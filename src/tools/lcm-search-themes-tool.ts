/**
 * lcm_search_themes — agent-explicit themes search tool (v4.1 §6.3 / Group G).
 *
 * Themes are NEVER in the assemble() pyramid (per the v4 RAG-leak adversarial
 * finding). This tool lets agents search the consolidated themes by query
 * substring (against name + description). Pairs with `lcm_recent_themes` (which
 * lists by recency) and `lcm_theme_explain` (which expands one theme by ID).
 *
 * For now only `mode='text'` is supported; semantic theme search requires
 * theme-level embeddings which haven't been wired yet.
 */

import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;
const DESCRIPTION_TRUNCATE_LEN = 200;

type SearchMode = "text" | "semantic";
type StatusFilter = "active" | "stale" | "all";

const LcmSearchThemesSchema = Type.Object({
  query: Type.String({
    description:
      "Substring to match against theme name OR description (case-insensitive).",
  }),
  mode: Type.Optional(
    Type.String({
      enum: ["text", "semantic"],
      description:
        "Search mode. 'text' (default) does case-insensitive LIKE matching against name + description. 'semantic' is not yet supported (theme-embedding backfill not wired).",
    }),
  ),
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Optional session-key scope filter. If omitted, searches across all sessions.",
    }),
  ),
  status: Type.Optional(
    Type.String({
      enum: ["active", "stale", "all"],
      description:
        "Theme status filter. 'active' (default) returns currently-valid themes; 'stale' means source leaves changed and re-consolidation is pending; 'all' returns everything.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: `Max themes to return (default ${DEFAULT_LIMIT}; range ${MIN_LIMIT}-${MAX_LIMIT}).`,
      minimum: MIN_LIMIT,
      maximum: MAX_LIMIT,
    }),
  ),
});

function normalizeMode(value: unknown): SearchMode {
  if (value === "semantic") return "semantic";
  return "text";
}

function normalizeStatus(value: unknown): StatusFilter {
  if (value === "stale" || value === "all" || value === "active") {
    return value;
  }
  return "active";
}

function truncateDescription(desc: string): string {
  const singleLine = desc.replace(/\n/g, " ").trim();
  if (singleLine.length <= DESCRIPTION_TRUNCATE_LEN) return singleLine;
  return singleLine.substring(0, DESCRIPTION_TRUNCATE_LEN) + "...";
}

interface ThemeSearchRow {
  theme_id: string;
  name: string;
  description: string;
  source_leaf_count: number;
  status: "active" | "stale" | "archived";
  consolidated_at: string;
  session_key: string;
}

export function createLcmSearchThemesTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_search_themes",
    label: "LCM Search Themes",
    description:
      "Search consolidated themes by substring match against name + " +
      "description. Use this to find themes related to a query (e.g. " +
      "'rebase', 'plan-mode'). Themes are agent-explicit only — they never " +
      "appear in the auto-assembled context. Returns hits sorted by " +
      "source-leaf count (largest themes first). Pairs with " +
      "lcm_theme_explain to drill into a specific theme.",
    parameters: LcmSearchThemesSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const p = params as Record<string, unknown>;

      const query = typeof p.query === "string" ? p.query.trim() : "";
      if (query.length === 0) {
        return jsonResult({
          error: "`query` is required and must be a non-empty string.",
        });
      }

      const mode = normalizeMode(p.mode);
      if (mode === "semantic") {
        return jsonResult({
          error:
            "semantic theme search requires theme embeddings; backfill them via a future operator command — for now use mode='text'",
        });
      }

      const status = normalizeStatus(p.status);
      const explicitSessionKey =
        typeof p.sessionKey === "string" && p.sessionKey.trim().length > 0
          ? p.sessionKey.trim()
          : undefined;
      const limit =
        typeof p.limit === "number" && Number.isFinite(p.limit)
          ? Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(p.limit)))
          : DEFAULT_LIMIT;

      const db = lcm.getDb();
      if (!db) {
        return jsonResult({
          error: "LCM database is unavailable.",
        });
      }

      const likePattern = `%${query}%`;
      const sessionKeyParam = explicitSessionKey ?? null;

      const rows = db
        .prepare(
          `SELECT theme_id, name, description, source_leaf_count, status, consolidated_at, session_key
             FROM lcm_themes
             WHERE (LOWER(name) LIKE LOWER(?) OR LOWER(description) LIKE LOWER(?))
               AND (status = ? OR ? = 'all')
               AND (session_key = ? OR ? IS NULL)
             ORDER BY source_leaf_count DESC
             LIMIT ?`,
        )
        .all(
          likePattern,
          likePattern,
          status,
          status,
          sessionKeyParam,
          sessionKeyParam,
          limit,
        ) as ThemeSearchRow[];

      const lines: string[] = [];
      const headerScope = explicitSessionKey ? `, sessionKey=${explicitSessionKey}` : "";
      lines.push(
        `## LCM Theme Search (query="${query}", mode=${mode}, n=${rows.length}${headerScope})`,
      );

      if (rows.length === 0) {
        lines.push("");
        // v4.1 Final.review.3 fix (Slice 5 §3 MED): the previous hint pointed
        // at `/lcm worker tick consolidate-themes`, which (a) doesn't accept
        // `consolidate-themes` as a kind name (parser expects `themes-
        // consolidation`), and (b) the kind isn't wired into the parser at
        // all (cycle-3 deferred). Replace with an honest message about the
        // current state.
        lines.push(
          `No themes match query "${query}" in mode=${mode}. Themes consolidation auto-tick is cycle-3 — themes are populated only when an operator manually triggers consolidation. If you expected results, check that themes have been built for this session.`,
        );
      } else {
        for (const r of rows) {
          const desc = truncateDescription(r.description ?? "");
          const statusBadge = r.status !== "active" ? ` [${r.status}]` : "";
          lines.push(
            `- **${r.name}**${statusBadge} (${r.source_leaf_count} leaves, ${r.session_key}) — \`${r.theme_id}\` — ${desc}`,
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          query,
          mode,
          status,
          sessionKey: explicitSessionKey ?? null,
          limit,
          themeCount: rows.length,
          themes: rows.map((r) => ({
            themeId: r.theme_id,
            name: r.name,
            description: r.description,
            sourceLeafCount: r.source_leaf_count,
            status: r.status,
            consolidatedAt: r.consolidated_at,
            sessionKey: r.session_key,
          })),
        },
      };
    },
  };
}
