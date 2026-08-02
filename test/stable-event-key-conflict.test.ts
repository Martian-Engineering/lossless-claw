/**
 * Store-level backstop: a stable-event-key unique index conflict must never
 * lose the row (P3 — prefer duplicate emission over dropped ingestion). The
 * colliding row is persisted with stable_event_key NULL and the conflict hook
 * fires so operators see the violated uniqueness invariant.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationStore } from "../src/store/conversation-store.js";
import {
  cleanupEngineTestState,
  createEngineWithDepsOverrides,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("ConversationStore stable-event-key conflict degradation", () => {
  it("persists the colliding row with a NULL stable key and notifies the conflict hook", async () => {
    const warn = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    const conversationStore: ConversationStore = engine.getConversationStore();
    const conversation = await conversationStore.getOrCreateConversation("stable-key-conflict");

    const first = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "tool",
      content: "first result",
      tokenCount: 1,
      stableEventKey: "tool-result:call_conflictTest001",
      skipReplayTimestampFloodGuard: true,
    });
    expect(first).toBeTruthy();

    // A second row with a different event body but the same stable key — the
    // "provider-unique" assumption was violated upstream. The row must
    // persist anyway.
    const second = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "tool",
      content: "second result",
      tokenCount: 1,
      stableEventKey: "tool-result:call_conflictTest001",
      skipReplayTimestampFloodGuard: true,
    });
    expect(second.messageId).not.toBe(first.messageId);

    const rows = await conversationStore.getMessages(conversation.conversationId);
    expect(rows.map((row) => row.content)).toEqual(["first result", "second result"]);
    expect(
      warn.mock.calls.some((call) => String(call[0]).includes("stable-event-key unique conflict")),
    ).toBe(true);
  });

  it("bulk insert path persists colliding rows too", async () => {
    const engine = createEngineWithDepsOverrides({
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const conversationStore = engine.getConversationStore();
    const conversation = await conversationStore.getOrCreateConversation("stable-key-conflict-bulk");

    const created = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "tool",
        content: "first bulk",
        tokenCount: 1,
        stableEventKey: "tool-result:call_bulkConflict001",
        skipReplayTimestampFloodGuard: true,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "tool",
        content: "second bulk",
        tokenCount: 1,
        stableEventKey: "tool-result:call_bulkConflict001",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    expect(created.length).toBe(2);
    const rows = await conversationStore.getMessages(conversation.conversationId);
    expect(rows.map((row) => row.content)).toEqual(["first bulk", "second bulk"]);
  });
});
