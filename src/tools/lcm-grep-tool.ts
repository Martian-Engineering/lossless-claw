import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const MAX_RESULT_CHARS = 40_000; // ~10k tokens

const LcmGrepSchema = Type.Object({
  pattern: Type.String({
    description:
      "Search pattern. Interpreted as regex when mode is 'regex', or as a text query for 'full_text' mode.",
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
        'Backwards-compatible scope selector. Accepts search scope ("messages" | "summaries" | "both") or memory scope ("current" | "agent").',
      enum: ["messages", "summaries", "both", "current", "agent"],
    }),
  ),
  searchScope: Type.Optional(
    Type.String({
      description:
        'What to search: "messages" for raw messages, "summaries" for compacted summaries, "both" for all. Default: "both".',
      enum: ["messages", "summaries", "both"],
    }),
  ),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to search within. If omitted, defaults to the current session conversation.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly search across all conversations. Ignored when conversationId is provided.",
    }),
  ),
  agentId: Type.Optional(
    Type.String({
      description:
        "Optional agent ID override for memory scope=agent. When omitted, inferred from sessionKey.",
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
});

function truncateSnippet(content: string, maxLen: number = 200): string {
  const singleLine = content.replace(/\n/g, " ").trim();
  if (singleLine.length <= maxLen) {
    return singleLine;
  }
  return singleLine.substring(0, maxLen - 3) + "...";
}

function parseGrepScopes(params: Record<string, unknown>): {
  searchScope: "messages" | "summaries" | "both";
  memoryScope: "current" | "agent";
} {
  const rawScope = typeof params.scope === "string" ? params.scope.trim() : "";
  const rawSearchScope = typeof params.searchScope === "string" ? params.searchScope.trim() : "";

  let searchScope: "messages" | "summaries" | "both" = "both";
  if (rawSearchScope === "messages" || rawSearchScope === "summaries" || rawSearchScope === "both") {
    searchScope = rawSearchScope;
  } else if (rawScope === "messages" || rawScope === "summaries" || rawScope === "both") {
    searchScope = rawScope;
  }

  const memoryScope: "current" | "agent" = rawScope === "agent" ? "agent" : "current";
  return { searchScope, memoryScope };
}

export function createLcmGrepTool(input: {
  deps: LcmDependencies;
  lcm: LcmContextEngine;
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
      "active context. Returns matching snippets with their summary/message IDs " +
      "for follow-up with lcm_expand or lcm_describe.",
    parameters: LcmGrepSchema,
    async execute(_toolCallId, params) {
      const retrieval = input.lcm.getRetrieval();

      const p = params as Record<string, unknown>;
      const pattern = (p.pattern as string).trim();
      const mode = (p.mode as "regex" | "full_text") ?? "regex";
      const { searchScope, memoryScope } = parseGrepScopes(p);
      const limit = typeof p.limit === "number" ? Math.trunc(p.limit) : 50;
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
        lcm: input.lcm,
        deps: input.deps,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        params: p,
        requestedScope: memoryScope,
      });
      if (
        !conversationScope.allConversations &&
        conversationScope.conversationId == null &&
        (!conversationScope.conversationIds || conversationScope.conversationIds.length === 0)
      ) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      const result = await retrieval.grep({
        query: pattern,
        mode,
        scope: searchScope,
        conversationId: conversationScope.conversationId,
        conversationIds: conversationScope.conversationIds,
        limit,
        since,
        before,
      });

      const lines: string[] = [];
      lines.push("## LCM Grep Results");
      lines.push(`**Pattern:** \`${pattern}\``);
      lines.push(`**Mode:** ${mode} | **Search scope:** ${searchScope}`);
      lines.push(`**Memory scope:** ${conversationScope.mode}`);
      if (conversationScope.allConversations) {
        lines.push("**Conversation scope:** all conversations");
      } else if (conversationScope.conversationIds && conversationScope.conversationIds.length > 0) {
        lines.push(
          `**Conversation scope:** ${conversationScope.conversationIds.length} conversation(s)`,
        );
      } else if (conversationScope.conversationId != null) {
        lines.push(`**Conversation scope:** ${conversationScope.conversationId}`);
      }
      if (conversationScope.agentId) {
        lines.push(`**Agent:** ${conversationScope.agentId}`);
      }
      if (conversationScope.warnings.length > 0) {
        lines.push(`**Warnings:** ${conversationScope.warnings.join(" | ")}`);
      }
      if (since || before) {
        lines.push(
          `**Time filter:** ${since ? `since ${since.toISOString()}` : "since -∞"} | ${
            before ? `before ${before.toISOString()}` : "before +∞"
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
          const line = `- [msg#${msg.messageId}] (${msg.role}, ${msg.createdAt.toISOString()}): ${snippet}`;
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
          const line = `- [${sum.summaryId}] (${sum.kind}, ${sum.createdAt.toISOString()}): ${snippet}`;
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
          scope: {
            mode: conversationScope.mode,
            conversationId: conversationScope.conversationId,
            conversationIds: conversationScope.conversationIds,
            agentId: conversationScope.agentId,
            warnings: conversationScope.warnings,
          },
          provenance: conversationScope.provenance,
        },
      };
    },
  };
}
