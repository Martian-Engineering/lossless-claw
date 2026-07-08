import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";
import { DEFAULT_LARGE_FILE_SEARCH_MAX_BYTES } from "../store/summary-store.js";

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
      'Search pattern. Interpreted as regex when mode is "regex", or as an FTS5 text query when mode is "full_text". In full_text mode, FTS5 defaults to AND matching, so prefer 1-3 distinctive terms or one quoted multi-word phrase instead of padding with synonyms or extra keywords. Regex syntax such as alternation (`A|B`) requires regex mode.',
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
        'What to search: "messages" for raw messages, "summaries" for compacted summaries, "both" for all, or "files" for the bounded prefix of externalized large file contents. Default: "both".',
      enum: ["messages", "summaries", "both", "files"],
    }),
  ),
  fileIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        'Optional list of file_xxx IDs to restrict the search to when scope="files". If omitted, large files in the conversation scope are searched, scanning up to 512000 bytes per file.',
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

// Identify clear regex syntax that is likely to make an FTS5 query silently
// miss. This intentionally stays conservative instead of becoming a parser.
function findRegexSyntaxInFullTextQuery(pattern: string): string | null {
  let inQuote = false;
  let escaped = false;

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (escaped) {
      escaped = false;
      if (!inQuote && char && /[bBdDsSwW]/.test(char)) {
        return "regex character escape";
      }
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) {
      continue;
    }
    if (char === "|") {
      return "alternation";
    }
    if (char === "." && (next === "*" || next === "+" || next === "?")) {
      return "wildcard";
    }
    if (char === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing > index + 1) {
        return "character class";
      }
    }
    if (char === "^" && (index === 0 || /\s/.test(pattern[index - 1] ?? ""))) {
      return "anchor";
    }
    if (char === "$" && (index === pattern.length - 1 || /\s/.test(next ?? ""))) {
      return "anchor";
    }
  }

  return null;
}

function validateFullTextPattern(pattern: string): string | null {
  const syntax = findRegexSyntaxInFullTextQuery(pattern);
  if (!syntax) {
    return null;
  }
  return `full_text mode does not support regex syntax (${syntax}). Use mode: "regex" for \`${pattern}\`, or rewrite the full_text query as 1-3 literal terms or one quoted phrase.`;
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
      "Search compacted conversation history or externalized file contents using regex or full-text search. " +
      "Searches across messages, summaries, and/or a bounded prefix of large files stored by LCM. " +
      "Use this to find specific content that may have been compacted away from " +
      "active context, or to search within the first 512000 bytes of externalized files " +
      "(scope='files') when a previous lcm_describe result was truncated. " +
      "In full_text mode, queries use FTS5 AND semantics by default, so keep them short and focused; quoted phrases stay intact and optional sort modes can prioritize relevance for older topics. Returns matching snippets with their summary/message/file IDs " +
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
      const scope = (p.scope as "messages" | "summaries" | "both" | "files") ?? "both";
      const fileIds = Array.isArray(p.fileIds)
        ? p.fileIds.filter((id): id is string => typeof id === "string")
        : undefined;
      const limit = typeof p.limit === "number" ? Math.trunc(p.limit) : 50;
      const requestedSort = (p.sort as "recency" | "relevance" | "hybrid") ?? "recency";
      const effectiveSort = mode === "full_text" ? requestedSort : "recency";
      if (mode === "full_text") {
        const fullTextPatternError = validateFullTextPattern(pattern);
        if (fullTextPatternError) {
          return jsonResult({ error: fullTextPatternError });
        }
      }
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
      if (conversationScope.error) {
        return jsonResult({ error: conversationScope.error });
      }
      if (
        !conversationScope.allConversations
        && conversationScope.conversationId == null
        && (conversationScope.conversationIds?.length ?? 0) === 0
      ) {
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
        fileIds,
        limit,
        since,
        before,
        sort: effectiveSort,
        largeFilesDir: lcm.configView?.largeFilesDir,
        allConversations: conversationScope.allConversations,
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
      if (scope === "files") {
        lines.push(
          `**File scan:** first ${DEFAULT_LARGE_FILE_SEARCH_MAX_BYTES.toLocaleString()} bytes per file; matches beyond that prefix are not searched.`,
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
          const line = `- [conv=${msg.conversationId} msg#${msg.messageId}] (${msg.role}, ${formatDisplayTime(msg.createdAt, timezone)}): ${snippet}`;
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
          const line = `- [conv=${sum.conversationId} ${sum.summaryId}] (${sum.kind}, ${formatDisplayTime(sum.createdAt, timezone)}): ${snippet}`;
          if (currentChars + line.length > MAX_RESULT_CHARS) {
            lines.push("*(truncated — more results available)*");
            break;
          }
          lines.push(line);
          currentChars += line.length;
        }
        lines.push("");
      }

      const files = result.files ?? [];

      if (files.length > 0) {
        lines.push("### Files");
        lines.push("");
        for (const file of files) {
          const snippet = truncateSnippet(file.snippet);
          const nameSuffix = file.fileName ? ` (${file.fileName})` : "";
          const truncationSuffix = file.scanTruncated ? " (file scan truncated)" : "";
          const line = `- [conv=${file.conversationId} ${file.fileId}${nameSuffix}] line ${file.lineNumber}, offset ${file.byteOffset}: \`${file.matchedText}\` ${snippet}${truncationSuffix}`;
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
          fileCount: files.length,
          ...(scope === "files"
            ? { fileScanByteLimit: DEFAULT_LARGE_FILE_SEARCH_MAX_BYTES }
            : {}),
          totalMatches: result.totalMatches,
        },
      };
    },
  };
}
