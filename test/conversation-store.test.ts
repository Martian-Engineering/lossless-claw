import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";

const tempDirs: string[] = [];

function setupTestDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-conv-store-"));
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

describe("ConversationStore CRUD", () => {
  it("creates and retrieves conversations", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await store.createConversation({
      sessionId: "test-session",
      title: "Test Conversation",
    });
    expect(conv.sessionId).toBe("test-session");
    expect(conv.title).toBe("Test Conversation");
    expect(conv.conversationId).toBeGreaterThan(0);

    const fetched = await store.getConversation(conv.conversationId);
    expect(fetched).toEqual(conv);
  });

  it("getOrCreateConversation is idempotent", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv1 = await store.getOrCreateConversation("test-session-2", "Title");
    const conv2 = await store.getOrCreateConversation("test-session-2", "Different Title");

    expect(conv1.conversationId).toBe(conv2.conversationId);
    expect(conv1.title).toBe("Title"); // First title wins
  });

  it("creates and retrieves messages", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await store.createConversation({ sessionId: "msg-test" });
    const msg = await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "Hello world",
      tokenCount: 2,
    });

    expect(msg.messageId).toBeGreaterThan(0);
    expect(msg.content).toBe("Hello world");
    expect(msg.role).toBe("user");
    expect(msg.seq).toBe(1);

    const fetched = await store.getMessageById(msg.messageId);
    expect(fetched).toEqual(msg);
  });

  it("gets messages by conversation with limits", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await store.createConversation({ sessionId: "multi-msg-test" });
    await store.createMessagesBulk([
      { conversationId: conv.conversationId, seq: 1, role: "user", content: "First", tokenCount: 1 },
      { conversationId: conv.conversationId, seq: 2, role: "assistant", content: "Second", tokenCount: 1 },
      { conversationId: conv.conversationId, seq: 3, role: "user", content: "Third", tokenCount: 1 },
    ]);

    const allMsgs = await store.getMessages(conv.conversationId);
    expect(allMsgs).toHaveLength(3);
    expect(allMsgs.map(m => m.content)).toEqual(["First", "Second", "Third"]);

    const limited = await store.getMessages(conv.conversationId, { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].content).toBe("First");

    const after = await store.getMessages(conv.conversationId, { after: 1 });
    expect(after).toHaveLength(2);
    expect(after[0].content).toBe("Second");
  });

  it("gets last message and max seq", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await store.createConversation({ sessionId: "last-msg-test" });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "First",
      tokenCount: 1,
    });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 2,
      role: "assistant",
      content: "Last",
      tokenCount: 1,
    });

    const last = await store.getLastMessage(conv.conversationId);
    expect(last?.content).toBe("Last");

    const maxSeq = await store.getMaxSeq(conv.conversationId);
    expect(maxSeq).toBe(2);
  });

  it("creates and retrieves message parts", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await store.createConversation({ sessionId: "parts-test" });
    const msg = await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "assistant",
      content: "",
      tokenCount: 0,
    });

    await store.createMessageParts(msg.messageId, [
      {
        sessionId: "parts-test",
        partType: "text",
        ordinal: 0,
        textContent: "Part one",
      },
      {
        sessionId: "parts-test",
        partType: "tool",
        ordinal: 1,
        toolCallId: "call-1",
        toolName: "bash",
        toolInput: '{"cmd":"ls"}',
      },
    ]);

    const parts = await store.getMessageParts(msg.messageId);
    expect(parts).toHaveLength(2);
    expect(parts[0].textContent).toBe("Part one");
    expect(parts[1].toolName).toBe("bash");
  });

  it("searches messages with full text", async () => {
    const { db, features } = setupTestDb();
    const store = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await store.createConversation({ sessionId: "search-test" });
    await store.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "The quick brown fox jumps over the lazy dog",
      tokenCount: 9,
    });

    const results = await store.searchMessages({
      query: "quick brown",
      mode: "full_text",
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain("quick brown");
  });
});