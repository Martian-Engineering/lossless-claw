import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import {
  extractOpenClawSenderMetadata,
  parseOpenClawSenderMetadata,
  serializeOpenClawSenderMetadata,
} from "../src/openclaw-sender-metadata.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  cleanupEngineTestState,
  createEngine,
  createEngineWithDepsOverrides,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("OpenClaw sender metadata", () => {
  it("allowlists non-empty sender identity fields and tolerates legacy values", () => {
    const message = {
      role: "user",
      content: "hello",
      __openclaw: {
        senderId: "user-42",
        senderName: "Ada Lovelace",
        senderUsername: "ada",
        senderIsOwner: true,
        injected: "ignore me",
      },
    } as AgentMessage;

    const metadata = extractOpenClawSenderMetadata(message);
    expect(metadata).toEqual({
      senderId: "user-42",
      senderName: "Ada Lovelace",
      senderUsername: "ada",
    });
    expect(parseOpenClawSenderMetadata(serializeOpenClawSenderMetadata(metadata))).toEqual(
      metadata,
    );
    expect(extractOpenClawSenderMetadata({ ...message, role: "assistant" })).toBeNull();
    expect(parseOpenClawSenderMetadata(null)).toBeNull();
    expect(parseOpenClawSenderMetadata("not-json")).toBeNull();
    expect(parseOpenClawSenderMetadata('{"senderName":"   ","extra":"value"}')).toBeNull();
  });

  it("preserves sender identity through live ingest, SQLite records, and replay", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: {
        role: "user",
        content: "group message",
        __openclaw: {
          senderId: "user-42",
          senderName: "Ada Lovelace",
          senderUsername: "ada",
          senderIsOwner: true,
        },
      },
    });
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "legacy direct message" },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored[0]?.openClawSenderMetadata).toEqual({
      senderId: "user-42",
      senderName: "Ada Lovelace",
      senderUsername: "ada",
    });
    expect(stored[1]?.openClawSenderMetadata).toBeNull();

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    expect(assembled.messages[0]?.__openclaw).toEqual({
      senderId: "user-42",
      senderName: "Ada Lovelace",
      senderUsername: "ada",
    });
    expect(assembled.messages[1]).not.toHaveProperty("__openclaw");
  });

  it("preserves sender identity during SQLite transcript projection bootstrap", async () => {
    const sessionId = randomUUID();
    const sessionKey = `agent:main:${sessionId}`;
    const engine = createEngineWithDepsOverrides({
      readVisibleSessionTranscriptMessageEntries: vi.fn(async () => [
        {
          entryId: "entry-bootstrap-user",
          parentId: null,
          seq: 1,
          role: "user",
          message: {
            role: "user",
            content: "bootstrapped group message",
            __openclaw: {
              senderId: "bootstrap-user",
              senderName: "Grace Hopper",
              senderUsername: "grace",
              ignored: "not persisted",
            },
          },
          createdAt: "2026-08-10T12:00:00.000Z",
        },
      ]),
    });

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      runtimeContext: {
        transcriptStorage: { kind: "sqlite" },
        sessionTarget: {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: "/tmp/openclaw-agent.sqlite",
          threadId: "sender-bootstrap-thread",
        },
      },
    });
    expect(result.importedMessages).toBe(1);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored[0]?.openClawSenderMetadata).toEqual({
      senderId: "bootstrap-user",
      senderName: "Grace Hopper",
      senderUsername: "grace",
    });
  });

  it("preserves sender identity beside transcript projection provenance", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const projectedMessage = attachTranscriptEntryMeta(
      {
        role: "user",
        content: "projection-shaped group message",
        __openclaw: {
          senderId: "projected-user",
          senderName: "Katherine Johnson",
        },
      },
      {
        entryId: "entry-projected-user-1",
        parentId: null,
        timestamp: "2026-08-10T12:00:00.000Z",
      },
    );

    await engine.ingest({ sessionId, message: projectedMessage });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored[0]?.transcriptEntryId).toBe("entry-projected-user-1");
    expect(stored[0]?.openClawSenderMetadata).toEqual({
      senderId: "projected-user",
      senderName: "Katherine Johnson",
    });
  });

  it("does not overwrite sender identity while adopting transcript provenance", async () => {
    const engine = createEngine();
    const store = engine.getConversationStore();
    const conversation = await store.getOrCreateConversation(randomUUID());
    const message = await store.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "already attributed",
      tokenCount: 2,
      openClawSenderMetadata: { senderId: "runtime-user", senderName: "Runtime Sender" },
    });

    const adopted = await store.adoptTranscriptEntryId(
      conversation.conversationId,
      "user",
      "already attributed",
      "entry-adopted-1",
      { senderId: "transcript-user", senderName: "Transcript Sender" },
    );

    expect(adopted).toBe(true);
    expect(await store.getMessageById(message.messageId)).toMatchObject({
      transcriptEntryId: "entry-adopted-1",
      openClawSenderMetadata: {
        senderId: "runtime-user",
        senderName: "Runtime Sender",
      },
    });

    const staleMessage = await store.createMessage({
      conversationId: conversation.conversationId,
      seq: 2,
      role: "user",
      content: "stale attribution",
      tokenCount: 2,
      transcriptEntryId: "entry-stale-old",
    });
    const restamped = await store.restampTranscriptEntryId(
      staleMessage.messageId,
      "entry-stale-new",
      { senderId: "restamped-user", senderName: "Restamped Sender" },
    );
    expect(restamped).toBe(true);
    expect(await store.getMessageById(staleMessage.messageId)).toMatchObject({
      transcriptEntryId: "entry-stale-new",
      openClawSenderMetadata: {
        senderId: "restamped-user",
        senderName: "Restamped Sender",
      },
    });
  });

  it("counts losslessly preserved sender identity against the replay budget", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const largeSenderName = `speaker-${"x".repeat(8_000)}`;
    await engine.ingest({
      sessionId,
      message: {
        role: "user",
        content: "old group message",
        __openclaw: { senderId: "large-speaker", senderName: largeSenderName },
      },
    });
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "protected fresh message" },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored[0]?.openClawSenderMetadata?.senderName).toBe(largeSenderName);

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 100,
      freshTailCount: 1,
    });
    expect(assembled.messages).toEqual([
      expect.objectContaining({ role: "user", content: "protected fresh message" }),
    ]);
    expect(assembled.estimatedTokens).toBeLessThanOrEqual(100);
  });
});
