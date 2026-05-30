import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { buildMessageIdentityHash } from "../src/store/message-identity.js";

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

describe("ConversationStore message identity lookups", () => {
  it("finds an exact match even when many rows share the same identity hash", async () => {
    const { db, store } = createStoreFixture();

    try {
      const conversation = await store.createConversation({ sessionId: "identity-hash-match" });
      const targetHash = buildMessageIdentityHash("assistant", "needle");

      for (let index = 0; index < 8; index += 1) {
        await store.createMessage({
          conversationId: conversation.conversationId,
          seq: index,
          role: "assistant",
          content: `decoy-${index}`,
          tokenCount: 1,
        });
      }

      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 8,
        role: "assistant",
        content: "needle",
        tokenCount: 1,
      });

      db.prepare(`UPDATE messages SET identity_hash = ? WHERE conversation_id = ?`).run(
        targetHash,
        conversation.conversationId,
      );

      await expect(
        store.hasMessage(conversation.conversationId, "assistant", "needle"),
      ).resolves.toBe(true);
      await expect(
        store.countMessagesByIdentity(conversation.conversationId, "assistant", "needle"),
      ).resolves.toBe(1);
    } finally {
      db.close();
    }
  });
});
