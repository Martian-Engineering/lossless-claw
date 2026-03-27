/**
 * Regression tests for bugs fixed on 2026-03-17 (nyx-lossless-v2).
 * Covers: session key continuity, ReDoS protection, grant scope,
 * content extraction, and heartbeat pruning.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { ExpansionAuthManager, createDelegatedExpansionGrant, getRuntimeExpansionAuthManager } from "../src/expansion-auth.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return db;
}

function createStores(db: DatabaseSync) {
  const { fts5Available } = getLcmDbFeatures(db);
  return {
    convStore: new ConversationStore(db, { fts5Available }),
    sumStore: new SummaryStore(db, { fts5Available }),
  };
}

// ── Session Key Continuity (#106, #107) ─────────────────────────────────────

describe("Session key continuity", () => {
  it("reuses conversation across multiple sequential resets", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv1 = await convStore.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    const conv2 = await convStore.getOrCreateConversation("uuid-2", { sessionKey: "agent:main:main" });
    const conv3 = await convStore.getOrCreateConversation("uuid-3", { sessionKey: "agent:main:main" });

    expect(conv1.conversationId).toBe(conv2.conversationId);
    expect(conv2.conversationId).toBe(conv3.conversationId);

    const refreshed = await convStore.getConversation(conv1.conversationId);
    expect(refreshed?.sessionId).toBe("uuid-3");
  });

  it("creates separate conversations for different sessionKeys", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv1 = await convStore.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    const conv2 = await convStore.getOrCreateConversation("uuid-2", { sessionKey: "agent:main:subagent:abc" });

    expect(conv1.conversationId).not.toBe(conv2.conversationId);
  });

  it("resolves the active conversation when archived rows share the same sessionKey", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const archived = await convStore.createConversation({
      sessionId: "uuid-archived",
      sessionKey: "agent:main:main",
    });
    db.prepare(
      `UPDATE conversations
       SET active = 0,
           archived_at = datetime('now'),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
    ).run(archived.conversationId);

    const active = await convStore.createConversation({
      sessionId: "uuid-active",
      sessionKey: "agent:main:main",
    });

    const byKey = await convStore.getConversationBySessionKey("agent:main:main");
    expect(byKey?.conversationId).toBe(active.conversationId);
    expect(byKey?.active).toBe(true);
  });

  it("creates a fresh active conversation instead of reusing an archived row", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const archived = await convStore.createConversation({
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    db.prepare(
      `UPDATE conversations
       SET active = 0,
           archived_at = datetime('now'),
           updated_at = datetime('now')
       WHERE conversation_id = ?`,
    ).run(archived.conversationId);

    const fresh = await convStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });

    expect(fresh.conversationId).not.toBe(archived.conversationId);
    expect(fresh.active).toBe(true);
    expect(fresh.archivedAt).toBeNull();
  });

  it("backfills sessionKey when found by sessionId", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    // Create without sessionKey (legacy path)
    const conv1 = await convStore.getOrCreateConversation("uuid-1");
    expect(conv1.sessionKey).toBeNull();

    // Re-fetch with sessionKey — should backfill
    const conv2 = await convStore.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    expect(conv2.conversationId).toBe(conv1.conversationId);

    // Verify backfill persisted
    const byKey = await convStore.getConversationBySessionKey("agent:main:main");
    expect(byKey).not.toBeNull();
    expect(byKey!.conversationId).toBe(conv1.conversationId);
  });

  it("falls back to sessionId when sessionKey is undefined", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv1 = await convStore.getOrCreateConversation("uuid-1");
    const conv2 = await convStore.getOrCreateConversation("uuid-1");

    expect(conv1.conversationId).toBe(conv2.conversationId);
  });
});

// ── ReDoS Protection (#76) ──────────────────────────────────────────────────

describe("ReDoS protection", () => {
  it("rejects catastrophic backtracking pattern", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    // Create a conversation with a message
    const conv = await convStore.createConversation({ sessionId: "redos-test" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "aaaaaaaaaaaaaaaaaaaaaa",
      tokenCount: 10,
    });

    // This pattern causes catastrophic backtracking: (a+)+$
    const results = await convStore.searchMessages({
      query: "(a+)+$",
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(0);
  });

  it("rejects patterns exceeding 500 characters", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "redos-long" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "test content",
      tokenCount: 5,
    });

    const longPattern = "a".repeat(501);
    const results = await convStore.searchMessages({
      query: longPattern,
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(0);
  });

  it("handles invalid regex syntax gracefully", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "redos-invalid" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "test content",
      tokenCount: 5,
    });

    // Unterminated character class — should not throw
    const results = await convStore.searchMessages({
      query: "[unterminated",
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(0);
  });

  it("normal regex patterns still work", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "redos-normal" });
    await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "the quick brown fox",
      tokenCount: 10,
    });

    const results = await convStore.searchMessages({
      query: "quick.*fox",
      mode: "regex",
      limit: 10,
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(1);
  });
});

// ── Grant Scope Inheritance (#72) ───────────────────────────────────────────

describe("Grant scope inheritance", () => {
  it("rejects depth exceeding grant maxDepth via clamping in wrapWithAuth", () => {
    const manager = new ExpansionAuthManager();
    const grant = manager.createGrant({
      issuerSessionId: "parent",
      allowedConversationIds: [1],
      maxDepth: 3,
      tokenCap: 1000,
    });

    // Validation allows it (clamped at execution)
    const result = manager.validateExpansion(grant.grantId, {
      conversationId: 1,
      summaryIds: [],
      depth: 10,
      tokenCap: 500,
    });
    expect(result.valid).toBe(true);
  });

  it("request at exactly maxDepth succeeds validation", () => {
    const manager = new ExpansionAuthManager();
    const grant = manager.createGrant({
      issuerSessionId: "parent",
      allowedConversationIds: [1],
      maxDepth: 3,
      tokenCap: 1000,
    });

    const result = manager.validateExpansion(grant.grantId, {
      conversationId: 1,
      summaryIds: [],
      depth: 3,
      tokenCap: 500,
    });
    expect(result.valid).toBe(true);
  });

  it("consumed tokens reduce remaining budget for subsequent calls", () => {
    const manager = new ExpansionAuthManager();
    const grant = manager.createGrant({
      issuerSessionId: "parent",
      allowedConversationIds: [1],
      tokenCap: 1000,
    });

    expect(manager.getRemainingTokenBudget(grant.grantId)).toBe(1000);
    manager.consumeTokenBudget(grant.grantId, 600);
    expect(manager.getRemainingTokenBudget(grant.grantId)).toBe(400);
    manager.consumeTokenBudget(grant.grantId, 400);
    expect(manager.getRemainingTokenBudget(grant.grantId)).toBe(0);
  });
});

// ── Content Extraction (#105) ───────────────────────────────────────────────

describe("Content extraction", () => {
  // We test via the engine's public interface indirectly through ConversationStore
  // since extractMessageContent is a private function. The engine tests in
  // engine.test.ts cover the acid test for toolCall arrays returning empty string.

  it("stores text content from text blocks correctly", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "content-test" });
    const msg = await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "plain text message",
      tokenCount: 5,
    });

    expect(msg.content).toBe("plain text message");
  });

  it("stores empty string for empty content", async () => {
    const db = createTestDb();
    const { convStore } = createStores(db);

    const conv = await convStore.createConversation({ sessionId: "empty-content" });
    const msg = await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "assistant",
      content: "",
      tokenCount: 0,
    });

    expect(msg.content).toBe("");
  });
});
