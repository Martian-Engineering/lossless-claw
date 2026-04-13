import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { formatTimestamp } from "../compaction.js";
import type { LcmConfig } from "../db/config.js";
import type { LcmSummarizeFn } from "../summarize.js";
import { createLcmSummarizeFromLegacyParams } from "../summarize.js";
import type { LcmDependencies } from "../types.js";
import { detectDoctorMarker, loadDoctorTargets, type DoctorTargetRecord } from "./lcm-doctor-shared.js";
import { estimateTokens } from "../estimate-tokens.js";

type SummaryOverride = {
  content: string;
  tokenCount: number;
};

type SummaryTimeRange = {
  earliestAt: Date | null;
  latestAt: Date | null;
};

type DoctorApplySkip = {
  summaryId: string;
  reason: string;
};

export type DoctorApplyResult =
  | {
      kind: "applied";
      detected: number;
      repaired: number;
      unchanged: number;
      skipped: DoctorApplySkip[];
      repairedSummaryIds: string[];
    }
  | {
      kind: "unavailable";
      reason: string;
    };

type DoctorApplyRow = {
  summary_id: string;
  ordinal: number;
  content?: string;
};

/**
 * Repair broken summaries for a single resolved conversation.
 */
export async function applyScopedDoctorRepair(params: {
  db: DatabaseSync;
  config: LcmConfig;
  conversationId: number;
  deps?: LcmDependencies;
  summarize?: LcmSummarizeFn;
  runtimeConfig?: unknown;
}): Promise<DoctorApplyResult> {
  const targets = loadDoctorTargets(params.db, params.conversationId);
  if (targets.length === 0) {
    return {
      kind: "applied",
      detected: 0,
      repaired: 0,
      unchanged: 0,
      skipped: [],
      repairedSummaryIds: [],
    };
  }

  const summarize = await resolveDoctorApplySummarize(params);
  if (!summarize) {
    return {
      kind: "unavailable",
      reason: "Lossless Claw could not resolve a summarizer for native doctor apply through the normal model/auth chain.",
    };
  }

  const ordered = orderDoctorTargets(params.db, params.conversationId, targets);
  const overrides = new Map<string, SummaryOverride>();
  const skipped: DoctorApplySkip[] = [];
  const repairedSummaryIds: string[] = [];
  let unchanged = 0;

  for (const target of ordered) {
    try {
      const sourceText = buildSummarySourceText({
        db: params.db,
        target,
        timezone: params.config.timezone,
        overrides,
      });
      if (!sourceText.trim()) {
        skipped.push({
          summaryId: target.summaryId,
          reason: "source text resolved empty",
        });
        continue;
      }

      const previousSummary = resolvePreviousSummaryContext({
        db: params.db,
        target,
        overrides,
      });

      const rewritten = (await summarize(sourceText, false, {
        previousSummary,
        isCondensed: isCondensedTarget(target),
        ...(isCondensedTarget(target) ? { depth: target.depth } : {}),
      })).trim();
      if (!rewritten) {
        skipped.push({
          summaryId: target.summaryId,
          reason: "summarizer returned empty output",
        });
        continue;
      }
      if (detectDoctorMarker(rewritten)) {
        skipped.push({
          summaryId: target.summaryId,
          reason: "rewritten content still contains a doctor marker",
        });
        continue;
      }
      if (rewritten === target.content.trim()) {
        unchanged += 1;
        continue;
      }

      const tokenCount = estimateTokens(rewritten);
      overrides.set(target.summaryId, {
        content: rewritten,
        tokenCount,
      });
      repairedSummaryIds.push(target.summaryId);
    } catch (error) {
      skipped.push({
        summaryId: target.summaryId,
        reason: error instanceof Error ? error.message : "unknown repair failure",
      });
    }
  }

  if (repairedSummaryIds.length > 0) {
    await withDatabaseTransaction(params.db, "BEGIN IMMEDIATE", async () => {
        for (const summaryId of repairedSummaryIds) {
          const override = overrides.get(summaryId);
          if (!override) {
            continue;
          }
          params.db
            .prepare(
              `UPDATE summaries
               SET content = ?, token_count = ?
               WHERE summary_id = ?`,
            )
            .run(override.content, override.tokenCount, summaryId);
          updateSummaryFts(params.db, summaryId, override.content);
        }
    });
  }

  return {
    kind: "applied",
    detected: targets.length,
    repaired: repairedSummaryIds.length,
    unchanged,
    skipped,
    repairedSummaryIds,
  };
}

async function resolveDoctorApplySummarize(params: {
  config: LcmConfig;
  deps?: LcmDependencies;
  summarize?: LcmSummarizeFn;
  runtimeConfig?: unknown;
}): Promise<LcmSummarizeFn | undefined> {
  if (typeof params.summarize === "function") {
    return params.summarize;
  }
  if (!params.deps) {
    return undefined;
  }

  const runtimeSummarizer = await createLcmSummarizeFromLegacyParams({
    deps: params.deps,
    legacyParams: {
      config: params.runtimeConfig,
      agentDir: params.deps.resolveAgentDir(),
    },
    customInstructions: params.config.customInstructions || undefined,
  });
  return runtimeSummarizer?.fn;
}

function isCondensedTarget(target: DoctorTargetRecord): boolean {
  return !(target.depth === 0 || target.kind === "leaf");
}

function orderDoctorTargets(
  db: DatabaseSync,
  conversationId: number,
  targets: DoctorTargetRecord[],
): DoctorTargetRecord[] {
  const leafOrdinals = loadDoctorLeafOrdinals(db, conversationId);
  const activeLeaves: Array<DoctorTargetRecord & { contextOrdinal: number }> = [];
  const orphanLeaves: DoctorTargetRecord[] = [];
  const condensed: DoctorTargetRecord[] = [];

  for (const target of targets) {
    if (!isCondensedTarget(target)) {
      const contextOrdinal = leafOrdinals.get(target.summaryId);
      if (typeof contextOrdinal === "number") {
        activeLeaves.push({ ...target, contextOrdinal });
      } else {
        orphanLeaves.push(target);
      }
      continue;
    }
    condensed.push(target);
  }

  activeLeaves.sort((left, right) => left.contextOrdinal - right.contextOrdinal);
  orphanLeaves.sort(compareDoctorTargets);
  condensed.sort(compareDoctorTargets);

  return [...activeLeaves, ...orphanLeaves, ...condensed];
}

function compareDoctorTargets(left: DoctorTargetRecord, right: DoctorTargetRecord): number {
  if (left.depth !== right.depth) {
    return left.depth - right.depth;
  }
  if (left.createdAt !== right.createdAt) {
    return left.createdAt.localeCompare(right.createdAt);
  }
  return left.summaryId.localeCompare(right.summaryId);
}

function loadDoctorLeafOrdinals(db: DatabaseSync, conversationId: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT ci.summary_id, ci.ordinal, COALESCE(s.content, '') AS content
       FROM context_items ci
       JOIN summaries s ON s.summary_id = ci.summary_id
       WHERE ci.conversation_id = ?
         AND ci.item_type = 'summary'
         AND COALESCE(s.depth, 0) = 0
       ORDER BY ci.ordinal ASC`,
    )
    .all(conversationId) as DoctorApplyRow[];

  const ordinals = new Map<string, number>();
  for (const row of rows) {
    if (!detectDoctorMarker(row.content ?? "")) {
      continue;
    }
    ordinals.set(row.summary_id, row.ordinal);
  }
  return ordinals;
}

function buildSummarySourceText(params: {
  db: DatabaseSync;
  target: DoctorTargetRecord;
  timezone: string;
  overrides: Map<string, SummaryOverride>;
}): string {
  return isCondensedTarget(params.target)
    ? buildCondensedSourceText(params)
    : buildLeafSourceText(params);
}

function buildLeafSourceText(params: {
  db: DatabaseSync;
  target: DoctorTargetRecord;
  timezone: string;
}): string {
  const rows = params.db
    .prepare(
      `SELECT m.created_at, COALESCE(m.content, '') AS content
       FROM summary_messages sm
       JOIN messages m ON m.message_id = sm.message_id
       WHERE sm.summary_id = ?
       ORDER BY sm.ordinal ASC`,
    )
    .all(params.target.summaryId) as Array<{ created_at: string; content: string }>;
  if (rows.length === 0) {
    throw new Error("no messages linked to summary");
  }

  return rows
    .map((row) => `[${formatSqliteTimestamp(row.created_at, params.timezone)}]\n${row.content}`)
    .join("\n\n");
}

function buildCondensedSourceText(params: {
  db: DatabaseSync;
  target: DoctorTargetRecord;
  timezone: string;
  overrides: Map<string, SummaryOverride>;
}): string {
  const rows = params.db
    .prepare(
      `SELECT
         sp.parent_summary_id AS summary_id,
         COALESCE(s.content, '') AS content,
         s.earliest_at,
         s.latest_at,
         s.created_at
       FROM summary_parents sp
       JOIN summaries s ON s.summary_id = sp.parent_summary_id
       WHERE sp.summary_id = ?
       ORDER BY sp.ordinal ASC`,
    )
    .all(params.target.summaryId) as Array<{
      summary_id: string;
      content: string;
      earliest_at: string | null;
      latest_at: string | null;
      created_at: string;
    }>;
  if (rows.length === 0) {
    throw new Error("no child summaries linked to summary");
  }

  const parts = rows
    .map((row) => {
      const override = params.overrides.get(row.summary_id);
      const content = (override?.content ?? row.content).trim();
      if (!content) {
        return null;
      }
      const timeRange = resolveSummaryTimeRange({
        earliestAt: row.earliest_at,
        latestAt: row.latest_at,
        createdAt: row.created_at,
      });
      const header = formatSummaryTimeRange(timeRange, params.timezone);
      return header ? `${header}\n${content}` : content;
    })
    .filter((value): value is string => typeof value === "string");

  if (parts.length === 0) {
    throw new Error("child summaries resolved empty");
  }
  return parts.join("\n\n");
}

function resolvePreviousSummaryContext(params: {
  db: DatabaseSync;
  target: DoctorTargetRecord;
  overrides: Map<string, SummaryOverride>;
}): string | undefined {
  return (
    previousViaContextItems(params) ??
    previousViaSummaryParents(params) ??
    previousViaTimestamp(params)
  );
}

function previousViaContextItems(params: {
  db: DatabaseSync;
  target: DoctorTargetRecord;
  overrides: Map<string, SummaryOverride>;
}): string | undefined {
  const targetRow = params.db
    .prepare(
      `SELECT ordinal
       FROM context_items
       WHERE conversation_id = ?
         AND item_type = 'summary'
         AND summary_id = ?
       LIMIT 1`,
    )
    .get(params.target.conversationId, params.target.summaryId) as { ordinal: number } | undefined;
  if (!targetRow) {
    return undefined;
  }

  const previousRow = params.db
    .prepare(
      `SELECT s.summary_id
       FROM context_items ci
       JOIN summaries s ON s.summary_id = ci.summary_id
       WHERE ci.conversation_id = ?
         AND ci.item_type = 'summary'
         AND COALESCE(s.depth, 0) = ?
         AND ci.ordinal < ?
       ORDER BY ci.ordinal DESC
       LIMIT 1`,
    )
    .get(
      params.target.conversationId,
      params.target.depth,
      targetRow.ordinal,
    ) as { summary_id: string } | undefined;
  return resolveSummaryContent(params.db, previousRow?.summary_id, params.overrides);
}

function previousViaSummaryParents(params: {
  db: DatabaseSync;
  target: DoctorTargetRecord;
  overrides: Map<string, SummaryOverride>;
}): string | undefined {
  const parentRow = params.db
    .prepare(
      `SELECT summary_id, ordinal
       FROM summary_parents
       WHERE parent_summary_id = ?
       LIMIT 1`,
    )
    .get(params.target.summaryId) as { summary_id: string; ordinal: number } | undefined;
  if (!parentRow) {
    return undefined;
  }

  const previousRow = params.db
    .prepare(
      `SELECT parent_summary_id AS summary_id
       FROM summary_parents
       WHERE summary_id = ?
         AND ordinal < ?
       ORDER BY ordinal DESC
       LIMIT 1`,
    )
    .get(parentRow.summary_id, parentRow.ordinal) as { summary_id: string } | undefined;
  return resolveSummaryContent(params.db, previousRow?.summary_id, params.overrides);
}

function previousViaTimestamp(params: {
  db: DatabaseSync;
  target: DoctorTargetRecord;
  overrides: Map<string, SummaryOverride>;
}): string | undefined {
  if (!params.target.createdAt.trim()) {
    return undefined;
  }

  const previousRow = params.db
    .prepare(
      `SELECT summary_id
       FROM summaries
       WHERE conversation_id = ?
         AND COALESCE(depth, 0) = ?
         AND (created_at < ? OR (created_at = ? AND summary_id < ?))
       ORDER BY created_at DESC, summary_id DESC
       LIMIT 1`,
    )
    .get(
      params.target.conversationId,
      params.target.depth,
      params.target.createdAt,
      params.target.createdAt,
      params.target.summaryId,
    ) as { summary_id: string } | undefined;
  return resolveSummaryContent(params.db, previousRow?.summary_id, params.overrides);
}

function resolveSummaryContent(
  db: DatabaseSync,
  summaryId: string | undefined,
  overrides: Map<string, SummaryOverride>,
): string | undefined {
  if (!summaryId) {
    return undefined;
  }

  const override = overrides.get(summaryId);
  if (override?.content.trim()) {
    return override.content.trim();
  }

  const row = db
    .prepare(`SELECT COALESCE(content, '') AS content FROM summaries WHERE summary_id = ?`)
    .get(summaryId) as { content: string } | undefined;
  const content = row?.content.trim();
  return content ? content : undefined;
}

function resolveSummaryTimeRange(params: {
  earliestAt: string | null;
  latestAt: string | null;
  createdAt: string;
}): SummaryTimeRange {
  const earliestAt = parseSqliteTimestamp(params.earliestAt) ?? parseSqliteTimestamp(params.createdAt);
  const latestAt = parseSqliteTimestamp(params.latestAt) ?? parseSqliteTimestamp(params.createdAt);
  return {
    earliestAt,
    latestAt,
  };
}

function formatSummaryTimeRange(range: SummaryTimeRange, timezone: string): string {
  if (!range.earliestAt || !range.latestAt) {
    return "";
  }
  return `[${formatTimestamp(range.earliestAt, timezone)} - ${formatTimestamp(range.latestAt, timezone)}]`;
}

function formatSqliteTimestamp(value: string, timezone: string): string {
  const date = parseSqliteTimestamp(value);
  if (date) {
    return formatTimestamp(date, timezone);
  }
  const fallback = value.trim();
  return fallback || "unknown";
}

function parseSqliteTimestamp(value: string | null | undefined): Date | null {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  const direct = new Date(normalized);
  if (!Number.isNaN(direct.getTime())) {
    return direct;
  }

  const sqlite = new Date(normalized.replace(" ", "T") + "Z");
  if (!Number.isNaN(sqlite.getTime())) {
    return sqlite;
  }
  return null;
}


function updateSummaryFts(db: DatabaseSync, summaryId: string, content: string): void {
  try {
    const update = db
      .prepare(`UPDATE summaries_fts SET content = ? WHERE summary_id = ?`)
      .run(content, summaryId);
    if (Number(update.changes ?? 0) === 0) {
      db.prepare(`INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`).run(summaryId, content);
    }
  } catch {
    // FTS repair is best-effort; the primary source of truth is summaries.
  }
}
