/**
 * Regression tests for cross-session transaction mutex.
 *
 * Reproduces https://github.com/Martian-Engineering/lossless-claw/issues/260
 *
 * The root cause: multiple async operations (from different sessions) share
 * one DatabaseSync handle. Without serialization, concurrent async transactions
 * cause "cannot start a transaction within a transaction" errors because
 * SQLite's transaction state is per-connection, not per-session.
 *
 * These tests verify that the acquireTransactionLock mutex prevents nested
 * transaction failures when ConversationStore.withTransaction() and
 * SummaryStore.replaceContextRangeWithSummary() are called concurrently.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLcmDatabaseConnection, closeLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { acquireTransactionLock } from "../src/transaction-mutex.js";

const tempDirs: string[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

function createTestDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-txn-mutex-"));
  tempDirs.push(tempDir);
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  dbs.push(db);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return { db, fts5Available };
}

afterEach(() => {
  for (const db of dbs.splice(0)) {
    closeLcmConnection(db);
  }
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("transaction-mutex", () => {
  describe("acquireTransactionLock", () => {
    it("serializes concurrent transaction acquisitions on the same db", async () => {
      const { db } = createTestDb();
      const order: string[] = [];

      const op = async (label: string) => {
        const release = await acquireTransactionLock(db);
        order.push(`${label}:acquired`);
        // Simulate async work inside the lock
        await delay(20);
        order.push(`${label}:releasing`);
        release();
      };

      // Launch 3 concurrent lock acquisitions
      await Promise.all([op("A"), op("B"), op("C")]);

      // Each operation must fully complete before the next starts
      // (acquired→releasing pattern must be contiguous per operation)
      expect(order).toHaveLength(6);
      for (let i = 0; i < 6; i += 2) {
        const acqLabel = order[i]!.split(":")[0];
        const relLabel = order[i + 1]!.split(":")[0];
        expect(acqLabel).toBe(relLabel);
        expect(order[i]).toContain("acquired");
        expect(order[i + 1]).toContain("releasing");
      }
    });

    it("different databases get independent locks", async () => {
      const { db: db1 } = createTestDb();
      const { db: db2 } = createTestDb();
      const order: string[] = [];

      const op = async (label: string, db: typeof db1) => {
        const release = await acquireTransactionLock(db);
        order.push(`${label}:acquired`);
        await delay(30);
        order.push(`${label}:releasing`);
        release();
      };

      await Promise.all([op("db1", db1), op("db2", db2)]);

      // Both should acquire concurrently (interleaved), not serialized
      expect(order[0]).toContain("acquired");
      expect(order[1]).toContain("acquired");
    });
  });

  describe("ConversationStore.withTransaction concurrent safety", () => {
    it("does not throw nested-transaction errors with concurrent withTransaction calls", async () => {
      const { db, fts5Available } = createTestDb();
      const store = new ConversationStore(db, { fts5Available });

      // Create a conversation to operate on
      const conv = await store.createConversation({
        sessionId: "sess-1",
        sessionKey: "key-1",
      });

      let seq = 0;

      // Simulate what #260 describes: two different sessions both call
      // withTransaction concurrently on the same DB. Without the mutex,
      // the second BEGIN IMMEDIATE would fail.
      const results = await Promise.all([
        store.withTransaction(async () => {
          // Simulate bootstrap's heavy async work inside txn
          await delay(15);
          const s = ++seq;
          await store.createMessage({
            conversationId: conv.conversationId,
            seq: s,
            role: "user",
            content: "msg from session A",
            tokenCount: 5,
          });
          return "A";
        }),
        store.withTransaction(async () => {
          await delay(15);
          const s = ++seq;
          await store.createMessage({
            conversationId: conv.conversationId,
            seq: s,
            role: "assistant",
            content: "msg from session B",
            tokenCount: 5,
          });
          return "B";
        }),
        store.withTransaction(async () => {
          await delay(10);
          const s = ++seq;
          await store.createMessage({
            conversationId: conv.conversationId,
            seq: s,
            role: "user",
            content: "msg from session C",
            tokenCount: 5,
          });
          return "C";
        }),
      ]);

      // All three transactions should complete successfully
      expect(results).toContain("A");
      expect(results).toContain("B");
      expect(results).toContain("C");

      // All messages should be persisted
      const messages = await store.getMessages(conv.conversationId);
      expect(messages).toHaveLength(3);
    });

    it("propagates errors without deadlocking the mutex", async () => {
      const { db, fts5Available } = createTestDb();
      const store = new ConversationStore(db, { fts5Available });

      const error = new Error("intentional failure");

      // First transaction fails
      const p1 = store.withTransaction(async () => {
        await delay(10);
        throw error;
      });

      // Second transaction should still succeed after the first fails
      const p2 = store.withTransaction(async () => {
        await delay(5);
        return "ok";
      });

      await expect(p1).rejects.toThrow("intentional failure");
      await expect(p2).resolves.toBe("ok");
    });

    it("supports nested transaction scopes on the same async path", async () => {
      const { db, fts5Available } = createTestDb();
      const store = new ConversationStore(db, { fts5Available });
      const conv = await store.createConversation({
        sessionId: "sess-nested",
        sessionKey: "key-nested",
      });

      await expect(
        store.withTransaction(async () => {
          await store.createMessage({
            conversationId: conv.conversationId,
            seq: 1,
            role: "user",
            content: "outer txn message",
            tokenCount: 5,
          });

          await store.withTransaction(async () => {
            await store.createMessage({
              conversationId: conv.conversationId,
              seq: 2,
              role: "assistant",
              content: "inner txn message",
              tokenCount: 5,
            });
          });
        }),
      ).resolves.toBeUndefined();

      const messages = await store.getMessages(conv.conversationId);
      expect(messages).toHaveLength(2);
    });
  });

  describe("SummaryStore.replaceContextRangeWithSummary concurrent safety", () => {
    it("serializes concurrent replaceContextRangeWithSummary calls", async () => {
      const { db, fts5Available } = createTestDb();
      const convStore = new ConversationStore(db, { fts5Available });
      const summaryStore = new SummaryStore(db, { fts5Available });

      // Set up a conversation with some context items
      const conv = await convStore.createConversation({
        sessionId: "sess-1",
        sessionKey: "key-1",
      });

      // Add messages to create context items (which also creates context_items)
      for (let i = 0; i < 6; i++) {
        await convStore.createMessage({
          conversationId: conv.conversationId,
          seq: i,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i}`,
          tokenCount: 5,
        });
      }

      // Create two summaries to use as replacements
      await summaryStore.insertSummary({
        summaryId: "sum_test_001",
        conversationId: conv.conversationId,
        kind: "leaf",
        content: "Summary of messages 0-1",
        tokenCount: 10,
        messageIds: [],
        childSummaryIds: [],
        depth: 0,
        fileIds: [],
      });

      await summaryStore.insertSummary({
        summaryId: "sum_test_002",
        conversationId: conv.conversationId,
        kind: "leaf",
        content: "Summary of messages 2-3",
        tokenCount: 10,
        messageIds: [],
        childSummaryIds: [],
        depth: 0,
        fileIds: [],
      });

      // These are launched concurrently; without the mutex, that could
      // cause "cannot start a transaction within a transaction"
      // because replaceContextRangeWithSummary uses bare BEGIN.
      //
      // The mutex serializes the transactions, but acquisition order is
      // nondeterministic, so either replacement may run first. This test is
      // only verifying that concurrent calls avoid the SQLite-level
      // nested-transaction error.
      await Promise.all([
        summaryStore.replaceContextRangeWithSummary({
          conversationId: conv.conversationId,
          startOrdinal: 0,
          endOrdinal: 1,
          summaryId: "sum_test_001",
        }),
        summaryStore.replaceContextRangeWithSummary({
          conversationId: conv.conversationId,
          startOrdinal: 2,
          endOrdinal: 3,
          summaryId: "sum_test_002",
        }),
      ]);

      // Both operations should complete — verify context items exist
      const items = db
        .prepare(
          `SELECT * FROM context_items WHERE conversation_id = ? ORDER BY ordinal`,
        )
        .all(conv.conversationId) as unknown as { ordinal: number; item_type: string; summary_id: string | null }[];

      // Should have context items (exact count depends on resequencing order)
      expect(items.length).toBeGreaterThan(0);
    });
  });

  describe("cross-store concurrent transaction safety", () => {
    it("serializes ConversationStore.withTransaction and SummaryStore.replaceContextRangeWithSummary on same db", async () => {
      const { db, fts5Available } = createTestDb();
      const convStore = new ConversationStore(db, { fts5Available });
      const summaryStore = new SummaryStore(db, { fts5Available });

      // Create conversation with messages
      const conv = await convStore.createConversation({
        sessionId: "sess-1",
        sessionKey: "key-1",
      });
      for (let i = 0; i < 4; i++) {
        await convStore.createMessage({
          conversationId: conv.conversationId,
          seq: i,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `message ${i}`,
          tokenCount: 5,
        });
      }

      await summaryStore.insertSummary({
        summaryId: "sum_cross_001",
        conversationId: conv.conversationId,
        kind: "leaf",
        content: "Cross-test summary",
        tokenCount: 10,
        messageIds: [],
        childSummaryIds: [],
        depth: 0,
        fileIds: [],
      });

      // This is the core #260 scenario: one session does withTransaction
      // (e.g., bootstrap) while another session does replaceContextRange
      // (e.g., compaction). Both touch the same DatabaseSync handle.
      // Without the mutex, this races.
      const results = await Promise.allSettled([
        convStore.withTransaction(async () => {
          // Simulate bootstrap's heavy async work inside txn
          await delay(20);
          await convStore.createMessage({
            conversationId: conv.conversationId,
            seq: 100,
            role: "user",
            content: "bootstrap msg",
            tokenCount: 5,
          });
          return "bootstrap-done";
        }),
        summaryStore.replaceContextRangeWithSummary({
          conversationId: conv.conversationId,
          startOrdinal: 0,
          endOrdinal: 1,
          summaryId: "sum_cross_001",
        }),
      ]);

      // Both should succeed (no nested transaction error)
      for (const result of results) {
        expect(result.status).toBe("fulfilled");
      }
    });

    it("serializes broader summary write sequences before context replacement", async () => {
      const { db, fts5Available } = createTestDb();
      const convStore = new ConversationStore(db, { fts5Available });
      const summaryStore = new SummaryStore(db, { fts5Available });

      const conv = await convStore.createConversation({
        sessionId: "sess-wide",
        sessionKey: "key-wide",
      });

      const contextMessageIds: number[] = [];
      for (let i = 0; i < 4; i++) {
        const message = await convStore.createMessage({
          conversationId: conv.conversationId,
          seq: i,
          role: i % 2 === 0 ? "user" : "assistant",
          content: `context ${i}`,
          tokenCount: 5,
        });
        contextMessageIds.push(message.messageId);
        await summaryStore.appendContextMessage(conv.conversationId, message.messageId);
      }

      const results = await Promise.allSettled([
        summaryStore.withTransaction(async () => {
          await summaryStore.insertSummary({
            summaryId: "sum_scope_001",
            conversationId: conv.conversationId,
            kind: "leaf",
            content: "Scoped summary",
            tokenCount: 10,
            depth: 0,
            fileIds: [],
          });
          await summaryStore.linkSummaryToMessages("sum_scope_001", contextMessageIds.slice(0, 2));
          await delay(20);
          await summaryStore.replaceContextRangeWithSummary({
            conversationId: conv.conversationId,
            startOrdinal: 0,
            endOrdinal: 1,
            summaryId: "sum_scope_001",
          });
          return "summary-done";
        }),
        convStore.withTransaction(async () => {
          await delay(10);
          await convStore.createMessage({
            conversationId: conv.conversationId,
            seq: 100,
            role: "user",
            content: "competing tx",
            tokenCount: 5,
          });
          return "conversation-done";
        }),
      ]);

      for (const result of results) {
        expect(result.status).toBe("fulfilled");
      }

      await expect(summaryStore.getSummary("sum_scope_001")).resolves.not.toBeNull();
    });
  });

  describe("high-concurrency stress test", () => {
    it("handles 10 concurrent transactions from different simulated sessions without errors", async () => {
      const { db, fts5Available } = createTestDb();
      const store = new ConversationStore(db, { fts5Available });

      // Create conversations for 10 "sessions"
      const convs: Awaited<ReturnType<typeof store.createConversation>>[] = [];
      for (let i = 0; i < 10; i++) {
        convs.push(
          await store.createConversation({
            sessionId: `sess-${i}`,
            sessionKey: `key-${i}`,
          }),
        );
      }

      // All 10 sessions do withTransaction concurrently with async work inside
      const results = await Promise.allSettled(
        convs.map((conv, i) =>
          store.withTransaction(async () => {
            await delay((i % 5) * 5);
            await store.createMessage({
              conversationId: conv.conversationId,
              seq: 1,
              role: "user",
              content: `stress test msg from session ${i}`,
              tokenCount: 10,
            });
            return `session-${i}-done`;
          }),
        ),
      );

      // All should succeed
      const failures = results.filter((r) => r.status === "rejected");
      expect(failures).toHaveLength(0);

      // Verify all messages were written
      for (const conv of convs) {
        const messages = await store.getMessages(conv.conversationId);
        expect(messages).toHaveLength(1);
      }
    });
  });
});
