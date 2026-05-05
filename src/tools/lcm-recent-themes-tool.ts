/**
 * lcm_recent_themes — agent-explicit themes listing tool (v4.1 §6.3 / Group G).
 *
 * Themes are NEVER in the assemble() pyramid (per the v4 RAG-leak adversarial
 * finding). Agents call this tool when they want to see the consolidated themes
 * for a session; the gateway never auto-includes them.
 *
 * Wraps `listThemes(db, ...)` from src/themes/consolidation.ts and renders
 * markdown for tool consumption.
 */

import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import { listThemes } from "../themes/consolidation.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { formatTimestamp } from "../compaction.js";

const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

type ThemeStatusFilter = "active" | "stale" | "archived" | "all";

const LcmRecentThemesSchema = Type.Object({
  sessionKey: Type.Optional(
    Type.String({
      description:
        "Session key to list themes for. If omitted, defaults to the current session's key.",
    }),
  ),
  status: Type.Optional(
    Type.String({
      enum: ["active", "stale", "archived", "all"],
      description:
        "Theme status filter. 'active' (default) returns currently-valid themes; 'stale' means source leaves changed and re-consolidation is pending; 'archived' is operator-marked; 'all' returns everything.",
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

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string,
): string {
  if (value == null) return "-";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return formatTimestamp(date, timezone);
}

function normalizeStatus(value: unknown): ThemeStatusFilter {
  if (value === "stale" || value === "archived" || value === "all" || value === "active") {
    return value;
  }
  return "active";
}

export function createLcmRecentThemesTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_recent_themes",
    label: "LCM Recent Themes",
    description:
      "List consolidated themes for a session. Themes are clusters of " +
      "related compacted leaves with a short name + description, built " +
      "by the idle consolidation pass. Use this to surface the dominant " +
      "topics in a session's history. Themes are agent-explicit only — " +
      "they never appear in the auto-assembled context. " +
      "Returns name, source-leaf count, theme_id (use with lcm_theme_explain), " +
      "and consolidation timestamp.",
    parameters: LcmRecentThemesSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const timezone = lcm.timezone;
      const p = params as Record<string, unknown>;

      const explicitSessionKey =
        typeof p.sessionKey === "string" && p.sessionKey.trim().length > 0
          ? p.sessionKey.trim()
          : undefined;
      const fallbackSessionKey = input.sessionKey?.trim() || undefined;
      const sessionKey = explicitSessionKey ?? fallbackSessionKey;
      if (!sessionKey) {
        return jsonResult({
          error:
            "No session key available. Provide `sessionKey` explicitly, or call from a session-bound context.",
        });
      }

      const status = normalizeStatus(p.status);
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

      const themes = listThemes(db, { sessionKey, status, limit });

      const lines: string[] = [];
      lines.push(`## LCM Recent Themes (${sessionKey}, status=${status})`);
      lines.push(`**Total returned:** ${themes.length}`);
      lines.push("");

      if (themes.length === 0) {
        lines.push("No themes found for this session at the requested status.");
      } else {
        for (const t of themes) {
          const ts = formatDisplayTime(t.consolidatedAt, timezone);
          lines.push(
            `- **${t.name}** (${t.sourceLeafCount} leaves, ${ts}) — \`${t.themeId}\``,
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          sessionKey,
          status,
          limit,
          themeCount: themes.length,
          themes: themes.map((t) => ({
            themeId: t.themeId,
            name: t.name,
            description: t.description,
            sourceLeafCount: t.sourceLeafCount,
            consolidatedAt: t.consolidatedAt,
            status: t.status,
          })),
        },
      };
    },
  };
}
