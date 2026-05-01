import { Type } from "@sinclair/typebox";
import { formatTimestamp } from "../compaction.js";
import type { LcmContextEngine } from "../engine.js";
import type { RollupStore } from "../store/rollup-store.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const MAX_DEBUG_ROLLUPS = 100;

const LcmRollupDebugSchema = Type.Object({
  conversationId: Type.Optional(
    Type.Number({
      description: "Conversation ID. Defaults to current session.",
    })
  ),
  periodKind: Type.Optional(
    Type.Union(
      [Type.Literal("day"), Type.Literal("week"), Type.Literal("month")],
      {
        description: "Optional rollup period filter.",
      }
    )
  ),
  limit: Type.Optional(
    Type.Number({ description: "Maximum rollups to return. Defaults to 20." })
  ),
  includeSources: Type.Optional(
    Type.Boolean({ description: "Include rollup source IDs." })
  ),
});

function getLcmRollupStore(lcm: LcmContextEngine): RollupStore {
  const store = lcm.getRollupStore?.();
  if (store?.db) {
    return store;
  }
  throw new Error("LCM rollup database is unavailable.");
}

function formatValue(value: string | null, timezone: string): string {
  return value ? formatTimestamp(new Date(value), timezone) : "-";
}

export function createLcmRollupDebugTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_rollup_debug",
    label: "LCM Rollup Debug",
    description:
      "Inspect temporal rollup state, recent rollups, and provenance sources without LLM calls.",
    parameters: LcmRollupDebugSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const p = params as Record<string, unknown>;
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
      });
      if (
        conversationScope.allConversations ||
        conversationScope.conversationId == null
      ) {
        return jsonResult({
          error: "lcm_rollup_debug requires a single conversation scope.",
        });
      }

      const store = getLcmRollupStore(lcm);
      const conversationId = conversationScope.conversationId;
      const limit =
        typeof p.limit === "number" && Number.isFinite(p.limit) && p.limit > 0
          ? Math.min(Math.floor(p.limit), MAX_DEBUG_ROLLUPS)
          : 20;
      let periodKind: "day" | "week" | "month" | undefined;
      if (p.periodKind != null) {
        if (
          p.periodKind !== "day" &&
          p.periodKind !== "week" &&
          p.periodKind !== "month"
        ) {
          return jsonResult({
            error: 'periodKind must be one of "day", "week", or "month".',
          });
        }
        periodKind = p.periodKind;
      }
      const includeSources = p.includeSources === true;
      const state = store.getState(conversationId);
      const rollups = store.listRollups(conversationId, periodKind, limit);
      const timezone = state?.timezone || lcm.timezone;

      const lines = [`## LCM Rollup Debug: conversation ${conversationId}`, ""];
      lines.push("### State");
      if (!state) {
        lines.push("- No rollup state row.");
      } else {
        lines.push(`- timezone: ${state.timezone}`);
        lines.push(`- pending_rebuild: ${state.pending_rebuild}`);
        lines.push(
          `- last_message_at: ${formatValue(state.last_message_at, timezone)}`
        );
        lines.push(
          `- last_daily_build_at: ${formatValue(
            state.last_daily_build_at,
            timezone
          )}`
        );
        lines.push(
          `- last_weekly_build_at: ${formatValue(
            state.last_weekly_build_at,
            timezone
          )}`
        );
        lines.push(
          `- last_monthly_build_at: ${formatValue(
            state.last_monthly_build_at,
            timezone
          )}`
        );
      }
      lines.push("", "### Rollups");
      if (rollups.length === 0) {
        lines.push("- No rollups found.");
      }
      for (const rollup of rollups) {
        lines.push(
          `- ${rollup.period_kind}:${rollup.period_key} status=${rollup.status} tokens=${rollup.token_count}`
        );
        if (includeSources) {
          lines.push(`  - source summaries: ${rollup.source_summary_ids || "[]"}`);
          const sources = store.getRollupSources(rollup.rollup_id);
          lines.push(
            `  - provenance: ${
              sources
                .map((source) => `${source.source_type}:${source.source_id}`)
                .join(", ") || "none"
            }`
          );
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          conversationId,
          state,
          rollups: includeSources
            ? rollups
            : rollups.map((rollup) => {
                const { source_summary_ids: omitted, ...redacted } = rollup;
                void omitted;
                return redacted;
              }),
        },
      };
    },
  };
}
