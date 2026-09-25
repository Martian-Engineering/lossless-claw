import { describe, expect, it, vi } from "vitest";
import { PendingCompactionCoordinator } from "../src/pending-summary-coordinator.js";
import {
  createEngineWithDeps,
  createSessionFilePath,
  makeMessage,
  seedBacklogContext,
} from "./helpers.js";

describe("compaction of a ready prefix during generation cooldown", () => {
  it.each(["compact", "maintain"])(
    "publishes prepared coverage through %s without calling a model",
    async (entry) => {
      const complete = vi.fn();
      const engine = createEngineWithDeps(
        {
          freshTailCount: 1,
          leafChunkTokens: 120,
          condensedMinFanout: 2,
          condensedTargetTokens: 1,
          summaryProvider: "anthropic",
          summaryModel: "claude-opus-4-5",
        },
        { complete },
      );
      const sessionId = "prefix-spend-backoff";
      await seedBacklogContext(engine, sessionId, Array(8).fill(60));
      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: "protected fresh tail" }),
      });
      const conversation = (await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId))!;
      const conversationId = conversation.conversationId;
      const coordinator = new PendingCompactionCoordinator({
        conversationStore: engine.getConversationStore(),
        summaryStore: engine.getSummaryStore(),
        pendingSummaryStore: engine.getPendingSummaryStore(),
        model: "test",
        leaseOwner: "test",
        config: {
          freshTailCount: 1,
          leafChunkTokens: 120,
          condensedMinFanout: 2,
          condensedMinSourceTokens: 1,
          condensedChunkTokens: 1000,
        },
        summarize: async () => "prepared summary",
      });
      for (let step = 0; step < 3; step += 1) {
        await coordinator.runOnce({
          conversationId,
          publishPolicy: "prepare-only",
        });
      }
      const before = await engine.getSummaryStore().getContextItems(conversationId);
      expect(before).toHaveLength(9);
      const batch = (await engine
        .getPendingSummaryStore()
        .getActiveBatchForConversation(conversationId))!;
      const guard = engine.getCompactionGuards();
      const scopeKey = guard.resolveSummarySpendScope({
        kind: "compaction",
        scope: sessionId,
      });
      const until = guard.openSummarySpendBackoff({
        scopeKey,
        reason: "test generation cap",
      });
      if (entry === "maintain") {
        const maintenance = engine.getCompactionMaintenanceStore();
        await maintenance.requestProactiveCompactionDebt({
          conversationId,
          reason: "threshold",
          tokenBudget: 200,
          currentTokenCount: 490,
        });
        await maintenance.markProactiveCompactionFinished({
          conversationId,
          keepPending: true,
          nextAttemptAfter: until,
        });
        expect(
          await engine.maintain({
            sessionId,
            sessionFile: createSessionFilePath(sessionId),
            runtimeContext: {
              allowDeferredCompactionExecution: true,
              tokenBudget: 200,
              currentTokenCount: 490,
            },
          }),
        ).toMatchObject({ changed: true, reason: "pending summaries published" });
        expect(
          await maintenance.getConversationCompactionMaintenance(conversationId),
        ).toMatchObject({ pending: true, running: false, nextAttemptAfter: until });
      } else {
        const result = await engine.compact({
          sessionId,
          sessionFile: createSessionFilePath(sessionId),
          tokenBudget: 200,
          currentTokenCount: 490,
          compactionTarget: "threshold",
        });
        expect(result).toMatchObject({
          ok: true,
          compacted: true,
          pending: true,
          result: {
            status: "published",
            remainingCompactableWork: true,
            summarySpendBackoffUntil: until.toISOString(),
          },
        });
      }
      expect(complete).not.toHaveBeenCalled();
      expect(guard.getSummarySpendBackoffUntil(scopeKey)).toEqual(until);
      const active = await engine.getSummaryStore().getContextItems(conversationId);
      expect(active.map((item) => item.itemType)).toEqual([
        "summary",
        "summary",
        ...Array(5).fill("message"),
      ]);
      expect(active.slice(2).map((item) => item.messageId)).toEqual(
        before.slice(4).map((item) => item.messageId),
      );
      expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(9);
      expect(await engine.getPendingSummaryStore().getBatch(batch.batchId)).toMatchObject({
        status: "planning",
      });
      // Repeating the trigger cannot regenerate, republish, or clear cooldown.
      expect(
        await engine.compact({
          sessionId,
          sessionFile: createSessionFilePath(sessionId),
          tokenBudget: 200,
          currentTokenCount: 490,
          compactionTarget: "threshold",
        }),
      ).toMatchObject({ compacted: false, reason: "summary spend backoff open" });
      expect(complete).not.toHaveBeenCalled();
      expect(await engine.getSummaryStore().getContextItems(conversationId)).toEqual(active);
    },
  );
});
