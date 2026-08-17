import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupEngineTestState,
  createEngineWithDepsOverrides,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("stable event key conflict fallback", () => {
  it("preserves recurrent model-authored tool results across ingests", async () => {
    const engine = createEngineWithDepsOverrides({
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const sessionId = "recurrent-model-tool-id";
    const toolResult = {
      role: "toolResult" as const,
      toolCallId: "exec:101",
      content: "(no output)",
    };

    await engine.ingest({ sessionId, message: toolResult });
    await engine.ingest({ sessionId, message: toolResult });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const rows = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(rows.map((row) => row.content)).toEqual(["(no output)", "(no output)"]);
  });

  it("persists a colliding row without its stable key", async () => {
    const warn = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: { debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() },
    });
    const store = engine.getConversationStore();
    const conversation = await store.getOrCreateConversation("stable-key-conflict");
    const sharedInput = {
      conversationId: conversation.conversationId,
      role: "tool" as const,
      tokenCount: 1,
      stableEventKey: "tool-result:call_123456789012",
      skipReplayTimestampFloodGuard: true,
    };

    await store.createMessage({ ...sharedInput, seq: 0, content: "first result" });
    await store.createMessage({ ...sharedInput, seq: 1, content: "second result" });

    const rows = await store.getMessages(conversation.conversationId);
    expect(rows.map((row) => row.content)).toEqual(["first result", "second result"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("stable-event-key conflict"));
  });

  it("preserves colliding rows in bulk inserts", async () => {
    const engine = createEngineWithDepsOverrides({
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    });
    const store = engine.getConversationStore();
    const conversation = await store.getOrCreateConversation("stable-key-conflict-bulk");
    const sharedInput = {
      conversationId: conversation.conversationId,
      role: "tool" as const,
      tokenCount: 1,
      stableEventKey: "tool-result:call_abcdefghijkl",
      skipReplayTimestampFloodGuard: true,
    };

    const rows = await store.createMessagesBulk([
      { ...sharedInput, seq: 0, content: "first bulk result" },
      { ...sharedInput, seq: 1, content: "second bulk result" },
    ]);

    expect(rows.map((row) => row.content)).toEqual([
      "first bulk result",
      "second bulk result",
    ]);
  });
});
