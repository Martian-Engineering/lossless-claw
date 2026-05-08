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
import { containsCjk } from "../store/full-text-fallback.js";
import { runWithTokenGate } from "../plugin/needs-compact-gate.js";
import { MAX_RESULT_CHARS, truncationNotice } from "../plugin/result-budget.js";

// Tool-result hard cap — protects against back-to-back tool calls
// blowing out the agent's context window. Operators tune via the
// `LCM_TOOL_RESULT_TOKEN_BUDGET` env var (default 10K tokens / ~40K chars).
// Wave-12 audit (W1A1 #2 + W1A8 #3): MAX_RESULT_CHARS now lives in
// `src/plugin/result-budget.ts` so the needs-compact gate's HARD_CAP
// estimator and per-tool char cap stay in lockstep.

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
  // Wave-12 consolidation SA: summaryKinds was previously a
  // lcm_semantic_recall-only param. Folded into lcm_grep when
  // semantic_recall consolidated into mode='semantic'. Honored only by
  // mode='semantic' and 'hybrid' (modes that target summaries); ignored
  // by regex/full_text/verbatim.
  summaryKinds: Type.Optional(
    Type.Array(
      Type.String({ enum: ["leaf", "condensed"] }),
      {
        description:
          "Filter by summary kind. Defaults to both 'leaf' and 'condensed'. Honored only by mode='semantic' and 'hybrid'. Useful when the agent wants to scope to high-level rollups (kind='condensed') or fresh leaves (kind='leaf') instead of both.",
      },
    ),
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
  /** Wave-14 token-state runtime context (see plugin/token-state.ts). */
  getRuntimeContext?: () => {
    currentTokenCount?: number;
    tokenBudget?: number;
  };
}): AnyAgentTool {
  return {
    name: "lcm_grep",
    label: "LCM Grep",
    description:
      "Search compacted conversation history with FIVE modes (`mode` parameter): " +
      "(1) `regex` — literal or regex pattern over summary content; " +
      "(2) `full_text` — FTS5 keyword search; queries use FTS5 AND semantics by default, so keep them short and focused; quoted phrases stay intact and optional sort modes can prioritize relevance for older topics; " +
      "(3) `hybrid` — FTS5 + Voyage semantic + rerank (PRIMARY for Type B topic-anchored queries: 'have we ever discussed X', 'what work has been done on Y' — handles paraphrases like 'merge mess' → 'rebase blew up'); " +
      "(4) `semantic` — pure-vector KNN over summaries via Voyage embed (no rerank, cheaper than hybrid). Use for paraphrastic exploration where keyword precision doesn't matter; " +
      "(5) `verbatim` — returns FULL untruncated source messages (PRIMARY for Type C verbatim/citation queries: 'what exactly did X say about Y', 'quote me the original wording'). " +
      "Optional `summaryKinds` filter (mode='semantic' / 'hybrid' only) scopes hits to ['leaf'] or ['condensed'] — useful when you want fresh source leaves vs higher-level rollups. " +
      "Returns matching snippets with summary/message IDs for follow-up with lcm_describe (one-hop) or lcm_expand_query (multi-hop drilldown). " +
      "Tool result is hard-capped at LCM_TOOL_RESULT_TOKEN_BUDGET (default 10K tokens / 40K chars) — when context is near full, prefer narrower queries (smaller `limit`, more specific `pattern`) over big sweeps; chained calls accumulate context, and compaction only fires post-turn.",
    parameters: LcmGrepSchema,
    async execute(_toolCallId, params) {
      // Wave-12 reviewer F5 fix: migrated from inline gate + 4 hand-written
      // taps (lines 206/222/247/252/264) leaving 9+ untapped return paths
      // (lines 392/590/598/604/661/761/774/779/854/1063) to a single
      // runWithTokenGate wrapper. Pre-fix, helpers like runHybridLcmGrep,
      // runSemanticLcmGrep, runVerbatimLcmGrep had error returns + success
      // returns that bypassed accounting entirely. The wrapper funnels
      // every return through one tap exit, structurally eliminating the
      // antipattern. Adversarial review caught 12 untapped paths total
      // across grep + describe.
      return runWithTokenGate({
        toolName: "lcm_grep",
        toolParams: params as Record<string, unknown>,
        sessionKey: input.sessionKey,
        getRuntimeContext: input.getRuntimeContext,
        inner: async () => {
      const lcm = input.lcm ?? (await input.getLcm?.());
      if (!lcm) {
        throw new Error("LCM engine is unavailable.");
      }
      const retrieval = lcm.getRetrieval();
      const timezone = lcm.timezone;

      const p = params as Record<string, unknown>;
      const pattern = (p.pattern as string).trim();
      // Wave-1 Auditor #9 + QA-runner adv-empty-pattern fix: empty
      // pattern was reaching FTS5 sanitizer which returns `'""'`,
      // causing FTS5 to match all rows. Reject explicitly.
      if (pattern.length === 0) {
        return jsonResult({
          error: "`pattern` is required and must be a non-empty string.",
        });
      }
      const mode =
        (p.mode as "regex" | "full_text" | "hybrid" | "semantic" | "verbatim") ?? "regex";
      const scope = (p.scope as "messages" | "summaries" | "both") ?? "both";
      // verbatim mode is hard-capped to 20 (full message rows can be large)
      const VERBATIM_HARD_CAP = 20;
      const requestedLimit = typeof p.limit === "number" ? Math.trunc(p.limit) : 50;
      const limit =
        mode === "verbatim" ? Math.min(requestedLimit, VERBATIM_HARD_CAP) : requestedLimit;
      const requestedSort = (p.sort as "recency" | "relevance" | "hybrid") ?? "recency";
      // Wave-7 Auditor #8 P1 fix: silent sort override is misleading. If
      // a caller explicitly passes sort=relevance with mode=regex, surface
      // a `sortIgnored` field in details so they can see the override.
      const effectiveSort = mode === "full_text" ? requestedSort : "recency";
      const sortIgnored =
        p.sort != null && requestedSort !== "recency" && mode !== "full_text";
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

      // Wave-12 audit (W1A5 P1): summaryKinds was previously plumbed only
      // through `mode='semantic'` even though the schema description claims
      // both 'semantic' AND 'hybrid' honor it. Now resolved once and passed
      // to both helper functions.
      const summaryKindsParam = Array.isArray(p.summaryKinds)
        ? (p.summaryKinds as Array<"leaf" | "condensed">)
        : undefined;

      if (mode === "hybrid") {
        return runHybridLcmGrep({
          lcm,
          pattern,
          conversationScope,
          since,
          before,
          limit,
          timezone,
          summaryKinds: summaryKindsParam,
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
          summaryKinds: summaryKindsParam,
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
      let truncated = false;

      if (result.messages.length > 0) {
        lines.push("### Messages");
        lines.push("");
        for (const msg of result.messages) {
          const snippet = truncateSnippet(msg.snippet);
          const line = `- [msg#${msg.messageId}] (${msg.role}, ${formatDisplayTime(msg.createdAt, timezone)}): ${snippet}`;
          if (currentChars + line.length > MAX_RESULT_CHARS) {
            lines.push(`*(truncated at ~${Math.round(MAX_RESULT_CHARS / 4)} tokens to protect agent context — narrow query, lower limit, or wait for next-turn compaction; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`);
            truncated = true;
            break;
          }
          lines.push(line);
          currentChars += line.length;
        }
        lines.push("");
      }

      if (result.summaries.length > 0 && !truncated) {
        lines.push("### Summaries");
        lines.push("");
        for (const sum of result.summaries) {
          const snippet = truncateSnippet(sum.snippet);
          const line = `- [${sum.summaryId}] (${sum.kind}, ${formatDisplayTime(sum.createdAt, timezone)}): ${snippet}`;
          if (currentChars + line.length > MAX_RESULT_CHARS) {
            lines.push(`*(truncated at ~${Math.round(MAX_RESULT_CHARS / 4)} tokens to protect agent context — narrow query, lower limit, or wait for next-turn compaction; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`);
            truncated = true;
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
        // Wave-9 TS-tightening: `as const` preserves the literal "text"
        // type so this branch matches the AgentToolResult contract.
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          messageCount: result.messages.length,
          summaryCount: result.summaries.length,
          totalMatches: result.totalMatches,
          // Wave-12 retro N2: top-level `truncated` is the canonical
          // agent-facing contract field across all content-emitting
          // tools. Mirrors lcm_describe + verbatim-mode parity.
          truncated,
          // Wave-7 Auditor #8 P1: surface sort override
          ...(sortIgnored
            ? { sortIgnored: true, requestedSort, effectiveSort }
            : {}),
        },
      };
        },  // close inner: async () => { ... }
      });   // close runWithTokenGate({ ... })
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
  // Wave-12 consolidation SA: summaryKinds was lcm_semantic_recall-only
  // pre-consolidation. Now plumbed through grep mode='semantic' so the
  // capability survives the recall→grep merge. Honored only by semantic
  // mode (other modes run against FTS or raw messages).
  summaryKinds?: Array<"leaf" | "condensed">;
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
  const { lcm, pattern, conversationScope, since, before, limit, timezone, summaryKinds } = input;
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
    // Wave-1 Auditor #4 finding #2: SummarySearchInput doesn't expose
    // sessionKeys/summaryKinds. Caller-passed filters were SILENTLY
    // DROPPED, leaking cross-session content into the FTS arm of hybrid
    // search. Fix: over-fetch, then post-filter on what searchSummaries
    // doesn't support.
    const overFetchK = args.sessionKeys?.length || args.summaryKinds?.length
      ? Math.max(args.limit, args.limit * 5, 100)
      : args.limit;
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
      limit: overFetchK,
      sort: "relevance",
    });
    if (ftsResults.length === 0) return [];
    const hydrated = hydrateRowsById(ftsResults.map((r) => r.summaryId));
    const sessionKeysFilter =
      args.sessionKeys && args.sessionKeys.length > 0
        ? new Set(args.sessionKeys)
        : null;
    const summaryKindsFilter =
      args.summaryKinds && args.summaryKinds.length > 0
        ? new Set(args.summaryKinds)
        : null;
    const out: FtsHit[] = [];
    for (let i = 0; i < ftsResults.length; i++) {
      const r = ftsResults[i];
      const row = hydrated.get(r.summaryId);
      if (!row) continue; // suppressed/deleted between FTS and hydrate — drop
      // Post-filter on sessionKeys (auditor #4 #2 fix) — required for
      // session-family scoping invariant per v4.1 §10.
      if (sessionKeysFilter && !sessionKeysFilter.has(row.sessionKey)) continue;
      // Post-filter on summaryKinds (parity with semantic arm).
      if (summaryKindsFilter && !summaryKindsFilter.has(row.kind)) continue;
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
      if (out.length >= args.limit) break;
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
    // Wave-7 Auditor #8 P1 fix: over-fetch ratio. Previously kFts/kSemantic
    // = max(limit, 50) — at limit=200, this gave rerank zero headroom to
    // reorder. Recall pipelines typically over-fetch 3-5×. Use 3× user
    // limit floored at 50, capped at 500 (Voyage rerank budget).
    hybridResult = await runHybridSearch(db, {
      query: pattern,
      kFts: Math.min(500, Math.max(50, limit * 3)),
      kSemantic: Math.min(500, Math.max(50, limit * 3)),
      topN: limit,
      conversationIds,
      since,
      before,
      // Wave-12 audit (W1A5 P1): summaryKinds was schema-documented for
      // hybrid mode but never plumbed to runHybridSearch. Now passed
      // through for parity with semantic mode.
      ...(summaryKinds && summaryKinds.length > 0 ? { summaryKinds } : {}),
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
  let truncated = false;

  if (hybridResult.hits.length > 0) {
    lines.push("### Summaries");
    lines.push("");
    for (const hit of hybridResult.hits) {
      const provenance = hitProvenanceTag(hit);
      const snippet = truncateSnippet(hit.content);
      const score = hit.score.toFixed(4);
      const line = `- [${hit.summaryId}] ${provenance} (${hit.kind}, score=${score}, ${formatDisplayTime(hit.createdAt, timezone)}): ${snippet}`;
      if (currentChars + line.length > MAX_RESULT_CHARS) {
        lines.push(`*(truncated at ~${Math.round(MAX_RESULT_CHARS / 4)} tokens to protect agent context — narrow query, lower limit, or wait for next-turn compaction; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`);
        truncated = true;
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
    // Wave-9 TS-tightening: `as const` preserves the literal "text" type.
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "hybrid",
      messageCount: 0,
      summaryCount: hybridResult.hits.length,
      totalMatches: hybridResult.hits.length,
      // Wave-12 retro N2: top-level truncated for parity with other tools.
      truncated,
      candidateCount: hybridResult.candidateCount,
      voyageTokensConsumed: hybridResult.voyageTokensConsumed,
      degradedToFtsOnly: hybridResult.degradedToFtsOnly,
      degradedSkippedRerank: hybridResult.degradedSkippedRerank,
      modelName: hybridResult.modelName,
      // Wave-4 Auditor #21 P1 fix + Wave-7 P1: emit confidenceBand for
      // parity with semantic mode + lcm_semantic_recall. Hybrid's `score`
      // is a rerank score (0..1 typically), NOT a cosine similarity —
      // calibration thresholds are tuned for cosine. Wave-7 surfaces
      // confidenceBandSource so callers can see whether the band came
      // from cosine (calibrated) or rerank (heuristic).
      ...(() => {
        const top = hybridResult.hits[0];
        if (!top) return { confidenceBand: "no-match" as const, confidenceBandSource: null };
        if (typeof top.semanticDistance === "number") {
          const cos = 1 - (top.semanticDistance * top.semanticDistance) / 2;
          const band =
            cos >= 0.65 ? "high" : cos >= 0.5 ? "medium" : cos >= 0.35 ? "low" : "noise";
          return { confidenceBand: band, confidenceBandSource: "cosine" as const };
        }
        const s = top.score;
        const band =
          s >= 0.65 ? "high" : s >= 0.5 ? "medium" : s >= 0.35 ? "low" : "noise";
        return { confidenceBand: band, confidenceBandSource: "rerank" as const };
      })(),
      hits: hybridResult.hits.map((h) => ({
        summaryId: h.summaryId,
        conversationId: h.conversationId,
        sessionKey: h.sessionKey,
        kind: h.kind,
        // Wave-4 Auditor #21 P1: add cosineSimilarity (computed from
        // semanticDistance when present) so hybrid hits have shape
        // parity with semantic + recall hits. Fall back to null when
        // the hit was FTS-only (no semantic distance).
        cosineSimilarity:
          typeof h.semanticDistance === "number"
            ? 1 - (h.semanticDistance * h.semanticDistance) / 2
            : null,
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
  const { lcm, pattern, conversationScope, since, before, limit, timezone, summaryKinds } = input;
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
    // Reviewer Wave-3 fix: cap Voyage wall-time on agent hot path. Parity
    // with the hybrid mode at line 538-539. Without this cap, default
    // Voyage client (3×60s) could block an agent turn for minutes if
    // Voyage throttles. 15s × 1 retry ≈ 30s worst case.
    semResult = await runSemanticSearch(db, {
      query: pattern,
      sessionKeys,
      k: limit,
      since,
      before,
      embeddedKinds: ["summary"],
      // Wave-12 consolidation SA: summaryKinds came from lcm_semantic_recall.
      // Pre-consolidation, runSemanticSearch's underlying SQL post-filters on
      // summary kind via Set membership; pass it through when the agent supplies
      // it. Defaults to undefined (no filter) for parity with the prior
      // grep mode='semantic' behavior.
      ...(summaryKinds && summaryKinds.length > 0 ? { summaryKinds } : {}),
      excludeSuppressed: true,
      voyageMaxRetries: 1,
      voyageTimeoutMs: 15_000,
    });
  } catch (e: unknown) {
    if (e instanceof SemanticSearchUnavailableError) {
      return jsonResult({
        error:
          "Semantic search unavailable: vec0 extension not loaded or no embedding profile registered. Use mode='regex' or mode='full_text' instead.",
      });
    }
    if (e instanceof VoyageError) {
      // Wave-9 Agent #4 P1 fix: previously only `auth` was caught; the
      // other transient kinds (`rate_limit`, `server_error`, `network`,
      // `bad_request`, `unexpected`) propagated as raw exceptions. Sister
      // tool `lcm_semantic_recall` correctly catches all VoyageError
      // kinds. Mirror that catch shape so two surfaces routed the same
      // way (Question B) have the same error contract.
      if (e.kind === "auth") {
        return jsonResult({
          error:
            "Voyage API key is missing or invalid (set VOYAGE_API_KEY) - semantic mode requires it. Use mode='regex' or mode='full_text' instead.",
        });
      }
      return jsonResult({
        error: `Voyage embed call failed (${e.kind}). Try mode='full_text' or wait and retry.`,
        detail: e.message,
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

  // Wave-3 Auditor #4 fix #5: parity with lcm_semantic_recall — emit
  // confidenceBand based on top-hit cosineSimilarity. Same calibration
  // (≥0.65 high / ≥0.5 medium / ≥0.35 low / <0.35 noise / no-match).
  const topCos = semResult.hits[0]?.cosineSimilarity ?? -1;
  const confidenceBand =
    semResult.hits.length === 0
      ? "no-match"
      : topCos >= 0.65
        ? "high"
        : topCos >= 0.5
          ? "medium"
          : topCos >= 0.35
            ? "low"
            : "noise";
  if (semResult.hits.length > 0) {
    lines.push(`**Confidence (top hit):** ${confidenceBand} (cosine=${topCos.toFixed(3)})`);
  }
  lines.push("");

  let truncatedSemantic = false;

  if (semResult.hits.length === 0) {
    lines.push(
      "_No semantic matches. Try mode='hybrid' for rerank-boosted recall, or mode='regex'/'full_text' for keyword-only._",
    );
  } else {
    if (confidenceBand === "low" || confidenceBand === "noise") {
      lines.push(
        `*Note: top-hit cosine ${topCos.toFixed(3)} is below the medium-confidence threshold (0.5). Treat results as candidates, not answers.*`,
      );
      lines.push("");
    }
    lines.push("### Hits (ranked by semantic distance — lower = more similar)");
    lines.push("");
    let currentChars = lines.join("\n").length;
    for (const hit of semResult.hits) {
      const snippet = truncateSnippet(hit.content);
      const cosStr = hit.cosineSimilarity.toFixed(3);
      const line = `- [${hit.summaryId}] (${hit.kind}, cosine=${cosStr}, ${formatDisplayTime(hit.createdAt, timezone)}): ${snippet}`;
      if (currentChars + line.length > MAX_RESULT_CHARS) {
        lines.push(`*(truncated at ~${Math.round(MAX_RESULT_CHARS / 4)} tokens to protect agent context — narrow query, lower limit, or wait for next-turn compaction; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`);
        truncatedSemantic = true;
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
      // Wave-12 retro N2: top-level truncated for parity with other tools.
      truncated: truncatedSemantic,
      voyageTokensConsumed: semResult.voyageTokensConsumed,
      modelName: semResult.modelName,
      // Wave-3 Auditor #4 fix #5: confidenceBand mirrors lcm_semantic_recall
      confidenceBand,
      // Wave-3 Auditor #4 fix #3: include conversationId + tokenCount
      // (was missing — broke parity with hybrid mode + semantic-recall).
      // cosineSimilarity is the standard cross-tool field.
      hits: semResult.hits.map((h) => ({
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

  // Wave-9 Agent #4 P1 fix: detect CJK queries and route directly through
  // LIKE substring match. messages_fts is created with `tokenize='porter
  // unicode61'` which can't segment CJK ideographs - `messages_fts MATCH
  // '<chinese characters>'` returns 0 rows WITHOUT throwing, so the
  // existing exception-driven LIKE fallback never triggers. There is no
  // messages_fts_cjk trigram table for messages (only for summaries).
  // For Chinese/Japanese/Korean conversations every Question-C verbatim
  // query was returning "No verbatim matches" silently. By detecting CJK
  // at the JS layer and skipping FTS entirely we get correct LIKE-based
  // verbatim recall on CJK content.
  const useLikeForCjk = containsCjk(pattern);

  // FTS5 join: messages_fts virtual table indexed on content
  // (we use FTS5 here since it's faster than LIKE for natural-language patterns)
  // P7 fix: sanitize the pattern so dots/brackets/hyphens don't trigger
  // "fts5: syntax error". Always-on for verbatim - by definition you want
  // literal text.
  // Wave-8 P1 fix: track ftsBindIndex AT THE PUSH SITE so future refactors
  // that move the FTS bind don't break the LIKE-fallback substitution.
  // Previously hard-coded to 0 with a comment that's brittle to refactor.
  const ftsBindIndex = binds.length;
  if (useLikeForCjk) {
    filters.push("m.content LIKE ?");
    binds.push(`%${pattern}%`);
  } else {
    filters.push("messages_fts MATCH ?");
    binds.push(sanitizeFts5Pattern(pattern));
  }

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
    filters.push("julianday(m.created_at) >= julianday(?)");
    binds.push(since.toISOString());
  }
  if (before) {
    filters.push("julianday(m.created_at) < julianday(?)");
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
    // Wave-9 Agent #4 P1 fix: when CJK detected at the JS layer above,
    // skip the messages_fts JOIN entirely - the filter is already a
    // direct `m.content LIKE ?` substring match.
    const sql = useLikeForCjk
      ? `SELECT m.message_id, m.conversation_id, m.role, m.content, m.token_count, m.created_at
           FROM messages m
           WHERE ${filters.join(" AND ")}
           ORDER BY datetime(m.created_at) DESC
           LIMIT ?`
      : `SELECT m.message_id, m.conversation_id, m.role, m.content, m.token_count, m.created_at
           FROM messages m
           JOIN messages_fts ON messages_fts.rowid = m.rowid
           WHERE ${filters.join(" AND ")}
           ORDER BY datetime(m.created_at) DESC
           LIMIT ?`;
    rows = db
      .prepare(sql)
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
    // Fix: replace the FTS5 bind with the raw LIKE pattern. The bind
    // index was tracked explicitly at the push site (ftsBindIndex) so
    // this no longer assumes FTS is the first push.
    const fallbackFilters = filters.map((f) =>
      f === "messages_fts MATCH ?" ? "m.content LIKE ?" : f,
    );
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

  // Wave-12 reviewer F6 fix: track which rows were emitted into markdown
  // and cap each hit's content at PER_HIT_CONTENT_CHAR_CAP. Pre-fix:
  // `details.hits[].content` returned full untruncated body for every
  // fetched row regardless of markdown truncation — empirical validation
  // showed 200-385K chars/call leaking through details while markdown
  // capped at 25-33K. Now: details.hits is sliced to renderedRowCount,
  // each hit's content capped at 5K chars (~96th percentile of message
  // lengths in observed corpus). Callers needing full body for a
  // specific message follow up with lcm_describe(messageId,
  // expandMessages=true).
  const PER_HIT_CONTENT_CHAR_CAP = 5_000;
  let renderedRowCount = 0;
  let truncated = false;
  if (rows.length === 0) {
    lines.push("_No verbatim matches in raw messages. Try mode='regex' or mode='full_text' for broader search._");
  } else {
    let currentChars = lines.join("\n").length;
    for (const row of rows) {
      const header = `### [msg#${row.message_id}] ${row.role} — ${formatDisplayTime(row.created_at, timezone)} (${row.token_count} tokens)`;
      const block = `${header}\n\n${row.content}\n`;
      if (currentChars + block.length > MAX_RESULT_CHARS) {
        lines.push(`*(truncated at ~${Math.round(MAX_RESULT_CHARS / 4)} tokens to protect agent context — narrow time range, lower limit, or wait for next-turn compaction; raise LCM_TOOL_RESULT_TOKEN_BUDGET env to increase the cap)*`);
        truncated = true;
        break;
      }
      lines.push(block);
      currentChars += block.length;
      renderedRowCount++;
    }
  }

  return {
    content: [{ type: "text" as const, text: lines.join("\n") }],
    details: {
      mode: "verbatim",
      pattern,
      totalMatches: rows.length,
      truncated,
      // Only include hits actually emitted into markdown. Each hit's
      // content is per-hit-capped at 5K chars. Full body via lcm_describe.
      hits: rows.slice(0, renderedRowCount).map((r) => {
        const fullLen = r.content.length;
        const capped = fullLen > PER_HIT_CONTENT_CHAR_CAP
          ? r.content.slice(0, PER_HIT_CONTENT_CHAR_CAP) + "…[truncated; full body via lcm_describe]"
          : r.content;
        return {
          messageId: r.message_id,
          conversationId: r.conversation_id,
          role: r.role,
          content: capped,
          contentTruncated: fullLen > PER_HIT_CONTENT_CHAR_CAP,
          fullContentLength: fullLen,
          tokenCount: r.token_count,
          createdAt: r.created_at,
        };
      }),
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
