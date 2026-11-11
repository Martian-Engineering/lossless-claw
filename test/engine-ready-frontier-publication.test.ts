/**
 * Regression test: a prepared pending-summary frontier must be REAPED even
 * when the publish gate can no longer fire for it.
 *
 * The two-part failure this covers:
 *
 *   1. The publish gate. `maintain()` decides whether to publish by asking
 *      `evaluateLeafTrigger`, which measures raw-token pressure outside the
 *      fresh tail. Preparing a summary is what REPLACES those raw tokens
 *      with summaries in the context projection, so a prepared conversation
 *      falls below the threshold and the trigger never fires again.
 *
 *   2. The reaping. Even when the trigger does fire, publication can be
 *      REFUSED: `getActiveBatchStaleReason` rejects the batch when its
 *      planned range is no longer compactable or when the source projection
 *      fingerprint changed. The prepared nodes then sit in `ready` forever,
 *      because nothing advances them and nothing rejects them either.
 *
 * The combination is what strands the backlog in the live database: the
 * conversation is below threshold (gate closed) and its batch is stale
 * (publication refused), so the prepared work is neither publishable nor
 * discarded.
 *
 * The fix: `maintain()` publishes an existing ready frontier through the
 * "publish-ready-only" policy whenever the leaf trigger does not fire. That
 * policy re-validates the batch and MARKS IT STALE when it can no longer
 * publish, which retires the stranded nodes instead of leaving them in
 * `ready` indefinitely. Work that is still publishable is published; work
 * that is not is retired with a recorded reason.
 *
 * This is deliberately an end-state assertion: after a maintenance pass, no
 * prepared node may remain stranded in `ready` for a conversation whose
 * frontier cannot publish.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupEngineTestState,
  createEngineWithDeps,
  makeMessage,
  seedBacklogContext,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const LEAF_TOKENS = 120;

async function conversationIdFor(
  engine: ReturnType<typeof createEngineWithDeps>,
  sessionId: string,
): Promise<number> {
  const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
  expect(conversation).not.toBeNull();
  return conversation!.conversationId;
}

describe("stranded ready-frontier reaping", () => {
  it("does not leave prepared nodes stranded in 'ready' when the gate cannot fire", async () => {
    const complete = vi.fn(async () => ({
      content: [{ type: "text", text: "Summary of completed messages." }],
    }));
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        leafChunkTokens: LEAF_TOKENS,
        condensedMinFanout: 2,
        condensedTargetTokens: 1,
        maxSweepIterations: 8,
        proactiveThresholdCompactionMode: "deferred",
        // Dormant publication is DISABLED so only the threshold-independent
        // path can act here.
        pendingSummaryDormancyMs: -1,
      },
      { complete },
    );
    const sessionId = "stranded-ready-frontier";

    await seedBacklogContext(engine, sessionId, [LEAF_TOKENS, LEAF_TOKENS, LEAF_TOKENS]);
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "fresh tail" }),
    });

    // Pass 1 prepares the leaves.
    await engine.maintain({
      sessionId,
      sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 10_000 },
    });

    const conversationId = await conversationIdFor(engine, sessionId);
    const batch = await engine.getPendingSummaryStore().getActiveBatchForConversation(conversationId);
    expect(batch).not.toBeNull();
    const before = await engine.getPendingSummaryStore().getNodesByBatch(batch!.batchId);
    expect(before.some((node) => node.status === "ready")).toBe(true);

    // Reproduce the production state: the context projection has moved on
    // since the batch was planned, so the batch's planned range no longer
    // matches what is compactable. This is exactly what the live stuck
    // batches look like (their source_projection_fingerprint no longer
    // matches, and their planned range extends past the projection).
    const canonical = await engine.getSummaryStore().insertSummary({
      summaryId: "sum_strand_sim",
      conversationId,
      kind: "leaf",
      depth: 0,
      content: "Canonical summary replacing the raw backlog.",
      tokenCount: 20,
      descendantCount: 3,
      descendantTokenCount: LEAF_TOKENS * 3,
      sourceMessageTokenCount: LEAF_TOKENS * 3,
      earliestAt: new Date("2026-01-01T00:00:00Z"),
      latestAt: new Date("2026-01-01T00:00:00Z"),
      createdAt: new Date("2026-01-01T00:00:00Z"),
      model: "test",
    });
    await engine.getSummaryStore().replaceContextRangesWithSummaries({
      conversationId,
      replacements: [
        {
          startOrdinal: batch!.compactableStartOrdinal,
          endOrdinal: batch!.compactableEndOrdinal,
          summaryId: canonical.summaryId,
        },
      ],
    });

    // The gate is now closed: no raw tokens remain outside the fresh tail.
    const leaf = await engine.getCompactionEngine().evaluateLeafTrigger(conversationId);
    expect(leaf.shouldCompact).toBe(false);

    // Pass 2 must not leave the prepared nodes stranded in "ready".
    await engine.maintain({
      sessionId,
      sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 10_000 },
    });

    const activeBatch = await engine.getPendingSummaryStore().getActiveBatchForConversation(conversationId);
    const after = activeBatch
      ? await engine.getPendingSummaryStore().getNodesByBatch(activeBatch.batchId)
      : [];
    const stillReady = after.filter((node) => node.status === "ready");
    expect(stillReady).toHaveLength(0);
  }, 60_000);

  it("leaves an active conversation's prepared frontier alone when the gate still fires", async () => {
    const complete = vi.fn(async () => ({
      content: [{ type: "text", text: "Summary of completed messages." }],
    }));
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        leafChunkTokens: LEAF_TOKENS,
        condensedMinFanout: 2,
        condensedTargetTokens: 1,
        maxSweepIterations: 8,
        proactiveThresholdCompactionMode: "deferred",
        pendingSummaryDormancyMs: -1,
      },
      { complete },
    );
    const sessionId = "publishable-ready-frontier";

    await seedBacklogContext(engine, sessionId, [LEAF_TOKENS, LEAF_TOKENS, LEAF_TOKENS]);
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "fresh tail" }),
    });

    await engine.maintain({
      sessionId,
      sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 10_000 },
    });

    const conversationId = await conversationIdFor(engine, sessionId);
    const batch = await engine.getPendingSummaryStore().getActiveBatchForConversation(conversationId);
    expect(batch).not.toBeNull();
    const before = await engine.getPendingSummaryStore().getNodesByBatch(batch!.batchId);
    expect(before.some((node) => node.status === "ready")).toBe(true);

    // The projection is UNCHANGED, so the leaf trigger STILL fires and the
    // preparation-only contract applies: an active conversation's frontier
    // may still be extended by a later turn, so it stays prepared and
    // unpublished. The threshold-independent path must NOT interfere.
    const leaf = await engine.getCompactionEngine().evaluateLeafTrigger(conversationId);
    expect(leaf.shouldCompact).toBe(true);

    await engine.maintain({
      sessionId,
      sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 10_000 },
    });

    const summaries = await engine.getSummaryStore().getSummariesByConversation(conversationId);
    expect(summaries).toHaveLength(0);
    const stillActive = await engine.getPendingSummaryStore().getActiveBatchForConversation(conversationId);
    expect(stillActive).not.toBeNull();
    const after = await engine.getPendingSummaryStore().getNodesByBatch(stillActive!.batchId);
    expect(after.some((node) => node.status === "ready")).toBe(true);
  }, 60_000);
});
