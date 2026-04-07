import { statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import packageJson from "../../package.json" with { type: "json" };
import type { LcmConfig } from "../db/config.js";
import type { LcmSummarizeFn } from "../summarize.js";
import type { LcmDependencies } from "../types.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext } from "openclaw/plugin-sdk";
import { applyScopedDoctorRepair } from "./lcm-doctor-apply.js";
import {
  detectDoctorMarker,
  getDoctorSummaryStats,
  type DoctorSummaryStats,
} from "./lcm-doctor-shared.js";
import { estimateModelCost, estimateSavings, formatCurrency } from "./pricing.js";

const VISIBLE_COMMAND = "/lossless";
const HIDDEN_ALIAS = "/lcm";

type LcmStatusStats = {
  conversationCount: number;
  summaryCount: number;
  storedSummaryTokens: number;
  summarizedSourceTokens: number;
  leafSummaryCount: number;
  condensedSummaryCount: number;
};

type LcmConversationStatusStats = {
  conversationId: number;
  sessionId: string;
  sessionKey: string | null;
  messageCount: number;
  summaryCount: number;
  storedSummaryTokens: number;
  summarizedSourceTokens: number;
  contextTokenCount: number;
  compressedTokenCount: number;
  leafSummaryCount: number;
  condensedSummaryCount: number;
};

type CurrentConversationResolution =
  | {
      kind: "resolved";
      source: "session_key" | "session_key_via_session_id" | "session_id";
      stats: LcmConversationStatusStats;
    }
  | {
      kind: "unavailable";
      reason: string;
    };

type ParsedLcmCommand =
  | { kind: "status" }
  | { kind: "doctor"; apply: boolean }
  | { kind: "efficiency" }
  | { kind: "help"; error?: string };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function formatBoolean(value: boolean): string {
  return value ? "yes" : "no";
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat("en-US").format(value);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "unknown";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unitIndex]}`;
}

function formatCommand(command: string): string {
  return `\`${command}\``;
}

function buildHeaderLines(): string[] {
  return [
    `**🦀 Lossless Claw v${packageJson.version}**`,
    `Help: ${formatCommand(`${VISIBLE_COMMAND} help`)} · Alias: ${formatCommand(HIDDEN_ALIAS)}`,
  ];
}

function buildSection(title: string, lines: string[]): string {
  return [`**${title}**`, ...lines.map((line) => `  ${line}`)].join("\n");
}

function buildStatLine(label: string, value: string): string {
  return `${label}: ${value}`;
}

function formatCompressionRatio(contextTokens: number, compressedTokens: number): string {
  if (
    !Number.isFinite(contextTokens) ||
    contextTokens <= 0 ||
    !Number.isFinite(compressedTokens) ||
    compressedTokens <= 0
  ) {
    return "n/a";
  }
  const ratio = Math.max(1, Math.round(compressedTokens / contextTokens));
  return `1:${formatNumber(ratio)}`;
}

function truncateMiddle(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  if (maxChars <= 3) {
    return value.slice(0, maxChars);
  }
  const head = Math.ceil((maxChars - 1) / 2);
  const tail = Math.floor((maxChars - 1) / 2);
  return `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
}

function splitArgs(rawArgs: string | undefined): string[] {
  return (rawArgs ?? "")
    .trim()
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(Boolean);
}

function parseLcmCommand(rawArgs: string | undefined): ParsedLcmCommand {
  const tokens = splitArgs(rawArgs);
  if (tokens.length === 0) {
    return { kind: "status" };
  }

  const [head, ...rest] = tokens;
  switch (head.toLowerCase()) {
    case "status":
      return rest.length === 0
        ? { kind: "status" }
        : { kind: "help", error: "`/lcm status` does not accept extra arguments." };
    case "doctor":
      if (rest.length === 0) {
        return { kind: "doctor", apply: false };
      }
      if (rest.length === 1 && rest[0]?.toLowerCase() === "apply") {
        return { kind: "doctor", apply: true };
      }
      return {
        kind: "help",
        error: "`/lcm doctor` accepts no arguments, or `apply` for the scoped repair path.",
      };
    case "efficiency":
      return rest.length === 0
        ? { kind: "efficiency" }
        : { kind: "help", error: "`/lcm efficiency` does not accept extra arguments." };
    case "help":
      return { kind: "help" };
    default:
      return {
        kind: "help",
        error: `Unknown subcommand \`${head}\`. Supported: status, doctor, doctor apply, efficiency.`,
      };
  }
}

function getLcmStatusStats(db: DatabaseSync): LcmStatusStats {
  const row = db
    .prepare(
      `SELECT
         COALESCE((SELECT COUNT(*) FROM conversations), 0) AS conversation_count,
         COALESCE(COUNT(*), 0) AS summary_count,
         COALESCE(SUM(token_count), 0) AS stored_summary_tokens,
         COALESCE(SUM(CASE WHEN kind = 'leaf' THEN source_message_token_count ELSE 0 END), 0) AS summarized_source_tokens,
         COALESCE(SUM(CASE WHEN kind = 'leaf' THEN 1 ELSE 0 END), 0) AS leaf_summary_count,
         COALESCE(SUM(CASE WHEN kind = 'condensed' THEN 1 ELSE 0 END), 0) AS condensed_summary_count
       FROM summaries`,
    )
    .get() as
    | {
        conversation_count: number;
        summary_count: number;
        stored_summary_tokens: number;
        summarized_source_tokens: number;
        leaf_summary_count: number;
        condensed_summary_count: number;
      }
    | undefined;

  return {
    conversationCount: row?.conversation_count ?? 0,
    summaryCount: row?.summary_count ?? 0,
    storedSummaryTokens: row?.stored_summary_tokens ?? 0,
    summarizedSourceTokens: row?.summarized_source_tokens ?? 0,
    leafSummaryCount: row?.leaf_summary_count ?? 0,
    condensedSummaryCount: row?.condensed_summary_count ?? 0,
  };
}

function getConversationStatusStats(
  db: DatabaseSync,
  conversationId: number,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(
      `SELECT
         c.conversation_id,
         c.session_id,
         c.session_key,
         COALESCE((SELECT COUNT(*) FROM messages WHERE conversation_id = c.conversation_id), 0) AS message_count,
         COALESCE((SELECT COUNT(*) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS summary_count,
         COALESCE((SELECT SUM(token_count) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS stored_summary_tokens,
         COALESCE((SELECT SUM(CASE WHEN kind = 'leaf' THEN source_message_token_count ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS summarized_source_tokens,
         COALESCE((
           SELECT SUM(token_count)
           FROM (
             SELECT m.token_count AS token_count
             FROM context_items ci
             JOIN messages m ON m.message_id = ci.message_id
             WHERE ci.conversation_id = c.conversation_id
               AND ci.item_type = 'message'
             UNION ALL
             SELECT s.token_count AS token_count
             FROM context_items ci
             JOIN summaries s ON s.summary_id = ci.summary_id
             WHERE ci.conversation_id = c.conversation_id
               AND ci.item_type = 'summary'
           ) context_token_rows
         ), 0) AS context_token_count,
         COALESCE((
           SELECT SUM(COALESCE(s.source_message_token_count, 0) + COALESCE(s.descendant_token_count, 0))
           FROM context_items ci
           JOIN summaries s ON s.summary_id = ci.summary_id
           WHERE ci.conversation_id = c.conversation_id
             AND ci.item_type = 'summary'
         ), 0) AS compressed_token_count,
         COALESCE((SELECT SUM(CASE WHEN kind = 'leaf' THEN 1 ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS leaf_summary_count,
         COALESCE((SELECT SUM(CASE WHEN kind = 'condensed' THEN 1 ELSE 0 END) FROM summaries WHERE conversation_id = c.conversation_id), 0) AS condensed_summary_count
       FROM conversations c
       WHERE c.conversation_id = ?`,
    )
    .get(conversationId) as
    | {
        conversation_id: number;
        session_id: string;
        session_key: string | null;
        message_count: number;
        summary_count: number;
        stored_summary_tokens: number;
        summarized_source_tokens: number;
        context_token_count: number;
        compressed_token_count: number;
        leaf_summary_count: number;
        condensed_summary_count: number;
      }
    | undefined;

  if (!row) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    sessionId: row.session_id,
    sessionKey: row.session_key,
    messageCount: row.message_count,
    summaryCount: row.summary_count,
    storedSummaryTokens: row.stored_summary_tokens,
    summarizedSourceTokens: row.summarized_source_tokens,
    contextTokenCount: row.context_token_count,
    compressedTokenCount: row.compressed_token_count,
    leafSummaryCount: row.leaf_summary_count,
    condensedSummaryCount: row.condensed_summary_count,
  };
}

function normalizeIdentity(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getConversationStatusBySessionKey(
  db: DatabaseSync,
  sessionKey: string,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(`SELECT conversation_id FROM conversations WHERE session_key = ? LIMIT 1`)
    .get(sessionKey) as { conversation_id: number } | undefined;

  if (!row) {
    return null;
  }

  return getConversationStatusStats(db, row.conversation_id);
}

function getConversationStatusBySessionId(
  db: DatabaseSync,
  sessionId: string,
): LcmConversationStatusStats | null {
  const row = db
    .prepare(
      `SELECT conversation_id
       FROM conversations
       WHERE session_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { conversation_id: number } | undefined;

  if (!row) {
    return null;
  }

  return getConversationStatusStats(db, row.conversation_id);
}

async function resolveCurrentConversation(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
}): Promise<CurrentConversationResolution> {
  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  const sessionId = normalizeIdentity(params.ctx.sessionId);

  if (sessionKey) {
    const bySessionKey = getConversationStatusBySessionKey(params.db, sessionKey);
    if (bySessionKey) {
      return { kind: "resolved", source: "session_key", stats: bySessionKey };
    }

    if (sessionId) {
      const bySessionId = getConversationStatusBySessionId(params.db, sessionId);
      if (bySessionId) {
        if (!bySessionId.sessionKey || bySessionId.sessionKey === sessionKey) {
          return {
            kind: "resolved",
            source: "session_key_via_session_id",
            stats: bySessionId,
          };
        }

        return {
          kind: "unavailable",
          reason: `Active session key ${formatCommand(sessionKey)} is not stored in LCM yet. Session id fallback found conversation #${formatNumber(bySessionId.conversationId)}, but it is bound to ${formatCommand(bySessionId.sessionKey)}, so Global stats are safer.`,
        };
      }
    }

    return {
      kind: "unavailable",
      reason: sessionId
        ? `No LCM conversation is stored yet for active session key ${formatCommand(sessionKey)} or active session id ${formatCommand(sessionId)}.`
        : `No LCM conversation is stored yet for active session key ${formatCommand(sessionKey)}.`,
    };
  }

  if (sessionId) {
    const bySessionId = getConversationStatusBySessionId(params.db, sessionId);
    if (bySessionId) {
      return { kind: "resolved", source: "session_id", stats: bySessionId };
    }

    return {
      kind: "unavailable",
      reason: `OpenClaw did not expose an active session key here. Tried active session id ${formatCommand(sessionId)}, but no stored LCM conversation matched it.`,
    };
  }

  return {
    kind: "unavailable",
    reason: "OpenClaw did not expose an active session key or session id here, so only GLOBAL stats are available.",
  };
}

function resolvePluginEnabled(config: unknown): boolean {
  const root = asRecord(config);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.["lossless-claw"]);
  if (typeof entry?.enabled === "boolean") {
    return entry.enabled;
  }
  return true;
}

function resolveContextEngineSlot(config: unknown): string {
  const root = asRecord(config);
  const plugins = asRecord(root?.plugins);
  const slots = asRecord(plugins?.slots);
  return typeof slots?.contextEngine === "string" ? slots.contextEngine.trim() : "";
}

function resolvePluginSelected(config: unknown): boolean {
  const slot = resolveContextEngineSlot(config);
  return slot === "" || slot === "lossless-claw" || slot === "default";
}

function resolveDbSizeLabel(dbPath: string): string {
  const trimmed = dbPath.trim();
  if (!trimmed || trimmed === ":memory:" || trimmed.startsWith("file::memory:")) {
    return "in-memory";
  }
  try {
    return formatBytes(statSync(trimmed).size);
  } catch {
    return "missing";
  }
}

function buildHelpText(error?: string): string {
  const lines = [
    ...(error ? [`⚠️ ${error}`, ""] : []),
    ...buildHeaderLines(),
    "",
    buildSection("📘 Commands", [
      buildStatLine(formatCommand(VISIBLE_COMMAND), "Show compact status output."),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} status`), "Show plugin, Global, and current-conversation status."),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor`), "Scan for broken or truncated summaries."),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor apply`), "Repair broken summaries in the current conversation."),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} efficiency`), "Detailed compaction cost/savings analysis with recommendations."),
    ]),
    "",
    buildSection("🧭 Notes", [
      buildStatLine("subcommands", `Discover them with ${formatCommand(`${VISIBLE_COMMAND} help`)}.`),
      buildStatLine("alias", `${formatCommand(HIDDEN_ALIAS)} is accepted as a shorter alias.`),
      buildStatLine("current conversation", "Uses the active LCM session when the host exposes session identity."),
    ]),
  ];
  return lines.join("\n");
}

async function buildStatusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
}): Promise<string> {
  const status = getLcmStatusStats(params.db);
  const doctor = getDoctorSummaryStats(params.db);
  const enabled = resolvePluginEnabled(params.ctx.config);
  const selected = resolvePluginSelected(params.ctx.config);
  const slot = resolveContextEngineSlot(params.ctx.config);
  const dbSize = resolveDbSizeLabel(params.config.databasePath);
  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });

  const lines = [
    ...buildHeaderLines(),
    "",
    buildSection("🧩 Plugin", [
      buildStatLine("enabled", formatBoolean(enabled)),
      buildStatLine("selected", `${formatBoolean(selected)}${slot ? ` (slot=${slot})` : " (slot=unset)"}`),
      buildStatLine("db path", params.config.databasePath),
      buildStatLine("db size", dbSize),
    ]),
    "",
    buildSection("🌐 Global", [
      buildStatLine("conversations", formatNumber(status.conversationCount)),
      buildStatLine(
        "summaries",
        `${formatNumber(status.summaryCount)} (${formatNumber(status.leafSummaryCount)} leaf, ${formatNumber(status.condensedSummaryCount)} condensed)`,
      ),
      buildStatLine("stored summary tokens", formatNumber(status.storedSummaryTokens)),
      buildStatLine("summarized source tokens", formatNumber(status.summarizedSourceTokens)),
    ]),
    "",
  ];

  if (current.kind === "resolved") {
    const conversationDoctor =
      doctor.byConversation.get(current.stats.conversationId) ?? {
        total: 0,
        old: 0,
        truncated: 0,
        fallback: 0,
      };
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine(
          "session key",
          current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
        ),
        buildStatLine("messages", formatNumber(current.stats.messageCount)),
        buildStatLine(
          "summaries",
          `${formatNumber(current.stats.summaryCount)} (${formatNumber(current.stats.leafSummaryCount)} leaf, ${formatNumber(current.stats.condensedSummaryCount)} condensed)`,
        ),
        buildStatLine("stored summary tokens", formatNumber(current.stats.storedSummaryTokens)),
        buildStatLine("summarized source tokens", formatNumber(current.stats.summarizedSourceTokens)),
        buildStatLine("tokens in context", formatNumber(current.stats.contextTokenCount)),
        buildStatLine(
          "compression ratio",
          formatCompressionRatio(current.stats.contextTokenCount, current.stats.compressedTokenCount),
        ),
        buildStatLine(
          "doctor",
          conversationDoctor.total > 0
            ? `${formatNumber(conversationDoctor.total)} issue(s) in this conversation`
            : "clean",
        ),
      ]),
    );
  } else {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Showing Global stats only."),
      ]),
    );
  }

  // Efficiency section (only when compaction events exist for current conversation)
  if (current.kind === "resolved") {
    const effStats = getCompactionEfficiencyStats(params.db, current.stats.conversationId);
    if (effStats.totalPasses > 0) {
      const compactionCost = effStats.modelBreakdown.reduce((sum, m) => {
        return sum + estimateModelCost(m.model, m.inputTokens, m.outputTokens).totalCost;
      }, 0);
      const savings = estimateSavings(effStats.totalTokensSaved);
      const net = savings - compactionCost;
      const effPct = savings > 0 ? Math.round((net / savings) * 100) : 0;
      const topModel = effStats.modelBreakdown[0]?.model ?? "unknown";
      const modelLabel = effStats.modelBreakdown.length > 1
        ? `${topModel} +${effStats.modelBreakdown.length - 1} more`
        : topModel;
      const recommendation = net >= 0
        ? "Compaction is saving money"
        : topModel.toLowerCase().includes("opus")
          ? "Switch summaryModel to haiku \u2014 Opus is ~5x more expensive"
          : "Compaction cost exceeds savings \u2014 check summaryModel";

      // Memory quality metrics
      const totalSummaries = current.stats.summaryCount;
      const doctorIssues = conversationDoctor.total;
      const losslessPct = totalSummaries > 0
        ? Math.round(((totalSummaries - doctorIssues) / totalSummaries) * 100)
        : 100;
      const compressionRatio = current.stats.compressedTokenCount > 0
        ? current.stats.contextTokenCount / current.stats.compressedTokenCount
        : 0;
      const compressionHealth = compressionRatio === 0 ? "no compression yet"
        : compressionRatio < 2 ? "conservative \u2014 summaries are barely compressing"
        : compressionRatio <= 8 ? "healthy"
        : compressionRatio <= 15 ? "aggressive \u2014 detail may be hard to retrieve"
        : "very aggressive \u2014 check fallback rate";

      lines.push(
        "",
        buildSection("\u26A1 Compaction efficiency", [
          buildStatLine("passes", `${formatNumber(effStats.totalPasses)} (${formatNumber(effStats.leafPasses)} leaf, ${formatNumber(effStats.condensedPasses)} condensed)`),
          buildStatLine("tokens saved", formatNumber(effStats.totalTokensSaved)),
          buildStatLine("compaction cost", `~${formatCurrency(compactionCost)} (${effStats.totalPasses} calls \u00D7 ${modelLabel})`),
          buildStatLine("estimated savings", `~${formatCurrency(savings)}`),
          buildStatLine("net efficiency", `${net >= 0 ? "+" : ""}${formatCurrency(net)} (${effPct}% efficient)`),
          buildStatLine("summary quality", totalSummaries > 0
            ? `${losslessPct}% lossless (${doctorIssues > 0 ? `${doctorIssues} fallback/truncated` : "all clean"} of ${totalSummaries})`
            : "no summaries yet"),
          buildStatLine("compression health", compressionHealth),
          buildStatLine("recommendation", net >= 0 ? `\u2713 ${recommendation}` : `\u26A0 ${recommendation}`),
        ]),
      );
    }
  }

  return lines.join("\n");
}

function getCompactionEfficiencyStats(db: DatabaseSync, conversationId?: number): {
  totalPasses: number;
  leafPasses: number;
  condensedPasses: number;
  totalTokensSaved: number;
  modelBreakdown: Array<{ model: string; passes: number; inputTokens: number; outputTokens: number }>;
} {
  try {
    const whereClause = conversationId !== undefined ? "WHERE conversation_id = ?" : "";
    const params = conversationId !== undefined ? [conversationId] : [];

    const agg = db
      .prepare(
        `SELECT
           COUNT(*) AS total_passes,
           SUM(CASE WHEN pass = 'leaf' THEN 1 ELSE 0 END) AS leaf_passes,
           SUM(CASE WHEN pass = 'condensed' THEN 1 ELSE 0 END) AS condensed_passes,
           SUM(tokens_before - tokens_after) AS total_tokens_saved
         FROM compaction_events ${whereClause}`,
      )
      .get(...params) as {
      total_passes: number;
      leaf_passes: number;
      condensed_passes: number;
      total_tokens_saved: number;
    };

    const modelRows = db
      .prepare(
        `SELECT
           COALESCE(compaction_model, 'unknown') AS model,
           COUNT(*) AS passes,
           SUM(input_tokens_est) AS input_tokens,
           SUM(output_tokens_est) AS output_tokens
         FROM compaction_events ${whereClause}
         GROUP BY COALESCE(compaction_model, 'unknown')
         ORDER BY passes DESC`,
      )
      .all(...params) as Array<{
      model: string;
      passes: number;
      input_tokens: number;
      output_tokens: number;
    }>;

    return {
      totalPasses: agg.total_passes ?? 0,
      leafPasses: agg.leaf_passes ?? 0,
      condensedPasses: agg.condensed_passes ?? 0,
      totalTokensSaved: agg.total_tokens_saved ?? 0,
      modelBreakdown: modelRows.map((r) => ({
        model: r.model,
        passes: r.passes,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
      })),
    };
  } catch {
    return { totalPasses: 0, leafPasses: 0, condensedPasses: 0, totalTokensSaved: 0, modelBreakdown: [] };
  }
}

async function buildEfficiencyText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
}): Promise<string> {
  const current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  const convId = current.kind === "resolved" ? current.stats.conversationId : undefined;
  const stats = getCompactionEfficiencyStats(params.db, convId);

  if (stats.totalPasses === 0) {
    return [
      ...buildHeaderLines(),
      "",
      buildSection("\u26A1 Compaction efficiency", [
        buildStatLine("status", "No compaction events recorded yet."),
        buildStatLine("tip", "Run a session with 10+ turns to generate compaction data."),
      ]),
    ].join("\n");
  }

  const lines = [...buildHeaderLines(), ""];

  // Summary
  const totalCompactionCost = stats.modelBreakdown.reduce((sum, m) => {
    return sum + estimateModelCost(m.model, m.inputTokens, m.outputTokens).totalCost;
  }, 0);
  const savings = estimateSavings(stats.totalTokensSaved);
  const net = savings - totalCompactionCost;
  const effPct = savings > 0 ? Math.round((net / savings) * 100) : 0;

  lines.push(
    buildSection("\u26A1 Summary", [
      buildStatLine("total passes", `${formatNumber(stats.totalPasses)} (${formatNumber(stats.leafPasses)} leaf, ${formatNumber(stats.condensedPasses)} condensed)`),
      buildStatLine("tokens saved", formatNumber(stats.totalTokensSaved)),
      buildStatLine("compaction cost", `~${formatCurrency(totalCompactionCost)}`),
      buildStatLine("estimated savings", `~${formatCurrency(savings)}`),
      buildStatLine("net", `${net >= 0 ? "+" : ""}${formatCurrency(net)} (${effPct}% efficient)`),
    ]),
    "",
  );

  // Per-model breakdown
  if (stats.modelBreakdown.length > 0) {
    const modelLines: string[] = [];
    for (const m of stats.modelBreakdown) {
      const cost = estimateModelCost(m.model, m.inputTokens, m.outputTokens);
      modelLines.push(
        buildStatLine(m.model, `${m.passes} passes, ~${formatCurrency(cost.totalCost)}${!cost.matched ? " (unknown model \u2014 using estimate)" : ""}`),
      );
    }
    lines.push(buildSection("\uD83D\uDCCA By model", modelLines), "");
  }

  // Recommendations
  const recommendations: string[] = [];
  for (const m of stats.modelBreakdown) {
    const lower = m.model.toLowerCase();
    if (lower.includes("opus")) {
      recommendations.push(`\u26A0 Using ${m.model} for compaction costs ~$0.16/call. Switch to haiku (~$0.03) or gpt-4o-mini (~$0.004).`);
    }
    if (lower.includes("sonnet") && stats.totalPasses > 5) {
      recommendations.push(`\uD83D\uDCA1 Using ${m.model}. Consider haiku for 3x cost reduction with similar quality.`);
    }
  }
  if (net < 0) {
    recommendations.push("\u26A0 Compaction is costing more than it saves. Check your summaryModel setting.");
  }
  if (stats.totalTokensSaved > 0 && stats.totalTokensSaved / stats.totalPasses < 2000) {
    recommendations.push("\uD83D\uDCA1 Average tokens saved per pass is low (<2K). Consider raising leafSkipReductionThreshold.");
  }
  if (recommendations.length > 0) {
    lines.push(buildSection("\uD83D\uDCA1 Recommendations", recommendations));
  } else {
    lines.push(buildSection("\u2713 Status", ["Compaction is working efficiently. No action needed."]));
  }

  lines.push("", "_Costs are estimates based on published API pricing (Apr 2026). Actual costs depend on your provider agreement._");

  return lines.join("\n");
}

async function buildDoctorText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
}): Promise<string> {
  const current = await resolveCurrentConversation(params);

  if (current.kind === "unavailable") {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor",
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Doctor is conversation-scoped, so no global scan ran."),
      ]),
    ].join("\n");
  }

  const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor",
    "",
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine(
        "session key",
        current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
      ),
      buildStatLine("scope", "this conversation only"),
    ]),
    "",
    buildSection("🧪 Scan", [
      buildStatLine("detected summaries", formatNumber(stats.total)),
      buildStatLine("old-marker summaries", formatNumber(stats.old)),
      buildStatLine("truncated-marker summaries", formatNumber(stats.truncated)),
      buildStatLine("fallback-marker summaries", formatNumber(stats.fallback)),
      buildStatLine("result", stats.total === 0 ? "clean" : "issues found"),
    ]),
  ];

  if (stats.total > 0) {
    const summaryList = stats.candidates
      .slice()
      .sort((left, right) => left.summaryId.localeCompare(right.summaryId))
      .map((candidate) => `${candidate.summaryId} (${candidate.markerKind})`)
      .join(", ");
    lines.push(
      "",
      buildSection("🧷 Affected summaries", [summaryList]),
      "",
      buildSection("🛠️ Next step", [
        `${formatCommand(`${VISIBLE_COMMAND} doctor apply`)} repairs these in place for the current conversation.`,
      ]),
    );
  }

  return lines.join("\n");
}

async function buildDoctorApplyText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  summarize?: LcmSummarizeFn;
}): Promise<string> {
  const current = await resolveCurrentConversation(params);

  if (current.kind === "unavailable") {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor Apply",
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Doctor apply is conversation-scoped, so no global repair ran."),
      ]),
    ].join("\n");
  }

  const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
  let result: Awaited<ReturnType<typeof applyScopedDoctorRepair>>;
  try {
    result = await applyScopedDoctorRepair({
      db: params.db,
      config: params.config,
      conversationId: current.stats.conversationId,
      deps: params.deps,
      summarize: params.summarize,
      runtimeConfig: params.ctx.config,
    });
  } catch (error) {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor Apply",
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine(
          "session key",
          current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
        ),
        buildStatLine("scope", "this conversation only"),
      ]),
      "",
      buildSection("🛠️ Apply", [
        buildStatLine("mode", "in-place summary rewrite"),
        buildStatLine("status", "failed"),
        buildStatLine("reason", error instanceof Error ? error.message : "unknown repair failure"),
      ]),
    ].join("\n");
  }

  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor Apply",
    "",
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine(
        "session key",
        current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
      ),
      buildStatLine("scope", "this conversation only"),
    ]),
    "",
  ];

  if (result.kind === "unavailable") {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("mode", "in-place summary rewrite"),
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("🛠️ Apply", [
      buildStatLine("mode", "in-place summary rewrite"),
      buildStatLine("detected summaries", formatNumber(stats.total)),
      buildStatLine("old-marker summaries", formatNumber(stats.old)),
      buildStatLine("truncated-marker summaries", formatNumber(stats.truncated)),
      buildStatLine("fallback-marker summaries", formatNumber(stats.fallback)),
      buildStatLine("repaired summaries", formatNumber(result.repaired)),
      buildStatLine("unchanged summaries", formatNumber(result.unchanged)),
      buildStatLine("skipped summaries", formatNumber(result.skipped.length)),
      buildStatLine(
        "result",
        stats.total === 0
          ? "clean; no writes ran"
          : result.repaired > 0
            ? `repaired ${formatNumber(result.repaired)} summary(s) in place`
            : "no repairs applied",
      ),
    ]),
  );

  if (result.repairedSummaryIds.length > 0) {
    lines.push(
      "",
      buildSection("🧷 Repaired summaries", [result.repairedSummaryIds.join(", ")]),
    );
  }

  if (result.skipped.length > 0) {
    lines.push(
      "",
      buildSection(
        "⚠️ Deferred",
        result.skipped.map((item) => `${item.summaryId}: ${item.reason}`),
      ),
    );
  }

  return lines.join("\n");
}

export function createLcmCommand(params: {
  db: DatabaseSync | (() => DatabaseSync | Promise<DatabaseSync>);
  config: LcmConfig;
  deps?: LcmDependencies;
  summarize?: LcmSummarizeFn;
}): OpenClawPluginCommandDefinition {
  const getDb = async (): Promise<DatabaseSync> =>
    typeof params.db === "function" ? await params.db() : params.db;

  return {
    name: "lcm",
    nativeNames: {
      default: "lossless",
    },
    description: "Show Lossless Claw health, scan broken summaries, and repair scoped doctor issues.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseLcmCommand(ctx.args);
      switch (parsed.kind) {
        case "status":
          return { text: await buildStatusText({ ctx, db: await getDb(), config: params.config }) };
        case "doctor":
          return parsed.apply
            ? {
                text: await buildDoctorApplyText({
                  ctx,
                  db: await getDb(),
                  config: params.config,
                  deps: params.deps,
                  summarize: params.summarize,
                }),
              }
            : { text: await buildDoctorText({ ctx, db: await getDb() }) };
        case "efficiency":
          return { text: await buildEfficiencyText({ ctx, db: await getDb() }) };
        case "help":
          return { text: buildHelpText(parsed.error) };
      }
    },
  };
}

export const __testing = {
  parseLcmCommand,
  detectDoctorMarker,
  getDoctorSummaryStats,
  getLcmStatusStats,
  getConversationStatusStats,
  resolveCurrentConversation,
  resolveContextEngineSlot,
  resolvePluginEnabled,
  resolvePluginSelected,
};
