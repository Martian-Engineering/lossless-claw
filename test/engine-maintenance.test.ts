// Engine maintain() sweeps and assemble() budget/degradation behavior. Split from engine-fidelity.test.ts.
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
describe("LcmContextEngine maintain and assemble budget", () => {
  it("assemble falls back to live messages on ambiguous runtime rollover while the old transcript still exists", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const firstSessionId = "assemble-ambiguous-rollover-old-runtime";
    const secondSessionId = "assemble-ambiguous-rollover-new-runtime";
    const sessionKey = "agent:main:test:assemble-ambiguous-runtime-rollover";

    const oldSessionFile = createSessionFilePath("assemble-ambiguous-rollover-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "what model produced the stale answer?" },
      { role: "assistant", content: "openai-codex/gpt-5.5" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    const liveMessages = [makeMessage({ role: "user", content: "new live user prompt" })];
    const assembled = await engine.assemble({
      sessionId: secondSessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget: 4_096,
    });

    expect(assembled.messages).toEqual(liveMessages);
    expect(
      assembled.messages.some((message) => message.content === "openai-codex/gpt-5.5"),
    ).toBe(false);
    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("ambiguous session-key runtime rollover")),
    ).toBe(true);
    const activeByKey = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeByKey?.conversationId).toBe(originalConversation!.conversationId);
    expect(activeByKey?.sessionId).toBe(firstSessionId);
    await expect(
      engine.getConversationStore().getConversationBySessionId(secondSessionId),
    ).resolves.toBeNull();
  });

  it("maintain() leaves deferred threshold debt pending until the host opts in", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-disabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });

    const compactSpy = vi.spyOn(engine, "compact");
    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-disabled-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: false,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
    expect(maintenanceResult.changed).toBe(false);
  });

  it("maintain() consumes deferred threshold debt when the host opts in", async () => {
    const engine = createEngineWithConfig({
      contextThresholdOverrides: [
        {
          match: { modelContextWindowMax: 250_000 },
          contextThreshold: 0.1,
        },
      ],
    });
    const sessionId = "maintain-deferred-compaction-enabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 500_000,
      currentTokenCount: 80_000,
      contextThreshold: 0.1,
      contextThresholdSource: "override",
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-enabled-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 500_000,
        currentTokenCount: 80_000,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 500_000,
        currentTokenCount: 80_000,
        compactionTarget: "threshold",
        contextThresholdOverride: expect.objectContaining({
          contextThreshold: 0.1,
          source: "override",
        }),
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(true);
  });

  it("maintain() clears stale legacy non-threshold debt when threshold no longer applies", async () => {
    const engine = createEngine();
    const sessionId = "maintain-legacy-leaf-debt-cleared";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 1_024,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-legacy-leaf-debt-cleared"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 1_024,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(evaluateSpy).toHaveBeenCalledWith(conversation.conversationId, 4_096, 1_024, {
      contextThreshold: 0.75,
    });
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(false);
    expect(maintenanceResult.reason).toBe("legacy deferred compaction no longer needed");
  });

  it("maintain() revalidates legacy non-threshold debt as threshold work when still over threshold", async () => {
    const engine = createEngine();
    const sessionId = "maintain-legacy-leaf-debt-threshold-revalidated";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "cold-cache-catchup",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-legacy-leaf-debt-threshold-revalidated"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
  });

  it("maintain() keeps threshold debt pending when compaction fails", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-auth-failure";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine, "executeCompactionCore").mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider auth failure",
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-auth-failure-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.retryAttempts).toBe(0);
    expect(maintenance?.nextAttemptAfter).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("provider auth failure");
  });

  it("maintain() keeps threshold debt pending when the auth circuit breaker is open", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-circuit-open";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine, "executeCompactionCore").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "circuit breaker open",
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-circuit-open"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("summary provider circuit breaker is open");
    expect(maintenance?.retryAttempts).toBe(0);
    expect(maintenance?.nextAttemptAfter).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("circuit breaker open");
  });

  it("maintain() backs off deferred threshold debt after non-auth compaction failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:00:00.000Z"));
    try {
      const engine = createEngine();
      const sessionId = "maintain-deferred-compaction-provider-timeout-backoff";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      });
      const privateEngine = engine as unknown as {
        executeCompactionCore: (params: unknown) => Promise<unknown>;
      };
      const executeSpy = vi.spyOn(privateEngine, "executeCompactionCore");
      executeSpy.mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "provider timeout",
      });
      executeSpy.mockResolvedValueOnce({
        ok: true,
        compacted: true,
        reason: "compacted",
      });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-provider-timeout-backoff"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(first.changed).toBe(false);
      expect(first.reason).toBe("provider timeout");
      expect(executeSpy).toHaveBeenCalledTimes(1);

      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-provider-timeout-backoff-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(executeSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      const third = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-provider-timeout-after-backoff"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(third.changed).toBe(true);
      expect(third.reason).toBe("compacted");
      expect(executeSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintain() keeps threshold debt pending when a no-action sweep stops at budget", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-no-action-budget-stop";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "compactFullSweep").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 3_500,
      tokensAfter: 3_500,
      condensed: false,
      stoppedAtBudget: true,
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-no-action-budget-stop"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("live context still exceeds target");
    expect(maintenance?.retryAttempts).toBe(1);
    expect(maintenance?.nextAttemptAfter).toBeInstanceOf(Date);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("live context still exceeds target");
  });

  it("maintain() keeps threshold debt pending when partial compaction remains over target", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-partial-still-over-threshold";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 3_500,
        tokensAfter: 3_200,
        condensed: false,
      });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-partial-still-over-threshold"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        tokenBudget: 4_096,
        force: true,
        hardTrigger: false,
        stopAtTokens: 1,
      }),
    );
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("compacted but still over target");
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("compacted but still over target");
  });

  it("maintain() backs off after partial deferred compaction still exceeds target", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:10:00.000Z"));
    try {
      const engine = createEngine();
      const sessionId = "maintain-deferred-partial-still-over-backoff";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      });
      const privateEngine = engine as unknown as {
        compaction: {
          compactFullSweep: (input: unknown) => Promise<unknown>;
        };
      };
      const compactFullSweepSpy = vi
        .spyOn(privateEngine.compaction, "compactFullSweep")
        .mockResolvedValue({
          actionTaken: true,
          tokensBefore: 3_500,
          tokensAfter: 3_200,
          condensed: false,
        });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-partial-over-backoff"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(first.changed).toBe(true);
      expect(first.reason).toBe("compacted but still over target");
      // The sweep chain retries once after the first partial round and stops
      // when the second round shows no further reduction.
      expect(compactFullSweepSpy).toHaveBeenCalledTimes(2);

      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-partial-over-backoff-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(compactFullSweepSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintain() stops model-backed deferred compaction at the summary call cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:20:00.000Z"));
    try {
      const complete = vi.fn(async () => ({
        content: [{ type: "text", text: "short summary" }],
      }));
      const engine = createEngineWithDeps(
        {
          summaryProvider: "anthropic",
          summaryModel: "claude-opus-4-5",
          summaryMaxCallsPerWindow: 1,
          summaryCallWindowMs: 10 * 60 * 1000,
          summarySpendBackoffMs: 20 * 60 * 1000,
        },
        { complete },
      );
      const sessionId = "maintain-summary-spend-call-cap";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      });
      const privateEngine = engine as unknown as {
        compaction: {
          compactFullSweep: (input: {
            summarize: (text: string, aggressive?: boolean) => Promise<string>;
          }) => Promise<unknown>;
        };
      };
      vi.spyOn(privateEngine.compaction, "compactFullSweep").mockImplementation(async (input) => {
        await input.summarize("first chunk ".repeat(200));
        await input.summarize("second chunk ".repeat(200));
        return {
          actionTaken: true,
          tokensBefore: 3_500,
          tokensAfter: 2_000,
          condensed: false,
        };
      });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-summary-spend-call-cap"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(first.changed).toBe(false);
      expect(first.reason).toBe("summary spend backoff open");
      expect(complete).toHaveBeenCalledTimes(1);

      const maintenance = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation.conversationId);
      expect(maintenance?.pending).toBe(true);
      expect(maintenance?.retryAttempts).toBe(1);
      expect(maintenance?.nextAttemptAfter?.toISOString()).toBe("2026-05-31T12:40:00.000Z");

      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-summary-spend-call-cap-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintain() bounds provider-fallback recursive sweeps with unlimited depth and repairable lineage", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:30:00.000Z"));
    try {
      const maxSweepIterations = 5;
      const complete = vi.fn(async (params: Parameters<LcmDependencies["complete"]>[0]) => {
        if (params.provider === "anthropic") {
          throw new Error("FallbackError: secondary summarizer unavailable");
        }
        throw new Error("FailoverError: ChatGPT prolite plan, try again in ~61 min");
      });
      const engine = createEngineWithDeps(
        {
          summaryProvider: "openai-codex",
          summaryModel: "gpt-5.3-codex",
          fallbackProviders: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
          sweepMaxDepth: -1,
          incrementalMaxDepth: -1,
          freshTailCount: 2,
          leafMinFanout: 2,
          condensedMinFanout: 2,
          condensedMinFanoutHard: 2,
          leafChunkTokens: 2_500,
          leafTargetTokens: 600,
          condensedTargetTokens: 900,
          summaryPrefixTargetTokens: 1,
          maxSweepIterations,
          sweepDeadlineMs: 1_000,
          summarySpendBackoffMs: 30 * 60 * 1000,
        },
        {
          complete,
          resolveModel: vi.fn((modelRef?: string, providerHint?: string) => {
            if (providerHint === "anthropic" || modelRef === "anthropic/claude-sonnet-4-6") {
              return { provider: "anthropic", model: "claude-sonnet-4-6" };
            }
            return { provider: "openai-codex", model: "gpt-5.3-codex" };
          }),
        },
      );
      const sessionId = "maintain-provider-fallback-unlimited-depth-repairable";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      const summaryStore = engine.getSummaryStore();
      await summaryStore.insertSummary({
        summaryId: "sum_provider_fallback_old_1",
        conversationId: conversation.conversationId,
        kind: "condensed",
        depth: 1,
        content: `old provider-stress arc 1 ${"a".repeat(3_600)}`,
        tokenCount: 1_000,
      });
      await summaryStore.insertSummary({
        summaryId: "sum_provider_fallback_old_2",
        conversationId: conversation.conversationId,
        kind: "condensed",
        depth: 1,
        content: `old provider-stress arc 2 ${"b".repeat(3_600)}`,
        tokenCount: 1_000,
      });
      await summaryStore.appendContextSummary(
        conversation.conversationId,
        "sum_provider_fallback_old_1",
      );
      await summaryStore.appendContextSummary(
        conversation.conversationId,
        "sum_provider_fallback_old_2",
      );
      const rawMessages = await engine.getConversationStore().createMessagesBulk(
        Array.from({ length: 6 }, (_, index) => ({
          conversationId: conversation.conversationId,
          seq: index + 1,
          role: index % 2 === 0 ? "user" as const : "assistant" as const,
          content: `provider stress turn ${index} ${"x".repeat(5_000)}`,
          tokenCount: 1_000,
          skipReplayTimestampFloodGuard: true,
        })),
      );
      await summaryStore.appendContextMessages(
        conversation.conversationId,
        rawMessages.map((message) => message.messageId),
      );
      const tokensBefore = await summaryStore.getContextTokenCount(conversation.conversationId);
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 9_000,
      });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-provider-fallback-unlimited-depth"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 9_000,
        },
      });

      expect(first.changed).toBe(true);
      expect(first.reason).toBe("compacted but still over target");
      expect(complete.mock.calls.length).toBeGreaterThan(0);
      expect(complete.mock.calls.length).toBeLessThanOrEqual(maxSweepIterations * 2);
      const calledProviders = new Set(
        complete.mock.calls.map(([params]) => params.provider ?? ""),
      );
      expect(calledProviders).toEqual(new Set(["openai-codex", "anthropic"]));

      const maintenance = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation.conversationId);
      expect(maintenance?.pending).toBe(true);
      expect(maintenance?.running).toBe(false);
      expect(maintenance?.lastFailureSummary).toBe("compacted but still over target");
      expect(maintenance?.nextAttemptAfter?.toISOString()).toBe("2026-05-31T13:00:00.000Z");

      const afterFirstCallCount = complete.mock.calls.length;
      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-provider-fallback-unlimited-depth-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 9_000,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(complete).toHaveBeenCalledTimes(afterFirstCallCount);

      const summaries = await summaryStore.getSummariesByConversation(conversation.conversationId);
      const markerSummaries = summaries.filter(
        (summary) => detectDoctorMarker(summary.content) !== null,
      );
      const markerLeaves = markerSummaries.filter((summary) => summary.kind === "leaf");
      const markerCondensed = markerSummaries.filter((summary) => summary.kind === "condensed");
      expect(markerLeaves.length).toBeGreaterThan(0);
      expect(markerCondensed.length).toBeGreaterThan(0);

      const contextItems = await summaryStore.getContextItems(conversation.conversationId);
      expect(contextItems.length).toBeGreaterThan(1);
      expect(contextItems.filter((item) => item.itemType === "message")).toHaveLength(2);
      expect(contextItems.filter((item) => item.itemType === "summary")).not.toHaveLength(1);

      const reachableSummaryIds = new Set<string>();
      const collectReachableSummaryIds = async (summaryId: string): Promise<void> => {
        if (reachableSummaryIds.has(summaryId)) {
          return;
        }
        reachableSummaryIds.add(summaryId);
        for (const parent of await summaryStore.getSummaryParents(summaryId)) {
          await collectReachableSummaryIds(parent.summaryId);
        }
      };
      for (const item of contextItems) {
        if (item.itemType === "summary" && item.summaryId != null) {
          await collectReachableSummaryIds(item.summaryId);
        }
      }
      expect(reachableSummaryIds).toContain("sum_provider_fallback_old_1");
      expect(reachableSummaryIds).toContain("sum_provider_fallback_old_2");

      for (const summary of markerLeaves) {
        expect(await summaryStore.getSummaryMessages(summary.summaryId)).not.toHaveLength(0);
      }
      for (const summary of markerCondensed) {
        expect(await summaryStore.getSummaryParents(summary.summaryId)).not.toHaveLength(0);
      }
      const tokensAfter = await summaryStore.getContextTokenCount(conversation.conversationId);
      expect(Number.isFinite(tokensAfter)).toBe(true);
      expect(tokensAfter).toBeLessThanOrEqual(tokensBefore);

      const privateEngine = engine as unknown as { db: Parameters<typeof applyScopedDoctorRepair>[0]["db"] };
      const repairSummarize = vi.fn(async (
        text: string,
        _aggressive?: boolean,
        options?: Parameters<NonNullable<Parameters<typeof applyScopedDoctorRepair>[0]["summarize"]>>[2],
      ) => {
        if (options?.isCondensed) {
          return `CONDENSED REPAIR\n${text}`;
        }
        return `LEAF REPAIR\n${text}`;
      });
      const repairResult = await applyScopedDoctorRepair({
        db: privateEngine.db,
        config: getEngineConfig(engine),
        conversationId: conversation.conversationId,
        summarize: repairSummarize,
      });
      expect(repairResult.kind).toBe("applied");
      if (repairResult.kind !== "applied") {
        throw new Error(`expected doctor repair to apply: ${repairResult.reason}`);
      }
      expect(repairResult.detected).toBe(markerSummaries.length);
      expect(repairResult.repaired).toBe(markerSummaries.length);
      expect(repairResult.skipped).toEqual([]);
      expect(repairSummarize).toHaveBeenCalledTimes(markerSummaries.length);

      const condensedRepairCalls = repairSummarize.mock.calls.filter(
        ([, , options]) => options?.isCondensed === true,
      );
      expect(
        repairSummarize.mock.calls.some(
          ([text, , options]) =>
            options?.isCondensed !== true &&
            text.includes("provider stress turn 0"),
        ),
      ).toBe(true);
      expect(
        condensedRepairCalls.some(
          ([text]) =>
            text.includes("old provider-stress arc 1") &&
            text.includes("old provider-stress arc 2"),
        ),
      ).toBe(true);

      const repairedSummaries = await summaryStore.getSummariesByConversation(conversation.conversationId);
      expect(repairedSummaries.every((summary) => detectDoctorMarker(summary.content) === null)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("assemble() leaves pending threshold debt for post-turn maintenance while under budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-left-pending";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() uses bounded live context when pending maintenance is near budget", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-near-budget-degrades";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const [storedMessage] = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "stored context should be skipped while maintenance is pending",
        tokenCount: 20,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, [storedMessage.messageId]);
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 100,
      currentTokenCount: 90,
    });
    const executeCompactionCoreSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "current delivery turn" })],
      tokenBudget: 100,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(true);
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "current delivery turn",
    ]);
    expect(assembleResult.estimatedTokens).toBeLessThanOrEqual(100);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reason=near-budget"));
  });

  it("assemble() intercepts large tool results in live messages before degraded fallback", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        largeFileTokenThreshold: 20,
        stubLargeToolPayloads: true,
        largeFilesDir,
      },
      { log },
    );
    const sessionId = "assemble-intercepts-large-tool-results-before-degraded";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const [storedMessage] = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "stored content",
        tokenCount: 20,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, [storedMessage.messageId]);
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 100,
      currentTokenCount: 90,
    });

    const largeToolContent = "tool output. ".repeat(200); // well above 20-token threshold
    const liveMessages = [
      makeMessage({ role: "user", content: "current turn" }),
      makeMessage({
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "exec", input: {} }],
      }),
      makeMessage({
        role: "toolResult",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            output: largeToolContent,
          },
        ],
      }),
    ];
    const originalLiveMessages = structuredClone(liveMessages);
    const assembleResult = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 100,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    // The tool result should have been intercepted and replaced with a
    // [LCM Tool Output: …] stub; the output field should reference the
    // externalized file, not contain the raw content.
    const hasStub = assembleResult.messages.some((msg) => {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return text.includes("[LCM Tool Output: file_")
        && text.includes("externalizedFileId");
    });
    expect(hasStub).toBe(true);
    expect(liveMessages).toEqual(originalLiveMessages);

    const firstLargeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation.conversationId);
    expect(firstLargeFiles).toHaveLength(1);

    const secondAssembleResult = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 100,
    });
    const secondHasStub = secondAssembleResult.messages.some((msg) => {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return text.includes(`[LCM Tool Output: ${firstLargeFiles[0]!.fileId}`)
        && text.includes("externalizedFileId");
    });
    expect(secondHasStub).toBe(true);
    await expect(
      engine.getSummaryStore().getLargeFilesByConversation(conversation.conversationId),
    ).resolves.toHaveLength(1);
  });

  it("assemble() clears exhausted threshold debt and preserves leading system context via degraded fallback (#639 Mode 2)", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const sessionId = "assemble-degraded-preserves-system";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 30,
      currentTokenCount: 29,
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [
        makeMessage({ role: "system", content: "critical runtime policy" }),
        makeMessage({ role: "user", content: "current delivery turn" }),
      ],
      tokenBudget: 10,
    });

    // #639 Mode 2: exhausted threshold debt (empty conversation -> nothing to
    // compact) is now CLEARED rather than left pending. Because this drain
    // happens during an already-over-budget assemble call, the current turn still
    // uses the degraded fallback instead of returning raw live messages.
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "critical runtime policy",
      "current delivery turn",
    ]);
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=emergency-debt-exhausted"),
    );
  });

  it("assemble() bounds live context when emergency debt drain reaches exhaustion", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const sessionId = "assemble-exhausted-emergency-debt-bounds-live";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 30,
      currentTokenCount: 500,
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [
        makeMessage({ role: "user", content: "oversized historical live turn ".repeat(100) }),
        makeMessage({ role: "user", content: "current delivery turn" }),
      ],
      tokenBudget: 10,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "current delivery turn",
    ]);
    // The single kept message exceeds the tiny budget; the estimate is the
    // honest serialized size of what was returned.
    expect(assembleResult.estimatedTokens).toBe(
      estimateSerializedMessagesTokens(assembleResult.messages),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=emergency-debt-exhausted"),
    );
  });

  it("assemble() degrades to bounded live context if emergency compaction leaves debt pending", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-emergency-failed-degrades";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const [storedMessage] = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "stored context should not be used after failed emergency compaction",
        tokenCount: 20,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, [storedMessage.messageId]);
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 100,
      currentTokenCount: 150,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider timeout",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "current emergency turn" })],
      tokenBudget: 100,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 100,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.lastFailureSummary).toBe("provider timeout");
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "current emergency turn",
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[lcm] assemble: emergency deferred compaction debt draining pre-assembly",
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=emergency-debt-still-pending"),
    );
  });

  it("assemble() drains pending threshold debt as an emergency when already over budget", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 10,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[lcm] assemble: emergency deferred compaction debt draining pre-assembly",
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reason=over-budget"));
  });

  it("assemble() drains pending threshold debt when recorded runtime tokens are over budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-runtime-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 5_000,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() uses projected deferred pressure for emergency drain without passing it as observed tokens", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-projected-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 300,
      projectedTokenCount: 5_000,
      rawTokensOutsideTail: 4_700,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 300,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() does not wait for the session queue when deferred threshold debt is not urgent", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      consumeDeferredCompactionDebt: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-not-urgent";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    const consumeSpy = vi.spyOn(privateEngine, "consumeDeferredCompactionDebt");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });

    let assembleSettled = false;
    const assemblePromise = engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    }).then((result) => {
      assembleSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleSettled).toBe(true);

    releaseQueue();
    await heldQueue;
    const assembleResult = await assemblePromise;

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() waits for the session queue before emergency deferred threshold compaction", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      consumeDeferredCompactionDebt: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-queued";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    const consumeSpy = vi.spyOn(privateEngine, "consumeDeferredCompactionDebt");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });

    let assembleSettled = false;
    const assemblePromise = engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    }).then((result) => {
      assembleSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleSettled).toBe(false);

    releaseQueue();
    await heldQueue;
    const assembleResult = await assemblePromise;

    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() degrades instead of spending during active deferred retry backoff", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-backoff-degrades";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: "provider timeout",
      keepPending: true,
    });
    const executeSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(assembleResult.messages).toHaveLength(1);
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
  });

  it("maintain() uses the stricter current token budget for deferred threshold debt", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "maintain-deferred-compaction-current-budget";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });

    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "already under target",
    });

    await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-current-budget"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 2_048,
      },
    });

    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 2_048,
      }),
    );
  });
});
