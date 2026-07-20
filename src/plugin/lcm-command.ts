import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import packageJson from "../../package.json" with { type: "json" };
import { formatTimestamp } from "../compaction.js";
import { resolveOpenclawStateDir, type LcmConfig } from "../db/config.js";
import type { RotateSessionStorageWithBackupResult } from "../engine.js";
import { runDelegatedFocusBrief, runDelegatedRefocusBrief } from "../focus-briefs.js";
import type { LcmSummarizeFn } from "../summarize.js";
import type { LcmDependencies } from "../types.js";
import type {
  CompactResult,
  ContextEngineControlCapabilities,
  ContextEngineControlOperation,
  ContextEngineControlResult,
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
  applyRolloverSplitRepair,
  scanRolloverSplits,
  type RolloverSplitCounts,
  type RolloverSplitExample,
} from "./lcm-doctor-rollover-splits.js";
import { scanLcmVersionCopies, type LcmVersionDoctorScan } from "./lcm-version-doctor.js";
import {
  CompactionMaintenanceStore,
  type ConversationCompactionMaintenanceRecord,
} from "../store/compaction-maintenance-store.js";
import { FocusBriefStore, hashFocusSourceContext } from "../store/focus-brief-store.js";

const VISIBLE_COMMAND = "/lossless";
const HIDDEN_ALIAS = "/lcm";
const LOSSLESS_PLUGIN_ID = "lossless-claw";
const LOSSLESS_NPM_PACKAGE = "@martian-engineering/lossless-claw";
const INSTALLED_PLUGIN_INDEX_KEY = "installed-plugin-index";
const ROTATE_DATABASE_LOCK_TIMEOUT_MS = 30_000;
const DOCTOR_APPLY_LARGE_TARGET_THRESHOLD = 25;
const DOCTOR_APPLY_BUDGET_PRESSURE_RATIO = 0.75;

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
      source: "session_key" | "session_key_via_session_id" | "session_id" | "conversation_id";
      stats: LcmConversationStatusStats;
    }
  | {
      kind: "unavailable";
      reason: string;
    };
type DoctorApplyOptions = {
  confirmOffline: boolean;
  conversationId?: number;
};
type DoctorApplyRepairMetrics = {
  repairInputTokenCount: number;
  repairTargetSourceTokenCount: number;
};
type RolloverSplitApplyOptions = {
  confirm: boolean;
};
type LcmInstallTrackWarning = {
  kind: "exact-pinned";
  spec: string;
  version: string;
};

type ParsedLcmCommand =
  | { kind: "status" }
  | { kind: "backup" }
  | { kind: "rotate" }
  | { kind: "focus_status" }
  | { kind: "focus_generate"; prompt: string }
  | { kind: "refocus" }
  | { kind: "unfocus" }
  | { kind: "doctor"; apply: boolean; applyOptions?: DoctorApplyOptions }
  | { kind: "doctor_rollover_splits"; apply: boolean; applyOptions?: RolloverSplitApplyOptions }
  | { kind: "doctor_cleaners"; apply: boolean; filterId?: DoctorCleanerId; vacuum: boolean }
  | { kind: "help"; error?: string };

type RotateCommandEngine = {
  rotateSessionStorageWithBackup(params: {
    sessionId?: string;
    sessionKey?: string;
    sessionFile: string;
    lockTimeoutMs: number;
    runtimeContext?: Record<string, unknown>;
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

/** Error thrown when a host requests a control operation that cannot run safely. */
export class LcmProgrammaticControlUnavailableError extends Error {
  constructor(
    readonly operation: string,
    readonly reasonCode: string,
    message = "Lossless Claw control operation is unavailable.",
  ) {
    super(message);
    this.name = "LcmProgrammaticControlUnavailableError";
  }
}

/** Error thrown when a supported control operation fails after starting. */
export class LcmProgrammaticControlFailedError extends Error {
  constructor(
    readonly operation: string,
    readonly reasonCode: string,
    message = "Lossless Claw control operation failed.",
  ) {
    super(message);
    this.name = "LcmProgrammaticControlFailedError";
  }
}

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

function readStringField(record: Record<string, unknown> | undefined, key: string): string {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function listConfigCandidates(ctx: PluginCommandContext, fallbackConfig?: unknown): unknown[] {
  const candidates: unknown[] = [];
  if (ctx.config !== undefined) {
    candidates.push(ctx.config);
  }
  if (fallbackConfig !== undefined && fallbackConfig !== ctx.config) {
    candidates.push(fallbackConfig);
  }
  return candidates;
}

function readEffectiveSelectionConfig(
  ctx: PluginCommandContext,
  fallbackConfig?: unknown,
): unknown {
  return ctx.config ?? fallbackConfig;
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) {
    return undefined;
  }
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return undefined;
  }
}

function resolveOpenClawStateSqlitePath(): string | undefined {
  if (process.env.VITEST && !process.env.OPENCLAW_STATE_DIR?.trim()) {
    return undefined;
  }
  return join(resolveOpenclawStateDir(), "state", "openclaw.sqlite");
}

/** Read the host's durable install metadata when OpenClaw has not exposed it on command config. */
function readPersistedOpenClawInstallRecords(): Record<string, unknown> | undefined {
  const dbPath = resolveOpenClawStateSqlitePath();
  if (!dbPath || !existsSync(dbPath)) {
    return undefined;
  }

  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare(
      `SELECT install_records_json
         FROM installed_plugin_index
        WHERE index_key = ?`,
    ).get(INSTALLED_PLUGIN_INDEX_KEY) as { install_records_json?: string | null } | undefined;
    return parseJsonRecord(row?.install_records_json);
  } catch {
    return undefined;
  } finally {
    db?.close();
  }
}

function readPersistedOpenClawInstallRecordsConfig(): unknown {
  const installRecords = readPersistedOpenClawInstallRecords();
  return installRecords ? { plugins: { installs: installRecords } } : undefined;
}

function normalizeLosslessInstallRecord(value: unknown): Record<string, unknown> | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const id = readStringField(record, "id") || readStringField(record, "pluginId");
  const name = readStringField(record, "name") || readStringField(record, "packageName");
  const spec =
    readStringField(record, "spec")
    || readStringField(record, "installSpec")
    || readStringField(record, "packageSpec")
    || readStringField(record, "resolvedSpec");
  if (
    (id && id !== LOSSLESS_PLUGIN_ID)
    || (name && name !== LOSSLESS_PLUGIN_ID && name !== LOSSLESS_NPM_PACKAGE)
  ) {
    return undefined;
  }
  if (!id && !name && spec && !spec.includes(LOSSLESS_NPM_PACKAGE)) {
    return undefined;
  }
  return record;
}

function collectLosslessInstallRecords(config: unknown): Record<string, unknown>[] {
  const root = asRecord(config);
  const plugins = asRecord(root?.plugins);
  const entries = asRecord(plugins?.entries);
  const entry = asRecord(entries?.[LOSSLESS_PLUGIN_ID]);
  const records: Record<string, unknown>[] = [];

  const pushRecord = (value: unknown): void => {
    const record = normalizeLosslessInstallRecord(value);
    if (record) {
      records.push(record);
    }
  };

  pushRecord(entry);

  for (const container of [
    asRecord(plugins?.installs),
    asRecord(plugins?.installed),
    asRecord(plugins?.registry),
    asRecord(root?.pluginInstalls),
  ]) {
    pushRecord(container?.[LOSSLESS_PLUGIN_ID]);
    pushRecord(container?.[LOSSLESS_NPM_PACKAGE]);
  }

  for (const list of [plugins?.installs, plugins?.installed, root?.pluginInstalls]) {
    if (Array.isArray(list)) {
      for (const item of list) {
        pushRecord(item);
      }
    }
  }

  return records;
}

function parseExactLosslessPackageVersion(spec: string): string | null {
  const trimmed = spec.trim();
  if (!trimmed.startsWith(`${LOSSLESS_NPM_PACKAGE}@`)) {
    return null;
  }
  const version = trimmed.slice(LOSSLESS_NPM_PACKAGE.length + 1).trim();
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
    ? version
    : null;
}

function detectLcmInstallTrackWarning(params: {
  ctx: PluginCommandContext;
  fallbackConfig?: unknown;
}): LcmInstallTrackWarning | null {
  const selectionConfig = readEffectiveSelectionConfig(params.ctx, params.fallbackConfig);
  if (!resolvePluginEnabled(selectionConfig) || !resolvePluginSelected(selectionConfig)) {
    return null;
  }

  for (const config of [
    ...listConfigCandidates(params.ctx, params.fallbackConfig),
    readPersistedOpenClawInstallRecordsConfig(),
  ]) {
    for (const record of collectLosslessInstallRecords(config)) {
      const source = readStringField(record, "source") || readStringField(record, "type");
      if (source && source !== "npm") {
        continue;
      }
      const spec =
        readStringField(record, "spec")
        || readStringField(record, "installSpec")
        || readStringField(record, "packageSpec")
        || readStringField(record, "resolvedSpec");
      const version = parseExactLosslessPackageVersion(spec);
      if (version) {
        return { kind: "exact-pinned", spec, version };
      }
    }
  }

  return null;
}

function buildInstallTrackWarningSection(warning: LcmInstallTrackWarning): string {
  return buildSection("⚠️ Update track", [
    buildStatLine("status", warning.kind),
    buildStatLine("installed spec", formatCommand(warning.spec)),
    buildStatLine(
      "impact",
      "OpenClaw plugin update sync will keep this exact version and will not follow new LCM releases.",
    ),
    buildStatLine(
      "repair",
      formatCommand(`openclaw plugins update ${LOSSLESS_NPM_PACKAGE}@latest`),
    ),
  ]);
}

/** Format the active package identity and every distinct copy discovered by doctor. */
function buildVersionDoctorSection(scan: LcmVersionDoctorScan): string {
  const lines = [
    buildStatLine("active version", scan.active.version),
    buildStatLine("active path", formatCommand(scan.active.path)),
    ...scan.shadows.map((copy) =>
      buildStatLine(`shadow copy (${copy.kind})`, `${formatCommand(copy.path)} (v${copy.version})`),
    ),
  ];
  if (scan.shadows.length === 0) {
    lines.push(buildStatLine("shadow copies", "none found"));
  }
  if (scan.split) {
    lines.push(
      buildStatLine(
        "impact",
        "A generated or live copy differs from the active Lossless Claw copy; update the active path above before restarting OpenClaw.",
      ),
    );
  }
  return buildSection(scan.split ? "⚠️ Version split" : "🧩 Installed copies", lines);
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

function parseDoctorApplyArgs(tokens: string[]):
  | { ok: true; options: DoctorApplyOptions }
  | { ok: false; error: string } {
  if (tokens.length === 0) {
    return { ok: true, options: { confirmOffline: false } };
  }

  let confirmOffline = false;
  let explicitConfirmOffline = false;
  let conversationId: number | undefined;
  for (const token of tokens) {
    const normalized = token.toLowerCase();
    if (normalized === "confirm-offline") {
      confirmOffline = true;
      explicitConfirmOffline = true;
      continue;
    }
    if (
      normalized === "confirm-large" ||
      normalized === "offline" ||
      normalized === "--offline" ||
      normalized === "--confirm-large"
    ) {
      confirmOffline = true;
      continue;
    }

    const parsedId = Number(token);
    if (
      !Number.isNaN(parsedId) &&
      Number.isSafeInteger(parsedId) &&
      parsedId > 0 &&
      String(parsedId) === token
    ) {
      if (conversationId !== undefined) {
        return {
          ok: false,
          error:
            `\`${VISIBLE_COMMAND} doctor apply\` accepts at most one conversation id.`,
        };
      }
      conversationId = parsedId;
      continue;
    }

    return {
      ok: false,
      error:
        `\`${VISIBLE_COMMAND} doctor apply\` accepts optional \`confirm-offline\` for the current conversation or \`<conversation-id> confirm-offline\` for targeted repair.`,
    };
  }

  if (conversationId !== undefined && confirmOffline && !explicitConfirmOffline) {
    return {
      ok: false,
      error:
        `\`${VISIBLE_COMMAND} doctor apply <conversation-id>\` requires explicit \`confirm-offline\`; other offline aliases apply only to current-conversation repair.`,
    };
  }

  return {
    ok: true,
    options: {
      confirmOffline,
      ...(conversationId !== undefined ? { conversationId } : {}),
    },
  };
}

function parseRolloverSplitApplyArgs(tokens: string[]):
  | { ok: true; options: RolloverSplitApplyOptions }
  | { ok: false; error: string } {
  if (tokens.length === 0) {
    return { ok: true, options: { confirm: false } };
  }
  if (tokens.length === 1 && tokens[0]?.toLowerCase() === "confirm") {
    return { ok: true, options: { confirm: true } };
  }
  return {
    ok: false,
    error: `\`${VISIBLE_COMMAND} doctor apply rollover-splits\` accepts optional \`confirm\`.`,
  };
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
        : {
            kind: "help",
            error: `\`${VISIBLE_COMMAND} status\` does not accept extra arguments.`,
          };
    case "backup":
      return rest.length === 0
        ? { kind: "backup" }
        : {
            kind: "help",
            error: `\`${VISIBLE_COMMAND} backup\` does not accept extra arguments.`,
          };
    case "rotate":
      return rest.length === 0
        ? { kind: "rotate" }
        : {
            kind: "help",
            error: `\`${VISIBLE_COMMAND} rotate\` does not accept extra arguments.`,
          };
    case "doctor":
      if (rest.length === 0) {
        return { kind: "doctor", apply: false };
      }
      if (rest.length === 1 && rest[0]?.toLowerCase() === "clean") {
        return { kind: "doctor_cleaners", apply: false, vacuum: false };
      }
      if (rest.length === 1 && rest[0]?.toLowerCase() === "rollover-splits") {
        return { kind: "doctor_rollover_splits", apply: false };
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
      if (rest[0]?.toLowerCase() === "apply" && rest[1]?.toLowerCase() === "rollover-splits") {
        const parsedApply = parseRolloverSplitApplyArgs(rest.slice(2));
        return parsedApply.ok
          ? {
              kind: "doctor_rollover_splits",
              apply: true,
              applyOptions: parsedApply.options,
            }
          : { kind: "help", error: parsedApply.error };
      }
      if (rest[0]?.toLowerCase() === "apply") {
        const parsedApply = parseDoctorApplyArgs(rest.slice(1));
        return parsedApply.ok
          ? { kind: "doctor", apply: true, applyOptions: parsedApply.options }
          : { kind: "help", error: parsedApply.error };
      }
      return {
        kind: "help",
        error:
          `\`${VISIBLE_COMMAND} doctor\` accepts no arguments, \`rollover-splits\` for global rollover diagnostics, \`apply rollover-splits [confirm]\` for backup-first split repair, \`clean\` for global high-confidence junk diagnostics, \`clean apply [filter-id] [vacuum]\` for cleanup, \`apply [confirm-offline]\` for current-conversation repair, or \`apply <conversation-id> confirm-offline\` for targeted repair.`,
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

async function resolveDoctorApplyConversationById(
  db: DatabaseSync,
  conversationId: number,
): Promise<CurrentConversationResolution> {
  const stats = getConversationStatusStats(db, conversationId);
  if (!stats) {
    return {
      kind: "unavailable",
      reason: `No LCM conversation found with id ${formatNumber(conversationId)}.`,
    };
  }

  return { kind: "resolved", source: "conversation_id", stats };
}

async function resolveRuntimeSessionId(params: {
  ctx: PluginCommandContext;
  deps: LcmDependencies;
  current: Extract<CurrentConversationResolution, { kind: "resolved" }>;
}): Promise<string | undefined> {
  const currentSessionId = normalizeIdentity(params.current.stats.sessionId);
  const directSessionId = normalizeIdentity(params.ctx.sessionId);
  if (directSessionId) {
    return !currentSessionId || directSessionId === currentSessionId
      ? directSessionId
      : undefined;
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

  return currentSessionId;
}

function normalizePositiveInteger(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

function resolveLifecycleCompactionTokenBudget(config: LcmConfig): number {
  return normalizePositiveInteger(config.maxAssemblyTokenBudget) ?? 128_000;
}

function resolveStatusAssemblyTokenBudget(
  config: LcmConfig,
  maintenance: ConversationCompactionMaintenanceRecord | null,
): number {
  return (
    normalizePositiveInteger(config.maxAssemblyTokenBudget)
    ?? normalizePositiveInteger(maintenance?.tokenBudget)
    ?? 128_000
  );
}

function buildTargetSummaryValuesSql(summaryIds: string[]): string {
  return summaryIds.map(() => "(?)").join(", ");
}

function loadDoctorApplyRepairMetrics(
  db: DatabaseSync,
  doctor: DoctorSummaryStats,
): DoctorApplyRepairMetrics {
  const summaryIds = [...new Set(doctor.candidates.map((candidate) => candidate.summaryId))];
  if (summaryIds.length === 0) {
    return {
      repairInputTokenCount: 0,
      repairTargetSourceTokenCount: 0,
    };
  }

  const targetValuesSql = buildTargetSummaryValuesSql(summaryIds);

  // Repair input mirrors lcm-doctor-apply: leaf targets read linked messages,
  // while condensed targets read their immediate child summaries.
  const repairInputRow = db
    .prepare(
      `WITH target_summaries(summary_id) AS (VALUES ${targetValuesSql})
       SELECT COALESCE(SUM(input_tokens), 0) AS token_count
       FROM (
         SELECT t.summary_id, COALESCE(SUM(m.token_count), 0) AS input_tokens
         FROM target_summaries t
         JOIN summaries target ON target.summary_id = t.summary_id
         JOIN summary_messages sm ON sm.summary_id = t.summary_id
         JOIN messages m ON m.message_id = sm.message_id
         WHERE target.kind = 'leaf' OR COALESCE(target.depth, 0) = 0
         GROUP BY t.summary_id
         UNION ALL
         SELECT t.summary_id, COALESCE(SUM(child.token_count), 0) AS input_tokens
         FROM target_summaries t
         JOIN summaries target ON target.summary_id = t.summary_id
         JOIN summary_parents sp ON sp.summary_id = t.summary_id
         JOIN summaries child ON child.summary_id = sp.parent_summary_id
         WHERE NOT (target.kind = 'leaf' OR COALESCE(target.depth, 0) = 0)
         GROUP BY t.summary_id
       ) repair_inputs`,
    )
    .get(...summaryIds) as { token_count: number | null } | undefined;

  // Source coverage expands each target's summary tree to linked raw messages
  // and deduplicates messages shared by multiple target roots.
  const sourceCoverageRow = db
    .prepare(
      `WITH RECURSIVE
       target_summaries(summary_id) AS (VALUES ${targetValuesSql}),
       target_tree(summary_id) AS (
         SELECT summary_id FROM target_summaries
         UNION
         SELECT sp.parent_summary_id
         FROM target_tree tree
         JOIN summary_parents sp ON sp.summary_id = tree.summary_id
       ),
       covered_messages AS (
         SELECT DISTINCT sm.message_id
         FROM target_tree tree
         JOIN summary_messages sm ON sm.summary_id = tree.summary_id
       )
       SELECT COALESCE(SUM(m.token_count), 0) AS token_count
       FROM covered_messages covered
       JOIN messages m ON m.message_id = covered.message_id`,
    )
    .get(...summaryIds) as { token_count: number | null } | undefined;

  return {
    repairInputTokenCount: Math.max(0, Math.floor(repairInputRow?.token_count ?? 0)),
    repairTargetSourceTokenCount: Math.max(0, Math.floor(sourceCoverageRow?.token_count ?? 0)),
  };
}

function buildDoctorApplySafetyPreflight(params: {
  config: LcmConfig;
  doctor: DoctorSummaryStats;
  repairMetrics: DoctorApplyRepairMetrics;
  maintenance: ConversationCompactionMaintenanceRecord | null;
}): { blocked: boolean; reasons: string[]; tokenBudget: number; tokenThreshold: number } {
  const tokenBudget = resolveLifecycleCompactionTokenBudget(params.config);
  const tokenThreshold = Math.floor(tokenBudget * DOCTOR_APPLY_BUDGET_PRESSURE_RATIO);
  const reasons: string[] = [];

  if (params.doctor.total > DOCTOR_APPLY_LARGE_TARGET_THRESHOLD) {
    reasons.push(
      `doctor target count ${formatNumber(params.doctor.total)} exceeds safe inline limit ${formatNumber(DOCTOR_APPLY_LARGE_TARGET_THRESHOLD)}`,
    );
  }
  if (params.repairMetrics.repairInputTokenCount > tokenThreshold) {
    reasons.push(
      `repair input token count ${formatNumber(params.repairMetrics.repairInputTokenCount)} exceeds ${formatNumber(Math.round(DOCTOR_APPLY_BUDGET_PRESSURE_RATIO * 100))}% of repair budget ${formatNumber(tokenBudget)}`,
    );
  }
  if (params.maintenance?.pending) {
    reasons.push(
      `compaction maintenance is pending (${params.maintenance.reason ?? "reason unknown"})`,
    );
  }
  if (params.maintenance?.running) {
    reasons.push("compaction maintenance is already running");
  }

  return {
    blocked: reasons.length > 0,
    reasons,
    tokenBudget,
    tokenThreshold,
  };
}

function buildLcmHealthSummary(params: {
  config: LcmConfig;
  stats: LcmConversationStatusStats;
  maintenance: ConversationCompactionMaintenanceRecord | null;
}): { state: "healthy" | "warning" | "degraded"; reasons: string[] } {
  const tokenBudget = resolveStatusAssemblyTokenBudget(
    params.config,
    params.maintenance,
  );
  const warningThreshold = Math.floor(tokenBudget * DOCTOR_APPLY_BUDGET_PRESSURE_RATIO);
  const activeMaintenance = params.maintenance?.pending || params.maintenance?.running;
  const assemblyObservedTokens = Math.max(
    params.stats.contextTokenCount,
    activeMaintenance ? params.maintenance?.currentTokenCount ?? 0 : 0,
    activeMaintenance ? params.maintenance?.projectedTokenCount ?? 0 : 0,
  );
  const degradedReasons: string[] = [];
  const warningReasons: string[] = [];

  if (params.maintenance?.running) {
    degradedReasons.push("compaction maintenance is running");
  }
  if (params.maintenance?.pending) {
    degradedReasons.push(
      `compaction maintenance is pending (${params.maintenance.reason ?? "reason unknown"})`,
    );
  }
  if (assemblyObservedTokens > tokenBudget) {
    degradedReasons.push(
      `observed token count ${formatNumber(assemblyObservedTokens)} exceeds assembly budget ${formatNumber(tokenBudget)}`,
    );
  } else if (assemblyObservedTokens > warningThreshold) {
    warningReasons.push(
      `observed token count ${formatNumber(assemblyObservedTokens)} exceeds ${formatNumber(Math.round(DOCTOR_APPLY_BUDGET_PRESSURE_RATIO * 100))}% of assembly budget ${formatNumber(tokenBudget)}`,
    );
  }
  if (params.maintenance?.lastFailureSummary) {
    warningReasons.push(`last maintenance failure: ${params.maintenance.lastFailureSummary}`);
  }

  if (degradedReasons.length > 0) {
    return { state: "degraded", reasons: [...degradedReasons, ...warningReasons] };
  }
  if (warningReasons.length > 0) {
    return { state: "warning", reasons: warningReasons };
  }
  return { state: "healthy", reasons: [] };
}

function getMaintenanceState(
  maintenance: ConversationCompactionMaintenanceRecord | null,
): "pending" | "running" | "idle" {
  if (maintenance?.pending) return "pending";
  if (maintenance?.running) return "running";
  return "idle";
}

// Keep default status focused on operator action: active work, failure state, or
// the last successful budget. Detailed token-pressure and cache telemetry stay in
// logs and maintenance internals instead of the chat command surface.
function buildMaintenanceSummaryLines(params: {
  maintenance: ConversationCompactionMaintenanceRecord | null;
  formatTime: (value: Date | null) => string;
}): string[] {
  const maintenance = params.maintenance;
  const state = getMaintenanceState(maintenance);
  const lines = [buildStatLine("state", state)];
  if (!maintenance) {
    return lines;
  }

  const active = state === "pending" || state === "running";
  const failed = Boolean(maintenance.lastFailureSummary);
  if (active || failed) {
    if (maintenance.reason) lines.push(buildStatLine("reason", maintenance.reason));
    if (active && maintenance.requestedAt) {
      lines.push(buildStatLine("requested at", params.formatTime(maintenance.requestedAt)));
    }
    if (maintenance.lastStartedAt) {
      lines.push(buildStatLine("last started", params.formatTime(maintenance.lastStartedAt)));
    }
    if (maintenance.lastFinishedAt && state !== "running") {
      lines.push(buildStatLine("last finished", params.formatTime(maintenance.lastFinishedAt)));
    }
    if (maintenance.lastFailureSummary) {
      lines.push(buildStatLine("last failure", maintenance.lastFailureSummary));
    }
    if (maintenance.nextAttemptAfter) {
      lines.push(buildStatLine("next retry", params.formatTime(maintenance.nextAttemptAfter)));
    }
  } else if (maintenance.lastFinishedAt) {
    lines.push(buildStatLine("last finished", params.formatTime(maintenance.lastFinishedAt)));
  }

  if (maintenance.tokenBudget != null) {
    lines.push(buildStatLine("budget", formatNumber(maintenance.tokenBudget)));
  }
  return lines;
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
        formatCommand(`${VISIBLE_COMMAND} doctor rollover-splits`),
        "Report whole-DB fresh-transcript rollover split memory.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor apply rollover-splits confirm`),
        "Repair all safe rollover split memory groups after creating a DB backup.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor clean`),
        "Report global high-confidence junk candidates without deleting anything.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor clean apply`),
        "Delete approved high-confidence cleaner matches after creating a DB backup.",
      ),
      buildStatLine(formatCommand(`${VISIBLE_COMMAND} doctor apply`), "Repair broken summaries in the current conversation."),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor apply <conversation-id> confirm-offline`),
        "Repair a specific conversation by id after isolating its active channel path.",
      ),
      buildStatLine(
        formatCommand(`${VISIBLE_COMMAND} doctor apply confirm-offline`),
        "Override large/hot-session repair preflight after isolating the active channel path.",
      ),
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
  openClawConfig?: unknown;
}): Promise<string> {
  const status = getLcmStatusStats(params.db);
  const doctor = getDoctorSummaryStats(params.db);
  const rolloverSplits = scanRolloverSplits(params.db);
  const enabled = resolvePluginEnabled(params.ctx.config);
  const selected = resolvePluginSelected(params.ctx.config);
  const slot = resolveContextEngineSlot(params.ctx.config);
  const dbSize = resolveDbSizeLabel(params.config.databasePath);
  const installTrackWarning = detectLcmInstallTrackWarning({
    ctx: params.ctx,
    fallbackConfig: params.openClawConfig,
  });
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
  ];

  if (installTrackWarning) {
    lines.push(buildInstallTrackWarningSection(installTrackWarning), "");
  }

  lines.push(
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
  );

  if (rolloverSplits.safe.length > 0 || rolloverSplits.needsReview.length > 0) {
    lines.push(buildRolloverSplitScanSection(rolloverSplits), "");
  }

  if (current.kind === "resolved") {
    const conversationDoctor =
      doctor.byConversation.get(current.stats.conversationId) ?? {
        total: 0,
        old: 0,
        truncated: 0,
        fallback: 0,
        emergency: 0,
      };
    const maintenance = await getConversationCompactionMaintenanceByConversationId(
      params.db,
      current.stats.conversationId,
    );
    const lcmHealth = buildLcmHealthSummary({
      config: params.config,
      stats: current.stats,
      maintenance,
    });
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
        buildStatLine("LCM frontier tokens", formatNumber(current.stats.contextTokenCount)),
        buildStatLine(
          "compression ratio",
          formatCompressionRatio(current.stats.contextTokenCount, current.stats.compressedTokenCount),
        ),
        buildStatLine("lcm health", lcmHealth.state),
        buildStatLine("transport health", "not assessed by Lossless Claw"),
        ...lcmHealth.reasons.map((reason) => buildStatLine("lcm reason", reason)),
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
      buildSection(
        "🛠️ Maintenance",
        buildMaintenanceSummaryLines({ maintenance, formatTime: formatMaintenanceTime }),
      ),
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
  openClawConfig?: unknown;
  activeSourcePath?: string;
}): Promise<string> {
  const rolloverSplits = scanRolloverSplits(params.db);
  const installTrackWarning = detectLcmInstallTrackWarning({
    ctx: params.ctx,
    fallbackConfig: params.openClawConfig,
  });
  const current = await resolveCurrentConversation(params);
  const versionScan = params.activeSourcePath
    ? scanLcmVersionCopies({
        activeSourcePath: params.activeSourcePath,
        activeVersion: packageJson.version,
        stateDir: resolveOpenclawStateDir(),
      })
    : null;

  if (current.kind === "unavailable") {
    const lines = [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor",
      "",
    ];
    if (installTrackWarning) {
      lines.push(buildInstallTrackWarningSection(installTrackWarning), "");
    }
    if (versionScan) {
      lines.push(buildVersionDoctorSection(versionScan), "");
    }
    lines.push(
      buildSection("📍 Current conversation", [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Summary doctor is conversation-scoped."),
      ]),
      "",
      buildRolloverSplitScanSection(rolloverSplits),
    );
    return lines.join("\n");
  }

  const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Doctor",
    "",
  ];
  if (installTrackWarning) {
    lines.push(buildInstallTrackWarningSection(installTrackWarning), "");
  }
  if (versionScan) {
    lines.push(buildVersionDoctorSection(versionScan), "");
  }
  lines.push(
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
      buildStatLine("emergency-fallback summaries", formatNumber(stats.emergency)),
      buildStatLine("result", stats.total === 0 ? "clean" : "issues found"),
    ]),
    "",
    buildRolloverSplitScanSection(rolloverSplits),
  );

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
        `${formatCommand(`${VISIBLE_COMMAND} doctor apply`)} repairs these in place for the current conversation. ` +
          `Use ${formatCommand(`${VISIBLE_COMMAND} doctor apply <conversation-id> confirm-offline`)} to target a different conversation after isolating its active channel path.`,
      ]),
    );
  }

  return lines.join("\n");
}

function formatRolloverCounts(counts: RolloverSplitCounts): string {
  const parts = [
    `${formatNumber(counts.messages)} messages`,
    `${formatNumber(counts.summaries)} summaries`,
    `${formatNumber(counts.contextItems)} context items`,
    `${formatNumber(counts.largeFiles)} large files`,
    `${formatNumber(counts.focusBriefs)} focus briefs`,
  ];
  return parts.join(" · ");
}

function formatRolloverExample(example: RolloverSplitExample): string {
  const sources = example.sourceConversationIds.map((id) => formatNumber(id)).join(",");
  return [
    `${truncateMiddle(example.sessionKey, 44)}: conv ${sources} -> ${formatNumber(example.targetConversationId)}`,
    formatRolloverCounts(example),
  ].join(", ");
}

function buildRolloverSplitScanSection(scan: ReturnType<typeof scanRolloverSplits>): string {
  if (scan.safe.length === 0 && scan.needsReview.length === 0) {
    return buildSection("✅ Rollover split memory", [
      buildStatLine("result", "clean"),
      buildStatLine("safe lanes", "0"),
      buildStatLine("needs review", "0"),
    ]);
  }

  const lines = [
    buildStatLine("result", scan.safe.length > 0 ? "safe repairs available" : "review needed"),
    buildStatLine("affected safe lanes", formatNumber(scan.totals.safeLanes)),
    buildStatLine("stranded", formatRolloverCounts(scan.totals)),
    buildStatLine("needs review", formatNumber(scan.totals.needsReviewLanes)),
    buildStatLine("repair", formatCommand(`${VISIBLE_COMMAND} doctor apply rollover-splits confirm`)),
  ];

  for (const example of scan.safe.slice(0, 3)) {
    lines.push(`- ${formatRolloverExample(example)}`);
  }
  if (scan.safe.length > 3) {
    lines.push(`- ... ${formatNumber(scan.safe.length - 3)} more safe lane(s)`);
  }
  if (scan.needsReview.length > 0) {
    lines.push(
      buildStatLine(
        "skipped",
        `${formatNumber(scan.needsReview.length)} lane(s) require manual review before repair`,
      ),
    );
  }

  return buildSection("⚠️ Rollover split memory", lines);
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
    agentId: normalizeIdentity(params.ctx.agentId),
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
    const runtimeContext = readCommandRuntimeContext(params.ctx);
    result = await (await params.getLcm()).rotateSessionStorageWithBackup({
      sessionId,
      sessionKey,
      sessionFile: transcriptPath,
      lockTimeoutMs: ROTATE_DATABASE_LOCK_TIMEOUT_MS,
      ...(runtimeContext ? { runtimeContext } : {}),
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

export function getLcmProgrammaticControlCapabilities(params?: {
  deps?: LcmDependencies;
  getLcm?: () => Promise<RuntimeCommandEngine>;
}): ContextEngineControlCapabilities {
  return {
    status: true,
    doctor: true,
    rotate: Boolean(params?.deps && params.getLcm),
  };
}

function normalizeControlOperation(operation: unknown): ContextEngineControlOperation {
  if (operation === "status" || operation === "doctor" || operation === "rotate") {
    return operation;
  }
  throw new LcmProgrammaticControlUnavailableError(
    typeof operation === "string" ? operation : "unknown",
    "unsupported_operation",
  );
}

function buildProgrammaticDoctorWarnings(stats: DoctorSummaryStats): string[] {
  const warnings: string[] = [];
  if (stats.total > 0) {
    warnings.push(`${stats.total} summary issue(s) detected`);
  }
  if (stats.old > 0) {
    warnings.push(`${stats.old} old-marker summary issue(s) detected`);
  }
  if (stats.truncated > 0) {
    warnings.push(`${stats.truncated} truncated-marker summary issue(s) detected`);
  }
  if (stats.fallback > 0) {
    warnings.push(`${stats.fallback} fallback-marker summary issue(s) detected`);
  }
  if (stats.emergency > 0) {
    warnings.push(`${stats.emergency} emergency-fallback summary issue(s) detected`);
  }
  return warnings.slice(0, 10);
}

function throwControlUnavailable(
  operation: ContextEngineControlOperation,
  reasonCode: string,
): never {
  throw new LcmProgrammaticControlUnavailableError(operation, reasonCode);
}

function classifyProgrammaticRotateUnavailableReason(reason: string | undefined): string {
  const normalized = (reason ?? "").toLowerCase();
  if (normalized.includes("transcript")) {
    return "transcript_unavailable";
  }
  if (normalized.includes("backup")) {
    return "backup_unavailable";
  }
  if (normalized.includes("transaction") || normalized.includes("database")) {
    return "database_unavailable";
  }
  if (
    normalized.includes("summar") ||
    normalized.includes("provider") ||
    normalized.includes("raw context") ||
    normalized.includes("circuit breaker")
  ) {
    return "summarization_unavailable";
  }
  if (normalized.includes("active lossless claw conversation")) {
    return "conversation_unavailable";
  }
  return "unavailable";
}

export async function runLcmProgrammaticControl(params: {
  operation: ContextEngineControlOperation;
  ctx: PluginCommandContext;
  db: DatabaseSync;
  config: LcmConfig;
  deps?: LcmDependencies;
  getLcm?: () => Promise<RuntimeCommandEngine>;
}): Promise<ContextEngineControlResult> {
  const operation = normalizeControlOperation(params.operation);
  const current = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });

  if (operation === "status") {
    return {
      operation: "status",
      active: current.kind === "resolved",
      messageCount: current.kind === "resolved" ? current.stats.messageCount : 0,
    };
  }

  if (operation === "doctor") {
    if (current.kind === "unavailable") {
      return {
        operation: "doctor",
        ok: false,
        warnings: ["current conversation unavailable"],
      };
    }

    const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
    const warnings = buildProgrammaticDoctorWarnings(stats);
    return {
      operation: "doctor",
      ok: warnings.length === 0,
      warnings,
    };
  }

  const sessionKey = normalizeIdentity(params.ctx.sessionKey);
  if (!sessionKey) {
    throwControlUnavailable("rotate", "session_key_unavailable");
  }
  if (current.kind === "unavailable") {
    throwControlUnavailable("rotate", "conversation_unavailable");
  }
  if (!params.deps || !params.getLcm) {
    throwControlUnavailable("rotate", "runtime_unavailable");
  }

  const sessionId = await resolveRuntimeSessionId({
    ctx: params.ctx,
    deps: params.deps,
    current,
  });
  if (!sessionId) {
    throwControlUnavailable("rotate", "session_id_unavailable");
  }

  const transcriptPath = await params.deps.resolveSessionTranscriptFile({
    agentId: normalizeIdentity(params.ctx.agentId),
    sessionId,
    sessionKey,
  });
  if (!transcriptPath || !existsSync(transcriptPath)) {
    throwControlUnavailable("rotate", "transcript_unavailable");
  }

  if (getLcmBackupUnavailableReason(params.config.databasePath)) {
    throwControlUnavailable("rotate", "backup_unavailable");
  }

  let result: RotateSessionStorageWithBackupResult;
  try {
    const runtimeContext = readCommandRuntimeContext(params.ctx);
    result = await (await params.getLcm()).rotateSessionStorageWithBackup({
      sessionId,
      sessionKey,
      sessionFile: transcriptPath,
      lockTimeoutMs: ROTATE_DATABASE_LOCK_TIMEOUT_MS,
      ...(runtimeContext ? { runtimeContext } : {}),
    });
  } catch {
    throw new LcmProgrammaticControlFailedError("rotate", "runtime_exception");
  }

  if (result.kind !== "rotated") {
    throw new LcmProgrammaticControlUnavailableError(
      "rotate",
      result.kind === "unavailable"
        ? classifyProgrammaticRotateUnavailableReason(result.reason)
        : result.kind,
    );
  }

  const rotatedAt = new Date().toISOString();
  const refreshed = await resolveCurrentConversation({
    ctx: params.ctx,
    db: params.db,
  });

  return {
    operation: "rotate",
    messageCount: refreshed.kind === "resolved"
      ? refreshed.stats.messageCount
      : result.currentMessageCount ?? current.stats.messageCount,
    lastRotatedAt: rotatedAt,
  };
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

async function buildRolloverSplitApplyText(params: {
  db: DatabaseSync;
  config: LcmConfig;
  options?: RolloverSplitApplyOptions;
}): Promise<string> {
  const scan = scanRolloverSplits(params.db);
  const lines = [
    ...buildHeaderLines(),
    "",
    "🩺 Lossless Claw Rollover Split Repair",
    "",
    buildSection("🌐 Repair scope", [
      buildStatLine("safe lanes", formatNumber(scan.totals.safeLanes)),
      buildStatLine("needs review", formatNumber(scan.totals.needsReviewLanes)),
      buildStatLine("stranded", formatRolloverCounts(scan.totals)),
    ]),
    "",
  ];

  if (scan.safe.length > 0 && params.options?.confirm !== true) {
    lines.push(
      buildSection("🧯 Safety preflight", [
        buildStatLine("status", "blocked"),
        buildStatLine("mode", "read-only; no rollover split repair ran"),
        buildStatLine("reason", "confirmation word required"),
      ]),
      "",
      buildSection("🛠️ Next step", [
        `Run ${formatCommand(`${VISIBLE_COMMAND} doctor apply rollover-splits confirm`)} to create a backup and repair all safe rollover split groups.`,
      ]),
    );
    return lines.join("\n");
  }

  let result: Awaited<ReturnType<typeof applyRolloverSplitRepair>>;
  try {
    result = await applyRolloverSplitRepair({
      db: params.db,
      databasePath: params.config.databasePath,
    });
  } catch (error) {
    lines.push(
      buildSection("🛠️ Apply", [
        buildStatLine("status", "failed"),
        buildStatLine("reason", error instanceof Error ? error.message : "unknown rollover split repair failure"),
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

  lines.push(
    buildSection("🛠️ Apply", [
      buildStatLine("status", "completed"),
      buildStatLine("backup path", result.backupPath),
      buildStatLine("repaired lanes", formatNumber(result.repairedLanes)),
      buildStatLine("skipped for review", formatNumber(result.skippedReviewLanes)),
      buildStatLine("merged", formatRolloverCounts(result.totals)),
      buildStatLine("integrity", result.verification.integrity),
      buildStatLine("foreign keys", result.verification.foreignKeys),
      buildStatLine(
        "result",
        result.repairedLanes > 0
          ? `repaired ${formatNumber(result.repairedLanes)} rollover split lane(s)`
          : "clean; no writes ran",
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
  options?: DoctorApplyOptions;
}): Promise<string> {
  const requestedConversationId = params.options?.conversationId;
  const confirmOffline = params.options?.confirmOffline === true;
  const nextStepCommand = requestedConversationId !== undefined
    ? `${VISIBLE_COMMAND} doctor apply ${String(requestedConversationId)} confirm-offline`
    : `${VISIBLE_COMMAND} doctor apply confirm-offline`;
  const targetSectionLabel = requestedConversationId !== undefined
    ? "📍 Target conversation"
    : "📍 Current conversation";
  const current = requestedConversationId !== undefined
    ? await resolveDoctorApplyConversationById(params.db, requestedConversationId)
    : await resolveCurrentConversation(params);

  if (current.kind === "unavailable") {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor Apply",
      "",
      buildSection(targetSectionLabel, [
        buildStatLine("status", "unavailable"),
        buildStatLine("reason", current.reason),
        buildStatLine("fallback", "Doctor apply is conversation-scoped, so no global repair ran."),
      ]),
    ].join("\n");
  }

  const stats = getDoctorSummaryStats(params.db, current.stats.conversationId);
  const maintenance = await getConversationCompactionMaintenanceByConversationId(
    params.db,
    current.stats.conversationId,
  );
  const skipRepairMetrics = !confirmOffline && stats.total > DOCTOR_APPLY_LARGE_TARGET_THRESHOLD;
  const repairMetrics = skipRepairMetrics
    ? null
    : loadDoctorApplyRepairMetrics(params.db, stats);
  const preflight = buildDoctorApplySafetyPreflight({
    config: params.config,
    doctor: stats,
    repairMetrics: repairMetrics ?? {
      repairInputTokenCount: 0,
      repairTargetSourceTokenCount: 0,
    },
    maintenance,
  });
  const targetedConfirmationReason = requestedConversationId !== undefined && !confirmOffline
    ? "explicit conversation-id targeting requires `confirm-offline`"
    : null;
  if ((preflight.blocked || targetedConfirmationReason !== null) && !confirmOffline) {
    return [
      ...buildHeaderLines(),
      "",
      "🩺 Lossless Claw Doctor Apply",
      "",
      buildSection(targetSectionLabel, [
        buildStatLine("conversation id", formatNumber(current.stats.conversationId)),
        buildStatLine(
          "session key",
          current.stats.sessionKey ? formatCommand(truncateMiddle(current.stats.sessionKey, 44)) : "missing",
        ),
        buildStatLine("scope", "this conversation only"),
      ]),
      "",
      buildSection("🧯 Safety preflight", [
        buildStatLine("status", "blocked"),
        buildStatLine("mode", "read-only; no summary rewrites ran"),
        buildStatLine("LCM frontier tokens", formatNumber(current.stats.contextTokenCount)),
        buildStatLine("repair targets", formatNumber(stats.total)),
        ...(repairMetrics
          ? [
              buildStatLine("repair input tokens", formatNumber(repairMetrics.repairInputTokenCount)),
              buildStatLine(
                "repair target source tokens",
                formatNumber(repairMetrics.repairTargetSourceTokenCount),
              ),
            ]
          : []),
        buildStatLine("token threshold", formatNumber(preflight.tokenThreshold)),
        ...(targetedConfirmationReason
          ? [buildStatLine("reason", targetedConfirmationReason)]
          : []),
        ...preflight.reasons.map((reason) => buildStatLine("reason", reason)),
      ]),
      "",
      buildSection("🛠️ Next step", [
        `Run ${formatCommand(nextStepCommand)} only from an isolated/offline maintenance lane after active channel delivery is paused or moved away from this conversation.`,
      ]),
    ].join("\n");
  }
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
      buildSection(targetSectionLabel, [
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
    buildSection(targetSectionLabel, [
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
      ...(confirmOffline
        ? [buildStatLine("safety override", "confirm-offline")]
        : []),
      buildStatLine("repair targets", formatNumber(stats.total)),
      buildStatLine("old-marker summaries", formatNumber(stats.old)),
      buildStatLine("truncated-marker summaries", formatNumber(stats.truncated)),
      buildStatLine("fallback-marker summaries", formatNumber(stats.fallback)),
      buildStatLine("emergency-fallback summaries", formatNumber(stats.emergency)),
      buildStatLine("backup path", result.backupPath ?? "skipped (no writes)"),
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
  openClawConfig?: unknown;
  activeSourcePath?: string;
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
          return {
            text: await buildStatusText({
              ctx,
              db: await getDb(),
              config: params.config,
              openClawConfig: params.openClawConfig,
            }),
          };
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
                  options: parsed.applyOptions,
                }),
              }
            : {
                text: await buildDoctorText({
                  ctx,
                  db: await getDb(),
                  openClawConfig: params.openClawConfig,
                  activeSourcePath: params.activeSourcePath,
                }),
              };
        case "doctor_rollover_splits":
          return parsed.apply
            ? {
                text: await buildRolloverSplitApplyText({
                  db: await getDb(),
                  config: params.config,
                  options: parsed.applyOptions,
                }),
              }
            : {
                text: [
                  ...buildHeaderLines(),
                  "",
                  "🩺 Lossless Claw Rollover Splits",
                  "",
                  buildRolloverSplitScanSection(scanRolloverSplits(await getDb())),
                ].join("\n"),
              };
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
