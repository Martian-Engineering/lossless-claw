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
import {
  runSemanticSearch,
  SemanticSearchUnavailableError,
} from "../embeddings/semantic-search.js";
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
        'Search mode: "regex" for regular expression matching, "full_text" for text search, "hybrid" to blend FTS + semantic vector search via Voyage rerank, "semantic" for pure-vector recall (no FTS, no rerank — cheapest semantic mode), or "verbatim" to return FULL untruncated content of matched messages (for citation / quote-back use cases where the agent needs literal wording). "hybrid" and "semantic" return hits scoped to summaries only (semantic doesn\'t cover raw messages); "verbatim" returns full message rows and is hard-capped at 20 results. Default: "regex".',
      enum: ["regex", "full_text", "hybrid", "semantic", "verbatim"],
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
  // P6 fix (2026-05-06 harness): in verbatim mode, the 20-result cap was
  // saturating with tool-role messages (code grep output, audit blobs) on
  // common queries, crowding out the user/assistant turns the agent
  // actually wants to quote. `role` filters at the SQL layer.
  // Audit 2 finding #2 fix: include 'system' in the enum since system
  // messages exist in the messages table (toDbRole writes them).
  role: Type.Optional(
    Type.String({
      description:
        'Restrict matches to messages of this role. Useful in verbatim mode where tool-role messages (code grep output, audit blobs) often crowd out user/assistant turns. Accepts "user", "assistant", "tool", "system", or "all" (default). Honored only by mode="verbatim" — other modes already match summaries that have no role.',
      enum: ["user", "assistant", "tool", "system", "all"],
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

/**
 * P7 fix (2026-05-06 harness): FTS5 MATCH chokes on bare non-tokenizer
 * characters in user input (`v4.1`, `[brackets]`, hyphenated terms,
 * leading/trailing operators). Users hit opaque "fts5: syntax error" with
 * no recovery hint.
 *
 * Strategy: detect patterns that FTS5 would reject AS-IS, and auto-wrap
 * them in double quotes (FTS5 phrase syntax — literal multi-token match).
 * Leave already-quoted patterns alone (user explicitly opted-in to FTS5
 * phrase semantics) AND leave patterns containing FTS5 boolean operators
 * alone (`AND`, `OR`, `NEAR(...)`).
 *
 * For verbatim mode this is always-on because verbatim is by definition
 * "I want literal text." For full_text mode this is opt-in via the existing
 * convention: if your pattern looks like an FTS5 query (uppercase boolean
 * operators, parens), we leave it; otherwise we sanitize.
 *
 * Returns the (possibly transformed) pattern.
 */
function sanitizeFts5Pattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (trimmed.length === 0) return trimmed;
  // Already double-quoted phrase — user knows what they're doing.
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return trimmed;
  }
  // Contains FTS5 boolean operators or grouping — assume user knows FTS5.
  // Match \bAND\b / \bOR\b / \bNOT\b / \bNEAR\b / opening paren.
  if (/\b(?:AND|OR|NOT|NEAR)\b/.test(trimmed) || /[()]/.test(trimmed)) {
    return trimmed;
  }
  // Detect chars FTS5 default tokenizer treats as separators or operators
  // when present BARE (not inside a phrase): `.` `[` `]` `-` (leading/trailing)
  // `+` `*` `^` `:` `/` `\\`.
  const HAS_PROBLEM_CHAR = /[.\[\]+*^:\/\\!~]/;
  const STARTS_OR_ENDS_WITH_HYPHEN = /^-|-$/;
  if (HAS_PROBLEM_CHAR.test(trimmed) || STARTS_OR_ENDS_WITH_HYPHEN.test(trimmed)) {
    // Wrap as a phrase. Escape internal double quotes by doubling them
    // (FTS5's escape convention).
    const escaped = trimmed.replace(/"/g, '""');
    return `"${escaped}"`;
  }
  return trimmed;
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
      const mode =
        (p.mode as "regex" | "full_text" | "hybrid" | "semantic" | "verbatim") ?? "regex";
      const scope = (p.scope as "messages" | "summaries" | "both") ?? "both";
      // verbatim mode is hard-capped to 20 (full message rows can be large)
      const VERBATIM_HARD_CAP = 20;
      const requestedLimit = typeof p.limit === "number" ? Math.trunc(p.limit) : 50;
      const limit =
        mode === "verbatim" ? Math.min(requestedLimit, VERBATIM_HARD_CAP) : requestedLimit;
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

      if (mode === "semantic") {
        return runSemanticLcmGrep({
          lcm,
          pattern,
          conversationScope,
          since,
          before,
          limit,
          timezone,
        });
      }

      if (mode === "verbatim") {
        const roleFilterRaw =
          typeof p.role === "string" ? p.role.trim() : undefined;
        const roleFilter =
          roleFilterRaw && roleFilterRaw !== "all" ? roleFilterRaw : undefined;
        return runVerbatimLcmGrep({
          lcm,
          pattern,
          conversationScope,
          since,
          before,
          limit,
          timezone,
          roleFilter,
        });
      }

      // P7 fix (revisited per audit 2 finding #1): the full_text mode goes
      // through retrieval.grep → conversation-store / summary-store, which
      // already apply sanitizeFts5Query (src/store/fts5-sanitize.ts). That
      // sanitizer correctly tokenizes-and-quotes problematic chars. Adding
      // OUR sanitizer here was redundant and risked double-quoting.
      // verbatim mode has its own SQL path that bypasses the store's
      // sanitizer, so sanitize is applied there (in runVerbatimLcmGrep).
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
  // P6 fix: optional role filter, honored only by verbatim mode (other
  // paths run on summaries which have no role).
  roleFilter?: string;
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

/**
 * Semantic-only lcm_grep path. Pure embedding KNN via runSemanticSearch
 * (no rerank — that's the cost-profile distinction from mode='hybrid').
 *
 * Use case: "find me everything similar to X across all of time" without
 * paying the rerank cost. Hits are summaries only (semantic doesn't cover
 * raw messages — embeddedKinds defaults to ['summary']).
 */
async function runSemanticLcmGrep(input: HybridGrepInput) {
  const { lcm, pattern, conversationScope, since, before, limit, timezone } = input;
  const db = lcm.getDb();

  let semResult;
  try {
    const sessionKeys = conversationScope.allConversations
      ? undefined
      : conversationScope.conversationIds && conversationScope.conversationIds.length > 0
        ? deriveSessionKeysFromConversationIds(db, conversationScope.conversationIds)
        : conversationScope.conversationId != null
          ? deriveSessionKeysFromConversationIds(db, [conversationScope.conversationId])
          : undefined;
    semResult = await runSemanticSearch(db, {
      query: pattern,
      sessionKeys,
      k: limit,
      since,
      before,
      embeddedKinds: ["summary"],
      excludeSuppressed: true,
    });
  } catch (e: unknown) {
    if (e instanceof SemanticSearchUnavailableError) {
      return jsonResult({
        error:
          "Semantic search unavailable: vec0 extension not loaded or no embedding profile registered. Use mode='regex' or mode='full_text' instead.",
      });
    }
    if (e instanceof VoyageError && e.kind === "auth") {
      return jsonResult({
        error:
          "Voyage API key is missing or invalid (set VOYAGE_API_KEY) — semantic mode requires it. Use mode='regex' or mode='full_text' instead.",
      });
    }
    throw e;
  }

  const lines: string[] = [];
  lines.push("## LCM Grep Results");
  lines.push(`**Pattern:** \`${pattern}\``);
  lines.push(`**Mode:** semantic | **Scope:** summaries (semantic doesn't index raw messages)`);
  if (conversationScope.allConversations) {
    lines.push("**Conversation scope:** all conversations");
  } else if (conversationScope.conversationId != null) {
    lines.push(`**Conversation scope:** ${conversationScope.conversationId}`);
  }
  if (since || before) {
    lines.push(
      `**Time filter:** ${since ? `since ${formatDisplayTime(since, timezone)}` : "since -∞"} | ${
        before ? `before ${formatDisplayTime(before, timezone)}` : "before +∞"
      }`,
    );
  }
  lines.push(`**Total matches:** ${semResult.hits.length}`);
  lines.push(`**Voyage tokens consumed:** ${semResult.voyageTokensConsumed}`);
  lines.push(`**Model:** ${semResult.modelName ?? "unknown"}`);
  lines.push("");

  if (semResult.hits.length === 0) {
    lines.push(
      "_No semantic matches. Try mode='hybrid' for rerank-boosted recall, or mode='regex'/'full_text' for keyword-only._",
    );
  } else {
    lines.push("### Hits (ranked by semantic distance — lower = more similar)");
    lines.push("");
    let currentChars = lines.join("\n").length;
    for (const hit of semResult.hits) {
      const snippet = truncateSnippet(hit.content);
      const line = `- [${hit.summaryId}] (${hit.kind}, dist=${hit.distance.toFixed(3)}, ${formatDisplayTime(hit.createdAt, timezone)}): ${snippet}`;
      if (currentChars + line.length > MAX_RESULT_CHARS) {
        lines.push("*(truncated — more results available)*");
        break;
      }
      lines.push(line);
      currentChars += line.length;
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "semantic",
      pattern,
      totalMatches: semResult.hits.length,
      voyageTokensConsumed: semResult.voyageTokensConsumed,
      modelName: semResult.modelName,
      hits: semResult.hits.map((h) => ({
        summaryId: h.summaryId,
        sessionKey: h.sessionKey,
        kind: h.kind,
        distance: h.distance,
        createdAt: h.createdAt,
      })),
    },
  };
}

/**
 * Verbatim lcm_grep path. Returns FULL untruncated message content for
 * matches — for citation, quote-back, and "show me what was actually said"
 * use cases where the literal wording matters and snippets aren't enough.
 *
 * Implementation: FTS5 over messages + return full m.content (not snippet).
 * Hard-capped at 20 results because full message rows can be large.
 * Filters suppressed_at IS NULL (per §10 invariant). Scope is messages only
 * (verbatim is a raw-message concept; summaries are by definition paraphrased).
 */
async function runVerbatimLcmGrep(input: HybridGrepInput) {
  const { lcm, pattern, conversationScope, since, before, limit, timezone, roleFilter } =
    input;
  const db = lcm.getDb();

  // Build the SQL query. Mirror conversation-store.searchFullText shape but
  // return full m.content instead of snippet.
  const filters: string[] = ["m.suppressed_at IS NULL"];
  const binds: (string | number)[] = [];

  // FTS5 join: messages_fts virtual table indexed on content
  // (we use FTS5 here since it's faster than LIKE for natural-language patterns)
  // P7 fix: sanitize the pattern so dots/brackets/hyphens don't trigger
  // "fts5: syntax error". Always-on for verbatim — by definition you want
  // literal text.
  filters.push("messages_fts MATCH ?");
  binds.push(sanitizeFts5Pattern(pattern));

  // P6 fix: role filter — at SQL layer so it composes with FTS5 and doesn't
  // burn the 20-result cap on tool-message blobs when the agent wants user
  // or assistant turns. Audit 2 finding #2: include 'system'.
  const VALID_ROLES = new Set(["user", "assistant", "tool", "system"]);
  if (roleFilter && VALID_ROLES.has(roleFilter)) {
    filters.push("m.role = ?");
    binds.push(roleFilter);
  }

  if (conversationScope.allConversations) {
    // no conversation filter
  } else if (
    conversationScope.conversationIds &&
    conversationScope.conversationIds.length > 0
  ) {
    const placeholders = conversationScope.conversationIds.map(() => "?").join(",");
    filters.push(`m.conversation_id IN (${placeholders})`);
    for (const id of conversationScope.conversationIds) binds.push(id);
  } else if (conversationScope.conversationId != null) {
    filters.push("m.conversation_id = ?");
    binds.push(conversationScope.conversationId);
  }

  if (since) {
    filters.push("datetime(m.created_at) >= datetime(?)");
    binds.push(since.toISOString());
  }
  if (before) {
    filters.push("datetime(m.created_at) < datetime(?)");
    binds.push(before.toISOString());
  }

  // Best to detect FTS5 absence and fall back to LIKE
  let rows: Array<{
    message_id: number;
    conversation_id: number;
    role: string;
    content: string;
    token_count: number;
    created_at: string;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT m.message_id, m.conversation_id, m.role, m.content, m.token_count, m.created_at
           FROM messages m
           JOIN messages_fts ON messages_fts.rowid = m.rowid
           WHERE ${filters.join(" AND ")}
           ORDER BY datetime(m.created_at) DESC
           LIMIT ?`,
      )
      .all(...binds, limit) as Array<{
      message_id: number;
      conversation_id: number;
      role: string;
      content: string;
      token_count: number;
      created_at: string;
    }>;
  } catch (e: unknown) {
    // FTS5 not available — fall back to LIKE on m.content.
    // Audit 3 finding #1 (HIGH): the `binds` array was poisoned by the
    // sanitizeFts5Pattern wrapping above (e.g. `"v4.1"` instead of raw
    // `v4.1`). The previous `findIndex(bb => bb === pattern)` returned -1,
    // so no replacement happened and LIKE got the literal phrase-quoted
    // form, matching nothing on old-SQLite (no-FTS5) installations.
    // Fix: replace the FIRST bind (always the pattern slot, since FTS5
    // bind was pushed first at line "binds.push(...)") with the raw LIKE
    // pattern, regardless of what was there.
    const fallbackFilters = filters.map((f) =>
      f === "messages_fts MATCH ?" ? "m.content LIKE ?" : f,
    );
    // Find the FTS5-MATCH-bind index by position in the filters array
    // (it's always pushed first per the code above).
    const ftsBindIndex = 0; // first filter pushed above is "messages_fts MATCH ?"
    const fallbackBinds = binds.map((b, i) =>
      i === ftsBindIndex ? `%${pattern}%` : b,
    );
    rows = db
      .prepare(
        `SELECT m.message_id, m.conversation_id, m.role, m.content, m.token_count, m.created_at
           FROM messages m
           WHERE ${fallbackFilters.join(" AND ")}
           ORDER BY datetime(m.created_at) DESC
           LIMIT ?`,
      )
      .all(...fallbackBinds, limit) as typeof rows;
  }

  const lines: string[] = [];
  lines.push("## LCM Grep Results");
  lines.push(`**Pattern:** \`${pattern}\``);
  lines.push(
    `**Mode:** verbatim | **Scope:** messages${
      roleFilter ? ` (role=${roleFilter})` : ""
    } | **Cap:** ${limit} (full message rows; hard limit 20)`,
  );
  if (conversationScope.allConversations) {
    lines.push("**Conversation scope:** all conversations");
  } else if (conversationScope.conversationId != null) {
    lines.push(`**Conversation scope:** ${conversationScope.conversationId}`);
  }
  if (since || before) {
    lines.push(
      `**Time filter:** ${since ? `since ${formatDisplayTime(since, timezone)}` : "since -∞"} | ${
        before ? `before ${formatDisplayTime(before, timezone)}` : "before +∞"
      }`,
    );
  }
  lines.push(`**Total matches:** ${rows.length}`);
  lines.push("");

  if (rows.length === 0) {
    lines.push("_No verbatim matches in raw messages. Try mode='regex' or mode='full_text' for broader search._");
  } else {
    let currentChars = lines.join("\n").length;
    for (const row of rows) {
      const header = `### [msg#${row.message_id}] ${row.role} — ${formatDisplayTime(row.created_at, timezone)} (${row.token_count} tokens)`;
      const block = `${header}\n\n${row.content}\n`;
      if (currentChars + block.length > MAX_RESULT_CHARS) {
        lines.push("*(truncated — increase limit or narrow time range to see more)*");
        break;
      }
      lines.push(block);
      currentChars += block.length;
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "verbatim",
      pattern,
      totalMatches: rows.length,
      hits: rows.map((r) => ({
        messageId: r.message_id,
        conversationId: r.conversation_id,
        role: r.role,
        content: r.content,
        tokenCount: r.token_count,
        createdAt: r.created_at,
      })),
    },
  };
}

/**
 * Look up session_keys for a list of conversation_ids. Used by semantic
 * mode to scope KNN to the agent's session family.
 */
function deriveSessionKeysFromConversationIds(
  db: import("node:sqlite").DatabaseSync,
  conversationIds: number[],
): string[] {
  if (conversationIds.length === 0) return [];
  const placeholders = conversationIds.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT DISTINCT session_key FROM conversations WHERE conversation_id IN (${placeholders}) AND session_key IS NOT NULL`,
    )
    .all(...conversationIds) as Array<{ session_key: string }>;
  return rows.map((r) => r.session_key);
}
