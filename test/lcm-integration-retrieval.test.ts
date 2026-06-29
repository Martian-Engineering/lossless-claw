// LCM integration: retrieval and dynamic leaf chunk sizing.
// Split from the former monolithic test/lcm-integration.test.ts.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompactionEngine, type CompactionConfig } from "../src/compaction.js";
import { RetrievalEngine } from "../src/retrieval.js";
import {
  createMockConversationStore,
  createMockSummaryStore,
  CONV_ID,
  ingestMessages,
  wireStores,
  defaultCompactionConfig,
} from "./integration-helpers.js";

describe("LCM integration: retrieval", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let retrieval: RetrievalEngine;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    retrieval = new RetrievalEngine(convStore as any, sumStore as any);
  });

  it("describe returns summary with lineage", async () => {
    // Create messages first
    const msgs = await ingestMessages(convStore, sumStore, 3);

    // Insert a leaf summary linked to those messages
    const summaryId = "sum_leaf_abc123";
    await sumStore.insertSummary({
      summaryId,
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Summary of messages 1-3 about testing.",
      tokenCount: 20,
    });
    await sumStore.linkSummaryToMessages(
      summaryId,
      msgs.map((m) => m.messageId),
    );

    // Describe it
    const result = await retrieval.describe(summaryId);

    expect(result).not.toBeNull();
    expect(result!.id).toBe(summaryId);
    expect(result!.type).toBe("summary");
    expect(result!.summary).toBeDefined();
    expect(result!.summary!.kind).toBe("leaf");
    expect(result!.summary!.content).toContain("Summary of messages 1-3");
    expect(result!.summary!.messageIds).toEqual(msgs.map((m) => m.messageId));
    expect(result!.summary!.parentIds).toEqual([]);
    expect(result!.summary!.childIds).toEqual([]);
  });

  it("describe returns file info for file IDs", async () => {
    await sumStore.insertLargeFile({
      fileId: "file_test_001",
      conversationId: CONV_ID,
      fileName: "data.csv",
      mimeType: "text/csv",
      byteSize: 1024,
      lineCount: 100,
      storageUri: "s3://bucket/data.csv",
      explorationSummary: "CSV with 100 rows of test data.",
    });

    const result = await retrieval.describe("file_test_001");

    expect(result).not.toBeNull();
    expect(result!.type).toBe("file");
    expect(result!.file).toBeDefined();
    expect(result!.file!.fileName).toBe("data.csv");
    expect(result!.file!.storageUri).toBe("s3://bucket/data.csv");
    expect(result!.file!.lineCount).toBe(100);
  });

  it("describe returns null for unknown IDs", async () => {
    const result = await retrieval.describe("sum_nonexistent");
    expect(result).toBeNull();
  });

  it("grep searches across messages and summaries", async () => {
    // Insert messages with searchable content
    await ingestMessages(convStore, sumStore, 5, {
      contentFn: (i) =>
        i === 2 ? "This message mentions the deployment bug" : `Regular message ${i}`,
    });

    // Insert a summary with searchable content
    await sumStore.insertSummary({
      summaryId: "sum_search_001",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Summary mentioning the deployment bug fix.",
      tokenCount: 15,
    });

    const result = await retrieval.grep({
      query: "deployment",
      mode: "full_text",
      scope: "both",
      conversationId: CONV_ID,
    });

    expect(result.totalMatches).toBeGreaterThanOrEqual(2);
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.summaries.length).toBeGreaterThanOrEqual(1);
  });

  it("grep respects scope=messages to only search messages", async () => {
    await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `Message about feature ${i}`,
    });

    await sumStore.insertSummary({
      summaryId: "sum_scope_001",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Summary about feature improvements.",
      tokenCount: 10,
    });

    const result = await retrieval.grep({
      query: "feature",
      mode: "full_text",
      scope: "messages",
      conversationId: CONV_ID,
    });

    // Only messages should be searched
    expect(result.messages.length).toBeGreaterThanOrEqual(1);
    expect(result.summaries).toEqual([]);
  });

  it("grep returns timestamps and orders matches by recency", async () => {
    const msgs = await ingestMessages(convStore, sumStore, 2, {
      contentFn: () => "timeline match in message",
    });
    await sumStore.insertSummary({
      summaryId: "sum_timeline_old",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "timeline match in old summary",
      tokenCount: 10,
    });
    await sumStore.insertSummary({
      summaryId: "sum_timeline_new",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "timeline match in new summary",
      tokenCount: 10,
    });

    const oldTime = new Date("2026-01-01T00:00:00.000Z");
    const midTime = new Date("2026-01-02T00:00:00.000Z");
    const newTime = new Date("2026-01-03T00:00:00.000Z");

    const firstMessage = convStore._messages.find((m) => m.messageId === msgs[0].messageId);
    const secondMessage = convStore._messages.find((m) => m.messageId === msgs[1].messageId);
    if (firstMessage) {
      firstMessage.createdAt = oldTime;
    }
    if (secondMessage) {
      secondMessage.createdAt = newTime;
    }

    const oldSummary = sumStore._summaries.find((s) => s.summaryId === "sum_timeline_old");
    const newSummary = sumStore._summaries.find((s) => s.summaryId === "sum_timeline_new");
    if (oldSummary) {
      oldSummary.createdAt = midTime;
    }
    if (newSummary) {
      newSummary.createdAt = newTime;
    }

    const result = await retrieval.grep({
      query: "timeline",
      mode: "full_text",
      scope: "both",
      conversationId: CONV_ID,
    });

    expect(result.messages[0]?.createdAt.toISOString()).toBe(newTime.toISOString());
    expect(result.messages[result.messages.length - 1]?.createdAt.toISOString()).toBe(
      oldTime.toISOString(),
    );
    expect(result.summaries[0]?.createdAt.toISOString()).toBe(newTime.toISOString());
    expect(result.summaries[result.summaries.length - 1]?.createdAt.toISOString()).toBe(
      midTime.toISOString(),
    );
  });

  it("grep applies since/before time filters", async () => {
    const msgs = await ingestMessages(convStore, sumStore, 3, {
      contentFn: () => "windowed match",
    });

    const t1 = new Date("2026-01-01T00:00:00.000Z");
    const t2 = new Date("2026-01-02T00:00:00.000Z");
    const t3 = new Date("2026-01-03T00:00:00.000Z");
    const [m1, m2, m3] = msgs;
    const row1 = convStore._messages.find((m) => m.messageId === m1.messageId);
    const row2 = convStore._messages.find((m) => m.messageId === m2.messageId);
    const row3 = convStore._messages.find((m) => m.messageId === m3.messageId);
    if (row1) {
      row1.createdAt = t1;
    }
    if (row2) {
      row2.createdAt = t2;
    }
    if (row3) {
      row3.createdAt = t3;
    }

    const result = await retrieval.grep({
      query: "windowed",
      mode: "full_text",
      scope: "messages",
      conversationId: CONV_ID,
      since: new Date("2026-01-02T00:00:00.000Z"),
      before: new Date("2026-01-03T00:00:00.000Z"),
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.createdAt.toISOString()).toBe(t2.toISOString());
  });

  it("expand returns source summaries of a condensed summary", async () => {
    // Create source leaf summaries that will be compacted into sum_parent
    await sumStore.insertSummary({
      summaryId: "sum_child_1",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Child leaf 1: authentication flow details.",
      tokenCount: 15,
    });
    await sumStore.insertSummary({
      summaryId: "sum_child_2",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Child leaf 2: database migration details.",
      tokenCount: 15,
    });

    await sumStore.insertSummary({
      summaryId: "sum_parent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "High-level condensed summary.",
      tokenCount: 10,
    });

    // Condensed summaries link to the source summaries they were built from.
    await sumStore.linkSummaryToParents("sum_parent", ["sum_child_1", "sum_child_2"]);

    const result = await retrieval.expand({
      summaryId: "sum_parent",
      depth: 1,
      includeMessages: false,
    });

    expect(result.children).toHaveLength(2);
    expect(result.children.map((c) => c.summaryId)).toContain("sum_child_1");
    expect(result.children.map((c) => c.summaryId)).toContain("sum_child_2");
    expect(result.truncated).toBe(false);
  });

  it("expand respects tokenCap", async () => {
    // Create source summaries with large token counts
    await sumStore.insertSummary({
      summaryId: "sum_big_child_1",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "A".repeat(400), // ~100 tokens
      tokenCount: 100,
    });
    await sumStore.insertSummary({
      summaryId: "sum_big_child_2",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "B".repeat(400), // ~100 tokens
      tokenCount: 100,
    });
    await sumStore.insertSummary({
      summaryId: "sum_big_child_3",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "C".repeat(400), // ~100 tokens
      tokenCount: 100,
    });

    await sumStore.insertSummary({
      summaryId: "sum_big_parent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "Parent summary.",
      tokenCount: 5,
    });

    await sumStore.linkSummaryToParents("sum_big_parent", [
      "sum_big_child_1",
      "sum_big_child_2",
      "sum_big_child_3",
    ]);

    // Expand with a cap of 150 tokens — should fit child 1 (100) but not child 2
    const result = await retrieval.expand({
      summaryId: "sum_big_parent",
      depth: 1,
      tokenCap: 150,
    });

    expect(result.truncated).toBe(true);
    expect(result.children.length).toBeLessThan(3);
    expect(result.estimatedTokens).toBeLessThanOrEqual(150);
  });

  it("expand includes source messages at leaf level when includeMessages=true", async () => {
    // Create messages
    const msgs = await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `Source message ${i}`,
    });

    // Create leaf summary linked to those messages
    const leafId = "sum_leaf_with_msgs";
    await sumStore.insertSummary({
      summaryId: leafId,
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Leaf summary of 3 messages.",
      tokenCount: 10,
    });
    await sumStore.linkSummaryToMessages(
      leafId,
      msgs.map((m) => m.messageId),
    );

    const result = await retrieval.expand({
      summaryId: leafId,
      depth: 1,
      includeMessages: true,
    });

    expect(result.messages).toHaveLength(3);
    expect(result.messages[0].content).toBe("Source message 0");
    expect(result.messages[1].content).toBe("Source message 1");
    expect(result.messages[2].content).toBe("Source message 2");
  });

  it("expand recurses through multiple depth levels", async () => {
    // Build a 3-level lineage chain: grandparent -> mid_parent -> deep_leaf
    await sumStore.insertSummary({
      summaryId: "sum_deep_leaf",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Deep leaf summary.",
      tokenCount: 10,
    });

    await sumStore.insertSummary({
      summaryId: "sum_mid_parent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "Mid-level condensed parent.",
      tokenCount: 10,
    });
    await sumStore.linkSummaryToParents("sum_mid_parent", ["sum_deep_leaf"]);

    await sumStore.insertSummary({
      summaryId: "sum_grandparent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "Grandparent condensed.",
      tokenCount: 10,
    });
    await sumStore.linkSummaryToParents("sum_grandparent", ["sum_mid_parent"]);

    // Expand grandparent with depth=2 to reach deep_leaf
    const result = await retrieval.expand({
      summaryId: "sum_grandparent",
      depth: 2,
    });

    // Should include mid_parent (depth 1) and deep_leaf (depth 2)
    const childIds = result.children.map((c) => c.summaryId);
    expect(childIds).toContain("sum_mid_parent");
    expect(childIds).toContain("sum_deep_leaf");
  });
});

describe("LCM integration: dynamic leaf chunk sizing", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let compactionEngine: CompactionEngine;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    compactionEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 2,
      leafChunkTokens: 200,
      leafTargetTokens: 40,
      incrementalMaxDepth: 0,
    });
  });

  it("evaluateLeafTrigger respects an overridden working leaf chunk threshold", async () => {
    await ingestMessages(convStore, sumStore, 5, {
      tokenCountFn: () => 100,
      contentFn: (i) => `trigger message ${i}`,
    });

    const baseline = await compactionEngine.evaluateLeafTrigger(CONV_ID);
    expect(baseline).toEqual({
      shouldCompact: true,
      rawTokensOutsideTail: 300,
      threshold: 200,
    });

    const overridden = await compactionEngine.evaluateLeafTrigger(CONV_ID, 400);
    expect(overridden).toEqual({
      shouldCompact: false,
      rawTokensOutsideTail: 300,
      threshold: 400,
    });
  });

  it("compactLeaf uses the overridden working leaf chunk size when selecting the oldest raw chunk", async () => {
    await ingestMessages(convStore, sumStore, 5, {
      tokenCountFn: () => 100,
      contentFn: (i) => `dynamic chunk message ${i}`,
    });

    const summarize = vi.fn(async (text: string) => `summary ${text.length}`);

    await compactionEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 8_000,
      leafChunkTokens: 300,
      summarize,
      force: true,
    });

    expect(summarize).toHaveBeenCalledTimes(1);
    const compactedText = summarize.mock.calls[0]?.[0] ?? "";
    expect(compactedText).toContain("dynamic chunk message 0");
    expect(compactedText).toContain("dynamic chunk message 1");
    expect(compactedText).toContain("dynamic chunk message 2");
    expect(compactedText).not.toContain("dynamic chunk message 3");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Full Round-Trip (ingest -> compact -> assemble -> retrieve)
// ═════════════════════════════════════════════════════════════════════════════

