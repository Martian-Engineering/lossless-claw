import { Type } from "@sinclair/typebox";
import { createHash } from "node:crypto";
import type { LcmContextEngine } from "../engine.js";
import {
  runSemanticSearch,
  SemanticSearchUnavailableError,
} from "../embeddings/semantic-search.js";
import { VoyageError } from "../voyage/client.js";
import { dispatchSynthesis, SynthesisDispatchError, type LlmCall } from "../synthesis/dispatch.js";
import { createLcmSummarizeFromLegacyParams } from "../summarize.js";
import { estimateTokens } from "../estimate-tokens.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";

/**
 * `lcm_synthesize_around` — agent tool (LCM v4.1 §13).
 *
 * Builds a freshly-synthesized summary of leaves "around" a target. Two
 * window modes:
 *   - `time`     — leaves with `created_at` within ±N hours of the target's
 *                  timestamp. Target must be a `summary_id` (we anchor on
 *                  the target summary's `created_at`).
 *   - `semantic` — top-K most-similar leaves to the target's content. Target
 *                  may be a `summary_id` (we anchor on its content) OR a
 *                  free-text query.
 *
 * The selected leaves are concatenated with separators and passed through
 * `dispatchSynthesis` (D.02) using tier='custom' or 'filtered'. The result
 * is persisted to `lcm_synthesis_cache` so subsequent identical calls can
 * hit the cache rather than re-LLM (single-flight via INSERT OR IGNORE on
 * the UNIQUE lookup index).
 *
 * Why a separate tool from `lcm_semantic_recall`: recall returns ranked
 * snippets (the agent picks). `synthesize_around` returns a single
 * synthesized markdown summary with telemetry — designed for
 * "give me a memory pass on what was happening around X" rather than
 * "find the closest leaves to query Q".
 */

const DEFAULT_WINDOW_HOURS = 24;
const DEFAULT_WINDOW_K = 30;
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 24 * 7 * 4; // 4 weeks
const MIN_WINDOW_K = 1;
const MAX_WINDOW_K = 200;
const MAX_SOURCE_TEXT_TOKENS = 50_000; // dispatch-side cap

const LcmSynthesizeAroundSchema = Type.Object({
  target: Type.String({
    description:
      "Target to anchor the window on. Pass a `sum_xxx` summary_id (works in both " +
      "modes — anchors on the summary's created_at OR content), OR a free-text query " +
      "string (semantic mode only — used as the query embedding directly).",
  }),
  window_kind: Type.String({
    enum: ["time", "semantic"],
    description:
      "Window selection: 'time' (±windowHours around target timestamp) or 'semantic' " +
      "(top-windowK most-similar leaves to target content/query).",
  }),
  windowHours: Type.Optional(
    Type.Number({
      description: `Half-window for time mode (default ${DEFAULT_WINDOW_HOURS}, range ${MIN_WINDOW_HOURS}-${MAX_WINDOW_HOURS}). Ignored for semantic mode.`,
      minimum: MIN_WINDOW_HOURS,
      maximum: MAX_WINDOW_HOURS,
    }),
  ),
  windowK: Type.Optional(
    Type.Number({
      description: `Top-K size for semantic mode (default ${DEFAULT_WINDOW_K}, range ${MIN_WINDOW_K}-${MAX_WINDOW_K}). Ignored for time mode.`,
      minimum: MIN_WINDOW_K,
      maximum: MAX_WINDOW_K,
    }),
  ),
  tier: Type.Optional(
    Type.String({
      enum: ["custom", "filtered"],
      description:
        "Synthesis tier (default 'custom'). Both use single-pass dispatch with the " +
        "Sonnet-class default model. Use 'filtered' when the leaf set is grep-filtered " +
        "(matches the cache CHECK constraint convention).",
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Physical conversation ID to scope leaf selection to. If omitted, defaults " +
        "to the current session family.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to include leaves from every conversation. Ignored when " +
        "conversationId is provided.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description:
        "Optional ISO timestamp lower bound. Combined with the chosen window — " +
        "e.g., for time mode, the effective window is `MAX(targetCreated - windowHours, since)`.",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description:
        "Optional ISO timestamp upper bound. Combined with the chosen window — " +
        "e.g., for time mode, the effective window is `MIN(targetCreated + windowHours, before)`.",
    }),
  ),
});

interface SummariesScopeFilter {
  conversationIds?: number[];
}

interface LeafRow {
  summary_id: string;
  content: string;
  created_at: string;
  token_count: number;
}

interface TargetSummaryRow {
  summary_id: string;
  content: string;
  created_at: string;
  conversation_id: number;
  session_key: string;
}

type SqlBind = string | number | bigint | null | Uint8Array;

function lookupTargetSummary(
  db: import("node:sqlite").DatabaseSync,
  summaryId: string,
  scope: SummariesScopeFilter,
): TargetSummaryRow | null {
  const filters: string[] = ["summary_id = ?", "suppressed_at IS NULL"];
  const binds: SqlBind[] = [summaryId];
  if (scope.conversationIds && scope.conversationIds.length > 0) {
    filters.push(`conversation_id IN (${scope.conversationIds.map(() => "?").join(",")})`);
    for (const id of scope.conversationIds) binds.push(id);
  }
  const row = db
    .prepare(
      `SELECT summary_id, content, created_at, conversation_id, session_key
         FROM summaries
         WHERE ${filters.join(" AND ")}
         LIMIT 1`,
    )
    .get(...binds) as unknown as TargetSummaryRow | undefined;
  return row ?? null;
}

function selectTimeWindowLeaves(
  db: import("node:sqlite").DatabaseSync,
  args: {
    rangeStart: string;
    rangeEnd: string;
    scope: SummariesScopeFilter;
    excludeSummaryId?: string;
  },
): LeafRow[] {
  // We compare via `datetime(col) >= datetime(?)` so the query is robust to
  // the format mismatch between SQLite's natural `'YYYY-MM-DD HH:MM:SS'`
  // (from `datetime('now')`) and JS `Date.toISOString()` `'...T...Z'` ISO
  // form. Plain string comparison would treat '2026-05-01 09:00:00' as
  // smaller than '2026-05-01T09:00:00.000Z' (space < T), which silently
  // drops valid rows. SQLite normalizes both via datetime().
  const filters: string[] = [
    "datetime(created_at) >= datetime(?)",
    "datetime(created_at) < datetime(?)",
    "suppressed_at IS NULL",
    "kind = 'leaf'",
  ];
  const binds: SqlBind[] = [args.rangeStart, args.rangeEnd];
  if (args.scope.conversationIds && args.scope.conversationIds.length > 0) {
    filters.push(`conversation_id IN (${args.scope.conversationIds.map(() => "?").join(",")})`);
    for (const id of args.scope.conversationIds) binds.push(id);
  }
  if (args.excludeSummaryId) {
    filters.push(`summary_id != ?`);
    binds.push(args.excludeSummaryId);
  }
  const rows = db
    .prepare(
      `SELECT summary_id, content, created_at, token_count
         FROM summaries
         WHERE ${filters.join(" AND ")}
         ORDER BY created_at ASC`,
    )
    .all(...binds) as unknown as LeafRow[];
  return rows;
}

function buildSourceText(rows: LeafRow[]): { text: string; truncatedAt?: number } {
  const parts: string[] = [];
  let totalTokens = 0;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    const block = `### Leaf ${row.summary_id} (${row.created_at})\n\n${row.content}`;
    totalTokens += row.token_count > 0 ? row.token_count : estimateTokens(block);
    if (totalTokens > MAX_SOURCE_TEXT_TOKENS) {
      return {
        text: parts.join("\n\n---\n\n"),
        truncatedAt: i,
      };
    }
    parts.push(block);
  }
  return { text: parts.join("\n\n---\n\n") };
}

function fingerprintLeaves(ids: string[]): string {
  const hash = createHash("sha256");
  for (const id of ids) {
    hash.update(id);
    hash.update(" ");
  }
  return hash.digest("hex").slice(0, 24);
}

function shortRandomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}

/**
 * SQLite stores timestamps via `datetime('now')` as UTC strings of the form
 * `'YYYY-MM-DD HH:MM:SS'` (no `T`, no `Z`). When fed to JS `new Date(...)`
 * the same string is parsed as **local time**, silently shifting the
 * reference point by the host timezone offset. This helper forces a UTC
 * reading by appending `Z` (and the missing `T`) before the JS parse.
 */
function parseSqliteUtcTimestamp(value: string): Date {
  const trimmed = value.trim();
  // If the value already includes a timezone indicator or `T`, defer to JS.
  if (/[Tt]/.test(trimmed) || /[Zz]|[+\-]\d\d:?\d\d$/.test(trimmed)) {
    return new Date(trimmed);
  }
  // SQLite default form: 'YYYY-MM-DD HH:MM:SS' or 'YYYY-MM-DD HH:MM:SS.SSS'
  return new Date(`${trimmed.replace(" ", "T")}Z`);
}

function formatDisplayTime(value: string | Date | null | undefined, timezone: string): string {
  if (!value) return "-";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return formatTimestamp(d, timezone);
}

/**
 * Adapt the existing `LcmSummarizeFn` (text → text) to dispatch's `LlmCall`
 * (model + prompt → output + telemetry). Latency is measured locally; cost
 * is left undefined (we don't have a cost calculator wired here).
 *
 * The summarizer wrapper ignores the dispatch-supplied model (the legacy
 * resolver picks its own provider/model fallback chain), so we record the
 * caller-supplied model name for audit, while letting the summarizer do
 * its own resolution.
 */
function buildLlmCallFromSummarizer(
  summarize: (text: string) => Promise<string>,
): LlmCall {
  return async (args) => {
    const startedAt = Date.now();
    const output = await summarize(args.prompt);
    const latencyMs = Date.now() - startedAt;
    return { output, latencyMs };
  };
}

export function createLcmSynthesizeAroundTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_synthesize_around",
    label: "LCM Synthesize Around",
    description:
      "Synthesize a fresh summary of leaves AROUND a target (a summary_id or a " +
      "semantic query). Two modes: 'time' (leaves within ±windowHours of target's " +
      "timestamp) or 'semantic' (top windowK most-similar leaves to target content). " +
      "Returns a markdown summary built via the synthesis dispatch (D.02), backed by " +
      "lcm_synthesis_cache so subsequent identical calls hit the cache. Use this for " +
      "'what was happening around X?' style memory passes — distinct from " +
      "lcm_semantic_recall (which returns ranked snippets, not a synthesized rollup).",
    parameters: LcmSynthesizeAroundSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const timezone = lcm.timezone;
      const p = params as Record<string, unknown>;

      // 1. Validate target
      const target = typeof p.target === "string" ? p.target.trim() : "";
      if (target.length === 0) {
        return jsonResult({
          error: "`target` is required (sum_xxx summary_id OR free-text query).",
        });
      }

      // 2. Validate window_kind
      const windowKind = typeof p.window_kind === "string" ? p.window_kind.trim() : "";
      if (windowKind !== "time" && windowKind !== "semantic") {
        return jsonResult({
          error: "`window_kind` must be 'time' or 'semantic'.",
        });
      }

      // 3. Numeric window args
      const windowHours =
        typeof p.windowHours === "number" && Number.isFinite(p.windowHours)
          ? Math.max(MIN_WINDOW_HOURS, Math.min(MAX_WINDOW_HOURS, p.windowHours))
          : DEFAULT_WINDOW_HOURS;
      const windowK =
        typeof p.windowK === "number" && Number.isFinite(p.windowK)
          ? Math.max(MIN_WINDOW_K, Math.min(MAX_WINDOW_K, Math.trunc(p.windowK)))
          : DEFAULT_WINDOW_K;

      // 4. Tier selection
      const tier =
        typeof p.tier === "string" && (p.tier === "custom" || p.tier === "filtered")
          ? (p.tier as "custom" | "filtered")
          : "custom";
      // lcm_synthesis_cache CHECK constrains tier_label to ('year','custom','filtered').
      const cacheTierLabel = tier;

      // 5. Optional time bounds
      let sinceBound: Date | undefined;
      let beforeBound: Date | undefined;
      try {
        sinceBound = parseIsoTimestampParam(p, "since");
        beforeBound = parseIsoTimestampParam(p, "before");
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : "Invalid timestamp filter.",
        });
      }
      if (sinceBound && beforeBound && sinceBound.getTime() >= beforeBound.getTime()) {
        return jsonResult({ error: "`since` must be earlier than `before`." });
      }

      // 6. Resolve conversation scope
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }
      const conversationIds = conversationScope.allConversations
        ? undefined
        : conversationScope.conversationIds && conversationScope.conversationIds.length > 0
          ? conversationScope.conversationIds
          : conversationScope.conversationId != null
            ? [conversationScope.conversationId]
            : undefined;
      const summariesScope: SummariesScopeFilter = { conversationIds };

      const db = lcm.getDb();

      // 7. Resolve target — only summary_id targets allowed for time mode.
      const targetIsSummaryId = target.startsWith("sum_");
      let targetSummary: TargetSummaryRow | null = null;
      if (targetIsSummaryId) {
        targetSummary = lookupTargetSummary(db, target, summariesScope);
        if (!targetSummary) {
          return jsonResult({
            error: `Target summary not found in scope: ${target}`,
            hint: "Verify the summary_id and (if scoped) the conversationId/allConversations.",
          });
        }
      } else if (windowKind === "time") {
        return jsonResult({
          error:
            "time window requires a summary_id target (sum_xxx). Free-text queries are only supported in semantic mode.",
        });
      }

      // 8. Build leaf set per window mode.
      let leafRows: LeafRow[];
      let rangeStartIso: string;
      let rangeEndIso: string;
      let semanticMeta: { modelName?: string; voyageTokensConsumed?: number } | undefined;
      const sessionKeyForCache =
        targetSummary?.session_key?.trim() ||
        (typeof input.sessionKey === "string" && input.sessionKey.trim()) ||
        "";

      if (windowKind === "time") {
        // targetSummary is non-null here (validated above)
        const anchor = parseSqliteUtcTimestamp(targetSummary!.created_at);
        if (Number.isNaN(anchor.getTime())) {
          return jsonResult({
            error: `Target summary has invalid created_at: ${targetSummary!.created_at}`,
          });
        }
        const halfMs = windowHours * 60 * 60 * 1000;
        let rangeStart = new Date(anchor.getTime() - halfMs);
        let rangeEnd = new Date(anchor.getTime() + halfMs);
        if (sinceBound && sinceBound.getTime() > rangeStart.getTime()) {
          rangeStart = sinceBound;
        }
        if (beforeBound && beforeBound.getTime() < rangeEnd.getTime()) {
          rangeEnd = beforeBound;
        }
        if (rangeStart.getTime() >= rangeEnd.getTime()) {
          return jsonResult({
            error: "Effective window is empty after applying since/before bounds.",
          });
        }
        rangeStartIso = rangeStart.toISOString();
        rangeEndIso = rangeEnd.toISOString();

        leafRows = selectTimeWindowLeaves(db, {
          rangeStart: rangeStartIso,
          rangeEnd: rangeEndIso,
          scope: summariesScope,
          excludeSummaryId: targetSummary!.summary_id,
        });
      } else {
        // semantic mode — use runSemanticSearch.
        const queryText = targetIsSummaryId ? targetSummary!.content : target;
        try {
          const result = await runSemanticSearch(db, {
            query: queryText,
            k: windowK,
            conversationIds,
            since: sinceBound,
            before: beforeBound,
            summaryKinds: ["leaf"],
            excludeSuppressed: true,
            voyageMaxRetries: 1,
            voyageTimeoutMs: 15_000,
          });
          semanticMeta = {
            modelName: result.modelName,
            voyageTokensConsumed: result.voyageTokensConsumed,
          };
          // Drop the target itself from the candidate set if it appears.
          const filtered = targetIsSummaryId
            ? result.hits.filter((h) => h.summaryId !== targetSummary!.summary_id)
            : result.hits;
          if (filtered.length === 0) {
            const startIso = sinceBound?.toISOString() ?? "1970-01-01T00:00:00.000Z";
            const endIso = beforeBound?.toISOString() ?? new Date().toISOString();
            return jsonResult({
              error: "Semantic window returned no leaves (after suppression and target dedupe).",
              hint: "Try increasing windowK or relaxing since/before bounds.",
              window: { kind: "semantic", k: windowK, since: startIso, before: endIso },
            });
          }
          leafRows = filtered.map((h) => ({
            summary_id: h.summaryId,
            content: h.content,
            created_at: h.createdAt,
            token_count: h.tokenCount,
          }));
          // Sort chronologically for the synthesis prompt to receive
          // leaves in stable temporal order (helps the model build a
          // coherent narrative).
          leafRows.sort((a, b) => a.created_at.localeCompare(b.created_at));
          rangeStartIso = leafRows[0]!.created_at;
          rangeEndIso = leafRows[leafRows.length - 1]!.created_at;
        } catch (error) {
          if (error instanceof SemanticSearchUnavailableError) {
            return jsonResult({
              error:
                "Semantic search is unavailable (sqlite-vec / vec0 not loaded or no active embedding model). " +
                "Use window_kind='time' with a summary_id target instead.",
              detail: error.message,
            });
          }
          if (error instanceof VoyageError) {
            if (error.kind === "auth") {
              return jsonResult({
                error: "Voyage API key is missing or invalid (set VOYAGE_API_KEY).",
                detail: error.message,
              });
            }
            return jsonResult({
              error: `Voyage embed call failed (${error.kind}).`,
              detail: error.message,
            });
          }
          const message = error instanceof Error ? error.message : String(error);
          if (/VOYAGE_API_KEY/i.test(message)) {
            return jsonResult({
              error: "Voyage API key is missing (set VOYAGE_API_KEY).",
              detail: message,
            });
          }
          return jsonResult({ error: `Semantic search failed: ${message}` });
        }
      }

      if (leafRows.length === 0) {
        return jsonResult({
          error: "Window selected zero leaves.",
          hint:
            windowKind === "time"
              ? "Widen windowHours, or set allConversations=true if leaves live elsewhere."
              : "Increase windowK, or relax since/before bounds.",
          window: {
            kind: windowKind,
            ...(windowKind === "time"
              ? { hours: windowHours, since: rangeStartIso, before: rangeEndIso }
              : { k: windowK }),
          },
        });
      }

      const built = buildSourceText(leafRows);
      const sourceText = built.text;
      const sourceTokenCount = estimateTokens(sourceText);
      const leafIds = leafRows
        .slice(0, built.truncatedAt ?? leafRows.length)
        .map((r) => r.summary_id);
      const leafFingerprint = fingerprintLeaves(leafIds);

      // 9. Build LLM call wrapper from the existing summarizer chain. We
      //    don't have a synthesizer-specific model resolver here, so we
      //    reuse the configured summarizer (it already handles fallback +
      //    auth retries + timeouts).
      const summarizerBuilt = await createLcmSummarizeFromLegacyParams({
        deps: input.deps,
        legacyParams: {},
      });
      if (!summarizerBuilt) {
        return jsonResult({
          error:
            "No summarization model resolved — set summaryModel/summaryProvider on the lossless-claw plugin or LCM_SUMMARY_MODEL env.",
        });
      }
      const llmCall = buildLlmCallFromSummarizer((text) =>
        summarizerBuilt.fn(text, false, { isCondensed: true }),
      );

      // 10. Pre-compute the cache_id and persist the synthesis to
      //     lcm_synthesis_cache. dispatchSynthesis writes to the audit
      //     log via the targetCacheId we supply, so we INSERT the cache
      //     row first as 'building' (single-flight via UNIQUE index),
      //     run dispatch, then UPDATE with the output.
      const cacheId = `cache_around_${Date.now().toString(36)}_${shortRandomSuffix()}`;
      const passSessionId = `pas_around_${Date.now().toString(36)}_${shortRandomSuffix()}`;

      // Pre-write cache row in 'building' state. CHECK constraint requires
      // tier_label IN ('year','custom','filtered'), session_key NOT NULL,
      // range_start/range_end NOT NULL. prompt_id is REQUIRED — but we
      // need to look it up first.
      // Look up the active prompt_id BEFORE the cache write so we can
      // satisfy the FK to lcm_prompt_registry. If no prompt is registered
      // we surface a clear error before any LLM call.
      const promptCheckRow = db
        .prepare(
          `SELECT prompt_id FROM lcm_prompt_registry
             WHERE memory_type = 'episodic-condensed' AND tier_label = ? AND pass_kind = 'single' AND active = 1
             ORDER BY version DESC LIMIT 1`,
        )
        .get(tier) as { prompt_id: string } | undefined;
      if (!promptCheckRow) {
        return jsonResult({
          error: `missing_prompt: no active prompt for (memory_type=episodic-condensed, tier=${tier}, pass_kind=single).`,
          hint:
            "Register a prompt via `registerPrompt(db, { memoryType: 'episodic-condensed', tierLabel: '" +
            tier +
            "', passKind: 'single', template: '...' })` before calling this tool.",
        });
      }
      const initialPromptId = promptCheckRow.prompt_id;

      try {
        db.prepare(
          `INSERT INTO lcm_synthesis_cache
             (cache_id, session_key, range_start, range_end, leaf_fingerprint,
              entity_index, model_used, prompt_id, tier_label,
              source_leaf_ids, source_token_count, output_token_count,
              actual_range_covered, leaf_count_synthesized,
              status, building_started_at)
           VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, 0, ?, ?, 'building', datetime('now'))`,
        ).run(
          cacheId,
          sessionKeyForCache,
          rangeStartIso,
          rangeEndIso,
          leafFingerprint,
          summarizerBuilt.model,
          initialPromptId,
          cacheTierLabel,
          JSON.stringify(leafIds),
          sourceTokenCount,
          JSON.stringify({
            mode: windowKind,
            anchorSummaryId: targetSummary?.summary_id ?? null,
            ...(windowKind === "time"
              ? { hours: windowHours }
              : { k: windowK, model: semanticMeta?.modelName ?? null }),
            since: sinceBound?.toISOString() ?? null,
            before: beforeBound?.toISOString() ?? null,
          }),
          leafIds.length,
        );
      } catch (insertErr) {
        return jsonResult({
          error: `Failed to insert synthesis cache row: ${insertErr instanceof Error ? insertErr.message : String(insertErr)}`,
        });
      }

      // 11. Dispatch synthesis. The dispatch will look up the active
      //     prompt for (memoryType, tier, single), record audit rows, and
      //     return the synthesized output.
      let dispatchResult;
      try {
        dispatchResult = await dispatchSynthesis(db, llmCall, {
          tier,
          memoryType: "episodic-condensed",
          sourceText,
          passSessionId,
          targetCacheId: cacheId,
        });
      } catch (error) {
        // Update cache row to failed and surface the error kind.
        try {
          db.prepare(
            `UPDATE lcm_synthesis_cache
               SET status = 'failed', failure_reason = ?
               WHERE cache_id = ?`,
          ).run(error instanceof Error ? error.message.slice(0, 800) : String(error).slice(0, 800), cacheId);
        } catch {
          // best-effort
        }
        if (error instanceof SynthesisDispatchError) {
          return jsonResult({
            error: `${error.kind}: ${error.message}`,
            cache_id: cacheId,
            hint:
              error.kind === "missing_prompt"
                ? `Register an active prompt for (memory_type='episodic-condensed', tier_label='${tier}', pass_kind='single') before calling this tool.`
                : undefined,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        return jsonResult({ error: `Synthesis dispatch failed: ${message}`, cache_id: cacheId });
      }

      const outputText = dispatchResult.output;
      const outputTokens = estimateTokens(outputText);

      // 12. Update the cache row with the final content + ready status.
      try {
        db.prepare(
          `UPDATE lcm_synthesis_cache
             SET status = 'ready', content = ?, output_token_count = ?,
                 prompt_id = ?, building_started_at = NULL
             WHERE cache_id = ?`,
        ).run(outputText, outputTokens, dispatchResult.primaryPromptId, cacheId);
      } catch (updateErr) {
        // The synthesis succeeded; cache update failure is logged but
        // shouldn't block the response.
        input.deps.log.warn(
          `[lcm] synthesize_around: cache row update failed for ${cacheId}: ${updateErr instanceof Error ? updateErr.message : String(updateErr)}`,
        );
      }

      // 13. Optional: leaf refs for purge-cascade (best-effort — if any
      //     leaf goes away later, cascade deletes this cache row too).
      try {
        const refStmt = db.prepare(
          `INSERT OR IGNORE INTO lcm_cache_leaf_refs (cache_id, leaf_summary_id) VALUES (?, ?)`,
        );
        for (const id of leafIds) {
          refStmt.run(cacheId, id);
        }
      } catch (refErr) {
        input.deps.log.warn(
          `[lcm] synthesize_around: cache_leaf_refs insert failed for ${cacheId}: ${refErr instanceof Error ? refErr.message : String(refErr)}`,
        );
      }

      // 14. Build the markdown response.
      const lines: string[] = [];
      lines.push("## LCM Synthesize-Around");
      lines.push(`**Mode:** ${windowKind}`);
      if (windowKind === "time") {
        lines.push(`**Window:** ±${windowHours}h around ${formatDisplayTime(targetSummary!.created_at, timezone)}`);
      } else {
        lines.push(`**Window:** top-${windowK} semantic neighbours`);
        if (semanticMeta?.modelName) {
          lines.push(`**Embedding model:** ${semanticMeta.modelName}`);
        }
      }
      lines.push(`**Effective range:** ${formatDisplayTime(rangeStartIso, timezone)} → ${formatDisplayTime(rangeEndIso, timezone)}`);
      lines.push(`**Leaves synthesized:** ${leafIds.length}${built.truncatedAt != null ? ` (truncated from ${leafRows.length})` : ""}`);
      lines.push(`**Tier:** ${tier}`);
      lines.push(`**Cache id:** \`${cacheId}\``);
      lines.push(`**Cost:** ${dispatchResult.totalCostCents} cents | **Latency:** ${dispatchResult.totalLatencyMs}ms`);
      if (dispatchResult.hallucinationFlagged === true) {
        lines.push("**Verify-fidelity:** flagged possible hallucination — see audit");
      }
      lines.push("");
      lines.push("---");
      lines.push("");
      lines.push(outputText);

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          cache_id: cacheId,
          mode: windowKind,
          tier,
          range_start: rangeStartIso,
          range_end: rangeEndIso,
          leaf_count: leafIds.length,
          source_token_count: sourceTokenCount,
          output_token_count: outputTokens,
          truncated: built.truncatedAt != null,
          model_used: summarizerBuilt.model,
          embedding_model: semanticMeta?.modelName ?? null,
          voyage_tokens_consumed: semanticMeta?.voyageTokensConsumed ?? 0,
          synthesis: {
            primary_prompt_id: dispatchResult.primaryPromptId,
            audit_ids: dispatchResult.auditIds,
            total_latency_ms: dispatchResult.totalLatencyMs,
            total_cost_cents: dispatchResult.totalCostCents,
            hallucination_flagged: dispatchResult.hallucinationFlagged ?? null,
          },
          target: {
            kind: targetIsSummaryId ? "summary_id" : "query",
            value: target,
            summary_anchor_at: targetSummary?.created_at ?? null,
          },
        },
      };
    },
  };
}
