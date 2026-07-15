// Whitespace-divergent store double-write on the NORMAL (transcript-covered)
// afterTurn path, NOT a placeholder/checkpoint recovery.
//
// The same user turn is persisted twice because its two faces differ ONLY by
// internal whitespace: the transcript stores the user's verbatim indentation,
// while the runtime in-memory AgentMessage arrives with the indentation
// collapsed. Their identity_hashes differ and neither face carries recognized
// decoration, so alignRuntimeBatchAgainstCoveredFrontier ->
// runtimeRowCoversPersistedFrontierRow fails to recognize the runtime row as
// covering the persisted verbatim row, and the collapsed twin is ingested as a
// SECOND user row.
//
// This test asserts the DESIRED behavior (a single user row whose content stays
// byte-verbatim). On the current code it FAILS, showing 2 rows, and that failure IS
// the whitespace double-write.
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

// Same body; the two faces differ ONLY in indentation (6 spaces vs 1 space).
const LABEL = "tool policy update; the disabled tools are listed below:";
const VERBATIM = `${LABEL}\n\n      "exec",\n      "read",\n      "shell"`;
const COLLAPSED = `${LABEL}\n\n "exec",\n "read",\n "shell"`;

describe("whitespace-divergent covered-path double-write", () => {
  it("collapses the whitespace-normalized runtime twin onto the persisted verbatim row (no double-write)", async () => {
    const warnLog = vi.fn();
    const debugLog = vi.fn();
    const engine: LcmContextEngine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: debugLog } },
    );
    const sessionId = "whitespace-covered-double-write";
    const sessionKey = "agent:main:whitespace-covered-double-write";

    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    // 1) The VERBATIM (6-space) inbound row, as a prior covered reconcile persisted it.
    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: VERBATIM,
        tokenCount: 16,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    // 2) A REAL jsonl holding the same verbatim face → the reconcile reads it to
    //    its frontier and finds overlap (transcriptCovered=true), so afterTurn
    //    takes the COVERED alignment path (not recovery, not degraded).
    const sessionFile = createSessionFilePath("whitespace-covered-double-write");
    writeLeafTranscript(sessionFile, [{ role: "user", content: VERBATIM }]);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
      lastProcessedEntryHash: null,
    });

    // 3) afterTurn runtime batch carries the COLLAPSED (1-space) twin of the same
    //    turn, plus a genuinely-new assistant reply.
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: COLLAPSED }),
        makeMessage({ role: "assistant", content: "updated the tool policy" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    const userBodyRows = stored.filter((m) => m.role === "user" && m.content.includes(LABEL));

    // Diagnostics surfaced in the failure output: the stored faces + which
    // afterTurn path ran (covered alignment vs degraded fallback).
    // eslint-disable-next-line no-console
    console.log(
      "whitespace stored user rows:",
      userBodyRows.map((m) => JSON.stringify(m.content)),
    );
    // eslint-disable-next-line no-console
    console.log(
      "afterTurn path markers:",
      [...debugLog.mock.calls, ...warnLog.mock.calls]
        .map((c) => String(c[0]))
        .filter((m) => /reconcileSessionTail|afterTurn: done|covered the frontier|overlaps persisted/.test(m)),
    );

    // RED today (2 rows: verbatim + collapsed twin). GREEN after the
    // runtimeRowCoversPersistedFrontierRow whitespace-tolerant arm.
    expect(userBodyRows).toHaveLength(1);
    // The survivor is the VERBATIM face (storage stays byte-exact; only the dedup
    // comparison is whitespace-insensitive).
    expect(userBodyRows[0]!.content).toContain('      "exec"');
    // The genuinely-new assistant reply is still imported (no over-suppression).
    expect(
      stored.some((m) => m.role === "assistant" && m.content.includes("updated the tool policy")),
    ).toBe(true);
  });

  it("keeps two genuinely-distinct turns that differ beyond whitespace (no false collapse)", async () => {
    // Boundary: the whitespace-tolerant arm must compare ONLY whitespace, so two
    // turns that differ in real content (not just indentation) must both survive.
    // Passes today; must STAY passing after the fix.
    const engine: LcmContextEngine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = "whitespace-distinct-no-collapse";
    const sessionKey = "agent:main:whitespace-distinct-no-collapse";

    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const priorBody = `${LABEL}\n\n      "exec",\n      "read"`;
    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: priorBody,
        tokenCount: 12,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const sessionFile = createSessionFilePath("whitespace-distinct-no-collapse");
    writeLeafTranscript(sessionFile, [{ role: "user", content: priorBody }]);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
      lastProcessedEntryHash: null,
    });

    // Same label + whitespace style, but a DIFFERENT tool set: the bodies differ
    // beyond whitespace, so a whitespace-only normalizer must NOT collapse them.
    const distinct = `${LABEL}\n\n "gateway",\n "process"`;
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: distinct })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userBodyRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(LABEL));
    expect(userBodyRows).toHaveLength(2);
  });

  it("keeps two turns that differ only by a meaningful newline (space-run narrowing preserves line breaks)", async () => {
    // The narrowed normalizer collapses ONLY runs of spaces (what core rewrites),
    // never newlines. Two turns whose sole difference is a line break vs a
    // space are semantically distinct (pasted code / config / JSON), so both must
    // survive. The old broad /\s+/ normalizer would have wrongly merged them.
    const engine: LcmContextEngine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = "whitespace-newline-distinct";
    const sessionKey = "agent:main:whitespace-newline-distinct";

    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    // Persisted verbatim face: the body carries a real line break.
    const persistedMultiline = `${LABEL}\n"exec"`;
    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: persistedMultiline,
        tokenCount: 10,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const sessionFile = createSessionFilePath("whitespace-newline-distinct");
    writeLeafTranscript(sessionFile, [{ role: "user", content: persistedMultiline }]);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
      lastProcessedEntryHash: null,
    });

    // Identical non-whitespace characters, but the line break is now a single
    // space: a genuinely different turn the narrowed normalizer must NOT collapse.
    const runtimeOneLine = `${LABEL} "exec"`;
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: runtimeOneLine })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userBodyRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(LABEL));
    expect(userBodyRows).toHaveLength(2);
  });

  it.each([
    ["leading", `  ${VERBATIM}`, ` ${COLLAPSED}`],
    ["trailing", `${VERBATIM}  `, `${COLLAPSED} `],
  ])("keeps turns with distinct %s space runs", async (boundary, persisted, runtime) => {
    const engine: LcmContextEngine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = `whitespace-${boundary}-distinct`;
    const sessionKey = `agent:main:whitespace-${boundary}-distinct`;
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: persisted,
        tokenCount: 16,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const sessionFile = createSessionFilePath(`whitespace-${boundary}-distinct`);
    writeLeafTranscript(sessionFile, [{ role: "user", content: persisted }]);
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
      messages: [makeMessage({ role: "user", content: runtime })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userBodyRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(LABEL));
    expect(userBodyRows).toHaveLength(2);
  });

  it("keeps space-run-divergent turns when transcript coverage is degraded", async () => {
    const engine: LcmContextEngine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = "whitespace-degraded-no-collapse";
    const sessionKey = "agent:main:whitespace-degraded-no-collapse";
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey });

    const bulk = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: VERBATIM,
        tokenCount: 16,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const missingSessionFile = createSessionFilePath("whitespace-degraded-no-collapse");
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
      messages: [makeMessage({ role: "user", content: COLLAPSED })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userBodyRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(LABEL));
    expect(userBodyRows).toHaveLength(2);
  });

  it("keeps space-run-divergent turns in degraded oversized suffix matching", async () => {
    const engine: LcmContextEngine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = "whitespace-oversized-no-collapse";
    const sessionKey = "agent:main:whitespace-oversized-no-collapse";
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
        content: VERBATIM,
        tokenCount: 16,
        skipReplayTimestampFloodGuard: true,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, bulk.map((m) => m.messageId));

    const missingSessionFile = createSessionFilePath("whitespace-oversized-no-collapse");
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
      messages: [makeMessage({ role: "user", content: COLLAPSED })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userBodyRows = (
      await engine.getConversationStore().getMessages(conversation.conversationId)
    ).filter((m) => m.role === "user" && m.content.includes(LABEL));
    expect(userBodyRows).toHaveLength(2);
  });
});
