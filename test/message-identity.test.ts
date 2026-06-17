import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { canonicalizeOpenClawInboundMetadataIdentityContent } from "../src/openclaw-inbound-metadata.js";
import {
  buildMessageIdentityHash,
  buildMessageIdentityKey,
} from "../src/store/message-identity.js";

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
  it("canonicalizes OpenClaw inbound metadata only for user identity", () => {
    const first = openClawInboundMetadataContent({
      messageId: "telegram-1",
      senderName: "Syu",
      text: "please keep this context",
    });
    const second = openClawInboundMetadataContent({
      messageId: "telegram-2",
      senderName: "Syu",
      text: "please keep this context",
    });

    expect(buildMessageIdentityHash("user", first)).toBe(
      buildMessageIdentityHash("user", second),
    );
    const canonicalFirst = canonicalizeOpenClawInboundMetadataIdentityContent("user", first);
    expect(buildMessageIdentityKey("user", first)).toBe(`user\u0000${canonicalFirst}`);
    expect(canonicalFirst).toContain('"chat_id":"telegram:chat-1"');
    expect(canonicalFirst).toContain('"name":"Syu"');
    expect(canonicalFirst).toContain("please keep this context");
    expect(canonicalFirst).not.toContain("telegram-1");
    expect(buildMessageIdentityHash("assistant", first)).not.toBe(
      buildMessageIdentityHash("assistant", second),
    );
  });

  it("canonicalizes OpenClaw inbound metadata after a delivery prelude", () => {
    const first = openClawInboundMetadataContent({
      messageId: "telegram-1",
      senderName: "Syu",
      text: "please keep this context",
      deliveryPrelude: "Delivery:\nRoute this inbound message through the Telegram channel.",
    });
    const second = openClawInboundMetadataContent({
      messageId: "telegram-2",
      senderName: "Syu",
      text: "please keep this context",
      deliveryPrelude: "Delivery:\nRoute this inbound message through the Telegram channel.",
    });

    expect(buildMessageIdentityHash("user", first)).toBe(
      buildMessageIdentityHash("user", second),
    );
    const canonical = canonicalizeOpenClawInboundMetadataIdentityContent("user", first);
    expect(canonical).toContain("Delivery:\nRoute this inbound message through the Telegram channel.");
    expect(canonical).not.toContain("telegram-1");
  });

  it("does not strip ordinary user-authored text that resembles an inbound metadata heading", () => {
    const ordinaryText = [
      "Conversation info (untrusted metadata):",
      "```text",
      "this is not an OpenClaw JSON metadata block",
      "```",
      "",
      "please keep this whole note",
    ].join("\n");

    expect(
      canonicalizeOpenClawInboundMetadataIdentityContent("user", ordinaryText),
    ).toBe(ordinaryText);
  });

  it("does not strip valid JSON blocks without OpenClaw metadata keys", () => {
    const ordinaryText = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ example: true }),
      "```",
      "",
      "please keep this whole note",
    ].join("\n");

    expect(
      canonicalizeOpenClawInboundMetadataIdentityContent("user", ordinaryText),
    ).toBe(ordinaryText);
    expect(buildMessageIdentityKey("user", ordinaryText)).toBe(
      `user\u0000${ordinaryText}`,
    );
  });

  it("does not strip non-object JSON blocks", () => {
    const contents = [
      [
        "Conversation info (untrusted metadata):",
        "```json",
        JSON.stringify(["message_id", "telegram-1"]),
        "```",
        "",
        "please keep this whole note",
      ].join("\n"),
      [
        "Sender (untrusted metadata):",
        "```json",
        JSON.stringify("Syu"),
        "```",
        "",
        "please keep this whole note",
      ].join("\n"),
    ];

    for (const content of contents) {
      expect(
        canonicalizeOpenClawInboundMetadataIdentityContent("user", content),
      ).toBe(content);
    }
  });

  it("does not strip metadata-only content without real user text", () => {
    const metadataOnly = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: "telegram:chat-1",
        message_id: "telegram-1",
        timestamp: "2026-06-16T00:00:00.000Z",
      }),
      "```",
      "",
    ].join("\n");

    expect(
      canonicalizeOpenClawInboundMetadataIdentityContent("user", metadataOnly),
    ).toBe(metadataOnly);
  });

  it("does not strip user-authored metadata-looking blocks after the injected preamble", () => {
    const userAuthoredBlock = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: "quoted-chat",
        message_id: "quoted-message",
      }),
      "```",
      "",
      "please analyze why this exact block appears in the prompt",
    ].join("\n");
    const content = openClawInboundMetadataContent({
      messageId: "telegram-1",
      senderName: "Syu",
      text: userAuthoredBlock,
    });

    const canonical = canonicalizeOpenClawInboundMetadataIdentityContent("user", content);
    expect(canonical).toContain(userAuthoredBlock);
    expect(canonical).not.toBe("please analyze why this exact block appears in the prompt");
  });

  it("keeps stable OpenClaw metadata in identity to avoid global text-prefix collapse", () => {
    const first = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: "quoted-chat-a",
        message_id: "quoted-message-1",
      }),
      "```",
      "",
      "please analyze why this exact block appears in the prompt",
    ].join("\n");
    const second = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: "quoted-chat-b",
        message_id: "quoted-message-2",
      }),
      "```",
      "",
      "please analyze why this exact block appears in the prompt",
    ].join("\n");

    expect(buildMessageIdentityHash("user", first)).not.toBe(
      buildMessageIdentityHash("user", second),
    );
  });

  it("preserves leading whitespace on the user payload after the metadata preamble", () => {
    const indented = openClawInboundMetadataContent({
      messageId: "telegram-1",
      senderName: "Syu",
      text: "  indented code",
    });
    const unindented = openClawInboundMetadataContent({
      messageId: "telegram-2",
      senderName: "Syu",
      text: "indented code",
    });

    expect(canonicalizeOpenClawInboundMetadataIdentityContent("user", indented)).toContain(
      "\n\n  indented code",
    );
    expect(buildMessageIdentityHash("user", indented)).not.toBe(
      buildMessageIdentityHash("user", unindented),
    );
  });

  it("canonicalizes nested metadata object key order", () => {
    const first = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        chat_id: "telegram:chat-1",
        message_id: "telegram-1",
        sender: { username: "syu", id: "sender-1" },
      }),
      "```",
      "",
      "please keep this context",
    ].join("\n");
    const second = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({
        message_id: "telegram-2",
        sender: { id: "sender-1", username: "syu" },
        chat_id: "telegram:chat-1",
      }),
      "```",
      "",
      "please keep this context",
    ].join("\n");

    expect(buildMessageIdentityHash("user", first)).toBe(
      buildMessageIdentityHash("user", second),
    );
  });

  it("stores the raw OpenClaw metadata-prefixed content while hashing canonical identity", async () => {
    const { db, store } = createStoreFixture();
    const rawContent = openClawInboundMetadataContent({
      messageId: "telegram-raw",
      senderName: "Syu",
      text: "please keep this context",
    });
    const sameCanonicalContent = openClawInboundMetadataContent({
      messageId: "telegram-other",
      senderName: "Syu",
      text: "please keep this context",
    });

    try {
      const conversation = await store.createConversation({ sessionId: "identity-raw-content" });
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: rawContent,
        tokenCount: 1,
      });

      const stored = await store.getMessages(conversation.conversationId);
      expect(stored[0]?.content).toBe(rawContent);
      await expect(
        store.countMessagesByIdentityHash(
          conversation.conversationId,
          "user",
          buildMessageIdentityHash("user", sameCanonicalContent),
        ),
      ).resolves.toBe(1);
    } finally {
      db.close();
    }
  });

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

function openClawInboundMetadataContent(params: {
  messageId: string;
  senderName: string;
  text: string;
  deliveryPrelude?: string;
}): string {
  return [
    ...(params.deliveryPrelude ? [params.deliveryPrelude, ""] : []),
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      chat_id: "telegram:chat-1",
      message_id: params.messageId,
      timestamp: "2026-06-16T00:00:00.000Z",
    }),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify({ name: params.senderName }),
    "```",
    "",
    params.text,
  ].join("\n");
}
