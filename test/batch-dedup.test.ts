import { describe, expect, it, vi } from "vitest";
import { BatchDeduplicator } from "../src/batch-dedup.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type {
  ConversationStore,
  MessagePartRecord,
  MessageRecord,
} from "../src/store/conversation-store.js";
import type { SummaryStore } from "../src/store/summary-store.js";
import { makeMessage } from "./helpers.js";

type FakeConversationStore = {
  messages: MessageRecord[];
  toolCallIdsByMessageId?: Record<number, string[]>;
};

function makeConversationStore(initial: FakeConversationStore): ConversationStore {
  return {
    getMessageById: vi.fn(
      async (messageId: number) =>
        initial.messages.find((message) => message.messageId === messageId) ?? null,
    ),
    getMessageParts: vi.fn(async (messageId: number) =>
      (initial.toolCallIdsByMessageId?.[messageId] ?? []).map(
        (toolCallId, ordinal): MessagePartRecord => ({
          partId: `${messageId}:${ordinal}`,
          messageId,
          sessionId: "s1",
          partType: "tool",
          ordinal,
          textContent: null,
          toolCallId,
          toolName: null,
          toolInput: null,
          toolOutput: null,
          metadata: null,
        }),
      ),
    ),
  } as unknown as ConversationStore;
}

type RedactSensitiveText = (content: string) => string;

function makeDedup(store: FakeConversationStore, redactSensitiveText?: RedactSensitiveText) {
  return new BatchDeduplicator(
    makeConversationStore(store),
    {} as unknown as SummaryStore,
    "/tmp/lcm-batch-dedup-test",
    redactSensitiveText,
  );
}

function redactTenantSecret(content: string): string {
  return content.replace(/tenant-secret-[a-z]+/g, "***");
}

function storedMessage(role: string, content: string, messageId: number): MessageRecord {
  return {
    messageId,
    conversationId: 1,
    seq: 0,
    role: role as MessageRecord["role"],
    content,
    tokenCount: 1,
    createdAt: new Date(),
    largeContent: null,
    transcriptEntryId: null,
    openClawSenderMetadata: null,
  };
}

function toolResultMessage(content: string, toolCallId: string): AgentMessage {
  return {
    ...makeMessage({ role: "toolResult", content }),
    toolCallId,
    toolName: "read",
  } as AgentMessage;
}

describe("BatchDeduplicator.matchesPersistedAnchor", () => {
  it("matches an exact persisted replay", async () => {
    const dedup = makeDedup({ messages: [storedMessage("assistant", "exact reply", 1)] });

    await expect(
      dedup.matchesPersistedAnchor(1, makeMessage({ role: "assistant", content: "exact reply" })),
    ).resolves.toBe(true);
  });

  it("rejects a missing row and different content", async () => {
    const dedup = makeDedup({ messages: [storedMessage("assistant", "exact reply", 1)] });

    await expect(
      dedup.matchesPersistedAnchor(2, makeMessage({ role: "assistant", content: "exact reply" })),
    ).resolves.toBe(false);
    await expect(
      dedup.matchesPersistedAnchor(1, makeMessage({ role: "assistant", content: "other reply" })),
    ).resolves.toBe(false);
  });

  it("matches the host-redacted face of a persisted tool row with the same call id", async () => {
    const dedup = makeDedup(
      {
        messages: [storedMessage("tool", "tool output tenant-secret-alpha", 1)],
        toolCallIdsByMessageId: { 1: ["call-secret"] },
      },
      redactTenantSecret,
    );

    await expect(
      dedup.matchesPersistedAnchor(1, toolResultMessage("tool output ***", "call-secret")),
    ).resolves.toBe(true);
  });

  it("matches a raw tool replay against its persisted host-redacted row", async () => {
    const dedup = makeDedup(
      {
        messages: [storedMessage("tool", "tool output ***", 1)],
        toolCallIdsByMessageId: { 1: ["call-secret"] },
      },
      redactTenantSecret,
    );

    await expect(
      dedup.matchesPersistedAnchor(
        1,
        toolResultMessage("tool output tenant-secret-alpha", "call-secret"),
      ),
    ).resolves.toBe(true);
  });

  it("does not equate different raw values that redact to the same text", async () => {
    const dedup = makeDedup(
      {
        messages: [storedMessage("tool", "tool output tenant-secret-alpha", 1)],
        toolCallIdsByMessageId: { 1: ["call-secret"] },
      },
      redactTenantSecret,
    );

    await expect(
      dedup.matchesPersistedAnchor(
        1,
        toolResultMessage("tool output tenant-secret-beta", "call-secret"),
      ),
    ).resolves.toBe(false);
  });

  it("does not accept a redaction match across different tool call ids", async () => {
    const dedup = makeDedup(
      {
        messages: [storedMessage("tool", "tool output ***", 1)],
        toolCallIdsByMessageId: { 1: ["call-alpha"] },
      },
      redactTenantSecret,
    );

    await expect(
      dedup.matchesPersistedAnchor(
        1,
        toolResultMessage("tool output tenant-secret-beta", "call-beta"),
      ),
    ).resolves.toBe(false);
  });

  it("does not match a blank-content tool call against an unrelated call", async () => {
    const dedup = makeDedup({
      messages: [storedMessage("assistant", "", 1)],
      toolCallIdsByMessageId: { 1: ["old-call"] },
    });
    const incoming = {
      role: "assistant",
      content: [{ type: "toolCall", id: "new-call", name: "bash", arguments: { command: "new" } }],
    } as AgentMessage;

    await expect(dedup.matchesPersistedAnchor(1, incoming)).resolves.toBe(false);
  });
});
