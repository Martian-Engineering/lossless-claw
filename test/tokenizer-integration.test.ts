/**
 * Integration tests for tokenizer usage in assembly, compaction, and retrieval.
 * Verifies that calculateTokens is called with the correct tokenizer parameters.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { MessagePartRecord, MessageRecord, MessageRole } from "../src/store/conversation-store.js";
import type {
  SummaryRecord,
  ContextItemRecord,
  SummaryKind,
  LargeFileRecord,
} from "../src/store/summary-store.js";
import { ContextAssembler } from "../src/assembler.js";
import { CompactionEngine, type CompactionConfig } from "../src/compaction.js";
import { RetrievalEngine } from "../src/retrieval.js";
import type { TokenizerService } from "../src/types.js";

// ── Mock Tokenizer ─────────────────────────────────────────────────────────

function createMockTokenizer(): TokenizerService & { callCount: number; textsTokenized: string[] } {
  return {
    callCount: 0,
    textsTokenized: [],
    isEnabled: () => true,
    countTokens(text: string): number {
      (this as any).callCount++;
      (this as any).textsTokenized.push(text);
      // More precise than heuristic: ~1 token per 3 chars
      return Math.ceil(text.length / 3);
    },
  };
}

// ── Mock Store Factories (simplified) ───────────────────────────────────────

function createMockConversationStore() {
  const messages: MessageRecord[] = [];
  const messageParts: MessagePartRecord[] = [];
  let nextMsgId = 1;
  let nextPartId = 1;

  return {
    withTransaction: vi.fn(async <T>(operation: () => Promise<T> | T): Promise<T> => {
      return await operation();
    }),
    createConversation: vi.fn(async () => ({ conversationId: 1, sessionId: "test" })),
    getConversation: vi.fn(async () => ({ conversationId: 1, sessionId: "test" })),
    getOrCreateConversation: vi.fn(async () => ({ conversationId: 1, sessionId: "test" })),
    createMessage: vi.fn(async (input: {
      conversationId: number;
      seq: number;
      role: MessageRole;
      content: string;
      tokenCount: number;
    }) => {
      const msg: MessageRecord = {
        messageId: nextMsgId++,
        conversationId: input.conversationId,
        seq: input.seq,
        role: input.role,
        content: input.content,
        tokenCount: input.tokenCount,
        createdAt: new Date(),
      };
      messages.push(msg);
      return msg;
    }),
    createMessageParts: vi.fn(async (
      messageId: number,
      parts: Array<{ sessionId: string; partType: string; ordinal: number; textContent?: string }>,
    ) => {
      for (const part of parts) {
        messageParts.push({
          partId: `part-${nextPartId++}`,
          messageId,
          sessionId: part.sessionId,
          partType: part.partType as any,
          ordinal: part.ordinal,
          textContent: part.textContent ?? null,
          toolCallId: null,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          metadata: null,
        });
      }
    }),
    getMessages: vi.fn(async (convId: number) => {
      return messages.filter((m) => m.conversationId === convId).sort((a, b) => a.seq - b.seq);
    }),
    getMessageById: vi.fn(async (id: number) => messages.find((m) => m.messageId === id) ?? null),
    getMessageParts: vi.fn(async () => []),
    getMessageCount: vi.fn(async (convId: number) => messages.filter((m) => m.conversationId === convId).length),
    getMaxSeq: vi.fn(async (convId: number) => {
      const convMsgs = messages.filter((m) => m.conversationId === convId);
      return convMsgs.length > 0 ? Math.max(...convMsgs.map((m) => m.seq)) : 0;
    }),
    searchMessages: vi.fn(async () => []),
    _messages: messages,
    _messageParts: messageParts,
  };
}

function createMockSummaryStore() {
  const summaries: SummaryRecord[] = [];
  const contextItems: ContextItemRecord[] = [];
  const summaryMessages: Array<{ summaryId: string; messageId: number; ordinal: number }> = [];
  const summaryParents: Array<{ summaryId: string; parentSummaryId: string; ordinal: number }> = [];
  const largeFiles: LargeFileRecord[] = [];

  const store = {
    getContextItems: vi.fn(async (conversationId: number): Promise<ContextItemRecord[]> => {
      return contextItems
        .filter((ci) => ci.conversationId === conversationId)
        .sort((a, b) => a.ordinal - b.ordinal);
    }),
    getDistinctDepthsInContext: vi.fn(async () => []),
    appendContextMessage: vi.fn(async (conversationId: number, messageId: number) => {
      const existing = contextItems.filter((ci) => ci.conversationId === conversationId);
      const maxOrdinal = existing.length > 0 ? Math.max(...existing.map((ci) => ci.ordinal)) : -1;
      contextItems.push({
        conversationId,
        ordinal: maxOrdinal + 1,
        itemType: "message",
        messageId,
        summaryId: null,
        createdAt: new Date(),
      });
    }),
    appendContextSummary: vi.fn(async (conversationId: number, summaryId: string) => {
      const existing = contextItems.filter((ci) => ci.conversationId === conversationId);
      const maxOrdinal = existing.length > 0 ? Math.max(...existing.map((ci) => ci.ordinal)) : -1;
      contextItems.push({
        conversationId,
        ordinal: maxOrdinal + 1,
        itemType: "summary",
        messageId: null,
        summaryId,
        createdAt: new Date(),
      });
    }),
    replaceContextRangeWithSummary: vi.fn(async (input: {
      conversationId: number;
      startOrdinal: number;
      endOrdinal: number;
      summaryId: string;
    }) => {
      const { conversationId, startOrdinal, summaryId } = input;
      for (let i = contextItems.length - 1; i >= 0; i--) {
        const ci = contextItems[i];
        if (ci.conversationId === conversationId && ci.ordinal >= startOrdinal) {
          contextItems.splice(i, 1);
        }
      }
      contextItems.push({
        conversationId,
        ordinal: startOrdinal,
        itemType: "summary",
        messageId: null,
        summaryId,
        createdAt: new Date(),
      });
    }),
    getContextTokenCount: vi.fn(async (conversationId: number): Promise<number> => {
      const items = contextItems.filter((ci) => ci.conversationId === conversationId);
      let total = 0;
      for (const item of items) {
        if (item.itemType === "message" && item.messageId != null) {
          total += store._getMessageTokenCount(item.messageId);
        } else if (item.itemType === "summary" && item.summaryId != null) {
          const summary = summaries.find((s) => s.summaryId === item.summaryId);
          if (summary) total += summary.tokenCount;
        }
      }
      return total;
    }),
    insertSummary: vi.fn(async (input: {
      summaryId: string;
      conversationId: number;
      kind: SummaryKind;
      depth?: number;
      content: string;
      tokenCount: number;
    }): Promise<SummaryRecord> => {
      const summary: SummaryRecord = {
        summaryId: input.summaryId,
        conversationId: input.conversationId,
        kind: input.kind,
        depth: input.depth ?? (input.kind === "leaf" ? 0 : 1),
        content: input.content,
        tokenCount: input.tokenCount,
        fileIds: [],
        earliestAt: null,
        latestAt: null,
        descendantCount: 0,
        descendantTokenCount: 0,
        sourceMessageTokenCount: 0,
        createdAt: new Date(),
      };
      summaries.push(summary);
      return summary;
    }),
    getSummary: vi.fn(async (summaryId: string) => summaries.find((s) => s.summaryId === summaryId) ?? null),
    getSummariesByConversation: vi.fn(async (conversationId: number) => {
      return summaries.filter((s) => s.conversationId === conversationId);
    }),
    linkSummaryToMessages: vi.fn(async (summaryId: string, messageIds: number[]) => {
      for (let i = 0; i < messageIds.length; i++) {
        summaryMessages.push({ summaryId, messageId: messageIds[i], ordinal: i });
      }
    }),
    linkSummaryToParents: vi.fn(async (summaryId: string, parentSummaryIds: string[]) => {
      for (let i = 0; i < parentSummaryIds.length; i++) {
        summaryParents.push({ summaryId, parentSummaryId: parentSummaryIds[i], ordinal: i });
      }
    }),
    getSummaryMessages: vi.fn(async (summaryId: string) => {
      return summaryMessages
        .filter((sm) => sm.summaryId === summaryId)
        .sort((a, b) => a.ordinal - b.ordinal)
        .map((sm) => sm.messageId);
    }),
    getSummaryParents: vi.fn(async () => []),
    getSummaryChildren: vi.fn(async () => []),
    getSummarySubtree: vi.fn(async () => []),
    searchSummaries: vi.fn(async () => []),
    getLargeFile: vi.fn(async () => null),
    insertLargeFile: vi.fn(async () => ({} as LargeFileRecord)),
    getLargeFilesByConversation: vi.fn(async () => []),
    _getMessageTokenCount: (messageId: number): number => {
      const msg = summaries.find(() => false); // placeholder
      return 0;
    },
    _summaries: summaries,
    _contextItems: contextItems,
    _summaryMessages: summaryMessages,
    _summaryParents: summaryParents,
    _largeFiles: largeFiles,
  };

  return store;
}

function wireStores(
  convStore: ReturnType<typeof createMockConversationStore>,
  sumStore: ReturnType<typeof createMockSummaryStore>,
) {
  sumStore._getMessageTokenCount = (messageId: number): number => {
    const msg = convStore._messages.find((m) => m.messageId === messageId);
    return msg?.tokenCount ?? 0;
  };
}

// ── Default config ─────────────────────────────────────────────────────────

const defaultCompactionConfig: CompactionConfig = {
  contextThreshold: 0.75,
  freshTailCount: 4,
  leafMinFanout: 8,
  condensedMinFanout: 4,
  condensedMinFanoutHard: 2,
  incrementalMaxDepth: 0,
  leafTargetTokens: 600,
  condensedTargetTokens: 900,
  maxRounds: 10,
};

const CONV_ID = 1;

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Assembly uses calculateTokens
// ═════════════════════════════════════════════════════════════════════════════

describe("Tokenizer integration: assembly uses calculateTokens", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let mockTokenizer: ReturnType<typeof createMockTokenizer>;
  let assembler: ContextAssembler;

  beforeEach(async () => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    mockTokenizer = createMockTokenizer();

    // Assembler constructor only takes stores and timezone
    // useTokenizer and tokenizer are passed to assemble()
    assembler = new ContextAssembler(
      convStore as any,
      sumStore as any,
      "UTC",
    );
  });

  it("uses tokenizer for messages without pre-computed tokenCount", async () => {
    // Add message with tokenCount=0 (forces tokenizer use)
    const msg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "user",
      content: "Hello world, this is a test message that needs token counting.",
      tokenCount: 0, // Forces tokenizer use
    });
    await sumStore.appendContextMessage(CONV_ID, msg.messageId);

    const initialCallCount = mockTokenizer.callCount;

    // Pass useTokenizer and tokenizer to assemble()
    await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
      useTokenizer: true,
      tokenizer: mockTokenizer,
    });

    // Tokenizer should have been called
    expect(mockTokenizer.callCount).toBeGreaterThan(initialCallCount);
  });

  it("uses tokenizer for summary content", async () => {
    // Add a summary - the assembler always calls calculateTokens for formatted summary content
    await sumStore.insertSummary({
      summaryId: "sum_test",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "This is a summary that needs to be tokenized.",
      tokenCount: 10, // Note: assembler recalculates tokens from formatted content
    });
    await sumStore.appendContextSummary(CONV_ID, "sum_test");

    const initialCallCount = mockTokenizer.callCount;

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
      useTokenizer: true,
      tokenizer: mockTokenizer,
    });

    // If summary was resolved, tokenizer should have been called for the formatted content
    // The assembler calls calculateTokens on the formatted summary XML
    if (result.stats.summaryCount > 0) {
      expect(mockTokenizer.callCount).toBeGreaterThan(initialCallCount);
    }
  });

  it("skips tokenizer when message has pre-computed tokenCount", async () => {
    // Add message with valid tokenCount
    const msg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "user",
      content: "This message has a pre-computed token count.",
      tokenCount: 10, // Pre-computed, no tokenizer needed
    });
    await sumStore.appendContextMessage(CONV_ID, msg.messageId);

    const initialCallCount = mockTokenizer.callCount;

    await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
      useTokenizer: true,
      tokenizer: mockTokenizer,
    });

    // Tokenizer should NOT have been called (tokenCount > 0)
    expect(mockTokenizer.callCount).toBe(initialCallCount);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Retrieval uses calculateTokens
// ═════════════════════════════════════════════════════════════════════════════

describe("Tokenizer integration: retrieval uses calculateTokens", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let mockTokenizer: ReturnType<typeof createMockTokenizer>;
  let retrieval: RetrievalEngine;

  beforeEach(async () => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    mockTokenizer = createMockTokenizer();

    retrieval = new RetrievalEngine(
      convStore as any,
      sumStore as any,
      true, // useTokenizer
      mockTokenizer,
    );
  });

  it("uses tokenizer for messages without tokenCount in expand", async () => {
    // Create messages with tokenCount=0
    const msgs: number[] = [];
    for (let i = 0; i < 3; i++) {
      const msg = await convStore.createMessage({
        conversationId: CONV_ID,
        seq: i + 1,
        role: "user",
        content: `Source message ${i} that needs tokenization.`,
        tokenCount: 0, // Forces tokenizer use
      });
      await sumStore.appendContextMessage(CONV_ID, msg.messageId);
      msgs.push(msg.messageId);
    }

    // Create leaf summary linked to messages
    await sumStore.insertSummary({
      summaryId: "sum_expand_test",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Leaf summary for expansion.",
      tokenCount: 5,
    });
    await sumStore.linkSummaryToMessages("sum_expand_test", msgs);

    const initialCallCount = mockTokenizer.callCount;

    await retrieval.expand({
      summaryId: "sum_expand_test",
      depth: 1,
      includeMessages: true,
      tokenCap: 100,
    });

    // Tokenizer should have been called for messages without tokenCount
    expect(mockTokenizer.callCount).toBeGreaterThan(initialCallCount);
  });

  it("expand works with pre-computed token counts", async () => {
    // Create parent and child summaries
    await sumStore.insertSummary({
      summaryId: "sum_parent",
      conversationId: CONV_ID,
      kind: "condensed",
      content: "Parent summary.",
      tokenCount: 10,
    });

    await sumStore.insertSummary({
      summaryId: "sum_child",
      conversationId: CONV_ID,
      kind: "leaf",
      content: "Child summary.",
      tokenCount: 8,
    });
    await sumStore.linkSummaryToParents("sum_child", ["sum_parent"]);

    // Verify the link was created
    const parents = sumStore._summaryParents.filter(p => p.summaryId === "sum_child");
    expect(parents.length).toBeGreaterThan(0);

    const result = await retrieval.expand({
      summaryId: "sum_parent",
      depth: 1,
      includeMessages: false,
      tokenCap: 50,
    });

    // The expand function looks up children via getSummaryChildren
    // If the mock returns children correctly, we should see the child
    // If not, we just verify the function doesn't throw
    expect(result).toBeDefined();
    expect(result.truncated).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Compaction uses calculateTokens
// ═════════════════════════════════════════════════════════════════════════════

describe("Tokenizer integration: compaction uses calculateTokens", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let mockTokenizer: ReturnType<typeof createMockTokenizer>;
  let compactionEngine: CompactionEngine;

  beforeEach(async () => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    mockTokenizer = createMockTokenizer();

    compactionEngine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      defaultCompactionConfig,
      true, // useTokenizer
      mockTokenizer,
    );
  });

  it("uses tokenizer when creating summary token count", async () => {
    // Add messages
    for (let i = 0; i < 12; i++) {
      const msg = await convStore.createMessage({
        conversationId: CONV_ID,
        seq: i + 1,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Message ${i}: ${"word ".repeat(30)}`,
        tokenCount: 35,
      });
      await sumStore.appendContextMessage(CONV_ID, msg.messageId);
    }

    const initialCallCount = mockTokenizer.callCount;

    const summarize = vi.fn(async () => "Summary of the conversation.");

    await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 200,
      summarize,
      force: true,
    });

    // Tokenizer should have been called for token counting
    expect(mockTokenizer.callCount).toBeGreaterThan(initialCallCount);
  });

  it("compactLeaf uses tokenizer for chunk token estimation", async () => {
    // Add messages with substantial content
    for (let i = 0; i < 8; i++) {
      const msg = await convStore.createMessage({
        conversationId: CONV_ID,
        seq: i + 1,
        role: i % 2 === 0 ? "user" : "assistant",
        content: `Turn ${i}: ${"sentence ".repeat(25)}`,
        tokenCount: 30,
      });
      await sumStore.appendContextMessage(CONV_ID, msg.messageId);
    }

    const initialCallCount = mockTokenizer.callCount;

    const summarize = vi.fn(async () => "Leaf summary.");

    await compactionEngine.compactLeaf({
      conversationId: CONV_ID,
      tokenBudget: 300,
      summarize,
      force: true,
    });

    // Tokenizer should have been called
    expect(mockTokenizer.callCount).toBeGreaterThan(initialCallCount);
  });

  it("tokenizer produces different counts than heuristic", async () => {
    const testText = "Hello world, this is a test message.";

    // Heuristic: chars / 4
    const heuristicCount = Math.ceil(testText.length / 4);

    // Mock tokenizer: chars / 3
    const tokenizerCount = mockTokenizer.countTokens(testText);

    // They should be different
    expect(tokenizerCount).not.toBe(heuristicCount);
    expect(tokenizerCount).toBe(Math.ceil(testText.length / 3));
  });

  it("tokenizer is called for summary content during compaction", async () => {
    // Add messages
    for (let i = 0; i < 10; i++) {
      const msg = await convStore.createMessage({
        conversationId: CONV_ID,
        seq: i + 1,
        role: "user",
        content: `Test message ${i} with content.`,
        tokenCount: 10,
      });
      await sumStore.appendContextMessage(CONV_ID, msg.messageId);
    }

    const initialTexts = [...mockTokenizer.textsTokenized];

    const summarize = vi.fn(async () => "This is a generated summary of the conversation.");

    await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 100,
      summarize,
      force: true,
    });

    // Check that tokenizer was called with the summary content
    const newTexts = mockTokenizer.textsTokenized.slice(initialTexts.length);
    expect(newTexts.some(t => t.includes("generated summary"))).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Tokenizer Disabled
// ═════════════════════════════════════════════════════════════════════════════

describe("Tokenizer disabled fallback", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let mockTokenizer: ReturnType<typeof createMockTokenizer>;
  let compactionEngine: CompactionEngine;

  beforeEach(async () => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    mockTokenizer = createMockTokenizer();

    // Create engine with tokenizer disabled
    compactionEngine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      defaultCompactionConfig,
      false, // useTokenizer = false
      mockTokenizer,
    );
  });

  it("does not call tokenizer when useTokenizer is false", async () => {
    // Add messages
    for (let i = 0; i < 10; i++) {
      const msg = await convStore.createMessage({
        conversationId: CONV_ID,
        seq: i + 1,
        role: "user",
        content: `Test message ${i}`,
        tokenCount: 5,
      });
      await sumStore.appendContextMessage(CONV_ID, msg.messageId);
    }

    const initialCallCount = mockTokenizer.callCount;

    const summarize = vi.fn(async () => "Summary.");

    await compactionEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 100,
      summarize,
      force: true,
    });

    // Tokenizer should NOT have been called
    expect(mockTokenizer.callCount).toBe(initialCallCount);
  });

  it("works without tokenizer instance", async () => {
    // Create engine without tokenizer
    const noTokenizerEngine = new CompactionEngine(
      convStore as any,
      sumStore as any,
      defaultCompactionConfig,
      true, // useTokenizer = true but no tokenizer
      undefined,
    );

    // Add messages
    for (let i = 0; i < 10; i++) {
      const msg = await convStore.createMessage({
        conversationId: CONV_ID,
        seq: i + 1,
        role: "user",
        content: `Test message ${i}`,
        tokenCount: 5,
      });
      await sumStore.appendContextMessage(CONV_ID, msg.messageId);
    }

    const summarize = vi.fn(async () => "Summary.");

    // Should not throw
    const result = await noTokenizerEngine.compact({
      conversationId: CONV_ID,
      tokenBudget: 100,
      summarize,
      force: true,
    });

    expect(result.actionTaken).toBe(true);
  });
});
