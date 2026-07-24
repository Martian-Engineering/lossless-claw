// LCM integration: ingest -> assemble against mock stores.
// Split from the former monolithic test/lcm-integration.test.ts.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import {
  createMockConversationStore,
  createMockSummaryStore,
  estimateTokens,
  extractMessageText,
  CONV_ID,
  ingestMessages,
  wireStores,
} from "./integration-helpers.js";

describe("LCM integration: ingest -> assemble", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let assembler: ContextAssembler;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    assembler = new ContextAssembler(convStore as any, sumStore as any);
  });

  it("ingested messages appear in assembled context", async () => {
    // Ingest 5 messages
    const msgs = await ingestMessages(convStore, sumStore, 5);

    // Assemble with a large budget so nothing is dropped
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    // All 5 messages should appear
    expect(result.messages).toHaveLength(5);
    expect(result.stats.rawMessageCount).toBe(5);
    expect(result.stats.summaryCount).toBe(0);
    expect(result.stats.totalContextItems).toBe(5);

    // Verify chronological order by checking content
    for (let i = 0; i < 5; i++) {
      expect(extractMessageText(result.messages[i].content)).toBe(`Message ${i}`);
    }
  });

  it("assembler respects token budget by dropping oldest items", async () => {
    // Ingest 10 messages with known token counts (each ~100 tokens via content length)
    const msgs = await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `M${i} ${"x".repeat(396)}`, // each message ~100 tokens
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Each message is ~100 tokens. Budget of 500 tokens with freshTailCount=4 means:
    // Fresh tail = last 4 items = ~400 tokens
    // Remaining budget = 500 - 400 = 100 tokens -> fits 1 more evictable item
    // So we should see items from index 5..9 (fresh tail) + maybe index 5 from evictable
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 150,
      freshTailCount: 4,
    });

    // Fresh tail (last 4) should always be included
    const lastFour = result.messages.slice(-4);
    for (let i = 0; i < 4; i++) {
      expect(extractMessageText(lastFour[i].content)).toContain(`M${6 + i}`);
    }

    // We should have fewer than 10 messages total (oldest dropped)
    expect(result.messages.length).toBeLessThan(10);

    // The oldest messages should be the ones dropped
    // With 100 tokens remaining budget and each msg ~100 tokens, we get at most 1 extra
    expect(result.messages.length).toBeLessThanOrEqual(5);
  });

  it("assembler includes summaries alongside messages", async () => {
    // Add 2 messages
    await ingestMessages(convStore, sumStore, 2);

    // Add a summary to the summary store and to context items
    const summaryId = "sum_test_001";
    await sumStore.insertSummary({
      summaryId,
      conversationId: CONV_ID,
      kind: "leaf",
      content: "This is a leaf summary of earlier conversation.",
      tokenCount: 20,
    });
    await sumStore.appendContextSummary(CONV_ID, summaryId);

    // Add 2 more messages after the summary
    const laterMsgs = await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Later message ${i}`,
    });

    // Assemble with large budget
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    // Should have 4 messages + 1 summary = 5 items total
    expect(result.messages).toHaveLength(5);
    expect(result.stats.rawMessageCount).toBe(4);
    expect(result.stats.summaryCount).toBe(1);

    // The summary should appear as a user message with an XML summary wrapper.
    const summaryMsg = result.messages.find((m) =>
      m.content.includes('<summary id="sum_test_001"'),
    );
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.role).toBe("user");
    expect(summaryMsg!.content).toContain("This is a leaf summary");
    // Injection persistence mitigation (issue #71): assembled summaries carry an
    // untrusted taint label on the <summary> tag so downstream models treat them
    // as historical reference, not current instructions. The semantics of the
    // label are defined once in the runtime recall system prompt.
    expect(summaryMsg!.content).toContain('trust="untrusted"');
  });

  it("emits depersonalized overflow diagnostics with top contributors", async () => {
    const [small, large, duplicate] = await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => {
        if (i === 0) return "tiny";
        if (i === 1) return `large message ${"x".repeat(800)}`;
        return `repeated content ${"y".repeat(120)}`;
      },
      tokenCountFn: (_i, content) => estimateTokens(content),
    });
    const duplicateText = duplicate.content;
    const secondDuplicate = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 4,
      role: "assistant",
      content: duplicateText,
      tokenCount: estimateTokens(duplicateText),
    });
    await sumStore.appendContextMessage(CONV_ID, secondDuplicate.messageId);

    const summaryId = "sum_overflow_diag";
    await sumStore.insertSummary({
      summaryId,
      conversationId: CONV_ID,
      kind: "leaf",
      content: `summary contributor ${"z".repeat(500)}`,
      tokenCount: 125,
    });
    await sumStore.appendContextSummary(CONV_ID, summaryId);
    sumStore._contextItems.push({
      conversationId: CONV_ID,
      ordinal: 5,
      itemType: "message",
      messageId: large.messageId,
      summaryId: null,
      createdAt: new Date(),
    });

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 150,
      freshTailCount: 1,
    });

    const diagnostics = result.debug?.overflowDiagnostics;
    expect(diagnostics).toMatchObject({
      tokenBudget: 150,
      rawMessageCount: 5,
      summaryCount: 1,
      totalContextItems: 6,
    });
    expect(diagnostics?.rawMessageTokens).toBeGreaterThan(diagnostics?.summaryTokens ?? 0);
    expect(diagnostics?.duplicateRefClusters).toEqual([
      expect.objectContaining({
        kind: "message-ref",
        count: 2,
        ordinals: [1, 5],
        seqs: [2, 2],
      }),
    ]);
    expect(diagnostics?.duplicateMessageClusters).toContainEqual(
      expect.objectContaining({
        kind: "message-content",
        count: 2,
        seqs: [2, 2],
      }),
    );
    expect(diagnostics?.topMessageContributors[0]).toMatchObject({
      messageId: large.messageId,
      seq: 2,
      role: "assistant",
    });
    expect(diagnostics?.topMessageContributors[0]?.tokens).toBeGreaterThanOrEqual(
      diagnostics?.topMessageContributors[1]?.tokens ?? 0,
    );
    expect(diagnostics?.topSummaryContributors[0]).toMatchObject({
      summaryId,
      summaryKind: "leaf",
      summaryDepth: 0,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("large message");
    expect(JSON.stringify(diagnostics)).not.toContain("summary contributor");
    expect(small.messageId).toBeGreaterThan(0);
  });

  it("empty conversation returns empty result", async () => {
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    expect(result.messages).toHaveLength(0);
    expect(result.estimatedTokens).toBe(0);
    expect(result.stats.totalContextItems).toBe(0);
  });

  it("fresh tail is always preserved even when over budget", async () => {
    // Ingest 3 messages, each ~200 tokens
    await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `M${i} ${"y".repeat(796)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Budget is only 100 tokens but freshTailCount=8 means all 3 are "fresh"
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100,
      freshTailCount: 8,
    });

    // All 3 messages should still be present (fresh tail is never dropped)
    expect(result.messages).toHaveLength(3);
  });

  it("fresh tail token cap preserves the newest user boundary and following suffix", async () => {
    await ingestMessages(convStore, sumStore, 4, {
      contentFn: (i) => `M${i} ${"z".repeat(396)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 150,
      freshTailCount: 4,
      freshTailMaxTokens: 110,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages.map((message) => extractMessageText(message.content))).toEqual([
      expect.stringContaining("M2"),
      expect.stringContaining("M3"),
    ]);
  });

  it("fresh tail count preserves the newest user boundary and following suffix", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => (i === 0 ? "Current user instruction" : "Assistant response"),
      roleFn: (i) => (i === 0 ? "user" : "assistant"),
    });

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 1,
      freshTailCount: 1,
    });

    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("fresh tail token cap still preserves the newest message when it alone exceeds the cap", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => (i === 1 ? `Huge tail ${"q".repeat(796)}` : `Older ${"q".repeat(196)}`),
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100,
      freshTailCount: 2,
      freshTailMaxTokens: 50,
    });

    const contents = result.messages.map((message) => extractMessageText(message.content));
    expect(contents.some((text) => text.includes("Older"))).toBe(true);
    expect(contents.some((text) => text.includes("Huge tail"))).toBe(true);
  });

  it("drops reverse-ordered tool-call blocks instead of promoting old tool results", async () => {
    await convStore.createConversation({ sessionId: "session-tail-tool-pair" });

    const toolResultMsg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "tool",
      content: "real tool result",
      tokenCount: estimateTokens("real tool result"),
    });
    await convStore.createMessageParts(toolResultMsg.messageId, [
      {
        sessionId: "session-tail-tool-pair",
        partType: "tool",
        ordinal: 0,
        textContent: "real tool result",
        toolCallId: "call_tail",
        toolName: "read",
        metadata: JSON.stringify({
          originalRole: "toolResult",
          rawType: "tool_result",
          toolCallId: "call_tail",
          toolName: "read",
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, toolResultMsg.messageId);

    const assistantMsg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 2,
      role: "assistant",
      content: "tail tool call",
      tokenCount: estimateTokens("tail tool call"),
    });
    await convStore.createMessageParts(assistantMsg.messageId, [
      {
        sessionId: "session-tail-tool-pair",
        partType: "text",
        ordinal: 0,
        textContent: "tail tool call",
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "text",
        }),
      },
      {
        sessionId: "session-tail-tool-pair",
        partType: "tool",
        ordinal: 1,
        toolCallId: "call_tail",
        toolName: "read",
        toolInput: JSON.stringify({ path: "foo.txt" }),
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "toolCall",
          raw: {
            type: "toolCall",
            id: "call_tail",
            name: "read",
            input: { path: "foo.txt" },
          },
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, assistantMsg.messageId);

    const trailingUser = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 3,
      role: "user",
      content: "tail marker",
      tokenCount: estimateTokens("tail marker"),
    });
    await sumStore.appendContextMessage(CONV_ID, trailingUser.messageId);

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 1_000,
      freshTailCount: 2,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("assistant");
    expect(extractMessageText(result.messages[0].content)).toContain("tail tool call");
    expect(
      Array.isArray(result.messages[0].content) &&
      result.messages[0].content.some(
        (block) =>
          block &&
          typeof block === "object" &&
          "type" in block &&
          [
            "toolCall",
            "toolUse",
            "tool_use",
            "tool-use",
            "functionCall",
            "function_call",
          ].includes((block as { type?: string }).type ?? ""),
      ),
    ).toBe(false);
    expect(result.messages[1].role).toBe("user");
    expect(extractMessageText(result.messages[1].content)).toBe("tail marker");
    expect(result.messages.some((message) => message.role === "toolResult")).toBe(false);
    expect(result.debug).toMatchObject({
      selectionMode: "full-fit",
      promotedToolResultCount: 0,
      promotedOrdinals: [],
      freshTailOrdinal: 1,
      baseFreshTailCount: 2,
      freshTailCount: 2,
    });
    expect(result.debug?.finalMessagesHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.debug?.preSanitizeMessagesHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("keeps assembled prompt prefixes stable across append-only turns", async () => {
    await convStore.createConversation({ sessionId: "session-tail-tool-prefix-stability" });

    const toolResultMsg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "tool",
      content: "real tool result",
      tokenCount: estimateTokens("real tool result"),
    });
    await convStore.createMessageParts(toolResultMsg.messageId, [
      {
        sessionId: "session-tail-tool-prefix-stability",
        partType: "tool",
        ordinal: 0,
        textContent: "real tool result",
        toolCallId: "call_stable",
        toolName: "read",
        metadata: JSON.stringify({
          originalRole: "toolResult",
          rawType: "tool_result",
          toolCallId: "call_stable",
          toolName: "read",
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, toolResultMsg.messageId);

    const assistantMsg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 2,
      role: "assistant",
      content: "stable tool call",
      tokenCount: estimateTokens("stable tool call"),
    });
    await convStore.createMessageParts(assistantMsg.messageId, [
      {
        sessionId: "session-tail-tool-prefix-stability",
        partType: "text",
        ordinal: 0,
        textContent: "stable tool call",
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "text",
        }),
      },
      {
        sessionId: "session-tail-tool-prefix-stability",
        partType: "tool",
        ordinal: 1,
        toolCallId: "call_stable",
        toolName: "read",
        toolInput: JSON.stringify({ path: "foo.txt" }),
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "toolCall",
          raw: {
            type: "toolCall",
            id: "call_stable",
            name: "read",
            input: { path: "foo.txt" },
          },
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, assistantMsg.messageId);

    const turnOneMarker = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 3,
      role: "user",
      content: "turn one tail marker",
      tokenCount: estimateTokens("turn one tail marker"),
    });
    await sumStore.appendContextMessage(CONV_ID, turnOneMarker.messageId);

    const turnOne = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      freshTailCount: 2,
    });

    for (const [seq, content] of [
      [4, "turn two tail marker"],
      [5, "turn three tail marker"],
    ] as const) {
      const message = await convStore.createMessage({
        conversationId: CONV_ID,
        seq,
        role: "user",
        content,
        tokenCount: estimateTokens(content),
      });
      await sumStore.appendContextMessage(CONV_ID, message.messageId);
    }

    const turnTwo = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      freshTailCount: 2,
    });

    expect(turnOne.messages.some((message) => message.role === "toolResult")).toBe(false);
    expect(turnTwo.messages.some((message) => message.role === "toolResult")).toBe(false);
    expect(turnTwo.messages.slice(0, turnOne.messages.length)).toEqual(turnOne.messages);
  });

  it("does not let paired tool results bypass fresh tail token caps", async () => {
    await convStore.createConversation({ sessionId: "session-tail-tool-pair-capped" });

    const hugeToolResult = `huge tool result ${"x".repeat(4096)}`;
    const toolResultMsg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "tool",
      content: hugeToolResult,
      tokenCount: estimateTokens(hugeToolResult),
    });
    await convStore.createMessageParts(toolResultMsg.messageId, [
      {
        sessionId: "session-tail-tool-pair-capped",
        partType: "tool",
        ordinal: 0,
        textContent: hugeToolResult,
        toolCallId: "call_tail_capped",
        toolName: "read",
        metadata: JSON.stringify({
          originalRole: "toolResult",
          rawType: "tool_result",
          toolCallId: "call_tail_capped",
          toolName: "read",
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, toolResultMsg.messageId);

    const assistantMsg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 2,
      role: "assistant",
      content: "tail tool call",
      tokenCount: estimateTokens("tail tool call"),
    });
    await convStore.createMessageParts(assistantMsg.messageId, [
      {
        sessionId: "session-tail-tool-pair-capped",
        partType: "text",
        ordinal: 0,
        textContent: "tail tool call",
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "text",
        }),
      },
      {
        sessionId: "session-tail-tool-pair-capped",
        partType: "tool",
        ordinal: 1,
        toolCallId: "call_tail_capped",
        toolName: "read",
        toolInput: JSON.stringify({ path: "foo.txt" }),
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "toolCall",
          raw: {
            type: "toolCall",
            id: "call_tail_capped",
            name: "read",
            input: { path: "foo.txt" },
          },
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, assistantMsg.messageId);

    const trailingUser = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 3,
      role: "user",
      content: "tail marker",
      tokenCount: estimateTokens("tail marker"),
    });
    await sumStore.appendContextMessage(CONV_ID, trailingUser.messageId);

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 120,
      freshTailCount: 2,
      freshTailMaxTokens: 80,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages.some((message) => message.role === "toolResult")).toBe(false);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(extractMessageText(result.messages[0]?.content)).toContain("tail tool call");
    expect(result.messages[1]?.role).toBe("user");
    expect(extractMessageText(result.messages[1]?.content)).toBe("tail marker");
  });

  it("degrades tool rows without toolCallId to assistant text", async () => {
    await ingestMessages(convStore, sumStore, 1, {
      roleFn: () => "tool",
      contentFn: () => "legacy tool output without call id",
    });

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].role).toBe("assistant");
    expect(extractMessageText(result.messages[0].content)).toContain(
      "legacy tool output without call id",
    );
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Compaction
// ═════════════════════════════════════════════════════════════════════════════
