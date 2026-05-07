/**
 * Voyage AI HTTP client — LCM v4.1 §13
 *
 * Raw `fetch` wrapper for Voyage embeddings + reranker. We do NOT use the
 * `voyageai` npm SDK because v0.2.1 has an ESM resolution bug that breaks
 * under Node 22's native ESM loader (verified during Phase A spike — see
 * `docs/projects/lcm-rollup-overhaul/voyage-spike-results.md`).
 *
 * Design constraints baked in here:
 *
 *   1. Per-batch token budget cap. Voyage server-side limit is 120K tokens
 *      per request; the Voyage tokenizer counts ~9.5% higher than our
 *      stored `summaries.token_count` (also measured during the spike).
 *      We batch at {@link MAX_TOKENS_PER_EMBED_BATCH} = 80K to leave
 *      generous margin (≈22K tokens of headroom even at 9.5% inflation).
 *
 *   2. Rate-limit budget visible to caller. The 429 response carries
 *      `Retry-After` (sometimes seconds, sometimes HTTP-date). The
 *      response body has more detail. Caller (backfill cron) coordinates
 *      across processes via `lcm_voyage_rate_state` table — this client
 *      JUST surfaces the retry hint and lets the caller decide the
 *      backoff strategy. (The client's own retry is for transient
 *      5xx / network blips, not sustained 429s.)
 *
 *   3. Truncation policy explicit. We pass `truncation: false` so Voyage
 *      will reject (HTTP 400) any input over its per-document cap, rather
 *      than silently truncate and produce a vector that doesn't reflect
 *      the full document. v4.1 §13 amendment: caller must catch 400 and
 *      either (a) suppress + log the over-cap leaf or (b) split. We
 *      chose `truncation: false` over `truncation: true` because lossless
 *      is a hard requirement and a silently-truncated embedding is worse
 *      than no embedding (you can't tell from the vector that the source
 *      was clipped).
 *
 *   4. Mockable fetch. Production calls `globalThis.fetch`; tests inject a
 *      stub via the `fetch` option. No global side effects, no module-level
 *      singleton state.
 *
 *   5. NO retries on 4xx. 4xx means caller bug — bad input, bad auth,
 *      over-cap document. Retrying just spends quota. We retry only on
 *      network errors and 5xx.
 *
 *   6. Bounded retries. {@link DEFAULT_MAX_RETRIES} = 3 attempts (so 4
 *      total tries: t0 + 3 retries). Exponential backoff base 500ms,
 *      doubled each attempt, capped at 30s. Total worst-case wall time:
 *      ≈37.5s before giving up. Caller (backfill cron) requeues for
 *      next pass on failure.
 *
 *   7. No PII in error messages. Voyage echoes the input back in some
 *      400 responses; we surface the response body verbatim only when
 *      it doesn't contain `input` or `texts` keys, otherwise we
 *      summarize ("voyage_400: <error_type> on input length=N").
 */

/**
 * Per-request token budget. Voyage server cap is 120K; we use 80K because
 * Voyage's tokenizer counts ~9.5% higher than our `summaries.token_count`
 * (empirically measured Phase A). 80K * 1.10 = 88K << 120K — safe margin.
 */
export const MAX_TOKENS_PER_EMBED_BATCH = 80_000;

/**
 * Per-document token budget for {@link embedTexts}. Voyage embeddings cap
 * is 32K tokens per document for `voyage-4-large`; we use 30K margin.
 * Caller MUST pre-filter documents over this size — this client does not
 * silently drop or truncate them, it sends them and lets Voyage 400.
 */
export const MAX_TOKENS_PER_EMBED_DOC = 30_000;

/**
 * Reranker per-call budget (Voyage `rerank-2.5`). 600K tokens total across
 * (query + all candidate documents). Caller must enforce this.
 */
export const MAX_TOKENS_PER_RERANK_CALL = 600_000;

const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 60_000;

const VOYAGE_API_BASE = "https://api.voyageai.com/v1";

export type VoyageEmbeddingModel =
  | "voyage-4-large"
  | "voyage-3"
  | "voyage-3-large"
  | "voyage-3-lite"
  | "voyage-code-3";

export type VoyageRerankerModel = "rerank-2" | "rerank-2.5" | "rerank-2-lite";

export type VoyageInputType = "query" | "document" | null;

export interface VoyageEmbedOptions {
  /** Voyage model id, e.g. `voyage-4-large`. */
  model: VoyageEmbeddingModel;
  /**
   * Texts to embed. Caller MUST batch such that
   * `sum(estimateTokens(text)) <= MAX_TOKENS_PER_EMBED_BATCH`. Each text MUST
   * be ≤ {@link MAX_TOKENS_PER_EMBED_DOC} (Voyage rejects over-cap with 400).
   */
  texts: string[];
  /**
   * `query` for retrieval queries, `document` for stored items, `null` for
   * Voyage default. Per Voyage docs, asymmetric embedding (different prompts
   * for queries vs documents) measurably improves retrieval quality.
   */
  inputType: VoyageInputType;
  /** Override default base URL (for tests). */
  baseUrl?: string;
  /** Inject mock `fetch` (for tests). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /**
   * Override `VOYAGE_API_KEY` env var (for tests). MUST be a valid Voyage key
   * in production (loaded from `~/.openclaw/credentials/voyage-api-key`).
   */
  apiKey?: string;
  /** Per-attempt timeout in ms. Default 60s. */
  timeoutMs?: number;
  /** Max retries on 5xx / network errors. Default 3 (4 attempts total). */
  maxRetries?: number;
}

export interface VoyageEmbedResult {
  /** Embeddings in same order as `texts`. */
  vectors: Float32Array[];
  /** Voyage server-reported token count for this batch. */
  totalTokens: number;
  /** Voyage model id echoed back. */
  model: string;
}

export interface VoyageRerankCandidate {
  /** Caller-supplied opaque id; passed through in result for joining. */
  id: string;
  /** Document text to rerank. */
  text: string;
}

export interface VoyageRerankOptions {
  model: VoyageRerankerModel;
  query: string;
  candidates: VoyageRerankCandidate[];
  /** How many top results to return. Default = candidates.length. */
  topK?: number;
  baseUrl?: string;
  fetch?: typeof fetch;
  apiKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
}

export interface VoyageRerankItem {
  /** Caller-supplied id, joined back from candidates. */
  id: string;
  /** Original index in `candidates` (Voyage returns this). */
  index: number;
  /** Relevance score, higher is better. */
  score: number;
}

export interface VoyageRerankResult {
  /** Sorted by `score` descending. */
  results: VoyageRerankItem[];
  totalTokens: number;
  model: string;
}

/**
 * Thrown for any Voyage HTTP error (4xx or exhausted retries on 5xx). The
 * `kind` discriminates how the caller should react:
 *
 *  - `auth`: 401/403. Caller should stop, surface to operator. Don't retry.
 *  - `bad_request`: 400. Likely caller bug (over-cap doc, malformed input).
 *      Don't retry; caller may suppress the offending doc and continue.
 *  - `rate_limit`: 429 after exhausted retries. Caller should park the
 *      backfill cron until {@link retryAfterMs} elapses.
 *  - `server_error`: 5xx after exhausted retries. Caller should requeue
 *      and try again later.
 *  - `network`: fetch threw (connection refused, DNS, timeout). Same
 *      treatment as `server_error`.
 *  - `unexpected`: malformed Voyage response (missing `data`, wrong shape).
 *      Bug in Voyage or in this client; caller should surface to operator.
 */
export class VoyageError extends Error {
  constructor(
    public readonly kind:
      | "auth"
      | "bad_request"
      | "rate_limit"
      | "server_error"
      | "network"
      | "unexpected",
    message: string,
    public readonly status?: number,
    public readonly retryAfterMs?: number,
    public readonly responseBody?: string,
  ) {
    super(message);
    this.name = "VoyageError";
  }
}

/**
 * Embed a batch of texts. Caller is responsible for token budget pre-checks.
 * Throws {@link VoyageError} on failure (no silent fallback to empty vectors).
 */
export async function embedTexts(opts: VoyageEmbedOptions): Promise<VoyageEmbedResult> {
  if (opts.texts.length === 0) {
    return { vectors: [], totalTokens: 0, model: opts.model };
  }

  const apiKey = resolveApiKey(opts.apiKey);
  const baseUrl = opts.baseUrl ?? VOYAGE_API_BASE;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = `${baseUrl}/embeddings`;

  const body: Record<string, unknown> = {
    model: opts.model,
    input: opts.texts,
    truncation: false,
  };
  if (opts.inputType !== null) {
    body.input_type = opts.inputType;
  }

  const response = await postWithRetry(
    fetchImpl,
    url,
    apiKey,
    body,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    opts.texts.length,
  );

  const json = (await response.json()) as VoyageEmbeddingsResponse;
  if (!Array.isArray(json.data) || json.data.length !== opts.texts.length) {
    throw new VoyageError(
      "unexpected",
      `voyage_unexpected: embeddings response shape — expected data[${opts.texts.length}], got ${
        Array.isArray(json.data) ? `data[${json.data.length}]` : "no data array"
      }`,
      response.status,
    );
  }

  const dims = json.data[0]?.embedding?.length ?? 0;
  const vectors: Float32Array[] = new Array(opts.texts.length);
  // Voyage may return data out of order in pathological cases; index by `index` field.
  for (const item of json.data) {
    if (!Array.isArray(item.embedding) || item.embedding.length !== dims) {
      throw new VoyageError(
        "unexpected",
        `voyage_unexpected: dimension mismatch in batch (expected ${dims}, got ${
          Array.isArray(item.embedding) ? item.embedding.length : "non-array"
        })`,
        response.status,
      );
    }
    if (typeof item.index !== "number" || item.index < 0 || item.index >= opts.texts.length) {
      throw new VoyageError(
        "unexpected",
        `voyage_unexpected: bad index ${String(item.index)} (batch size ${opts.texts.length})`,
        response.status,
      );
    }
    vectors[item.index] = Float32Array.from(item.embedding);
  }
  for (let i = 0; i < vectors.length; i++) {
    if (!vectors[i]) {
      throw new VoyageError(
        "unexpected",
        `voyage_unexpected: missing embedding for index ${i}`,
        response.status,
      );
    }
  }

  return {
    vectors,
    totalTokens: typeof json.usage?.total_tokens === "number" ? json.usage.total_tokens : 0,
    model: typeof json.model === "string" ? json.model : opts.model,
  };
}

/**
 * Rerank candidates by relevance to query. Returns top-K sorted by score.
 */
export async function rerankCandidates(
  opts: VoyageRerankOptions,
): Promise<VoyageRerankResult> {
  if (opts.candidates.length === 0) {
    return { results: [], totalTokens: 0, model: opts.model };
  }

  const apiKey = resolveApiKey(opts.apiKey);
  const baseUrl = opts.baseUrl ?? VOYAGE_API_BASE;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const url = `${baseUrl}/rerank`;

  const body: Record<string, unknown> = {
    model: opts.model,
    query: opts.query,
    documents: opts.candidates.map((c) => c.text),
    top_k: opts.topK ?? opts.candidates.length,
    truncation: false,
  };

  const response = await postWithRetry(
    fetchImpl,
    url,
    apiKey,
    body,
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    opts.maxRetries ?? DEFAULT_MAX_RETRIES,
    opts.candidates.length,
  );

  const json = (await response.json()) as VoyageRerankResponse;
  if (!Array.isArray(json.data)) {
    throw new VoyageError(
      "unexpected",
      "voyage_unexpected: rerank response missing data array",
      response.status,
    );
  }

  const items: VoyageRerankItem[] = json.data.map((item) => {
    if (
      typeof item.index !== "number" ||
      item.index < 0 ||
      item.index >= opts.candidates.length ||
      typeof item.relevance_score !== "number"
    ) {
      throw new VoyageError(
        "unexpected",
        `voyage_unexpected: bad rerank item (index=${String(item.index)}, score=${String(item.relevance_score)})`,
        response.status,
      );
    }
    return {
      id: opts.candidates[item.index].id,
      index: item.index,
      score: item.relevance_score,
    };
  });
  // Voyage docs say they return sorted descending; sort defensively.
  items.sort((a, b) => b.score - a.score);

  return {
    results: items,
    totalTokens: typeof json.usage?.total_tokens === "number" ? json.usage.total_tokens : 0,
    model: typeof json.model === "string" ? json.model : opts.model,
  };
}

// ---------- internals ----------

interface VoyageEmbeddingItem {
  embedding: number[];
  index: number;
  object?: string;
}
interface VoyageEmbeddingsResponse {
  data?: VoyageEmbeddingItem[];
  model?: string;
  usage?: { total_tokens?: number };
}
interface VoyageRerankItemRaw {
  index: number;
  relevance_score: number;
  document?: string;
}
interface VoyageRerankResponse {
  data?: VoyageRerankItemRaw[];
  model?: string;
  usage?: { total_tokens?: number };
}

function resolveApiKey(explicit: string | undefined): string {
  const key = (explicit ?? process.env.VOYAGE_API_KEY ?? "").trim();
  if (!key) {
    throw new VoyageError(
      "auth",
      "voyage_auth: VOYAGE_API_KEY is empty (set env or pass `apiKey` option)",
    );
  }
  return key;
}

async function postWithRetry(
  fetchImpl: typeof fetch,
  url: string,
  apiKey: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  maxRetries: number,
  inputCount: number,
): Promise<Response> {
  let lastErr: VoyageError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e: unknown) {
      lastErr = new VoyageError(
        "network",
        `voyage_network: ${e instanceof Error ? e.message : String(e)} (attempt ${attempt + 1}/${maxRetries + 1})`,
      );
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (response.ok) {
      return response;
    }

    const status = response.status;
    const bodyText = await safeReadBody(response);

    if (status === 401 || status === 403) {
      throw new VoyageError(
        "auth",
        `voyage_auth: ${status} (check VOYAGE_API_KEY)`,
        status,
        undefined,
        bodyText,
      );
    }
    if (status === 400) {
      throw new VoyageError(
        "bad_request",
        `voyage_400: bad request on ${inputCount} inputs (${summarizeBody(bodyText)})`,
        status,
        undefined,
        bodyText,
      );
    }
    if (status === 429) {
      const retryAfterMs = parseRetryAfterMs(response.headers.get("Retry-After"));
      lastErr = new VoyageError(
        "rate_limit",
        `voyage_429: rate limited (attempt ${attempt + 1}/${maxRetries + 1})`,
        status,
        retryAfterMs,
        bodyText,
      );
      if (attempt < maxRetries) {
        // Honor server hint if present; else exponential backoff.
        await sleep(retryAfterMs ?? backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }
    if (status >= 500 && status < 600) {
      lastErr = new VoyageError(
        "server_error",
        `voyage_5xx: ${status} (attempt ${attempt + 1}/${maxRetries + 1})`,
        status,
        undefined,
        bodyText,
      );
      if (attempt < maxRetries) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw lastErr;
    }
    // Some other 4xx — treat as bad_request, no retry.
    throw new VoyageError(
      "bad_request",
      `voyage_4xx: ${status} ${summarizeBody(bodyText)}`,
      status,
      undefined,
      bodyText,
    );
  }

  // Exhausted loop without throwing or returning — should be unreachable
  // because every code path in the loop either returns or throws on the
  // last attempt. Defensive throw.
  throw lastErr ?? new VoyageError("unexpected", "voyage_unexpected: postWithRetry exited loop");
}

async function safeReadBody(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.length > 800 ? text.slice(0, 800) + "…(truncated)" : text;
  } catch {
    return "";
  }
}

function summarizeBody(body: string): string {
  // Avoid echoing input back to logs / errors. Voyage 400 responses sometimes
  // include the offending input in the error message.
  if (body.includes('"input"') || body.includes('"texts"') || body.includes('"documents"')) {
    return "input echoed in error body — suppressed for privacy";
  }
  return body.slice(0, 200);
}

function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  // Voyage may send seconds (numeric) or HTTP-date.
  const asNum = Number.parseFloat(header);
  if (Number.isFinite(asNum) && asNum >= 0) {
    return Math.min(asNum * 1000, BACKOFF_CAP_MS);
  }
  const asDate = Date.parse(header);
  if (Number.isFinite(asDate)) {
    const ms = asDate - Date.now();
    return ms > 0 ? Math.min(ms, BACKOFF_CAP_MS) : undefined;
  }
  return undefined;
}

function backoffMs(attempt: number): number {
  // Exponential: 500, 1000, 2000, 4000, ... capped at 30s.
  const ms = BACKOFF_BASE_MS * 2 ** attempt;
  return Math.min(ms, BACKOFF_CAP_MS);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
