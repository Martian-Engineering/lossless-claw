/**
 * Compaction telemetry recording: per-conversation cache-state telemetry
 * derived from runtime prompt-cache snapshots, leaf-compaction success
 * marking, and deferred compaction debt rows for later drain.
 *
 * Extracted from engine.ts (Phase 3 of the engine decomposition).
 */
import type { ResolvedContextThreshold } from "./context-threshold.js";
import { readRuntimeModelContext } from "./runtime-model.js";
import type { CompactionMaintenanceStore } from "./store/compaction-maintenance-store.js";
import {
  type CacheState,
  type CompactionTelemetryStore,
  type ConversationCompactionTelemetryRecord,
} from "./store/compaction-telemetry-store.js";
import type { LcmDependencies } from "./types.js";
import { asRecord, normalizeOptionalCount, safeBoolean, safeString } from "./value-utils.js";

type PromptCacheSnapshot = {
  lastObservedCacheRead?: number;
  lastObservedCacheWrite?: number;
  lastObservedPromptTokenCount?: number;
  cacheState: CacheState;
  retention?: string;
  sawExplicitBreak: boolean;
  lastCacheTouchAt?: Date;
  provider?: string;
  model?: string;
};

export class CompactionTelemetryRecorder {
  constructor(
    private readonly compactionTelemetryStore: CompactionTelemetryStore,
    private readonly compactionMaintenanceStore: CompactionMaintenanceStore,
    private readonly deps: Pick<LcmDependencies, "log">,
  ) {}

  /** Extract the current prompt-cache snapshot from runtime context, if present. */
  private readPromptCacheSnapshot(runtimeContext?: Record<string, unknown>): PromptCacheSnapshot | null {
    const promptCache = asRecord(runtimeContext?.promptCache);
    const { provider, model } = readRuntimeModelContext(runtimeContext);
    if (!promptCache && !provider && !model) {
      return null;
    }

    const lastCallUsage = asRecord(promptCache?.lastCallUsage);
    const observation = asRecord(promptCache?.observation);
    const cacheRead = normalizeOptionalCount(lastCallUsage?.cacheRead);
    const cacheWrite = normalizeOptionalCount(lastCallUsage?.cacheWrite);
    const promptTokenCount = (() => {
      const input = normalizeOptionalCount(lastCallUsage?.input) ?? 0;
      const total = input + (cacheRead ?? 0) + (cacheWrite ?? 0);
      return total > 0 ? total : undefined;
    })();
    const sawExplicitBreak = safeBoolean(observation?.broke) === true;
    const retention = safeString(promptCache?.retention)?.trim();
    const lastCacheTouchAtRaw = promptCache?.lastCacheTouchAt;
    const lastCacheTouchAt =
      typeof lastCacheTouchAtRaw === "number" && Number.isFinite(lastCacheTouchAtRaw)
        ? new Date(lastCacheTouchAtRaw)
        : undefined;
    const hasUsageSignal = cacheRead !== undefined || cacheWrite !== undefined;
    const hasObservationSignal =
      typeof observation?.cacheRead === "number"
      || typeof observation?.previousCacheRead === "number"
      || sawExplicitBreak;

    let cacheState: CacheState = "unknown";
    if (sawExplicitBreak) {
      cacheState = "cold";
    } else if (typeof cacheRead === "number" && cacheRead > 0) {
      cacheState = "hot";
    } else if (typeof cacheWrite === "number" && cacheWrite > 0) {
      cacheState = "hot";
    } else if (hasUsageSignal || hasObservationSignal) {
      cacheState = "cold";
    }

    return {
      ...(cacheRead !== undefined ? { lastObservedCacheRead: cacheRead } : {}),
      ...(cacheWrite !== undefined ? { lastObservedCacheWrite: cacheWrite } : {}),
      ...(promptTokenCount !== undefined
        ? { lastObservedPromptTokenCount: promptTokenCount }
        : {}),
      cacheState,
      ...(retention ? { retention } : {}),
      sawExplicitBreak,
      ...(lastCacheTouchAt ? { lastCacheTouchAt } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
    };
  }

  /** Persist the current turn's compaction telemetry for later policy decisions. */
  async updateCompactionTelemetry(params: {
    conversationId: number;
    runtimeContext?: Record<string, unknown>;
    tokenBudget?: number;
    rawTokensOutsideTail?: number;
  }): Promise<ConversationCompactionTelemetryRecord | null> {
    const snapshot = this.readPromptCacheSnapshot(params.runtimeContext);
    const existing = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    if (!snapshot && params.rawTokensOutsideTail === undefined) {
      return existing;
    }

    const now = new Date();
    const turnsSinceLeafCompaction =
      (existing?.turnsSinceLeafCompaction ?? 0) + 1;
    const tokensAccumulatedSinceLeafCompaction =
      params.rawTokensOutsideTail ?? existing?.tokensAccumulatedSinceLeafCompaction ?? 0;
    const touchedPromptCache =
      snapshot?.lastCacheTouchAt
      ?? (
        snapshot
        && (snapshot.lastObservedCacheRead !== undefined || snapshot.lastObservedCacheWrite !== undefined)
          ? now
          : existing?.lastCacheTouchAt ?? null
      );
    const consecutiveColdObservations =
      snapshot?.sawExplicitBreak
        ? Math.max(existing?.consecutiveColdObservations ?? 0, 1)
        : snapshot?.cacheState === "hot"
          ? 0
          : snapshot?.cacheState === "cold"
            ? (existing?.consecutiveColdObservations ?? 0) + 1
            : existing?.consecutiveColdObservations ?? 0;
    await this.compactionTelemetryStore.upsertConversationCompactionTelemetry({
      conversationId: params.conversationId,
      lastObservedCacheRead: snapshot?.lastObservedCacheRead ?? existing?.lastObservedCacheRead ?? null,
      lastObservedCacheWrite:
        snapshot?.lastObservedCacheWrite ?? existing?.lastObservedCacheWrite ?? null,
      lastObservedPromptTokenCount:
        snapshot?.lastObservedPromptTokenCount ?? existing?.lastObservedPromptTokenCount ?? null,
      lastObservedCacheHitAt:
        snapshot?.cacheState === "hot"
          ? now
          : existing?.lastObservedCacheHitAt ?? null,
      lastObservedCacheBreakAt:
        snapshot?.sawExplicitBreak
          ? now
          : existing?.lastObservedCacheBreakAt ?? null,
      cacheState: snapshot?.cacheState ?? existing?.cacheState ?? "unknown",
      consecutiveColdObservations,
      retention: snapshot?.retention ?? existing?.retention ?? null,
      lastLeafCompactionAt: existing?.lastLeafCompactionAt ?? null,
      turnsSinceLeafCompaction,
      tokensAccumulatedSinceLeafCompaction,
      lastActivityBand: existing?.lastActivityBand ?? "low",
      lastApiCallAt: now,
      lastCacheTouchAt: touchedPromptCache,
      provider: snapshot?.provider ?? existing?.provider ?? null,
      model: snapshot?.model ?? existing?.model ?? null,
    });
    const updated = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    if (updated) {
      this.deps.log.debug(
        `[lcm] compaction telemetry updated: conversation=${params.conversationId} cacheState=${updated.cacheState} coldObservationStreak=${updated.consecutiveColdObservations} cacheRead=${updated.lastObservedCacheRead ?? "null"} cacheWrite=${updated.lastObservedCacheWrite ?? "null"} promptTokenCount=${updated.lastObservedPromptTokenCount ?? "null"} retention=${updated.retention ?? "null"} lastApiCallAt=${updated.lastApiCallAt?.toISOString() ?? "null"} lastCacheTouchAt=${updated.lastCacheTouchAt?.toISOString() ?? "null"} provider=${updated.provider ?? "null"} model=${updated.model ?? "null"} turnsSinceLeafCompaction=${updated.turnsSinceLeafCompaction} tokensSinceLeafCompaction=${updated.tokensAccumulatedSinceLeafCompaction} activityBand=${updated.lastActivityBand} rawTokensOutsideTail=${params.rawTokensOutsideTail ?? "null"} tokenBudget=${params.tokenBudget ?? "null"}`,
      );
    }
    return updated;
  }

  /** Reset refill counters after successful summary-producing compaction. */
  async markLeafCompactionTelemetrySuccess(params: {
    conversationId: number;
  }): Promise<void> {
    const existing = await this.compactionTelemetryStore.getConversationCompactionTelemetry(
      params.conversationId,
    );
    await this.compactionTelemetryStore.upsertConversationCompactionTelemetry({
      conversationId: params.conversationId,
      lastObservedCacheRead: existing?.lastObservedCacheRead ?? null,
      lastObservedCacheWrite: existing?.lastObservedCacheWrite ?? null,
      lastObservedPromptTokenCount: existing?.lastObservedPromptTokenCount ?? null,
      lastObservedCacheHitAt: existing?.lastObservedCacheHitAt ?? null,
      lastObservedCacheBreakAt: existing?.lastObservedCacheBreakAt ?? null,
      cacheState: existing?.cacheState ?? "unknown",
      consecutiveColdObservations: existing?.consecutiveColdObservations ?? 0,
      retention: existing?.retention ?? null,
      lastLeafCompactionAt: new Date(),
      turnsSinceLeafCompaction: 0,
      tokensAccumulatedSinceLeafCompaction: 0,
      lastActivityBand: existing?.lastActivityBand ?? "low",
      lastApiCallAt: existing?.lastApiCallAt ?? null,
      lastCacheTouchAt: existing?.lastCacheTouchAt ?? null,
      provider: existing?.provider ?? null,
      model: existing?.model ?? null,
    });
    this.deps.log.debug(
      `[lcm] compaction telemetry reset after compaction: conversation=${params.conversationId} cacheState=${existing?.cacheState ?? "unknown"} activityBand=${existing?.lastActivityBand ?? "low"}`,
    );
  }

  /** Persist a coalesced proactive-compaction debt record for later maintenance. */
  async recordDeferredCompactionDebt(params: {
    conversationId: number;
    reason: string;
    tokenBudget: number;
    currentTokenCount?: number;
    projectedTokenCount?: number;
    rawTokensOutsideTail?: number;
    /** Threshold that triggered the debt, reused verbatim by the drain. */
    contextThreshold?: ResolvedContextThreshold;
  }): Promise<void> {
    await this.compactionMaintenanceStore.requestProactiveCompactionDebt({
      conversationId: params.conversationId,
      reason: params.reason,
      tokenBudget: params.tokenBudget,
      currentTokenCount: params.currentTokenCount ?? null,
      projectedTokenCount: params.projectedTokenCount ?? null,
      rawTokensOutsideTail: params.rawTokensOutsideTail ?? null,
      contextThreshold: params.contextThreshold?.contextThreshold ?? null,
      contextThresholdSource: params.contextThreshold?.source ?? null,
    });
    this.deps.log.debug(
      `[lcm] deferred compaction debt recorded: conversation=${params.conversationId} reason=${params.reason} tokenBudget=${params.tokenBudget} currentTokenCount=${params.currentTokenCount ?? "null"} projectedTokenCount=${params.projectedTokenCount ?? "null"} rawTokensOutsideTail=${params.rawTokensOutsideTail ?? "null"} contextThreshold=${params.contextThreshold?.contextThreshold ?? "null"} contextThresholdSource=${params.contextThreshold?.source ?? "null"}`,
    );
  }
}
