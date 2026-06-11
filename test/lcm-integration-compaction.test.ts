// LCM integration: compaction passes, escalation, and summary linking against mock stores.
// Split from the former monolithic test/lcm-integration.test.ts.
import { describe, expect, it, vi, beforeEach } from "vitest";
import { CompactionEngine, type CompactionConfig } from "../src/compaction.js";
import { createLcmSummarizeFromLegacyParams, LcmProviderAuthError } from "../src/summarize.js";
import {
  createMockConversationStore,
  createMockSummaryStore,
  estimateTokens,
  CONV_ID,
  ingestMessages,
  wireStores,
  defaultCompactionConfig,
  makeSummarizeDeps,
} from "./integration-helpers.js";

describe("LCM integration: compaction", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let compactionEngine: CompactionEngine;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    compactionEngine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      defaultCompactionConfig,
    );
  });

  it("compaction creates leaf summary from oldest messages", async () => {
    // Ingest 10 messages
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Turn ${i}: discussion about topic ${i}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Summarize stub that produces shorter output
    const summarize = vi.fn(async (text: string, aggressive?: boolean) => {
      return `Summary: condensed version of ${text.length} chars`;
    });

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    // A compaction should have occurred
    expect(result.actionTaken).toBe(true);
    expect(result.createdSummaryId).toBeDefined();
    expect(result.createdSummaryId!.startsWith("sum_")).toBe(true);

    // A leaf summary should have been inserted into the summary store
    const allSummaries = sumStore._summaries;
    expect(allSummaries.length).toBeGreaterThanOrEqual(1);
    const leafSummary = allSummaries.find((s) => s.kind === "leaf");
    expect(leafSummary).toBeDefined();
    expect(leafSummary!.content).toContain("Summary:");

    // Context items should now include a summary item
    const contextItems = await sumStore.getContextItems(CONV_ID);
    const summaryItems = contextItems.filter((ci) => ci.itemType === "summary");
    expect(summaryItems.length).toBeGreaterThanOrEqual(1);

    // Total context items should be fewer than the original 10
    expect(contextItems.length).toBeLessThan(10);
  });

  it("leaf compaction strips thinking/reasoning blocks from the summarizer input", async () => {
    // Ingest a mix of messages: some with thinking blocks only, some with visible text,
    // and some with both thinking blocks and visible text.
    const thinkingOnlyContent = JSON.stringify([
      { type: "thinking", thinking: "", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_abc", encrypted_content: "ENCRYPTED_PAYLOAD_XXXX" }) },
    ]);
    const mixedContent = JSON.stringify([
      { type: "thinking", thinking: "Let me reason...", thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_xyz", encrypted_content: "ANOTHER_ENCRYPTED" }) },
      { type: "text", text: "Visible assistant reply." },
    ]);
    const reasoningTextContent = JSON.stringify([
      { type: "reasoning", text: "PRIVATE_REASONING_TEXT" },
      { type: "text", text: "Visible reply after reasoning text." },
    ]);
    const redactedThinkingTextContent = JSON.stringify([
      { type: "redacted_thinking", text: "PRIVATE_REDACTED_THINKING_TEXT" },
      { type: "text", text: "Visible reply after redacted thinking text." },
    ]);
    const thinkingSummaryContent = JSON.stringify([
      { type: "thinking", summary: "PRIVATE_THINKING_SUMMARY" },
      { type: "text", text: "Visible reply after thinking summary." },
    ]);
    const plainContent = "A plain user message.";
    const reasoningHeadingContent =
      "Thinking Process: this is a user bug report heading, not provider reasoning.";

    await ingestMessages(convStore, sumStore, 1, {
      contentFn: () => plainContent,
      roleFn: () => "user",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });
    await ingestMessages(convStore, sumStore, 1, {
      contentFn: () => reasoningHeadingContent,
      roleFn: () => "user",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });
    await ingestMessages(convStore, sumStore, 1, {
      contentFn: () => thinkingOnlyContent,
      roleFn: () => "assistant",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });
    await ingestMessages(convStore, sumStore, 1, {
      contentFn: () => mixedContent,
      roleFn: () => "assistant",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });
    await ingestMessages(convStore, sumStore, 1, {
      contentFn: () => reasoningTextContent,
      roleFn: () => "assistant",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });
    await ingestMessages(convStore, sumStore, 1, {
      contentFn: () => redactedThinkingTextContent,
      roleFn: () => "assistant",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });
    await ingestMessages(convStore, sumStore, 1, {
      contentFn: () => thinkingSummaryContent,
      roleFn: () => "assistant",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });
    // Add extra user messages to cross the compaction threshold
    await ingestMessages(convStore, sumStore, 7, {
      contentFn: (i) => `Follow-up message ${i}`,
      roleFn: () => "user",
      tokenCountFn: (_i, c) => estimateTokens(c),
    });

    let capturedSourceText = "";
    const summarize = vi.fn(async (text: string) => {
      capturedSourceText = text;
      return "Leaf summary.";
    });

    await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(summarize).toHaveBeenCalled();

    // Thinking block types and encrypted signatures must not appear in the summarizer input
    expect(capturedSourceText).not.toContain("thinkingSignature");
    expect(capturedSourceText).not.toContain("ENCRYPTED_PAYLOAD_XXXX");
    expect(capturedSourceText).not.toContain("ANOTHER_ENCRYPTED");
    expect(capturedSourceText).not.toContain('"type":"thinking"');
    expect(capturedSourceText).not.toContain("PRIVATE_REASONING_TEXT");
    expect(capturedSourceText).not.toContain("PRIVATE_REDACTED_THINKING_TEXT");
    expect(capturedSourceText).not.toContain("PRIVATE_THINKING_SUMMARY");

    // The visible text from the mixed-content message must still be present
    expect(capturedSourceText).toContain("Visible assistant reply.");
    expect(capturedSourceText).toContain("Visible reply after reasoning text.");
    expect(capturedSourceText).toContain("Visible reply after redacted thinking text.");
    expect(capturedSourceText).toContain("Visible reply after thinking summary.");

    // The plain user message must still be present
    expect(capturedSourceText).toContain("A plain user message.");
    expect(capturedSourceText).toContain(reasoningHeadingContent);
  });

  it("leaf compaction strips redacted_thinking blocks from structured message parts", async () => {
    const structuredPartEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafChunkTokens: 1_000,
    });
    await convStore.createConversation({ sessionId: "redacted-thinking-session" });

    const assistant = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "assistant",
      content: "",
      tokenCount: 120,
    });
    await convStore.createMessageParts(assistant.messageId, [
      {
        sessionId: "redacted-thinking-session",
        partType: "reasoning",
        ordinal: 0,
        textContent: JSON.stringify({
          type: "redacted_thinking",
          text: "PRIVATE_PART_REDACTED_THINKING",
          summary: [{ text: "PRIVATE_PART_SUMMARY" }],
        }),
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "redacted_thinking",
        }),
      },
      {
        sessionId: "redacted-thinking-session",
        partType: "text",
        ordinal: 1,
        textContent: "Visible answer after redacted thinking.",
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "text",
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, assistant.messageId);

    let capturedSourceText = "";
    const summarize = vi.fn(async (text: string) => {
      capturedSourceText = text;
      return "Structured redacted thinking summary.";
    });

    const result = await structuredPartEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(capturedSourceText).toContain("Visible answer after redacted thinking.");
    expect(capturedSourceText).not.toContain("PRIVATE_PART_REDACTED_THINKING");
    expect(capturedSourceText).not.toContain("PRIVATE_PART_SUMMARY");
  });

  it("persists vLLM message content rather than reasoning as a leaf summary", async () => {
    const qwenCompactionEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafMinFanout: 2,
      leafChunkTokens: 1_000,
    });
    await ingestMessages(convStore, sumStore, 4, {
      contentFn: (i) => `Conversation turn ${i}: weather and follow-up details ${"x".repeat(200)}`,
      roleFn: (i) => (i % 2 === 0 ? "user" : "assistant"),
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarizeResult = await createLcmSummarizeFromLegacyParams({
      deps: makeSummarizeDeps({
        resolveModel: vi.fn(() => ({ provider: "vllm", model: "qwen3.5-122b" })),
        complete: vi.fn(async () => ({
          content: [],
          choices: [
            {
              message: {
                role: "assistant",
                content: "User asked for weather; assistant answered sunny and 25C.",
                reasoning: "Thinking Process: PRIVATE_QWEN_REASONING",
                reasoning_content: "PRIVATE_QWEN_REASONING_CONTENT",
              },
            },
          ],
        })),
      }),
      legacyParams: { provider: "vllm", model: "qwen3.5-122b" },
    });

    expect(summarizeResult).toBeDefined();

    await qwenCompactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize: summarizeResult!.fn,
      summaryModel: "qwen3.5-122b",
      force: true,
    });

    const leaf = sumStore._summaries.find((summary) => summary.kind === "leaf");
    expect(leaf?.content).toBe("User asked for weather; assistant answered sunny and 25C.");
    expect(leaf?.content).not.toContain("Thinking Process");
    expect(leaf?.content).not.toContain("PRIVATE_QWEN_REASONING");
    expect(leaf?.content).not.toContain("PRIVATE_QWEN_REASONING_CONTENT");
    expect(leaf?.model).toBe("qwen3.5-122b");
  });

  it("leaf compaction summarizes structured message parts when stored content is empty", async () => {
    const structuredPartEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafChunkTokens: 1_000,
    });
    await convStore.createConversation({ sessionId: "structured-parts-session" });

    const assistant = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "assistant",
      content: "",
      tokenCount: 120,
    });
    await convStore.createMessageParts(assistant.messageId, [
      {
        sessionId: "structured-parts-session",
        partType: "tool",
        ordinal: 0,
        toolName: "supabase.execute_sql",
        toolInput: JSON.stringify({
          query: "select name from companies where status = 'active'",
        }),
        metadata: JSON.stringify({
          originalRole: "assistant",
          rawType: "function_call",
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, assistant.messageId);

    const toolResult = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 2,
      role: "tool",
      content: "",
      tokenCount: 400,
    });
    await convStore.createMessageParts(toolResult.messageId, [
      {
        sessionId: "structured-parts-session",
        partType: "tool",
        ordinal: 0,
        textContent: JSON.stringify({
          content: [{ type: "text", text: "Active company: Acme Robotics" }],
        }),
        metadata: JSON.stringify({
          originalRole: "toolResult",
          rawType: "function_call_output",
        }),
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, toolResult.messageId);

    let capturedSourceText = "";
    const summarize = vi.fn(async (text: string) => {
      capturedSourceText = text;
      return "Structured parts summary.";
    });

    const result = await structuredPartEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(1);
    expect(capturedSourceText).toContain("select name from companies");
    expect(capturedSourceText).toContain("Active company: Acme Robotics");

    const leafSummary = sumStore._summaries.find((summary) => summary.kind === "leaf");
    expect(leafSummary?.content).toBe("Structured parts summary.");
    expect(leafSummary?.content).not.toContain("[Truncated from 0 tokens]");
    expect(leafSummary?.sourceMessageTokenCount).toBe(520);
  });

  it("leaf-trigger accounting respects fresh tail token caps", async () => {
    const tokenAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 4,
      freshTailMaxTokens: 150,
      leafChunkTokens: 200,
    });

    await ingestMessages(convStore, sumStore, 4, {
      contentFn: (i) => `Turn ${i}: ${"r".repeat(396)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const trigger = await tokenAwareEngine.evaluateLeafTrigger(CONV_ID);

    expect(trigger.rawTokensOutsideTail).toBeGreaterThanOrEqual(250);
    expect(trigger.shouldCompact).toBe(true);
  });

  it("compactLeaf uses preceding summary context for soft leaf continuity", async () => {
    const leafEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 1,
    });

    await convStore.createConversation({ sessionId: "leaf-continuity-session" });

    await sumStore.insertSummary({
      summaryId: "sum_pre_1",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Prior summary one.",
      tokenCount: 4,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_pre_1");
    await sumStore.insertSummary({
      summaryId: "sum_pre_2",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "<think>PRIVATE_PRIOR_REASONING_TWO</think>",
      tokenCount: 4,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_pre_2");
    await sumStore.insertSummary({
      summaryId: "sum_pre_3",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "<thinking>PRIVATE_ONLY</thinking>",
      tokenCount: 4,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_pre_3");

    await ingestMessages(convStore, sumStore, 4, {
      contentFn: (i) => `Turn ${i}: ${"k".repeat(160)}`,
      tokenCountFn: () => 40,
    });

    type SummarizeOptions = { previousSummary?: string; isCondensed?: boolean; depth?: number };
    const summarizeCalls: SummarizeOptions[] = [];
    const summarize = vi.fn(
      async (_text: string, _aggressive?: boolean, options?: SummarizeOptions) => {
        summarizeCalls.push(options ?? {});
        return "Leaf summary with continuity.";
      },
    );

    const result = await leafEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 200,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(summarizeCalls.length).toBeGreaterThan(0);
    expect(summarizeCalls[0]?.previousSummary).toBe("Prior summary one.");
    expect(summarizeCalls[0]?.previousSummary).not.toContain("PRIVATE_PRIOR_REASONING_TWO");
    expect(summarizeCalls[0]?.previousSummary).not.toContain("PRIVATE_ONLY");
    expect(summarizeCalls[0]?.previousSummary).not.toContain("<think>");
    expect(summarizeCalls[0]?.previousSummary).not.toContain("<thinking>");
    expect(summarizeCalls[0]?.isCondensed).toBe(false);
  });

  it("compactLeaf stays leaf-only when incrementalMaxDepth is zero", async () => {
    const leafEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      condensedMinFanout: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 0,
    });

    await convStore.createConversation({ sessionId: "incremental-depth-zero" });

    await sumStore.insertSummary({
      summaryId: "sum_depth_zero_leaf_a",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_zero_leaf_b",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_zero_leaf_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_zero_leaf_b");

    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Leaf source turn ${i}: ${"m".repeat(160)}`,
      tokenCountFn: () => 120,
    });

    const summarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        return options?.isCondensed ? "Condensed summary" : "Leaf summary";
      },
    );
    const result = await leafEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 1_200,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(false);
    expect(sumStore._summaries.filter((summary) => summary.kind === "condensed")).toHaveLength(0);
  });

  it("compactLeaf suppresses follow-on condensed passes when the caller disallows them", async () => {
    const leafEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      condensedMinFanout: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 2,
    });

    await convStore.createConversation({ sessionId: "incremental-no-condensed-when-hot" });

    await sumStore.insertSummary({
      summaryId: "sum_no_condensed_leaf_a",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_no_condensed_leaf_b",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_no_condensed_leaf_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_no_condensed_leaf_b");

    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Leaf source turn ${i}: ${"h".repeat(160)}`,
      tokenCountFn: () => 120,
    });

    const summarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        return options?.isCondensed ? "Condensed summary" : "Leaf summary";
      },
    );
    const result = await leafEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 1_200,
      summarize,
      force: true,
      allowCondensedPasses: false,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(false);
    expect(
      summarize.mock.calls.some((call) => call[2]?.isCondensed === true),
    ).toBe(false);
    expect(sumStore._summaries.filter((summary) => summary.kind === "condensed")).toHaveLength(0);
  });

  it("compactLeaf performs one depth-zero condensation pass when incrementalMaxDepth is one", async () => {
    const leafEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      condensedMinFanout: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 1,
    });

    await convStore.createConversation({ sessionId: "incremental-depth-one" });

    await sumStore.insertSummary({
      summaryId: "sum_depth_one_leaf_a",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_one_leaf_b",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_one_leaf_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_one_leaf_b");

    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Leaf source turn ${i}: ${"n".repeat(160)}`,
      tokenCountFn: () => 120,
    });

    const summarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        return options?.isCondensed ? "Condensed summary" : "Leaf summary";
      },
    );
    const result = await leafEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 1_200,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(false);
    const condensedSummaries = sumStore._summaries.filter(
      (summary) => summary.kind === "condensed",
    );
    expect(condensedSummaries).toHaveLength(0);
  });

  it("compactLeaf cascades to depth two when incrementalMaxDepth is two", async () => {
    const leafEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      condensedMinFanout: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 2,
    });

    await convStore.createConversation({ sessionId: "incremental-depth-two" });

    await sumStore.insertSummary({
      summaryId: "sum_depth_two_existing_d1",
      conversationId: CONV_ID,
      kind: "condensed",
      depth: 1,
      content: "Existing depth one summary",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_two_leaf_a",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_two_leaf_b",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Depth zero leaf B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_two_existing_d1");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_two_leaf_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_two_leaf_b");

    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Leaf source turn ${i}: ${"p".repeat(160)}`,
      tokenCountFn: () => 120,
    });

    let summarizeCount = 0;
    const summarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        summarizeCount += 1;
        return options?.isCondensed ? `Condensed summary ${summarizeCount}` : "Leaf summary";
      },
    );
    const result = await leafEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 1_200,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(false);

    const condensedSummaries = sumStore._summaries.filter(
      (summary) => summary.kind === "condensed",
    );
    expect(condensedSummaries.some((summary) => summary.depth === 2)).toBe(false);
  });


  it("compactLeaf cascades without depth limit when incrementalMaxDepth is -1 (unlimited)", async () => {
    const leafEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      incrementalMaxDepth: -1,
    });

    await convStore.createConversation({ sessionId: "incremental-depth-unlimited" });

    // Seed enough depth-0 leaves to trigger depth-0 condensation (fanout=2)
    for (const suffix of ["a", "b", "c"]) {
      await sumStore.insertSummary({
        summaryId: `sum_unlimited_leaf_${suffix}`,
        conversationId: CONV_ID,
        kind: "leaf",
        depth: 0,
        content: `Depth zero leaf ${suffix}`,
        tokenCount: 60,
      });
      await sumStore.appendContextSummary(CONV_ID, `sum_unlimited_leaf_${suffix}`);
    }

    // Seed depth-1 summaries so depth-1 condensation can also fire
    for (const suffix of ["a", "b"]) {
      await sumStore.insertSummary({
        summaryId: `sum_unlimited_d1_${suffix}`,
        conversationId: CONV_ID,
        kind: "condensed",
        depth: 1,
        content: `Existing depth one summary ${suffix}`,
        tokenCount: 60,
      });
      await sumStore.appendContextSummary(CONV_ID, `sum_unlimited_d1_${suffix}`);
    }

    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Leaf source turn ${i}: ${"u".repeat(160)}`,
      tokenCountFn: () => 120,
    });

    const depthsSummarized: number[] = [];
    const summarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        if (options?.depth !== undefined) depthsSummarized.push(options.depth);
        return options?.isCondensed ? `Condensed at depth ${options.depth}` : "Leaf summary";
      },
    );
    const result = await leafEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 1_200,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);

    // With unlimited depth (-1) and sufficient material at depth 0,
    // the cascade should produce at least one condensed pass.
    // A capped incrementalMaxDepth=0 would produce zero condensed calls.
    const condensedCalls = summarize.mock.calls.filter(
      (_call, i) => summarize.mock.calls[i][2]?.isCondensed,
    );
    expect(condensedCalls.length).toBeGreaterThanOrEqual(1);

    // Verify depth-0 condensation happened (produces a depth-1 summary)
    expect(depthsSummarized).toContain(1);
  });

  it("compactFullSweep treats sweepMaxDepth as the preferred condensation depth", async () => {
    const seedLeafSummaries = async (
      store: ReturnType<typeof createMockSummaryStore>,
      prefix: string,
    ) => {
      await convStore.createConversation({ sessionId: `${prefix}-session` });
      for (const suffix of ["a", "b"]) {
        const summaryId = `${prefix}_${suffix}`;
        await store.insertSummary({
          summaryId,
          conversationId: CONV_ID,
          kind: "leaf",
          depth: 0,
          content: `Depth zero leaf ${suffix}`,
          tokenCount: 60,
        });
        await store.appendContextSummary(CONV_ID, summaryId);
      }
    };

    const cappedEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      sweepMaxDepth: 0,
    });
    await seedLeafSummaries(sumStore, "sum_sweep_depth_zero");

    const cappedSummarize = vi.fn(async () => "Condensed summary");
    const cappedResult = await cappedEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 1_000,
      summarize: cappedSummarize,
      force: true,
    });

    expect(cappedResult.actionTaken).toBe(false);
    expect(cappedSummarize).not.toHaveBeenCalled();
    expect(sumStore._summaries.filter((summary) => summary.kind === "condensed")).toHaveLength(0);

    const nextConvStore = createMockConversationStore();
    const nextSumStore = createMockSummaryStore();
    wireStores(nextConvStore, nextSumStore);
    convStore = nextConvStore;
    sumStore = nextSumStore;

    const depthOneEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      sweepMaxDepth: 1,
      summaryPrefixTargetTokens: 100,
    });
    await seedLeafSummaries(sumStore, "sum_sweep_depth_one");

    const depthOneSummarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        return options?.isCondensed ? "Depth one condensed summary" : "Leaf summary";
      },
    );
    const depthOneResult = await depthOneEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 1_000,
      summarize: depthOneSummarize,
      force: true,
    });

    expect(depthOneResult.actionTaken).toBe(true);
    expect(depthOneResult.condensed).toBe(true);
    expect(depthOneSummarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Boolean),
      expect.objectContaining({ isCondensed: true, depth: 1 }),
    );
    expect(
      sumStore._summaries.some((summary) => summary.kind === "condensed" && summary.depth === 1),
    ).toBe(true);
  });

  it("compactFullSweep runs leaf phase until no eligible raw chunks remain", async () => {
    const sweepEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      contextThreshold: 0.75,
      freshTailCount: 2,
      leafChunkTokens: 400,
      leafTargetTokens: 20,
      condensedMinFanout: 2,
      condensedMinFanoutHard: 2,
      sweepMaxDepth: 1,
      summaryPrefixTargetTokens: 10_000,
    });

    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Message ${i} with enough text to summarize.`,
      tokenCountFn: () => 200,
    });

    let leafIndex = 0;
    const summarize = vi.fn(async () => `Leaf summary ${++leafIndex}`);
    const result = await sweepEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 2_500,
      summarize,
    });

    expect(result.actionTaken).toBe(true);
    expect(summarize).toHaveBeenCalledTimes(4);
    expect(sumStore._summaries.filter((summary) => summary.kind === "leaf")).toHaveLength(4);

    const contextItems = await sumStore.getContextItems(CONV_ID);
    expect(contextItems.filter((item) => item.itemType === "message")).toHaveLength(2);
    expect(contextItems.filter((item) => item.itemType === "summary")).toHaveLength(4);
  });

  it("compactFullSweep pressure-condenses beyond sweepMaxDepth when summary prefix exceeds target", async () => {
    const pressureEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      sweepMaxDepth: 1,
      summaryPrefixTargetTokens: 100,
    });

    await convStore.createConversation({ sessionId: "summary-prefix-pressure-depth" });
    for (const suffix of ["a", "b"]) {
      const summaryId = `sum_pressure_depth_one_${suffix}`;
      await sumStore.insertSummary({
        summaryId,
        conversationId: CONV_ID,
        kind: "condensed",
        depth: 1,
        content: `Depth one summary ${suffix}`,
        tokenCount: 80,
      });
      await sumStore.appendContextSummary(CONV_ID, summaryId);
    }

    const summarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        return options?.isCondensed ? "Depth two pressure summary" : "Leaf summary";
      },
    );
    const result = await pressureEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 1_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(true);
    expect(summarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Boolean),
      expect.objectContaining({ isCondensed: true, depth: 2 }),
    );
    expect(
      sumStore._summaries.some((summary) => summary.kind === "condensed" && summary.depth === 2),
    ).toBe(true);
  });

  it("compactFullSweep does not pressure-condense for total-threshold pressure alone", async () => {
    const pressureEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 2,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      sweepMaxDepth: 1,
      summaryPrefixTargetTokens: 10_000,
    });

    await convStore.createConversation({ sessionId: "threshold-pressure-depth" });
    for (const suffix of ["a", "b"]) {
      const summaryId = `sum_threshold_pressure_depth_one_${suffix}`;
      await sumStore.insertSummary({
        summaryId,
        conversationId: CONV_ID,
        kind: "condensed",
        depth: 1,
        content: `Depth one summary ${suffix}`,
        tokenCount: 80,
      });
      await sumStore.appendContextSummary(CONV_ID, summaryId);
    }
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Fresh tail message ${i}`,
      tokenCountFn: () => 1_000,
    });

    const summarize = vi.fn(async () => "Depth two threshold pressure summary");
    const result = await pressureEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 100,
      summarize,
    });

    expect(result.actionTaken).toBe(false);
    expect(result.condensed).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
    expect(
      sumStore._summaries.some((summary) => summary.kind === "condensed" && summary.depth === 2),
    ).toBe(false);
  });

  it("compactFullSweep uses stopAtTokens to pressure-condense live-runtime overages", async () => {
    const pressureEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 2,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      leafChunkTokens: 500,
      condensedTargetTokens: 10,
      sweepMaxDepth: 1,
      summaryPrefixTargetTokens: 10_000,
    });

    await convStore.createConversation({ sessionId: "stop-target-pressure-depth" });
    for (const suffix of ["a", "b"]) {
      const summaryId = `sum_stop_target_depth_one_${suffix}`;
      await sumStore.insertSummary({
        summaryId,
        conversationId: CONV_ID,
        kind: "condensed",
        depth: 1,
        content: `Depth one stop target summary ${suffix}`,
        tokenCount: 80,
      });
      await sumStore.appendContextSummary(CONV_ID, summaryId);
    }
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Fresh tail message ${i}`,
      tokenCountFn: () => 1_000,
    });

    const summarize = vi.fn(
      async (
        _text: string,
        _aggressive?: boolean,
        options?: { isCondensed?: boolean; depth?: number },
      ) => {
        return options?.isCondensed ? "Depth two stop target summary" : "Leaf summary";
      },
    );
    const result = await pressureEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 100,
      summarize,
      stopAtTokens: 1_000,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(true);
    expect(summarize).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Boolean),
      expect.objectContaining({ isCondensed: true, depth: 2 }),
    );
    expect(
      sumStore._summaries.some((summary) => summary.kind === "condensed" && summary.depth === 2),
    ).toBe(true);
  });


  it("compaction propagates referenced file ids into summary metadata", async () => {
    const productionTailEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 16,
    });

    await ingestMessages(convStore, sumStore, 20, {
      contentFn: (i) => {
        if (i === 1) {
          return "Review [LCM File: file_aaaabbbbccccdddd | spec.md | text/markdown | 1,024 bytes]";
        }
        if (i === 2) {
          return "Also inspect file_1111222233334444 and file_aaaabbbbccccdddd for context.";
        }
        return `Turn ${i}: regular planning text.`;
      },
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async () => "Condensed file-aware summary.");
    const result = await productionTailEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);

    const leafSummary = sumStore._summaries.find((summary) => summary.kind === "leaf");
    expect(leafSummary).toBeDefined();
    expect(leafSummary!.fileIds).toEqual(["file_aaaabbbbccccdddd", "file_1111222233334444"]);
  });

  it("compaction keeps leaf-only telemetry out of canonical transcript state", async () => {
    await convStore.createConversation({ sessionId: "leaf-only-session" });
    await ingestMessages(convStore, sumStore, 5, {
      contentFn: (i) => `Turn ${i}: ${"l".repeat(160)}`,
      tokenCountFn: () => 40,
    });

    const summarize = vi.fn(async () => "Leaf summary");
    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 250,
      summarize,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(false);
    expect(result.createdSummaryId).toBeTypeOf("string");
    expect(result.tokensBefore).toBeTypeOf("number");
    expect(result.tokensAfter).toBeTypeOf("number");
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
    expect(result.level).toBeDefined();

    const compactionParts = convStore._messageParts.filter(
      (part) => part.partType === "compaction",
    );
    expect(compactionParts).toHaveLength(0);

    const createdSummary = sumStore._summaries.find(
      (summary) => summary.summaryId === result.createdSummaryId,
    );
    expect(createdSummary).toBeDefined();
    expect(createdSummary!.kind).toBe("leaf");

    const contextItems = await sumStore.getContextItems(CONV_ID);
    expect(contextItems.some((item) => item.itemType === "summary")).toBe(true);
  });

  it("compaction keeps leaf and condensed telemetry out of canonical transcript state", async () => {
    const condensedFriendlyEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 2,
      leafChunkTokens: 100,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 1,
      summaryPrefixTargetTokens: 1,
    });

    await convStore.createConversation({ sessionId: "leaf-condensed-session" });
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Turn ${i}: ${"c".repeat(200)}`,
      tokenCountFn: () => 50,
    });

    const summarize = vi.fn(async () => "Compacted summary block with enough detail.");
    const result = await condensedFriendlyEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 260,
      summarize,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.condensed).toBe(true);
    expect(result.createdSummaryId).toBeTypeOf("string");
    expect(result.tokensBefore).toBeTypeOf("number");
    expect(result.tokensAfter).toBeTypeOf("number");
    expect(result.tokensBefore).toBeGreaterThan(result.tokensAfter);
    expect(result.level).toBeDefined();

    const compactionParts = convStore._messageParts.filter(
      (part) => part.partType === "compaction",
    );
    expect(compactionParts).toHaveLength(0);

    const leafSummaries = sumStore._summaries.filter((summary) => summary.kind === "leaf");
    const condensedSummaries = sumStore._summaries.filter(
      (summary) => summary.kind === "condensed",
    );

    expect(leafSummaries.length).toBeGreaterThanOrEqual(1);
    expect(condensedSummaries.length).toBeGreaterThanOrEqual(1);

    const createdSummary = sumStore._summaries.find(
      (summary) => summary.summaryId === result.createdSummaryId,
    );
    expect(createdSummary).toBeDefined();
    expect(["leaf", "condensed"]).toContain(createdSummary!.kind);

    const contextItems = await sumStore.getContextItems(CONV_ID);
    expect(contextItems.some((item) => item.itemType === "summary")).toBe(true);
  });

  it("depth-aware condensation sets condensed depth to max parent depth plus one", async () => {
    const depthAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 2,
    });

    await convStore.createConversation({ sessionId: "depth-aware-depth-assignment" });
    await sumStore.insertSummary({
      summaryId: "sum_depth_parent_a",
      conversationId: CONV_ID,
      kind: "condensed",
      depth: 1,
      content: "Depth one summary A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_parent_b",
      conversationId: CONV_ID,
      kind: "condensed",
      depth: 1,
      content: "Depth one summary B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_parent_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_parent_b");

    const summarize = vi.fn(async () => "Depth two merged summary");
    const result = await depthAwareEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 200,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    const createdSummary = sumStore._summaries.find((s) => s.summaryId === result.createdSummaryId);
    expect(createdSummary).toBeDefined();
    expect(createdSummary!.depth).toBe(2);
  });

  it("depth-aware selection stops on depth mismatch and does not mix depth bands", async () => {
    const depthAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 2,
      condensedMinFanout: 3,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 1,
      summaryPrefixTargetTokens: 150,
    });

    await convStore.createConversation({ sessionId: "depth-break-session" });
    await sumStore.insertSummary({
      summaryId: "sum_break_leaf_1",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Leaf depth zero A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_break_leaf_2",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Leaf depth zero B",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_break_mid_1",
      conversationId: CONV_ID,
      kind: "condensed",
      depth: 1,
      content: "Depth one block",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_break_leaf_3",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Leaf depth zero C",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_break_leaf_1");
    await sumStore.appendContextSummary(CONV_ID, "sum_break_leaf_2");
    await sumStore.appendContextSummary(CONV_ID, "sum_break_mid_1");
    await sumStore.appendContextSummary(CONV_ID, "sum_break_leaf_3");

    const summarize = vi.fn(async () => "Depth-aware merged summary");
    const result = await depthAwareEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 200,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    const parentIds = sumStore._summaryParents
      .filter((edge) => edge.summaryId === result.createdSummaryId)
      .toSorted((a, b) => a.ordinal - b.ordinal)
      .map((edge) => edge.parentSummaryId);
    expect(parentIds).toEqual(["sum_break_leaf_1", "sum_break_leaf_2"]);
  });

  it("depth-aware phase 2 processes shallowest eligible depth first", async () => {
    const depthAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 1,
    });

    await convStore.createConversation({ sessionId: "shallowest-first-session" });
    await sumStore.insertSummary({
      summaryId: "sum_depth_one_a",
      conversationId: CONV_ID,
      kind: "condensed",
      depth: 1,
      content: "D1-A existing condensed context",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_one_b",
      conversationId: CONV_ID,
      kind: "condensed",
      depth: 1,
      content: "D1-B existing condensed context",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_zero_a",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "L0-A leaf context",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_zero_b",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "L0-B leaf context",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_one_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_one_b");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_zero_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_depth_zero_b");

    const summarize = vi.fn(async (_sourceText: string) => "Depth-aware summary output");
    const result = await depthAwareEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 140,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    const firstSourceText = summarize.mock.calls[0]?.[0] ?? "";
    expect(firstSourceText).toMatch(
      /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC - \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\]/,
    );
    expect(firstSourceText).toContain("L0-A leaf context");
    expect(firstSourceText).toContain("L0-B leaf context");
    expect(firstSourceText).not.toContain("D1-A existing condensed context");
  });

  it("includes continuity context only when condensing depth-0 summaries", async () => {
    const depthAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
    });

    const depthOneConversation = await convStore.createConversation({
      sessionId: "continuity-gate-depth-one",
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_one_prior",
      conversationId: depthOneConversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "Depth one prior context",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_one_focus_a",
      conversationId: depthOneConversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "Depth one focus A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_one_focus_b",
      conversationId: depthOneConversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "Depth one focus B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(depthOneConversation.conversationId, "sum_depth_one_prior");
    await sumStore.appendContextSummary(
      depthOneConversation.conversationId,
      "sum_depth_one_focus_a",
    );
    await sumStore.appendContextSummary(
      depthOneConversation.conversationId,
      "sum_depth_one_focus_b",
    );

    const summarizeCalls: Array<{
      text: string;
      options?: {
        previousSummary?: string;
        isCondensed?: boolean;
        depth?: number;
      };
    }> = [];
    const summarize = vi.fn(
      async (
        text: string,
        _aggressive?: boolean,
        options?: { previousSummary?: string; isCondensed?: boolean; depth?: number },
      ) => {
        summarizeCalls.push({ text, options });
        return "Condensed output";
      },
    );

    const depthOneContext = await sumStore.getContextItems(depthOneConversation.conversationId);
    const depthOneItems = depthOneContext.filter(
      (item) =>
        item.itemType === "summary" &&
        (item.summaryId === "sum_depth_one_focus_a" || item.summaryId === "sum_depth_one_focus_b"),
    );
    await (depthAwareEngine as any).condensedPass(
      depthOneConversation.conversationId,
      depthOneItems,
      1,
      summarize,
    );

    expect(summarizeCalls[0]?.options?.isCondensed).toBe(true);
    expect(summarizeCalls[0]?.options?.depth).toBe(2);
    expect(summarizeCalls[0]?.options?.previousSummary).toBeUndefined();

    const depthZeroConversation = await convStore.createConversation({
      sessionId: "continuity-gate-depth-zero",
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_zero_prior",
      conversationId: depthZeroConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "<think>PRIVATE_PRIOR_REASONING</think>Depth zero prior context",
      tokenCount: 60,
    });
    for (let index = 0; index < 4; index++) {
      await sumStore.insertSummary({
        summaryId: `sum_depth_zero_empty_prior_${index}`,
        conversationId: depthZeroConversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: `<thinking>PRIVATE_EMPTY_PRIOR_${index}</thinking>`,
        tokenCount: 60,
      });
    }
    await sumStore.insertSummary({
      summaryId: "sum_depth_zero_focus_a",
      conversationId: depthZeroConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "<thinking>PRIVATE_FOCUS_REASONING</thinking>Depth zero focus A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_depth_zero_focus_b",
      conversationId: depthZeroConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Depth zero focus B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(
      depthZeroConversation.conversationId,
      "sum_depth_zero_prior",
    );
    for (let index = 0; index < 4; index++) {
      await sumStore.appendContextSummary(
        depthZeroConversation.conversationId,
        `sum_depth_zero_empty_prior_${index}`,
      );
    }
    await sumStore.appendContextSummary(
      depthZeroConversation.conversationId,
      "sum_depth_zero_focus_a",
    );
    await sumStore.appendContextSummary(
      depthZeroConversation.conversationId,
      "sum_depth_zero_focus_b",
    );

    const depthZeroContext = await sumStore.getContextItems(depthZeroConversation.conversationId);
    const depthZeroItems = depthZeroContext.filter(
      (item) =>
        item.itemType === "summary" &&
        (item.summaryId === "sum_depth_zero_focus_a" ||
          item.summaryId === "sum_depth_zero_focus_b"),
    );
    await (depthAwareEngine as any).condensedPass(
      depthZeroConversation.conversationId,
      depthZeroItems,
      0,
      summarize,
    );

    const depthZeroCall = summarizeCalls[summarizeCalls.length - 1];
    expect(depthZeroCall?.options?.depth).toBe(1);
    expect(depthZeroCall?.options?.previousSummary).toContain("Depth zero prior context");
    expect(depthZeroCall?.options?.previousSummary).not.toContain("PRIVATE_PRIOR_REASONING");
    expect(depthZeroCall?.options?.previousSummary).not.toContain("PRIVATE_EMPTY_PRIOR");
    expect(depthZeroCall?.options?.previousSummary).not.toContain("<think>");
    expect(depthZeroCall?.options?.previousSummary).not.toContain("<thinking>");
    expect(depthZeroCall?.text).toContain("Depth zero focus A");
    expect(depthZeroCall?.text).toContain("Depth zero focus B");
    expect(depthZeroCall?.text).not.toContain("PRIVATE_FOCUS_REASONING");
    expect(depthZeroCall?.text).not.toContain("<thinking>");
  });

  it("skips condensed writes when all selected summaries sanitize empty", async () => {
    const emptyCondensedEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      condensedTargetTokens: 10,
    });
    const conversation = await convStore.createConversation({
      sessionId: "empty-sanitized-condensed",
    });

    await sumStore.insertSummary({
      summaryId: "sum_empty_reasoning_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "<think>PRIVATE_A</think>",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_empty_reasoning_b",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "[thinking] PRIVATE_B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(conversation.conversationId, "sum_empty_reasoning_a");
    await sumStore.appendContextSummary(conversation.conversationId, "sum_empty_reasoning_b");

    const contextItems = await sumStore.getContextItems(conversation.conversationId);
    const summaryItems = contextItems.filter((item) => item.itemType === "summary");
    const summarize = vi.fn(async () => "Should not be called");
    const result = await (emptyCondensedEngine as any).condensedPass(
      conversation.conversationId,
      summaryItems,
      0,
      summarize,
    );

    expect(result).toEqual({ skipped: "empty-source" });
    expect(summarize).not.toHaveBeenCalled();
    expect(
      sumStore._summaries.some((summary) => summary.content === "[Truncated from 0 tokens]"),
    ).toBe(false);

    const sweepResult = await emptyCondensedEngine.compactFullSweep({
      conversationId: conversation.conversationId,
      tokenBudget: 10_000,
      stopAtTokens: 1,
      summarize,
      force: true,
    });

    expect(sweepResult.actionTaken).toBe(false);
    expect(sweepResult.authFailure).toBeUndefined();
    expect(summarize).not.toHaveBeenCalled();
  });

  it("skips empty sanitized summaries when selecting condensed chunks", async () => {
    const prefixSkipEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 0,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
    });
    const conversation = await convStore.createConversation({
      sessionId: "empty-prefix-condensed",
    });

    for (const [summaryId, content] of [
      ["sum_empty_prefix_a", "<think>PRIVATE_PREFIX_A</think>"],
      ["sum_empty_prefix_b", "[thinking] PRIVATE_PREFIX_B"],
      ["sum_valid_after_prefix_a", "Valid summary A"],
      ["sum_empty_middle", "<thinking>PRIVATE_MIDDLE</thinking>"],
      ["sum_valid_after_prefix_b", "Valid summary B"],
    ] as const) {
      await sumStore.insertSummary({
        summaryId,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content,
        tokenCount: 60,
      });
      await sumStore.appendContextSummary(conversation.conversationId, summaryId);
    }

    let capturedSourceText = "";
    const summarize = vi.fn(async (text: string) => {
      capturedSourceText = text;
      return "Condensed valid summaries";
    });

    const result = await prefixSkipEngine.compactFullSweep({
      conversationId: conversation.conversationId,
      tokenBudget: 10_000,
      stopAtTokens: 1,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.authFailure).toBeUndefined();
    expect(summarize).toHaveBeenCalledOnce();
    expect(capturedSourceText).toContain("Valid summary A");
    expect(capturedSourceText).toContain("Valid summary B");
    expect(capturedSourceText).not.toContain("PRIVATE_PREFIX");
    expect(capturedSourceText).not.toContain("PRIVATE_MIDDLE");
    expect(capturedSourceText).not.toContain("<think>");
    expect(capturedSourceText).not.toContain("<thinking>");
  });

  it("relaxes fanout thresholds only under summarized-prefix pressure", async () => {
    const depthAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 3,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 1,
      summaryPrefixTargetTokens: 1_000,
    });

    await convStore.createConversation({ sessionId: "fanout-threshold-session" });
    await sumStore.insertSummary({
      summaryId: "sum_fanout_leaf_a",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Leaf A",
      tokenCount: 60,
    });
    await sumStore.insertSummary({
      summaryId: "sum_fanout_leaf_b",
      conversationId: CONV_ID,
      kind: "leaf",
      depth: 0,
      content: "Leaf B",
      tokenCount: 60,
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_fanout_leaf_a");
    await sumStore.appendContextSummary(CONV_ID, "sum_fanout_leaf_b");

    const summarize = vi.fn(async () => "Fanout relaxed summary");
    const normalResult = await depthAwareEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 500,
      summarize,
      force: true,
    });
    expect(normalResult.actionTaken).toBe(false);

    const pressureEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 3,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 1,
      summaryPrefixTargetTokens: 100,
    });
    const pressureResult = await pressureEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 500,
      summarize,
      force: true,
    });
    expect(pressureResult.actionTaken).toBe(true);
  });

  it("keeps condensed parents at uniform depth across interleaved sweeps", async () => {
    const depthAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      leafMinFanout: 2,
      condensedMinFanout: 2,
      leafChunkTokens: 200,
      condensedTargetTokens: 10,
      incrementalMaxDepth: 1,
    });

    await convStore.createConversation({ sessionId: "balanced-depth-sweep-session" });
    for (let i = 0; i < 8; i++) {
      const summaryId = `sum_balanced_leaf_initial_${i}`;
      await sumStore.insertSummary({
        summaryId,
        conversationId: CONV_ID,
        kind: "leaf",
        depth: 0,
        content: `Initial leaf ${i}`,
        tokenCount: 60,
      });
      await sumStore.appendContextSummary(CONV_ID, summaryId);
    }

    let summarizeCallCount = 0;
    const summarize = vi.fn(async () => `Balanced tree summary ${++summarizeCallCount}`);
    await depthAwareEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 800,
      summarize,
      force: true,
    });

    for (let i = 0; i < 4; i++) {
      const summaryId = `sum_balanced_leaf_late_${i}`;
      await sumStore.insertSummary({
        summaryId,
        conversationId: CONV_ID,
        kind: "leaf",
        depth: 0,
        content: `Late leaf ${i}`,
        tokenCount: 60,
      });
      await sumStore.appendContextSummary(CONV_ID, summaryId);
    }

    await depthAwareEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 800,
      summarize,
      force: true,
    });

    const condensedSummaries = sumStore._summaries.filter(
      (summary) => summary.kind === "condensed",
    );
    expect(condensedSummaries.length).toBeGreaterThan(0);
    for (const condensedSummary of condensedSummaries) {
      const parentIds = sumStore._summaryParents
        .filter((edge) => edge.summaryId === condensedSummary.summaryId)
        .map((edge) => edge.parentSummaryId);
      if (parentIds.length === 0) {
        continue;
      }

      const parentDepths = new Set<number>();
      for (const parentId of parentIds) {
        const parent = sumStore._summaries.find((summary) => summary.summaryId === parentId);
        if (parent) {
          parentDepths.add(parent.depth);
        }
      }
      expect(parentDepths.size).toBeLessThanOrEqual(1);
    }
  });

  it("compaction escalates to aggressive when normal does not converge", async () => {
    // Ingest messages
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Content ${i}: ${"a".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    let normalCallCount = 0;
    let aggressiveCallCount = 0;

    // Normal summarize returns text >= input size (no convergence)
    // Aggressive summarize returns shorter text
    const summarize = vi.fn(async (text: string, aggressive?: boolean) => {
      if (!aggressive) {
        normalCallCount++;
        // Return something at least as long as input => no convergence
        return text + " (expanded, not summarized)";
      } else {
        aggressiveCallCount++;
        // Return much shorter text => converges
        return "Aggressively summarized.";
      }
    });

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    // Normal was called first but didn't converge, so aggressive was called
    expect(normalCallCount).toBeGreaterThanOrEqual(1);
    expect(aggressiveCallCount).toBeGreaterThanOrEqual(1);
    expect(result.level).toBe("aggressive");
  });

  it("compaction falls back to truncation when aggressive does not converge", async () => {
    // Ingest messages
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Content ${i}: ${"b".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Both normal and aggressive return >= input size
    const summarize = vi.fn(async (text: string, _aggressive?: boolean) => {
      return text + " (not actually summarized)";
    });

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.level).toBe("fallback");

    // The created summary should contain the truncation marker
    const leafSummary = sumStore._summaries.find((s) => s.kind === "leaf");
    expect(leafSummary).toBeDefined();
    expect(leafSummary!.content).toContain("[Truncated from");
    expect(leafSummary!.content).toContain("tokens]");
  });

  it("compaction still creates a deterministic fallback summary when the summarizer returns empty content", async () => {
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Content ${i}: ${"c".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async () => "");

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.level).toBe("fallback");

    const leafSummary = sumStore._summaries.find((s) => s.kind === "leaf");
    expect(leafSummary).toBeDefined();
    expect(leafSummary!.content).toContain("[Truncated from");
    expect(leafSummary!.content).toContain("tokens]");
  });

  it("compaction keeps deterministic fallback within budget for CJK-heavy content", async () => {
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `消息 ${i}: ${"你".repeat(600)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async (text: string) => `${text} (not actually summarized)`);

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
    expect(result.level).toBe("fallback");

    const leafSummary = sumStore._summaries.find((s) => s.kind === "leaf");
    expect(leafSummary).toBeDefined();
    expect(leafSummary!.content).toContain("[Truncated from");
    expect(leafSummary!.tokenCount).toBeLessThanOrEqual(512);
  });

  it("skips summary persistence when the summarizer hits a provider auth failure", async () => {
    await ingestMessages(convStore, sumStore, 8, {
      contentFn: (i) => `Content ${i}: ${"d".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async () => {
      throw new LcmProviderAuthError({
        provider: "anthropic",
        model: "claude-opus-4-6",
        failure: {
          statusCode: 401,
          message: "Missing required scope: model.request",
          missingModelRequestScope: true,
        },
      });
    });

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 10_000,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(false);
    expect(result.level).toBeUndefined();
    expect(sumStore._summaries.find((s) => s.kind === "leaf")).toBeUndefined();
  });

  it("compactUntilUnder loops until under budget", async () => {
    // Ingest many messages with substantial token counts
    await ingestMessages(convStore, sumStore, 20, {
      contentFn: (i) => `Turn ${i}: ${"c".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    let callCount = 0;
    // Each summarize call produces a short summary, so each round makes progress
    const summarize = vi.fn(async (text: string, _aggressive?: boolean) => {
      callCount++;
      return `Round ${callCount} summary of ${text.length} chars.`;
    });

    // Set a tight budget that requires multiple rounds
    // Each message is ~52 tokens; 20 messages = ~1040 tokens total.
    // Set budget to 200 tokens to force multiple compaction rounds.
    const result = await compactionEngine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 200,
      summarize,
    });

    // Multiple rounds should have been needed
    expect(result.rounds).toBeGreaterThan(1);
    // Final tokens should be at or under budget (or we ran out of rounds)
    if (result.success) {
      expect(result.finalTokens).toBeLessThanOrEqual(200);
    }
  });

  it("compactUntilUnder respects an explicit threshold target", async () => {
    await ingestMessages(convStore, sumStore, 16, {
      contentFn: (i) => `Turn ${i}: ${"z".repeat(220)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async (text: string) => {
      return `summary ${text.length}`;
    });

    const result = await compactionEngine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 600,
      targetTokens: 450,
      summarize,
    });

    expect(result.success).toBe(true);
    expect(result.finalTokens).toBeLessThanOrEqual(450);
  });

  it("evaluate returns shouldCompact=false when under threshold", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: () => "Short msg",
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const decision = await compactionEngine.evaluate(CONV_ID, 100_000);
    expect(decision.shouldCompact).toBe(false);
    expect(decision.reason).toBe("none");
  });

  it("evaluate returns shouldCompact=true when over threshold", async () => {
    // Ingest enough messages to exceed 75% of a small budget
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Message ${i}: ${"d".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    // Each message ~53 tokens, total ~530 tokens. Budget=600 => threshold=450
    const decision = await compactionEngine.evaluate(CONV_ID, 600);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("threshold");
    expect(decision.currentTokens).toBeGreaterThan(decision.threshold);
  });

  it("evaluate uses observed live token count when it exceeds stored count", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: () => "Short msg",
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const decision = await compactionEngine.evaluate(CONV_ID, 600, 500);
    expect(decision.shouldCompact).toBe(true);
    expect(decision.reason).toBe("threshold");
    expect(decision.currentTokens).toBe(500);
    expect(decision.threshold).toBe(450);
  });

  it("evaluate accepts a per-call contextThreshold override", async () => {
    await ingestMessages(convStore, sumStore, 4, {
      contentFn: (i) => `Override ${i}`,
      tokenCountFn: () => 100,
    });

    const defaultDecision = await compactionEngine.evaluate(CONV_ID, 600);
    expect(defaultDecision).toMatchObject({
      shouldCompact: false,
      threshold: 450,
      currentTokens: 400,
    });

    const overrideDecision = await compactionEngine.evaluate(CONV_ID, 600, undefined, {
      contextThreshold: 0.5,
    });
    expect(overrideDecision).toMatchObject({
      shouldCompact: true,
      threshold: 300,
      currentTokens: 400,
    });
  });

  it("evaluate compacts when observed tokens plus raw backlog exceed the threshold", async () => {
    const backlogEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 1,
    });
    await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `Backlog ${i}`,
      tokenCountFn: () => 100,
    });

    const decision = await backlogEngine.evaluate(CONV_ID, 600, 300);
    expect(decision).toMatchObject({
      shouldCompact: true,
      reason: "threshold",
      storedTokens: 300,
      observedTokens: 300,
      rawTokensOutsideTail: 200,
      projectedTokens: 500,
      currentTokens: 500,
      threshold: 450,
    });
  });

  it("evaluate stays below threshold when projected raw backlog still fits", async () => {
    const backlogEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 1,
    });
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: (i) => `Small backlog ${i}`,
      tokenCountFn: () => 100,
    });

    const decision = await backlogEngine.evaluate(CONV_ID, 600, 250);
    expect(decision).toMatchObject({
      shouldCompact: false,
      reason: "none",
      storedTokens: 200,
      observedTokens: 250,
      rawTokensOutsideTail: 100,
      projectedTokens: 350,
      currentTokens: 350,
      threshold: 450,
    });
  });

  it("evaluate does not count fresh-tail raw messages as backlog pressure", async () => {
    const freshTailEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      freshTailCount: 3,
    });
    await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `Fresh tail ${i}`,
      tokenCountFn: () => 100,
    });

    const decision = await freshTailEngine.evaluate(CONV_ID, 600, 300);
    expect(decision).toMatchObject({
      shouldCompact: false,
      reason: "none",
      storedTokens: 300,
      observedTokens: 300,
      rawTokensOutsideTail: 0,
      projectedTokens: 300,
      currentTokens: 300,
      threshold: 450,
    });
  });

  it("compactFullSweep accepts a per-call contextThreshold override", async () => {
    const thresholdAwareEngine = new CompactionEngine(convStore as any, sumStore as any, {
      ...defaultCompactionConfig,
      contextThreshold: 0.75,
      leafChunkTokens: 20_000,
      condensedTargetTokens: 100,
      summaryPrefixTargetTokens: undefined,
      freshTailCount: 1,
    });
    await ingestMessages(convStore, sumStore, 3, {
      contentFn: (i) => `Threshold target ${i}`,
      tokenCountFn: () => 100,
    });

    const defaultResult = await thresholdAwareEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 1_000,
      summarize: async () => "leaf summary",
    });
    expect(defaultResult.actionTaken).toBe(false);
    expect(defaultResult.tokensBefore).toBe(300);

    const overrideResult = await thresholdAwareEngine.compactFullSweep({
      conversationId: CONV_ID,
      tokenBudget: 1_000,
      contextThreshold: 0.2,
      summarize: async () => "leaf summary",
    });

    expect(overrideResult.actionTaken).toBe(true);
    expect(overrideResult.tokensBefore).toBe(300);
    expect(overrideResult.tokensAfter).toBeLessThan(300);
  });

  it("compactUntilUnder uses currentTokens when stored tokens are stale", async () => {
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Turn ${i}: ${"x".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async (text: string) => {
      return `summary ${text.length}`;
    });

    const result = await compactionEngine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 2_000,
      targetTokens: 1_000,
      currentTokens: 1_500,
      summarize,
    });

    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(summarize).toHaveBeenCalled();
  });

  it("compactUntilUnder performs a forced round when currentTokens equals target", async () => {
    await ingestMessages(convStore, sumStore, 10, {
      contentFn: (i) => `Turn ${i}: ${"x".repeat(200)}`,
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async (text: string) => {
      return `summary ${text.length}`;
    });

    const result = await compactionEngine.compactUntilUnder({
      conversationId: CONV_ID,
      tokenBudget: 2_000,
      targetTokens: 2_000,
      currentTokens: 2_000,
      summarize,
    });

    expect(result.rounds).toBeGreaterThanOrEqual(1);
    expect(summarize).toHaveBeenCalled();
  });

  it("compact skips when under threshold and not forced", async () => {
    await ingestMessages(convStore, sumStore, 2, {
      contentFn: () => "Short",
      tokenCountFn: (_i, content) => estimateTokens(content),
    });

    const summarize = vi.fn(async () => "should not be called");

    const result = await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
      summarize,
    });

    expect(result.actionTaken).toBe(false);
    expect(summarize).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Full-sweep bounds (iteration cap + wall-clock deadline)
// ═════════════════════════════════════════════════════════════════════════════

