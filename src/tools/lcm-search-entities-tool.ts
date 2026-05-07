/**
 * lcm_search_entities — agent tool for fuzzy / substring search across the
 * entity catalog. Returns matching entities ranked by recency + occurrence_count.
 *
 * Use this when the agent doesn't know the exact canonical name (e.g. "show me
 * entities related to embeddings") or wants to browse what's in the catalog.
 * For exact-name lookup with full mention list, use `lcm_get_entity`.
 *
 * Backed by lcm_entities (populated by the async entity coreference worker).
 *
 * Search modes:
 *   - `LIKE` (default): canonical_text LIKE %query% COLLATE NOCASE — fast,
 *     substring match
 *   - `prefix`: canonical_text LIKE query% COLLATE NOCASE — narrower, useful
 *     when the agent has the start of a name
 *   - `exact`: canonical_text = query COLLATE NOCASE — degenerate case;
 *     prefer `lcm_get_entity` for exact lookup
 *
 * Suppression: entities with ZERO unsuppressed mentions are filtered out
 * (Wave-10 reviewer P2 fix). The query joins through `lcm_entity_mentions`
 * + `summaries` and requires at least one mention with
 * `suppressed_at IS NULL`. This means an entity returned here has at
 * least one agent-visible mention. (Operators wanting the audit-mode
 * view of suppressed-only entities must use raw SQL — there is no
 * agent-facing path that exposes them.)
 */

import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { formatTimestamp } from "../compaction.js";
import { runWithTokenGate } from "../plugin/needs-compact-gate.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

type SearchMode = "like" | "prefix" | "exact";

const LcmSearchEntitiesSchema = Type.Object({
  query: Type.String({
    description:
      "Search query. Default mode is substring (LIKE %query%). Use the `mode` " +
      "param to switch to 'prefix' (LIKE query%) or 'exact' (= query). " +
      "All matches are COLLATE NOCASE.",
  }),
  mode: Type.Optional(
    Type.String({
      enum: ["like", "prefix", "exact"],
      description: "Match mode (default 'like'). 'prefix' matches start; 'exact' matches whole.",
    }),
  ),
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Session key scope. If omitted, defaults to the current session's key.",
    }),
  ),
  entityType: Type.Optional(
    Type.String({
      description:
        "Optional entity_type filter. Common values produced by the entity-coreference extractor: " +
        "'person_name', 'pr_number', 'agent_id', 'session_key', 'command', 'file_path', 'date'. " +
        "Wave-1 Auditor #7 finding #8: the extractor uses snake_case canonical types; older docs " +
        "incorrectly listed 'person'/'project'/'pr' which never matched. Use lcm_search_entities " +
        "without an entityType filter first to discover what's actually in the catalog.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Max entities to return (default ${DEFAULT_LIMIT}; range ${MIN_LIMIT}-${MAX_LIMIT}).`,
      minimum: MIN_LIMIT,
      maximum: MAX_LIMIT,
    }),
  ),
});

interface EntityRow {
  entity_id: string;
  canonical_text: string;
  entity_type: string;
  first_seen_at: string;
  last_seen_at: string;
  occurrence_count: number;
  alternate_surfaces: string | null;
}

function formatDisplayTime(value: string | null | undefined, timezone: string): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  return formatTimestamp(d, timezone);
}

function safeJsonParse<T>(s: string | null): T | null {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}

function escapeLike(input: string): string {
  // Escape % and _ so user-supplied input doesn't accidentally widen the
  // search. We use ESCAPE '\' in the SQL clause.
  return input.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

function normalizeMode(value: unknown): SearchMode {
  if (value === "prefix" || value === "exact") return value;
  return "like";
}

export function createLcmSearchEntitiesTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
  /** Wave-14 token-state runtime context. */
  getRuntimeContext?: () => {
    currentTokenCount?: number;
    tokenBudget?: number;
  };
}): AnyAgentTool {
  return {
    name: "lcm_search_entities",
    label: "LCM Search Entities",
    description:
      "Browse / search the entity catalog by name (substring, prefix, or exact " +
      "match — all COLLATE NOCASE). Returns ranked entities with their type + " +
      "occurrence count + last-seen time. For full mention list of a single " +
      "entity, follow up with lcm_get_entity. Backed by the async entity " +
      "coreference worker.",
    parameters: LcmSearchEntitiesSchema,
    async execute(_toolCallId, params) {
      return runWithTokenGate({
        toolName: "lcm_search_entities",
        toolParams: params as Record<string, unknown>,
        sessionKey: input.sessionKey,
        getRuntimeContext: input.getRuntimeContext,
        inner: async () => {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const timezone = lcm.timezone;
      const p = params as Record<string, unknown>;

      const query = typeof p.query === "string" ? p.query.trim() : "";
      if (query.length === 0) {
        return jsonResult({ error: "`query` is required (non-empty)." });
      }

      const mode = normalizeMode(p.mode);

      const sessionKeyParam = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      const effectiveSessionKey = sessionKeyParam.length > 0 ? sessionKeyParam : input.sessionKey;
      if (!effectiveSessionKey) {
        return jsonResult({
          error:
            "No session_key resolved. Pass `sessionKey` explicitly or call from an active LCM session.",
        });
      }

      const entityTypeFilter =
        typeof p.entityType === "string" && p.entityType.trim().length > 0
          ? p.entityType.trim().toLowerCase()
          : null;

      const limit =
        typeof p.limit === "number" && Number.isFinite(p.limit)
          ? Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(p.limit)))
          : DEFAULT_LIMIT;

      const db = lcm.getDb();

      // Build WHERE / pattern based on mode.
      // Wave-10 reviewer P2 fix: previously the docstring acknowledged
      // "Entities with all-suppressed mentions can still appear here
      // (the entity row itself isn't suppressed)" — but that violated
      // the suppression contract for agent-facing read paths. Add an
      // EXISTS guard requiring at least one unsuppressed mention so
      // suppressed entities don't leak via search either.
      const filters: string[] = [
        "e.session_key = ?",
        // EXISTS guard: at least one mention whose summary is not suppressed.
        `EXISTS (
           SELECT 1 FROM lcm_entity_mentions m
             JOIN summaries s ON s.summary_id = m.summary_id
             WHERE m.entity_id = e.entity_id
               AND s.suppressed_at IS NULL
         )`,
      ];
      const binds: (string | number)[] = [effectiveSessionKey];

      const escaped = escapeLike(query);
      let pattern: string;
      if (mode === "prefix") {
        pattern = `${escaped}%`;
        filters.push("e.canonical_text LIKE ? ESCAPE '\\' COLLATE NOCASE");
        binds.push(pattern);
      } else if (mode === "exact") {
        filters.push("e.canonical_text = ? COLLATE NOCASE");
        binds.push(query);
      } else {
        pattern = `%${escaped}%`;
        filters.push("e.canonical_text LIKE ? ESCAPE '\\' COLLATE NOCASE");
        binds.push(pattern);
      }
      if (entityTypeFilter) {
        filters.push("e.entity_type = ?");
        binds.push(entityTypeFilter);
      }

      // Wave-12 reviewer P1 fix: rank + display aggregates from
      // unsuppressed mentions only (mirrors lcm_get_entity). Without the
      // CTE, occurrence_count + last_seen_at + alternate_surfaces leak
      // suppressed-mention data, ranking biases toward heavily-suppressed
      // entities, and surface forms first introduced in suppressed leaves
      // remain visible. The CTE join also acts as the visible-mentions
      // gate (no unsuppressed mention → entity hidden, mirroring the
      // EXISTS guard already in get-entity).
      // Rank: most-occurrences first, then most-recent. Cap at `limit`.
      const rows = db
        .prepare(
          `WITH visible_mentions AS (
             SELECT m.entity_id, m.summary_id, m.surface_form, m.mentioned_at
               FROM lcm_entity_mentions m
               JOIN summaries s ON s.summary_id = m.summary_id
              WHERE s.suppressed_at IS NULL
           ),
           entity_agg AS (
             SELECT
               vm.entity_id,
               COUNT(*) AS occ_count,
               MIN(vm.mentioned_at) AS first_at,
               MAX(vm.mentioned_at) AS last_at,
               json_group_array(DISTINCT vm.surface_form) AS visible_surfaces
              FROM visible_mentions vm
             GROUP BY vm.entity_id
           )
           SELECT e.entity_id, e.canonical_text, e.entity_type,
                  ea.first_at AS first_seen_at,
                  ea.last_at  AS last_seen_at,
                  ea.occ_count AS occurrence_count,
                  ea.visible_surfaces AS alternate_surfaces
             FROM lcm_entities e
             JOIN entity_agg ea ON ea.entity_id = e.entity_id
            WHERE ${filters.join(" AND ")}
            ORDER BY ea.occ_count DESC, ea.last_at DESC
            LIMIT ?`,
        )
        // Wave-9 TS-tightening: route through unknown (Record<string,
        // SQLOutputValue>[] doesn't overlap EntityRow strictly).
        .all(...binds, limit) as unknown as EntityRow[];

      // P8 fix (2026-05-06 harness): distinguish "0 results for query" from
      // "0 entities indexed yet" — the latter is a coverage gap, not a
      // negative answer. Probe the catalog scope so callers (and the agent)
      // know which scenario they're in.
      // Audit 3 finding #3 fix: use EXISTS(SELECT 1 ... LIMIT 1) instead of
      // COUNT(*) to avoid full-table scans on multi-million-entity DBs.
      // EXISTS short-circuits at the first row it finds (or doesn't) and
      // is O(log n) via the lcm_entities_lookup_idx index when filtered by
      // session_key, O(1) on the global probe.
      let catalogStatus:
        | "active"
        | "empty-for-session"
        | "empty-globally" = "active";
      if (rows.length === 0) {
        const sessionExists = db
          .prepare(
            `SELECT EXISTS(SELECT 1 FROM lcm_entities WHERE session_key = ? LIMIT 1) AS e`,
          )
          .get(effectiveSessionKey) as { e: number };
        if ((sessionExists?.e ?? 0) === 0) {
          const globalExists = db
            .prepare(`SELECT EXISTS(SELECT 1 FROM lcm_entities LIMIT 1) AS e`)
            .get() as { e: number };
          catalogStatus =
            (globalExists?.e ?? 0) === 0 ? "empty-globally" : "empty-for-session";
        }
      }

      // Markdown rendering
      const lines: string[] = [];
      lines.push(`## LCM Entity Search`);
      lines.push("");
      lines.push(`- **Query**: \`${query}\` (mode: ${mode})`);
      lines.push(`- **Session key**: \`${effectiveSessionKey}\``);
      if (entityTypeFilter) {
        lines.push(`- **Type filter**: ${entityTypeFilter}`);
      }
      lines.push(`- **Matches**: ${rows.length}${rows.length === limit ? ` (limit ${limit} reached — narrow with mode='prefix' or entityType)` : ""}`);
      lines.push("");

      if (rows.length === 0) {
        if (catalogStatus === "empty-globally") {
          lines.push(
            "_No entities indexed in this DB at all. The entity-coreference worker has not run on this DB. This is a coverage gap, NOT a negative answer to your query — the entity may exist in the corpus but has not been extracted yet. Fall back to lcm_grep --mode hybrid for now._",
          );
        } else if (catalogStatus === "empty-for-session") {
          lines.push(
            `_No entities indexed for session_key \`${effectiveSessionKey}\` (other sessions DO have entities — the worker has run on the corpus but not on this session yet, or no extractable entities have appeared in its leaves). Try sessionKey='agent:main:main' if you intended the main thread, or fall back to lcm_grep._`,
          );
        } else {
          lines.push(
            "_No entities matched this query (the catalog has entries for this session, but none match — try a wider query, mode='like', or drop the entityType filter)._",
          );
        }
      } else {
        lines.push(`| Entity | Type | Occurrences | Last seen |`);
        lines.push(`|---|---|---|---|`);
        for (const r of rows) {
          lines.push(
            `| **${r.canonical_text}** | ${r.entity_type} | ${r.occurrence_count} | ${formatDisplayTime(r.last_seen_at, timezone)} |`,
          );
        }
        lines.push("");
        lines.push(`Use \`lcm_get_entity({ name: '<canonical>' })\` for the full mention list of any entry above.`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          query,
          mode,
          sessionKey: effectiveSessionKey,
          entityType: entityTypeFilter,
          totalMatches: rows.length,
          limitReached: rows.length === limit,
          catalogStatus,
          entities: rows.map((r) => {
            const allSurfaces = safeJsonParse<string[]>(r.alternate_surfaces) ?? [];
            // Strip canonical (the recomputed list captures all distinct
            // forms incl. canonical itself). See parity comment in
            // lcm_get_entity for rationale.
            const altSurfaces = allSurfaces.filter(
              (s) => s.localeCompare(r.canonical_text, undefined, { sensitivity: "base" }) !== 0,
            );
            return {
              entityId: r.entity_id,
              canonicalText: r.canonical_text,
              entityType: r.entity_type,
              firstSeenAt: r.first_seen_at,
              lastSeenAt: r.last_seen_at,
              occurrenceCount: r.occurrence_count,
              alternateSurfaces: altSurfaces,
            };
          }),
        },
      };
        },
      });
    },
  };
}
