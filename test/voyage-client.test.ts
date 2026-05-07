import { describe, expect, it } from "vitest";
import {
  embedTexts,
  MAX_TOKENS_PER_EMBED_BATCH,
  MAX_TOKENS_PER_EMBED_DOC,
  MAX_TOKENS_PER_RERANK_CALL,
  rerankCandidates,
  VoyageError,
} from "../src/voyage/client.js";

/**
 * Voyage HTTP client — covered with mock fetch only. No live API calls.
 * Live calls happen in the backfill cron tests with explicit env-gated
 * `VOYAGE_API_KEY` (B.04) so CI never hits the network.
 */

function mockResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  const headers = new Headers({ "Content-Type": "application/json", ...(init.headers ?? {}) });
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers });
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>): typeof fetch {
  // The real `fetch` signature accepts string | URL | Request; tests only ever
  // pass string URLs from this client.
  return impl as unknown as typeof fetch;
}

describe("voyage client — token budget constants (v4.1 §13)", () => {
  it("MAX_TOKENS_PER_EMBED_BATCH is 80K (Voyage server cap 120K minus tokenizer-mismatch margin)", () => {
    expect(MAX_TOKENS_PER_EMBED_BATCH).toBe(80_000);
  });
  it("MAX_TOKENS_PER_EMBED_DOC is 30K (voyage-4-large per-doc cap is 32K)", () => {
    expect(MAX_TOKENS_PER_EMBED_DOC).toBe(30_000);
  });
  it("MAX_TOKENS_PER_RERANK_CALL is 600K (Voyage rerank-2.5 limit)", () => {
    expect(MAX_TOKENS_PER_RERANK_CALL).toBe(600_000);
  });
});

describe("voyage client — embedTexts happy path", () => {
  it("posts texts to /embeddings with input_type, returns parsed Float32 vectors", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetch = mockFetch(async (url, init) => {
      captured = { url, init };
      return mockResponse({
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 0, object: "embedding" },
          { embedding: [0.4, 0.5, 0.6], index: 1, object: "embedding" },
        ],
        model: "voyage-4-large",
        usage: { total_tokens: 42 },
      });
    });

    const result = await embedTexts({
      model: "voyage-4-large",
      texts: ["hello", "world"],
      inputType: "document",
      apiKey: "test-key",
      fetch,
    });

    expect(result.vectors).toHaveLength(2);
    expect(result.vectors[0]).toBeInstanceOf(Float32Array);
    expect(Array.from(result.vectors[0])).toEqual([
      0.1, // narrow to f32 precision
    ].map((n) => Float32Array.from([n])[0]).concat(
      [0.2, 0.3].map((n) => Float32Array.from([n])[0]),
    ));
    expect(result.totalTokens).toBe(42);
    expect(result.model).toBe("voyage-4-large");

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(captured!.init.method).toBe("POST");
    const headers = captured!.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(captured!.init.body as string);
    expect(body).toEqual({
      model: "voyage-4-large",
      input: ["hello", "world"],
      truncation: false,
      input_type: "document",
    });
  });

  it("omits input_type when null (Voyage default)", async () => {
    let captured: RequestInit | null = null;
    const fetch = mockFetch(async (_url, init) => {
      captured = init;
      return mockResponse({
        data: [{ embedding: [1, 2], index: 0 }],
        usage: { total_tokens: 1 },
      });
    });
    await embedTexts({
      model: "voyage-4-large",
      texts: ["x"],
      inputType: null,
      apiKey: "k",
      fetch,
    });
    const body = JSON.parse(captured!.body as string);
    expect(body.input_type).toBeUndefined();
  });

  it("re-orders out-of-order responses by `index` field", async () => {
    const fetch = mockFetch(async () =>
      mockResponse({
        data: [
          // Voyage might (in theory) return out of order
          { embedding: [0.9, 0.9], index: 1 },
          { embedding: [0.1, 0.1], index: 0 },
        ],
        usage: { total_tokens: 2 },
      }),
    );
    const result = await embedTexts({
      model: "voyage-4-large",
      texts: ["first", "second"],
      inputType: "query",
      apiKey: "k",
      fetch,
    });
    expect(Array.from(result.vectors[0])).toEqual(Array.from(Float32Array.from([0.1, 0.1])));
    expect(Array.from(result.vectors[1])).toEqual(Array.from(Float32Array.from([0.9, 0.9])));
  });

  it("returns empty result for empty input without calling fetch", async () => {
    let called = 0;
    const fetch = mockFetch(async () => {
      called++;
      return mockResponse({});
    });
    const result = await embedTexts({
      model: "voyage-4-large",
      texts: [],
      inputType: "query",
      apiKey: "k",
      fetch,
    });
    expect(called).toBe(0);
    expect(result.vectors).toEqual([]);
    expect(result.totalTokens).toBe(0);
  });

  it("sends `truncation: false` always (lossless guarantee — never silently clip)", async () => {
    let body: Record<string, unknown> | null = null;
    const fetch = mockFetch(async (_url, init) => {
      body = JSON.parse(init.body as string);
      return mockResponse({ data: [{ embedding: [0], index: 0 }], usage: { total_tokens: 1 } });
    });
    await embedTexts({
      model: "voyage-4-large",
      texts: ["x"],
      inputType: "document",
      apiKey: "k",
      fetch,
    });
    expect(body!.truncation).toBe(false);
  });
});

describe("voyage client — embedTexts error handling", () => {
  it("throws VoyageError(auth) on 401 — does not retry", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls++;
      return mockResponse({ error: "bad key" }, { status: 401 });
    });
    await expect(
      embedTexts({
        model: "voyage-4-large",
        texts: ["x"],
        inputType: "document",
        apiKey: "k",
        fetch,
        maxRetries: 3,
      }),
    ).rejects.toMatchObject({ name: "VoyageError", kind: "auth", status: 401 });
    expect(calls).toBe(1);
  });

  it("throws VoyageError(bad_request) on 400 — does not retry, suppresses input echo", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls++;
      return mockResponse(
        // Voyage 400 sometimes echoes input — should not appear in error message
        { error: "input too long", input: "secret payload that should not leak" },
        { status: 400 },
      );
    });
    let caught: VoyageError | null = null;
    try {
      await embedTexts({
        model: "voyage-4-large",
        texts: ["x"],
        inputType: "document",
        apiKey: "k",
        fetch,
        maxRetries: 3,
      });
    } catch (e) {
      caught = e as VoyageError;
    }
    expect(calls).toBe(1);
    expect(caught?.kind).toBe("bad_request");
    expect(caught?.status).toBe(400);
    // Error message should NOT contain the secret
    expect(caught?.message).not.toContain("secret payload");
    // ResponseBody field is preserved for caller to log carefully if needed
    expect(caught?.responseBody).toContain("secret payload");
  });

  it("throws VoyageError(rate_limit) on persistent 429, exposes Retry-After in ms", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls++;
      return mockResponse({ error: "slow down" }, {
        status: 429,
        headers: { "Retry-After": "2" },
      });
    });
    let caught: VoyageError | null = null;
    try {
      await embedTexts({
        model: "voyage-4-large",
        texts: ["x"],
        inputType: "document",
        apiKey: "k",
        fetch,
        maxRetries: 0, // no retries — surface immediately
      });
    } catch (e) {
      caught = e as VoyageError;
    }
    expect(calls).toBe(1);
    expect(caught?.kind).toBe("rate_limit");
    expect(caught?.status).toBe(429);
    expect(caught?.retryAfterMs).toBe(2000);
  });

  it("retries on 5xx then succeeds — caller never sees the transient failure", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls++;
      if (calls < 3) {
        return mockResponse({ error: "internal" }, { status: 503 });
      }
      return mockResponse({
        data: [{ embedding: [0.5], index: 0 }],
        usage: { total_tokens: 1 },
      });
    });
    const result = await embedTexts({
      model: "voyage-4-large",
      texts: ["x"],
      inputType: "document",
      apiKey: "k",
      fetch,
      maxRetries: 3,
    });
    expect(calls).toBe(3); // failed twice, succeeded on third
    expect(result.vectors).toHaveLength(1);
  });

  it("throws VoyageError(server_error) when retries exhausted on 5xx", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls++;
      return mockResponse({ error: "internal" }, { status: 500 });
    });
    let caught: VoyageError | null = null;
    try {
      await embedTexts({
        model: "voyage-4-large",
        texts: ["x"],
        inputType: "document",
        apiKey: "k",
        fetch,
        maxRetries: 1,
      });
    } catch (e) {
      caught = e as VoyageError;
    }
    expect(calls).toBe(2); // initial + 1 retry
    expect(caught?.kind).toBe("server_error");
    expect(caught?.status).toBe(500);
  });

  it("throws VoyageError(network) when fetch itself throws", async () => {
    let calls = 0;
    const fetch = mockFetch(async () => {
      calls++;
      throw new Error("ECONNREFUSED");
    });
    let caught: VoyageError | null = null;
    try {
      await embedTexts({
        model: "voyage-4-large",
        texts: ["x"],
        inputType: "document",
        apiKey: "k",
        fetch,
        maxRetries: 0,
      });
    } catch (e) {
      caught = e as VoyageError;
    }
    expect(calls).toBe(1);
    expect(caught?.kind).toBe("network");
    expect(caught?.message).toContain("ECONNREFUSED");
  });

  it("throws VoyageError(auth) when no API key is set anywhere", async () => {
    const originalKey = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    try {
      await expect(
        embedTexts({
          model: "voyage-4-large",
          texts: ["x"],
          inputType: "document",
          fetch: mockFetch(async () => mockResponse({})),
        }),
      ).rejects.toMatchObject({ name: "VoyageError", kind: "auth" });
    } finally {
      if (originalKey !== undefined) process.env.VOYAGE_API_KEY = originalKey;
    }
  });

  it("throws VoyageError(unexpected) when response data length doesn't match input", async () => {
    const fetch = mockFetch(async () =>
      mockResponse({
        data: [{ embedding: [0.5], index: 0 }], // sent 2 texts, got 1 back
        usage: { total_tokens: 1 },
      }),
    );
    await expect(
      embedTexts({
        model: "voyage-4-large",
        texts: ["a", "b"],
        inputType: "document",
        apiKey: "k",
        fetch,
      }),
    ).rejects.toMatchObject({ name: "VoyageError", kind: "unexpected" });
  });

  it("throws VoyageError(unexpected) on dimension mismatch within batch", async () => {
    const fetch = mockFetch(async () =>
      mockResponse({
        data: [
          { embedding: [0.1, 0.2, 0.3], index: 0 },
          { embedding: [0.4, 0.5], index: 1 }, // wrong dim
        ],
        usage: { total_tokens: 2 },
      }),
    );
    await expect(
      embedTexts({
        model: "voyage-4-large",
        texts: ["a", "b"],
        inputType: "document",
        apiKey: "k",
        fetch,
      }),
    ).rejects.toMatchObject({ name: "VoyageError", kind: "unexpected" });
  });
});

describe("voyage client — rerankCandidates", () => {
  it("posts to /rerank with documents + topK, joins ids back from candidates", async () => {
    let captured: RequestInit | null = null;
    const fetch = mockFetch(async (_url, init) => {
      captured = init;
      return mockResponse({
        data: [
          { index: 1, relevance_score: 0.9 },
          { index: 0, relevance_score: 0.4 },
        ],
        model: "rerank-2.5",
        usage: { total_tokens: 100 },
      });
    });

    const result = await rerankCandidates({
      model: "rerank-2.5",
      query: "what is foo?",
      candidates: [
        { id: "leaf_a", text: "doc A about foo" },
        { id: "leaf_b", text: "doc B about bar" },
      ],
      topK: 2,
      apiKey: "k",
      fetch,
    });

    expect(result.results).toHaveLength(2);
    // Sorted descending by score
    expect(result.results[0]).toEqual({ id: "leaf_b", index: 1, score: 0.9 });
    expect(result.results[1]).toEqual({ id: "leaf_a", index: 0, score: 0.4 });

    const body = JSON.parse(captured!.body as string);
    expect(body.model).toBe("rerank-2.5");
    expect(body.query).toBe("what is foo?");
    expect(body.documents).toEqual(["doc A about foo", "doc B about bar"]);
    expect(body.top_k).toBe(2);
    expect(body.truncation).toBe(false);
  });

  it("defaults top_k to candidates.length when not supplied", async () => {
    let captured: RequestInit | null = null;
    const fetch = mockFetch(async (_url, init) => {
      captured = init;
      return mockResponse({
        data: [{ index: 0, relevance_score: 0.5 }],
        usage: { total_tokens: 1 },
      });
    });
    await rerankCandidates({
      model: "rerank-2.5",
      query: "q",
      candidates: [{ id: "x", text: "y" }],
      apiKey: "k",
      fetch,
    });
    const body = JSON.parse(captured!.body as string);
    expect(body.top_k).toBe(1);
  });

  it("returns empty result for empty candidates without calling fetch", async () => {
    let called = 0;
    const fetch = mockFetch(async () => {
      called++;
      return mockResponse({});
    });
    const result = await rerankCandidates({
      model: "rerank-2.5",
      query: "q",
      candidates: [],
      apiKey: "k",
      fetch,
    });
    expect(called).toBe(0);
    expect(result.results).toEqual([]);
  });

  it("throws VoyageError(unexpected) when reranker returns invalid index", async () => {
    const fetch = mockFetch(async () =>
      mockResponse({
        data: [{ index: 99, relevance_score: 0.5 }], // out of range
        usage: { total_tokens: 1 },
      }),
    );
    await expect(
      rerankCandidates({
        model: "rerank-2.5",
        query: "q",
        candidates: [{ id: "a", text: "b" }],
        apiKey: "k",
        fetch,
      }),
    ).rejects.toMatchObject({ name: "VoyageError", kind: "unexpected" });
  });
});

describe("voyage client — picks up VOYAGE_API_KEY env var", () => {
  it("uses process.env.VOYAGE_API_KEY when no apiKey opt provided", async () => {
    const originalKey = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = "from-env-test";
    try {
      let captured: Record<string, string> | null = null;
      const fetch = mockFetch(async (_url, init) => {
        captured = init.headers as Record<string, string>;
        return mockResponse({
          data: [{ embedding: [0], index: 0 }],
          usage: { total_tokens: 1 },
        });
      });
      await embedTexts({
        model: "voyage-4-large",
        texts: ["x"],
        inputType: "document",
        fetch,
      });
      expect(captured!.Authorization).toBe("Bearer from-env-test");
    } finally {
      if (originalKey === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = originalKey;
    }
  });
});
