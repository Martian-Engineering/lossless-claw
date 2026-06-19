import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { BatchDeduplicator } from "../src/batch-dedup.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { messageIdentity } from "../src/message-signatures.js";
import { extractOpenClawInboundBody } from "../src/openclaw-inbound-metadata.js";
import { ConversationStore } from "../src/store/conversation-store.js";

function createStoreFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return { db, store: new ConversationStore(db, { fts5Available }) };
}

// Deps stub for BatchDeduplicator — only log is needed and align only calls warn.
const noopDeps = {
  log: { debug() {}, info() {}, warn() {}, error() {} },
} as unknown as ConstructorParameters<typeof BatchDeduplicator>[1];

const BODY = "back to Telegram. How is it looking now?";

// The decorated, model-facing copy OpenClaw delivers live: a run of untrusted
// metadata blocks (Conversation info / Sender / Conversation context) followed
// by the raw body. The transcript copy is just the raw body.
function decorated(body: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      chat_id: "telegram:527476217",
      message_id: "1625",
      sender_id: "527476217",
      sender: "Gorkem",
      timestamp: "Thu 2026-06-18 14:24:56 GMT+3",
      inbound_event_kind: "user_request",
    }),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify({ label: "Gorkem (527476217)", id: "527476217", name: "Gorkem" }),
    "```",
    "",
    "Conversation context (untrusted, chronological, selected for current message):",
    "#1601 Wed 2026-06-17 23:50:44 GMT+3 Gorkem: an earlier message",
    "#1604 Wed 2026-06-17 23:51:21 GMT+3 Jennifer: an earlier reply",
    "",
    body,
  ].join("\n");
}

// The decorated form a DIFFERENT chat would deliver for the SAME body — used to
// pin down that the in-memory dedup identity is body-only (chat distinction is
// a concern of the persisted identity hash / #901, not this primitive).
function decoratedFromOtherChat(body: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({ chat_id: "telegram:999999999", sender: "Someone" }),
    "```",
    "",
    body,
  ].join("\n");
}

function userAuthoredMetadataLookingText(body = "please keep this whole note"): string {
  return [
    "Conversation info (untrusted metadata):",
    "```text",
    "this is quoted prompt text, not an OpenClaw JSON metadata block",
    "```",
    "",
    body,
  ].join("\n");
}

describe("messageIdentity OpenClaw inbound normalization (issue #912)", () => {
  it("gives a decorated user turn the same in-memory identity as its bare body", () => {
    expect(messageIdentity("user", decorated(BODY))).toBe(messageIdentity("user", BODY));
  });

  it("keeps distinct user bodies distinct", () => {
    expect(messageIdentity("user", decorated(BODY))).not.toBe(
      messageIdentity("user", "an entirely different request"),
    );
  });

  it("keeps user-authored metadata-looking text distinct from its trailing body", () => {
    const ordinaryText = userAuthoredMetadataLookingText();
    expect(messageIdentity("user", ordinaryText)).not.toBe(
      messageIdentity("user", "please keep this whole note"),
    );
  });

  it("keeps decorated user-authored metadata-looking body distinct from its trailing body", () => {
    const ordinaryText = userAuthoredMetadataLookingText();
    expect(messageIdentity("user", decorated(ordinaryText))).not.toBe(
      messageIdentity("user", "please keep this whole note"),
    );
    expect(messageIdentity("user", decorated(ordinaryText))).toBe(
      messageIdentity("user", ordinaryText),
    );
  });

  it("keeps user-authored leading whitespace distinct", () => {
    expect(messageIdentity("user", "  indented code")).not.toBe(
      messageIdentity("user", "indented code"),
    );
  });

  it("keeps timestamp-looking bare user text distinct from the unprefixed body", () => {
    expect(messageIdentity("user", "[Thu 2026-06-18 14:23 GMT+3] I've updated")).not.toBe(
      messageIdentity("user", "I've updated"),
    );
  });

  it("does not collapse decorated vs bare for non-user roles", () => {
    // The inbound normalization is user-only; assistant/tool content is never
    // decorated, so these forms must remain distinct identities.
    expect(messageIdentity("assistant", decorated(BODY))).not.toBe(
      messageIdentity("assistant", BODY),
    );
  });

  it("treats same-body decorations from different chats as the same in-memory identity", () => {
    // messageIdentity is the per-conversation alignment primitive; conversations
    // are never cross-compared here, so body-only collapse is correct. The
    // chat-aware persisted hash (buildMessageIdentityHash / #901) is unaffected.
    expect(messageIdentity("user", decorated(BODY))).toBe(
      messageIdentity("user", decoratedFromOtherChat(BODY)),
    );
  });
});

describe("alignRuntimeBatchAgainstCoveredFrontier bare-vs-decorated (issue #912)", () => {
  it("drops the decorated runtime copy when the bare body is the covered-frontier tail", async () => {
    const { db, store } = createStoreFixture();
    try {
      const conversation = await store.createConversation({ sessionId: "tg-align" });
      // Transcript reconcile flushed the BARE body as the covered-frontier tail.
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: BODY,
        tokenCount: 1,
      });
      const dedup = new BatchDeduplicator(store, noopDeps);
      // The runtime turn delta delivers the SAME message decorated (live copy).
      const aligned = await dedup.alignRuntimeBatchAgainstCoveredFrontier("tg-align", undefined, [
        { role: "user", content: decorated(BODY) } as any,
      ]);
      // Recognized as already-flushed → nothing left to ingest → no duplicate row.
      expect(aligned).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("keeps a genuinely new turn whose body differs from the covered-frontier tail", async () => {
    const { db, store } = createStoreFixture();
    try {
      const conversation = await store.createConversation({ sessionId: "tg-align-new" });
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: BODY,
        tokenCount: 1,
      });
      const dedup = new BatchDeduplicator(store, noopDeps);
      const aligned = await dedup.alignRuntimeBatchAgainstCoveredFrontier("tg-align-new", undefined, [
        { role: "user", content: decorated("a brand new unrelated question") } as any,
      ]);
      expect(aligned).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("keeps a new user-authored metadata-looking turn instead of aligning it to the body", async () => {
    const { db, store } = createStoreFixture();
    try {
      const conversation = await store.createConversation({ sessionId: "tg-align-ordinary" });
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "please keep this whole note",
        tokenCount: 1,
      });
      const dedup = new BatchDeduplicator(store, noopDeps);
      const aligned = await dedup.alignRuntimeBatchAgainstCoveredFrontier(
        "tg-align-ordinary",
        undefined,
        [{ role: "user", content: userAuthoredMetadataLookingText() } as any],
      );
      expect(aligned).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it("keeps a decorated user-authored metadata-looking body instead of aligning it to the suffix", async () => {
    const { db, store } = createStoreFixture();
    try {
      const conversation = await store.createConversation({ sessionId: "tg-align-decorated-body" });
      await store.createMessage({
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "please keep this whole note",
        tokenCount: 1,
      });
      const dedup = new BatchDeduplicator(store, noopDeps);
      const aligned = await dedup.alignRuntimeBatchAgainstCoveredFrontier(
        "tg-align-decorated-body",
        undefined,
        [{ role: "user", content: decorated(userAuthoredMetadataLookingText()) } as any],
      );
      expect(aligned).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("extractOpenClawInboundBody", () => {
  it("reduces a decorated telegram message (incl. Conversation context) to its body", () => {
    expect(extractOpenClawInboundBody("user", decorated(BODY))).toBe(BODY);
  });

  it("strips a leading channel timestamp only when validated OpenClaw metadata follows", () => {
    const withTimestamp = `[Thu 2026-06-18 14:23 GMT+3] ${decorated("I've updated the plugins")}`;
    expect(
      extractOpenClawInboundBody("user", withTimestamp),
    ).toBe("I've updated the plugins");
  });

  it("strips Conversation info + Sender blocks (slack flavor)", () => {
    const slack = [
      "Conversation info (untrusted metadata):",
      "```json",
      JSON.stringify({ chat_id: "user:U1", sender: "g" }),
      "```",
      "",
      "Sender (untrusted metadata):",
      "```json",
      JSON.stringify({ id: "U1", name: "g" }),
      "```",
      "",
      "now we are on Slack",
    ].join("\n");
    expect(extractOpenClawInboundBody("user", slack)).toBe("now we are on Slack");
  });

  it("leaves a bare body unchanged", () => {
    expect(extractOpenClawInboundBody("user", "just a plain message")).toBe("just a plain message");
  });

  it("leaves timestamp-looking bare user text unchanged", () => {
    const body = "[Thu 2026-06-18 14:23 GMT+3] I've updated the plugins";
    expect(extractOpenClawInboundBody("user", body)).toBe(body);
  });

  it("leaves user-authored metadata-looking bare text unchanged", () => {
    const body = userAuthoredMetadataLookingText();
    expect(extractOpenClawInboundBody("user", body)).toBe(body);
  });

  it("preserves user-authored metadata-looking body after real OpenClaw metadata", () => {
    const body = userAuthoredMetadataLookingText();
    expect(extractOpenClawInboundBody("user", decorated(body))).toBe(body);
  });

  it("does not strip metadata-looking blocks from non-user roles", () => {
    expect(extractOpenClawInboundBody("assistant", decorated(BODY))).toBe(decorated(BODY));
  });
});
