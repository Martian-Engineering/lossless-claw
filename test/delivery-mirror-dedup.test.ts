// Regression test: delivery-mirror messages are deduplicated by content identity.
// OpenClaw writes two JSONL entries per assistant turn — the model response
// (with thinking + text) and a delivery-mirror (text only, model="delivery-mirror").
// Both share the same identity_hash because toStoredMessage strips thinking,
// but they have different transcript entry ids. This test verifies that
// ingestSingle skips the delivery-mirror when a matching response already exists,
// and that standalone delivery-mirrors (no prior response) are still ingested.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import { cleanupEngineTestState, createEngine } from "./helpers.js";

afterEach(cleanupEngineTestState);

function makeAssistantMessage(opts: {
  text: string;
  thinking?: string;
  model?: string;
  entryId?: string;
}): AgentMessage {
  const content: unknown[] = [];
  if (opts.thinking) {
    content.push({ type: "thinking", thinking: opts.thinking });
  }
  content.push({ type: "text", text: opts.text });

  const msg: AgentMessage = {
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...(opts.model ? { model: opts.model } : {}),
  } as AgentMessage;

  if (opts.entryId) {
    attachTranscriptEntryMeta(msg, {
      entryId: opts.entryId,
      parentId: null,
      timestamp: new Date().toISOString(),
    });
  }

  return msg;
}

function makeUserMessage(text: string): AgentMessage {
  return {
    role: "user",
    content: text,
    timestamp: Date.now(),
  } as AgentMessage;
}

describe("delivery-mirror dedup", () => {
  it("skips delivery-mirror when response with same content already exists", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const text = "Hello from the assistant";

    // Ingest the response entry (hex entry id, includes thinking)
    const response = makeAssistantMessage({
      text,
      thinking: "internal reasoning",
      entryId: "a1b2c3d4",
    });
    const r1 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: response,
    });
    expect(r1.ingested).toBe(true);

    // Ingest the delivery-mirror (UUID entry id, text only, model="delivery-mirror")
    const mirror = makeAssistantMessage({
      text,
      model: "delivery-mirror",
      entryId: randomUUID(),
    });
    const r2 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: mirror,
    });
    expect(r2.ingested).toBe(false);

    // Verify only one message in the DB
    const store = engine.getConversationStore();
    const conversation = await store.getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    if (conversation) {
      const count = await store.getMessageCount(conversation.conversationId);
      expect(count).toBe(1);
    }
  });

  it("ingests delivery-mirror when no prior matching response exists", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const text = "Standalone health alert";

    // Ingest only the delivery-mirror (no prior response)
    const mirror = makeAssistantMessage({
      text,
      model: "delivery-mirror",
      entryId: randomUUID(),
    });
    const r = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: mirror,
    });
    expect(r.ingested).toBe(true);

    const store = engine.getConversationStore();
    const conversation = await store.getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    if (conversation) {
      const count = await store.getMessageCount(conversation.conversationId);
      expect(count).toBe(1);
    }
  });

  it("skips delivery-mirror after string response with top-level reasoning", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const text = "Hello from a string response";

    const response = {
      role: "assistant",
      content: text,
      reasoning_content: "private top-level reasoning",
      timestamp: Date.now(),
    } as AgentMessage;
    attachTranscriptEntryMeta(response, {
      entryId: "b1c2d3e4",
      parentId: null,
      timestamp: new Date().toISOString(),
    });

    const r1 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: response,
    });
    expect(r1.ingested).toBe(true);

    const mirror = makeAssistantMessage({
      text,
      model: "delivery-mirror",
      entryId: randomUUID(),
    });
    const r2 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: mirror,
    });
    expect(r2.ingested).toBe(false);

    const store = engine.getConversationStore();
    const conversation = await store.getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    if (conversation) {
      const count = await store.getMessageCount(conversation.conversationId);
      expect(count).toBe(1);
    }
  });

  it("ingests repeated standalone delivery-mirrors with identical text", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const text = "Repeated health alert";

    // First standalone mirror — ingested
    const mirror1 = makeAssistantMessage({
      text,
      model: "delivery-mirror",
      entryId: randomUUID(),
    });
    const r1 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: mirror1,
    });
    expect(r1.ingested).toBe(true);

    const mirror2 = makeAssistantMessage({
      text,
      model: "delivery-mirror",
      entryId: randomUUID(),
    });
    const r2 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: mirror2,
    });
    expect(r2.ingested).toBe(true);

    const store = engine.getConversationStore();
    const conversation = await store.getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    if (conversation) {
      const count = await store.getMessageCount(conversation.conversationId);
      expect(count).toBe(2);
    }
  });

  it("does not skip repeated mirror text after an intervening turn", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const text = "OK";

    const response = makeAssistantMessage({
      text,
      thinking: "first reasoning",
      entryId: "aabbccdd",
    });
    await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: response,
    });

    const firstMirror = makeAssistantMessage({
      text,
      model: "delivery-mirror",
      entryId: randomUUID(),
    });
    const r1 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: firstMirror,
    });
    expect(r1.ingested).toBe(false);

    await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: makeUserMessage("Please answer again."),
    });

    const secondMirror = makeAssistantMessage({
      text,
      model: "delivery-mirror",
      entryId: randomUUID(),
    });
    const r2 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: secondMirror,
    });
    expect(r2.ingested).toBe(true);

    const store = engine.getConversationStore();
    const conversation = await store.getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    if (conversation) {
      const count = await store.getMessageCount(conversation.conversationId);
      expect(count).toBe(3);
    }
  });

  it("does not skip non-mirror assistant messages with identical content", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const text = "Repeated message";

    // First assistant message (no model="delivery-mirror")
    const msg1 = makeAssistantMessage({ text, entryId: "e1f2g3h4" });
    await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: msg1,
    });

    // Second assistant message with same content but different entry id,
    // NOT a delivery-mirror — should be ingested normally
    const msg2 = makeAssistantMessage({ text, entryId: "i5j6k7l8" });
    const r2 = await engine.ingest({
      sessionId,
      sessionKey: undefined,
      message: msg2,
    });
    expect(r2.ingested).toBe(true);

    const store = engine.getConversationStore();
    const conversation = await store.getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    if (conversation) {
      const count = await store.getMessageCount(conversation.conversationId);
      expect(count).toBe(2);
    }
  });
});
