import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const tempDirs: string[] = [];

function setupTestDb() {
  const tempDir = mkdtempSync(join(tmpdir(), "lcm-sum-store-"));
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

describe("SummaryStore CRUD", () => {
  it("inserts and retrieves summaries", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await convStore.createConversation({ sessionId: "sum-test" });
    const summary = await sumStore.insertSummary({
      summaryId: "sum-001",
      conversationId: conv.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Test summary content",
      tokenCount: 4,
    });

    expect(summary.summaryId).toBe("sum-001");
    expect(summary.content).toBe("Test summary content");

    const fetched = await sumStore.getSummary("sum-001");
    expect(fetched).toEqual(summary);
  });

  it("links summaries to parents and children", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await convStore.createConversation({ sessionId: "link-test" });
    const leaf = await sumStore.insertSummary({
      summaryId: "leaf-1",
      conversationId: conv.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Leaf summary",
      tokenCount: 2,
    });
    const condensed = await sumStore.insertSummary({
      summaryId: "cond-1",
      conversationId: conv.conversationId,
      kind: "condensed",
      depth: 1,
      content: "Condensed summary",
      tokenCount: 2,
    });

    await sumStore.linkSummaryToParents("cond-1", ["leaf-1"]);

    const parents = await sumStore.getSummaryParents("cond-1");
    expect(parents).toHaveLength(1);
    expect(parents[0].summaryId).toBe("leaf-1");

    const children = await sumStore.getSummaryChildren("leaf-1");
    expect(children).toHaveLength(1);
    expect(children[0].summaryId).toBe("cond-1");
  });

  it("manages context items", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await convStore.createConversation({ sessionId: "context-test" });
    const msg = await convStore.createMessage({
      conversationId: conv.conversationId,
      seq: 1,
      role: "user",
      content: "Test message",
      tokenCount: 2,
    });
    const summary = await sumStore.insertSummary({
      summaryId: "ctx-sum",
      conversationId: conv.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Context summary",
      tokenCount: 2,
    });

    await sumStore.appendContextMessage(conv.conversationId, msg.messageId);
    await sumStore.appendContextSummary(conv.conversationId, "ctx-sum");

    const context = await sumStore.getContextItems(conv.conversationId);
    expect(context).toHaveLength(2);
    expect(context[0].itemType).toBe("message");
    expect(context[1].itemType).toBe("summary");
  });

  it("searches summaries with full text", async () => {
    const { db, features } = setupTestDb();
    const convStore = new ConversationStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });
    const sumStore = new SummaryStore(db, {
      fullTextAvailable: features.fullTextAvailable,
      backend: features.backend,
    });

    const conv = await convStore.createConversation({ sessionId: "sum-search-test" });
    await sumStore.insertSummary({
      summaryId: "search-sum",
      conversationId: conv.conversationId,
      kind: "leaf",
      depth: 0,
      content: "This summary contains searchable text",
      tokenCount: 5,
    });

    const results = await sumStore.searchSummaries({
      query: "searchable text",
      mode: "full_text",
      conversationId: conv.conversationId,
    });

    expect(results).toHaveLength(1);
    expect(results[0].summaryId).toBe("search-sum");
  });
});