import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";

const MAX_RESULT_CHARS = 40_000; // ~10k tokens

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

const LcmGrepSchema = Type.Object({
  pattern: Type.String({
    description:
      'Search pattern. Interpreted as regex when mode is "regex", or as an FTS5 text query when mode is "full_text". In full_text mode, FTS5 defaults to AND matching, so prefer 1-3 distinctive terms or one quoted multi-word phrase instead of padding with synonyms or extra keywords.',
  }),
  mode: Type.Optional(
    Type.String({
      description:
        'Search mode: "regex" for regular expression matching, "full_text" for text search. Default: "regex".',
      enum: ["regex", "full_text"],
    }),
  ),
  scope: Type.Optional(
    Type.String({
      description:
        'What to search: "messages" for raw messages, "summaries" for compacted summaries, "both" for all. Default: "both".',
      enum: ["messages", "summaries", "both"],
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Physical conversation ID to search within. If omitted, defaults to the current session family.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly search across all conversations. Ignored when conversationId is provided.",
    }),
  ),
  since: Type.Optional(
    Type.String({
      description: "Only return matches created at or after this ISO timestamp.",
    }),
  ),
  before: Type.Optional(
    Type.String({
      description: "Only return matches created before this ISO timestamp.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Maximum number of results to return (default: 50).",
      minimum: 1,
      maximum: 200,
    }),
  ),
  sort: Type.Optional(
    Type.String({
      description:
        'Sort order: "recency" (newest first, default), "relevance" (best FTS5 match first, full_text mode only), or "hybrid" (full_text mode only; balances relevance with recency). Applied before limit is enforced.',
      enum: ["recency", "relevance", "hybrid"],
    }),
  ),
});

function truncateSnippet(content: string, maxLen: number = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.substring(0, maxLen - 3) + "...";
}

export function createLcmGrepTool(input: {
  deps: LcmDependencies;
  lcm?: LcmContextEngine;
  getLcm?: () => Promise<LcmContextEngine>;
  sessionId?: string;
  sessionKey?: string;
}): AnyAgentTool {
  return {
    name: "lcm_grep",
    label: "LCM Grep",
    description:
      "Search compacted conversation history using regex or full-text search. " +
      "Searches across messages and/or summaries stored by LCM. " +
      "Use this to find specific content that may have been compacted away from " +
      "active context. In full_text mode, queries use FTS5 AND semantics by default, so keep them short and focused; quoted phrases stay intact and optional sort modes can prioritize relevance for older topics. Returns matching snippets with their summary/message IDs " +
      "for follow-up with lcm_expand or lcm_describe.",
    parameters: LcmGrepSchema,
    async execute(_toolCallId, params) {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const retrieval = lcm.getRetrieval();
      const timezone = lcm.timezone;

      const p = params as Record<string, unknown>;
      const pattern = (p.pattern as string).trim();
      const mode = (p.mode as "regex" | "full_text") ?? "regex";
      const scope = (p.scope as "messages" | "summaries" | "both") ?? "both";
      const limit = typeof p.limit === "number" ? Math.trunc(p.limit) : 50;
      const requestedSort = (p.sort as "recency" | "relevance" | "hybrid") ?? "recency";
      const effectiveSort = mode === "full_text" ? requestedSort : "recency";
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
      const result = await retrieval.grep({
        query: pattern,
        mode,
        scope,
        conversationId: conversationScope.conversationId,
        conversationIds: conversationScope.conversationIds,
        limit,
        since,
        before,
        sort: effectiveSort,
      });

      const lines: string[] = [];
      lines.push("## LCM Grep Results");
      lines.push(`**Pattern:** \`${pattern}\``);
      lines.push(`**Mode:** ${mode} | **Scope:** ${scope} | **Sort:** ${effectiveSort}`);
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
      lines.push(`**Total matches:** ${result.totalMatches}`);
      lines.push("");

      let currentChars = lines.join("\n").length;

      if (result.messages.length > 0) {
        lines.push("### Messages");
        lines.push("");
        for (const msg of result.messages) {
          const snippet = truncateSnippet(msg.snippet);
          const line = `- [msg#${msg.messageId}] (${msg.role}, ${formatDisplayTime(msg.createdAt, timezone)}): ${snippet}`;
          if (currentChars + line.length > MAX_RESULT_CHARS) {
            lines.push("*(truncated — more results available)*");
            break;
          }
          lines.push(line);
          currentChars += line.length;
        }
        lines.push("");
      }

      if (result.summaries.length > 0) {
        lines.push("### Summaries");
        lines.push("");
        for (const sum of result.summaries) {
          const snippet = truncateSnippet(sum.snippet);
          const line = `- [${sum.summaryId}] (${sum.kind}, ${formatDisplayTime(sum.createdAt, timezone)}): ${snippet}`;
          if (currentChars + line.length > MAX_RESULT_CHARS) {
            lines.push("*(truncated — more results available)*");
            break;
          }
          lines.push(line);
          currentChars += line.length;
        }
        lines.push("");
      }

      if (result.totalMatches === 0) {
        lines.push("No matches found.");
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: {
          messageCount: result.messages.length,
          summaryCount: result.summaries.length,
          totalMatches: result.totalMatches,
        },
      };
    },
  };
}
