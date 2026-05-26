/**
 * Semantic search service — LCM v4.1 §13 / Group C.
 *
 * Wraps the embed-query → KNN → join-back-to-summary flow used by
 * the `semantic` and `hybrid` modes of `lcm_grep`.
 *
 * Caller passes a free-text query + optional filters. We embed it via
 * Voyage (with `inputType='query'` for asymmetric retrieval), run KNN
 * against the active model's vec0 table, JOIN back to `summaries` for
 * content + metadata, and return ranked hits.
 *
 * Invariants:
 *   - Suppression is filtered at TWO layers: vec0 metadata col
 *     (`suppressed=0` pre-filter inside MATCH) AND a final JOIN to
 *     summaries WHERE `suppressed_at IS NULL` (defense in depth — a
 *     race between trigger fire and KNN call could leak a stale row
 *     through the metadata layer; the JOIN catches it).
 *   - Session-family scoping uses `summaries.session_key` (populated
 *     atomically at write time per Gap 8 fix).
 *   - Time filters via `summaries.created_at` (when present in input).
 *   - NEVER fall back to FTS silently if vec0 isn't loaded — caller
 *     gets `vec0_unavailable` error and decides whether to degrade.
 *
 * NOT in this module: rerank. Rerank lives in the hybrid path in
 * lcm_grep (Group C.02), where it can score across BOTH semantic and
 * FTS hits.
 */

import type { DatabaseSync } from "node:sqlite";
import {
  embeddingsTableExists,
  embeddingsTableName,
  searchSimilar,
  vec0Version,
  type EmbeddedKind,
} from "./store.js";
import {
  embedTexts,
  type VoyageEmbeddingModel,
  type VoyageInputType,
} from "../voyage/client.js";

export interface SemanticSearchOptions {
  /** Free-text query. */
  query: string;
  /**
   * How many candidates to retrieve from vec0 BEFORE optional rerank.
   * Default 50. Rerank caller (Group C.02) typically asks for 100.
   */
  k?: number;
  /**
   * Filter to specific session_keys. If provided, results restricted
   * to summaries.session_key IN (sessionKeys).
   */
  sessionKeys?: string[];
  /**
   * Filter to specific conversation_ids. Honored if provided; sessionKeys
   * takes precedence if both are passed (unusual).
   */
  conversationIds?: number[];
  /** ISO timestamp. Result restricted to summaries created at or after. */
  since?: Date;
  /** ISO timestamp. Result restricted to summaries created before. */
  before?: Date;
  /**
   * Restrict by summary kind: 'leaf' / 'condensed'. Default both.
   */
  summaryKinds?: Array<"leaf" | "condensed">;
  /**
   * Restrict by embedded kind. Default ['summary']. Operator/admin tools
   * may pass ['summary', 'entity'] etc.
   */
  embeddedKinds?: EmbeddedKind[];
  /**
   * If false, INCLUDES suppressed rows. Default true (excludes).
   * v4.1 §10 invariant: every retrieval surface defaults to suppressed-
   * filter ON. Operator tools opt-in to false.
   */
  excludeSuppressed?: boolean;

  // Voyage call wiring — passed through to embedTexts.
  voyageModel?: VoyageEmbeddingModel;
  voyageApiKey?: string;
  voyageFetch?: typeof fetch;
  voyageMaxRetries?: number;
  /**
   * Voyage per-attempt timeout in ms. Default = Voyage client default
   * (60s). Agent-tool callers should cap this (e.g. 15s) to avoid
   * blocking the agent's turn on a slow Voyage response.
   */
  voyageTimeoutMs?: number;
  /** Override `inputType` (default 'query' — asymmetric retrieval). */
  inputType?: VoyageInputType;

  /**
   * Inject a precomputed query vector instead of calling Voyage. Useful
   * for tests AND for the hybrid path that may want to embed once and
   * call both semantic + rerank with the same vector.
   *
   * If provided: voyageModel/voyageApiKey are ignored; queryVector
   * length must match the active model's dim.
   */
  queryVector?: Float32Array | number[];
}

export interface SemanticHit {
  summaryId: string;
  embeddedKind: EmbeddedKind;
  /**
   * vec0's reported L2 (Euclidean) distance from the query vector.
   * Voyage embeddings are unit-normalized (norm=1.0); on unit vectors,
   * L2² = 2·(1 - cosine_similarity). Range:
   *   - 0.0 = identical
   *   - ~0.45 (cos ≈ 0.9) = strongly related
   *   - ~1.00 (cos ≈ 0.5) = weakly related
   *   - ~1.41 (cos ≈ 0.0) = orthogonal / unrelated
   *   - ~2.00 (cos ≈ -1.0) = opposite (rare with text embeddings)
   * Use {@link cosineSimilarity} for the [-1, 1] cosine score.
   */
  distance: number;
  /**
   * Convenience: cosine similarity in [-1, 1] derived from `distance`
   * (assumes unit-normalized vectors, which Voyage guarantees).
   * Higher = more similar. The agent-facing tool maps this into bands:
   *   ≥0.65 high / ≥0.5 medium / ≥0.35 low / <0.35 noise.
   * (Calibrated against Eva's live DB on 2026-05-06; see
   *  `lcm-grep-tool.ts` semantic mode for the band logic.)
   */
  cosineSimilarity: number;
  /** From summaries: content + metadata (after suppression-filter join). */
  conversationId: number;
  sessionKey: string;
  kind: "leaf" | "condensed";
  content: string;
  tokenCount: number;
  createdAt: string;
  earliestAt: string | null;
  latestAt: string | null;
  /** True if the row passed the metadata-only check but failed the JOIN
   *  (i.e. summary exists but is suppressed). Should always be false in
   *  practice; surfaced for diagnostic / metric. */
  filteredAfterJoin?: boolean;
}

export interface SemanticSearchResult {
  hits: SemanticHit[];
  /** Total candidates returned by vec0 KNN (before suppression-JOIN filter). */
  candidateCount: number;
  /** Voyage tokens consumed by the embed call (0 if queryVector provided). */
  voyageTokensConsumed: number;
  /** Active embedding model used. */
  modelName: string;
}

export class SemanticSearchUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SemanticSearchUnavailableError";
  }
}

/**
 * Look up the currently-active embedding model from `lcm_embedding_profile`.
 * Returns the row with `active=1` AND highest registered_at (most recent
 * activation wins on ties). Returns null if no active row exists.
 */
export function getActiveEmbeddingModel(
  db: DatabaseSync,
): { modelName: string; dim: number } | null {
  const row = db
    .prepare(
      `SELECT model_name, dim FROM lcm_embedding_profile
         WHERE active = 1 AND archive_after IS NULL
         ORDER BY registered_at DESC LIMIT 1`,
    )
    .get() as { model_name?: string; dim?: number } | undefined;
  if (!row?.model_name || !row.dim) return null;
  return { modelName: row.model_name, dim: row.dim };
}

/**
 * Run a semantic search. Returns ranked hits sorted by distance ascending.
 *
 * Throws {@link SemanticSearchUnavailableError} if vec0 isn't loaded or
 * no active embedding model is registered. Caller (e.g. lcm_grep with
 * mode='hybrid') should catch this and gracefully degrade to FTS-only.
 */
export async function runSemanticSearch(
  db: DatabaseSync,
  opts: SemanticSearchOptions,
): Promise<SemanticSearchResult> {
  // 1. Validate vec0 + active model
  if (vec0Version(db) === null) {
    throw new SemanticSearchUnavailableError(
      "[semantic-search] sqlite-vec is not loaded — semantic retrieval unavailable",
    );
  }
  const active = getActiveEmbeddingModel(db);
  if (!active) {
    throw new SemanticSearchUnavailableError(
      "[semantic-search] no active embedding model registered in lcm_embedding_profile",
    );
  }
  if (!embeddingsTableExists(db, active.modelName)) {
    throw new SemanticSearchUnavailableError(
      `[semantic-search] vec0 table for ${active.modelName} doesn't exist — call ensureEmbeddingsTable() during setup`,
    );
  }

  // 2. Embed query (or use injected vector)
  let queryVector: Float32Array | number[];
  let voyageTokensConsumed = 0;
  if (opts.queryVector) {
    if (opts.queryVector.length !== active.dim) {
      throw new Error(
        `[semantic-search] queryVector dim ${opts.queryVector.length} != active model dim ${active.dim}`,
      );
    }
    queryVector = opts.queryVector;
  } else {
    const query = opts.query?.trim() ?? "";
    if (query.length === 0) {
      throw new Error("[semantic-search] query is required (or pass queryVector)");
    }
    const voyageModel = (opts.voyageModel ?? active.modelName) as VoyageEmbeddingModel;
    const embed = await embedTexts({
      model: voyageModel,
      texts: [query],
      inputType: opts.inputType ?? "query",
      apiKey: opts.voyageApiKey,
      fetch: opts.voyageFetch,
      maxRetries: opts.voyageMaxRetries,
      timeoutMs: opts.voyageTimeoutMs,
      // Wave-11 reviewer P1 fix: query embedding must request the
      // same dim as the indexed corpus. Pulled from the active
      // profile so query vectors match vec0's column shape.
      outputDimension: active.dim,
    });
    if (embed.vectors.length !== 1) {
      throw new Error(
        `[semantic-search] Voyage returned ${embed.vectors.length} vectors (expected 1)`,
      );
    }
    queryVector = embed.vectors[0];
    voyageTokensConsumed = embed.totalTokens;
  }

  // 3. KNN search (with vec0-side suppression + kind filter)
  //
  // P1 FIX (2026-05-06 harness finding): when any filter (time / conversation
  // / sessionKey / kind) is present, vec0's nearest-K does not know about it.
  // Top-K globally may all live OUTSIDE the filter window, leading to
  // 0 hits even though hundreds of matching docs exist. Counter by
  // OVER-FETCHING from vec0 (10× the user's k, capped at 500) when filters
  // are active, then trimming after the JOIN. Without filters, request just
  // k — no waste.
  const userK = opts.k ?? 50;
  const hasFilter = Boolean(
    opts.since ||
      opts.before ||
      (opts.conversationIds && opts.conversationIds.length > 0) ||
      (opts.sessionKeys && opts.sessionKeys.length > 0) ||
      (opts.summaryKinds && opts.summaryKinds.length > 0),
  );
  const VEC0_OVERFETCH_MULT = 10;
  const VEC0_OVERFETCH_MAX = 500;
  const k = hasFilter
    ? Math.min(VEC0_OVERFETCH_MAX, Math.max(userK, userK * VEC0_OVERFETCH_MULT))
    : userK;
  const candidates = searchSimilar(db, {
    modelName: active.modelName,
    queryVector,
    k,
    embeddedKinds: opts.embeddedKinds ?? ["summary"],
    excludeSuppressed: opts.excludeSuppressed !== false,
  });

  if (candidates.length === 0) {
    return { hits: [], candidateCount: 0, voyageTokensConsumed, modelName: active.modelName };
  }

  // 4. JOIN back to summaries with all the filter clauses applied at the
  //    SQL layer. Defense-in-depth suppression: filter vec0-metadata AND
  //    summaries.suppressed_at to handle a race between trigger + KNN.
  const summaryHits = candidates.filter((c) => c.embeddedKind === "summary");
  const summaryIds = summaryHits.map((c) => c.embeddedId);
  if (summaryIds.length === 0) {
    // All candidates were entity/theme — return them with no JOIN. Caller
    // tools (lcm_grep semantic mode) may or may not handle these.
    // Audit 1 finding #1 (HIGH): cosineSimilarity is a required field —
    // omitting it crashes downstream `.toFixed(3)` calls. Compute it here.
    return {
      hits: candidates.map((c) => ({
        summaryId: c.embeddedId,
        embeddedKind: c.embeddedKind,
        distance: c.distance,
        cosineSimilarity: Math.max(-1, Math.min(1, 1 - (c.distance * c.distance) / 2)),
        conversationId: -1, // unknown — not a summary
        sessionKey: "",
        kind: "leaf",
        content: "",
        tokenCount: 0,
        createdAt: "",
        earliestAt: null,
        latestAt: null,
        // Wave-8 Auditor #2-5 B-P1 fix: `filteredAfterJoin: true` was
        // being set on EVERY entity/theme hit despite no JOIN being
        // attempted. The field's documented semantic is "row passed
        // metadata-only check but failed JOIN" — meaningless for the
        // entity branch where no JOIN exists. Now `false` (these rows
        // didn't fail any JOIN; there was no JOIN to fail).
        filteredAfterJoin: false,
      })),
      candidateCount: candidates.length,
      voyageTokensConsumed,
      modelName: active.modelName,
    };
  }

  // Build dynamic WHERE clauses + bind params
  const placeholders = summaryIds.map(() => "?").join(",");
  const filters: string[] = [];
  // Wave-9 TS-tightening: typed for DatabaseSync.all(...args) which
  // requires SQLInputValue. summaryIds are strings; appended values
  // are ISO timestamps (since/before) and summaryKinds (strings).
  const binds: (string | number)[] = [...summaryIds];

  if (opts.excludeSuppressed !== false) {
    filters.push("s.suppressed_at IS NULL");
  }
  if (opts.sessionKeys && opts.sessionKeys.length > 0) {
    filters.push(`s.session_key IN (${opts.sessionKeys.map(() => "?").join(",")})`);
    binds.push(...opts.sessionKeys);
  }
  if (opts.conversationIds && opts.conversationIds.length > 0) {
    filters.push(`s.conversation_id IN (${opts.conversationIds.map(() => "?").join(",")})`);
    binds.push(...opts.conversationIds);
  }
  // Wave-1 Auditor #4 finding #3: semantic and FTS arms had divergent
  // time-filter semantics — semantic used `s.created_at` (row-write
  // time), FTS used `COALESCE(s.latest_at, s.created_at)` (the content's
  // covered-time bracket). On condensed summaries written long after the
  // content they cover, the two arms returned different sets for the
  // same since/before window. Use COALESCE here to match FTS.
  if (opts.since) {
    filters.push(
      `julianday(COALESCE(s.latest_at, s.created_at)) >= julianday(?)`,
    );
    binds.push(opts.since.toISOString());
  }
  if (opts.before) {
    filters.push(
      `julianday(COALESCE(s.latest_at, s.created_at)) < julianday(?)`,
    );
    binds.push(opts.before.toISOString());
  }
  if (opts.summaryKinds && opts.summaryKinds.length > 0) {
    filters.push(`s.kind IN (${opts.summaryKinds.map(() => "?").join(",")})`);
    binds.push(...opts.summaryKinds);
  }
  const whereExtra = filters.length > 0 ? " AND " + filters.join(" AND ") : "";

  const rows = db
    .prepare(
      `SELECT s.summary_id, s.conversation_id, s.session_key, s.kind, s.content,
              s.token_count, s.created_at, s.earliest_at, s.latest_at
         FROM summaries s
         WHERE s.summary_id IN (${placeholders})${whereExtra}`,
    )
    .all(...binds) as Array<{
    summary_id: string;
    conversation_id: number;
    session_key: string;
    kind: "leaf" | "condensed";
    content: string;
    token_count: number;
    created_at: string;
    earliest_at: string | null;
    latest_at: string | null;
  }>;

  const rowsById = new Map(rows.map((r) => [r.summary_id, r] as const));

  // 5. Build hits in candidate (distance) order, dropping any that didn't
  //    survive the filter JOIN. Mark filtered-out for diagnostics.
  //    P1 FIX: trim to user-requested k after filtering — the over-fetch
  //    above was just to give the post-filter step survivors to choose from.
  const hits: SemanticHit[] = [];
  for (const cand of summaryHits) {
    const row = rowsById.get(cand.embeddedId);
    if (!row) continue;
    // Cosine similarity from L2 distance on unit vectors:
    //   cos = 1 - L²/2
    // Clamp to [-1, 1] to absorb floating-point error.
    const cosSim = Math.max(-1, Math.min(1, 1 - (cand.distance * cand.distance) / 2));
    hits.push({
      summaryId: cand.embeddedId,
      embeddedKind: cand.embeddedKind,
      distance: cand.distance,
      cosineSimilarity: cosSim,
      conversationId: row.conversation_id,
      sessionKey: row.session_key,
      kind: row.kind,
      content: row.content,
      tokenCount: row.token_count,
      createdAt: row.created_at,
      earliestAt: row.earliest_at,
      latestAt: row.latest_at,
    });
    if (hits.length >= userK) break;
  }

  return {
    hits,
    candidateCount: candidates.length,
    voyageTokensConsumed,
    modelName: active.modelName,
  };
}
