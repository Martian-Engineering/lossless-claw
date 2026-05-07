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
 * Suppression note: this tool returns entity records, NOT mentions. Entities
 * with all-suppressed mentions can still appear here (the entity row itself
 * isn't suppressed). To check if an entity has agent-visible mentions, call
 * lcm_get_entity which filters mentions by parent summary's suppressed_at.
 */

import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { formatTimestamp } from "../compaction.js";

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
        "Optional entity_type filter (e.g. 'person', 'project', 'pr', 'commit', 'file').",
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

      // Build WHERE / pattern based on mode
      const filters: string[] = ["session_key = ?"];
      const binds: (string | number)[] = [effectiveSessionKey];

      const escaped = escapeLike(query);
      let pattern: string;
      if (mode === "prefix") {
        pattern = `${escaped}%`;
        filters.push("canonical_text LIKE ? ESCAPE '\\' COLLATE NOCASE");
        binds.push(pattern);
      } else if (mode === "exact") {
        filters.push("canonical_text = ? COLLATE NOCASE");
        binds.push(query);
      } else {
        pattern = `%${escaped}%`;
        filters.push("canonical_text LIKE ? ESCAPE '\\' COLLATE NOCASE");
        binds.push(pattern);
      }
      if (entityTypeFilter) {
        filters.push("entity_type = ?");
        binds.push(entityTypeFilter);
      }

      // Rank: most-occurrences first, then most-recent. Cap at `limit`.
      const rows = db
        .prepare(
          `SELECT entity_id, canonical_text, entity_type,
                  first_seen_at, last_seen_at, occurrence_count, alternate_surfaces
             FROM lcm_entities
             WHERE ${filters.join(" AND ")}
             ORDER BY occurrence_count DESC, last_seen_at DESC
             LIMIT ?`,
        )
        .all(...binds, limit) as EntityRow[];

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
        lines.push("_No matching entities. The entity coreference worker may not have processed leaves containing this name yet._");
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
          entities: rows.map((r) => ({
            entityId: r.entity_id,
            canonicalText: r.canonical_text,
            entityType: r.entity_type,
            firstSeenAt: r.first_seen_at,
            lastSeenAt: r.last_seen_at,
            occurrenceCount: r.occurrence_count,
            alternateSurfaces: safeJsonParse<string[]>(r.alternate_surfaces) ?? [],
          })),
        },
      };
    },
  };
}
