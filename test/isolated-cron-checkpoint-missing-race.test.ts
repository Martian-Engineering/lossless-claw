/**
 * Regression tests: fix/isolated-cron-sessionid-guard-race
 *
 * When multiple isolated cron runs fire simultaneously, they share the same
 * durable sessionKey (agent:<agentId>:cron:<jobId>). The checkpoint-missing
 * recovery path in transcript-reconciler.ts had a guard
 * `conversation.sessionId === params.sessionId` that could silently fail for
 * runner-up cron invocations whose sessionId had been overwritten.
 *
 * The fix resolves isolated cron afterTurn by runtime session first. A stale
 * or missing runtime row must not take over the newer active cron conversation
 * when the shared cron key is already owned by another runtime.
 */
import { describe, expect, it } from "vitest";
import { isIsolatedCronSessionKey } from "../src/session-patterns.js";

describe("isIsolatedCronSessionKey export and behavior", () => {
  it("returns true for well-formed isolated cron session keys", () => {
    expect(isIsolatedCronSessionKey("agent:main:cron:nightly-summary")).toBe(true);
    expect(isIsolatedCronSessionKey("agent:test:cron:myjob")).toBe(true);
    expect(isIsolatedCronSessionKey("agent:chatbot:cron:daily-report")).toBe(true);
    expect(isIsolatedCronSessionKey("  agent:main:cron:nightly  ")).toBe(true); // trimmed
  });

  it("returns false for non-cron session keys", () => {
    expect(isIsolatedCronSessionKey(undefined)).toBe(false);
    expect(isIsolatedCronSessionKey("")).toBe(false);
    expect(isIsolatedCronSessionKey("   ")).toBe(false);
    expect(isIsolatedCronSessionKey("agent:main:default")).toBe(false);
    expect(isIsolatedCronSessionKey("agent:chatbot:session-id-123")).toBe(false);
    expect(isIsolatedCronSessionKey("cron:main:agent:nightly")).toBe(false); // wrong order
    expect(isIsolatedCronSessionKey("agent:cron:nightly")).toBe(false); // too few parts
  });
});

// ─── End-to-end: reconciler branch through engine.afterTurn ───

import { afterEach, vi } from "vitest";
import { SessionRolloverDetector } from "../src/session-rollover.js";
import {
  cleanupEngineTestState,
  createEngine,
  createSessionFilePath,
  makeMessage,
  writeLeafTranscript,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

/**
 * Helper: delete the bootstrap_state row directly via the store's db,
 * simulating a checkpoint that was lost (e.g. after a race or recovery event).
 */
function deleteBootstrapState(
  engine: ReturnType<typeof createEngine>,
  conversationId: number,
): void {
  const store = engine.getSummaryStore() as unknown as {
    db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
  };
  store.db
    .prepare("DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?")
    .run(conversationId);
}

/**
 * Helper: directly update a conversation's session_id in the DB, simulating
 * the effect of a concurrent getOrCreateConversation call that rebound the
 * sessionKey to a newer runtime sessionId before this reconciler pass ran.
 */
function updateConversationSessionId(
  engine: ReturnType<typeof createEngine>,
  conversationId: number,
  newSessionId: string,
): void {
  const store = engine.getConversationStore() as unknown as {
    db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } };
  };
  store.db
    .prepare("UPDATE conversations SET session_id = ? WHERE conversation_id = ?")
    .run(newSessionId, conversationId);
}

describe("isolated cron checkpoint-missing recovery", () => {
  const cronSessionKey = "agent:main:cron:nightly-report";

  it("does not recover a missing runtime row when another runtime owns the cron key", async () => {
    // Simulate a legacy/rebound shape where the shared cron key points at a
    // different runtime session and no conversation row still owns the original
    // runtime session id. Recovery must not weaken the checkpoint-missing
    // no-anchor guard or rotate the active cron key owner from afterTurn.
    //
    // We achieve this by:
    // 1. Bootstrapping a cron conversation normally
    // 2. Deleting the bootstrap checkpoint (simulating checkpoint loss)
    // 3. Directly updating the conversation's sessionId in the DB (simulating
    //    a concurrent getOrCreateConversation that rebound the sessionKey)
    // 4. Mocking the rollover detector to be a no-op to isolate the resolver
    //    branch under test
    // 5. Calling afterTurn with the original sessionId.

    const engine = createEngine();

    const firstSessionId = "cron-run-001";
    const firstSessionFile = createSessionFilePath("cron-run-001");
    writeLeafTranscript(firstSessionFile, [
      { role: "user", content: "run nightly report" },
      { role: "assistant", content: "report generated" },
    ]);

    // Phase 1: Bootstrap normally.
    const bootstrapResult = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey: cronSessionKey,
      sessionFile: firstSessionFile,
    });
    expect(bootstrapResult.bootstrapped).toBe(true);

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(firstSessionId);
    expect(conversation).not.toBeNull();
    expect(conversation!.bootstrappedAt).not.toBeNull();

    // Delete bootstrap checkpoint to trigger checkpoint-missing path.
    deleteBootstrapState(engine, conversation!.conversationId);
    let checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint).toBeNull();

    // Simulate TOCTOU: update sessionId to a different value, as if a
    // concurrent cron run rebound the sessionKey.
    updateConversationSessionId(engine, conversation!.conversationId, "cron-run-002");
    const updatedConversation = await engine
      .getConversationStore()
      .getConversationBySessionId("cron-run-002");
    expect(updatedConversation).not.toBeNull();
    expect(updatedConversation!.sessionId).toBe("cron-run-002");

    // Mock the rollover detector to be a no-op — simulating that it already
    // ran successfully in a prior transaction and found no mismatch.
    const reconciler = (engine as unknown as {
      transcriptReconciler: {
        rolloverDetector: SessionRolloverDetector;
      };
    }).transcriptReconciler;
    vi.spyOn(reconciler.rolloverDetector, "rotateIsolatedCronConversationIfRuntimeChanged").mockResolvedValue(false);

    // Phase 2: Call afterTurn with the ORIGINAL sessionId. The shared cron
    // key currently points at cron-run-002, but no row owns cron-run-001.
    const secondSessionFile = createSessionFilePath("cron-run-001-phase2");
    writeLeafTranscript(secondSessionFile, [
      { role: "user", content: "run nightly report" },
      { role: "assistant", content: "report generated" },
      { role: "user", content: "follow-up question" },
      { role: "assistant", content: "follow-up answer" },
    ]);

    await engine.afterTurn({
      sessionId: "cron-run-001", // original sessionId — mismatches conversation's sessionId
      sessionKey: cronSessionKey,
      sessionFile: secondSessionFile,
      messages: [
        makeMessage({ role: "user", content: "follow-up question" }),
        makeMessage({ role: "assistant", content: "follow-up answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // Verify: the stale/missing runtime did not import into the active cron row.
    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const contents = messages.map((m) => m.content);

    // The original bootstrap messages should still be present.
    expect(contents).toContain("run nightly report");
    expect(contents).toContain("report generated");
    expect(contents).not.toContain("follow-up answer");

    const activeByCronKey = await engine
      .getConversationStore()
      .getConversationBySessionKey(cronSessionKey);
    expect(activeByCronKey?.conversationId).toBe(conversation!.conversationId);
    expect(activeByCronKey?.sessionId).toBe("cron-run-002");
  });

  it("does not create a cron conversation when the runtime session owns another key", async () => {
    const engine = createEngine();

    const sessionId = "runtime-shared-with-non-cron";
    const nonCronSessionKey = "agent:main:channel:general";
    const firstSessionFile = createSessionFilePath("runtime-non-cron-owner");
    writeLeafTranscript(firstSessionFile, [
      { role: "user", content: "ordinary channel prompt" },
      { role: "assistant", content: "ordinary channel answer" },
    ]);

    await engine.bootstrap({
      sessionId,
      sessionKey: nonCronSessionKey,
      sessionFile: firstSessionFile,
    });

    const originalConversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(originalConversation).not.toBeNull();
    expect(originalConversation?.sessionKey).toBe(nonCronSessionKey);

    const cronSessionFile = createSessionFilePath("runtime-ambiguous-cron-key");
    writeLeafTranscript(cronSessionFile, [
      { role: "user", content: "ambiguous cron prompt" },
      { role: "assistant", content: "ambiguous cron answer" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey: cronSessionKey,
      sessionFile: cronSessionFile,
      messages: [
        makeMessage({ role: "user", content: "ambiguous cron prompt" }),
        makeMessage({ role: "assistant", content: "ambiguous cron answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const activeCronConversation = await engine
      .getConversationStore()
      .getConversationBySessionKey(cronSessionKey);
    expect(activeCronConversation).toBeNull();

    const originalMessages = await engine
      .getConversationStore()
      .getMessages(originalConversation!.conversationId);
    const originalContents = originalMessages.map((m) => m.content);
    expect(originalContents).toEqual(["ordinary channel prompt", "ordinary channel answer"]);
    expect(originalContents).not.toContain("ambiguous cron answer");
  });
});

describe("cron isolation / fail-closed rollover preservation", () => {
  const cronSessionKey = "agent:main:cron:daily-digest";

  it("non-cron session with stale sessionId fails closed on checkpoint-missing", async () => {
    // This test proves the fix does NOT weaken the fail-closed rollover guard
    // for non-cron sessions. A non-cron sessionKey with mismatched sessionId
    // and missing checkpoint should NOT be recovered through the relaxed guard.

    const engine = createEngine();

    const firstSessionId = "session-alpha";
    const nonCronSessionKey = "agent:main:default";
    const firstSessionFile = createSessionFilePath("session-alpha");
    writeLeafTranscript(firstSessionFile, [
      { role: "user", content: "alpha message 1" },
      { role: "assistant", content: "alpha reply 1" },
    ]);

    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey: nonCronSessionKey,
      sessionFile: firstSessionFile,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(firstSessionId);
    expect(conversation).not.toBeNull();

    // Delete bootstrap checkpoint.
    deleteBootstrapState(engine, conversation!.conversationId);

    // Simulate TOCTOU: update sessionId to simulate concurrent rebind.
    updateConversationSessionId(engine, conversation!.conversationId, "session-beta");

    // Mock rollover detector to no-op (simulating TOCTOU gap).
    const reconciler = (engine as unknown as {
      transcriptReconciler: {
        rolloverDetector: SessionRolloverDetector;
      };
    }).transcriptReconciler;
    vi.spyOn(
      reconciler.rolloverDetector,
      "findAmbiguousSessionKeyRuntimeRollover",
    ).mockResolvedValue(null);

    // Call afterTurn with original sessionId — mismatches conversation's sessionId.
    // Use a transcript with COMPLETELY DIFFERENT content (no overlap) so the
    // reconciler cannot anchor via content overlap. Without the cron guard,
    // checkpoint-missing recovery is blocked for non-cron sessions.
    const secondSessionFile = createSessionFilePath("session-alpha-phase2");
    writeLeafTranscript(secondSessionFile, [
      { role: "user", content: "completely unrelated question" },
      { role: "assistant", content: "unrelated answer" },
    ]);

    await engine.afterTurn({
      sessionId: firstSessionId,
      sessionKey: nonCronSessionKey,
      sessionFile: secondSessionFile,
      messages: [
        makeMessage({ role: "user", content: "completely unrelated question" }),
        makeMessage({ role: "assistant", content: "unrelated answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // The non-cron session should fail-closed: beta messages NOT ingested.
    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const contents = messages.map((m) => m.content);

    // The unrelated messages MUST NOT be present — fail-closed guard blocked
    // checkpoint-missing recovery for non-cron session with mismatched sessionId.
    expect(contents).not.toContain("unrelated answer");

    // Original messages should still be there.
    expect(contents).toContain("alpha message 1");
    expect(contents).toContain("alpha reply 1");
  });

  it("isolated cron rollover keeps a stale old afterTurn from taking over the active run", async () => {
    // This test proves the existing cron isolation rollover behavior
    // (rotateIsolatedCronConversationIfRuntimeChanged) is not broken.
    // When a new cron run uses the same sessionKey but different sessionId,
    // the old conversation is archived and a new one is created.

    const engine = createEngine();

    const firstSessionId = "cron-run-A";
    const firstSessionFile = createSessionFilePath("cron-run-A");
    writeLeafTranscript(firstSessionFile, [
      { role: "user", content: "first cron message" },
      { role: "assistant", content: "first cron reply" },
    ]);

    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey: cronSessionKey,
      sessionFile: firstSessionFile,
    });

    const firstConversation = await engine
      .getConversationStore()
      .getConversationBySessionId(firstSessionId);
    expect(firstConversation).not.toBeNull();

    // Delete bootstrap checkpoint to simulate checkpoint loss (forces
    // recovery path to be considered).
    deleteBootstrapState(engine, firstConversation!.conversationId);

    // Phase 2: New cron run with different sessionId, SAME sessionKey.
    const secondSessionId = "cron-run-B";
    const secondSessionFile = createSessionFilePath("cron-run-B");
    writeLeafTranscript(secondSessionFile, [
      { role: "user", content: "second cron message" },
      { role: "assistant", content: "second cron reply" },
    ]);

    await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey: cronSessionKey,
      sessionFile: secondSessionFile,
    });

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey: cronSessionKey,
      sessionFile: secondSessionFile,
      messages: [
        makeMessage({ role: "user", content: "second cron message" }),
        makeMessage({ role: "assistant", content: "second cron reply" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const archivedFirstConversation = await engine
      .getConversationStore()
      .getConversation(firstConversation!.conversationId);
    expect(archivedFirstConversation?.active).toBe(false);

    const secondConversation = await engine
      .getConversationStore()
      .getConversationBySessionId(secondSessionId);
    expect(secondConversation).not.toBeNull();
    expect(secondConversation!.conversationId).not.toBe(firstConversation!.conversationId);
    expect(secondConversation!.sessionId).toBe(secondSessionId);

    const secondMessages = await engine
      .getConversationStore()
      .getMessages(secondConversation!.conversationId);
    const secondContents = secondMessages.map((m) => m.content);
    expect(secondContents).toEqual(["second cron message", "second cron reply"]);

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (...args: unknown[]) => Promise<unknown>;
      };
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate");

    // A delayed afterTurn from the old run must not archive the newer active
    // run, import into it, or run post-turn maintenance against it.
    const staleOldSessionFile = createSessionFilePath("cron-run-A-stale");
    writeLeafTranscript(staleOldSessionFile, [
      { role: "user", content: "stale first cron follow-up" },
      { role: "assistant", content: "stale first cron answer" },
    ]);

    await engine.afterTurn({
      sessionId: firstSessionId,
      sessionKey: cronSessionKey,
      sessionFile: staleOldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "stale first cron follow-up" }),
        makeMessage({ role: "assistant", content: "stale first cron answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(evaluateSpy).not.toHaveBeenCalled();

    const secondAfterStale = await engine
      .getConversationStore()
      .getConversation(secondConversation!.conversationId);
    expect(secondAfterStale?.active).toBe(true);

    const activeByCronKey = await engine
      .getConversationStore()
      .getConversationBySessionKey(cronSessionKey);
    expect(activeByCronKey?.conversationId).toBe(secondConversation!.conversationId);

    const secondContentsAfterStale = (
      await engine.getConversationStore().getMessages(secondConversation!.conversationId)
    ).map((m) => m.content);
    expect(secondContentsAfterStale).toEqual(["second cron message", "second cron reply"]);
    expect(secondContentsAfterStale).not.toContain("stale first cron answer");
  });
});
