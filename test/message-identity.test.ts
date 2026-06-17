import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { buildMessageIdentityHash, normalizeIdentityContent } from "../src/store/message-identity.js";

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

describe("normalizeIdentityContent — Slack untrusted-metadata wrapper", () => {
  const raw =
    "Hello again, we were testing message duplication issue. is it still the case? are you getting my messages multiple times?";

  // The Slack runtime copy: metadata wrapped in a ```json fenced block, then the raw text.
  // (matches the on-disk bytes of lcm conv528 seq1)
  const fencedWrapper = [
    "Conversation info (untrusted metadata):",
    "```json",
    "{",
    '  "chat_id": "user:U02V2TNFK2R",',
    '  "message_id": "1781693435.927299",',
    '  "sender_id": "U02V2TNFK2R",',
    '  "sender": "gorkem.erdogan",',
    '  "timestamp": 1781693437307',
    "}",
    "```",
    "",
    raw,
  ].join("\n");

  it("collapses the fenced ```json wrapper so the runtime copy and the transcript-raw copy share one identity", () => {
    expect(normalizeIdentityContent(fencedWrapper)).toBe(raw);
    expect(buildMessageIdentityHash("user", fencedWrapper)).toBe(
      buildMessageIdentityHash("user", raw),
    );
  });

  it("still collapses the legacy bare-brace wrapper form (no regression of the timestamp-era handling)", () => {
    const bare = `Conversation info (untrusted metadata): { "chat_id": "x", "sender": "y" }\n\n${raw}`;
    expect(normalizeIdentityContent(bare)).toBe(raw);
  });

  it("still strips the leading [Wkdy YYYY-MM-DD HH:MM GMT+N] timestamp prefix", () => {
    const stamped = `[Sat 2026-06-13 23:14 GMT+3] ${raw}`;
    expect(normalizeIdentityContent(stamped)).toBe(raw);
    expect(buildMessageIdentityHash("user", stamped)).toBe(buildMessageIdentityHash("user", raw));
  });
});
