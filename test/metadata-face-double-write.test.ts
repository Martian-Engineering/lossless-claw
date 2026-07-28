// Metadata-face store double-write across the afterTurn dedup routes.
//
// OpenClaw delivers the same inbound turn in two faces: the transcript
// persists the BARE body (with a transcript_entry_id), while the runtime
// AgentMessage carries the DECORATED face ("Conversation info (untrusted
// metadata)" block + body). Their identity_hashes differ, so identity dedup
// cannot see the pair; the metadata-body match must collapse it. Anchoring
// strength comes from the persisted row's transcript provenance: a user can
// forge a metadata block, but not a row written by the host's own transcript
// flush. Without provenance the pair deliberately duplicates (duplicates over
// deletion); with it, exactly one row survives and it is always the bare one.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LcmContextEngine } from "../src/engine.js";
import {
  cleanupEngineTestState,
  createEngineWithDeps,
  createSessionFilePath,
  makeMessage,
  writeLeafTranscript,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const BARE = "quick status ping, did the overnight jobs finish?";
const DIFFERENT = "actually hold the deploy until tomorrow";

function decorated(body: string): string {
  return (
    'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "user:U0EXAMPLE01",\n  "sender": "sam.rivera",\n  "message_id": "1700000000.000100"\n}\n```\n\n' +
    body
  );
}

function quietEngine(): LcmContextEngine {
  return createEngineWithDeps(
    {},
    { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  );
}

describe("metadata-face covered-path double-write", () => {
  it("collapses the decorated runtime twin onto the transcript-proven bare row (covered route)", async () => {
    const engine = quietEngine();
    const sessionId = "metadata-face-covered-double-write";
    const sessionKey = "agent:main:metadata-face-covered-double-write";
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    // The bare face as a prior covered reconcile persisted it: transcript
    // provenance recorded on the row (the marker the collapse anchors on).
    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: BARE,
        tokenCount: 12,
        transcriptEntryId: "probe-entry-0003",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const sessionFile = createSessionFilePath("metadata-face-covered-double-write");
    writeLeafTranscript(sessionFile, [{ role: "user", content: BARE }]);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
      lastProcessedEntryHash: null,
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: decorated(BARE) }),
        makeMessage({ role: "assistant", content: "all overnight jobs finished green" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    const userRows = stored.filter((m) => m.role === "user" && m.content.includes(BARE));
    expect(userRows).toHaveLength(1);
    // The survivor is the BARE transcript face, never the decorated copy.
    expect(userRows[0]!.content).toBe(BARE);
    expect(
      stored.some((m) => m.role === "assistant" && m.content.includes("finished green")),
    ).toBe(true);
  });

  it("collapses the decorated twin on the degraded route when the persisted row is transcript-proven", async () => {
    const engine = quietEngine();
    const sessionId = "metadata-face-degraded-double-write";
    const sessionKey = "agent:main:metadata-face-degraded-double-write";
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: BARE,
        tokenCount: 12,
        transcriptEntryId: "probe-entry-0001",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    // Transcript unavailable, checkpoint preserved: the degraded dedup path.
    const missingSessionFile = createSessionFilePath("metadata-face-degraded-double-write");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastSeenMtimeMs: 1_700_000_000_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: missingSessionFile,
      messages: [makeMessage({ role: "user", content: decorated(BARE) })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(BARE));
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.content).toBe(BARE);
  });

  it("collapses the decorated twin on the oversized-suffix route when the persisted row is transcript-proven", async () => {
    const engine = quietEngine();
    const sessionId = "metadata-face-oversized-double-write";
    const sessionKey = "agent:main:metadata-face-oversized-double-write";
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "previous reply",
        tokenCount: 2,
        skipReplayTimestampFloodGuard: true,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: BARE,
        tokenCount: 12,
        transcriptEntryId: "probe-entry-0002",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const missingSessionFile = createSessionFilePath("metadata-face-oversized-double-write");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastSeenMtimeMs: 1_700_000_000_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: missingSessionFile,
      messages: [
        makeMessage({ role: "user", content: decorated(BARE) }),
        makeMessage({ role: "assistant", content: "fresh reply after the ping" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    const userRows = stored.filter((m) => m.role === "user" && m.content.includes(BARE));
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.content).toBe(BARE);
    expect(
      stored.some((m) => m.role === "assistant" && m.content.includes("fresh reply")),
    ).toBe(true);
  });

  it("never collapses a decorated frame concealing a DIFFERENT body (fail-closed)", async () => {
    const engine = quietEngine();
    const sessionId = "metadata-face-forged-frame";
    const sessionKey = "agent:main:metadata-face-forged-frame";
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: BARE,
        tokenCount: 12,
        transcriptEntryId: "probe-entry-0004",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const sessionFile = createSessionFilePath("metadata-face-forged-frame");
    writeLeafTranscript(sessionFile, [{ role: "user", content: BARE }]);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
      lastProcessedEntryHash: null,
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: decorated(DIFFERENT) })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    expect(stored.filter((m) => m.role === "user" && m.content === BARE)).toHaveLength(1);
    expect(
      stored.filter((m) => m.role === "user" && m.content.includes(DIFFERENT)),
    ).toHaveLength(1);
  });

  it("keeps the pair when the persisted row lacks transcript provenance (weak match duplicates, never trims)", async () => {
    const engine = quietEngine();
    const sessionId = "metadata-face-no-provenance";
    const sessionKey = "agent:main:metadata-face-no-provenance";
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: BARE,
        tokenCount: 12,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    // No transcript at all: the persisted row has no provenance and none can
    // be established, so the metadata-body match must stay weak. The pair
    // deliberately duplicates (duplicates over deletion) rather than let a
    // forgeable metadata block trim on its own authority.
    const missingSessionFile = createSessionFilePath("metadata-face-no-provenance");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastSeenMtimeMs: 1_700_000_000_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: missingSessionFile,
      messages: [makeMessage({ role: "user", content: decorated(BARE) })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(BARE));
    expect(userRows).toHaveLength(2);
    expect(userRows.some((m) => m.content === BARE)).toBe(true);
  });
});
