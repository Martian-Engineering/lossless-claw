/**
 * lcm_get_entity — agent tool to look up a specific entity by canonical name
 * (e.g., "Voyage", "Eva", "PR #613") and return its mentions across the corpus.
 *
 * Backed by lcm_entities + lcm_entity_mentions (populated by the async entity
 * coreference worker — see src/extraction/entity-coreference.ts +
 * src/operator/extraction-autostart.ts).
 *
 * Use this when the agent or user asks "tell me about X" or "what work has been
 * done on X" — distinct from `lcm_search_entities` (fuzzy / browse) and
 * `lcm_grep --mode semantic` (similarity over leaf content, no entity needed).
 *
 * Caller-provided `name` is matched COLLATE NOCASE against `canonical_text`.
 * Optional filters: session_key (defaults to current session_key), entity_type
 * (e.g. "person", "project"), and limit on returned mentions.
 *
 * Returns: the entity record + a list of mentions with summary_id, surface_form,
 * mentioned_at. Mention list is bounded by `mentionLimit` (default 20, max 100).
 *
 * Suppression: filters mentions where the parent summary has suppressed_at
 * IS NOT NULL. The lossless-bedrock principle still holds for the entities
 * table itself — entities are not deleted on leaf suppression, but their
 * mentions are filtered from agent surfaces.
 */

import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { formatTimestamp } from "../compaction.js";
import { runWithTokenGate } from "../plugin/needs-compact-gate.js";
import { VISIBLE_MENTIONS_CTE, entityAggCte } from "./lcm-entity-shared.js";

const DEFAULT_MENTION_LIMIT = 20;
const MIN_MENTION_LIMIT = 1;
const MAX_MENTION_LIMIT = 100;

const LcmGetEntitySchema = Type.Object({
  name: Type.String({
    description:
      "Entity name to look up. Matched COLLATE NOCASE against the canonical " +
      "form in lcm_entities (e.g. 'Voyage', 'eva', 'PR #613'). Required.",
  }),
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Session key scope. If omitted, defaults to the current session's key.",
    }),
  ),
  entityType: Type.Optional(
    Type.String({
      description:
        "Optional entity_type filter. Common extractor-produced values: 'person_name', " +
        "'pr_number', 'agent_id', 'session_key', 'command', 'file_path', 'date'. Useful when " +
        "the same name (e.g. 'main') could match multiple entity types. Discover what's in " +
        "the catalog first via lcm_search_entities without an entityType filter.",
    }),
  ),
  mentionLimit: Type.Optional(
    Type.Number({
      description: `Max mentions to return (default ${DEFAULT_MENTION_LIMIT}; range ${MIN_MENTION_LIMIT}-${MAX_MENTION_LIMIT}).`,
      minimum: MIN_MENTION_LIMIT,
      maximum: MAX_MENTION_LIMIT,
    }),
  ),
});

interface EntityRow {
  entity_id: string;
  session_key: string;
  canonical_text: string;
  entity_type: string;
  first_seen_at: string;
  last_seen_at: string;
  first_seen_in_summary_id: string | null;
  occurrence_count: number;
  alternate_surfaces: string | null;
  metadata: string | null;
}

interface MentionRow {
  mention_id: string;
  entity_id: string;
  summary_id: string;
  surface_form: string;
  span_start: number | null;
  span_end: number | null;
  mentioned_at: string;
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

export function createLcmGetEntityTool(input: {
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
    name: "lcm_get_entity",
    label: "LCM Get Entity",
    description:
      "Look up a NAMED entity (person, project, customer, library, identifier — " +
      "things automatically extracted by the entity coreference worker) by " +
      "canonical name and return its mentions across the session corpus. " +
      "PRIMARY tool for Type D pattern-anchored entity queries when the user " +
      "NAMES a specific entity: 'tell me about <X>', 'history of customer <Y>', " +
      "'work I've done with <library Z>'. " +
      "If the user is asking a paraphrastic topic question without naming an " +
      "entity ('have we discussed X-shaped problems', 'what work has been done " +
      "on rate limiting'), prefer lcm_grep --mode hybrid instead — it handles " +
      "paraphrase across the corpus without needing a canonical entity to exist. " +
      "For browsing many entities by substring or by entity_type, use " +
      "lcm_search_entities. For raw leaf content similarity (no entity " +
      "needed), use lcm_grep --mode semantic.",
    parameters: LcmGetEntitySchema,
    async execute(_toolCallId, params) {
      return runWithTokenGate({
        toolName: "lcm_get_entity",
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

      // 1. Validate name
      const name = typeof p.name === "string" ? p.name.trim() : "";
      if (name.length === 0) {
        return jsonResult({ error: "`name` is required." });
      }

      // 2. Resolve session_key — explicit param wins; else current session.
      const sessionKeyParam = typeof p.sessionKey === "string" ? p.sessionKey.trim() : "";
      const effectiveSessionKey = sessionKeyParam.length > 0 ? sessionKeyParam : input.sessionKey;
      if (!effectiveSessionKey) {
        return jsonResult({
          error:
            "No session_key resolved. Pass `sessionKey` explicitly or call from an active LCM session.",
        });
      }

      // 3. Optional entity_type filter
      const entityTypeFilter =
        typeof p.entityType === "string" && p.entityType.trim().length > 0
          ? p.entityType.trim().toLowerCase()
          : null;

      // 4. Mention limit
      const mentionLimit =
        typeof p.mentionLimit === "number" && Number.isFinite(p.mentionLimit)
          ? Math.max(MIN_MENTION_LIMIT, Math.min(MAX_MENTION_LIMIT, Math.trunc(p.mentionLimit)))
          : DEFAULT_MENTION_LIMIT;

      const db = lcm.getDb();

      // 5. Look up the entity (COLLATE NOCASE).
      // Wave-10 reviewer P2 fix: previously this returned the entity row
      // even when ALL its mentions had been suppressed via /lcm purge.
      // Wave-12 reviewer P1 fix: even with the EXISTS guard, the
      // aggregate columns (occurrence_count, first/last_seen_*,
      // alternate_surfaces, first_seen_in_summary_id) were read directly
      // from `lcm_entities` — they include suppressed-mention data.
      // Recompute aggregates from the unsuppressed mention join. Now
      // suppression contract is fully clean: "suppression means
      // invisible to agents, period" (no oracle handles via aggregate
      // columns either). The CTE join also implicitly enforces the
      // EXISTS guard — if no unsuppressed mention, no row in entity_agg
      // → no row returned. Operators wanting audit-mode view must use
      // raw SQL.
      const entityFilters: string[] = [
        "e.session_key = ?",
        "e.canonical_text = ? COLLATE NOCASE",
      ];
      const entityBinds: (string | number)[] = [effectiveSessionKey, name];
      if (entityTypeFilter) {
        entityFilters.push("e.entity_type = ?");
        entityBinds.push(entityTypeFilter);
      }
      // Wave-12 consolidation B: CTE extracted into shared helper to
      // close the parallel-edit drift hazard between get-entity +
      // search-entities (both maintained byte-identical SQL post-F4).
      const entity = db
        .prepare(
          `${VISIBLE_MENTIONS_CTE}${entityAggCte({ includeFirstIn: true })}
           SELECT e.entity_id, e.session_key, e.canonical_text, e.entity_type,
                  ea.first_at AS first_seen_at,
                  ea.last_at  AS last_seen_at,
                  ea.first_in AS first_seen_in_summary_id,
                  ea.occ_count AS occurrence_count,
                  ea.visible_surfaces AS alternate_surfaces,
                  e.metadata
             FROM lcm_entities e
             JOIN entity_agg ea ON ea.entity_id = e.entity_id
            WHERE ${entityFilters.join(" AND ")}
            LIMIT 1`,
        )
        .get(...entityBinds) as EntityRow | undefined;

      if (!entity) {
        // The "not found" branch now covers BOTH "no such entity" AND
        // "all mentions suppressed" — they're indistinguishable to the
        // agent by design (operator suppression is the contract). The
        // message intentionally doesn't say "or has been suppressed" so
        // an attacker can't infer entity existence by querying.
        return jsonResult({
          found: false,
          name,
          sessionKey: effectiveSessionKey,
          entityType: entityTypeFilter,
          message: `No entity matching '${name}'${entityTypeFilter ? ` of type '${entityTypeFilter}'` : ""} in session_key='${effectiveSessionKey}'. The entity coreference worker may not have run yet, or the name doesn't appear in any leaf summary.`,
          // Concrete fallbacks the agent can try right now (Eva onboarding
          // feedback: empty entity result should suggest next steps, not
          // dead-end). Try in order: prefix browse → paraphrastic search.
          fallback_suggestions: [
            `lcm_search_entities query='${name.toLowerCase().split(/[\s\-_]+/)[0] ?? name}' mode='prefix' — browse entities by canonical-name prefix (handles 'Smarter-Claw' vs 'smarter claw' canonicalization mismatches)`,
            `lcm_grep mode='hybrid' pattern='${name}' — paraphrastic search across all summary content (works without an entity catalog entry, surfaces mentions even if coreference hasn't run)`,
            `lcm_grep mode='verbatim' pattern='${name}' — exact-text search of source messages (for citation / quote-back use cases)`,
          ],
        });
      }

      // 6. Look up mentions — JOIN to summaries to filter suppressed leaves.
      const mentions = db
        .prepare(
          `SELECT m.mention_id, m.entity_id, m.summary_id, m.surface_form,
                  m.span_start, m.span_end, m.mentioned_at
             FROM lcm_entity_mentions m
             JOIN summaries s ON s.summary_id = m.summary_id
             WHERE m.entity_id = ?
               AND s.suppressed_at IS NULL
             ORDER BY m.mentioned_at DESC
             LIMIT ?`,
        )
        // Wave-9 TS-tightening: Record<string, SQLOutputValue>[] doesn't
        // overlap MentionRow strictly enough for direct cast; route
        // through unknown.
        .all(entity.entity_id, mentionLimit) as unknown as MentionRow[];

      // Wave-12 reviewer P1 fix: alternate_surfaces is now the
      // recomputed distinct set from unsuppressed mentions only.
      // Strip the canonical form so the list shows only *alternate*
      // surfaces (matches the column's intent + parity with stored
      // representation).
      const allSurfaces = safeJsonParse<string[]>(entity.alternate_surfaces) ?? [];
      const altSurfaces = allSurfaces.filter(
        (s) => s.localeCompare(entity.canonical_text, undefined, { sensitivity: "base" }) !== 0,
      );
      const metadata = safeJsonParse<Record<string, unknown>>(entity.metadata) ?? {};

      // 7. Markdown rendering for tool output
      const lines: string[] = [];
      lines.push(`## Entity: ${entity.canonical_text}`);
      lines.push("");
      lines.push(`- **Type**: ${entity.entity_type}`);
      lines.push(`- **Entity ID**: \`${entity.entity_id}\``);
      lines.push(`- **Session key**: \`${entity.session_key}\``);
      lines.push(`- **First seen**: ${formatDisplayTime(entity.first_seen_at, timezone)}`);
      lines.push(`- **Last seen**: ${formatDisplayTime(entity.last_seen_at, timezone)}`);
      lines.push(`- **Total occurrences**: ${entity.occurrence_count}`);
      if (altSurfaces.length > 0) {
        lines.push(`- **Alternate surfaces**: ${altSurfaces.join(", ")}`);
      }
      if (entity.first_seen_in_summary_id) {
        lines.push(`- **First seen in**: \`${entity.first_seen_in_summary_id}\``);
      }
      lines.push("");
      if (mentions.length === 0) {
        lines.push("_No agent-visible mentions (all may be in suppressed leaves)._");
      } else {
        // Wave-12 reviewer P1: occurrence_count is now visible-only, so
        // length === occurrence_count when not truncated by mentionLimit.
        // Show "(N of M)" only when truncation actually happened.
        const truncated = mentions.length < entity.occurrence_count;
        lines.push(
          truncated
            ? `### Mentions (${mentions.length} of ${entity.occurrence_count})`
            : `### Mentions (${mentions.length})`,
        );
        lines.push("");
        for (const m of mentions) {
          lines.push(
            `- [${formatDisplayTime(m.mentioned_at, timezone)}] in \`${m.summary_id}\` — surface: "${m.surface_form}"`,
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          found: true,
          entityId: entity.entity_id,
          name: entity.canonical_text,
          entityType: entity.entity_type,
          sessionKey: entity.session_key,
          firstSeenAt: entity.first_seen_at,
          lastSeenAt: entity.last_seen_at,
          totalOccurrences: entity.occurrence_count,
          alternateSurfaces: altSurfaces,
          firstSeenInSummaryId: entity.first_seen_in_summary_id,
          metadata,
          mentions: mentions.map((m) => ({
            mentionId: m.mention_id,
            summaryId: m.summary_id,
            surfaceForm: m.surface_form,
            spanStart: m.span_start,
            spanEnd: m.span_end,
            mentionedAt: m.mentioned_at,
          })),
          mentionsTruncated: mentions.length === mentionLimit,
        },
      };
        },
      });
    },
  };
}
