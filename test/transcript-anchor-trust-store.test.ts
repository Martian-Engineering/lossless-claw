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

/** Read one message's persisted anchor-trust row directly from SQLite. */
function readAnchorTrust(db: DatabaseSync, messageId: number) {
  return db
    .prepare(
      `SELECT conversation_id, transcript_entry_id, trust_state, source, reason, verified_at
       FROM message_transcript_anchor_trust
       WHERE message_id = ?`,
    )
    .get(messageId);
}

describe("ConversationStore transcript anchor trust", () => {
  it("persists explicit message trust separately from transcript_entry_id", async () => {
    const { db, store } = createStoreFixture();
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
    expect(readAnchorTrust(db, legacyMessage.messageId)).toBeUndefined();

    await store.upsertMessageTranscriptAnchorTrust({
      messageId: legacyMessage.messageId,
      conversationId: conversation.conversationId,
      transcriptEntryId: "entry-suspect",
      trustState: "suspect",
      source: "audit",
      reason: "blank assistant content",
    });
    expect(readAnchorTrust(db, legacyMessage.messageId)).toEqual({
      conversation_id: conversation.conversationId,
      transcript_entry_id: "entry-suspect",
      trust_state: "suspect",
      source: "audit",
      reason: "blank assistant content",
      verified_at: null,
    });
    await expect(
      store.isTrustedTranscriptAnchor(conversation.conversationId, "entry-suspect"),
    ).resolves.toBe(false);

    await store.upsertMessageTranscriptAnchorTrust({
      messageId: legacyMessage.messageId,
      conversationId: conversation.conversationId,
      transcriptEntryId: "entry-suspect",
      trustState: "repaired",
      source: "audit",
      reason: "unique sequence alignment",
      verifiedAt: new Date("2026-07-08T12:00:00.000Z"),
    });

    expect(readAnchorTrust(db, legacyMessage.messageId)).toMatchObject({
      trust_state: "repaired",
      reason: "unique sequence alignment",
    });
    await expect(
      store.isTrustedTranscriptAnchor(conversation.conversationId, "entry-suspect"),
    ).resolves.toBe(true);
    db.close();
  });
});
