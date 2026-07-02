// Engine afterTurn: transcript-covered persistence, dedup interplay, heartbeat handling, deferred-compaction scheduling. Split from engine-fidelity.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ContextAssembler } from "../src/assembler.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import { estimateSerializedMessageTokens, estimateSerializedMessagesTokens, estimateTokens } from "../src/estimate-tokens.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { applyScopedDoctorRepair } from "../src/plugin/lcm-doctor-apply.js";
import { detectDoctorMarker } from "../src/plugin/lcm-doctor-shared.js";
import type { LcmDependencies } from "../src/types.js";
import {
  cleanupEngineTestState,
  appendSessionMessage,
  getEngineConfig,
  createEngine,
  createEngineWithDepsOverrides,
  createSessionFilePath,
  writeLeafTranscript,
  writeLeafTranscriptMessages,
  createEngineWithConfig,
  createEngineWithDeps,
  makeMessage,
  seedBacklogContext,
  estimateAssembledPayloadTokens,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);
describe("LcmContextEngine afterTurn", () => {

  it("afterTurn runs inline threshold compaction when projected raw backlog crosses threshold", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
      freshTailCount: 1,
    });
    const sessionId = "after-turn-inline-projected-raw-backlog-threshold";
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-inline-projected-raw-backlog-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 600,
      runtimeContext: { currentTokenCount: 300 },
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 600,
        currentTokenCount: 300,
        compactionTarget: "threshold",
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await expect(
      engine.getSummaryStore().getContextTokenCount(conversation!.conversationId),
    ).resolves.toBeLessThan(450);
  });

  it("afterTurn records deferred threshold debt when projected raw backlog crosses threshold", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      { freshTailCount: 1 },
      {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: debugLog },
      },
    );
    const sessionId = "after-turn-deferred-projected-raw-backlog-threshold";
    const privateEngine = engine as unknown as {
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-projected-raw-backlog-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 600,
      runtimeContext: { currentTokenCount: 300 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 600,
        currentTokenCount: 300,
        reason: "threshold",
      }),
    );
    expect(maintenance).toMatchObject({
      pending: true,
      running: false,
      reason: "threshold",
      tokenBudget: 600,
      currentTokenCount: 300,
      projectedTokenCount: expect.any(Number),
      rawTokensOutsideTail: expect.any(Number),
    });
    await expect(
      engine.getSummaryStore().getContextTokenCount(conversation!.conversationId),
    ).resolves.toBeLessThan(450);
    const deferredDebtLog = debugLog.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("deferred compaction debt recorded"));
    expect(deferredDebtLog).toContain("projectedTokenCount=");
    expect(deferredDebtLog).not.toContain("projectedTokenCount=null");
    expect(deferredDebtLog).toContain("rawTokensOutsideTail=");
    expect(deferredDebtLog).not.toContain("rawTokensOutsideTail=null");
  });

  it("afterTurn does not let a lower runtime token count suppress local prompt pressure", async () => {
    const engine = createEngineWithDeps({ freshTailCount: 200 });
    const sessionId = "after-turn-runtime-count-under-reports-local-estimate";
    const privateEngine = engine as unknown as {
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    await seedBacklogContext(engine, sessionId, [10]);
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");
    const messages = [
      makeMessage({
        role: "user",
        content: [{ type: "text", text: `start ${"x".repeat(6000)}` }],
      }),
      makeMessage({
        role: "assistant",
        content: [{ type: "text", text: `result ${"y".repeat(6000)}` }],
      }),
    ];
    const localEstimate = estimateSerializedMessagesTokens(messages);
    expect(localEstimate).toBeGreaterThan(750);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-count-under-reports-local-estimate"),
      messages,
      prePromptMessageCount: 0,
      tokenBudget: 1000,
      runtimeContext: { currentTokenCount: 300 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 1000,
        currentTokenCount: localEstimate,
        reason: "threshold",
      }),
    );
    expect(maintenance).toMatchObject({
      pending: true,
      running: false,
      reason: "threshold",
      tokenBudget: 1000,
      currentTokenCount: localEstimate,
    });
  });

  it("afterTurn schedules prepare-only pending summaries below threshold", async () => {
    const engine = createEngineWithDeps({
      freshTailCount: 1,
      leafChunkTokens: 120,
    });
    const sessionId = "after-turn-below-threshold-pending-summary-prep";
    const privateEngine = engine as unknown as {
      schedulePendingSummaryPreparationDrain: (params: unknown) => void;
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);
    const prepareScheduleSpy = vi
      .spyOn(privateEngine, "schedulePendingSummaryPreparationDrain")
      .mockImplementation(() => undefined);
    const thresholdScheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-below-threshold-pending-summary-prep"),
      messages: [makeMessage({ role: "assistant", content: "fresh below-threshold turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 10_000,
      runtimeContext: { currentTokenCount: 300 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending ?? false).toBe(false);
    expect(thresholdScheduleSpy).not.toHaveBeenCalled();
    expect(prepareScheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation!.conversationId,
        sessionId,
        tokenBudget: 10_000,
        currentTokenCount: 300,
        reason: "leaf-prep",
      }),
    );
  });

  it("background deferred summarization does not block later user-turn ingestion", async () => {
    let resolveComplete:
      | ((value: { content: Array<{ type: "text"; text: string }> }) => void)
      | undefined;
    let completeStarted!: () => void;
    const completeStartedPromise = new Promise<void>((resolve) => {
      completeStarted = resolve;
    });
    const completeResultPromise = new Promise<{ content: Array<{ type: "text"; text: string }> }>(
      (resolve) => {
        resolveComplete = resolve;
      },
    );
    const complete = vi.fn(async () => {
      completeStarted();
      return completeResultPromise;
    });
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        leafChunkTokens: 120,
        condensedMinFanout: 2,
        condensedTargetTokens: 1,
        maxSweepIterations: 8,
        summaryProvider: "anthropic",
        summaryModel: "claude-opus-4-5",
      },
      { complete },
    );
    const sessionId = "after-turn-deferred-background-does-not-block-ingest";
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-background-does-not-block-ingest"),
      messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 600,
      runtimeContext: { currentTokenCount: 300 },
    });
    expect(complete).not.toHaveBeenCalled();

    await completeStartedPromise;
    const ingestWhileSummaryRuns = await Promise.race([
      engine.ingest({
        sessionId,
        message: makeMessage({
          role: "user",
          content: "this user turn should not wait for the pending summary call",
        }),
      }),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
    ]);
    expect(ingestWhileSummaryRuns).toMatchObject({ ingested: true });

    resolveComplete?.({
      content: [{ type: "text", text: "background pending summary" }],
    });
  });



  it("afterTurn drains threshold debt even when cache telemetry stays hot", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-hot-cache-threshold-drain";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "hot",
      consecutiveColdObservations: 0,
      retention: "long",
      lastObservedCacheHitAt: new Date("2026-05-31T12:00:00.000Z"),
      lastObservedCacheRead: 123_000,
      lastObservedPromptTokenCount: 189_666,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 189_666,
      threshold: 102_400,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-hot-cache-threshold-drain"),
      messages: [makeMessage({ role: "assistant", content: "fresh hot-cache turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: {
        currentTokenCount: 189_666,
        provider: "openai-codex",
        model: "gpt-5.5",
        promptCache: {
          retention: "long",
          lastCallUsage: {
            input: 66_666,
            cacheRead: 123_000,
            cacheWrite: 0,
          },
          observation: {
            broke: false,
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: conversation.conversationId,
          sessionId,
          tokenBudget: 128_000,
          currentTokenCount: 189_666,
          compactionTarget: "threshold",
          legacyParams: {
            provider: "openai-codex",
            model: "gpt-5.5",
          },
        }),
      );
    });

    const telemetry = await engine
      .getCompactionTelemetryStore()
      .getConversationCompactionTelemetry(conversation.conversationId);
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(telemetry?.cacheState).toBe("hot");
    expect(telemetry?.consecutiveColdObservations).toBe(0);
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
  });

  it("afterTurn refreshes threshold debt while retry backoff is active without compacting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:30:00.000Z"));
    try {
      const engine = createEngineWithConfig({ freshTailCount: 1 });
      const sessionId = "after-turn-records-debt-during-backoff";
      await seedBacklogContext(engine, sessionId, [100, 100, 100]);
      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation!.conversationId,
        reason: "threshold",
        tokenBudget: 600,
        currentTokenCount: 300,
      });
      await engine.getCompactionMaintenanceStore().markProactiveCompactionRunning({
        conversationId: conversation!.conversationId,
      });
      await engine.getCompactionMaintenanceStore().markProactiveCompactionFinished({
        conversationId: conversation!.conversationId,
        failureSummary: "provider timeout",
        keepPending: true,
      });
      const before = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation!.conversationId);
      const privateEngine = engine as unknown as {
        scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
      };
      const scheduleSpy = vi
        .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
        .mockImplementation(() => undefined);
      const compactSpy = vi.spyOn(engine, "compact");

      await engine.afterTurn({
        sessionId,
        sessionFile: createSessionFilePath("after-turn-records-debt-during-backoff"),
        messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
        prePromptMessageCount: 0,
        tokenBudget: 600,
        runtimeContext: { currentTokenCount: 300 },
      });

      const after = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation!.conversationId);
      expect(compactSpy).not.toHaveBeenCalled();
      expect(scheduleSpy).toHaveBeenCalled();
      expect(after?.pending).toBe(true);
      expect(after?.running).toBe(false);
      expect(after?.nextAttemptAfter?.toISOString()).toBe(
        before?.nextAttemptAfter?.toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });


  it("afterTurn heartbeat flag skips non-empty transcript imports", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-heartbeat-flag-transcript-skip";
    const sessionKey = "agent:main:test:after-turn-heartbeat-flag-transcript-skip";
    const sessionFile = createSessionFilePath("after-turn-heartbeat-flag-transcript-skip");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "heartbeat transcript user" },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "HEARTBEAT_OK" })],
      isHeartbeat: true,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).toBeNull();
  });

});
