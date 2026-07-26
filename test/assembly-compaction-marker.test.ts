/**
 * Tests for the compaction marker injected by `ContextAssembler.resolveSummaryItem`.
 *
 * The `resolveSummaryItem` method (private) is invoked by `assemble()` for each
 * context item of type `"summary"`. It returns an `AgentMessage` with an
 * `__openclaw: { kind: "compaction" }` marker.
 *
 * Strategy: mock `SummaryStore` and `ConversationStore`, then call `assemble()`
 * and inspect the returned messages.
 */

import { describe, it, expect, vi } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import type {
  SummaryStore,
  ContextItemRecord,
  SummaryRecord,
} from "../src/store/summary-store.js";
import type {
  ConversationStore,
  MessageRecord,
  MessagePartRecord,
} from "../src/store/conversation-store.js";

// ── types ────────────────────────────────────────────────────────────────────

type AgentMessage = {
  role: string;
  content: string;
  [key: string]: unknown;
};

type AssembleContextResult = {
  messages: AgentMessage[];
  estimatedTokens: number;
  stats: {
    rawMessageCount: number;
    summaryCount: number;
    totalContextItems: number;
  };
};

// ── mock factories ───────────────────────────────────────────────────────────

function makeSummaryRecord(overrides: Partial<SummaryRecord> = {}): SummaryRecord {
  return {
    summaryId: "sum-test",
    conversationId: 100,
    kind: "leaf",
    depth: 0,
    content: "Test summary content",
    tokenCount: 10,
    fileIds: [],
    earliestAt: new Date("2024-01-01T00:00:00Z"),
    latestAt: new Date("2024-01-01T01:00:00Z"),
    descendantCount: 0,
    descendantTokenCount: 0,
    sourceMessageTokenCount: 0,
    model: "test-model",
    createdAt: new Date("2024-01-01T02:00:00Z"),
    ...overrides,
  };
}

function makeSummaryContextItem(
  summaryId: string,
  ordinal: number = 0,
): ContextItemRecord {
  return {
    conversationId: 100,
    ordinal,
    itemType: "summary",
    messageId: null,
    summaryId,
    createdAt: new Date("2024-01-01T02:00:00Z"),
  };
}

function makeMessageContextItem(
  messageId: number,
  ordinal: number = 0,
): ContextItemRecord {
  return {
    conversationId: 100,
    ordinal,
    itemType: "message",
    messageId,
    summaryId: null,
    createdAt: new Date("2024-01-01T02:00:00Z"),
  };
}

function makeMessageRecord(
  messageId: number,
  overrides: Partial<MessageRecord> = {},
): MessageRecord {
  return {
    messageId,
    conversationId: 100,
    seq: messageId,
    role: "user",
    content: `Message ${messageId} content`,
    tokenCount: 5,
    createdAt: new Date("2024-01-01T02:00:00Z"),
    largeContent: null,
    ...overrides,
  };
}

function createMockSummaryStore(
  contextItems: ContextItemRecord[],
  summaries: Map<string, SummaryRecord> = new Map(),
): SummaryStore {
  return {
    getContextItems: vi.fn().mockResolvedValue(contextItems),
    getSummary: vi.fn().mockImplementation((summaryId: string) => {
      return Promise.resolve(summaries.get(summaryId) ?? makeSummaryRecord({ summaryId }));
    }),
    getSummaryParents: vi.fn().mockResolvedValue([]),
    getSummaryMessageSeqRange: vi.fn().mockResolvedValue({ maxSeq: null }),
    getLargeFile: vi.fn().mockResolvedValue(null),
  } as unknown as SummaryStore;
}

function createMockConversationStore(): ConversationStore {
  return {
    getMessageById: vi.fn().mockResolvedValue(null),
    getMessageParts: vi.fn().mockResolvedValue([]),
  } as unknown as ConversationStore;
}

// ── tests ────────────────────────────────────────────────────────────────────

describe("ContextAssembler compaction marker", () => {
  // TC-5: assemble() returns messages with __openclaw.kind = "compaction" for summary items
  it("TC-5: summary items include __openclaw: { kind: 'compaction' } marker", async () => {
    const summaryId = "sum-compaction-1";
    const summaryRecord = makeSummaryRecord({
      summaryId,
      content: "This is a compaction summary.",
    });

    const contextItems = [makeSummaryContextItem(summaryId, 0)];
    const summaries = new Map([[summaryId, summaryRecord]]);

    const summaryStore = createMockSummaryStore(contextItems, summaries);
    const conversationStore = createMockConversationStore();

    const assembler = new ContextAssembler(
      conversationStore,
      summaryStore,
      "UTC",
    );

    const result: AssembleContextResult = await assembler.assemble({
      conversationId: 100,
      tokenBudget: 100_000,
    });

    // There should be at least one message
    expect(result.messages.length).toBeGreaterThanOrEqual(1);

    // Find the message that came from the summary
    const compactionMessage = result.messages.find(
      (m: AgentMessage) => m.__openclaw !== undefined,
    );

    expect(compactionMessage).toBeDefined();
    expect(compactionMessage!.__openclaw).toEqual({ kind: "compaction" });
  });

  // TC-6: message-only items do not produce __openclaw markers
  it("TC-6: message items do not include __openclaw marker", async () => {
    const messageId = 42;
    const contextItems = [makeMessageContextItem(messageId, 0)];

    const summaryStore = createMockSummaryStore(contextItems);
    const conversationStore = createMockConversationStore();

    // Override getMessageById to return a real message
    (conversationStore.getMessageById as ReturnType<typeof vi.fn>).mockResolvedValue(
      makeMessageRecord(messageId),
    );

    const assembler = new ContextAssembler(
      conversationStore,
      summaryStore,
      "UTC",
    );

    const result: AssembleContextResult = await assembler.assemble({
      conversationId: 100,
      tokenBudget: 100_000,
    });

    // Messages should exist
    expect(result.messages.length).toBeGreaterThanOrEqual(1);

    // None of the messages should have __openclaw
    for (const msg of result.messages) {
      expect(msg.__openclaw).toBeUndefined();
    }
  });
});
