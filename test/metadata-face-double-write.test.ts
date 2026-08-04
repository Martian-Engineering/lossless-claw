// Metadata-face store double-write across the afterTurn dedup boundaries.
//
// OpenClaw delivers the same inbound turn in two faces: the transcript
// persists the BARE body (with a transcript_entry_id), while the runtime
// AgentMessage carries the DECORATED face ("Conversation info (untrusted
// metadata)" block + body). Their identity_hashes differ, so identity dedup
// cannot see the pair; the metadata-body match must collapse it. Collapse
// strength exists only on the transcript-covered route and requires the
// persisted row to be host-proven (transcript provenance), ingested by the
// CURRENT turn's own reconcile (message_id above the pre-reconcile floor the
// engine captures), AND the conversation's newest user row — a backfilled
// historical row imported by the same reconcile never anchors. Any other
// row, and any provenance-less row, stays weak and duplicates instead of
// trimming; the degraded and oversized routes never strong-collapse at all.
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

function decoratedWithAnnouncedRecap(body: string): string {
  const recap = [
    "Conversation context (untrusted, chronological, selected for current message):",
    "#12 Tue 2026-07-22 10:00 GMT+3 sam.rivera: earlier message about the build",
  ].join("\n");
  return (
    'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "user:U0EXAMPLE01",\n  "sender": "sam.rivera",\n  "history_count": 1\n}\n```\n\n' +
    `${recap}\n\n${body}`
  );
}

function quietEngine(): LcmContextEngine {
  return createEngineWithDeps(
    {},
    { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
  );
}

describe("metadata-face covered-path double-write", () => {
  it("collapses an announced-recap twin when a sibling exact row anchors the covered route", async () => {
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
        role: "assistant",
        content: "previous exact reply",
        tokenCount: 3,
        transcriptEntryId: "probe-entry-0002",
        skipReplayTimestampFloodGuard: true,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
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
    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: "previous exact reply" },
      { role: "user", content: BARE },
    ]);
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
        makeMessage({ role: "assistant", content: "previous exact reply" }),
        makeMessage({ role: "user", content: decoratedWithAnnouncedRecap(BARE) }),
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

  it("keeps the pair on the degraded route even for a transcript-proven row created moments ago (not this turn's ingest; covers the rapid repeated-body case)", async () => {
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

    // The persisted row was seeded moments ago, yet the transcript is
    // unavailable this turn: the degraded route runs without same-turn
    // ingest proof and never strong-collapses, so the match stays weak. A
    // rapid repeated body (same text within seconds) takes exactly this
    // shape, and the pair duplicates instead of eating the new turn.
    const userRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(BARE));
    expect(userRows).toHaveLength(2);
    expect(userRows.some((m) => m.content === BARE)).toBe(true);
    expect(userRows.some((m) => m.content !== BARE)).toBe(true);
  });

  it("keeps the pair on the oversized-suffix route even for a transcript-proven row created moments ago (not this turn's ingest)", async () => {
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
    expect(userRows).toHaveLength(2);
    expect(userRows.some((m) => m.content === BARE)).toBe(true);
    expect(userRows.some((m) => m.content !== BARE)).toBe(true);
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

describe("covered-frontier same-turn anchor", () => {
  it("never anchors on a backfilled above-floor row: an older user row imported by the same reconcile stays weak and the batch is kept", async () => {
    // Catch-up reconcile shape: floor 0 (first reconcile of the
    // conversation), several host-proven rows imported by the same
    // reconcile, among them an OLD user row whose body a decorated runtime
    // face repeats. The insertion watermark alone would call that row
    // same-turn; the newest-user-row condition refuses it, and its
    // provenanced sibling never extends strength to the refused neighbor.
    const engine = quietEngine();
    const sessionId = "metadata-face-backfill";
    const sessionKey = "agent:main:metadata-face-backfill";
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
        transcriptEntryId: "backfill-entry-0001",
        skipReplayTimestampFloodGuard: true,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: DIFFERENT,
        tokenCount: 8,
        transcriptEntryId: "backfill-entry-0002",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const result = await engine
      .getBatchDeduplicator()
      .alignRuntimeBatchAgainstCoveredFrontier(
        sessionId,
        sessionKey,
        [
          makeMessage({ role: "user", content: decorated(BARE) }),
          makeMessage({ role: "user", content: decorated(DIFFERENT) }),
        ],
        0,
      );

    // The BARE-bodied face matched a row that is above the floor but not the
    // newest user row (a backfill), so nothing in the suffix may trim.
    expect(result).toHaveLength(2);
  });

  it("collapses a lone decorated face onto exactly its own same-turn ingest (above floor and the newest user row)", async () => {
    const engine = quietEngine();
    const sessionId = "metadata-face-own-ingest";
    const sessionKey = "agent:main:metadata-face-own-ingest";
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
        transcriptEntryId: "own-ingest-entry-0001",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const result = await engine
      .getBatchDeduplicator()
      .alignRuntimeBatchAgainstCoveredFrontier(
        sessionId,
        sessionKey,
        [makeMessage({ role: "user", content: decorated(BARE) })],
        0,
      );

    expect(result).toHaveLength(0);
  });

  it("keeps the pair when no floor is available (lookup failure disables the strong collapse)", async () => {
    const engine = quietEngine();
    const sessionId = "metadata-face-no-floor";
    const sessionKey = "agent:main:metadata-face-no-floor";
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
        transcriptEntryId: "no-floor-entry-0001",
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const result = await engine
      .getBatchDeduplicator()
      .alignRuntimeBatchAgainstCoveredFrontier(sessionId, sessionKey, [
        makeMessage({ role: "user", content: decorated(BARE) }),
      ]);

    expect(result).toHaveLength(1);
  });
});
