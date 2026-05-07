/**
 * lcm_theme_explain — agent-explicit theme expansion tool (v4.1 §6.3 / Group G).
 *
 * Themes are NEVER in the assemble() pyramid (per the v4 RAG-leak adversarial
 * finding). This tool expands one theme by ID — surfacing the source leaves
 * (and optionally their snippets) that were consolidated into the theme.
 *
 * Source leaves with `suppressed_at` set are deliberately excluded from the
 * snippet fetch — we never expose suppressed content via the agent surface,
 * mirroring the lcm_semantic_recall hardening (Group C Finding #2).
 */

import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { formatTimestamp } from "../compaction.js";

const DEFAULT_MAX_SOURCES = 10;
const MIN_MAX_SOURCES = 1;
const MAX_MAX_SOURCES = 100;

const LcmThemeExplainSchema = Type.Object({
  themeId: Type.String({
    description: "Theme ID to expand (e.g. theme_sk1_abc123). Get IDs from lcm_recent_themes or lcm_search_themes.",
  }),
  includeSourceContent: Type.Optional(
    Type.Boolean({
      description:
        "If true (default), fetch + include short snippets from each source leaf. If false, only show source IDs.",
    }),
  ),
  maxSourcesShown: Type.Optional(
    Type.Number({
      description: `Cap on how many sources to include (default ${DEFAULT_MAX_SOURCES}; range ${MIN_MAX_SOURCES}-${MAX_MAX_SOURCES}).`,
      minimum: MIN_MAX_SOURCES,
      maximum: MAX_MAX_SOURCES,
    }),
  ),
});

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string,
): string {
  if (value == null) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return formatTimestamp(date, timezone);
}

function truncateSnippet(content: string, maxLen = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) return singleLine;
  return singleLine.substring(0, maxLen - 3) + "...";
}

interface ThemeRow {
  theme_id: string;
  session_key: string;
  name: string;
  description: string;
  source_leaf_count: number;
  consolidated_at: string;
  status: "active" | "stale" | "archived";
  consolidation_model: string | null;
  consolidation_pass_id: string | null;
}

interface SourceRow {
  summary_id: string;
  content: string;
  created_at: string;
  kind: string;
}

export function createLcmThemeExplainTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_theme_explain",
    label: "LCM Theme Explain",
    description:
      "Expand a single theme by ID — surfaces the source leaves (and " +
      "optionally short content snippets) that were consolidated into " +
      "the theme. Use this after lcm_recent_themes or lcm_search_themes " +
      "to drill into what's actually in a theme. Suppressed source leaves " +
      "are excluded from the snippet fetch (theme metadata still shows " +
      "the original source_leaf_count).",
    parameters: LcmThemeExplainSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const timezone = lcm.timezone;
      const p = params as Record<string, unknown>;

      const themeId = typeof p.themeId === "string" ? p.themeId.trim() : "";
      if (themeId.length === 0) {
        return jsonResult({
          error: "`themeId` is required and must be a non-empty string.",
        });
      }

      const includeSourceContent = p.includeSourceContent !== false; // default true
      const maxSourcesShown =
        typeof p.maxSourcesShown === "number" && Number.isFinite(p.maxSourcesShown)
          ? Math.max(MIN_MAX_SOURCES, Math.min(MAX_MAX_SOURCES, Math.trunc(p.maxSourcesShown)))
          : DEFAULT_MAX_SOURCES;

      const db = lcm.getDb();
      if (!db) {
        return jsonResult({
          error: "LCM database is unavailable.",
        });
      }

      // 1. Fetch theme row
      const theme = db
        .prepare(
          `SELECT theme_id, session_key, name, description, source_leaf_count,
                  consolidated_at, status, consolidation_model, consolidation_pass_id
             FROM lcm_themes WHERE theme_id = ?`,
        )
        .get(themeId) as ThemeRow | undefined;

      if (!theme) {
        return jsonResult({
          error: `Theme not found: ${themeId}`,
          hint: "Use lcm_recent_themes or lcm_search_themes to discover valid theme IDs.",
        });
      }

      // 2. Fetch source IDs
      const sourceIdRows = db
        .prepare(
          `SELECT summary_id FROM lcm_theme_sources WHERE theme_id = ? ORDER BY summary_id`,
        )
        .all(themeId) as Array<{ summary_id: string }>;
      const allSourceIds = sourceIdRows.map((r) => r.summary_id);

      // 3. Optionally fetch source content (excluding suppressed)
      let sources: SourceRow[] = [];
      if (includeSourceContent && allSourceIds.length > 0) {
        const idsToFetch = allSourceIds.slice(0, maxSourcesShown);
        const placeholders = idsToFetch.map(() => "?").join(",");
        sources = db
          .prepare(
            `SELECT summary_id, content, created_at, kind
               FROM summaries
              WHERE summary_id IN (${placeholders})
                AND suppressed_at IS NULL
              ORDER BY created_at ASC`,
          )
          .all(...idsToFetch) as SourceRow[];
      }

      // 4. Format markdown
      const lines: string[] = [];
      lines.push(`## Theme: ${theme.name}`);
      lines.push(`**ID**: ${theme.theme_id}`);
      lines.push(`**Session**: ${theme.session_key}`);
      lines.push(`**Status**: ${theme.status}`);
      const shownCountLabel =
        includeSourceContent && allSourceIds.length > maxSourcesShown
          ? `${allSourceIds.length} (showing top ${maxSourcesShown})`
          : `${allSourceIds.length}`;
      lines.push(`**Source leaves**: ${shownCountLabel}`);
      lines.push(`**Consolidated**: ${formatDisplayTime(theme.consolidated_at, timezone)}`);
      if (theme.consolidation_model) {
        lines.push(`**Naming model**: ${theme.consolidation_model}`);
      }
      lines.push(`**Description**: ${theme.description}`);
      lines.push("");

      if (allSourceIds.length === 0) {
        lines.push("### Sources");
        lines.push("*(theme has no recorded source leaves)*");
      } else if (!includeSourceContent) {
        lines.push("### Source IDs");
        for (const sid of allSourceIds.slice(0, maxSourcesShown)) {
          lines.push(`- ${sid}`);
        }
        if (allSourceIds.length > maxSourcesShown) {
          lines.push(`*(${allSourceIds.length - maxSourcesShown} more not shown)*`);
        }
      } else {
        lines.push("### Sources");
        if (sources.length === 0) {
          lines.push("*(all source leaves suppressed or missing)*");
        } else {
          let i = 1;
          for (const s of sources) {
            const ts = formatDisplayTime(s.created_at, timezone);
            lines.push(
              `${i}. [${s.summary_id}] (${s.kind}, ${ts}) — ${truncateSnippet(s.content)}`,
            );
            i++;
          }
          const omitted = Math.min(maxSourcesShown, allSourceIds.length) - sources.length;
          if (omitted > 0) {
            lines.push(`*(${omitted} source leaves omitted because they are suppressed)*`);
          }
          if (allSourceIds.length > maxSourcesShown) {
            lines.push(`*(${allSourceIds.length - maxSourcesShown} additional sources not shown — raise maxSourcesShown to include them)*`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          themeId: theme.theme_id,
          sessionKey: theme.session_key,
          name: theme.name,
          description: theme.description,
          status: theme.status,
          sourceLeafCount: theme.source_leaf_count,
          consolidatedAt: theme.consolidated_at,
          consolidationModel: theme.consolidation_model,
          consolidationPassId: theme.consolidation_pass_id,
          allSourceIds,
          shownSources: sources.map((s) => ({
            summaryId: s.summary_id,
            kind: s.kind,
            createdAt: s.created_at,
            snippet: truncateSnippet(s.content),
          })),
          includeSourceContent,
          maxSourcesShown,
        },
      };
    },
  };
}
