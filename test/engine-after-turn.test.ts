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
  it("afterTurn ingests auto-compaction summary and new turn messages", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-ingest";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-ingest"),
      messages: [
        makeMessage({ role: "user", content: "already present before prompt" }),
        makeMessage({ role: "assistant", content: "new assistant reply" }),
      ],
      prePromptMessageCount: 1,
      autoCompactionSummary: "[summary] compacted older history",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[summary] compacted older history",
      "new assistant reply",
    ]);
  });

  it("afterTurn keeps auto-compaction summary that matches stored text", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-same-as-stored";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "S" }),
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-same-as-stored"),
      messages: [
        makeMessage({ role: "assistant", content: "fresh assistant reply" }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: "S",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "S",
      "S",
      "fresh assistant reply",
    ]);
  });

  it("afterTurn deduplicates replayed history before prepending auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-replay";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-replay-seed"),
      messages: [
        makeMessage({ role: "user", content: "old question" }),
        makeMessage({ role: "assistant", content: "old answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-replay"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
        makeMessage({ role: "user", content: "old question" }),
        makeMessage({ role: "assistant", content: "old answer" }),
        makeMessage({ role: "user", content: "new question" }),
        makeMessage({ role: "assistant", content: "new answer" }),
      ],
      prePromptMessageCount: 1,
      autoCompactionSummary: "[summary] compacted older history",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old question",
      "old answer",
      "[summary] compacted older history",
      "new question",
      "new answer",
    ]);
  });

  it("afterTurn skips new-message content already covered by auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-overlap";
    const repeatedInstruction =
      "kick off workers to review all of these pull requests and report back";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-overlap"),
      messages: [
        makeMessage({ role: "user", content: repeatedInstruction }),
        makeMessage({ role: "assistant", content: "Workers are running now." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: `Summary of compacted context: the user said "${repeatedInstruction}" and the assistant began coordinating the work.`,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      `Summary of compacted context: the user said "${repeatedInstruction}" and the assistant began coordinating the work.`,
      "Workers are running now.",
    ]);
  });

  it("afterTurn does not drop short messages just because they appear in auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-short-overlap";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-short-overlap"),
      messages: [
        makeMessage({ role: "user", content: "yes" }),
        makeMessage({ role: "assistant", content: "Proceeding." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: "Summary: the user previously said yes to the plan.",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "Summary: the user previously said yes to the plan.",
      "yes",
      "Proceeding.",
    ]);
  });

  it("afterTurn keeps a 24+ char user message that only collides as a substring of the summary narrative (F6)", async () => {
    // PR-6 #566 / F6: bare summary.includes(content) was too loose. A medium-
    // length user instruction that coincidentally appears inside a long
    // narrative summary must NOT be silently dropped — only anchored or
    // quoted matches count as covered.
    const engine = createEngine();
    const sessionId = "after-turn-summary-substring-collision";
    const collidingInstruction = "please update the readme file"; // 30 chars
    const summary =
      "Summary of compacted context: the assistant was asked to please " +
      "update the readme file with new sections, then verify CI passes " +
      "and report back to the operator before EOD.";
    expect(summary.toLowerCase()).toContain(collidingInstruction);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-substring-collision"),
      messages: [
        makeMessage({ role: "user", content: collidingInstruction }),
        makeMessage({ role: "assistant", content: "Acknowledged." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: summary,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    // The user instruction must survive: it's only a coincidental substring,
    // not anchored or quoted.
    expect(stored.map((message) => message.content)).toEqual([
      summary,
      collidingInstruction,
      "Acknowledged.",
    ]);
  });

  it("afterTurn drops a user message when the summary ends with that exact content (F6 anchored)", async () => {
    // Anchored truth case: content appears at the end of the summary's
    // normalized text — that's a real coverage signal, drop the dup.
    const engine = createEngine();
    const sessionId = "after-turn-summary-suffix-anchored";
    const repeatedInstruction = "kick off the workers and check back in an hour";
    const summary = `Summary of compacted context. ${repeatedInstruction}`;

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-suffix-anchored"),
      messages: [
        makeMessage({ role: "user", content: repeatedInstruction }),
        makeMessage({ role: "assistant", content: "On it." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: summary,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([summary, "On it."]);
  });

  it("afterTurn runs inline threshold compaction only after context threshold is crossed", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compact";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const leafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger");
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
      result: {
        tokensBefore: 3_500,
        tokensAfter: 2_000,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-inline-threshold-compact"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(leafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
  });

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

  it("afterTurn ignores raw leaf pressure below the context threshold", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-below-threshold-ignores-leaf-pressure";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };

    const leafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger");
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 20_000,
      threshold: 96_000,
    });
    const scheduleSpy = vi.spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain");
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-below-threshold-ignores-leaf-pressure"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: { currentTokenCount: 20_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(leafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending ?? false).toBe(false);
  });

  it("afterTurn resolves tokenBudget from runtimeContext and forwards it as legacyParams", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-runtime-context";
    const runtimeContext = {
      provider: "anthropic",
      model: "claude-opus-4-5",
      tokenBudget: 2048,
      currentTokenCount: 1800,
    };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 1800,
      threshold: 1536,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-context"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      runtimeContext,
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 2048,
        currentTokenCount: 1800,
        legacyParams: runtimeContext,
        compactionTarget: "threshold",
      }),
    );
  });

  it("afterTurn keeps the bootstrap checkpoint stale and records retry debt when inline threshold compaction fails", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compaction-failure";
    const sessionFile = createSessionFilePath("after-turn-inline-threshold-compaction-failure");
    writeFileSync(sessionFile, "0123456789\n");

    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const sessionFileStats = statSync(sessionFile);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 1,
      lastSeenMtimeMs: Math.trunc(sessionFileStats.mtimeMs),
      lastProcessedOffset: 1,
      lastProcessedEntryHash: null,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider auth failure",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation.conversationId);
    expect(bootstrapState).not.toBeNull();
    expect(bootstrapState?.lastSeenSize).toBe(1);
    expect(bootstrapState?.lastProcessedOffset).toBe(1);

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("threshold");
    expect(maintenance?.tokenBudget).toBe(4_096);
    expect(compactSpy).toHaveBeenCalled();
  });

  it("afterTurn waits for inline threshold compaction before completing", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compaction-queue-order";
    const sessionFile = createSessionFilePath("after-turn-inline-threshold-compaction-queue-order");
    writeFileSync(sessionFile, "0123456789\n");

    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const sessionFileStats = statSync(sessionFile);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 1,
      lastSeenMtimeMs: Math.trunc(sessionFileStats.mtimeMs),
      lastProcessedOffset: 1,
      lastProcessedEntryHash: null,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });

    let releaseCompaction!: () => void;
    let notifyCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      notifyCompactionStarted = resolve;
    });
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });

    vi.spyOn(engine, "compact").mockImplementation(async () => {
      notifyCompactionStarted();
      await compactionGate;
      return {
        ok: false,
        compacted: false,
        reason: "provider auth failure",
      };
    });

    const afterTurnPromise = engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    await compactionStarted;

    let afterTurnResolved = false;
    afterTurnPromise.then(() => {
      afterTurnResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(afterTurnResolved).toBe(false);

    releaseCompaction();

    await afterTurnPromise;
    expect(afterTurnResolved).toBe(true);

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
  });

  it("afterTurn falls back to the default token budget when no budget is provided", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {
        proactiveThresholdCompactionMode: "inline",
      },
      {
        log: {
          info: vi.fn(),
          warn: warnLog,
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "after-turn-default-token-budget";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 100_000,
      threshold: 96_000,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-default-token-budget"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      runtimeContext: { currentTokenCount: 100_000 },
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 128_000,
        compactionTarget: "threshold",
      }),
    );
    expect(warnLog).toHaveBeenCalledWith(
      "[lcm] afterTurn: tokenBudget not provided; using default 128000",
    );
  });

  it("afterTurn falls back to legacyCompactionParams when runtimeContext is missing", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-legacy-compaction-params";
    const legacyCompactionParams = { provider: "anthropic", model: "claude-opus-4-5" };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-legacy-compaction-params"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      legacyCompactionParams,
      currentTokenCount: 3_500,
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyParams: legacyCompactionParams,
      }),
    );
  });

  it("afterTurn prefers runtimeContext when both runtimeContext and legacyCompactionParams are set", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-runtime-context-priority";
    const runtimeContext = { provider: "anthropic", model: "claude-opus-4-5", source: "rt" };
    const legacyCompactionParams = {
      provider: "anthropic",
      model: "claude-opus-4-5",
      source: "legacy",
    };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-context-priority"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      runtimeContext,
      legacyCompactionParams,
    });

    expect((compactSpy.mock.calls[0]?.[0] as { legacyParams?: unknown }).legacyParams).toBe(
      runtimeContext,
    );
  });

  it("afterTurn prefers runtimeContext.currentTokenCount for compaction decisions", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-runtime-current-token-count";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-current-token-count"),
      messages: [makeMessage({ role: "assistant", content: "tiny" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: {
        provider: "openai",
        model: "gpt-5.4",
        currentTokenCount: 500,
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 4_096, 500, {
      contextThreshold: 0.75,
    });
  });

  it("afterTurn falls back to local message token estimates when runtimeContext.currentTokenCount is absent", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-local-current-token-count-fallback";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 1,
      threshold: 3_072,
    });

    const turnMessage = makeMessage({ role: "assistant", content: "tiny" });
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-local-current-token-count-fallback"),
      messages: [turnMessage],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    // Local estimates use full-message serialization so structured payloads count.
    expect(evaluateSpy).toHaveBeenCalledWith(
      expect.any(Number),
      4_096,
      estimateSerializedMessageTokens(turnMessage),
      { contextThreshold: 0.75 },
    );
  });

  it("afterTurn records deferred threshold debt instead of compacting inline by default", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    const sessionId = "after-turn-deferred-compaction-debt";
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-compaction-debt"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reason: "threshold",
        tokenBudget: 4_096,
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("threshold");
    expect(maintenance?.requestedAt).toBeInstanceOf(Date);
  });

  it("afterTurn evaluates threshold compaction when ingestBatch is empty", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-empty-ingest-still-evaluates-compaction";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      batchDeduplicator: {
        deduplicateAfterTurnBatch: (
          sessionId: string,
          sessionKey: string | undefined,
          messages: AgentMessage[],
          opts: unknown,
        ) => Promise<AgentMessage[]>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed message" }),
    });
    vi.spyOn(engine.getBatchDeduplicator(), "deduplicateAfterTurnBatch").mockResolvedValue([]);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 200_000,
      threshold: 180_000,
    });
    vi.spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain").mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-empty-ingest-still-evaluates-compaction"),
      messages: [
        makeMessage({ role: "user", content: "already-stored user message" }),
        makeMessage({ role: "assistant", content: "already-stored assistant reply" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 258_000,
      runtimeContext: { currentTokenCount: 200_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("afterTurn skips compaction work when ingestBatch is empty AND conversation is below threshold", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-empty-ingest-below-threshold-noop";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      batchDeduplicator: {
        deduplicateAfterTurnBatch: (
          sessionId: string,
          sessionKey: string | undefined,
          messages: AgentMessage[],
          opts: unknown,
        ) => Promise<AgentMessage[]>;
      };
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed message" }),
    });
    vi.spyOn(engine.getBatchDeduplicator(), "deduplicateAfterTurnBatch").mockResolvedValue([]);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 30_000,
      threshold: 180_000,
    });
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-empty-ingest-below-threshold-noop"),
      messages: [makeMessage({ role: "assistant", content: "already-stored" })],
      prePromptMessageCount: 0,
      tokenBudget: 258_000,
      runtimeContext: { currentTokenCount: 30_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending ?? false).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("afterTurn does not use tokenBudget as a model context-window override fallback", async () => {
    const engine = createEngineWithConfig({
      contextThresholdOverrides: [
        {
          match: { modelContextWindowMax: 250_000 },
          contextThreshold: 0.1,
        },
      ],
    });
    const sessionId = "after-turn-window-override-requires-explicit-window";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
          options?: { contextThreshold?: number },
        ) => Promise<unknown>;
      };
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 50_000,
      threshold: 150_000,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-window-override-requires-explicit-window"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 200_000,
      runtimeContext: {
        currentTokenCount: 50_000,
        provider: "openai",
        model: "gpt-5.5",
      },
    });

    // No explicit window metadata: the window rule must not match, so the
    // resolved threshold falls back to the global 0.75 default.
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 200_000, 50_000, {
      contextThreshold: 0.75,
    });
  });

  it("afterTurn falls back to legacy model context-window metadata for threshold overrides", async () => {
    const engine = createEngineWithConfig({
      contextThresholdOverrides: [
        {
          match: { modelContextWindowMax: 250_000 },
          contextThreshold: 0.1,
        },
      ],
    });
    const sessionId = "after-turn-window-override-legacy-metadata";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
          options?: { contextThreshold?: number },
        ) => Promise<unknown>;
      };
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 80_000,
      threshold: 50_000,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-window-override-legacy-metadata"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 500_000,
      runtimeContext: {
        currentTokenCount: 80_000,
      },
      legacyCompactionParams: {
        modelContextWindow: 200_000,
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 500_000, 80_000, {
      contextThreshold: 0.1,
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).toMatchObject({
      pending: true,
      contextThreshold: 0.1,
      contextThresholdSource: "override",
    });
  });

  it("afterTurn forwards legacy-only resolved threshold overrides into inline compaction", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
      contextThresholdOverrides: [
        {
          match: { modelContextWindowMax: 250_000 },
          contextThreshold: 0.1,
        },
      ],
    });
    const sessionId = "after-turn-inline-threshold-override-legacy-metadata";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
          options?: { contextThreshold?: number },
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 80_000,
      threshold: 50_000,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-inline-threshold-override-legacy-metadata"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 500_000,
      runtimeContext: {
        currentTokenCount: 80_000,
      },
      legacyCompactionParams: {
        modelContextWindow: 200_000,
      },
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        compactionTarget: "threshold",
        contextThresholdOverride: expect.objectContaining({
          contextThreshold: 0.1,
          source: "override",
        }),
      }),
    );
  });

  it("afterTurn schedules a deferred threshold drain even when compactionTelemetry has no provider/model", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-no-cache-context-threshold";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-no-cache-context-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reason: "threshold",
        tokenBudget: 4_096,
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
  });

  it("afterTurn caps the transcript-reconcile slow path to one full re-read per session+file (F7)", async () => {
    // PR-6 #566 / F7: PR #551 added reconcileTranscriptTailForAfterTurn but
    // its slow path called readLeafPathMessages on the entire session file
    // every afterTurn when the checkpoint was missing or path-mismatched.
    // After PR-6: the slow path runs once per (session-key|id, sessionFile),
    // refreshes the checkpoint, and subsequent afterTurns take the
    // incremental path or the cap branch.
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: infoLog, warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-reconcile-slow-path-cap";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    // Seed conversation by ingesting one turn through afterTurn first, with
    // a DIFFERENT sessionFile so the next call has a path-mismatched
    // checkpoint and is forced into the slow path.
    const seedSessionFile = createSessionFilePath("after-turn-reconcile-slow-path-seed");
    writeLeafTranscript(seedSessionFile, [{ role: "assistant", content: "seed turn" }]);
    await engine.afterTurn({
      sessionId,
      sessionFile: seedSessionFile,
      messages: [makeMessage({ role: "assistant", content: "seed turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Spy on the (module-scoped) full reader by spying on the slow-path
    // log, since readLeafPathMessages is a free function. The slow-path warn
    // is the canonical signal that the full re-read happened.
    warnLog.mockClear();
    debugLog.mockClear();

    // First call with a different sessionFile triggers the slow path.
    // Pre-populate the target sessionFile with at least one historical
    // overlapping message so readLeafPathMessages returns a successful
    // same-frontier full read and the slow-path cap can be remembered.
    const targetSessionFile = createSessionFilePath("after-turn-reconcile-slow-path-target");
    writeLeafTranscript(targetSessionFile, [{ role: "assistant", content: "seed turn" }]);
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn one" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const slowPathWarns = warnLog.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("transcript reconcile slow path"));
    expect(slowPathWarns.length).toBe(1);

    // Second call against the SAME (sessionId, sessionFile) tuple must NOT
    // re-enter the slow path. After the first slow-path read we refresh the
    // checkpoint, so this normally goes through the fast (incremental) path
    // and emits no slow-path warn. If somehow the slow path is reached again
    // (e.g. checkpoint not append-only-eligible), the cap log fires instead
    // of a second full re-read.
    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn two" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const secondSlowPathWarns = warnLog.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("transcript reconcile slow path (full re-read)"));
    expect(secondSlowPathWarns.length).toBe(0);
  });

  it("afterTurn treats missing tracked transcripts as a cheap degraded path without full reread", async () => {
    const warnLog = vi.fn();
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: debugLog },
      },
    );
    const sessionId = "after-turn-missing-transcript-cheap-skip";
    const sessionKey = "agent:main:test:missing-transcript-cheap-skip";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey,
    });
    const bulkMessages = await engine.getConversationStore().createMessagesBulk(
      Array.from({ length: 120 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `persisted historical message ${index}`,
        tokenCount: 5,
        skipReplayTimestampFloodGuard: true,
      })),
    );
    await engine
      .getSummaryStore()
      .appendContextMessages(
        conversation.conversationId,
        bulkMessages.map((message) => message.messageId),
      );
    const missingSessionFile = createSessionFilePath("after-turn-missing-transcript-cheap-skip");
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
        makeMessage({ role: "assistant", content: "persisted historical message 119" }),
        makeMessage({ role: "user", content: "live user after missing transcript" }),
        makeMessage({ role: "assistant", content: "live assistant after missing transcript" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    expect(stored.slice(-2).map((message) => message.content)).toEqual([
      "live user after missing transcript",
      "live assistant after missing transcript",
    ]);
    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation.conversationId);
    expect(checkpoint).toMatchObject({
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("session file missing; skipping transcript reconcile full reread")),
    ).toBe(true);
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toBe(false);
  });

  it("afterTurn recovers a checkpoint-missing conversation with a non-anchoring frontier instead of looping forever (#837)", async () => {
    // #837: a conversation with bootstrapped_at set but NO
    // conversation_bootstrap_state row classifies as reason="checkpoint-missing"
    // on the afterTurn slow path. Unlike the rotate lane, afterTurn used to call
    // reconcileSessionTail WITHOUT allowNoAnchorImportOnCheckpointMissing, so a
    // DB frontier of only non-anchoring rows (e.g. an injected metadata
    // preamble) imported 0 messages and never persisted a checkpoint. Net
    // effect: every turn emitted "found no anchor and imported 0 messages" +
    // "did not cover the transcript frontier" forever, compaction never ran, and
    // the conversation was a permanent LCM no-op until manually archived.
    //
    // This is the sibling of the #649 follow-up above: there the transcript
    // could not be stat/read (ENOENT) and the placeholder-seed escape hatch
    // fired; here the transcript EXISTS with real content, so stat/read succeeds
    // and the only escape is to let afterTurn import the no-anchor epoch the same
    // way the rotate lane already does.
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-checkpoint-missing-no-anchor-recovery";
    const sessionKey = "agent:main:test:checkpoint-missing-no-anchor-recovery";

    // Build the exact production shape: a single non-anchoring DB frontier row
    // (the injected metadata preamble), bootstrapped_at set, and NO
    // bootstrap_state row.
    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({
        role: "user",
        content: "Conversation info (untrusted metadata): injected preamble",
      }),
    });
    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    await engine
      .getConversationStore()
      .markConversationBootstrapped(conversation!.conversationId);

    const refreshed = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(refreshed?.bootstrappedAt).toBeTruthy();
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();

    // A real, growing transcript whose messages do NOT anchor to the lone
    // injected preamble row in the DB.
    const sessionFile = createSessionFilePath("after-turn-checkpoint-missing-no-anchor");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "CRABPOT_837_FACT is amber-beacon-7." },
      { role: "assistant", content: "noted the fact" },
      { role: "user", content: "follow-up question" },
      { role: "assistant", content: "follow-up answer" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "follow-up question" }),
        makeMessage({ role: "assistant", content: "follow-up answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Recovery, not deadlock: the transcript history is imported and a
    // bootstrap_state checkpoint is persisted so future turns advance.
    const recoveredState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(recoveredState).not.toBeNull();
    expect(recoveredState?.sessionFilePath).toBe(sessionFile);
    expect(recoveredState?.lastProcessedOffset).toBeGreaterThan(0);

    const contents = (
      await engine.getConversationStore().getMessages(conversation!.conversationId)
    ).map((m) => m.content);
    expect(contents).toContain("CRABPOT_837_FACT is amber-beacon-7.");
    expect(contents).toContain("follow-up answer");

    // The forever-loop warning pair must NOT have fired.
    const warns = warnLog.mock.calls.map((c) => String(c[0]));
    expect(
      warns.some((m) => m.includes("did not cover the transcript frontier")),
    ).toBe(false);
    expect(
      warns.some((m) =>
        m.includes("found no anchor and imported 0 messages; skipping checkpoint refresh"),
      ),
    ).toBe(false);

    // A second ordinary turn must keep advancing on the fast path (no relapse
    // into the checkpoint-missing slow-path loop).
    warnLog.mockClear();
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "CRABPOT_837_FACT is amber-beacon-7." },
      { role: "assistant", content: "noted the fact" },
      { role: "user", content: "follow-up question" },
      { role: "assistant", content: "follow-up answer" },
      { role: "user", content: "third turn user" },
      { role: "assistant", content: "third turn assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "third turn assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const secondWarns = warnLog.mock.calls.map((c) => String(c[0]));
    expect(
      secondWarns.some((m) => m.includes("did not cover the transcript frontier")),
    ).toBe(false);
    const finalContents = (
      await engine.getConversationStore().getMessages(conversation!.conversationId)
    ).map((m) => m.content);
    expect(finalContents).toContain("third turn assistant");
  });

  it("afterTurn does not recover checkpoint-missing delivery-only transcript traffic", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-checkpoint-missing-delivery-only";
    const sessionKey = "agent:main:signal:checkpoint-missing-delivery-only";

    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({
        role: "user",
        content: "Conversation info (untrusted metadata): injected preamble",
      }),
    });
    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    await engine
      .getConversationStore()
      .markConversationBootstrapped(conversation!.conversationId);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();

    const sessionFile = createSessionFilePath("after-turn-checkpoint-missing-delivery-only");
    writeLeafTranscript(sessionFile, [
      { role: "system", content: "delivery-mirror config-audit: refreshed host policy" },
      { role: "system", content: "config-audit delivery-mirror: no user turn" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "assistant", content: "assistant delta without foreground user" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("delivery-only path-mismatched transcript")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "Conversation info (untrusted metadata): injected preamble",
    ]);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();
  });

  it("afterTurn does not recover checkpoint-missing transcript traffic from another runtime session", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const firstSessionId = "after-turn-checkpoint-missing-rollover-old-runtime";
    const secondSessionId = "after-turn-checkpoint-missing-rollover-new-runtime";
    const sessionKey = "agent:main:test:checkpoint-missing-runtime-rollover";

    const oldSessionFile = createSessionFilePath("after-turn-checkpoint-missing-rollover-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old checkpoint-missing rollover question" },
      { role: "assistant", content: "old checkpoint-missing rollover answer" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation?.bootstrappedAt).toBeTruthy();

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const newSessionFile = createSessionFilePath("after-turn-checkpoint-missing-rollover-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new unrelated checkpoint-missing runtime question" },
      { role: "assistant", content: "new unrelated checkpoint-missing runtime answer" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({
          role: "assistant",
          content: "new unrelated checkpoint-missing runtime answer",
        }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("did not cover the transcript frontier")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old checkpoint-missing rollover question",
      "old checkpoint-missing rollover answer",
    ]);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();
    await expect(
      engine.getConversationStore().getConversationBySessionId(secondSessionId),
    ).resolves.toBeNull();
  });

  it("afterTurn does not recover checkpoint-missing divergent transcript over real history", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-checkpoint-missing-real-history";
    const sessionKey = "agent:main:test:checkpoint-missing-real-history";

    const oldSessionFile = createSessionFilePath("after-turn-checkpoint-missing-real-history-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old checkpoint-missing real-history question" },
      { role: "assistant", content: "old checkpoint-missing real-history answer" },
    ]);
    await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation?.bootstrappedAt).toBeTruthy();

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "rewritten unrelated checkpoint-missing question" },
      { role: "assistant", content: "rewritten unrelated checkpoint-missing answer" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({
          role: "assistant",
          content: "rewritten unrelated checkpoint-missing answer",
        }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("did not cover the transcript frontier")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old checkpoint-missing real-history question",
      "old checkpoint-missing real-history answer",
    ]);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();
  });

  it("afterTurn fails closed on ambiguous runtime rollover while the old transcript still exists", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    const evaluateLeafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "above threshold",
      currentTokens: 10_000,
      threshold: 3_072,
      projectedTokens: 10_000,
      rawTokensOutsideTail: 6_000,
    });
    const firstSessionId = "after-turn-ambiguous-rollover-old-runtime";
    const secondSessionId = "after-turn-ambiguous-rollover-new-runtime";
    const sessionKey = "agent:main:test:after-turn-ambiguous-runtime-rollover";

    const oldSessionFile = createSessionFilePath("after-turn-ambiguous-rollover-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old afterTurn long-lived question" },
      { role: "assistant", content: "Done" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("after-turn-ambiguous-rollover-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new afterTurn unrelated first turn" },
      { role: "assistant", content: "Done" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "Done" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("ambiguous session-key runtime rollover")),
    ).toBe(true);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old afterTurn long-lived question",
      "Done",
    ]);
    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint).toEqual(oldCheckpoint);
    const activeByKey = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeByKey?.conversationId).toBe(conversation!.conversationId);
    expect(activeByKey?.sessionId).toBe(firstSessionId);
    await expect(
      engine.getConversationStore().getConversationBySessionId(secondSessionId),
    ).resolves.toBeNull();
    await expect(
      engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation!.conversationId),
    ).resolves.toBeNull();
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it("afterTurn reconciles a path-mismatched no-anchor transcript before oversized delta dedup", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-transcript-epoch-no-anchor";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-transcript-epoch-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old turn user 1" },
      { role: "assistant", content: "old turn assistant 1" },
      { role: "user", content: "old turn user 2" },
      { role: "assistant", content: "old turn assistant 2" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old turn user 1" }),
        makeMessage({ role: "assistant", content: "old turn assistant 1" }),
        makeMessage({ role: "user", content: "old turn user 2" }),
        makeMessage({ role: "assistant", content: "old turn assistant 2" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const newSessionFile = createSessionFilePath("after-turn-transcript-epoch-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new codex user prompt" },
      { role: "assistant", content: "new codex assistant delta" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new codex assistant delta" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old turn user 1",
      "old turn assistant 1",
      "old turn user 2",
      "old turn assistant 2",
      "new codex user prompt",
      "new codex assistant delta",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.sessionFilePath).toBe(newSessionFile);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(newSessionFile).size);
  });

  it("afterTurn preserves continuity when a path-mismatched transcript is only delivery audit traffic", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-delivery-only-path-mismatch";
    const sessionKey = "agent:main:signal:direct:after-turn-delivery-only";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-delivery-only-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "long-lived afterTurn DM question" },
      { role: "assistant", content: "long-lived afterTurn DM answer" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "long-lived afterTurn DM question" }),
        makeMessage({ role: "assistant", content: "long-lived afterTurn DM answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("after-turn-delivery-only-new");
    writeLeafTranscript(newSessionFile, [
      { role: "system", content: "delivery-mirror config-audit: refreshed host policy" },
      { role: "system", content: "config-audit delivery-mirror: no user turn" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "assistant delta without foreground user" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("delivery-only path-mismatched transcript")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "long-lived afterTurn DM question",
      "long-lived afterTurn DM answer",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint).toEqual(oldCheckpoint);
  });

  it("afterTurn archives a stale active conversation when the prior keyed transcript was pruned", async () => {
    const engine = createEngine();
    const firstSessionId = "after-turn-missed-reset-fallback-1";
    const secondSessionId = "after-turn-missed-reset-fallback-2";
    const sessionKey = "agent:main:test:after-turn-missed-reset-fallback";
    const oldSessionFile = createSessionFilePath("after-turn-missed-reset-fallback-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old turn user" },
      { role: "assistant", content: "openai-codex/gpt-5.5" },
    ]);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    rmSync(oldSessionFile, { force: true });

    const newSessionFile = createSessionFilePath("after-turn-missed-reset-fallback-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new turn user" },
      { role: "assistant", content: "new turn assistant" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new turn assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(originalConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);
    expect(activeConversation!.active).toBe(true);

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const activeMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(activeMessages.map((message) => message.content)).toEqual([
      "new turn user",
      "new turn assistant",
    ]);
  });

  it("afterTurn skips assistant-only rollover when the replacement transcript is unreadable", async () => {
    const engine = createEngine();
    const firstSessionId = "after-turn-missed-reset-unreadable-1";
    const secondSessionId = "after-turn-missed-reset-unreadable-2";
    const sessionKey = "agent:main:test:after-turn-missed-reset-unreadable";
    const oldSessionFile = createSessionFilePath("after-turn-missed-reset-unreadable-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old unreadable user" },
      { role: "assistant", content: "old unreadable assistant" },
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

    rmSync(oldSessionFile, { force: true });
    const unreadableSessionFile = createSessionFilePath("after-turn-missed-reset-unreadable-new");
    writeFileSync(unreadableSessionFile, '{"message":', "utf8");

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: unreadableSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new unreadable assistant delta" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).toBeNull();
  });

  it("afterTurn bounds initial transcript imports to the bootstrap budget", async () => {
    const engine = createEngineWithConfig({ bootstrapMaxTokens: 120 });
    const sessionId = "after-turn-initial-transcript-budget";
    const sessionKey = "agent:main:test:after-turn-initial-transcript-budget";
    const sessionFile = createSessionFilePath("after-turn-initial-transcript-budget");
    const transcriptMessages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `initial afterTurn bulk transcript ${index} ${"x".repeat(200)}`,
    })) as Array<{ role: AgentMessage["role"]; content: string }>;
    writeLeafTranscript(sessionFile, transcriptMessages);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({
          role: "assistant",
          content: transcriptMessages[transcriptMessages.length - 1]!.content,
        }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(10);
    expect(stored.map((message) => message.content)).toContain(
      transcriptMessages[transcriptMessages.length - 1]!.content,
    );
  });

  it("afterTurn skips persistence when full reread finds no anchor and imports nothing", async () => {
    const engine = createEngineWithDeps({}, {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const sessionId = "after-turn-no-anchor-no-import";
    const sessionKey = "agent:main:test:direct:no-anchor-no-import";

    const privateEngine = engine as unknown as {
      config: LcmConfig;
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-no-anchor-no-import");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old no-anchor user" },
      { role: "assistant", content: "old no-anchor assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old no-anchor user" }),
        makeMessage({ role: "assistant", content: "old no-anchor assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    const rawDb = createLcmDatabaseConnection(privateEngine.config.databasePath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "rewritten missing prefix user" },
      { role: "assistant", content: "rewritten missing prefix assistant" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "live no-anchor user" }),
        makeMessage({ role: "assistant", content: "live no-anchor assistant" }),
        makeMessage({ role: "user", content: "live no-anchor follow-up" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const checkpointAfterNoImport = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterNoImport).toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old no-anchor user",
      "old no-anchor assistant",
    ]);
  });

  it("afterTurn imports a bounded same-path transcript epoch after the file shrinks", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-same-path-shrink";
    const sessionKey = "agent:main:test:direct:same-path-shrink";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old shrink user" },
      { role: "assistant", content: "old shrink assistant" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old shrink user" }),
        makeMessage({ role: "assistant", content: "old shrink assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "missed shrink prefix user" },
      { role: "assistant", content: "missed shrink prefix assistant" },
      { role: "user", content: "live shrink user" },
      { role: "assistant", content: "live shrink assistant" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);
    const shrinkStats = statSync(sessionFile);
    (
      engine.getTranscriptReconciler() as unknown as {
        afterTurnReconcileFullReadStates: Map<string, { size: number; mtimeMs: number }>;
      }
    ).afterTurnReconcileFullReadStates.set(`${sessionKey}\u0000${sessionFile}`, {
      size: shrinkStats.size,
      mtimeMs: Math.trunc(shrinkStats.mtimeMs),
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "live shrink user" }),
        makeMessage({ role: "assistant", content: "live shrink assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("same-path-shrink")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old shrink user",
      "old shrink assistant",
      "missed shrink prefix user",
      "missed shrink prefix assistant",
      "live shrink user",
      "live shrink assistant",
    ]);

    const newCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(newCheckpoint?.sessionFilePath).toBe(sessionFile);
    expect(newCheckpoint?.lastProcessedOffset).toBe(statSync(sessionFile).size);
  });

  it("afterTurn imports the full bounded same-path shrink epoch instead of trusting a stale externalized frontier", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-same-path-shrink-externalized";
    const sessionKey = "agent:main:test:direct:same-path-shrink-externalized";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink-externalized");
    const rawFrontier = "afterTurn externalized raw shrink frontier";
    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: rawFrontier })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const firstStored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(firstStored).toHaveLength(1);

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(`UPDATE messages SET content = ?, token_count = ? WHERE message_id = ?`)
        .run(
          "[LCM afterTurn externalized payload reference]",
          estimateTokens("[LCM afterTurn externalized payload reference]"),
          firstStored[0].messageId,
        );
    } finally {
      closeLcmConnection(rawDb);
    }

    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
      { role: "user", content: "afterTurn tail after externalized shrink" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: "afterTurn tail after externalized shrink" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[LCM afterTurn externalized payload reference]",
      rawFrontier,
      "afterTurn tail after externalized shrink",
    ]);
  });

  it("afterTurn imports a full same-path shrink epoch when new content repeats an old frontier message", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-same-path-shrink-duplicate-frontier";
    const sessionKey = "agent:main:test:direct:same-path-shrink-duplicate-frontier";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink-duplicate-frontier");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old afterTurn duplicate frontier user" },
      { role: "assistant", content: "OK" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old afterTurn duplicate frontier user" }),
        makeMessage({ role: "assistant", content: "OK" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "new afterTurn duplicate frontier user" },
      { role: "assistant", content: "OK" },
      { role: "user", content: "new afterTurn duplicate frontier tail" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: "new afterTurn duplicate frontier tail" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old afterTurn duplicate frontier user",
      "OK",
      "new afterTurn duplicate frontier user",
      "OK",
      "new afterTurn duplicate frontier tail",
    ]);
  });

  it("afterTurn keeps the old checkpoint when a path-mismatched no-anchor import is capped", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      { proactiveThresholdCompactionMode: "inline" },
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-transcript-epoch-no-anchor-capped";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-transcript-epoch-capped-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old capped user" },
      { role: "assistant", content: "old capped assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old capped user" }),
        makeMessage({ role: "assistant", content: "old capped assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("after-turn-transcript-epoch-capped-new");
    writeLeafTranscript(
      newSessionFile,
      Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `oversized no-anchor epoch ${index}`,
      })),
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({ role: "user", content: "live after capped epoch user" }),
        makeMessage({ role: "assistant", content: "live after capped epoch assistant" }),
        makeMessage({ role: "user", content: "live after capped epoch follow-up" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("no anchor import cap exceeded")),
    ).toBe(true);

    const checkpointAfterCap = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterCap).toEqual(oldCheckpoint);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old capped user",
      "old capped assistant",
    ]);

    appendFileSync(
      newSessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "live after capped epoch assistant" }],
        },
      })}\n${JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "second live after capped epoch user" }],
        },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({ role: "assistant", content: "live after capped epoch assistant" }),
        makeMessage({ role: "user", content: "second live after capped epoch user" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("no anchor import cap exceeded")),
    ).toBe(true);
    const checkpointAfterRetry = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterRetry).toEqual(oldCheckpoint);

    const storedAfterRetry = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterRetry.map((message) => message.content)).toEqual([
      "old capped user",
      "old capped assistant",
    ]);
  });

  it("afterTurn retries a capped reconcile when the transcript file changed with an append-only-ineligible suffix (F7)", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: infoLog, warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-reconcile-cap-retries-on-file-change";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-reconcile-cap-retry-seed"),
      messages: [makeMessage({ role: "assistant", content: "seed turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const targetSessionFile = createSessionFilePath("after-turn-reconcile-cap-retry-target");
    writeFileSync(
      targetSessionFile,
      `${JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "seed turn" }] },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn one" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toHaveLength(1);

    appendFileSync(
      targetSessionFile,
      `not-json\n${JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "append-only-ineligible user" }],
        },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "append-only-ineligible assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      infoLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("transcript reconcile slow path skipped")),
    ).toBe(false);
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toHaveLength(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed turn",
      "next turn one",
      "append-only-ineligible user",
      "append-only-ineligible assistant",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(targetSessionFile).size);
  });

  it("afterTurn drains deferred threshold debt in the background without cache telemetry", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-background-threshold-drain";
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

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-background-threshold-drain"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    await vi.waitFor(() => {
      expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
          compactionTarget: "threshold",
        }),
      );
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
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

  it("afterTurn persists prompt-cache telemetry for hot sessions", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      },
    );
    const sessionId = "after-turn-prompt-cache-hot";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });
    vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-prompt-cache-hot"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      runtimeContext: {
        promptCache: {
          retention: "long",
          lastCallUsage: {
            input: 512,
            cacheRead: 1_024,
            cacheWrite: 128,
          },
          observation: {
            broke: false,
          },
        },
      },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const telemetry = await engine
      .getCompactionTelemetryStore()
      .getConversationCompactionTelemetry(conversation!.conversationId);
    expect(telemetry).not.toBeNull();
    expect(telemetry).toMatchObject({
      cacheState: "hot",
      lastObservedCacheRead: 1_024,
      lastObservedCacheWrite: 128,
      lastObservedPromptTokenCount: 1_664,
      retention: "long",
    });
    expect(telemetry?.lastObservedCacheHitAt).toBeInstanceOf(Date);
    expect(telemetry?.lastObservedCacheBreakAt).toBeNull();
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] compaction telemetry updated:"),
    );
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("cacheState=hot"),
    );
  });

  it("afterTurn prefers runtime prompt tokens over transcript estimates for compaction decisions", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      },
    );
    const sessionId = "after-turn-runtime-prompt-tokens";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 204_800,
      threshold: 98_304,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-prompt-tokens"),
      messages: [makeMessage({ role: "assistant", content: "small transcript estimate" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: {
        usage: {
          prompt_tokens: 204_800,
        },
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 204_800, {
      contextThreshold: 0.75,
    });
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("using runtime prompt token count currentTokenCount=204800"),
    );
  });

  it("afterTurn skips compaction when ingest fails", async () => {
    const errorLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
        debug: vi.fn(),
      },
    });
    const sessionId = "after-turn-ingest-failure";

    const ingestBatchSpy = vi
      .spyOn(engine, "ingestBatch")
      .mockRejectedValue(new Error("ingest exploded"));
    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-ingest-failure"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(ingestBatchSpy).toHaveBeenCalled();
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[lcm] afterTurn: ingest failed, skipping compaction: ingest exploded",
    );
  });

  it("afterTurn prunes heartbeat-shaped ACK turns before compaction even without the heartbeat flag", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: infoLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: debugLog,
      },
    });
    const sessionId = "after-turn-heartbeat-prune";
    const sessionKey = "agent:main:test:after-turn-heartbeat-prune";
    const heartbeatMessages = [
      makeMessage({
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
      makeMessage({
        role: "tool",
        content: "# HEARTBEAT.md\n\n## Worker heartbeat (minimal)",
      }),
      makeMessage({
        role: "tool",
        content: '{\n  "active_session_ids": []\n}',
      }),
      makeMessage({ role: "assistant", content: "HEARTBEAT_OK" }),
    ];
    const sessionFile = createSessionFilePath("after-turn-heartbeat-prune");
    writeLeafTranscriptMessages(sessionFile, heartbeatMessages);

    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: heartbeatMessages,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(0);
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining(
        `heartbeat ack messages for conversation=${conversation!.conversationId} session=${sessionId} sessionKey=${sessionKey}`,
      ),
    );
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

  it("afterTurn heartbeat flag skips append-only transcript deltas and advances the checkpoint", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-heartbeat-flag-append-only-skip";
    const sessionKey = "agent:main:test:after-turn-heartbeat-flag-append-only-skip";
    const sessionFile = createSessionFilePath("after-turn-heartbeat-flag-append-only-skip");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, makeMessage({ role: "user", content: "seed user" }));
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "seed assistant" }));

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const heartbeatMessages = [
      makeMessage({
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
      makeMessage({
        role: "tool",
        content: "# HEARTBEAT.md\n\nIf nothing needs attention, stay quiet.",
      }),
      makeMessage({ role: "assistant", content: "HEARTBEAT_OK" }),
    ];
    for (const message of heartbeatMessages) {
      appendSessionMessage(sm, message);
    }

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
    expect(conversation).not.toBeNull();
    let stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
    ]);

    appendSessionMessage(sm, makeMessage({ role: "user", content: "real user" }));
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "real assistant" }));

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "real assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "real user",
      "real assistant",
    ]);
  });
});
