import type {
  CompactionMaintenanceStore,
  ConversationCompactionMaintenanceRecord,
} from "../../store/compaction-maintenance-store.js";
import { NativeRepository, n } from "./repository.js";
const DEFERRED_COMPACTION_RETRY_BASE_MS = 5 * 60 * 1000;
const DEFERRED_COMPACTION_RETRY_MAX_MS = 30 * 60 * 1000;

function computeDeferredCompactionRetryDelayMs(attempts: number): number {
  const safeAttempts = Number.isFinite(attempts)
    ? Math.max(1, Math.floor(attempts))
    : 1;
  const multiplier = Math.min(2 ** (safeAttempts - 1), 64);
  return Math.min(
    DEFERRED_COMPACTION_RETRY_BASE_MS * multiplier,
    DEFERRED_COMPACTION_RETRY_MAX_MS
  );
}

function shouldBackOffDeferredCompactionFailure(
  failureSummary: string | null | undefined
): boolean {
  if (failureSummary == null) {
    return false;
  }
  return !/\b(provider auth failure|summary provider circuit breaker is open)\b/i.test(
    failureSummary
  );
}

function mergeMaintenanceRecord(
  conversationId: number,
  existing: ConversationCompactionMaintenanceRecord | null,
  patch: Partial<ConversationCompactionMaintenanceRecord>
): ConversationCompactionMaintenanceRecord {
  return {
    conversationId,
    pending:
      patch.pending !== undefined ? patch.pending : existing?.pending ?? false,
    requestedAt:
      patch.requestedAt !== undefined
        ? patch.requestedAt
        : existing?.requestedAt ?? null,
    reason:
      patch.reason !== undefined ? patch.reason : existing?.reason ?? null,
    running:
      patch.running !== undefined ? patch.running : existing?.running ?? false,
    lastStartedAt:
      patch.lastStartedAt !== undefined
        ? patch.lastStartedAt
        : existing?.lastStartedAt ?? null,
    lastFinishedAt:
      patch.lastFinishedAt !== undefined
        ? patch.lastFinishedAt
        : existing?.lastFinishedAt ?? null,
    lastFailureSummary:
      patch.lastFailureSummary !== undefined
        ? patch.lastFailureSummary
        : existing?.lastFailureSummary ?? null,
    tokenBudget:
      patch.tokenBudget !== undefined
        ? patch.tokenBudget
        : existing?.tokenBudget ?? null,
    currentTokenCount:
      patch.currentTokenCount !== undefined
        ? patch.currentTokenCount
        : existing?.currentTokenCount ?? null,
    projectedTokenCount:
      patch.projectedTokenCount !== undefined
        ? patch.projectedTokenCount
        : existing?.projectedTokenCount ?? null,
    rawTokensOutsideTail:
      patch.rawTokensOutsideTail !== undefined
        ? patch.rawTokensOutsideTail
        : existing?.rawTokensOutsideTail ?? null,
    contextThreshold:
      patch.contextThreshold !== undefined
        ? patch.contextThreshold
        : existing?.contextThreshold ?? null,
    contextThresholdSource:
      patch.contextThresholdSource !== undefined
        ? patch.contextThresholdSource
        : existing?.contextThresholdSource ?? null,
    contextFreshTailCount:
      patch.contextFreshTailCount !== undefined
        ? patch.contextFreshTailCount
        : existing?.contextFreshTailCount ?? null,
    contextLeafChunkTokens:
      patch.contextLeafChunkTokens !== undefined
        ? patch.contextLeafChunkTokens
        : existing?.contextLeafChunkTokens ?? null,
    retryAttempts:
      patch.retryAttempts !== undefined
        ? Math.max(0, Math.floor(patch.retryAttempts))
        : existing?.retryAttempts ?? 0,
    nextAttemptAfter:
      patch.nextAttemptAfter !== undefined
        ? patch.nextAttemptAfter
        : existing?.nextAttemptAfter ?? null,
    resolutionReason:
      patch.resolutionReason !== undefined
        ? patch.resolutionReason
        : existing?.resolutionReason ?? null,
    resolvedAt:
      patch.resolvedAt !== undefined
        ? patch.resolvedAt
        : existing?.resolvedAt ?? null,
    maintenanceRevision:
      patch.maintenanceRevision !== undefined
        ? Math.max(0, Math.floor(patch.maintenanceRevision))
        : existing?.maintenanceRevision ?? 0,
    updatedAt: new Date(),
  };
}

export class NativeCompactionMaintenanceStore
  extends NativeRepository
  implements Pick<CompactionMaintenanceStore, keyof CompactionMaintenanceStore>
{
  getConversationCompactionMaintenance(
    cid: number
  ): Promise<ConversationCompactionMaintenanceRecord | null> {
    return this.read((v) => v.get(`maintenance/${n(cid)}`));
  }
  private saveConversationCompactionMaintenance(
    row: ConversationCompactionMaintenanceRecord
  ): Promise<void> {
    return this.write(async (tx) => {
      const old = await tx.get<ConversationCompactionMaintenanceRecord>(
        `maintenance/${n(row.conversationId)}`
      );
      await tx.put(`maintenance/${n(row.conversationId)}`, {
        ...row,
        maintenanceRevision: old
          ? old.maintenanceRevision + 1
          : row.maintenanceRevision,
        updatedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
      });
    });
  }
  async requestProactiveCompactionDebt(input: {
    conversationId: number;
    reason: string;
    requestedAt?: Date;
    tokenBudget?: number | null;
    currentTokenCount?: number | null;
    projectedTokenCount?: number | null;
    rawTokensOutsideTail?: number | null;
    contextThreshold?: number | null;
    contextThresholdSource?: "global" | "override" | null;
    contextFreshTailCount?: number | null;
    contextLeafChunkTokens?: number | null;
  }): Promise<void> {
    return this.write(async () => {
      const existing = await this.getConversationCompactionMaintenance(
        input.conversationId
      );
      await this.saveConversationCompactionMaintenance(
        mergeMaintenanceRecord(input.conversationId, existing, {
          pending: true,
          requestedAt: input.requestedAt ?? new Date(),
          reason: input.reason,
          running: false,
          tokenBudget: input.tokenBudget ?? existing?.tokenBudget ?? null,
          currentTokenCount:
            input.currentTokenCount ?? existing?.currentTokenCount ?? null,
          projectedTokenCount:
            input.projectedTokenCount ?? existing?.projectedTokenCount ?? null,
          rawTokensOutsideTail:
            input.rawTokensOutsideTail ??
            existing?.rawTokensOutsideTail ??
            null,
          // Unlike the token diagnostics above, the persisted threshold is NOT
          // carried over from the previous row: a stale threshold must not
          // outlive the debt that resolved it, so new debt without a threshold
          // resets both columns to null.
          contextThreshold: input.contextThreshold ?? null,
          contextThresholdSource: input.contextThresholdSource ?? null,
          contextFreshTailCount: input.contextFreshTailCount ?? null,
          contextLeafChunkTokens: input.contextLeafChunkTokens ?? null,
          resolutionReason: null,
          resolvedAt: null,
        })
      );
    });
  }

  /** Administratively close pending debt only when its conversation is inactive. */
  async closeInactiveCompactionDebt(input: {
    conversationId: number;
    expectedRevision: number;
    resolvedAt?: Date;
  }): Promise<boolean> {
    return this.write(async (tx) => {
      const row = await this.getConversationCompactionMaintenance(
        input.conversationId
      );
      const conversation = await tx.get<{ active: boolean }>(
        `conversations/${n(input.conversationId)}`
      );
      if (
        !row ||
        !row.pending ||
        row.running ||
        row.maintenanceRevision !== input.expectedRevision ||
        conversation?.active !== false
      )
        return false;
      await this.saveConversationCompactionMaintenance({
        ...row,
        pending: false,
        running: false,
        resolutionReason: "operator-ignored",
        resolvedAt: input.resolvedAt ?? new Date(),
      });
      return true;
    });
  }

  /** Mark deferred proactive compaction as actively running. */
  async markProactiveCompactionRunning(input: {
    conversationId: number;
    startedAt?: Date;
  }): Promise<void> {
    return this.write(async () => {
      const existing = await this.getConversationCompactionMaintenance(
        input.conversationId
      );
      await this.saveConversationCompactionMaintenance(
        mergeMaintenanceRecord(input.conversationId, existing, {
          pending: false,
          running: true,
          lastStartedAt: input.startedAt ?? new Date(),
        })
      );
    });
  }

  /** Mark deferred proactive compaction as finished. */
  async markProactiveCompactionFinished(input: {
    conversationId: number;
    finishedAt?: Date;
    failureSummary?: string | null;
    keepPending?: boolean;
    nextAttemptAfter?: Date | null;
    /** Canonical publication invalidates observations of the preceding prompt. */
    clearTokenObservations?: boolean;
    /** A publication-only no-op does not retry model-backed work. */
    preserveRetryState?: boolean;
  }): Promise<void> {
    return this.write(async () => {
      const existing = await this.getConversationCompactionMaintenance(
        input.conversationId
      );
      const finishedAt = input.finishedAt ?? new Date();
      const isFailure = input.failureSummary != null;
      const shouldBackOff = shouldBackOffDeferredCompactionFailure(
        input.failureSummary
      );
      const retryAttempts = shouldBackOff
        ? (existing?.retryAttempts ?? 0) + 1
        : 0;
      let nextAttemptAfter =
        input.nextAttemptAfter !== undefined
          ? input.nextAttemptAfter
          : shouldBackOff
          ? new Date(
              finishedAt.getTime() +
                computeDeferredCompactionRetryDelayMs(retryAttempts)
            )
          : null;
      // Retained debt must honor every applicable cooldown. An explicit
      // spend deadline cannot shorten a later maintenance retry (or vice versa).
      if (input.keepPending ?? isFailure) {
        const retryDeadline = shouldBackOff
          ? finishedAt.getTime() +
            computeDeferredCompactionRetryDelayMs(retryAttempts)
          : 0;
        const latest = Math.max(
          retryDeadline,
          existing?.nextAttemptAfter?.getTime() ?? 0,
          nextAttemptAfter?.getTime() ?? 0
        );
        nextAttemptAfter =
          latest > finishedAt.getTime() ? new Date(latest) : null;
      }
      await this.saveConversationCompactionMaintenance(
        mergeMaintenanceRecord(input.conversationId, existing, {
          pending: input.keepPending ?? isFailure,
          running: false,
          lastFinishedAt: finishedAt,
          lastFailureSummary:
            input.preserveRetryState || input.failureSummary === undefined
              ? existing?.lastFailureSummary ?? null
              : input.failureSummary,
          retryAttempts: input.preserveRetryState
            ? existing?.retryAttempts ?? 0
            : retryAttempts,
          nextAttemptAfter: input.preserveRetryState
            ? existing?.nextAttemptAfter ?? null
            : nextAttemptAfter,
          ...(input.clearTokenObservations
            ? {
                currentTokenCount: null,
                projectedTokenCount: null,
                rawTokensOutsideTail: null,
              }
            : {}),
        })
      );
    });
  }
}
