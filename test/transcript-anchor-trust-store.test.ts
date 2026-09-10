import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";

function createStoreFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    store: new ConversationStore(db, { fts5Available }),
  };
}

describe("ConversationStore transcript anchor trust", () => {
  it("persists explicit message trust separately from transcript_entry_id", async () => {
    const { store } = createStoreFixture();
    const conversation = await store.createConversation({
      sessionId: "session-trust",
      sessionKey: "agent:main:session-trust",
    });
    const [legacyMessage] = await store.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "",
        tokenCount: 0,
        transcriptEntryId: "entry-suspect",
      },
    ]);

    await expect(
      store.isTrustedTranscriptAnchor(conversation.conversationId, "entry-suspect"),
    ).resolves.toBe(false);
    await expect(
      store.getMessageTranscriptAnchorTrust(legacyMessage.messageId),
    ).resolves.toBeNull();

    await store.upsertMessageTranscriptAnchorTrust({
      messageId: legacyMessage.messageId,
      conversationId: conversation.conversationId,
      transcriptEntryId: "entry-suspect",
      trustState: "suspect",
      source: "audit",
      reason: "blank assistant content",
    });
    await expect(
      store.getMessageTranscriptAnchorTrust(legacyMessage.messageId),
    ).resolves.toMatchObject({
      messageId: legacyMessage.messageId,
      conversationId: conversation.conversationId,
      transcriptEntryId: "entry-suspect",
      trustState: "suspect",
      source: "audit",
      reason: "blank assistant content",
      verifiedAt: null,
    });
    await expect(
      store.isTrustedTranscriptAnchor(conversation.conversationId, "entry-suspect"),
    ).resolves.toBe(false);

    const verifiedAt = new Date("2026-07-08T12:00:00.000Z");
    await store.upsertMessageTranscriptAnchorTrust({
      messageId: legacyMessage.messageId,
      conversationId: conversation.conversationId,
      transcriptEntryId: "entry-suspect",
      trustState: "repaired",
      source: "audit",
      reason: "unique sequence alignment",
      verifiedAt,
    });

    await expect(
      store.getMessageTranscriptAnchorTrust(legacyMessage.messageId),
    ).resolves.toMatchObject({
      trustState: "repaired",
      reason: "unique sequence alignment",
      verifiedAt,
    });
    await expect(
      store.isTrustedTranscriptAnchor(conversation.conversationId, "entry-suspect"),
    ).resolves.toBe(true);
    await expect(
      store.listTranscriptAnchorAuditMessages(conversation.conversationId),
    ).resolves.toEqual([
      {
        messageId: legacyMessage.messageId,
        seq: 1,
        role: "assistant",
        content: "",
        transcriptEntryId: "entry-suspect",
        anchorTrustState: "repaired",
        createdAt: legacyMessage.createdAt.toISOString().slice(0, 19).replace("T", " "),
      },
    ]);
  });

  it("persists a conversation transcript epoch frontier idempotently", async () => {
    const { store } = createStoreFixture();
    const conversation = await store.createConversation({
      sessionId: "session-epoch",
      sessionKey: "agent:main:session-epoch",
    });

    await expect(
      store.getConversationTranscriptEpoch(conversation.conversationId),
    ).resolves.toBeNull();

    await store.upsertConversationTranscriptEpoch({
      conversationId: conversation.conversationId,
      sessionId: "session-epoch",
      sessionKey: "agent:main:session-epoch",
      frontierEntryId: "entry-frontier-a",
      frontierSeq: 12,
      frontierCreatedAt: new Date("2026-07-08T12:01:00.000Z"),
      migrationMode: "legacy_prefix",
      metadata: { classification: "unproven" },
    });

    await expect(
      store.getConversationTranscriptEpoch(conversation.conversationId),
    ).resolves.toMatchObject({
      conversationId: conversation.conversationId,
      sessionId: "session-epoch",
      sessionKey: "agent:main:session-epoch",
      frontierEntryId: "entry-frontier-a",
      frontierSeq: 12,
      frontierCreatedAt: new Date("2026-07-08T12:01:00.000Z"),
      migrationMode: "legacy_prefix",
      metadata: { classification: "unproven" },
    });

    await store.upsertConversationTranscriptEpoch({
      conversationId: conversation.conversationId,
      sessionId: "session-epoch",
      sessionKey: "agent:main:session-epoch",
      frontierEntryId: "entry-frontier-b",
      frontierSeq: 13,
      frontierCreatedAt: new Date("2026-07-08T12:02:00.000Z"),
      migrationMode: "verified",
      metadata: { classification: "verified" },
    });

    await expect(
      store.getConversationTranscriptEpoch(conversation.conversationId),
    ).resolves.toMatchObject({
      frontierEntryId: "entry-frontier-b",
      frontierSeq: 13,
      migrationMode: "verified",
      metadata: { classification: "verified" },
    });
  });
});

describe("weak anchor adoption", () => {
  it("never stamps blank parent messages or ambiguous repeated text", async () => {
    const { store, db } = createStoreFixture();
    const { conversationId } = await store.createConversation({ sessionId: "weak" });
    await store.createMessagesBulk(
      [1, 2].map((seq) => ({
        conversationId,
        seq,
        role: "assistant" as const,
        content: "",
        tokenCount: 1,
      })),
    );
    expect(await store.adoptTranscriptEntryId(conversationId, "assistant", "", "wrong")).toBe(
      false,
    );
    expect(
      await store.adoptRecentTranscriptEntryId(conversationId, "assistant", "", "wrong", 64),
    ).toBe(false);
    await store.createMessagesBulk(
      [3, 4].map((seq) => ({
        conversationId,
        seq,
        role: "user" as const,
        content: "repeated",
        tokenCount: 1,
      })),
    );
    expect(await store.adoptTranscriptEntryId(conversationId, "user", "repeated", "wrong")).toBe(
      false,
    );
    expect(
      await store.adoptRecentTranscriptEntryId(conversationId, "user", "repeated", "wrong", 64),
    ).toBe(false);
    expect(await store.getMessageCount(conversationId)).toBe(4);
    db.close();
  });
});

it("adopts the matching structured call, not the newest blank row", async () => {
  const { store, db } = createStoreFixture();
  const { BatchDeduplicator } = await import("../src/batch-dedup.js");
  const { buildMessageParts } = await import("../src/message-content.js");
  const { conversationId } = await store.createConversation({ sessionId: "structured" });
  const calls = ["wanted", "unrelated"].map(
    (id) =>
      ({
        role: "assistant",
        content: [{ type: "toolCall", id, name: "bash", arguments: { command: id } }],
      }) as import("../src/openclaw-bridge.js").AgentMessage,
  );
  const records = await store.createMessagesBulk(
    calls.map((_, seq) => ({
      conversationId,
      seq,
      role: "assistant" as const,
      content: "",
      tokenCount: 1,
    })),
  );
  for (let i = 0; i < calls.length; i++)
    await store.createMessageParts(
      records[i]!.messageId,
      buildMessageParts({ sessionId: "structured", message: calls[i]!, fallbackContent: "" }),
    );
  const dedup = new BatchDeduplicator(
    store,
    {} as import("../src/store/summary-store.js").SummaryStore,
    "/tmp",
    { log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } },
  );
  expect(
    await dedup.adoptRecentTranscriptEntryIdForMessage({
      conversationId,
      message: calls[0]!,
      transcriptEntryId: "correct",
      tailWindow: 64,
    }),
  ).toBe(true);
  expect(await store.getTranscriptEntryAnchorCandidate(conversationId, "correct")).toMatchObject({
    messageId: records[0]!.messageId,
  });
  expect(await store.getMessageCount(conversationId)).toBe(2);
  db.close();
});

it("does not substitute a structured row for a proven plain-text candidate", async () => {
  const { store, db } = createStoreFixture();
  const { conversationId } = await store.createConversation({ sessionId: "mixed-tail" });
  const records = await store.createMessagesBulk(
    [1, 2].map((seq) => ({
      conversationId,
      seq,
      role: "assistant" as const,
      content: "same text",
      tokenCount: 2,
    })),
  );
  await store.createMessageParts(records[1]!.messageId, [
    {
      sessionId: "mixed-tail",
      partType: "tool",
      ordinal: 0,
      toolCallId: "unrelated",
      textContent: "same text",
    },
  ]);
  expect(
    await store.adoptRecentTranscriptEntryId(
      conversationId,
      "assistant",
      "same text",
      "plain-anchor",
      64,
    ),
  ).toBe(true);
  expect(
    await store.getTranscriptEntryAnchorCandidate(conversationId, "plain-anchor"),
  ).toMatchObject({ messageId: records[0]!.messageId });
  db.close();
});
