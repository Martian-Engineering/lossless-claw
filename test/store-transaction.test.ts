/**
 * Tests for AsyncLocalStorage-based transaction safety in ConversationStore
 * and SummaryStore.
 *
 * Verifies that:
 * - Transactions properly scope the DB client via ALS
 * - Concurrent operations on shared store singletons don't cross-contaminate
 * - Nested withTransaction calls reuse the existing transaction
 * - withClient scopes queries to the provided client
 * - withSharedTransaction exposes the txClient for cross-store use
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLcmConnection, closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const tempDirs: string[] = [];

function setupTestDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-store-txn-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "test.db");
  const sqliteDb = getLcmConnection(dbPath);
  const features = getLcmDbFeatures("sqlite", sqliteDb);
  runLcmMigrations(sqliteDb, { fullTextAvailable: features.fullTextAvailable });
  const db = createLcmConnection({ backend: "sqlite", databasePath: dbPath } as any);
  return { db, dbPath, features };
}

afterEach(async () => {
  await closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ConversationStore transaction safety", () => {
  it("withTransaction scopes queries to the transaction client", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    // Create a conversation inside a transaction
    const conv = await store.withTransaction(async () => {
      return store.createConversation({ sessionId: "txn-test" });
    });
    expect(conv.sessionId).toBe("txn-test");

    // Verify it's visible outside the transaction
    const fetched = await store.getConversation(conv.conversationId);
    expect(fetched).not.toBeNull();
    expect(fetched!.sessionId).toBe("txn-test");
  });

  it("withTransaction rolls back on error", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    try {
      await store.withTransaction(async () => {
        await store.createConversation({ sessionId: "rollback-test" });
        throw new Error("deliberate failure");
      });
    } catch {
      // Expected
    }

    // Conversation should not exist after rollback
    const fetched = await store.getConversationBySessionId("rollback-test");
    expect(fetched).toBeNull();
  });

  it("nested withTransaction reuses existing transaction (no double-begin)", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await store.withTransaction(async () => {
      // Nested transaction — should just run inline
      return store.withTransaction(async () => {
        return store.createConversation({ sessionId: "nested-test" });
      });
    });

    expect(conv.sessionId).toBe("nested-test");
    const fetched = await store.getConversation(conv.conversationId);
    expect(fetched).not.toBeNull();
  });

  it("concurrent async operations on shared store don't cross-contaminate", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    // Create two conversations
    const conv1 = await store.createConversation({ sessionId: "session-1" });
    const conv2 = await store.createConversation({ sessionId: "session-2" });

    // Create messages in both conversations
    await store.createMessage({
      conversationId: conv1.conversationId,
      seq: 1,
      role: "user",
      content: "hello from session 1",
      tokenCount: 5,
    });
    await store.createMessage({
      conversationId: conv2.conversationId,
      seq: 1,
      role: "user",
      content: "hello from session 2",
      tokenCount: 5,
    });

    // Run concurrent reads on the shared store instance — verifies that
    // ALS scoping doesn't leak state between interleaved async operations.
    // (Note: SQLite serializes at the connection level, so true concurrent
    // transactions require Postgres. This test verifies the ALS getter
    // returns the correct client in each async context.)
    const [msgs1, msgs2] = await Promise.all([
      store.getMessages(conv1.conversationId),
      store.getMessages(conv2.conversationId),
    ]);

    expect(msgs1).toHaveLength(1);
    expect(msgs1[0].content).toBe("hello from session 1");
    expect(msgs2).toHaveLength(1);
    expect(msgs2[0].content).toBe("hello from session 2");
  });
});

describe("SummaryStore transaction safety", () => {
  it("withTransaction scopes queries to the transaction client", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await convStore.createConversation({ sessionId: "sum-txn" });

    const summary = await sumStore.withTransaction(async () => {
      return sumStore.insertSummary({
        summaryId: "sum_test_001",
        conversationId: conv.conversationId,
        kind: "leaf",
        content: "test summary content",
        tokenCount: 10,
      });
    });

    expect(summary.summaryId).toBe("sum_test_001");
    const fetched = await sumStore.getSummary("sum_test_001");
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("test summary content");
  });

  it("withClient scopes to provided client", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await convStore.createConversation({ sessionId: "client-scope" });

    // Use withSharedTransaction to get a txClient, pass to sumStore via withClient
    await convStore.withSharedTransaction(async (txClient) => {
      await sumStore.withClient(txClient, async () => {
        await sumStore.insertSummary({
          summaryId: "sum_shared_001",
          conversationId: conv.conversationId,
          kind: "leaf",
          content: "shared txn content",
          tokenCount: 8,
        });
      });
    });

    const fetched = await sumStore.getSummary("sum_shared_001");
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe("shared txn content");
  });
});

describe("ConversationStore withSharedTransaction", () => {
  it("exposes txClient to callback for cross-store use", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    // Create conversation + summary in a single shared transaction
    const conv = await convStore.withSharedTransaction(async (txClient) => {
      const c = await convStore.createConversation({ sessionId: "shared-txn" });
      await sumStore.withClient(txClient, async () => {
        await sumStore.insertSummary({
          summaryId: "sum_cross_001",
          conversationId: c.conversationId,
          kind: "leaf",
          content: "cross-store summary",
          tokenCount: 5,
        });
      });
      return c;
    });

    expect(conv.sessionId).toBe("shared-txn");
    const summary = await sumStore.getSummary("sum_cross_001");
    expect(summary).not.toBeNull();
  });

  it("rolls back both stores on error", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    // Pre-create a conversation (outside the failing txn)
    const conv = await convStore.createConversation({ sessionId: "rollback-both" });

    try {
      await convStore.withSharedTransaction(async (txClient) => {
        await convStore.createMessage({
          conversationId: conv.conversationId,
          seq: 1,
          role: "user",
          content: "should be rolled back",
          tokenCount: 5,
        });
        await sumStore.withClient(txClient, async () => {
          await sumStore.insertSummary({
            summaryId: "sum_rollback_001",
            conversationId: conv.conversationId,
            kind: "leaf",
            content: "also rolled back",
            tokenCount: 5,
          });
        });
        throw new Error("deliberate cross-store failure");
      });
    } catch {
      // Expected
    }

    const msgs = await convStore.getMessages(conv.conversationId);
    expect(msgs).toHaveLength(0);
    const summary = await sumStore.getSummary("sum_rollback_001");
    expect(summary).toBeNull();
  });
});
