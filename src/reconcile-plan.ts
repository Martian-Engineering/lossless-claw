/**
 * Pure planning for transcript reconciliation. No IO, no store access, no
 * logging — every decision here is unit-testable in isolation, and the
 * engine is responsible only for gathering inputs and executing plans.
 * See specs/transcript-reconciliation-by-entry-id.md (Phase 4).
 */

/**
 * Sanity bound on a single reconciliation import relative to the already
 * persisted conversation size. Guards remain even for entry-id-verified
 * imports: a declared-but-bogus epoch should not be able to flood the store.
 */
export function transcriptImportCap(existingDbCount: number): number {
  return Math.max(Math.floor(existingDbCount * 0.2), 50);
}

export type EpochRoute =
  /** Header ids match: the file is the same declared session epoch. */
  | "same-epoch"
  /** Both header ids known and different: the transcript was rewritten or
   *  rotated — a declared epoch rollover, no heuristics required. */
  | "declared-rollover"
  /** One or both header ids unknown (legacy/array-mode transcripts):
   *  heuristic reason taxonomy applies. */
  | "undeclared";

export function resolveEpochRoute(params: {
  checkpointHeaderId: string | null | undefined;
  transcriptHeaderId: string | null | undefined;
}): EpochRoute {
  const checkpointHeaderId = params.checkpointHeaderId ?? null;
  const transcriptHeaderId = params.transcriptHeaderId ?? null;
  if (!checkpointHeaderId || !transcriptHeaderId) {
    return "undeclared";
  }
  return checkpointHeaderId === transcriptHeaderId ? "same-epoch" : "declared-rollover";
}

export type EntryIdTailSelection =
  /** No persisted entry id links this transcript to the conversation; the
   *  caller's content-identity machinery and no-anchor guards decide. */
  | { kind: "no-id-lineage" }
  /** The anchor is the newest transcript entry — nothing to import. */
  | { kind: "at-tip"; anchorIndex: number }
  /** Import the listed indexes (transcript order), all after the anchor and
   *  not yet persisted. */
  | { kind: "tail"; anchorIndex: number; missingIndexes: number[] };

/**
 * Choose the resume anchor and the missing tail for an all-id transcript.
 *
 * The anchor is the checkpoint's last processed entry id when the transcript
 * still contains it, otherwise the newest entry whose id is already
 * persisted. Entries before the anchor are never imported (mid-history
 * gap-filling would append out of order); entries after it are imported
 * exactly when their id is absent.
 */
export function selectEntryIdTail(params: {
  entryIds: readonly string[];
  /** Ids already persisted; must cover at least the entries after the
   *  checkpoint anchor, or all entries when no checkpoint anchor matches. */
  existingEntryIds: ReadonlySet<string>;
  lastProcessedEntryId?: string | null;
}): EntryIdTailSelection {
  const { entryIds, existingEntryIds } = params;

  let anchorIndex = params.lastProcessedEntryId
    ? entryIds.lastIndexOf(params.lastProcessedEntryId)
    : -1;
  if (anchorIndex < 0) {
    for (let index = entryIds.length - 1; index >= 0; index -= 1) {
      if (existingEntryIds.has(entryIds[index]!)) {
        anchorIndex = index;
        break;
      }
    }
    if (anchorIndex < 0) {
      return { kind: "no-id-lineage" };
    }
  }

  if (anchorIndex >= entryIds.length - 1) {
    return { kind: "at-tip", anchorIndex };
  }

  const missingIndexes: number[] = [];
  for (let index = anchorIndex + 1; index < entryIds.length; index += 1) {
    if (!existingEntryIds.has(entryIds[index]!)) {
      missingIndexes.push(index);
    }
  }
  if (missingIndexes.length === 0) {
    return { kind: "at-tip", anchorIndex };
  }
  return { kind: "tail", anchorIndex, missingIndexes };
}

export type TranscriptReconcileResult = {
  blockedByImportCap: boolean;
  blockedReason?:
    | "import-cap"
    | "cross-conversation-raw-id"
    | "duplicate-transcript-replay"
    | "ambiguous-session-key-runtime-rollover"
    | "ambiguous-rollover-rotated-fresh-transcript";
  importedMessages: number;
  hasOverlap: boolean;
  /**
   * True only when the transcript file was actually read to its frontier and
   * reconciled into the DB this call (or proven already reconciled). When
   * true, the transcript is the single persistence source for the turn and
   * afterTurn must NOT also persist the runtime messages array; flush-lagged
   * tail messages arrive on the next turn's append-only read, idempotently.
   * False on every path that allows live runtime persistence because the
   * transcript was missing, unreadable, or skipped.
   */
  transcriptCovered?: boolean;
  /**
   * The transcript frontier was reconciled, but the reconciled tail contained
   * only non-durable heartbeat/control traffic. afterTurn should skip the
   * matching runtime batch instead of asking generic dedup to infer that.
   */
  runtimeBatchDisposition?: "skip-non-durable-control";
  nonDurableTranscriptMessages?: number;
};
