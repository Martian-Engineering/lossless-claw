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

const MAX_RESULT_CHARS = 40_000; // ~10k tokens
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
  excludeSuppressed: Type.Optional(
    Type.Boolean({
      description:
        "If true (default), suppressed rows are excluded. Operator/admin tools may opt out by setting false; agent tools should leave the default.",
    }),
  ),
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
      "and a snippet for follow-up via lcm_expand or lcm_describe.",
    parameters: LcmSemanticRecallSchema,
    async execute(_toolCallId, params) {
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
      const excludeSuppressed =
        typeof p.excludeSuppressed === "boolean" ? p.excludeSuppressed : true;

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
          excludeSuppressed,
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
        lines.push("");

        let currentChars = lines.join("\n").length;

        if (result.hits.length === 0) {
          lines.push("No matches found.");
        } else {
          for (const hit of result.hits) {
            const snippet = truncateSnippet(hit.content);
            const distanceStr = hit.distance.toFixed(4);
            const line = `- [${hit.summaryId}] (${hit.kind}, distance=${distanceStr}, ${formatDisplayTime(hit.createdAt, timezone)}): ${snippet}`;
            if (currentChars + line.length > MAX_RESULT_CHARS) {
              lines.push("*(truncated — more results available)*");
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
            hits: result.hits.map((h) => ({
              summaryId: h.summaryId,
              conversationId: h.conversationId,
              sessionKey: h.sessionKey,
              kind: h.kind,
              distance: h.distance,
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
  };
}
