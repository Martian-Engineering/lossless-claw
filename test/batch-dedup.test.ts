import { describe, expect, it, vi } from "vitest";
import { BatchDeduplicator } from "../src/batch-dedup.js";
import type { ConversationStore, MessageRecord } from "../src/store/conversation-store.js";
import { buildMessageIdentityHash } from "../src/store/message-identity.js";
import type { SummaryStore } from "../src/store/summary-store.js";
import { makeMessage } from "./helpers.js";

function makeLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

type FakeConversationStore = {
  conversationId: number;
  messages: MessageRecord[];
};

function makeConversationStore(initial: FakeConversationStore): ConversationStore {
  return {
    getConversationForSession: vi.fn(async () => ({ conversationId: initial.conversationId })),
    getMessageCount: vi.fn(async () => initial.messages.length),
    getLastMessage: vi.fn(async () => initial.messages[initial.messages.length - 1]),
    getLastMessages: vi.fn(async (conversationId: number, limit: number) => {
      expect(conversationId).toBe(initial.conversationId);
      return initial.messages.slice(-limit);
    }),
    getMessages: vi.fn(
      async (conversationId: number, options?: { afterSeq?: number; limit?: number }) => {
        expect(conversationId).toBe(initial.conversationId);
        const afterSeq = options?.afterSeq ?? -1;
        const filtered = initial.messages.filter((m) => m.seq > afterSeq).sort((a, b) => a.seq - b.seq);
        if (options?.limit !== undefined) {
          return filtered.slice(0, options.limit);
        }
        return filtered;
      },
    ),
    getLastMessageIdentityHash: vi.fn(async () => {
      const last = initial.messages[initial.messages.length - 1];
      return last ? buildMessageIdentityHash(last.role, last.content) : null;
    }),
    getRecentMessageIdentityHashes: vi.fn(async (conversationId: number, limit: number) => {
      expect(conversationId).toBe(initial.conversationId);
      return initial.messages
        .slice(-limit)
        .map((m) => buildMessageIdentityHash(m.role, m.content));
    }),
    hasMessage: vi.fn(async (conversationId: number, role: string, content: string) => {
      expect(conversationId).toBe(initial.conversationId);
      const identityHash = buildMessageIdentityHash(role, content);
      return initial.messages.some(
        (message) =>
          message.role === role &&
          message.content === content &&
          buildMessageIdentityHash(message.role, message.content) === identityHash,
      );
    }),
    countMessagesByIdentityHash: vi.fn(
      async (_conversationId: number, role: string, identityHash: string) =>
        initial.messages.filter(
          (m) => buildMessageIdentityHash(m.role, m.content) === identityHash && m.role === role,
        ).length,
    ),
  } as unknown as ConversationStore;
}

function makeDedup(store: FakeConversationStore) {
  return new BatchDeduplicator(
    makeConversationStore(store),
    {} as unknown as SummaryStore,
    "/tmp/lcm-batch-dedup-test",
    { log: makeLog() },
  );
}

function storedMessage(role: string, content: string): MessageRecord {
  return {
    messageId: 0,
    conversationId: 1,
    seq: 0,
    role: role as MessageRecord["role"],
    content,
    tokenCount: 1,
    createdAt: new Date(),
    largeContent: null,
  };
}

describe("BatchDeduplicator.deduplicateAfterTurnBatch", () => {
  it("returns an empty batch unchanged", async () => {
    const dedup = makeDedup({ conversationId: 1, messages: [] });
    const result = await dedup.deduplicateAfterTurnBatch("s1", undefined, []);
    expect(result).toEqual([]);
  });

  it("returns the batch when no conversation is stored yet", async () => {
    const dedup = new BatchDeduplicator(
      {
        getConversationForSession: vi.fn(async () => null),
      } as unknown as ConversationStore,
      {} as unknown as SummaryStore,
      "/tmp/lcm-batch-dedup-test",
      { log: makeLog() },
    );
    const batch = [makeMessage({ role: "user", content: "hello" })];
    const result = await dedup.deduplicateAfterTurnBatch("s1", undefined, batch);
    expect(result).toEqual(batch);
  });

  it("returns the batch when the stored conversation is empty", async () => {
    const dedup = makeDedup({ conversationId: 1, messages: [] });
    const batch = [makeMessage({ role: "user", content: "hello" })];
    const result = await dedup.deduplicateAfterTurnBatch("s1", undefined, batch);
    expect(result).toEqual(batch);
  });

  it("trims the full stored transcript when the batch begins with it", async () => {
    const dedup = makeDedup({
      conversationId: 1,
      messages: [storedMessage("user", "a"), storedMessage("assistant", "b")],
    });
    const batch = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
      makeMessage({ role: "user", content: "c" }),
    ];
    const result = await dedup.deduplicateAfterTurnBatch("s1", undefined, batch);
    expect(result).toEqual([batch[2]]);
  });

  it("returns an empty batch when the entire batch is already stored", async () => {
    const dedup = makeDedup({
      conversationId: 1,
      messages: [storedMessage("user", "a"), storedMessage("assistant", "b")],
    });
    const batch = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
    ];
    const result = await dedup.deduplicateAfterTurnBatch("s1", undefined, batch);
    expect(result).toEqual([]);
  });

  it("keeps genuinely new messages after a tail-only replay", async () => {
    const dedup = makeDedup({
      conversationId: 1,
      messages: [
        storedMessage("user", "old-1"),
        storedMessage("assistant", "old-2"),
        storedMessage("user", "old-3"),
      ],
    });
    const batch = [
      makeMessage({ role: "user", content: "old-3" }),
      makeMessage({ role: "assistant", content: "new" }),
    ];
    const result = await dedup.deduplicateAfterTurnBatch("s1", undefined, batch);
    expect(result).toEqual([batch[1]]);
  });
});

describe("BatchDeduplicator.alignRuntimeBatchAgainstCoveredFrontier", () => {
  it("returns an empty batch when the runtime batch aligns fully with the covered frontier", async () => {
    const dedup = makeDedup({
      conversationId: 1,
      messages: [storedMessage("user", "a"), storedMessage("assistant", "b")],
    });
    const batch = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
    ];
    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s1", undefined, batch);
    expect(result).toEqual([]);
  });

  it("returns only the new suffix when a prefix aligns with the covered frontier", async () => {
    const dedup = makeDedup({
      conversationId: 1,
      messages: [storedMessage("user", "a"), storedMessage("assistant", "b")],
    });
    const batch = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "b" }),
      makeMessage({ role: "user", content: "c" }),
    ];
    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s1", undefined, batch);
    expect(result).toEqual([batch[2]]);
  });

  it("returns the full batch when there is no frontier overlap", async () => {
    const dedup = makeDedup({
      conversationId: 1,
      messages: [storedMessage("user", "old")],
    });
    const batch = [makeMessage({ role: "user", content: "new" })];
    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s1", undefined, batch);
    expect(result).toEqual(batch);
  });

  it("collapses a decorated runtime copy of the same user turn instead of persisting it twice", async () => {
    const bareContent = "please summarize";
    const decoratedContent = `[Sun 2026-01-01 12:00 GMT+0]\n${bareContent}`;
    const dedup = makeDedup({
      conversationId: 1,
      messages: [storedMessage("user", bareContent)],
    });
    const batch = [makeMessage({ role: "user", content: decoratedContent })];
    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s1", undefined, batch);
    expect(result).toEqual([]);
  });

  it("fails closed when persisted identity overlaps without frontier alignment", async () => {
    const dedup = makeDedup({
      conversationId: 1,
      messages: [storedMessage("user", "a"), storedMessage("assistant", "b")],
    });
    const batch = [
      makeMessage({ role: "user", content: "a" }),
      makeMessage({ role: "assistant", content: "new" }),
    ];
    const result = await dedup.alignRuntimeBatchAgainstCoveredFrontier("s1", undefined, batch);
    expect(result).toEqual([]);
  });
});
