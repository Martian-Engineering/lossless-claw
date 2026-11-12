import type {
  CompactionTelemetryStore,
  ConversationCompactionTelemetryRecord,
  UpsertConversationCompactionTelemetryInput,
} from "../../store/compaction-telemetry-store.js";
import { NativeRepository, n } from "./repository.js";
export class NativeCompactionTelemetryStore
  extends NativeRepository
  implements Pick<CompactionTelemetryStore, keyof CompactionTelemetryStore>
{
  getConversationCompactionTelemetry(
    cid: number
  ): Promise<ConversationCompactionTelemetryRecord | null> {
    return this.read((v) => v.get(`telemetry/${n(cid)}`));
  }
  upsertConversationCompactionTelemetry(
    input: UpsertConversationCompactionTelemetryInput
  ): Promise<void> {
    return this.write(async (tx) => {
      const row: ConversationCompactionTelemetryRecord = {
        conversationId: input.conversationId,
        lastObservedCacheRead: input.lastObservedCacheRead ?? null,
        lastObservedCacheWrite: input.lastObservedCacheWrite ?? null,
        lastObservedPromptTokenCount:
          input.lastObservedPromptTokenCount ?? null,
        lastObservedCacheHitAt: input.lastObservedCacheHitAt ?? null,
        lastObservedCacheBreakAt: input.lastObservedCacheBreakAt ?? null,
        cacheState: input.cacheState,
        consecutiveColdObservations: input.consecutiveColdObservations ?? 0,
        retention: input.retention ?? null,
        lastLeafCompactionAt: input.lastLeafCompactionAt ?? null,
        turnsSinceLeafCompaction: input.turnsSinceLeafCompaction ?? 0,
        tokensAccumulatedSinceLeafCompaction:
          input.tokensAccumulatedSinceLeafCompaction ?? 0,
        lastActivityBand: input.lastActivityBand ?? "low",
        lastApiCallAt: input.lastApiCallAt ?? null,
        lastCacheTouchAt: input.lastCacheTouchAt ?? null,
        provider: input.provider ?? null,
        model: input.model ?? null,
        updatedAt: new Date(Math.floor(Date.now() / 1000) * 1000),
      };
      await tx.put(`telemetry/${n(input.conversationId)}`, row);
    });
  }
}
