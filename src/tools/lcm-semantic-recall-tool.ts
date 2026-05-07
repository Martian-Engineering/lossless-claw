import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import {
  runSemanticSearch,
  SemanticSearchUnavailableError,
} from "../embeddings/semantic-search.js";
import { VoyageError } from "../voyage/client.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";
import { runWithTokenGate } from "../plugin/needs-compact-gate.js";

// Tool-result hard cap — see lcm-grep-tool.ts for env contract
// (LCM_TOOL_RESULT_TOKEN_BUDGET; default 10K tokens / 40K chars).
function resolveMaxResultChars(): number {
  const raw = process.env.LCM_TOOL_RESULT_TOKEN_BUDGET?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  const tokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 10_000;
  return Math.max(2_000, tokens) * 4;
}
const MAX_RESULT_CHARS = resolveMaxResultChars();
const DEFAULT_LIMIT = 20;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

function formatDisplayTime(
  value: Date | string | number | null | undefined,
  timezone: string,
): string {
  if (value == null) {
    return "-";
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return formatTimestamp(date, timezone);
}

function truncateSnippet(content: string, maxLen = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.substring(0, maxLen - 3) + "...";
}

const LcmSemanticRecallSchema = Type.Object({
  query: Type.String({
    description:
      "Natural-language query for semantic search. Use this for paraphrastic / conceptual queries that exact-match FTS would miss (e.g. \"how did we decide to handle the auth race?\"). For keyword + semantic blending prefer lcm_grep mode='hybrid'.",
  }),
  limit: Type.Optional(
    Type.Number({
      description: `Max hits to return (default: ${DEFAULT_LIMIT}; range ${MIN_LIMIT}-${MAX_LIMIT}).`,
      minimum: MIN_LIMIT,
      maximum: MAX_LIMIT,
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Physical conversation ID to scope search to. If omitted, defaults to the current session family.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to search across all conversations. Ignored when conversationId is provided.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "Only return summaries created at or after this ISO timestamp.",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description: "Only return summaries created before this ISO timestamp.",
    }),
  ),
  summaryKinds: Type.Optional(
    Type.Array(
      Type.String({ enum: ["leaf", "condensed"] }),
      {
        description:
          "Filter by summary kind. Defaults to both 'leaf' and 'condensed'.",
      },
    ),
  ),
  // v4.1 §10 + Group C adversarial Finding #2: excludeSuppressed is no
  // longer exposed as an agent param. Agents must NOT see suppressed
  // content via this surface — operator opt-out lives in /lcm purge
  // and operator-only tools (Group F), not in agent tool params.
});

function readSummaryKinds(value: unknown): Array<"leaf" | "condensed"> | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const out: Array<"leaf" | "condensed"> = [];
  for (const item of value) {
    if (item === "leaf" || item === "condensed") {
      out.push(item);
    }
  }
  return out.length > 0 ? out : undefined;
}

export function createLcmSemanticRecallTool(input: {
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
    name: "lcm_semantic_recall",
    label: "LCM Semantic Recall",
    description:
      "Search compacted conversation history with vector-based semantic retrieval. " +
      "Use this for paraphrastic / conceptual queries that exact-match FTS misses " +
      "(e.g. asking \"what did we decide about the embedding fallback path?\" when " +
      "the original wording was different). For keyword + semantic blending, prefer " +
      "lcm_grep with mode='hybrid'; reserve lcm_semantic_recall for purely semantic " +
      "exploration. Returns ranked summary hits with [summary_id], kind, distance, " +
      "and a snippet for follow-up via lcm_describe (one-hop) or lcm_expand_query (multi-hop). " +
      "Tool result is hard-capped at LCM_TOOL_RESULT_TOKEN_BUDGET (default 10K tokens / 40K chars) — when context is near full, prefer smaller `limit` over big sweeps; chained tool calls accumulate context, and compaction only fires post-turn.",
    parameters: LcmSemanticRecallSchema,
    async execute(_toolCallId, params) {
      return runWithTokenGate({
        toolName: "lcm_semantic_recall",
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

      const rawQuery = typeof p.query === "string" ? p.query.trim() : "";
      if (rawQuery.length === 0) {
        return jsonResult({
          error: "`query` is required and must be a non-empty string.",
        });
      }

      const limit =
        typeof p.limit === "number" && Number.isFinite(p.limit)
          ? Math.max(MIN_LIMIT, Math.min(MAX_LIMIT, Math.trunc(p.limit)))
          : DEFAULT_LIMIT;

      let since: Date | undefined;
      let before: Date | undefined;
      try {
        since = parseIsoTimestampParam(p, "since");
        before = parseIsoTimestampParam(p, "before");
      } catch (error) {
        return jsonResult({
          error: error instanceof Error ? error.message : "Invalid timestamp filter.",
        });
      }
      if (since && before && since.getTime() >= before.getTime()) {
        return jsonResult({
          error: "`since` must be earlier than `before`.",
        });
      }

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

      const summaryKinds = readSummaryKinds(p.summaryKinds);

      const conversationIds = conversationScope.allConversations
        ? undefined
        : conversationScope.conversationIds && conversationScope.conversationIds.length > 0
          ? conversationScope.conversationIds
          : conversationScope.conversationId != null
            ? [conversationScope.conversationId]
            : undefined;

      const db = lcm.getDb();

      try {
        const result = await runSemanticSearch(db, {
          query: rawQuery,
          k: limit,
          conversationIds,
          since,
          before,
          summaryKinds,
          // v4.1 §10 + Group C Finding #2: hardcoded true. Agent surface
          // never sees suppressed; operator opt-out is via separate
          // operator tools (Group F).
          excludeSuppressed: true,
          // Final review Finding #2: cap Voyage wall-time budget on agent
          // hot path. Default Voyage client uses 3 retries × 60s = up to
          // ~244s — would block the agent's turn for minutes if Voyage
          // hangs/throttles. 1 retry × 15s ≈ 30s worst case (15s + 0.5s
          // backoff + 15s).
          voyageMaxRetries: 1,
          voyageTimeoutMs: 15_000,
        });

        const lines: string[] = [];
        lines.push("## LCM Semantic Recall Results");
        lines.push(`**Query:** \`${rawQuery}\``);
        if (conversationScope.allConversations) {
          lines.push("**Conversation scope:** all conversations");
        } else if (conversationScope.conversationId != null) {
          const familyCount = conversationScope.conversationIds?.length ?? 0;
          lines.push(
            familyCount > 1
              ? `**Conversation scope:** session family rooted at ${conversationScope.conversationId} (${familyCount} segments)`
              : `**Conversation scope:** ${conversationScope.conversationId}`,
          );
        }
        if (since || before) {
          lines.push(
            `**Time filter:** ${since ? `since ${formatDisplayTime(since, timezone)}` : "since -∞"} | ${
              before ? `before ${formatDisplayTime(before, timezone)}` : "before +∞"
            }`,
          );
        }
        lines.push(`**Model:** ${result.modelName}`);
        lines.push(`**Total hits:** ${result.hits.length}`);

        // P3 confidence band — derived from cosine similarity (Voyage = unit
        // vectors; cos = 1 - L²/2). Bands (calibrated per harness 2026-05-06):
        //   high  ≥ 0.65 — strong match, agent can cite directly
        //   med   ≥ 0.50 — likely related, verify with describe before citing
        //   low   ≥ 0.35 — weak match, more probably noise than signal
        //   noise <  0.35 — almost certainly not the answer
        // We emit the BAND OF THE TOP HIT so agents can adjust their confidence
        // before treating the top result as the answer.
        const topCos = result.hits[0]?.cosineSimilarity ?? -1;
        const confidenceBand =
          result.hits.length === 0
            ? "no-match"
            : topCos >= 0.65
              ? "high"
              : topCos >= 0.5
                ? "medium"
                : topCos >= 0.35
                  ? "low"
                  : "noise";
        if (result.hits.length > 0) {
          lines.push(
            `**Confidence (top hit):** ${confidenceBand} (cosine=${topCos.toFixed(3)})`,
          );
        }
        lines.push("");

        let currentChars = lines.join("\n").length;

        if (result.hits.length === 0) {
          lines.push("No matches found.");
        } else {
          if (confidenceBand === "low" || confidenceBand === "noise") {
            lines.push(
              `*Note: top-hit cosine ${topCos.toFixed(3)} is below the medium-confidence threshold (0.5). Treat results as candidates, not answers — verify with lcm_describe / lcm_grep verbatim.*`,
            );
            lines.push("");
          }
          for (const hit of result.hits) {
            const snippet = truncateSnippet(hit.content);
            const cosStr = hit.cosineSimilarity.toFixed(3);
            const line = `- [${hit.summaryId}] (${hit.kind}, cosine=${cosStr}, ${formatDisplayTime(hit.createdAt, timezone)}): ${snippet}`;
            if (currentChars + line.length > MAX_RESULT_CHARS) {
              lines.push(`*(truncated at ~${Math.round(MAX_RESULT_CHARS / 4)} tokens to protect agent context — narrow query, lower limit, or wait for next-turn compaction; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`);
              break;
            }
            lines.push(line);
            currentChars += line.length;
          }
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: {
            modelName: result.modelName,
            candidateCount: result.candidateCount,
            voyageTokensConsumed: result.voyageTokensConsumed,
            hitCount: result.hits.length,
            confidenceBand,
            hits: result.hits.map((h) => ({
              summaryId: h.summaryId,
              conversationId: h.conversationId,
              sessionKey: h.sessionKey,
              kind: h.kind,
              distance: h.distance,
              cosineSimilarity: h.cosineSimilarity,
              tokenCount: h.tokenCount,
              createdAt: h.createdAt,
            })),
          },
        };
      } catch (error) {
        if (error instanceof SemanticSearchUnavailableError) {
          return jsonResult({
            error:
              "Semantic search is unavailable (sqlite-vec / vec0 not loaded or no active embedding model). Use lcm_grep instead.",
            detail: error.message,
          });
        }
        if (error instanceof VoyageError) {
          if (error.kind === "auth") {
            return jsonResult({
              error:
                "Voyage API key is missing or invalid (set VOYAGE_API_KEY). Use lcm_grep for keyword search in the meantime.",
              detail: error.message,
            });
          }
          return jsonResult({
            error: `Voyage embed call failed (${error.kind}). Try again or fall back to lcm_grep.`,
            detail: error.message,
          });
        }
        const message = error instanceof Error ? error.message : String(error);
        if (/VOYAGE_API_KEY/i.test(message)) {
          return jsonResult({
            error:
              "Voyage API key is missing (set VOYAGE_API_KEY). Use lcm_grep for keyword search in the meantime.",
            detail: message,
          });
        }
        return jsonResult({
          error: `Semantic search failed: ${message}`,
        });
      }
        },
      });
    },
  };
}
