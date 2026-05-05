import { existsSync, statSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import packageJson from "../../package.json" with { type: "json" };
import { formatTimestamp } from "../compaction.js";
import type { LcmConfig } from "../db/config.js";
import type { RotateSessionStorageWithBackupResult } from "../engine.js";
import type { LcmSummarizeFn } from "../summarize.js";
import type { LcmDependencies } from "../types.js";
import type { OpenClawPluginCommandDefinition, PluginCommandContext } from "../openclaw-bridge.js";
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
import {
  getV41HealthSnapshot,
  type V41HealthSnapshot,
  type WorkerStatus,
} from "../operator/health.js";
import {
  listLegacyCandidates,
  reconcileSessionKeys,
  ReconcileError,
  type ReconcileResult,
} from "../operator/reconcile-session-keys.js";
import {
  EvalRunnerError,
  formatEvalReport,
  runEval,
  type EvalMode,
  type RunEvalArgs,
} from "../operator/eval-runner.js";
import { getWorkerStatusSnapshot } from "../operator/worker-orchestrator.js";
import { runHybridSearch } from "../embeddings/hybrid-search.js";
import { vec0Version } from "../embeddings/store.js";
import { SummaryStore } from "../store/summary-store.js";
import { getLcmDbFeatures } from "../db/features.js";

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
  | { kind: "doctor"; apply: boolean }
  | { kind: "doctor_cleaners"; apply: boolean; filterId?: DoctorCleanerId; vacuum: boolean }
  | { kind: "health" }
  | { kind: "worker_status" }
  | { kind: "reconcile_session_keys_list" }
  | {
      kind: "reconcile_session_keys_apply";
      fromSessionKeys: string[];
      toSessionKey: string;
      reason: string;
      allowMainSession: boolean;
    }
  | { kind: "eval"; mode: EvalMode; querySetName: string; querySetVersion: number }
  | { kind: "help"; error?: string };

type RotateCommandEngine = {
  rotateSessionStorageWithBackup(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile: string;
    lockTimeoutMs: number;
  }): Promise<RotateSessionStorageWithBackupResult>;
};

const DOCTOR_CLEANER_IDS = new Set<DoctorCleanerId>(getDoctorCleanerFilterIds());

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

/**
 * Tokenize a raw argument string respecting double-quoted segments. Used
 * by subcommands whose flag values can contain spaces (`--reason "all
 * rebase work"`). Returns the list of tokens with surrounding quotes
 * stripped. Backslash inside a quoted region escapes the next char.
 */
function splitArgsQuoted(rawArgs: string | undefined): string[] {
  const text = rawArgs ?? "";
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inQuote) {
      if (ch === "\\" && i + 1 < text.length) {
        cur += text[i + 1];
        i += 1;
        continue;
      }
      if (ch === '"') {
        inQuote = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inQuote = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur.length > 0) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

interface EvalParseResult {
  baseline: boolean;
  mode?: EvalMode;
  querySet?: string;
  querySetVersion?: number;
}

const EVAL_MODES: EvalMode[] = ["fts_only", "semantic_only", "hybrid"];
const DEFAULT_EVAL_QUERY_SET_NAME = "eva-baseline";
const DEFAULT_EVAL_QUERY_SET_VERSION = 1;

function parseEvalArgs(tokens: string[]):
  | { ok: true; parsed: EvalParseResult }
  | { ok: false; error: string } {
  const result: EvalParseResult = { baseline: false };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t) {
      case "--baseline":
        result.baseline = true;
        break;
      case "--mode": {
        const v = tokens[i + 1];
        if (!v) return { ok: false, error: "`--mode` requires a value (fts_only|semantic_only|hybrid)." };
        if (!EVAL_MODES.includes(v as EvalMode)) {
          return { ok: false, error: `Unknown mode \`${v}\`. Supported: ${EVAL_MODES.join(", ")}.` };
        }
        result.mode = v as EvalMode;
        i += 1;
        break;
      }
      case "--query-set": {
        const v = tokens[i + 1];
        if (!v) return { ok: false, error: "`--query-set` requires a value." };
        result.querySet = v;
        i += 1;
        break;
      }
      case "--version": {
        const v = tokens[i + 1];
        if (!v) return { ok: false, error: "`--version` requires a value." };
        const parsed = Number.parseInt(v, 10);
        if (!Number.isFinite(parsed) || parsed < 1) {
          return { ok: false, error: `\`--version\` must be a positive integer (got \`${v}\`).` };
        }
        result.querySetVersion = parsed;
        i += 1;
        break;
      }
      default:
        return { ok: false, error: `Unknown argument \`${t}\` for \`/lcm eval\`.` };
    }
  }
  return { ok: true, parsed: result };
}

interface ReconcileParseResult {
  fromSessionKeys: string[];
  toSessionKey?: string;
  reason?: string;
  allowMainSession: boolean;
  list: boolean;
  apply: boolean;
}

function parseReconcileArgs(tokens: string[]):
  | { ok: true; parsed: ReconcileParseResult }
  | { ok: false; error: string } {
  const result: ReconcileParseResult = {
    fromSessionKeys: [],
    allowMainSession: false,
    list: false,
    apply: false,
  };
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    switch (t) {
      case "--list-candidates":
        result.list = true;
        break;
      case "--apply":
        result.apply = true;
        break;
      case "--allow-main-session":
        result.allowMainSession = true;
        break;
      case "--from": {
        const v = tokens[i + 1];
        if (!v) return { ok: false, error: "`--from` requires a comma-separated session_key list." };
        result.fromSessionKeys = v.split(",").map((s) => s.trim()).filter(Boolean);
        i += 1;
        break;
      }
      case "--to": {
        const v = tokens[i + 1];
        if (!v) return { ok: false, error: "`--to` requires a session_key." };
        result.toSessionKey = v;
        i += 1;
        break;
      }
      case "--reason": {
        const v = tokens[i + 1];
        if (!v) return { ok: false, error: "`--reason` requires a string." };
        result.reason = v;
        i += 1;
        break;
      }
      default:
        return { ok: false, error: `Unknown argument \`${t}\` for \`/lcm reconcile-session-keys\`.` };
    }
  }
  return { ok: true, parsed: result };
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
    case "health":
      return rest.length === 0
        ? { kind: "health" }
        : { kind: "help", error: "`/lcm health` does not accept extra arguments." };
    case "eval": {
      const idx = (rawArgs ?? "").toLowerCase().indexOf("eval");
      const remainder = idx >= 0 ? (rawArgs ?? "").slice(idx + "eval".length) : "";
      const quoted = splitArgsQuoted(remainder);
      const r = parseEvalArgs(quoted);
      if (!r.ok) {
        return { kind: "help", error: r.error };
      }
      const { parsed } = r;
      // --baseline shorthand: defaults to fts_only against eva-baseline v1.
      const mode: EvalMode = parsed.mode ?? (parsed.baseline ? "fts_only" : "fts_only");
      if (!parsed.mode && !parsed.baseline) {
        // Plain `/lcm eval` is ambiguous — require either flag.
        return {
          kind: "help",
          error: "`/lcm eval` requires `--baseline` or `--mode <fts_only|semantic_only|hybrid>`.",
        };
      }
      const querySetName = parsed.querySet ?? DEFAULT_EVAL_QUERY_SET_NAME;
      const querySetVersion = parsed.querySetVersion ?? DEFAULT_EVAL_QUERY_SET_VERSION;
      return {
        kind: "eval",
        mode,
        querySetName,
        querySetVersion,
      };
    }
    case "reconcile-session-keys": {
      // Re-tokenize via the quote-aware splitter so `--reason "..."`
      // survives. We strip the leading subcommand token from the raw
      // arg string and re-parse the remainder.
      const idx = (rawArgs ?? "").toLowerCase().indexOf("reconcile-session-keys");
      const remainder = idx >= 0
        ? (rawArgs ?? "").slice(idx + "reconcile-session-keys".length)
        : "";
      const quoted = splitArgsQuoted(remainder);
      const r = parseReconcileArgs(quoted);
      if (!r.ok) {
        return { kind: "help", error: r.error };
      }
      const { parsed } = r;
      if (parsed.list && parsed.apply) {
        return { kind: "help", error: "`/lcm reconcile-session-keys` cannot combine `--list-candidates` with `--apply`." };
      }
      if (parsed.list) {
        return { kind: "reconcile_session_keys_list" };
      }
      if (!parsed.apply) {
        return {
          kind: "help",
          error: "`/lcm reconcile-session-keys` requires `--list-candidates` or `--apply --from k1,k2 --to k3 --reason \"...\"`.",
        };
      }
      if (parsed.fromSessionKeys.length === 0) {
        return { kind: "help", error: "`/lcm reconcile-session-keys --apply` requires `--from <comma-separated session_keys>`." };
      }
      if (!parsed.toSessionKey) {
        return { kind: "help", error: "`/lcm reconcile-session-keys --apply` requires `--to <destination session_key>`." };
      }
      if (!parsed.reason || parsed.reason.trim().length === 0) {
        return { kind: "help", error: "`/lcm reconcile-session-keys --apply` requires `--reason \"...\"`." };
      }
      return {
        kind: "reconcile_session_keys_apply",
        fromSessionKeys: parsed.fromSessionKeys,
        toSessionKey: parsed.toSessionKey,
        reason: parsed.reason,
        allowMainSession: parsed.allowMainSession,
      };
    }
    case "worker": {
      // /lcm worker [status]
      // Currently only `status` is wired (Final review #3 partial fix).
      // Manual `tick <kind>` is deferred to a follow-up wiring commit
      // — the underlying orchestrator service is in src/operator/
      // worker-orchestrator.ts; production wiring needs an LLM-call
      // injection path that's not yet plumbed through the plugin.
      if (rest.length === 0 || rest[0]?.toLowerCase() === "status") {
        return { kind: "worker_status" };
      }
      return {
        kind: "help",
        error:
          `\`${VISIBLE_COMMAND} worker\` currently supports \`status\` only. ` +
          `Manual \`tick <kind>\` deferred to follow-up; backfill / extraction / ` +
          `procedure-mining / themes-consolidation services exist in src/operator/ ` +
          `but are not yet wired into the plugin lifecycle (cycle-2 work).`,
      };
    }
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
        error: `Unknown subcommand \`${head}\`. Supported: status, backup, rotate, health, worker, reconcile-session-keys, eval, doctor, doctor clean, doctor apply, help.`,
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

async function resolveRotateSessionId(params: {
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
        formatCommand(`${VISIBLE_COMMAND} health`),
        "Show LCM v4.1 subsystem health: embeddings, workers, synthesis, eval, suppression.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} reconcile-session-keys --list-candidates`),
        "List `legacy:conv_*` session keys that may be candidates for merging.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} reconcile-session-keys --apply --from k1,k2 --to k3 --reason "..."`),
        "Merge multiple legacy session keys into one logical session.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} eval --baseline`),
        "Run the baseline eval (default: eva-baseline v1, fts_only) and report recall + drift.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} eval --mode hybrid --query-set <name> --version <n>`),
        "Run an eval against a specific query set + retrieval mode.",
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
  getLcm?: () => Promise<RotateCommandEngine>;
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

  const sessionId = await resolveRotateSessionId({
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

function formatWorkerLine(worker: WorkerStatus): string {
  if (!worker.active) {
    return `${worker.jobKind}: (idle)`;
  }
  const expiredFlag = worker.expired ? " EXPIRED" : "";
  const id = worker.workerId ?? "unknown";
  const acquired = worker.acquiredAt ?? "unknown";
  const expires = worker.expiresAt ?? "unknown";
  return `${worker.jobKind}: worker_id=${id}${expiredFlag} acquired_at=${acquired} expires_at=${expires}`;
}

function formatHealthSnapshot(snapshot: V41HealthSnapshot): string[] {
  const lines: string[] = [];

  // ── Embeddings ───────────────────────────────────────────────────
  const embeddingsLines: string[] = [];
  if (snapshot.embeddings.activeProfile) {
    const p = snapshot.embeddings.activeProfile;
    embeddingsLines.push(buildStatLine("active model", `${p.modelName} (dim=${formatNumber(p.dim)})`));
  } else {
    embeddingsLines.push(buildStatLine("active model", "NOT REGISTERED"));
  }
  embeddingsLines.push(
    buildStatLine(
      "vec0 status",
      snapshot.embeddings.vec0Version ?? "NOT LOADED",
    ),
  );
  embeddingsLines.push(
    buildStatLine("pending backfill", `${formatNumber(snapshot.embeddings.pendingBackfill)} docs`),
  );
  embeddingsLines.push(buildStatLine("embedded count", formatNumber(snapshot.embeddings.embeddedCount)));
  lines.push(buildSection("Embeddings", embeddingsLines));

  // ── Workers ──────────────────────────────────────────────────────
  lines.push("");
  lines.push(buildSection("Workers", snapshot.workers.map(formatWorkerLine)));

  // ── Synthesis ────────────────────────────────────────────────────
  lines.push("");
  lines.push(
    buildSection("Synthesis", [
      buildStatLine(
        "active prompts",
        `${formatNumber(snapshot.synthesis.activePromptCount)} across ${formatNumber(snapshot.synthesis.distinctMemoryTypeCount)} memory_types`,
      ),
      buildStatLine(
        "recent synthesis runs",
        `${formatNumber(snapshot.synthesis.recentSynthesisRuns7d)} (last 7 days)`,
      ),
    ]),
  );

  // ── Eval ─────────────────────────────────────────────────────────
  lines.push("");
  const evalLines = [
    buildStatLine("query sets registered", formatNumber(snapshot.eval.querySetCount)),
  ];
  if (snapshot.eval.mostRecentRun) {
    const r = snapshot.eval.mostRecentRun;
    evalLines.push(
      buildStatLine(
        "most-recent run",
        `${r.querySetId} mode=${r.mode} recall=${r.recallScore.toFixed(3)} (run_id=${r.runId})`,
      ),
    );
  } else {
    evalLines.push(buildStatLine("most-recent run", "(none)"));
  }
  if (snapshot.eval.driftIndex === null) {
    evalLines.push(buildStatLine("drift index", "(no baseline)"));
  } else {
    const sign = snapshot.eval.driftIndex >= 0 ? "+" : "";
    evalLines.push(buildStatLine("drift index", `${sign}${snapshot.eval.driftIndex.toFixed(4)}`));
  }
  lines.push(buildSection("Eval", evalLines));

  // ── Suppression ──────────────────────────────────────────────────
  lines.push("");
  lines.push(
    buildSection("Suppression", [
      buildStatLine("suppressed leaves", formatNumber(snapshot.suppression.suppressedLeaves)),
      buildStatLine(
        "pending purge rebuilds",
        formatNumber(snapshot.suppression.pendingPurgeRebuilds),
      ),
    ]),
  );

  return lines;
}

function buildHealthText(params: { db: DatabaseSync }): string {
  const snapshot = getV41HealthSnapshot(params.db);
  const lines: string[] = [
    ...buildHeaderLines(),
    "",
    "### v4.1 Health",
    "",
    ...formatHealthSnapshot(snapshot),
  ];
  return lines.join("\n");
}

function buildWorkerStatusText(params: { db: DatabaseSync }): string {
  // Final review #3 partial fix: surface worker-orchestrator state.
  // Manual `tick <kind>` deferred — the underlying services exist
  // (src/operator/worker-orchestrator.ts) but their LLM-call wiring
  // through the plugin lifecycle is cycle-2 work.
  const snapshot = getWorkerStatusSnapshot(params.db);
  const lines: string[] = [
    ...buildHeaderLines(),
    "",
    "### Worker Status",
    "",
  ];
  for (const [kind, lockInfo] of Object.entries(snapshot.locks)) {
    if (lockInfo) {
      lines.push(
        `- **${kind}**: HELD by \`${lockInfo.workerId}\` (acquired ${lockInfo.acquiredAt}, expires ${lockInfo.expiresAt}); jobMetadata=${lockInfo.jobMetadata ?? "(none)"}`,
      );
    } else {
      lines.push(`- **${kind}**: idle (no lock held)`);
    }
  }
  lines.push("");
  lines.push("### Pending Work");
  lines.push("");
  lines.push(
    `- Embedding backfill pending: ${snapshot.pending.embeddingBackfill === -1 ? "(model not specified)" : snapshot.pending.embeddingBackfill}`,
  );
  lines.push(`- Extraction queue: ${snapshot.pending.extractionQueue}`);
  lines.push("");
  lines.push("### Note");
  lines.push("");
  lines.push(
    "Manual `/lcm worker tick <kind>` is not yet wired in this PR. The worker " +
      "orchestrator service (`src/operator/worker-orchestrator.ts`) exists and " +
      "is testable, but production wiring (including LLM-call injection for " +
      "extraction / procedure-mining / themes) is deferred to a cycle-2 commit. " +
      "Today, view-only status reporting; for manual ticks against a dev DB, " +
      "import `tickEmbeddingBackfill` etc. from `src/operator/worker-orchestrator.ts`.",
  );
  return lines.join("\n");
}

function buildReconcileListText(params: { db: DatabaseSync }): string {
  const candidates = listLegacyCandidates(params.db);
  const lines: string[] = [
    ...buildHeaderLines(),
    "",
    "🔗 Lossless Claw Reconcile Session Keys",
    "",
    buildSection("📋 Legacy candidates", [
      buildStatLine("matched session keys", formatNumber(candidates.length)),
    ]),
  ];
  if (candidates.length === 0) {
    lines.push(
      "",
      buildSection("✅ Result", ["No `legacy:conv_*` session keys present."]),
    );
    return lines.join("\n");
  }
  lines.push(
    "",
    buildSection(
      "🧷 Candidates",
      candidates.map((c) =>
        `${formatCommand(truncateMiddle(c.sessionKey, 44))} · convs=${formatNumber(c.conversationCount)} · leaves=${formatNumber(c.leafCount)}`,
      ),
    ),
    "",
    buildSection("🛠️ Next step", [
      `${formatCommand(`${VISIBLE_COMMAND} reconcile-session-keys --apply --from k1,k2 --to my-thread --reason "..."`)} merges the listed keys.`,
    ]),
  );
  return lines.join("\n");
}

/**
 * Build a recall search adapter that wraps `summaryStore.searchSummaries`
 * in `mode='full_text'`. Returns IDs in rank order. Used by the
 * fts_only eval mode and by the FTS arm of hybrid (when the operator
 * picks --mode hybrid but vec0 is unavailable).
 */
function buildFtsOnlyAdapter(db: DatabaseSync): RunEvalArgs["retrievalAdapter"] {
  const { fts5Available } = getLcmDbFeatures(db);
  const summaryStore = new SummaryStore(db, { fts5Available });
  return {
    async search(query) {
      const hits = await summaryStore.searchSummaries({
        query: query.queryText,
        mode: "full_text",
        limit: 50,
      });
      return hits.map((h) => h.summaryId);
    },
  };
}

/**
 * Build a hybrid adapter wrapping `runHybridSearch`. The hybrid arm
 * gracefully degrades to FTS-only inside runHybridSearch itself if
 * vec0 isn't available; we surface that via the eval report so the
 * operator sees the warning.
 *
 * Note: the hybrid path requires Voyage credentials in the env (or a
 * test-injected fetch). For an operator-driven `/lcm eval --mode
 * hybrid` invocation we assume credentials are set; tests use
 * fts_only with mocked adapters.
 */
function buildHybridAdapter(db: DatabaseSync): RunEvalArgs["retrievalAdapter"] {
  const ftsAdapter = buildFtsOnlyAdapter(db);
  return {
    async search(query) {
      try {
        // Re-build the FTS hit shape inside the adapter — runHybridSearch
        // wants ftsSearch to return FtsHit, not summaryIds, but we already
        // collapse to IDs at the end so we re-run the lookup here for
        // simplicity (the operator eval path is not perf-sensitive).
        const { fts5Available } = getLcmDbFeatures(db);
        const summaryStore = new SummaryStore(db, { fts5Available });
        const result = await runHybridSearch(db, {
          query: query.queryText,
          rerank: false, // RRF fusion only — no Voyage rerank cost in eval path
          ftsSearch: async (args) => {
            const hits = await summaryStore.searchSummaries({
              query: args.query,
              mode: "full_text",
              limit: args.limit,
            });
            return hits.map((h, idx) => ({
              summaryId: h.summaryId,
              conversationId: h.conversationId,
              sessionKey: "",
              kind: h.kind as "leaf" | "condensed",
              content: h.snippet,
              tokenCount: 0,
              createdAt: h.createdAt.toISOString(),
              rank: idx,
            }));
          },
        });
        return result.hits.map((h) => h.summaryId);
      } catch {
        // Hybrid arm unavailable (vec0 missing, no key, etc.) — fall
        // back to FTS-only for this single query so the eval still
        // produces a result.
        return ftsAdapter.search(query);
      }
    },
  };
}

async function buildEvalText(params: {
  db: DatabaseSync;
  mode: EvalMode;
  querySetName: string;
  querySetVersion: number;
}): Promise<string> {
  const lines: string[] = [
    ...buildHeaderLines(),
    "",
    "🧪 Lossless Claw Eval",
    "",
    buildSection("📋 Plan", [
      buildStatLine("query set", `${params.querySetName} v${params.querySetVersion}`),
      buildStatLine("mode", formatCommand(params.mode)),
    ]),
    "",
  ];

  // Pick the retrieval adapter for the requested mode.
  let adapter: RunEvalArgs["retrievalAdapter"];
  if (params.mode === "fts_only") {
    adapter = buildFtsOnlyAdapter(params.db);
  } else if (params.mode === "hybrid") {
    if (vec0Version(params.db) === null) {
      lines.push(
        buildSection("⚠️ Warning", [
          "vec0 is not loaded — hybrid mode will degrade to FTS-only inside the adapter.",
        ]),
        "",
      );
    }
    adapter = buildHybridAdapter(params.db);
  } else {
    // semantic_only — not yet wired separately; treat as hybrid for v4.1
    // first cut. The hybrid adapter already covers the "if vec0 absent
    // fall back to FTS" case so the user gets a meaningful result.
    lines.push(
      buildSection("ℹ️ Note", [
        "`semantic_only` is wired through the hybrid adapter for v4.1 first cut (RRF fusion, no rerank).",
      ]),
      "",
    );
    adapter = buildHybridAdapter(params.db);
  }

  try {
    const result = await runEval(params.db, {
      querySetIdentity: { name: params.querySetName, version: params.querySetVersion },
      mode: params.mode,
      retrievalAdapter: adapter,
    });
    lines.push(
      buildSection("📊 Result", [
        formatEvalReport({
          querySetIdentity: { name: params.querySetName, version: params.querySetVersion },
          mode: params.mode,
          result,
        }),
      ]),
    );
  } catch (e) {
    if (e instanceof EvalRunnerError) {
      lines.push(
        buildSection("🛠️ Eval", [
          buildStatLine("status", "failed"),
          buildStatLine("kind", e.kind),
          buildStatLine("reason", e.message),
        ]),
      );
      return lines.join("\n");
    }
    lines.push(
      buildSection("🛠️ Eval", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", formatFailureReason(e)),
      ]),
    );
  }
  return lines.join("\n");
}

function buildReconcileApplyText(params: {
  db: DatabaseSync;
  fromSessionKeys: string[];
  toSessionKey: string;
  reason: string;
  allowMainSession: boolean;
}): string {
  const lines: string[] = [
    ...buildHeaderLines(),
    "",
    "🔗 Lossless Claw Reconcile Session Keys",
    "",
    buildSection("📋 Plan", [
      buildStatLine("from", params.fromSessionKeys.map((k) => formatCommand(truncateMiddle(k, 44))).join(", ")),
      buildStatLine("to", formatCommand(truncateMiddle(params.toSessionKey, 44))),
      buildStatLine("reason", params.reason),
      buildStatLine("allow main session", formatBoolean(params.allowMainSession)),
    ]),
    "",
  ];

  let result: ReconcileResult;
  try {
    result = reconcileSessionKeys(params.db, {
      fromSessionKeys: params.fromSessionKeys,
      toSessionKey: params.toSessionKey,
      reason: params.reason,
      allowMainSession: params.allowMainSession,
    });
  } catch (e) {
    if (e instanceof ReconcileError) {
      lines.push(
        buildSection("🛠️ Apply", [
          buildStatLine("status", "failed"),
          buildStatLine("kind", e.kind),
          buildStatLine("reason", e.message),
        ]),
      );
      return lines.join("\n");
    }
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", formatFailureReason(e)),
      ]),
    );
    return lines.join("\n");
  }

  const fromLabel = params.fromSessionKeys.map((k) => `\`${truncateMiddle(k, 32)}\``).join(", ");
  lines.push(
    buildSection("🛠️ Apply", [
      buildStatLine("status", "completed"),
      buildStatLine("conversations moved", formatNumber(result.conversationsMoved)),
      buildStatLine("summaries moved", formatNumber(result.summariesMoved)),
      buildStatLine("audit entries", formatNumber(result.auditEntries)),
      buildStatLine(
        "summary",
        `Moved ${formatNumber(result.conversationsMoved)} conversations, ${formatNumber(result.summariesMoved)} summaries from {${fromLabel}} to ${formatCommand(truncateMiddle(params.toSessionKey, 44))}`,
      ),
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
  getLcm?: () => Promise<RotateCommandEngine>;
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
      "Show Lossless Claw health, create DB backups, compact the current session transcript while preserving LCM context, inspect high-confidence junk candidates, and run scoped doctor actions.",
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
        case "health":
          return { text: buildHealthText({ db: await getDb() }) };
        case "worker_status":
          return { text: buildWorkerStatusText({ db: await getDb() }) };
        case "reconcile_session_keys_list":
          return { text: buildReconcileListText({ db: await getDb() }) };
        case "reconcile_session_keys_apply":
          return {
            text: buildReconcileApplyText({
              db: await getDb(),
              fromSessionKeys: parsed.fromSessionKeys,
              toSessionKey: parsed.toSessionKey,
              reason: parsed.reason,
              allowMainSession: parsed.allowMainSession,
            }),
          };
        case "eval":
          return {
            text: await buildEvalText({
              db: await getDb(),
              mode: parsed.mode,
              querySetName: parsed.querySetName,
              querySetVersion: parsed.querySetVersion,
            }),
          };
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
