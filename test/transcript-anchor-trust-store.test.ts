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
    await expect(store.getMessageTranscriptAnchorTrust(legacyMessage.messageId)).resolves.toBeNull();

    await store.upsertMessageTranscriptAnchorTrust({
      messageId: legacyMessage.messageId,
      conversationId: conversation.conversationId,
      transcriptEntryId: "entry-suspect",
      trustState: "suspect",
      source: "audit",
      reason: "blank assistant content",
    });
    await expect(store.getMessageTranscriptAnchorTrust(legacyMessage.messageId)).resolves.toMatchObject({
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

    await expect(store.getMessageTranscriptAnchorTrust(legacyMessage.messageId)).resolves.toMatchObject({
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
