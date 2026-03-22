/**
 * Tests for EmbeddingQueue batching, retry, drain, and shutdown semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmbeddingQueue, type QueueableDb } from "../src/embedding-queue.js";
import type { EmbeddingClient } from "../src/embeddings.js";

// ── Mocks ──────────────────────────────────────────────────────────────────

function createMockDb(opts?: {
  hasEmbedding?: boolean;
  partsRows?: Array<{ part_type: string; tool_name: string | null; tool_input: string | null; text_content: string | null }>;
}): QueueableDb {
  return {
    async run(_sql: string, _params: unknown[]) {
      return { lastInsertId: 1 };
    },
    async query<T>(_sql: string, _params: unknown[]): Promise<{ rows: T[] }> {
      if (_sql.includes("has_emb")) {
        return { rows: [{ has_emb: opts?.hasEmbedding ?? false }] as T[] };
      }
      if (_sql.includes("message_parts")) {
        return { rows: (opts?.partsRows ?? []) as T[] };
      }
      return { rows: [] };
    },
  };
}

function createMockEmbeddingClient(opts?: {
  shouldFail?: boolean;
  failCount?: number;
}): EmbeddingClient {
  let callCount = 0;
  const failCount = opts?.failCount ?? Infinity;

  return {
    isConfigured: () => true,
    embedOne: async (text: string) => {
      callCount++;
      if (opts?.shouldFail && callCount <= failCount) {
        throw new Error("API error");
      }
      return new Array(1536).fill(0.1);
    },
    embed: async (texts: string[]) => {
      callCount++;
      if (opts?.shouldFail && callCount <= failCount) {
        throw new Error("API batch error");
      }
      return texts.map(() => new Array(1536).fill(0.1));
    },
  } as unknown as EmbeddingClient;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("EmbeddingQueue", () => {
  let queue: EmbeddingQueue;

  afterEach(async () => {
    if (queue) await queue.stop();
  });

  it("enqueues items and tracks pending count", () => {
    const db = createMockDb();
    const client = createMockEmbeddingClient();
    queue = new EmbeddingQueue(client, db, { flushIntervalMs: 60_000 });

    queue.enqueue("messages", 1, "hello world");
    queue.enqueue("messages", 2, "another message");
    expect(queue.pending).toBe(2);
  });

  it("skips empty-content summaries", () => {
    const db = createMockDb();
    const client = createMockEmbeddingClient();
    queue = new EmbeddingQueue(client, db, { flushIntervalMs: 60_000 });

    queue.enqueue("summaries", "sum_001", "");
    queue.enqueue("summaries", "sum_002", "   ");
    expect(queue.pending).toBe(0);
  });

  it("allows empty-content messages (synthesize from parts)", () => {
    const db = createMockDb();
    const client = createMockEmbeddingClient();
    const log = vi.fn();
    queue = new EmbeddingQueue(client, db, { flushIntervalMs: 60_000, log });

    queue.enqueue("messages", 1, "");
    expect(queue.pending).toBe(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("enqueued empty-content message 1"),
    );
  });

  it("drain() processes all items across multiple batches", async () => {
    const db = createMockDb();
    const embedCalls: number[] = [];
    const client = {
      isConfigured: () => true,
      embed: async (texts: string[]) => {
        embedCalls.push(texts.length);
        return texts.map(() => new Array(1536).fill(0.1));
      },
    } as unknown as EmbeddingClient;

    queue = new EmbeddingQueue(client, db, {
      flushIntervalMs: 60_000,
      batchSize: 3,
    });

    // Enqueue 8 items — should need 3 batches (3 + 3 + 2)
    for (let i = 0; i < 8; i++) {
      queue.enqueue("messages", i + 1, `message ${i}`);
    }
    expect(queue.pending).toBe(8);

    await queue.drain();
    expect(queue.pending).toBe(0);
    expect(embedCalls).toEqual([3, 3, 2]);
  });

  it("stop() drains all items before stopping", async () => {
    const db = createMockDb();
    let embedded = 0;
    const client = {
      isConfigured: () => true,
      embed: async (texts: string[]) => {
        embedded += texts.length;
        return texts.map(() => new Array(1536).fill(0.1));
      },
    } as unknown as EmbeddingClient;

    queue = new EmbeddingQueue(client, db, {
      flushIntervalMs: 60_000,
      batchSize: 5,
    });
    queue.start();

    for (let i = 0; i < 12; i++) {
      queue.enqueue("messages", i + 1, `message ${i}`);
    }

    await queue.stop();
    expect(embedded).toBe(12);
    expect(queue.pending).toBe(0);
  });

  it("drain() clears retry delays so backoff-delayed items are processed", async () => {
    const db = createMockDb();
    let callCount = 0;
    const client = {
      isConfigured: () => true,
      embed: async (texts: string[]) => {
        callCount++;
        if (callCount === 1) throw new Error("transient failure");
        return texts.map(() => new Array(1536).fill(0.1));
      },
    } as unknown as EmbeddingClient;

    queue = new EmbeddingQueue(client, db, {
      flushIntervalMs: 60_000,
      batchSize: 100,
      baseRetryDelayMs: 60_000, // Long delay — drain should override
    });

    queue.enqueue("messages", 1, "will fail first");

    // First flush fails, items re-enqueued with 60s delay
    // @ts-expect-error - accessing private method for testing
    await queue.flush();
    expect(queue.pending).toBe(1);

    // drain() should clear the delay and process immediately
    await queue.drain();
    expect(queue.pending).toBe(0);
  });

  it("gives up after maxRetries and logs", async () => {
    const db = createMockDb();
    const log = vi.fn();
    const client = {
      isConfigured: () => true,
      embed: async () => {
        throw new Error("persistent failure");
      },
    } as unknown as EmbeddingClient;

    queue = new EmbeddingQueue(client, db, {
      flushIntervalMs: 60_000,
      maxRetries: 2,
      baseRetryDelayMs: 0,
      log,
    });

    queue.enqueue("messages", 1, "doomed message");

    // Flush 3 times: initial + 2 retries = gives up
    for (let i = 0; i < 4; i++) {
      // @ts-expect-error - private method
      await queue.flush();
    }

    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("Giving up on messages/1 after 2 retries"),
    );
    expect(queue.pending).toBe(0);
  });

  it("deduplicates items that already have embeddings", async () => {
    const db = createMockDb({ hasEmbedding: true });
    let embedCalled = false;
    const client = {
      isConfigured: () => true,
      embed: async (texts: string[]) => {
        embedCalled = true;
        return texts.map(() => new Array(1536).fill(0.1));
      },
    } as unknown as EmbeddingClient;

    queue = new EmbeddingQueue(client, db, { flushIntervalMs: 60_000 });
    queue.enqueue("messages", 1, "already embedded");

    await queue.drain();
    expect(embedCalled).toBe(false);
    expect(queue.pending).toBe(0);
  });

  it("synthesizes embedding text from message parts for empty content", async () => {
    const partsRows = [
      { part_type: "tool", tool_name: "exec", tool_input: '{"command":"ls"}', text_content: null },
      { part_type: "text", tool_name: null, tool_input: null, text_content: "some output" },
    ];
    const db = createMockDb({ partsRows });

    let embeddedTexts: string[] = [];
    const client = {
      isConfigured: () => true,
      embed: async (texts: string[]) => {
        embeddedTexts = texts;
        return texts.map(() => new Array(1536).fill(0.1));
      },
    } as unknown as EmbeddingClient;

    queue = new EmbeddingQueue(client, db, { flushIntervalMs: 60_000 });
    queue.enqueue("messages", 42, "");

    await queue.drain();
    expect(embeddedTexts).toHaveLength(1);
    expect(embeddedTexts[0]).toContain("tool:exec");
    expect(embeddedTexts[0]).toContain("command=ls");
  });
});
