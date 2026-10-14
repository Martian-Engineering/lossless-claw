import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLcmConnection } from "../src/db/connection.js";
import type { LcmContextEngine } from "../src/engine.js";
import type { ContextEngineRuntimeSettings } from "../src/openclaw-bridge.js";
import {
  cleanupEngineTestState,
  createEngineAtDatabasePath,
  createEngineWithConfig,
  seedStoredMessage,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const sessionId = "maintenance-current-budget";
const sessionKey = `agent:main:${sessionId}`;

function hostSettings(promptTokenBudget: unknown): ContextEngineRuntimeSettings {
  return {
    schemaVersion: 1,
    executionHost: { id: "codex", label: "Codex" },
    limits: { promptTokenBudget },
  };
}

/** Keep the public lifecycle and durable SQLite debt real; stub only execution. */
async function seedDebt(engine: LcmContextEngine, tokenBudget: number) {
  await seedStoredMessage(engine, {
    sessionId, sessionKey, message: { role: "user", content: "Retained evidence" },
  });
  const conversation = (await engine.getConversationStore().getConversationForSession({
    sessionId, sessionKey,
  }))!;
  await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
    conversationId: conversation.conversationId,
    reason: "threshold",
    tokenBudget,
    currentTokenCount: 160_000,
  });
  return conversation.conversationId;
}

function captureExecution(engine: LcmContextEngine) {
  const internal = engine as unknown as {
    executePendingCompactionCore: (params: unknown) => Promise<unknown>;
  };
  return vi.spyOn(internal, "executePendingCompactionCore").mockResolvedValue({
    ok: true, compacted: false, reason: "below current threshold",
  });
}

describe("host-owned maintenance budget", () => {
  it.each([
    { name: "settings without runtimeContext budget", recorded: 500_000, settings: 500_000, expected: 500_000 },
    { name: "settings supersede old fallback debt", recorded: 128_000, settings: 500_000, expected: 500_000 },
    { name: "context supersedes old fallback debt", recorded: 128_000, context: 500_000, expected: 500_000 },
    { name: "configured cap still applies", recorded: 128_000, settings: 828_400, cap: 500_000, expected: 500_000 },
    { name: "smaller settings replace a large budget", recorded: 500_000, settings: 64_000, expected: 64_000 },
    { name: "settings precede conflicting legacy context", recorded: 500_000, settings: 64_000, context: 500_000, expected: 64_000 },
    { name: "invalid settings fall back to current context", recorded: 500_000, settings: Number.NaN, context: 64_000, expected: 64_000 },
    { name: "missing budget retains conservative default", recorded: 500_000, expected: 128_000 },
    { name: "missing budget cannot enlarge small recorded debt", recorded: 64_000, expected: 64_000 },
    { name: "invalid settings cannot enlarge small recorded debt", recorded: 64_000, settings: -1, expected: 64_000 },
  ])("$name", async ({ recorded, settings, context, cap, expected }) => {
    const engine = createEngineWithConfig({
      ...(cap !== undefined ? { maxAssemblyTokenBudget: cap } : {}),
    });
    const conversationId = await seedDebt(engine, recorded);
    const execute = captureExecution(engine);

    await engine.maintain({
      sessionId, sessionKey, sessionFile: "",
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        // Model identity alone is not evidence for a larger prompt allowance.
        model: "large-context-model",
        ...(context !== undefined ? { tokenBudget: context } : {}),
      },
      ...(settings !== undefined ? { runtimeSettings: hostSettings(settings) } : {}),
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: expected }));
    expect(await engine.getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversationId)).toMatchObject({ pending: false });
  });

  it.each([64_000, 500_000, undefined])(
    "recreated engine uses current settings (%s), not an earlier turn's allowance",
    async (currentBudget) => {
      const directory = mkdtempSync(join(tmpdir(), "lossless-maintenance-budget-"));
      tempDirs.push(directory);
      const databasePath = join(directory, "lcm.db");
      const first = createEngineAtDatabasePath(databasePath);
      await seedDebt(first, 128_000);
      // Leave a real data-only maintenance request in the first engine.
      await first.afterTurn({
        sessionId, sessionKey, sessionFile: "", messages: [], prePromptMessageCount: 0,
        tokenBudget: 500_000, currentTokenCount: 450_000,
      });
      closeLcmConnection(databasePath);

      const recreated = createEngineAtDatabasePath(databasePath);
      const execute = captureExecution(recreated);
      await recreated.maintain({
        sessionId, sessionKey, sessionFile: "",
        runtimeContext: { allowDeferredCompactionExecution: true },
        ...(currentBudget !== undefined ? { runtimeSettings: hostSettings(currentBudget) } : {}),
      });
      expect(execute).toHaveBeenCalledWith(expect.objectContaining({
        tokenBudget: currentBudget ?? 128_000,
      }));
    },
  );

  it("current settings override an old queued request in the same engine", async () => {
    const engine = createEngineWithConfig({});
    await seedDebt(engine, 500_000);
    await engine.afterTurn({
      sessionId, sessionKey, sessionFile: "", messages: [], prePromptMessageCount: 0,
      tokenBudget: 500_000, currentTokenCount: 450_000,
    });
    const execute = captureExecution(engine);
    await engine.maintain({
      sessionId, sessionKey, sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true },
      runtimeSettings: hostSettings(64_000),
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 64_000 }));
  });

  it.each([
    { direct: 64_000, settings: 500_000 },
    { direct: 500_000, settings: 64_000 },
  ])("immediate publication preserves the smaller current allowance ($direct/$settings)", async ({ direct, settings }) => {
    const engine = createEngineWithConfig({});
    const conversationId = await seedDebt(engine, 500_000);
    const [message] = await engine.getConversationStore().createMessagesBulk([{
      conversationId, seq: 2, role: "user", content: "Stored threshold pressure",
      tokenCount: 100_000,
    }]);
    await engine.getSummaryStore().appendContextMessages(conversationId, [message.messageId]);
    const execute = captureExecution(engine);
    await engine.afterTurn({
      sessionId, sessionKey, sessionFile: "", messages: [], prePromptMessageCount: 0,
      tokenBudget: direct, currentTokenCount: 100_000,
      runtimeSettings: hostSettings(settings),
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: 64_000 }));
  });

  it("revalidates published debt using the current allowance even during backoff", async () => {
    const engine = createEngineWithConfig({ contextThreshold: 0.9 });
    const conversationId = await seedDebt(engine, 128_000);
    // Between the obsolete 128k threshold and the current 500k threshold.
    const [message] = await engine.getConversationStore().createMessagesBulk([{
      conversationId, seq: 2, role: "user", content: "Canonical published context",
      tokenCount: 160_000,
    }]);
    await engine.getSummaryStore().appendContextMessages(conversationId, [message.messageId]);
    const debt = (await engine.getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversationId))!;
    const batch = await engine.getPendingSummaryStore().createBatch({
      batchId: "pcb_current_budget_published",
      conversationId, status: "planning", sourceProjectionFingerprint: "budget-proof",
      compactableStartOrdinal: 0, compactableEndOrdinal: 0,
      promptVersion: "pending-summary-dag:v1", model: "test-model",
    });
    await engine.getPendingSummaryStore().markBatchPublished({
      batchId: batch.batchId, publishedAt: new Date(debt.requestedAt!.getTime() + 1),
    });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionFinished({
      conversationId, keepPending: true, failureSummary: "ordinary failure",
      nextAttemptAfter: new Date(Date.now() + 60_000),
    });
    const execute = captureExecution(engine);

    const result = await engine.maintain({
      sessionId, sessionKey, sessionFile: "",
      runtimeContext: { allowDeferredCompactionExecution: true },
      runtimeSettings: hostSettings(500_000),
    });

    expect(result.reason).toBe("pending summary publication satisfied stored threshold");
    expect(execute).not.toHaveBeenCalled();
    expect(await engine.getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversationId)).toMatchObject({
        pending: false, running: false, nextAttemptAfter: null, lastFailureSummary: null,
      });
    expect(await engine.getConversationStore().getMessages(conversationId)).toHaveLength(2);
  });
});
