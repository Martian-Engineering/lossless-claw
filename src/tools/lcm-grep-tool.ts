import { Type } from "@sinclair/typebox";
import type { LcmContextEngine } from "../engine.js";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { parseIsoTimestampParam, resolveLcmConversationScope } from "./lcm-conversation-scope.js";
import { formatTimestamp } from "../compaction.js";
import {
  runHybridSearch,
  type FtsHit,
  type HybridHit,
} from "../embeddings/hybrid-search.js";
import { VoyageError } from "../voyage/client.js";

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
        'Search mode: "regex" for regular expression matching, "full_text" for text search, or "hybrid" to blend FTS + semantic vector search via Voyage rerank. "hybrid" returns hits scoped to summaries only (semantic doesn\'t cover raw messages); use it when keyword matches alone are too narrow. Default: "regex".',
      enum: ["regex", "full_text", "hybrid"],
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
      "Search compacted conversation history using regex, full-text, or hybrid search. " +
      "Searches across messages and/or summaries stored by LCM. " +
      "Use this to find specific content that may have been compacted away from " +
      "active context. In full_text mode, queries use FTS5 AND semantics by default, so keep them short and focused; quoted phrases stay intact and optional sort modes can prioritize relevance for older topics. " +
      "In hybrid mode, FTS + semantic vector search are blended via Voyage rerank — best for keyword + paraphrase coverage in one call. Hybrid hits are summaries only (no raw messages); for purely-semantic exploration prefer lcm_semantic_recall. Returns matching snippets with their summary/message IDs " +
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
      const mode = (p.mode as "regex" | "full_text" | "hybrid") ?? "regex";
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

      if (mode === "hybrid") {
        return runHybridLcmGrep({
          lcm,
          pattern,
          conversationScope,
          since,
          before,
          limit,
          timezone,
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

interface HybridGrepInput {
  lcm: LcmContextEngine;
  pattern: string;
  conversationScope: {
    conversationId?: number;
    conversationIds?: number[];
    allConversations: boolean;
  };
  since?: Date;
  before?: Date;
  limit: number;
  timezone: string;
}

/**
 * Hybrid lcm_grep path. Routes pattern → runHybridSearch (FTS arm calls
 * summaryStore.searchSummaries, which we hydrate via the same db
 * connection to get content + sessionKey + tokenCount + createdAt).
 *
 * Output format mirrors the regex/full_text branch but with hybrid-
 * specific extras: per-hit provenance flags ([from FTS+semantic],
 * [from FTS only], [from semantic only]), the rerank/RRF score, and
 * degraded-mode warnings when vec0 or rerank is unavailable.
 */
async function runHybridLcmGrep(input: HybridGrepInput) {
  const { lcm, pattern, conversationScope, since, before, limit, timezone } = input;
  const summaryStore = lcm.getSummaryStore();
  const db = lcm.getDb();

  const hydrateRowsById = (summaryIds: string[]) => {
    if (summaryIds.length === 0) return new Map<string, {
      sessionKey: string;
      content: string;
      tokenCount: number;
      createdAt: string;
      kind: "leaf" | "condensed";
      conversationId: number;
    }>();
    const placeholders = summaryIds.map(() => "?").join(",");
    const rows = db
      .prepare(
        // v4.1 §10 + Group C Finding #5 (defense in depth): hydrate
        // step also filters suppressed_at IS NULL. Source FTS already
        // filters this (C.03), but a row could be suppressed BETWEEN
        // FTS query and hydrate. This guarantees the hybrid surface
        // never returns content for a suppressed row even under that
        // race.
        `SELECT summary_id, conversation_id, session_key, kind, content, token_count, created_at
           FROM summaries
           WHERE summary_id IN (${placeholders})
             AND suppressed_at IS NULL`,
      )
      .all(...summaryIds) as Array<{
      summary_id: string;
      conversation_id: number;
      session_key: string;
      kind: "leaf" | "condensed";
      content: string;
      token_count: number;
      created_at: string;
    }>;
    return new Map(
      rows.map(
        (r) =>
          [
            r.summary_id,
            {
              sessionKey: r.session_key,
              content: r.content,
              tokenCount: r.token_count,
              createdAt: r.created_at,
              kind: r.kind,
              conversationId: r.conversation_id,
            },
          ] as const,
      ),
    );
  };

  const ftsSearch = async (args: {
    sessionKeys?: string[];
    conversationIds?: number[];
    since?: Date;
    before?: Date;
    summaryKinds?: Array<"leaf" | "condensed">;
    excludeSuppressed?: boolean;
    limit: number;
  }): Promise<FtsHit[]> => {
    const ftsResults = await summaryStore.searchSummaries({
      query: pattern,
      mode: "full_text",
      conversationId: conversationScope.allConversations
        ? undefined
        : conversationScope.conversationId,
      conversationIds: conversationScope.allConversations
        ? undefined
        : conversationScope.conversationIds,
      since: args.since,
      before: args.before,
      limit: args.limit,
      sort: "relevance",
    });
    if (ftsResults.length === 0) return [];
    const hydrated = hydrateRowsById(ftsResults.map((r) => r.summaryId));
    const out: FtsHit[] = [];
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i];
      const row = hydrated.get(r.summaryId);
      if (!row) continue; // suppressed/deleted between FTS and hydrate — drop
      out.push({
        summaryId: r.summaryId,
        conversationId: row.conversationId,
        sessionKey: row.sessionKey,
        kind: row.kind,
        content: row.content,
        tokenCount: row.tokenCount,
        createdAt: row.createdAt,
        rank: i,
      });
    }
    return out;
  };

  const conversationIds = conversationScope.allConversations
    ? undefined
    : conversationScope.conversationIds && conversationScope.conversationIds.length > 0
      ? conversationScope.conversationIds
      : conversationScope.conversationId != null
        ? [conversationScope.conversationId]
        : undefined;

  let hybridResult;
  try {
    hybridResult = await runHybridSearch(db, {
      query: pattern,
      kFts: Math.max(limit, 50),
      kSemantic: Math.max(limit, 50),
      topN: limit,
      conversationIds,
      since,
      before,
      ftsSearch,
      // Final review Finding #2: cap Voyage wall-time on agent hot path.
      // Embed call + rerank call each capped at 15s × 1 retry ≈ 30s
      // worst case per call. Default Voyage client (3×60s) would block
      // agent turn for minutes if Voyage throttles.
      voyageMaxRetries: 1,
      voyageTimeoutMs: 15_000,
    });
  } catch (error) {
    if (error instanceof VoyageError && error.kind === "auth") {
      return jsonResult({
        error:
          "Voyage API key is missing or invalid (set VOYAGE_API_KEY) — hybrid mode requires it. Use mode='full_text' for keyword-only search.",
        detail: error.message,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    if (/VOYAGE_API_KEY/i.test(message)) {
      return jsonResult({
        error:
          "Voyage API key is missing (set VOYAGE_API_KEY) — hybrid mode requires it. Use mode='full_text' for keyword-only search.",
        detail: message,
      });
    }
    return jsonResult({
      error: `Hybrid search failed: ${message}`,
    });
  }

  const lines: string[] = [];
  lines.push("## LCM Grep Results");
  lines.push(`**Pattern:** \`${pattern}\``);
  lines.push(`**Mode:** hybrid`);
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
  lines.push(`**Total matches:** ${hybridResult.hits.length}`);
  if (hybridResult.degradedToFtsOnly) {
    lines.push("*(semantic search unavailable; degraded to FTS-only)*");
  }
  if (hybridResult.degradedSkippedRerank) {
    lines.push("*(rerank failed; using RRF fusion fallback)*");
  }
  lines.push("");

  let currentChars = lines.join("\n").length;

  if (hybridResult.hits.length > 0) {
    lines.push("### Summaries");
    lines.push("");
    for (const hit of hybridResult.hits) {
      const provenance = hitProvenanceTag(hit);
      const snippet = truncateSnippet(hit.content);
      const score = hit.score.toFixed(4);
      const line = `- [${hit.summaryId}] ${provenance} (${hit.kind}, score=${score}, ${formatDisplayTime(hit.createdAt, timezone)}): ${snippet}`;
      if (currentChars + line.length > MAX_RESULT_CHARS) {
        lines.push("*(truncated — more results available)*");
        break;
      }
      lines.push(line);
      currentChars += line.length;
    }
    lines.push("");
  } else {
    lines.push("No matches found.");
  }

  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: {
      mode: "hybrid",
      messageCount: 0,
      summaryCount: hybridResult.hits.length,
      totalMatches: hybridResult.hits.length,
      candidateCount: hybridResult.candidateCount,
      voyageTokensConsumed: hybridResult.voyageTokensConsumed,
      degradedToFtsOnly: hybridResult.degradedToFtsOnly,
      degradedSkippedRerank: hybridResult.degradedSkippedRerank,
      modelName: hybridResult.modelName,
      hits: hybridResult.hits.map((h) => ({
        summaryId: h.summaryId,
        conversationId: h.conversationId,
        sessionKey: h.sessionKey,
        kind: h.kind,
        score: h.score,
        fromFts: h.fromFts,
        fromSemantic: h.fromSemantic,
        semanticDistance: h.semanticDistance,
        ftsRank: h.ftsRank,
      })),
    },
  };
}

function hitProvenanceTag(hit: HybridHit): string {
  if (hit.fromFts && hit.fromSemantic) return "[from FTS+semantic]";
  if (hit.fromFts) return "[from FTS only]";
  return "[from semantic only]";
}
