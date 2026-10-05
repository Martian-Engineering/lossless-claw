import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { BatchDeduplicator } from "../src/batch-dedup.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { toStoredMessage, toStoredMessageIdentity } from "../src/message-content.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import * as tokenAccounting from "../src/token-accounting.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";

describe("reconciliation identity work", () => {
  it("preserves persisted identity without token-accounting structured payloads", () => {
    const messages = [
      { role: "user", content: "A user message" },
      { role: "assistant", content: [{ type: "thinking", thinking: "private reasoning" }, { type: "text", text: "answer" }] },
      { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "large payload ".repeat(1000) }] },
      { role: "bashExecution", command: "pwd", output: "/workspace" },
    ] as AgentMessage[];
    const expected = messages.map((message) => {
      const { role, content } = toStoredMessage(message);
      return { role, content };
    });
    const estimate = vi.spyOn(tokenAccounting, "estimateContentTokensForRole");
    try {
      expect(messages.map(toStoredMessageIdentity)).toEqual(expected);
      expect(estimate).not.toHaveBeenCalled();
    } finally {
      estimate.mockRestore();
    }
  });

  it.each([false, true])("does not retry already anchored rows (mixed tail: %s)", async (mixed) => {
    const db = new DatabaseSync(":memory:");
    try {
      const { fts5Available } = getLcmDbFeatures(db);
      runLcmMigrations(db, { fts5Available });
      const store = new ConversationStore(db, { fts5Available });
      const summaryStore = new SummaryStore(db, { fts5Available });
      const conversation = await store.createConversation({ sessionId: "identity-work" });
      const rows = await store.createMessagesBulk([
        { conversationId: conversation.conversationId, seq: 1, role: "user", content: "same body", tokenCount: 2, ...(mixed ? {} : { transcriptEntryId: "existing-1" }) },
        { conversationId: conversation.conversationId, seq: 2, role: "user", content: "same body", tokenCount: 2, transcriptEntryId: "existing-2" },
      ]);
      const adopt = vi.spyOn(store, "adoptTranscriptEntryIdForMessage");
      const hashes = vi.spyOn(store, "getRecentMessageIdentityHashes");
      const dedup = new BatchDeduplicator(store, summaryStore, "/unused", {
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const plan = await dedup.planRecentTranscriptEntryAdoptions({
        conversationId: conversation.conversationId,
        messages: [{ role: "user", content: "same body" } as AgentMessage],
        tailWindow: 2,
      });
      if (mixed) {
        expect(plan.get(0)).toEqual({ messageId: rows[0]!.messageId, decorated: false });
        await store.adoptTranscriptEntryIdForMessage(conversation.conversationId, plan.get(0)!.messageId, "new-entry");
        expect(adopt).toHaveBeenCalledExactlyOnceWith(conversation.conversationId, rows[0]!.messageId, "new-entry");
      } else {
        expect(plan.size).toBe(0);
        expect(adopt).not.toHaveBeenCalled();
        expect(hashes).not.toHaveBeenCalled();
      }
      expect((await store.getMessages(conversation.conversationId)).map((row) => row.transcriptEntryId)).toEqual(mixed ? ["new-entry", "existing-2"] : ["existing-1", "existing-2"]);
    } finally {
      db.close();
    }
  });

  it("screens unrelated historical rows before reading legacy tail parts", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const { fts5Available } = getLcmDbFeatures(db);
      runLcmMigrations(db, { fts5Available });
      const store = new ConversationStore(db, { fts5Available });
      const conversation = await store.createConversation({ sessionId: "large-projection" });
      const rows = await store.createMessagesBulk(
        Array.from({ length: 64 }, (_, index) => ({
          conversationId: conversation.conversationId,
          seq: index + 1,
          role: "assistant" as const,
          content: `legacy-tail-${index}`,
          tokenCount: 4,
        })),
      );
      const parts = vi.spyOn(store, "getMessageParts");
      const dedup = new BatchDeduplicator(store, {} as SummaryStore, "/unused", {
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const messages = [
        ...Array.from({ length: 1000 }, (_, index) => ({
          role: "assistant",
          content: `unrelated-history-${index}`,
        } as AgentMessage)),
        { role: "assistant", content: "legacy-tail-17" } as AgentMessage,
      ];
      const plan = await dedup.planRecentTranscriptEntryAdoptions({
        conversationId: conversation.conversationId,
        messages,
        tailWindow: 64,
      });

      expect(plan.get(1000)).toEqual({ messageId: rows[17]!.messageId, decorated: false });
      expect(plan.size).toBe(1);
      expect(parts).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });

  it("keeps an existing anchor's repeated-content claim ambiguous", async () => {
    const db = new DatabaseSync(":memory:");
    try {
      const { fts5Available } = getLcmDbFeatures(db);
      runLcmMigrations(db, { fts5Available });
      const store = new ConversationStore(db, { fts5Available });
      const conversation = await store.createConversation({ sessionId: "repeat-claim" });
      await store.createMessagesBulk([{
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "repeat",
        tokenCount: 2,
      }]);
      const dedup = new BatchDeduplicator(store, {} as SummaryStore, "/unused", {
        log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      });
      const resolved = attachTranscriptEntryMeta(
        { role: "assistant", content: "repeat" } as AgentMessage,
        { entryId: "already-anchored", parentId: null, timestamp: null },
      );
      const plan = await dedup.planRecentTranscriptEntryAdoptions({
        conversationId: conversation.conversationId,
        messages: [resolved, { role: "assistant", content: "repeat" } as AgentMessage],
        tailWindow: 64,
        existingEntryIds: new Set(["already-anchored"]),
      });
      expect(plan.size).toBe(0);
    } finally {
      db.close();
    }
  });
});
