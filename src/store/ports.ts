// Storage contracts deliberately expose behavior, not a SQLite connection.
import type { ConversationStore } from "./conversation-store.js";
import type {
  SummaryStore,
  CreateLargeFileInput,
  LargeFileRecord,
  ContextItemRecord,
} from "./summary-store.js";
import type { PendingSummaryStore } from "./pending-summary-store.js";
import type { FocusBriefStore } from "./focus-brief-store.js";
import type { CompactionTelemetryStore } from "./compaction-telemetry-store.js";
import type { CompactionMaintenanceStore } from "./compaction-maintenance-store.js";
import type { TranscriptCursorStore } from "./transcript-cursor-store.js";
import type { TranscriptGapStore } from "./transcript-gap-store.js";
import type { UserReplayKeyStore } from "./user-replay-key-store.js";
export type ConversationRepository = Pick<
  ConversationStore,
  keyof ConversationStore
>;
export type SummaryRepository = Pick<SummaryStore, keyof SummaryStore> & {
  withReadSnapshot?<T>(operation: () => Promise<T>): Promise<T>;
  prefetchContextItems?: (items: ContextItemRecord[]) => Promise<void>;
  storeLargeFileBytes?: (
    input: CreateLargeFileInput,
    bytes: Buffer
  ) => Promise<LargeFileRecord>;
  getLargeFileBytes?: (
    id: string,
    options?: { maxBytes?: number }
  ) => Promise<Buffer | null>;
};
export type PendingSummaryRepository = Pick<
  PendingSummaryStore,
  keyof PendingSummaryStore
>;
export type FocusBriefRepository = Pick<FocusBriefStore, keyof FocusBriefStore>;
export type CompactionTelemetryRepository = Pick<
  CompactionTelemetryStore,
  keyof CompactionTelemetryStore
>;
export type CompactionMaintenanceRepository = Pick<
  CompactionMaintenanceStore,
  keyof CompactionMaintenanceStore
>;
type AsyncCompatible<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => R | Promise<Awaited<R>>
    : never;
};
export type TranscriptCursorRepository = AsyncCompatible<
  Pick<TranscriptCursorStore, keyof TranscriptCursorStore>
>;
export type TranscriptGapRepository = AsyncCompatible<
  Pick<TranscriptGapStore, keyof TranscriptGapStore>
>;
export type UserReplayKeyRepository = AsyncCompatible<
  Pick<UserReplayKeyStore, keyof UserReplayKeyStore>
>;
