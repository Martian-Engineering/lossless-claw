/**
 * Hybrid retrieval — LCM v4.1 §13 / Group C.02.
 *
 * Combines FTS (BM25-style relevance over `summaries_fts`) with semantic
 * search (vec0 KNN over the active embedding model), then optionally
 * reranks the union via Voyage rerank-2.5 to produce a final ranked
 * list. Empirically (Phase A spike: voyage-spike-results.md) lifts
 * paraphrastic queries by +52.5pp over FTS-only on Eva's 31-query eval.
 *
 * Why this lives outside the lcm_grep tool: the same pipeline is needed
 * by lcm_synthesize_around (window_kind='semantic') and any future tool
 * that needs ranked-by-relevance content windows. Centralizing here so
 * suppression filters, dedup logic, and the rerank cache stay coherent
 * across all callers.
 *
 * Pipeline:
 *
 *   1. Run FTS + semantic in parallel (Promise.all). Both restricted to
 *      summaries (semantic doesn't cover raw messages — we don't embed
 *      messages directly).
 *   2. Build deduplicated candidate union (by summary_id). Each side
 *      contributes up to `kFts` / `kSemantic` candidates.
 *   3. If `rerank: true`: send the union to Voyage rerank-2.5; take
 *      top-N from rerank score.
 *      If `rerank: false`: merge by reciprocal-rank-fusion (RRF) across
 *      the FTS rank and semantic rank. Cheap fallback for when the
 *      Voyage rerank quota is exhausted or the operator opts out.
 *   4. Return final hits with `score` (rerank score OR RRF score) +
 *      provenance flags (`fromFts`, `fromSemantic`).
 *
 * Suppression: both arms exclude suppressed by default; the rerank input
 * is the post-suppression union, so no post-rerank filter needed.
 *
 * Graceful degrade: if semantic search throws SemanticSearchUnavailableError
 * (vec0 not loaded, no model registered), we fall back to FTS-only and
 * set `degradedToFtsOnly: true` in the result so the caller can warn.
 * Voyage rerank failures (auth/network) similarly fall back to RRF
 * fusion with `degradedSkippedRerank: true`.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  rerankCandidates,
  VoyageError,
  type VoyageRerankerModel,
} from "../voyage/client.js";
import {
  runSemanticSearch,
  SemanticSearchUnavailableError,
  type SemanticHit,
  type SemanticSearchOptions,
} from "./semantic-search.js";

export interface HybridSearchOptions {
  query: string;

  /**
   * FTS-side candidate count. Default 50.
   */
  kFts?: number;
  /** Semantic-side candidate count. Default 50. */
  kSemantic?: number;
  /** How many final hits to return after rerank/RRF. Default 20. */
  topN?: number;

  // Filters — passed through to both arms
  sessionKeys?: string[];
  conversationIds?: number[];
  since?: Date;
  before?: Date;
  excludeSuppressed?: boolean;
  summaryKinds?: Array<"leaf" | "condensed">;

  /**
   * If true (default), call Voyage rerank-2.5 over the candidate union.
   * If false, fuse FTS + semantic via reciprocal-rank-fusion (much
   * cheaper, slightly less accurate).
   */
  rerank?: boolean;
  /** Voyage reranker model. Default 'rerank-2.5'. */
  rerankerModel?: VoyageRerankerModel;

  // Voyage HTTP wiring
  voyageApiKey?: string;
  voyageFetch?: typeof fetch;
  voyageMaxRetries?: number;
  /**
   * Voyage per-attempt timeout in ms. Agent-tool callers should cap
   * this (e.g. 15s) to avoid blocking the agent's turn.
   */
  voyageTimeoutMs?: number;

  // Semantic-side overrides (rarely used; passed through to semantic-search)
  semantic?: Pick<
    SemanticSearchOptions,
    "voyageModel" | "inputType" | "queryVector"
  >;

  /**
   * FTS provider — caller injects a function that runs FTS over
   * summaries given the same filters and returns ranked hits. We don't
   * own the FTS query here because the existing summary-store/retrieval
   * code is already wired with FTS5 sanitization, hybrid-recency
   * sorting, etc. Caller wraps `summaryStore.searchSummaries` and
   * normalizes to the FtsHit shape.
   *
   * Returning [] is fine (treated as "no FTS results").
   */
  ftsSearch: (args: {
    query: string;
    sessionKeys?: string[];
    conversationIds?: number[];
    since?: Date;
    before?: Date;
    summaryKinds?: Array<"leaf" | "condensed">;
    excludeSuppressed?: boolean;
    limit: number;
  }) => Promise<FtsHit[]>;
}

export interface FtsHit {
  summaryId: string;
  conversationId: number;
  sessionKey: string;
  kind: "leaf" | "condensed";
  content: string;
  tokenCount: number;
  createdAt: string;
  /** FTS rank (0-indexed; 0 = best match). Used for RRF when rerank
   *  is off. */
  rank: number;
}

export interface HybridHit {
  summaryId: string;
  conversationId: number;
  sessionKey: string;
  kind: "leaf" | "condensed";
  content: string;
  tokenCount: number;
  createdAt: string;
  /** Final score: rerank relevance (range ~[0, 1]) OR RRF score. */
  score: number;
  fromFts: boolean;
  fromSemantic: boolean;
  /** Cosine distance from semantic hit (when applicable; null otherwise). */
  semanticDistance: number | null;
  /** FTS rank (0-indexed; null if not in FTS results). */
  ftsRank: number | null;
}

export interface HybridSearchResult {
  hits: HybridHit[];
  /** Candidate union size before rerank/cut. */
  candidateCount: number;
  /** Voyage tokens consumed across embed (semantic) + rerank calls. */
  voyageTokensConsumed: number;
  /** True if vec0 unavailable; we ran FTS-only. */
  degradedToFtsOnly: boolean;
  /** True if rerank failed; we used RRF instead. */
  degradedSkippedRerank: boolean;
  /** Hint for caller logs / `/lcm health`. */
  modelName: string | null;
}

const DEFAULT_K_FTS = 50;
const DEFAULT_K_SEMANTIC = 50;
const DEFAULT_TOP_N = 20;

/**
 * Run a hybrid retrieval. See module docs for pipeline detail.
 *
 * Caller is responsible for passing a working `ftsSearch` that respects
 * the existing FTS5 sanitization rules. We don't rebuild FTS here — we
 * delegate to it.
 */
export async function runHybridSearch(
  db: DatabaseSync,
  opts: HybridSearchOptions,
): Promise<HybridSearchResult> {
  const query = opts.query?.trim() ?? "";
  if (query.length === 0) {
    throw new Error("[hybrid-search] query is required");
  }
  const kFts = opts.kFts ?? DEFAULT_K_FTS;
  const kSemantic = opts.kSemantic ?? DEFAULT_K_SEMANTIC;
  const topN = opts.topN ?? DEFAULT_TOP_N;

  // 1. Run both arms in parallel. Catch SemanticSearchUnavailableError
  //    and downgrade to FTS-only.
  const ftsPromise = opts.ftsSearch({
    query,
    sessionKeys: opts.sessionKeys,
    conversationIds: opts.conversationIds,
    since: opts.since,
    before: opts.before,
    summaryKinds: opts.summaryKinds,
    excludeSuppressed: opts.excludeSuppressed,
    limit: kFts,
  });
  const semanticPromise = (async () => {
    try {
      const sem = await runSemanticSearch(db, {
        query,
        sessionKeys: opts.sessionKeys,
        conversationIds: opts.conversationIds,
        since: opts.since,
        before: opts.before,
        summaryKinds: opts.summaryKinds,
        excludeSuppressed: opts.excludeSuppressed,
        k: kSemantic,
        voyageModel: opts.semantic?.voyageModel,
        voyageApiKey: opts.voyageApiKey,
        voyageFetch: opts.voyageFetch,
        voyageMaxRetries: opts.voyageMaxRetries,
        voyageTimeoutMs: opts.voyageTimeoutMs,
        inputType: opts.semantic?.inputType,
        queryVector: opts.semantic?.queryVector,
        embeddedKinds: ["summary"],
      });
      return { hits: sem.hits, tokens: sem.voyageTokensConsumed, modelName: sem.modelName };
    } catch (e: unknown) {
      if (e instanceof SemanticSearchUnavailableError) {
        return { hits: [] as SemanticHit[], tokens: 0, modelName: null, degraded: true };
      }
      throw e;
    }
  })();

  const [ftsHits, semResult] = await Promise.all([ftsPromise, semanticPromise]);
  const degradedToFtsOnly = "degraded" in semResult ? Boolean(semResult.degraded) : false;
  let voyageTokensConsumed = "tokens" in semResult ? semResult.tokens : 0;
  const modelName = "modelName" in semResult ? semResult.modelName : null;

  // 2. Build deduplicated union. Use summaryId as key. Each side gets
  //    its rank recorded.
  const merged = new Map<string, HybridHit>();
  for (let i = 0; i < ftsHits.length; i++) {
    const f = ftsHits[i];
    merged.set(f.summaryId, {
      summaryId: f.summaryId,
      conversationId: f.conversationId,
      sessionKey: f.sessionKey,
      kind: f.kind,
      content: f.content,
      tokenCount: f.tokenCount,
      createdAt: f.createdAt,
      score: 0, // computed below
      fromFts: true,
      fromSemantic: false,
      semanticDistance: null,
      ftsRank: i,
    });
  }
  for (const s of semResult.hits) {
    const existing = merged.get(s.summaryId);
    if (existing) {
      existing.fromSemantic = true;
      existing.semanticDistance = s.distance;
    } else {
      merged.set(s.summaryId, {
        summaryId: s.summaryId,
        conversationId: s.conversationId,
        sessionKey: s.sessionKey,
        kind: s.kind,
        content: s.content,
        tokenCount: s.tokenCount,
        createdAt: s.createdAt,
        score: 0,
        fromFts: false,
        fromSemantic: true,
        semanticDistance: s.distance,
        ftsRank: null,
      });
    }
  }

  const candidates = Array.from(merged.values());
  const candidateCount = candidates.length;
  if (candidateCount === 0) {
    return {
      hits: [],
      candidateCount: 0,
      voyageTokensConsumed,
      degradedToFtsOnly,
      degradedSkippedRerank: false,
      modelName,
    };
  }

  // 3. Rerank or RRF.
  const rerankRequested = opts.rerank !== false;
  let degradedSkippedRerank = false;
  if (rerankRequested) {
    try {
      const rerankResp = await rerankCandidates({
        model: opts.rerankerModel ?? "rerank-2.5",
        query,
        candidates: candidates.map((c) => ({ id: c.summaryId, text: c.content })),
        topK: Math.min(topN, candidates.length),
        apiKey: opts.voyageApiKey,
        fetch: opts.voyageFetch,
        maxRetries: opts.voyageMaxRetries,
        timeoutMs: opts.voyageTimeoutMs,
      });
      voyageTokensConsumed += rerankResp.totalTokens;
      // Apply rerank scores; return only items that survived rerank
      const byId = new Map(candidates.map((c) => [c.summaryId, c] as const));
      const finalHits: HybridHit[] = rerankResp.results
        .map((r) => {
          const c = byId.get(r.id);
          if (!c) return null;
          return { ...c, score: r.score };
        })
        .filter((h): h is HybridHit => h !== null);
      return {
        hits: finalHits,
        candidateCount,
        voyageTokensConsumed,
        degradedToFtsOnly,
        degradedSkippedRerank: false,
        modelName,
      };
    } catch (e: unknown) {
      if (e instanceof VoyageError && e.kind === "auth") {
        // Auth errors are fatal — re-throw so operator surfaces.
        throw e;
      }
      // Otherwise, fall back to RRF.
      degradedSkippedRerank = true;
    }
  }

  // RRF fallback (also when rerank=false explicitly)
  const RRF_K = 60; // standard reciprocal-rank-fusion constant
  for (const c of candidates) {
    let score = 0;
    if (c.ftsRank !== null) score += 1 / (RRF_K + c.ftsRank);
    if (c.fromSemantic && c.semanticDistance !== null) {
      // Semantic rank — recover from semantic-arm position. We need to
      // know the rank. Search semResult.hits for the summaryId.
      const semIdx = semResult.hits.findIndex((h) => h.summaryId === c.summaryId);
      if (semIdx >= 0) score += 1 / (RRF_K + semIdx);
    }
    c.score = score;
  }
  candidates.sort((a, b) => b.score - a.score);
  return {
    hits: candidates.slice(0, topN),
    candidateCount,
    voyageTokensConsumed,
    degradedToFtsOnly,
    degradedSkippedRerank,
    modelName,
  };
}
