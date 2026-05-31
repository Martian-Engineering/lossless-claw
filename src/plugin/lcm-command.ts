import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import packageJson from "../../package.json" with { type: "json" };
import { formatTimestamp } from "../compaction.js";
import type { LcmConfig } from "../db/config.js";
import type { RotateSessionStorageWithBackupResult } from "../engine.js";
import { runDelegatedFocusBrief, runDelegatedRefocusBrief } from "../focus-briefs.js";
import type { LcmSummarizeFn } from "../summarize.js";
import type { LcmDependencies } from "../types.js";
import type {
  CompactResult,
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "../openclaw-bridge.js";
import { applyScopedDoctorRepair } from "./lcm-doctor-apply.js";
import { createLcmDatabaseBackup } from "./lcm-db-backup.js";
import { describeLogError } from "../lcm-log.js";
import {
  applyDoctorCleaners,
  getDoctorCleanerApplyUnavailableReason,
  getDoctorCleanerFilterIds,
  scanDoctorCleaners,
  type DoctorCleanerId,
} from "./lcm-doctor-cleaners.js";
import {
  detectDoctorMarker,
  getDoctorSummaryStats,
  type DoctorSummaryStats,
} from "./lcm-doctor-shared.js";
import {
  CompactionMaintenanceStore,
  type ConversationCompactionMaintenanceRecord,
} from "../store/compaction-maintenance-store.js";
import { CompactionTelemetryStore } from "../store/compaction-telemetry-store.js";
import { FocusBriefStore, hashFocusSourceContext } from "../store/focus-brief-store.js";

const VISIBLE_COMMAND = "/lossless";
const HIDDEN_ALIAS = "/lcm";
const ROTATE_DATABASE_LOCK_TIMEOUT_MS = 30_000;

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
  | { kind: "backup" }
  | { kind: "rotate" }
  | { kind: "focus_status" }
  | { kind: "focus_generate"; prompt: string }
  | { kind: "refocus" }
  | { kind: "unfocus" }
  | { kind: "doctor"; apply: boolean }
  | { kind: "doctor_cleaners"; apply: boolean; filterId?: DoctorCleanerId; vacuum: boolean }
  | { kind: "help"; error?: string };

type RotateCommandEngine = {
  rotateSessionStorageWithBackup(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile: string;
    lockTimeoutMs: number;
  }): Promise<RotateSessionStorageWithBackupResult>;
};

type FocusCompactionCommandEngine = {
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number;
    currentTokenCount?: number;
    compactionTarget?: "budget" | "threshold";
    runtimeContext?: Record<string, unknown>;
    force?: boolean;
  }): Promise<CompactResult>;
};

type RuntimeCommandEngine = RotateCommandEngine & Partial<FocusCompactionCommandEngine>;

const DOCTOR_CLEANER_IDS = new Set<DoctorCleanerId>(getDoctorCleanerFilterIds());

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readCommandRuntimeContext(ctx: PluginCommandContext): Record<string, unknown> | undefined {
  return asRecord(asRecord(ctx)?.runtimeContext);
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

function formatFailureReason(error: unknown): string {
  const message = describeLogError(error).trim();
  return message || "Unknown error";
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

function parseDoctorCleanerApplyArgs(tokens: string[]):
  | { ok: true; filterId?: DoctorCleanerId; vacuum: boolean }
  | { ok: false; error: string } {
  let filterId: DoctorCleanerId | undefined;
  let vacuum = false;

  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "vacuum") {
      vacuum = true;
      continue;
    }
    if (DOCTOR_CLEANER_IDS.has(normalized as DoctorCleanerId) && !filterId) {
      filterId = normalized as DoctorCleanerId;
      continue;
    }
    return {
      ok: false,
      error:
        `\`${VISIBLE_COMMAND} doctor clean apply\` accepts at most one filter id (\`${getDoctorCleanerFilterIds().join("`, `")}\`) plus optional \`vacuum\`.`,
    };
  }

  return { ok: true, filterId, vacuum };
}

function parseLcmCommand(rawArgs: string | undefined): ParsedLcmCommand {
  const raw = (rawArgs ?? "").trim();
  if (raw === "") {
    return { kind: "status" };
  }
  const focusMatch = raw.match(/^focus(?:\s+([\s\S]*))?$/i);
  if (focusMatch) {
    const prompt = focusMatch[1]?.trim() ?? "";
    return prompt ? { kind: "focus_generate", prompt } : { kind: "focus_status" };
  }
  if (/^refocus$/i.test(raw)) {
    return { kind: "refocus" };
  }
  if (/^unfocus$/i.test(raw)) {
    return { kind: "unfocus" };
  }

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
    case "backup":
      return rest.length === 0
        ? { kind: "backup" }
        : { kind: "help", error: "`/lcm backup` does not accept extra arguments." };
    case "rotate":
      return rest.length === 0
        ? { kind: "rotate" }
        : { kind: "help", error: "`/lcm rotate` does not accept extra arguments." };
    case "doctor":
      if (rest.length === 0) {
        return { kind: "doctor", apply: false };
      }
      if (rest.length === 1 && rest[0]?.toLowerCase() === "clean") {
        return { kind: "doctor_cleaners", apply: false, vacuum: false };
      }
      if (rest[0]?.toLowerCase() === "clean" && rest[1]?.toLowerCase() === "apply") {
        const parsedApply = parseDoctorCleanerApplyArgs(rest.slice(2));
        return parsedApply.ok
          ? {
              kind: "doctor_cleaners",
              apply: true,
              filterId: parsedApply.filterId,
              vacuum: parsedApply.vacuum,
            }
          : { kind: "help", error: parsedApply.error };
      }
      if (rest.length === 1 && rest[0]?.toLowerCase() === "apply") {
        return { kind: "doctor", apply: true };
      }
      return {
        kind: "help",
        error:
          `\`${VISIBLE_COMMAND} doctor\` accepts no arguments, \`clean\` for global high-confidence junk diagnostics, \`clean apply [filter-id] [vacuum]\` for cleanup, or \`apply\` for the scoped summary repair path.`,
      };
    case "help":
      return { kind: "help" };
    default:
      return {
        kind: "help",
        error: `Unknown subcommand \`${head}\`. Supported: status, focus, refocus, unfocus, backup, rotate, doctor, doctor clean, doctor apply, help.`,
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
    .prepare(
      `SELECT conversation_id
       FROM conversations
       WHERE session_key = ?
       ORDER BY active DESC, created_at DESC
       LIMIT 1`,
    )
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
       ORDER BY active DESC, created_at DESC
       LIMIT 1`,
    )
    .get(sessionId) as { conversation_id: number } | undefined;

  if (!row) {
    return null;
  }

  return getConversationStatusStats(db, row.conversation_id);
}

async function getConversationCompactionMaintenanceByConversationId(
  db: DatabaseSync,
  conversationId: number,
): Promise<ConversationCompactionMaintenanceRecord | null> {
  return await new CompactionMaintenanceStore(db).getConversationCompactionMaintenance(
    conversationId,
  );
}

async function getConversationCompactionTelemetryByConversationId(
  db: DatabaseSync,
  conversationId: number,
) {
  return await new CompactionTelemetryStore(db).getConversationCompactionTelemetry(conversationId);
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

async function resolveRuntimeSessionId(params: {
  ctx: PluginCommandContext;
  deps: LcmDependencies;
  current: Extract<CurrentConversationResolution, { kind: "resolved" }>;
}): Promise<string | undefined> {
  const directSessionId = normalizeIdentity(params.ctx.sessionId);
  if (directSessionId) {
    return directSessionId;
  }

  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (sessionKey) {
    const runtimeSessionId = normalizeIdentity(
      await params.deps.resolveSessionIdFromSessionKey(sessionKey),
    );
    if (runtimeSessionId) {
      return runtimeSessionId;
    }
  }

  return normalizeIdentity(params.current.stats.sessionId);
}

function resolveLifecycleCompactionTokenBudget(config: LcmConfig): number {
  return config.maxAssemblyTokenBudget && config.maxAssemblyTokenBudget > 0
    ? Math.floor(config.maxAssemblyTokenBudget)
    : 128_000;
}

// Run the cache-aware focus lifecycle sweep. Focus and unfocus both mutate the
// prompt prefix, so they explicitly take the manual full-sweep path and bypass
// threshold skips instead of leaving compaction to normal background policy.
async function runFocusLifecycleCompaction(params: {
  ctx: PluginCommandContext;
  deps?: LcmDependencies;
  getLcm?: () => Promise<RuntimeCommandEngine>;
  config: LcmConfig;
  current: Extract<CurrentConversationResolution, { kind: "resolved" }>;
  sessionKey?: string;
}): Promise<
  | { status: "ok"; sessionId: string; result: CompactResult }
  | { status: "unavailable" | "failed"; reason: string }
> {
  if (!params.deps || !params.getLcm) {
    return {
      status: "unavailable",
      reason: "Focus lifecycle compaction requires the runtime-backed LCM engine.",
    };
  }

  const sessionKey = params.sessionKey ?? normalizeIdentity(params.ctx.sessionKey);
  const sessionId = await resolveRuntimeSessionId({
    ctx: params.ctx,
    deps: params.deps,
    current: params.current,
  });
  if (!sessionId) {
    return {
      status: "unavailable",
      reason:
        "Lossless Claw resolved the active conversation, but OpenClaw did not expose or resolve a runtime session id for compaction.",
    };
  }

  const engine = await params.getLcm();
  if (typeof engine.compact !== "function") {
    return {
      status: "unavailable",
      reason: "The runtime-backed LCM engine does not expose compaction to commands.",
    };
  }

  let sessionFile = "";
  try {
    sessionFile =
      (await params.deps.resolveSessionTranscriptFile({
        sessionId,
        sessionKey,
      })) ?? "";
  } catch {
    sessionFile = "";
  }

  const tokenBudget = resolveLifecycleCompactionTokenBudget(params.config);
  try {
    const result = await engine.compact({
      sessionId,
      sessionKey,
      sessionFile,
      tokenBudget,
      currentTokenCount: params.current.stats.contextTokenCount,
      compactionTarget: "threshold",
      runtimeContext: {
        manualCompaction: true,
        tokenBudget,
        currentTokenCount: params.current.stats.contextTokenCount,
      },
      force: true,
    });
    return result.ok
      ? { status: "ok", sessionId, result }
      : {
          status: "failed",
          reason: result.reason ?? result.error ?? "focus lifecycle compaction failed",
        };
  } catch (error) {
    return { status: "failed", reason: formatFailureReason(error) };
  }
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
  return slot === "" || slot === "lossless-claw";
}

function resolveDbSizeLabel(dbPath: string): string {
  if (typeof dbPath !== "string") return "unknown";
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
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} status`),
        "Show plugin, Global, current-conversation, and compaction-maintenance status.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} backup`),
        "Create a timestamped backup of the current LCM database.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} rotate`),
        "Compact the current session transcript while preserving the same LCM conversation and live session identity.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} focus <prompt>`),
        "Generate an active focus brief with a delegated recall sub-agent.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} focus`),
        "Show the latest focus brief for the current conversation.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} refocus`),
        "Refresh the active focus brief from post-focus summary deltas.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} unfocus`),
        "Deactivate the active focus overlay without deleting focus history.",
      ),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor`), "Scan for broken or truncated summaries."),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor clean`),
        "Report global high-confidence junk candidates without deleting anything.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor clean apply`),
        "Delete approved high-confidence cleaner matches after creating a DB backup.",
      ),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor apply`), "Repair broken summaries in the current conversation."),
    ]),
    "",
    buildSection("🧭 Notes", [
      buildStatLine("subcommands", `Discover them with ${formatCommand(`${VISIBLE_COMMAND} help`)}.`),
      buildStatLine("alias", `${formatCommand(HIDDEN_ALIAS)} is accepted as a shorter alias.`),
      buildStatLine("current conversation", "Uses the active LCM session when the host exposes session identity."),
      buildStatLine("`/new`", "Prunes context for the current LCM conversation. It does not split storage."),
      buildStatLine("`/reset`", "Resets OpenClaw session flow. Use rotate when you only want transcript compaction."),
    ]),
  ];
  return lines.join("\n");
}

function buildDoctorCleanerExampleLine(params: {
  conversationId: number;
  sessionKey: string | null;
  messageCount: number;
  firstMessagePreview: string | null;
}): string {
  const sessionKey = params.sessionKey ? formatCommand(truncateMiddle(params.sessionKey, 44)) : "missing";
  const preview = params.firstMessagePreview ? ` · first: ${JSON.stringify(params.firstMessagePreview)}` : "";
  return `conv ${formatNumber(params.conversationId)} · session key ${sessionKey} · messages ${formatNumber(params.messageCount)}${preview}`;
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
    const maintenance = await getConversationCompactionMaintenanceByConversationId(
      params.db,
      current.stats.conversationId,
    );
    const telemetry = await getConversationCompactionTelemetryByConversationId(
      params.db,
      current.stats.conversationId,
    );
    const focusLines = await buildFocusSummaryLines({
      store: new FocusBriefStore(params.db),
      conversationId: current.stats.conversationId,
      timezone: params.config.timezone,
    });
    const formatMaintenanceTime = (value: Date | null): string =>
      value ? formatTimestamp(value, params.config.timezone) : "never";
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
    lines.push("", buildSection("🎯 Focus", focusLines));
    lines.push(
      "",
      buildSection("🛠️ Maintenance", [
        buildStatLine(
          "state",
          maintenance?.pending
            ? "pending"
            : maintenance?.running
              ? "running"
              : "idle",
        ),
        buildStatLine("requested at", formatMaintenanceTime(maintenance?.requestedAt ?? null)),
        buildStatLine("reason", maintenance?.reason ?? "none"),
        buildStatLine("last started", formatMaintenanceTime(maintenance?.lastStartedAt ?? null)),
        buildStatLine("last finished", formatMaintenanceTime(maintenance?.lastFinishedAt ?? null)),
        buildStatLine("last failure", maintenance?.lastFailureSummary ?? "none"),
        buildStatLine(
          "requested token budget",
          maintenance?.tokenBudget != null ? formatNumber(maintenance.tokenBudget) : "unknown",
        ),
        buildStatLine(
          "observed token count",
          maintenance?.currentTokenCount != null ? formatNumber(maintenance.currentTokenCount) : "unknown",
        ),
        buildStatLine(
          "projected token count",
          maintenance?.projectedTokenCount != null ? formatNumber(maintenance.projectedTokenCount) : "unknown",
        ),
        buildStatLine(
          "raw tokens outside tail",
          maintenance?.rawTokensOutsideTail != null ? formatNumber(maintenance.rawTokensOutsideTail) : "unknown",
        ),
        buildStatLine("last api call", formatMaintenanceTime(telemetry?.lastApiCallAt ?? null)),
        buildStatLine("last cache touch", formatMaintenanceTime(telemetry?.lastCacheTouchAt ?? null)),
        buildStatLine("cache retention", telemetry?.retention ?? "unknown"),
        buildStatLine("cache state", telemetry?.cacheState ?? "unknown"),
        buildStatLine("provider/model", [telemetry?.provider, telemetry?.model].filter(Boolean).join(" / ") || "unknown"),
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

async function buildDoctorCleanersText(params: {
  db: DatabaseSync;
}): Promise<string> {
  const scan = scanDoctorCleaners(params.db);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor Clean",
    "",
    buildSection("🌐 Global scan", [
      buildStatLine("filters", formatNumber(scan.filters.length)),
      buildStatLine("matched conversations", formatNumber(scan.totalDistinctConversations)),
      buildStatLine("matched messages", formatNumber(scan.totalDistinctMessages)),
      buildStatLine("mode", "read-only diagnostics"),
    ]),
  ];

  if (scan.filters.every((filter) => filter.conversationCount === 0)) {
    lines.push(
      "",
      buildSection("✅ Result", ["No high-confidence cleaner candidates detected."]),
    );
    return lines.join("\n");
  }

  for (const filter of scan.filters) {
    lines.push(
      "",
      buildSection(`🧹 ${filter.label}`, [
        buildStatLine("filter id", formatCommand(filter.id)),
        buildStatLine("description", filter.description),
        buildStatLine("matched conversations", formatNumber(filter.conversationCount)),
        buildStatLine("matched messages", formatNumber(filter.messageCount)),
      ]),
    );

    if (filter.examples.length > 0) {
      lines.push(
        "",
        buildSection(
          "🧷 Examples",
          filter.examples.map((example) => buildDoctorCleanerExampleLine(example)),
        ),
      );
    }
  }

  lines.push(
    "",
    buildSection("🛠️ Next step", [
      `Review the examples, then run ${formatCommand(`${VISIBLE_COMMAND} doctor clean apply`)} to delete approved matches after Lossless Claw creates a backup.`,
    ]),
  );

  return lines.join("\n");
}

function runQuickCheck(db: DatabaseSync): string {
  const rows = db.prepare(`PRAGMA quick_check`).all() as Array<{ quick_check?: string }>;
  const results = rows
    .map((row) => row.quick_check)
    .filter((value): value is string => typeof value === "string" && value.length > 0);

  if (results.length === 0) {
    return "unknown";
  }

  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }

  return results.join("; ");
}

function isPassingQuickCheck(result: string): boolean {
  return result === "ok";
}

function getLcmBackupUnavailableReason(databasePath: string): string | null {
  if (typeof databasePath !== "string") return "Invalid database path.";
  const trimmed = databasePath.trim();
  if (!trimmed || trimmed === ":memory:" || trimmed.startsWith("file::memory:")) {
    return "Backup requires a file-backed SQLite database.";
  }
  return null;
}

async function buildBackupText(params: {
  db: DatabaseSync;
  config: LcmConfig;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "💾 Lossless Claw Backup",
    "",
  ];

  const unavailableReason = getLcmBackupUnavailableReason(params.config.databasePath);
  if (unavailableReason) {
    lines.push(
      buildSection("🛠️ Backup", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", unavailableReason),
      ]),
    );
    return lines.join("\n");
  }

  let backupPath: string | null;
  try {
    backupPath = createLcmDatabaseBackup(params.db, {
      databasePath: params.config.databasePath,
      label: "backup",
    });
  } catch (error) {
    lines.push(
      buildSection("🛠️ Backup", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", formatFailureReason(error)),
      ]),
    );
    return lines.join("\n");
  }
  if (!backupPath) {
    lines.push(
      buildSection("🛠️ Backup", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "Lossless Claw could not determine a backup path."),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("🛠️ Backup", [
      buildStatLine("status", "created"),
      buildStatLine("db path", params.config.databasePath),
      buildStatLine("backup path", backupPath),
    ]),
  );
  return lines.join("\n");
}

async function buildRotateText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<RuntimeCommandEngine>;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🪓 Lossless Claw Rotate",
    "",
  ];

  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (!sessionKey) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "OpenClaw must expose the active session key for Lossless Claw to rotate storage safely.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  if (!params.deps || !params.getLcm) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "Rotate requires the runtime-backed LCM engine to be available."),
      ]),
    );
    return lines.join("\n");
  }

  const sessionId = await resolveRuntimeSessionId({
    ctx: params.ctx,
    deps: params.deps,
    current,
  });
  if (!sessionId) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(sessionKey, 44))),
        buildStatLine("messages", formatNumber(current.stats.messageCount)),
      ]),
      "",
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Lossless Claw resolved the active conversation, but OpenClaw did not expose or resolve a runtime session id, so rotate cannot locate the live transcript safely.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const transcriptPath = await params.deps.resolveSessionTranscriptFile({
    sessionId,
    sessionKey,
  });
  if (!transcriptPath || !existsSync(transcriptPath)) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Lossless Claw could not resolve the active session transcript path, so it cannot rotate the transcript safely.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const unavailableReason = getLcmBackupUnavailableReason(params.config.databasePath);
  if (unavailableReason) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", unavailableReason),
      ]),
    );
    return lines.join("\n");
  }

  let result: RotateSessionStorageWithBackupResult;
  try {
    result = await (await params.getLcm()).rotateSessionStorageWithBackup({
      sessionId,
      sessionKey,
      sessionFile: transcriptPath,
      lockTimeoutMs: ROTATE_DATABASE_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", formatFailureReason(error)),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine(
        "conversation id",
        formatNumber(result.currentConversationId ?? current.stats.conversationId),
      ),
      buildStatLine("session key", formatCommand(truncateMiddle(sessionKey, 44))),
      buildStatLine(
        "messages",
        formatNumber(result.currentMessageCount ?? current.stats.messageCount),
      ),
    ]),
    "",
  );

  if (result.kind === "backup_failed") {
    lines.push(
      buildSection("💾 Backup", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  if (result.kind === "unavailable" && !result.backupPath) {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("💾 Backup", [
      buildStatLine("status", "replaced latest"),
      buildStatLine("backup path", result.backupPath!),
    ]),
    "",
  );

  if (result.kind === "rotate_failed") {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  if (result.kind === "unavailable") {
    lines.push(
      buildSection("🛠️ Rotate", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    buildSection("🛠️ Rotate", [
      buildStatLine("status", "rotated"),
      buildStatLine("preserved tail messages", formatNumber(result.preservedTailMessageCount)),
      buildStatLine("checkpoint bytes", formatNumber(result.checkpointSize)),
      buildStatLine("bytes removed", formatNumber(result.bytesRemoved)),
      buildStatLine("transcript", transcriptPath),
      buildStatLine("mode", "preserved current conversation and rotated transcript tail"),
    ]),
    "",
    buildSection("🧭 Notes", [
      "Current LCM conversation, summaries, and context items remain in place.",
      `${formatCommand("/new")} still prunes context only, and ${formatCommand("/reset")} still resets OpenClaw session flow.`,
    ]),
  );
  return lines.join("\n");
}

function formatFocusPreview(content: string, maxChars = 1200): string {
  const trimmed = content.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}

function formatFocusBriefTime(value: Date | null, timezone: string): string {
  return value ? formatTimestamp(value, timezone) : "unknown";
}

function formatFocusDelta(diagnostics: {
  postFocusMessageCount: number;
  postFocusSummaryCount: number;
  postFocusTokenCount: number;
}): string {
  return [
    `${formatNumber(diagnostics.postFocusMessageCount)} messages`,
    `${formatNumber(diagnostics.postFocusSummaryCount)} summaries`,
    `~${formatNumber(diagnostics.postFocusTokenCount)} tokens`,
  ].join(", ");
}

async function buildFocusSummaryLines(params: {
  store: FocusBriefStore;
  conversationId: number;
  timezone: string;
}): Promise<string[]> {
  const active = await params.store.getActiveFocusBrief(params.conversationId);
  const latest = await params.store.getLatestFocusBrief(params.conversationId);
  if (!active) {
    return [
      buildStatLine("status", "none"),
      ...(latest
        ? [
            buildStatLine("latest generation", latest.status),
            buildStatLine("latest brief id", formatCommand(latest.briefId)),
          ]
        : []),
    ];
  }

  const diagnostics = await params.store.getFocusBriefDiagnostics(active);
  const lines = [
    buildStatLine("status", "active"),
    buildStatLine("brief id", formatCommand(active.briefId)),
    buildStatLine("created", formatFocusBriefTime(active.createdAt, params.timezone)),
    buildStatLine("prompt", JSON.stringify(formatFocusPreview(active.prompt, 160))),
    buildStatLine("tokens", `${formatNumber(active.tokenCount)} / ${formatNumber(active.targetTokens)}`),
    buildStatLine("delta since focus", formatFocusDelta(diagnostics)),
    buildStatLine("stale", formatBoolean(diagnostics.stale)),
    buildStatLine("truncated", formatBoolean(diagnostics.truncated)),
    buildStatLine("source snapshot", diagnostics.sourceContextChanged ? "obsolete" : "current"),
  ];
  if (latest && latest.briefId !== active.briefId) {
    lines.push(buildStatLine("latest generation", latest.status));
    if (latest.error) {
      lines.push(buildStatLine("latest error", latest.error));
    }
  }
  return lines;
}

// Build the read-only status response for the current conversation's latest focus brief.
async function buildFocusStatusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Focus",
    "",
  ];
  const current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const store = new FocusBriefStore(params.db);
  const active = await store.getActiveFocusBrief(current.stats.conversationId);
  const latest = await store.getLatestFocusBrief(current.stats.conversationId);
  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine(
        "session key",
        current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
      ),
    ]),
    "",
  );

  if (!active && !latest) {
    lines.push(
      buildSection("🎯 Focus", [
        buildStatLine("status", "none"),
        buildStatLine("usage", formatCommand(`${VISIBLE_COMMAND} focus <prompt>`)),
        buildStatLine("behavior", "generates an active focus brief overlay"),
      ]),
    );
    return lines.join("\n");
  }

  const primary = active ?? latest;
  if (!primary) {
    return lines.join("\n");
  }

  const sources = await store.getFocusBriefSources(primary.briefId);
  const cited = sources.filter((source) => source.role === "cited").map((source) => source.summaryId);
  const diagnostics = await store.getFocusBriefDiagnostics(primary);
  lines.push(
    buildSection(active ? "🎯 Active focus brief" : "🎯 Latest focus brief", [
      buildStatLine("brief id", formatCommand(primary.briefId)),
      buildStatLine("status", primary.status),
      buildStatLine("created", formatFocusBriefTime(primary.createdAt, params.config.timezone)),
      buildStatLine("prompt", JSON.stringify(formatFocusPreview(primary.prompt, 240))),
      buildStatLine("tokens", formatNumber(primary.tokenCount)),
      buildStatLine("target tokens", formatNumber(primary.targetTokens)),
      buildStatLine("source summaries", formatNumber(sources.filter((source) => source.role === "active_input").length)),
      buildStatLine("cited summaries", cited.length > 0 ? cited.slice(0, 8).join(", ") : "none"),
      buildStatLine("generator run", primary.generatorRunId ?? "unknown"),
      buildStatLine("delta since focus", formatFocusDelta(diagnostics)),
      buildStatLine("stale", formatBoolean(diagnostics.stale)),
      buildStatLine("truncated", formatBoolean(diagnostics.truncated)),
      buildStatLine("source snapshot", diagnostics.sourceContextChanged ? "obsolete" : "current"),
    ]),
  );
  if (latest && active && latest.briefId !== active.briefId) {
    lines.push(
      "",
      buildSection("⚠️ Latest generation", [
        buildStatLine("latest generation", latest.status),
        buildStatLine("brief id", formatCommand(latest.briefId)),
        ...(latest.error ? [buildStatLine("error", latest.error)] : []),
      ]),
    );
  } else if (primary.error) {
    lines.push("", buildSection("⚠️ Error", [primary.error]));
  }
  if (primary.content.trim()) {
    lines.push("", buildSection("📝 Preview", [formatFocusPreview(primary.content)]));
  }
  return lines.join("\n");
}

// Generate an active focus brief through a delegated subagent and persist the result.
async function buildFocusGenerateText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<RuntimeCommandEngine>;
  prompt: string;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Focus",
    "",
  ];
  if (!params.deps || !params.getLcm) {
    lines.push(
      buildSection("🛠️ Focus", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Focus generation requires runtime dependencies for pre-focus compaction and delegated subagents.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const requesterSessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (!requesterSessionKey) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "OpenClaw must expose the active session key for Lossless Claw to spawn a focus subagent.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  let current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const preFocusCompaction = await runFocusLifecycleCompaction({
    ctx: params.ctx,
    deps: params.deps,
    getLcm: params.getLcm,
    config: params.config,
    current,
    sessionKey: requesterSessionKey,
  });
  if (preFocusCompaction.status !== "ok") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      ]),
      "",
      buildSection("🧹 Pre-focus compaction", [
        buildStatLine("status", preFocusCompaction.status),
        buildStatLine("reason", preFocusCompaction.reason),
      ]),
    );
    return lines.join("\n");
  }

  current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("🧹 Pre-focus compaction", [
        buildStatLine("status", "completed"),
        buildStatLine("result", preFocusCompaction.result.reason ?? "done"),
      ]),
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const store = new FocusBriefStore(params.db);
  const summaries = await store.getActiveContextSummaries(current.stats.conversationId);
  if (summaries.length === 0) {
    lines.push(
      buildSection("🎯 Focus", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The current conversation has no active summary context items to focus."),
      ]),
    );
    return lines.join("\n");
  }

  const sourceContextHash = hashFocusSourceContext(summaries);
  const watermark = await store.getCoveredWatermark(current.stats.conversationId);
  const generation = await runDelegatedFocusBrief({
    deps: params.deps,
    requesterSessionKey,
    conversationId: current.stats.conversationId,
    focusPrompt: params.prompt,
    summaries,
  });
  const ordinalBySummaryId = new Map(summaries.map((summary) => [summary.summaryId, summary.ordinal]));
  const sources = [
    ...summaries.map((summary) => ({
      summaryId: summary.summaryId,
      ordinal: summary.ordinal,
      role: "active_input" as const,
    })),
    ...generation.citedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "cited" as const,
    })),
    ...generation.expandedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "expanded" as const,
    })),
    ...generation.irrelevantSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "irrelevant" as const,
    })),
  ];

  const ok = generation.status === "ok";
  const brief = await store.createFocusBrief({
    conversationId: current.stats.conversationId,
    sessionKey: requesterSessionKey,
    prompt: params.prompt,
    content: ok ? generation.briefMarkdown : "",
    status: ok ? "active" : "failed",
    tokenCount: generation.tokenCount,
    targetTokens: generation.targetTokens,
    coveredLatestAt: watermark.coveredLatestAt,
    coveredMessageSeq: watermark.coveredMessageSeq,
    sourceContextHash,
    generatorRunId: generation.runId,
    generatorSessionKey: generation.childSessionKey,
    rawResultJson:
      generation.rawResultJson ??
      JSON.stringify({
        status: generation.status,
        error: generation.error,
        rawReply: generation.rawReply,
      }),
    error: generation.error ?? null,
    sources,
    supersedeCurrentDrafts: ok,
  });

  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      buildStatLine("source summaries", formatNumber(summaries.length)),
      buildStatLine("source context hash", sourceContextHash.slice(0, 16)),
    ]),
    "",
    buildSection("🧹 Pre-focus compaction", [
      buildStatLine("status", "completed"),
      buildStatLine("compacted", formatBoolean(preFocusCompaction.result.compacted)),
      buildStatLine("result", preFocusCompaction.result.reason ?? "done"),
    ]),
    "",
    buildSection("🎯 Focus brief", [
      buildStatLine("brief id", formatCommand(brief.briefId)),
      buildStatLine("status", brief.status),
      buildStatLine("prompt", JSON.stringify(formatFocusPreview(params.prompt, 240))),
      buildStatLine("tokens", formatNumber(brief.tokenCount)),
      buildStatLine("target tokens", formatNumber(brief.targetTokens)),
      buildStatLine("generator run", generation.runId),
      buildStatLine("generator session", truncateMiddle(generation.childSessionKey, 60)),
      buildStatLine("truncated", formatBoolean(generation.truncated)),
    ]),
  );
  if (generation.warning) {
    lines.push("", buildSection("⚠️ Generation warning", [generation.warning]));
  }
  if (!ok) {
    lines.push(
      "",
      buildSection("⚠️ Generation failed", [
        generation.error ?? "Focus brief generation failed without a specific error.",
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    buildSection("📝 Preview", [formatFocusPreview(generation.briefMarkdown)]),
  );
  return lines.join("\n");
}

function isSummaryAfterFocusWatermark(
  summary: { latestAt: string | null; createdAt: string; maxSourceSeq?: number | null },
  brief: { coveredMessageSeq: number | null; coveredLatestAt: Date | null },
): boolean {
  if (brief.coveredMessageSeq != null && summary.maxSourceSeq != null) {
    return summary.maxSourceSeq > brief.coveredMessageSeq;
  }
  if (!brief.coveredLatestAt) {
    return true;
  }
  const timestamp = summary.latestAt ?? summary.createdAt;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) {
    return true;
  }
  return parsed > brief.coveredLatestAt.getTime();
}

// Refresh the active focus brief by merging relevant post-focus summary deltas
// into the existing brief. The old active brief is superseded only after a new
// active replacement is generated and persisted successfully.
async function buildRefocusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<RuntimeCommandEngine>;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Refocus",
    "",
  ];
  if (!params.deps || !params.getLcm) {
    lines.push(
      buildSection("🛠️ Refocus", [
        buildStatLine("status", "unavailable"),
        buildStatLine(
          "reason",
          "Refocus requires runtime dependencies for pre-refocus compaction and delegated subagents.",
        ),
      ]),
    );
    return lines.join("\n");
  }

  const requesterSessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (!requesterSessionKey) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "OpenClaw must expose the active session key for Lossless Claw to refocus."),
      ]),
    );
    return lines.join("\n");
  }

  let current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const store = new FocusBriefStore(params.db);
  const active = await store.getActiveFocusBrief(current.stats.conversationId);
  if (!active?.content.trim()) {
    lines.push(
      buildSection("🎯 Refocus", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", "The current conversation has no active focus brief to refresh."),
      ]),
    );
    return lines.join("\n");
  }

  const preRefocusCompaction = await runFocusLifecycleCompaction({
    ctx: params.ctx,
    deps: params.deps,
    getLcm: params.getLcm,
    config: params.config,
    current,
    sessionKey: requesterSessionKey,
  });
  if (preRefocusCompaction.status !== "ok") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      ]),
      "",
      buildSection("🧹 Pre-refocus compaction", [
        buildStatLine("status", preRefocusCompaction.status),
        buildStatLine("reason", preRefocusCompaction.reason),
      ]),
    );
    return lines.join("\n");
  }

  current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("🧹 Pre-refocus compaction", [
        buildStatLine("status", "completed"),
        buildStatLine("result", preRefocusCompaction.result.reason ?? "done"),
      ]),
      "",
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }

  const activeSummaries = await store.getActiveContextSummaries(current.stats.conversationId);
  const deltaSummaries = activeSummaries.filter((summary) =>
    isSummaryAfterFocusWatermark(summary, active),
  );
  if (deltaSummaries.length === 0) {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      ]),
      "",
      buildSection("🧹 Pre-refocus compaction", [
        buildStatLine("status", "completed"),
        buildStatLine("compacted", formatBoolean(preRefocusCompaction.result.compacted)),
        buildStatLine("result", preRefocusCompaction.result.reason ?? "done"),
      ]),
      "",
      buildSection("🎯 Refocus", [
        buildStatLine("status", "already current"),
        buildStatLine("active brief", formatCommand(active.briefId)),
        buildStatLine("delta summaries", "0"),
      ]),
    );
    return lines.join("\n");
  }

  const sourceContextHash = hashFocusSourceContext(activeSummaries);
  const watermark = await store.getCoveredWatermark(current.stats.conversationId);
  const generation = await runDelegatedRefocusBrief({
    deps: params.deps,
    requesterSessionKey,
    conversationId: current.stats.conversationId,
    focusPrompt: active.prompt,
    existingBriefMarkdown: active.content,
    deltaSummaries,
  });
  const ordinalBySummaryId = new Map(activeSummaries.map((summary) => [summary.summaryId, summary.ordinal]));
  const sources = [
    ...deltaSummaries.map((summary) => ({
      summaryId: summary.summaryId,
      ordinal: summary.ordinal,
      role: "active_input" as const,
    })),
    ...generation.citedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "cited" as const,
    })),
    ...generation.expandedSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "expanded" as const,
    })),
    ...generation.irrelevantSummaryIds.map((summaryId) => ({
      summaryId,
      ordinal: ordinalBySummaryId.get(summaryId) ?? null,
      role: "irrelevant" as const,
    })),
  ];

  const ok = generation.status === "ok";
  const brief = await store.createFocusBrief({
    conversationId: current.stats.conversationId,
    sessionKey: requesterSessionKey,
    prompt: active.prompt,
    content: ok ? generation.briefMarkdown : "",
    status: ok ? "active" : "failed",
    tokenCount: generation.tokenCount,
    targetTokens: generation.targetTokens,
    coveredLatestAt: watermark.coveredLatestAt,
    coveredMessageSeq: watermark.coveredMessageSeq,
    sourceContextHash,
    generatorRunId: generation.runId,
    generatorSessionKey: generation.childSessionKey,
    rawResultJson:
      generation.rawResultJson ??
      JSON.stringify({
        status: generation.status,
        error: generation.error,
        rawReply: generation.rawReply,
      }),
    error: generation.error ?? null,
    sources,
    supersedeCurrentDrafts: ok,
  });

  lines.push(
    buildSection("📍 Current conversation", [
      buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
      buildStatLine("session key", formatCommand(truncateMiddle(requesterSessionKey, 44))),
      buildStatLine("active brief", formatCommand(active.briefId)),
      buildStatLine("delta summaries", formatNumber(deltaSummaries.length)),
      buildStatLine("source context hash", sourceContextHash.slice(0, 16)),
    ]),
    "",
    buildSection("🧹 Pre-refocus compaction", [
      buildStatLine("status", "completed"),
      buildStatLine("compacted", formatBoolean(preRefocusCompaction.result.compacted)),
      buildStatLine("result", preRefocusCompaction.result.reason ?? "done"),
    ]),
    "",
    buildSection("🎯 Focus brief", [
      buildStatLine("brief id", formatCommand(brief.briefId)),
      buildStatLine("status", brief.status),
      buildStatLine("prompt", JSON.stringify(formatFocusPreview(active.prompt, 240))),
      buildStatLine("tokens", formatNumber(brief.tokenCount)),
      buildStatLine("target tokens", formatNumber(brief.targetTokens)),
      buildStatLine("generator run", generation.runId),
      buildStatLine("generator session", truncateMiddle(generation.childSessionKey, 60)),
      buildStatLine("truncated", formatBoolean(generation.truncated)),
    ]),
  );
  if (generation.warning) {
    lines.push("", buildSection("⚠️ Generation warning", [generation.warning]));
  }
  if (!ok) {
    lines.push(
      "",
      buildSection("⚠️ Generation failed", [
        generation.error ?? "Refocus brief generation failed without a specific error.",
      ]),
    );
    return lines.join("\n");
  }

  lines.push(
    "",
    buildSection("📝 Preview", [formatFocusPreview(generation.briefMarkdown)]),
  );
  return lines.join("\n");
}

// Deactivate the current focus overlay without deleting focus history.
async function buildUnfocusText(params: {
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<RuntimeCommandEngine>;
}): Promise<string> {
  const lines = [
    ...buildHeaderLines(),
    "",
    "🎯 Lossless Claw Focus",
    "",
  ];
  const current = await resolveCurrentConversation({ ctx: params.ctx, db: params.db });
  if (current.kind === "unavailable") {
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
      ]),
    );
    return lines.join("\n");
  }
  const store = new FocusBriefStore(params.db);
  const active = await store.getActiveFocusBrief(current.stats.conversationId);
  if (!active) {
    lines.push(
      buildSection("🎯 Focus", [
        buildStatLine("status", "none active"),
        buildStatLine("deactivated briefs", "0"),
      ]),
    );
    return lines.join("\n");
  }

  const deactivated = await store.deactivateActiveFocusBriefs(current.stats.conversationId);
  const postUnfocusCompaction = await runFocusLifecycleCompaction({
    ctx: params.ctx,
    deps: params.deps,
    getLcm: params.getLcm,
    config: params.config,
    current,
    sessionKey:
      normalizeIdentity(params.ctx.sessionKey) ??
      normalizeIdentity(current.stats.sessionKey ?? undefined),
  });

  lines.push(
    buildSection("🎯 Focus", [
      buildStatLine("status", deactivated > 0 ? "inactive" : "none active"),
      buildStatLine("deactivated briefs", formatNumber(deactivated)),
    ]),
  );
  lines.push(
    "",
    buildSection("🧹 Post-unfocus compaction", [
      buildStatLine(
        "status",
        postUnfocusCompaction.status === "ok" ? "completed" : postUnfocusCompaction.status,
      ),
      ...(postUnfocusCompaction.status === "ok"
        ? [
            buildStatLine("compacted", formatBoolean(postUnfocusCompaction.result.compacted)),
            buildStatLine("result", postUnfocusCompaction.result.reason ?? "done"),
          ]
        : [buildStatLine("reason", postUnfocusCompaction.reason)]),
    ]),
  );
  return lines.join("\n");
}

async function buildDoctorCleanersApplyText(params: {
  db: DatabaseSync;
  config: LcmConfig;
  filterId?: DoctorCleanerId;
  vacuum: boolean;
}): Promise<string> {
  const filterIds = params.filterId ? [params.filterId] : undefined;
  const unavailableReason = getDoctorCleanerApplyUnavailableReason(params.config.databasePath);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor Clean Apply",
    "",
    buildSection("🌐 Cleaner scope", [
      buildStatLine(
        "filters",
        filterIds && filterIds.length > 0
          ? filterIds.map((filter) => formatCommand(filter)).join(", ")
          : "all approved cleaner filters",
      ),
      buildStatLine("vacuum requested", formatBoolean(params.vacuum)),
    ]),
    "",
  ];
  if (unavailableReason) {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", unavailableReason),
      ]),
    );
    return lines.join("\n");
  }

  const before = scanDoctorCleaners(params.db, filterIds);
  lines.splice(
    lines.length - 1,
    0,
    buildSection("📊 Current matches", [
      buildStatLine("matched conversations before apply", formatNumber(before.totalDistinctConversations)),
      buildStatLine("matched messages before apply", formatNumber(before.totalDistinctMessages)),
    ]),
    "",
  );

  if (before.totalDistinctConversations === 0) {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "completed"),
        buildStatLine("backup path", "skipped (no matches)"),
        buildStatLine("deleted conversations", "0"),
        buildStatLine("deleted messages", "0"),
        buildStatLine("vacuumed", "no"),
        buildStatLine("quick_check", "not run (no writes)"),
        buildStatLine("result", "clean; no deletes ran"),
      ]),
    );
    return lines.join("\n");
  }

  let result: ReturnType<typeof applyDoctorCleaners>;
  try {
    result = applyDoctorCleaners(params.db, {
      databasePath: params.config.databasePath,
      filterIds,
      vacuum: params.vacuum,
    });
  } catch (error) {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "failed"),
        buildStatLine(
          "reason",
          error instanceof Error ? error.message : "unknown cleaner apply failure",
        ),
      ]),
    );
    return lines.join("\n");
  }

  if (result.kind === "unavailable") {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", result.reason),
      ]),
    );
    return lines.join("\n");
  }

  const quickCheck = runQuickCheck(params.db);
  const quickCheckPassed = isPassingQuickCheck(quickCheck);
  lines.push(
    buildSection("🛠️ Apply", [
      buildStatLine("status", quickCheckPassed ? "completed" : "warning"),
      buildStatLine("backup path", result.backupPath),
      buildStatLine("deleted conversations", formatNumber(result.deletedConversations)),
      buildStatLine("deleted messages", formatNumber(result.deletedMessages)),
      buildStatLine("vacuumed", formatBoolean(result.vacuumed)),
      buildStatLine("quick_check", quickCheck),
      buildStatLine(
        "result",
        quickCheckPassed
          ? result.deletedConversations > 0
            ? `removed ${formatNumber(result.deletedConversations)} conversation(s)`
            : "clean; no deletes ran"
          : "writes committed, but SQLite integrity verification reported problems; inspect the database or restore from the backup before continuing",
      ),
    ]),
  );

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
      runtimeContext: readCommandRuntimeContext(params.ctx),
      sessionKey: current.stats.sessionKey ?? normalizeIdentity(params.ctx.sessionKey),
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
  getLcm?: () => Promise<RuntimeCommandEngine>;
}): OpenClawPluginCommandDefinition {
  const getDb = async (): Promise<DatabaseSync> =>
    typeof params.db === "function" ? await params.db() : params.db;

  return {
    name: "lcm",
    nativeNames: {
      default: "lossless",
    },
    nativeProgressMessages: {
      telegram: "Lossless Claw is working...",
    },
    description:
      "Lossless Claw health, backups, compaction, junk review, and doctor tools.",
    acceptsArgs: true,
    handler: async (ctx) => {
      const parsed = parseLcmCommand(ctx.args);
      switch (parsed.kind) {
        case "status":
          return { text: await buildStatusText({ ctx, db: await getDb(), config: params.config }) };
        case "backup":
          return {
            text: await buildBackupText({
              db: await getDb(),
              config: params.config,
            }),
          };
        case "rotate":
          return {
            text: await buildRotateText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
            }),
          };
        case "focus_status":
          return { text: await buildFocusStatusText({ ctx, db: await getDb(), config: params.config }) };
        case "focus_generate":
          return {
            text: await buildFocusGenerateText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
              prompt: parsed.prompt,
            }),
          };
        case "refocus":
          return {
            text: await buildRefocusText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
            }),
          };
        case "unfocus":
          return {
            text: await buildUnfocusText({
              ctx,
              db: await getDb(),
              config: params.config,
              deps: params.deps,
              getLcm: params.getLcm,
            }),
          };
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
        case "doctor_cleaners":
          return parsed.apply
            ? {
                text: await buildDoctorCleanersApplyText({
                  db: await getDb(),
                  config: params.config,
                  filterId: parsed.filterId,
                  vacuum: parsed.vacuum,
                }),
              }
            : { text: await buildDoctorCleanersText({ db: await getDb() }) };
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
  scanDoctorCleaners,
  resolveCurrentConversation,
  resolveContextEngineSlot,
  resolvePluginEnabled,
  resolvePluginSelected,
};
