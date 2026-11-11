/**
 * Regression test: a DORMANT conversation's prepared pending-summary frontier
 * must publish even though no compaction event (threshold crossing) will ever
 * arrive for it.
 *
 * A dormant conversation never grows its context, so no assembly pressure is
 * recorded and no threshold debt is created. Before the fix, its ready nodes
 * stayed unpublished forever.
 *
 * An ACTIVE conversation must keep the preparation-only contract: below
 * threshold, preparation stays hidden and records no debt.
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

describe("dormant pending-summary publication", () => {
  it("publishes a dormant conversation's prepared frontier without a compaction event", async () => {
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
        // A zero window makes every conversation dormant immediately.
        pendingSummaryDormancyMs: 0,
      },
      { complete },
    );
    const sessionId = "dormant-pending-summary";

    await seedBacklogContext(engine, sessionId, [LEAF_TOKENS, LEAF_TOKENS, LEAF_TOKENS]);
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "fresh tail" }),
    });

    // The first maintenance pass prepares the leaves. With a zero dormancy
    // window the conversation is already dormant, so the same pass also
    // publishes the prepared frontier even though the threshold was never
    // crossed.
    await engine.maintain({
      sessionId,
      sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 10_000 },
    });

    const conversationId = await conversationIdFor(engine, sessionId);
    const summaries = await engine.getSummaryStore().getSummariesByConversation(conversationId);
    expect(summaries.length).toBeGreaterThan(0);
  }, 60_000);

  it("keeps the preparation-only contract for an active conversation", async () => {
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
        // Dormancy never applies: the window is effectively infinite.
        pendingSummaryDormancyMs: -1,
      },
      { complete },
    );
    const sessionId = "active-pending-summary";

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
    const nodes = await engine.getPendingSummaryStore().getNodesByBatch(batch!.batchId);
    expect(nodes.some((node) => node.status === "ready")).toBe(true);

    // A second pass must NOT publish: the conversation is active, so the
    // prepared frontier may still be extended by a later turn.
    await engine.maintain({
      sessionId,
      sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true, tokenBudget: 10_000 },
    });

    await expect(
      engine.getSummaryStore().getSummariesByConversation(conversationId),
    ).resolves.toHaveLength(0);
  }, 60_000);
});
