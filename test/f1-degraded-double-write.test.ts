// F1 follow-up repro: does the DEGRADED (non-covered transcript) afterTurn path
// suffer the same store double-write the COVERED path was fixed for?
//
// The covered path (alignRuntimeBatchAgainstCoveredFrontier) learned to collapse
// a DECORATED runtime copy onto the BARE persisted row of the same turn via
// runtimeRowCoversPersistedFrontierRow. The degraded path (deduplicateAfterTurnBatch
// + deduplicateSuffixFallback) still compares with raw messageIdentity only, so a
// decorated copy whose bare body is already persisted should NOT match and should
// be ingested as a SECOND row.
//
// This test drives the degraded path by pointing the bootstrap checkpoint at a
// MISSING session file (transcriptCovered=false). It asserts the DESIRED behavior
// (single collapsed user row). On the current code it is expected to FAIL, showing
// 2 rows — that failure IS the double-write demonstration.
import { afterEach, describe, expect, it } from "vitest";
import { LcmContextEngine } from "../src/engine.js";
import {
  cleanupEngineTestState,
  createEngine,
  createSessionFilePath,
  makeMessage,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("F1 degraded-path double-write", () => {
  it("degraded path collapses the decorated runtime copy onto the bare persisted row (no double-write)", async () => {
    const engine: LcmContextEngine = createEngine();
    const sessionId = "f1-degraded-double-write";
    const sessionKey = "agent:main:f1-degraded-double-write";

    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    // 1) The BARE inbound row, as a prior covered reconcile would have persisted it.
    const bare = "Hey there Aria! hows it going?";
    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: bare,
        tokenCount: 8,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    // 2) Bootstrap checkpoint → MISSING session file forces the DEGRADED path
    //    (transcript reconcile cannot cover the frontier).
    const missingSessionFile = createSessionFilePath("f1-degraded-double-write");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastSeenMtimeMs: 1_700_000_000_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });

    // 3) afterTurn batch carries the DECORATED copy of the SAME turn.
    const decorated =
      'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "telegram:100000001",\n  "sender": "sam.rivera"\n}\n```\n\n' +
      bare;
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: missingSessionFile,
      messages: [makeMessage({ role: "user", content: decorated })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    const userRows = stored.filter((m) => m.role === "user");
    // Surface the actual stored rows in the failure output.
    // eslint-disable-next-line no-console
    console.log(
      "F1 stored user rows:",
      userRows.map((m) => JSON.stringify(m.content.slice(0, 40))),
    );
    expect(userRows.length).toBe(1);
  });

  it("degraded path KEEPS a genuinely-distinct turn whose trailing line equals a prior body (no false-collapse)", async () => {
    // Safety boundary: the decoration gate must not collapse an undecorated turn
    // just because its trailing line matches a short prior body — that would be
    // silent data loss. Mirrors the covered-path guard.
    const engine: LcmContextEngine = createEngine();
    const sessionId = "f1-degraded-no-false-collapse";
    const sessionKey = "agent:main:f1-degraded-no-false-collapse";

    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const priorBody = "ok";
    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: priorBody,
        tokenCount: 2,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const missingSessionFile = createSessionFilePath("f1-degraded-no-false-collapse");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastSeenMtimeMs: 1_700_000_000_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });

    // Distinct turn, NO decoration markers, trailing line happens to equal "ok".
    const distinct = "here is more context\nok";
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: missingSessionFile,
      messages: [makeMessage({ role: "user", content: distinct })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    const userRows = stored.filter((m) => m.role === "user");
    // Both must survive: the prior "ok" and the distinct turn — no collapse.
    expect(userRows.length).toBe(2);
  });
});
