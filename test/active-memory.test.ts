import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore, type ContextItemRecord, type PointerRecord, type ScratchpadRecord } from "../src/store/summary-store.js";
import { ContextAssembler } from "../src/assembler.js";
import { runLcmMigrations } from "../src/db/migration.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function createInMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function createStores(db: DatabaseSync) {
  const conversationStore = new ConversationStore(db, { fts5Available: false });
  const summaryStore = new SummaryStore(db, { fts5Available: false });
  const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC");
  return { conversationStore, summaryStore, assembler };
}

async function seedConversation(
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  messageCount: number,
): Promise<{ conversationId: number; messageIds: number[] }> {
  const conversation = await conversationStore.getOrCreateConversation("test-session");
  const conversationId = conversation.conversationId;
  const messageIds: number[] = [];

  for (let i = 0; i < messageCount; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    const content = `${role} message ${i}: ${"x".repeat(100)}`; // ~25 tokens each
    const msg = await conversationStore.createMessage({
      conversationId,
      seq: i,
      role: role as "user" | "assistant",
      content,
      tokenCount: 25,
    });
    messageIds.push(msg.messageId);
  }

  await summaryStore.appendContextMessages(conversationId, messageIds);
  return { conversationId, messageIds };
}

async function seedToolCallPair(
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
  conversationId: number,
  startSeq: number,
): Promise<{ assistantId: number; toolId: number }> {
  const assistant = await conversationStore.createMessage({
    conversationId,
    seq: startSeq,
    role: "assistant",
    content: '[{"type":"toolCall","id":"call_123","name":"exec","input":{"command":"ls"}}]',
    tokenCount: 30,
  });

  const tool = await conversationStore.createMessage({
    conversationId,
    seq: startSeq + 1,
    role: "tool",
    content: "file1.ts\nfile2.ts\nfile3.ts\n" + "x".repeat(4000), // big tool output
    tokenCount: 1050,
  });

  await summaryStore.appendContextMessages(conversationId, [assistant.messageId, tool.messageId]);
  return { assistantId: assistant.messageId, toolId: tool.messageId };
}

// ── Migration tests ──────────────────────────────────────────────────────────

describe("Active Memory: Migrations", () => {
  it("should create pointers table", () => {
    const db = createInMemoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='pointers'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should create scratchpads table", () => {
    const db = createInMemoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scratchpads'")
      .all();
    expect(tables).toHaveLength(1);
  });

  it("should allow pointer and scratchpad item types in context_items", () => {
    const db = createInMemoryDb();
    // Verify the CHECK constraint allows new types
    const conversationId = 1;
    db.prepare(
      "INSERT INTO conversations (conversation_id, session_id, created_at, updated_at) VALUES (?, 'test', datetime('now'), datetime('now'))",
    ).run(conversationId);

    // pointer type should work
    expect(() => {
      db.prepare(
        "INSERT INTO context_items (conversation_id, ordinal, item_type, pointer_id) VALUES (?, 0, 'pointer', 'ptr_test123')",
      ).run(conversationId);
    }).not.toThrow();

    // scratchpad type should work
    expect(() => {
      db.prepare(
        "INSERT INTO context_items (conversation_id, ordinal, item_type) VALUES (?, 1, 'scratchpad')",
      ).run(conversationId);
    }).not.toThrow();
  });

  it("should enforce CHECK constraints on new item types", () => {
    const db = createInMemoryDb();
    const conversationId = 1;
    db.prepare(
      "INSERT INTO conversations (conversation_id, session_id, created_at, updated_at) VALUES (?, 'test', datetime('now'), datetime('now'))",
    ).run(conversationId);

    // pointer without pointer_id should fail
    expect(() => {
      db.prepare(
        "INSERT INTO context_items (conversation_id, ordinal, item_type) VALUES (?, 10, 'pointer')",
      ).run(conversationId);
    }).toThrow();

    // pointer with message_id should fail
    expect(() => {
      db.prepare(
        "INSERT INTO context_items (conversation_id, ordinal, item_type, pointer_id, message_id) VALUES (?, 11, 'pointer', 'ptr_x', 1)",
      ).run(conversationId);
    }).toThrow();
  });

  it("should migrate existing context_items table to support new types", () => {
    // Simulate a pre-migration DB by creating old-style table first
    const db = new DatabaseSync(":memory:");

    // Create minimal schema without new item types
    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        bootstrapped_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, seq)
      );
      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        earliest_at TEXT,
        latest_at TEXT,
        descendant_count INTEGER NOT NULL DEFAULT 0,
        descendant_token_count INTEGER NOT NULL DEFAULT 0,
        source_message_token_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_ids TEXT NOT NULL DEFAULT '[]'
      );
      CREATE TABLE summary_messages (
        summary_id TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, message_id)
      );
      CREATE TABLE summary_parents (
        summary_id TEXT NOT NULL,
        parent_summary_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, parent_summary_id)
      );
      CREATE TABLE context_items (
        conversation_id INTEGER NOT NULL,
        ordinal INTEGER NOT NULL,
        item_type TEXT NOT NULL CHECK (item_type IN ('message', 'summary')),
        message_id INTEGER,
        summary_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        PRIMARY KEY (conversation_id, ordinal)
      );
    `);

    // Insert some existing data
    db.prepare(
      "INSERT INTO conversations (session_id, created_at, updated_at) VALUES ('s1', datetime('now'), datetime('now'))",
    ).run();
    db.prepare(
      "INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES (1, 0, 'user', 'hello', 5)",
    ).run();
    db.prepare(
      "INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES (1, 0, 'message', 1)",
    ).run();

    // Run migrations — should upgrade context_items
    runLcmMigrations(db, { fts5Available: false });

    // Existing data should be preserved
    const items = db.prepare("SELECT * FROM context_items WHERE conversation_id = 1").all();
    expect(items).toHaveLength(1);

    // New types should now be allowed
    expect(() => {
      db.prepare(
        "INSERT INTO context_items (conversation_id, ordinal, item_type, pointer_id) VALUES (1, 1, 'pointer', 'ptr_test')",
      ).run();
    }).not.toThrow();
  });
});

// ── Pointer CRUD tests ───────────────────────────────────────────────────────

describe("Active Memory: Pointer Store", () => {
  let db: DatabaseSync;
  let summaryStore: SummaryStore;
  let conversationStore: ConversationStore;
  let defaultConversationId: number;

  beforeEach(async () => {
    db = createInMemoryDb();
    const stores = createStores(db);
    summaryStore = stores.summaryStore;
    conversationStore = stores.conversationStore;
    // Create conversation so FK constraints pass
    const conv = await conversationStore.getOrCreateConversation("pointer-test");
    defaultConversationId = conv.conversationId;
  });

  it("should insert and retrieve a pointer", async () => {
    const pointer = await summaryStore.insertPointer({
      pointerId: "ptr_test123",
      conversationId: defaultConversationId,
      label: "test pointer",
      reason: "testing",
      sourceType: "messages",
      sourceIds: ["1", "2", "3"],
      tokensSaved: 500,
    });

    expect(pointer.pointerId).toBe("ptr_test123");
    expect(pointer.label).toBe("test pointer");
    expect(pointer.reason).toBe("testing");
    expect(pointer.sourceType).toBe("messages");
    expect(pointer.sourceIds).toEqual(["1", "2", "3"]);
    expect(pointer.tokensSaved).toBe(500);

    const retrieved = await summaryStore.getPointer("ptr_test123");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.pointerId).toBe("ptr_test123");
    expect(retrieved!.sourceIds).toEqual(["1", "2", "3"]);
  });

  it("should return null for non-existent pointer", async () => {
    const result = await summaryStore.getPointer("ptr_nonexistent");
    expect(result).toBeNull();
  });

  it("should list pointers by conversation", async () => {
    await summaryStore.insertPointer({
      pointerId: "ptr_a",
      conversationId: defaultConversationId,
      label: "first",
      sourceType: "messages",
      sourceIds: ["1"],
      tokensSaved: 100,
    });
    await summaryStore.insertPointer({
      pointerId: "ptr_b",
      conversationId: defaultConversationId,
      label: "second",
      sourceType: "tool_output",
      sourceIds: ["2"],
      tokensSaved: 200,
    });
    const conv2 = await conversationStore.getOrCreateConversation("pointer-test-2");
    await summaryStore.insertPointer({
      pointerId: "ptr_c",
      conversationId: conv2.conversationId,
      label: "other conversation",
      sourceType: "messages",
      sourceIds: ["3"],
      tokensSaved: 300,
    });

    const conv1Pointers = await summaryStore.getPointersByConversation(1);
    expect(conv1Pointers).toHaveLength(2);
    expect(conv1Pointers[0].pointerId).toBe("ptr_a");
    expect(conv1Pointers[1].pointerId).toBe("ptr_b");
  });

  it("should delete a pointer", async () => {
    await summaryStore.insertPointer({
      pointerId: "ptr_delete_me",
      conversationId: defaultConversationId,
      label: "ephemeral",
      sourceType: "messages",
      sourceIds: ["1"],
      tokensSaved: 50,
    });

    await summaryStore.deletePointer("ptr_delete_me");
    const result = await summaryStore.getPointer("ptr_delete_me");
    expect(result).toBeNull();
  });
});

// ── Context item replacement tests ───────────────────────────────────────────

describe("Active Memory: Context Item Replacement", () => {
  let db: DatabaseSync;
  let summaryStore: SummaryStore;
  let conversationStore: ConversationStore;

  beforeEach(() => {
    db = createInMemoryDb();
    const stores = createStores(db);
    summaryStore = stores.summaryStore;
    conversationStore = stores.conversationStore;
  });

  it("should replace a range of context items with a pointer", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore,
      summaryStore,
      6,
    );

    // Create pointer
    await summaryStore.insertPointer({
      pointerId: "ptr_range",
      conversationId,
      label: "messages 2-4",
      sourceType: "messages",
      sourceIds: messageIds.slice(2, 5).map(String),
      tokensSaved: 75,
    });

    // Replace ordinals 2-4 with pointer
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 2,
      endOrdinal: 4,
      pointerId: "ptr_range",
    });

    const items = await summaryStore.getContextItems(conversationId);

    // Should have: msg0, msg1, pointer, msg5 = 4 items
    expect(items).toHaveLength(4);
    expect(items[0].itemType).toBe("message");
    expect(items[1].itemType).toBe("message");
    expect(items[2].itemType).toBe("pointer");
    expect(items[2].pointerId).toBe("ptr_range");
    expect(items[3].itemType).toBe("message");

    // Ordinals should be resequenced 0,1,2,3
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2, 3]);
  });

  it("should restore a pointer back to original context items", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore,
      summaryStore,
      6,
    );

    const collapseIds = messageIds.slice(2, 5);

    // Collapse
    await summaryStore.insertPointer({
      pointerId: "ptr_restore",
      conversationId,
      label: "messages 2-4",
      sourceType: "messages",
      sourceIds: collapseIds.map(String),
      tokensSaved: 75,
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 2,
      endOrdinal: 4,
      pointerId: "ptr_restore",
    });

    // Verify collapsed state
    let items = await summaryStore.getContextItems(conversationId);
    expect(items).toHaveLength(4);
    const pointerItem = items.find((i) => i.itemType === "pointer");
    expect(pointerItem).toBeDefined();

    // Expand
    await summaryStore.replacePointerWithContextItems({
      conversationId,
      pointerOrdinal: pointerItem!.ordinal,
      items: collapseIds.map((id) => ({ itemType: "message" as const, messageId: id })),
    });

    // Should be back to 6 message items
    items = await summaryStore.getContextItems(conversationId);
    expect(items).toHaveLength(6);
    expect(items.every((i) => i.itemType === "message")).toBe(true);
    expect(items.map((i) => i.ordinal)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("should handle collapse-expand-collapse cycle", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore,
      summaryStore,
      4,
    );

    // Collapse messages 1-2
    await summaryStore.insertPointer({
      pointerId: "ptr_cycle",
      conversationId,
      label: "first collapse",
      sourceType: "messages",
      sourceIds: [String(messageIds[1]), String(messageIds[2])],
      tokensSaved: 50,
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 1,
      endOrdinal: 2,
      pointerId: "ptr_cycle",
    });

    let items = await summaryStore.getContextItems(conversationId);
    expect(items).toHaveLength(3); // msg0, pointer, msg3

    // Expand
    const pointerItem = items.find((i) => i.itemType === "pointer")!;
    await summaryStore.replacePointerWithContextItems({
      conversationId,
      pointerOrdinal: pointerItem.ordinal,
      items: [
        { itemType: "message", messageId: messageIds[1] },
        { itemType: "message", messageId: messageIds[2] },
      ],
    });

    items = await summaryStore.getContextItems(conversationId);
    expect(items).toHaveLength(4);

    // Re-collapse different range
    await summaryStore.insertPointer({
      pointerId: "ptr_cycle2",
      conversationId,
      label: "second collapse",
      sourceType: "messages",
      sourceIds: [String(messageIds[0]), String(messageIds[1])],
      tokensSaved: 50,
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      pointerId: "ptr_cycle2",
    });

    items = await summaryStore.getContextItems(conversationId);
    expect(items).toHaveLength(3); // pointer, msg2, msg3
    expect(items[0].itemType).toBe("pointer");
    expect(items[0].pointerId).toBe("ptr_cycle2");
  });
});

// ── Scratchpad tests ─────────────────────────────────────────────────────────

describe("Active Memory: Scratchpad Store", () => {
  let db: DatabaseSync;
  let summaryStore: SummaryStore;
  let conversationStore: ConversationStore;
  let defaultConversationId: number;

  beforeEach(async () => {
    db = createInMemoryDb();
    const stores = createStores(db);
    summaryStore = stores.summaryStore;
    conversationStore = stores.conversationStore;
    const conv = await conversationStore.getOrCreateConversation("scratchpad-test");
    defaultConversationId = conv.conversationId;
  });

  it("should return null for non-existent scratchpad", async () => {
    const result = await summaryStore.getScratchpad(999);
    expect(result).toBeNull();
  });

  it("should create and retrieve a scratchpad", async () => {
    const content = "## Active Context\n- Working on tests";
    await summaryStore.upsertScratchpad({
      conversationId: defaultConversationId,
      content,
      tokenCount: 10,
    });

    const scratchpad = await summaryStore.getScratchpad(defaultConversationId);
    expect(scratchpad).not.toBeNull();
    expect(scratchpad!.content).toBe(content);
    expect(scratchpad!.tokenCount).toBe(10);
  });

  it("should upsert (update existing) scratchpad", async () => {
    await summaryStore.upsertScratchpad({
      conversationId: defaultConversationId,
      content: "version 1",
      tokenCount: 5,
    });

    await summaryStore.upsertScratchpad({
      conversationId: defaultConversationId,
      content: "version 2 — updated",
      tokenCount: 8,
    });

    const scratchpad = await summaryStore.getScratchpad(defaultConversationId);
    expect(scratchpad!.content).toBe("version 2 — updated");
    expect(scratchpad!.tokenCount).toBe(8);
  });

  it("should ensure only one scratchpad context item per conversation", async () => {
    const db2 = createInMemoryDb();
    const stores = createStores(db2);

    const conv = await stores.conversationStore.getOrCreateConversation("test");
    const conversationId = conv.conversationId;

    await stores.summaryStore.ensureScratchpadContextItem(conversationId);
    await stores.summaryStore.ensureScratchpadContextItem(conversationId); // idempotent

    const items = await stores.summaryStore.getContextItems(conversationId);
    const scratchpadItems = items.filter((i) => i.itemType === "scratchpad");
    expect(scratchpadItems).toHaveLength(1);
  });
});

// ── Assembler tests ──────────────────────────────────────────────────────────

describe("Active Memory: Assembler", () => {
  let db: DatabaseSync;
  let conversationStore: ConversationStore;
  let summaryStore: SummaryStore;
  let assembler: ContextAssembler;

  beforeEach(() => {
    db = createInMemoryDb();
    const stores = createStores(db);
    conversationStore = stores.conversationStore;
    summaryStore = stores.summaryStore;
    assembler = stores.assembler;
  });

  it("should render pointer as collapsed XML", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore,
      summaryStore,
      4,
    );

    await summaryStore.insertPointer({
      pointerId: "ptr_render",
      conversationId,
      label: "big HTML dump",
      reason: "accidentally pulled full page",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[1])],
      tokensSaved: 5000,
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 1,
      endOrdinal: 1,
      pointerId: "ptr_render",
    });

    const result = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });

    // Find the pointer message
    const pointerMsg = result.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("ptr_render"),
    );
    expect(pointerMsg).toBeDefined();
    expect(pointerMsg!.role).toBe("user");

    const content = pointerMsg!.content as string;
    expect(content).toContain("<collapsed");
    expect(content).toContain("tokens_saved=\"5000\"");
    expect(content).toContain("big HTML dump");
    expect(content).toContain("accidentally pulled full page");
    expect(content).toContain("lcm_expand_active");
  });

  it("should position scratchpad just before fresh tail", async () => {
    const { conversationId } = await seedConversation(
      conversationStore,
      summaryStore,
      10,
    );

    // Add scratchpad
    await summaryStore.upsertScratchpad({
      conversationId,
      content: "## Active Context\n- Building tests",
      tokenCount: 10,
    });
    await summaryStore.ensureScratchpadContextItem(conversationId);

    const result = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 3,
    });

    // Scratchpad should be just before the last 3 messages
    const messages = result.messages;
    const scratchpadIdx = messages.findIndex(
      (m) => typeof m.content === "string" && m.content.includes("<scratchpad"),
    );

    expect(scratchpadIdx).toBeGreaterThan(-1);
    // Scratchpad should be at position (total - freshTailCount - 1)
    // i.e. 3 messages after it
    const messagesAfterScratchpad = messages.length - 1 - scratchpadIdx;
    expect(messagesAfterScratchpad).toBe(3); // freshTailCount
  });

  it("should render scratchpad with content", async () => {
    const { conversationId } = await seedConversation(
      conversationStore,
      summaryStore,
      4,
    );

    const scratchpadContent = "## Active Context\n- Task: testing\n\n## Nearby\n- research paper";
    await summaryStore.upsertScratchpad({
      conversationId,
      content: scratchpadContent,
      tokenCount: 20,
    });
    await summaryStore.ensureScratchpadContextItem(conversationId);

    const result = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });

    const scratchpadMsg = result.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("<scratchpad"),
    );
    expect(scratchpadMsg).toBeDefined();
    expect(scratchpadMsg!.content).toContain("Task: testing");
    expect(scratchpadMsg!.content).toContain("research paper");
  });

  it("should skip empty scratchpad in assembly", async () => {
    const { conversationId } = await seedConversation(
      conversationStore,
      summaryStore,
      4,
    );

    await summaryStore.upsertScratchpad({
      conversationId,
      content: "",
      tokenCount: 0,
    });
    await summaryStore.ensureScratchpadContextItem(conversationId);

    const result = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });

    const scratchpadMsg = result.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("<scratchpad"),
    );
    expect(scratchpadMsg).toBeUndefined();
  });

  it("should not evict scratchpad under budget pressure", async () => {
    const { conversationId } = await seedConversation(
      conversationStore,
      summaryStore,
      20, // 20 messages * ~25 tokens = ~500 tokens
    );

    await summaryStore.upsertScratchpad({
      conversationId,
      content: "## Important\n- Must survive budget cuts",
      tokenCount: 12,
    });
    await summaryStore.ensureScratchpadContextItem(conversationId);

    // Very tight budget — only room for fresh tail + scratchpad
    const result = await assembler.assemble({
      conversationId,
      tokenBudget: 100, // ~100 tokens, barely fits fresh tail
      freshTailCount: 3,
    });

    const scratchpadMsg = result.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("Must survive budget cuts"),
    );
    expect(scratchpadMsg).toBeDefined();
  });
});

// ── Compaction interaction tests ─────────────────────────────────────────────

describe("Active Memory: Compaction Interaction", () => {
  let db: DatabaseSync;
  let conversationStore: ConversationStore;
  let summaryStore: SummaryStore;

  beforeEach(() => {
    db = createInMemoryDb();
    const stores = createStores(db);
    conversationStore = stores.conversationStore;
    summaryStore = stores.summaryStore;
  });

  it("pointer items should not be counted as raw messages for compaction", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore,
      summaryStore,
      10,
    );

    // Collapse first 5 messages
    await summaryStore.insertPointer({
      pointerId: "ptr_compaction",
      conversationId,
      label: "old messages",
      sourceType: "messages",
      sourceIds: messageIds.slice(0, 5).map(String),
      tokensSaved: 125,
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 0,
      endOrdinal: 4,
      pointerId: "ptr_compaction",
    });

    const items = await summaryStore.getContextItems(conversationId);

    // Count raw messages (what compaction would see)
    const rawMessages = items.filter((i) => i.itemType === "message");
    expect(rawMessages).toHaveLength(5); // only the uncollapsed ones

    // Pointer should be separate
    const pointers = items.filter((i) => i.itemType === "pointer");
    expect(pointers).toHaveLength(1);
  });
});

// ── Scratchpad section replacement tests ─────────────────────────────────────

describe("Active Memory: Scratchpad Section Replacement", () => {
  it("should handle markdown section boundaries correctly", async () => {
    const db = createInMemoryDb();
    const { summaryStore, conversationStore } = createStores(db);
    const conv = await conversationStore.getOrCreateConversation("section-test");
    const cid = conv.conversationId;

    const original = [
      "## Active Context",
      "- Task: building feature X",
      "- Key constraint: must be backward compatible",
      "",
      "## Nearby",
      "- Research paper on attention mechanisms",
      "- AgentFold: proactive context management",
      "",
      "## Parked",
      "- Old debugging session notes",
    ].join("\n");

    await summaryStore.upsertScratchpad({
      conversationId: cid,
      content: original,
      tokenCount: 30,
    });

    // Verify the content structure
    const scratchpad = await summaryStore.getScratchpad(cid);
    expect(scratchpad!.content).toContain("## Active Context");
    expect(scratchpad!.content).toContain("## Nearby");
    expect(scratchpad!.content).toContain("## Parked");
  });
});

// ── End-to-end flow tests ────────────────────────────────────────────────────

describe("Active Memory: End-to-End Flows", () => {
  let db: DatabaseSync;
  let conversationStore: ConversationStore;
  let summaryStore: SummaryStore;
  let assembler: ContextAssembler;

  beforeEach(() => {
    db = createInMemoryDb();
    const stores = createStores(db);
    conversationStore = stores.conversationStore;
    summaryStore = stores.summaryStore;
    assembler = stores.assembler;
  });

  it("full workflow: seed → collapse tool output → scratchpad → expand → verify", async () => {
    // 1. Seed a conversation with some messages and a big tool call
    const { conversationId, messageIds } = await seedConversation(
      conversationStore,
      summaryStore,
      4,
    );
    const { assistantId, toolId } = await seedToolCallPair(
      conversationStore,
      summaryStore,
      conversationId,
      4,
    );

    // Verify initial state
    let items = await summaryStore.getContextItems(conversationId);
    expect(items).toHaveLength(6); // 4 messages + tool call + tool result

    // 2. Assemble and verify the big tool output is present
    let assembled = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });
    const initialTokens = assembled.estimatedTokens;

    // 3. Collapse the tool call pair
    await summaryStore.insertPointer({
      pointerId: "ptr_e2e_tool",
      conversationId,
      label: "ls command output (huge)",
      reason: "only needed the file listing, not the full output",
      sourceType: "tool_output",
      sourceIds: [String(assistantId), String(toolId)],
      tokensSaved: 1080, // 30 + 1050
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 4,
      endOrdinal: 5,
      pointerId: "ptr_e2e_tool",
    });

    // 4. Verify collapse saved tokens
    items = await summaryStore.getContextItems(conversationId);
    expect(items).toHaveLength(5); // 4 messages + pointer
    expect(items[4].itemType).toBe("pointer");

    assembled = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });
    expect(assembled.estimatedTokens).toBeLessThan(initialTokens);

    // 5. Set up scratchpad
    await summaryStore.upsertScratchpad({
      conversationId,
      content: "## Active\n- Collapsed tool output, saved ~1080 tokens\n- ptr_e2e_tool has the ls output if needed",
      tokenCount: 25,
    });
    await summaryStore.ensureScratchpadContextItem(conversationId);

    assembled = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });
    const scratchpadMsg = assembled.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("<scratchpad"),
    );
    expect(scratchpadMsg).toBeDefined();
    expect(scratchpadMsg!.content).toContain("ptr_e2e_tool");

    // 6. Expand the pointer
    const pointerItem = (await summaryStore.getContextItems(conversationId)).find(
      (i) => i.itemType === "pointer",
    )!;
    await summaryStore.replacePointerWithContextItems({
      conversationId,
      pointerOrdinal: pointerItem.ordinal,
      items: [
        { itemType: "message", messageId: assistantId },
        { itemType: "message", messageId: toolId },
      ],
    });
    await summaryStore.deletePointer("ptr_e2e_tool");

    // 7. Verify expansion
    items = await summaryStore.getContextItems(conversationId);
    const messageItems = items.filter((i) => i.itemType === "message");
    expect(messageItems).toHaveLength(6); // back to 6 messages
    expect(items.find((i) => i.itemType === "pointer")).toBeUndefined();

    assembled = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });
    // Tokens should be back up (scratchpad adds a little extra)
    expect(assembled.estimatedTokens).toBeGreaterThanOrEqual(initialTokens);
  });

  it("multiple collapses should coexist", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore,
      summaryStore,
      10,
    );

    // Collapse first 3 messages
    await summaryStore.insertPointer({
      pointerId: "ptr_first",
      conversationId,
      label: "early context",
      sourceType: "messages",
      sourceIds: messageIds.slice(0, 3).map(String),
      tokensSaved: 75,
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 0,
      endOrdinal: 2,
      pointerId: "ptr_first",
    });

    // Collapse messages 5-6 (ordinals shifted after first collapse)
    let items = await summaryStore.getContextItems(conversationId);
    const midItems = items.filter((i) => i.itemType === "message").slice(2, 4);
    const midStart = midItems[0].ordinal;
    const midEnd = midItems[midItems.length - 1].ordinal;

    await summaryStore.insertPointer({
      pointerId: "ptr_second",
      conversationId,
      label: "mid context",
      sourceType: "messages",
      sourceIds: midItems.map((i) => String(i.messageId)),
      tokensSaved: 50,
    });
    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: midStart,
      endOrdinal: midEnd,
      pointerId: "ptr_second",
    });

    items = await summaryStore.getContextItems(conversationId);
    const pointers = items.filter((i) => i.itemType === "pointer");
    expect(pointers).toHaveLength(2);
    expect(pointers[0].pointerId).toBe("ptr_first");
    expect(pointers[1].pointerId).toBe("ptr_second");

    // Both should render in assembly
    const assembled = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 2,
    });
    const collapsedMsgs = assembled.messages.filter(
      (m) => typeof m.content === "string" && m.content.includes("<collapsed"),
    );
    expect(collapsedMsgs).toHaveLength(2);
  });
});

// ── Tags & Status tests ────────────────────────────────────────────────────

describe("Pointer tags and status", () => {
  let db: DatabaseSync;
  let conversationStore: ConversationStore;
  let summaryStore: SummaryStore;
  let assembler: ContextAssembler;

  beforeEach(() => {
    db = createInMemoryDb();
    ({ conversationStore, summaryStore, assembler } = createStores(db));
  });

  afterEach(() => {
    db.close();
  });

  it("should store and retrieve tags on a pointer", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 4,
    );

    const pointer = await summaryStore.insertPointer({
      pointerId: "ptr_test_tags_1",
      conversationId,
      label: "test pointer with tags",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 100,
      tags: ["research", "path-a"],
      status: "active",
    });

    expect(pointer.tags).toEqual(["research", "path-a"]);
    expect(pointer.status).toBe("active");

    const retrieved = await summaryStore.getPointer("ptr_test_tags_1");
    expect(retrieved).not.toBeNull();
    expect(retrieved!.tags).toEqual(["research", "path-a"]);
    expect(retrieved!.status).toBe("active");
  });

  it("should default tags to empty array and status to active", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 4,
    );

    const pointer = await summaryStore.insertPointer({
      pointerId: "ptr_test_defaults",
      conversationId,
      label: "test pointer defaults",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 50,
    });

    expect(pointer.tags).toEqual([]);
    expect(pointer.status).toBe("active");
  });

  it("should update tags on a pointer", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 4,
    );

    await summaryStore.insertPointer({
      pointerId: "ptr_update_tags",
      conversationId,
      label: "test update tags",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 50,
      tags: ["old-tag"],
    });

    await summaryStore.updatePointerTags("ptr_update_tags", ["new-tag", "another"]);
    const updated = await summaryStore.getPointer("ptr_update_tags");
    expect(updated!.tags).toEqual(["new-tag", "another"]);
  });

  it("should update status on a pointer", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 4,
    );

    await summaryStore.insertPointer({
      pointerId: "ptr_update_status",
      conversationId,
      label: "test update status",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 50,
    });

    expect((await summaryStore.getPointer("ptr_update_status"))!.status).toBe("active");

    await summaryStore.updatePointerStatus("ptr_update_status", "stale");
    const updated = await summaryStore.getPointer("ptr_update_status");
    expect(updated!.status).toBe("stale");
  });

  it("should find pointers by tags", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 6,
    );

    await summaryStore.insertPointer({
      pointerId: "ptr_tag_search_1",
      conversationId,
      label: "pointer A",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 50,
      tags: ["research", "math"],
    });

    await summaryStore.insertPointer({
      pointerId: "ptr_tag_search_2",
      conversationId,
      label: "pointer B",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[1])],
      tokensSaved: 50,
      tags: ["research", "coding"],
    });

    await summaryStore.insertPointer({
      pointerId: "ptr_tag_search_3",
      conversationId,
      label: "pointer C",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[2])],
      tokensSaved: 50,
      tags: ["coding"],
    });

    const mathPointers = await summaryStore.getPointersByTags(conversationId, ["math"]);
    expect(mathPointers).toHaveLength(1);
    expect(mathPointers[0].pointerId).toBe("ptr_tag_search_1");

    const researchPointers = await summaryStore.getPointersByTags(conversationId, ["research"]);
    expect(researchPointers).toHaveLength(2);

    const codingOrMath = await summaryStore.getPointersByTags(conversationId, ["coding", "math"]);
    expect(codingOrMath).toHaveLength(3);
  });

  it("should find related pointers via shared tags", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 6,
    );

    await summaryStore.insertPointer({
      pointerId: "ptr_related_1",
      conversationId,
      label: "pointer A",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 50,
      tags: ["research", "path-a"],
    });

    await summaryStore.insertPointer({
      pointerId: "ptr_related_2",
      conversationId,
      label: "pointer B",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[1])],
      tokensSaved: 50,
      tags: ["research", "path-b"],
    });

    await summaryStore.insertPointer({
      pointerId: "ptr_related_3",
      conversationId,
      label: "pointer C - unrelated",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[2])],
      tokensSaved: 50,
      tags: ["coding"],
    });

    const related = await summaryStore.getRelatedPointers("ptr_related_1", conversationId);
    expect(related).toHaveLength(1);
    expect(related[0].pointerId).toBe("ptr_related_2");
  });

  it("should render tags and status in assembled pointer XML", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 4,
    );

    const pointer = await summaryStore.insertPointer({
      pointerId: "ptr_render_tags",
      conversationId,
      label: "tagged pointer",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 50,
      tags: ["research", "math"],
      status: "reference",
    });

    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      pointerId: "ptr_render_tags",
    });

    await conversationStore.markConversationManaged(conversationId);

    const assembled = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 0,
    });

    const collapsedMsg = assembled.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("ptr_render_tags"),
    );
    expect(collapsedMsg).toBeDefined();
    const content = collapsedMsg!.content as string;
    expect(content).toContain('tags="research,math"');
    expect(content).toContain('status="reference"');
  });

  it("should not render status attribute when active (default)", async () => {
    const { conversationId, messageIds } = await seedConversation(
      conversationStore, summaryStore, 4,
    );

    await summaryStore.insertPointer({
      pointerId: "ptr_active_default",
      conversationId,
      label: "active pointer",
      sourceType: "tool_output",
      sourceIds: [String(messageIds[0])],
      tokensSaved: 50,
      tags: [],
      status: "active",
    });

    await summaryStore.replaceContextRangeWithPointer({
      conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      pointerId: "ptr_active_default",
    });

    await conversationStore.markConversationManaged(conversationId);

    const assembled = await assembler.assemble({
      conversationId,
      tokenBudget: 100000,
      freshTailCount: 0,
    });

    const collapsedMsg = assembled.messages.find(
      (m) => typeof m.content === "string" && m.content.includes("ptr_active_default"),
    );
    expect(collapsedMsg).toBeDefined();
    const content = collapsedMsg!.content as string;
    expect(content).not.toContain('status=');
    expect(content).not.toContain('tags=');
  });
});
