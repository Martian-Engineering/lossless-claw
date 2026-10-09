/**
 * Single-writer transcript ingestion: the host transcript is the log and LCM
 * is a projection with a persisted watermark (an opaque visible-delta cursor).
 *
 * - Incremental: drain pages after the stored cursor; cost is O(new entries).
 * - Resync (cursor reset): re-scan the visible projection without payloads,
 *   reconcile ids in bulk against one stored-id query, then import only the
 *   suffix after the last known entry (restamping rewritten rows in order).
 * - Fresh start (conversation with zero rows): import the bootstrap-budget
 *   suffix of the window after the latest same-session `/reset`.
 *
 * Each page's rows and the advanced cursor commit in one SQLite transaction,
 * so a crash leaves either both or neither. Pages are byte-bounded and the
 * event loop is yielded between pages.
 */
import type { AgentMessage } from "./openclaw-bridge.js";
import { batchLooksLikeHeartbeatAckTurn } from "./heartbeat-filter.js";
import { buildMessageParts, hasPersistableMessageRole, toStoredMessage, toStoredMessageIdentity } from "./message-content.js";
import { extractOpenClawSenderMetadata } from "./openclaw-sender-metadata.js";
import type { ConversationStore } from "./store/conversation-store.js";
import { buildMessageIdentityHash } from "./store/message-identity.js";
import type {
  ContentMatchCandidate,
  StoredTranscriptRow,
  TranscriptCursorOrigin,
  TranscriptCursorRecord,
  TranscriptCursorStore,
} from "./store/transcript-cursor-store.js";
import type { TranscriptGapStore, TranscriptHistoryGap } from "./store/transcript-gap-store.js";
import type { TranscriptUserReplayKey, UserReplayKeyStore } from "./store/user-replay-key-store.js";
import { attachTranscriptEntryMeta } from "./transcript.js";
import { isGapEligibleMessage } from "./transcript-gap-eligibility.js";
import {
  collectRawTranscriptNavigation,
  resolvePostResetStartIndex,
} from "./transcript-reset-boundary.js";
import {
  budgetStartIndex,
  contentMatchKey,
  findHistoryGaps,
  planResync,
  SuffixContentMatcher,
  type ScannedVisibleEntry,
} from "./transcript-resync-plan.js";
import { observeUserReplayIdentity, type UserReplayIdentity } from "./user-replay.js";
import type {
  LcmDependencies,
  SessionTranscriptRawDeltaParams,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadTarget,
  SessionTranscriptVisibleMessageDeltaParams,
  SessionTranscriptVisibleMessageDeltaResult,
  VisibleSessionTranscriptMessageEntry,
} from "./types.js";

const PAGE_MAX_BYTES = 8 * 1024 * 1024;
const PAGE_MAX_MESSAGES = 1_000;
const PAGE_HARD_MAX_BYTES = 64 * 1024 * 1024;
const MAX_RESYNC_ATTEMPTS = 4;

/** How a sync call reached its result. */
export type TranscriptSyncPath = "incremental" | "resync" | "fresh";

/**
 * Terminal state of one sync call. Only `synced` advanced the watermark to the
 * readable frontier; every other status leaves the DB as it was.
 */
export type TranscriptSyncStatus =
  | "synced"
  | "unavailable"
  | "missing"
  | "fenced"
  | "blocked";

/** Result of one sync call. */
export type TranscriptSyncOutcome = {
  status: TranscriptSyncStatus;
  path: TranscriptSyncPath;
  importedMessages: number;
  restampedMessages: number;
  /** Visible ordinal (message position + 1) of the stored frontier after the call. */
  frontierSeq: number | null;
  /** True when an imported page looked like a heartbeat poll/ack turn. */
  importedHeartbeatAck: boolean;
  resetReason?: string;
  detail?: string;
  /** Bulk reconciliation facts of a resync, for migration and resync logs. */
  resync?: ResyncSummary;
};

/** What one bulk resync decided. */
export type ResyncSummary = {
  visibleEntries: number;
  /** Visible index of the last stored (or supersedes-restamped) entry; -1 when unanchored. */
  anchorIndex: number;
  contentMatches: number;
  supersedesRestamps: number;
  /** Unknown visible entries before the anchor that were deliberately not imported. */
  unimportedBeforeAnchor: number;
  /** Stored rows at or before the anchor row that still carry no transcript entry id. */
  unstampedRowsBeforeAnchor: number;
  /** History gaps found before the anchor (see `findHistoryGaps`). */
  historyGaps: number;
  /** Storable entries across those gaps. */
  historyGapEntries: number;
  /** Gap markers this resync recorded for the first time. */
  newHistoryGaps: number;
};

/**
 * How a resync treats a projection with no stored id to anchor on:
 * - `skip`: import nothing and only record the frontier cursor.
 * - `match-only`: content-match the post-reset window; import only after the last match.
 * - `match-or-fresh`: like `match-only`, but with no match import the fresh-start budget suffix.
 */
export type UnanchoredResyncPolicy = "skip" | "match-only" | "match-or-fresh";

/** Facts passed to the in-transaction finalizer of a successful sync. */
export type TranscriptSyncFinalizeFacts = {
  frontierSeq: number | null;
  importedMessages: number;
};

/** One sync request for an already-resolved conversation. */
export type TranscriptSyncRequest = {
  conversationId: number;
  target: SessionTranscriptReadTarget;
  /** Fresh-start import budget; null imports the whole post-reset window. */
  freshStartBudgetTokens: number | null;
  /**
   * Entry from which the transcript is known to be new (a committed turn's
   * admission): fresh start and resync import it and everything after it
   * unless already stored.
   */
  importFromEntryId?: string;
  /** Persist one entry through the engine's storage policy; true when a row was created. */
  ingest: (message: AgentMessage) => Promise<boolean>;
  /** Runs inside the transaction that persists the final cursor of a successful sync. */
  finalize?: (facts: TranscriptSyncFinalizeFacts) => void | Promise<void>;
  label: string;
};

/** Collaborators supplied by the engine. */
export type TranscriptDeltaSyncDeps = {
  readVisibleDelta: (
    params: SessionTranscriptVisibleMessageDeltaParams,
  ) => Promise<SessionTranscriptVisibleMessageDeltaResult>;
  readRawDelta?: (params: SessionTranscriptRawDeltaParams) => Promise<SessionTranscriptRawDeltaResult>;
  cursorStore: TranscriptCursorStore;
  conversationStore: ConversationStore;
  replayKeyStore: UserReplayKeyStore;
  gapStore: TranscriptGapStore;
  log: LcmDependencies["log"];
  yieldToEventLoop?: () => Promise<void>;
};

type PageResult =
  | Extract<SessionTranscriptVisibleMessageDeltaResult, { kind: "page" }>
  | Extract<SessionTranscriptVisibleMessageDeltaResult, { kind: "reset" }>
  | { kind: "stop"; status: Exclude<TranscriptSyncStatus, "synced">; detail?: string };

type ScanPage = { cursorBefore: string | undefined; startIndex: number };

type ScanResult =
  | {
      kind: "complete";
      entries: ScannedVisibleEntry[];
      pages: ScanPage[];
      finalCursor: string;
    }
  | { kind: "reset"; cursor: string; reason: string }
  | { kind: "stop"; status: Exclude<TranscriptSyncStatus, "synced">; detail?: string };

type Counters = {
  imported: number;
  restamped: number;
  heartbeatAck: boolean;
};

/** Per-entry decision applied inside a page transaction. */
type EntryHandler = (
  entry: VisibleSessionTranscriptMessageEntry,
  index: number,
  counters: Counters,
) => Promise<void>;

/** Convert one visible entry into an agent message that carries its transcript meta. */
export function messageFromVisibleEntry(entry: VisibleSessionTranscriptMessageEntry): AgentMessage {
  // Copy so the host-owned payload object is never mutated.
  return attachTranscriptEntryMeta({ ...entry.message } as AgentMessage, {
    entryId: entry.entryId,
    parentId: entry.parentId,
    timestamp: entry.createdAt ?? null,
  });
}

/**
 * Suffix content-match key for an entry: the identity hash the store would
 * compute for its stored role/content plus the tool-call ids its stored parts
 * would carry. Null for non-persisted roles and non-distinguishing entries.
 */
function contentMatchKeyForEntry(entry: VisibleSessionTranscriptMessageEntry): string | null {
  if (!hasPersistableMessageRole(entry.message)) {
    return null;
  }
  const { role, content } = toStoredMessageIdentity(entry.message);
  const toolCallIds = buildMessageParts({ sessionId: "", message: entry.message, fallbackContent: content }).flatMap(
    (part) => (part.toolCallId ? [part.toolCallId] : []),
  );
  return contentMatchKey({
    identityHash: buildMessageIdentityHash(role, content),
    toolCallIds,
    hasContent: content.trim().length > 0,
  });
}

/** Scanned index of `request.importFromEntryId`, or -1 when absent or not visible. */
function importFromIndex(
  request: TranscriptSyncRequest,
  entries: readonly ScannedVisibleEntry[],
): number {
  const entryId = request.importFromEntryId;
  return entryId === undefined ? -1 : entries.findIndex((entry) => entry.entryId === entryId);
}

/** Replay identity of a user entry, or undefined for other roles. */
function userReplayForEntry(entry: VisibleSessionTranscriptMessageEntry): UserReplayIdentity | undefined {
  return entry.message.role === "user" ? observeUserReplayIdentity(entry.message) : undefined;
}

/** Recognize OpenClaw's current-turn read fence by its stable error name. */
function isTranscriptReadFenceError(error: unknown): boolean {
  return error instanceof Error && error.name === "SessionTranscriptReadFenceError";
}

/** Drains OpenClaw's visible transcript delta into one LCM conversation. */
export class TranscriptDeltaSync {
  private readonly yieldToEventLoop: () => Promise<void>;

  constructor(private readonly deps: TranscriptDeltaSyncDeps) {
    this.yieldToEventLoop =
      deps.yieldToEventLoop ?? (() => new Promise<void>((resolve) => setImmediate(resolve)));
  }

  /** Continue from a stored cursor, resyncing in bulk if the host resets it. */
  async drain(
    request: TranscriptSyncRequest,
    state: TranscriptCursorRecord,
  ): Promise<TranscriptSyncOutcome> {
    const counters: Counters = { imported: 0, restamped: 0, heartbeatAck: false };
    let cursor = state.cursor;
    let frontier = { entryId: state.frontierEntryId, seq: state.frontierSeq };
    // Page until the host reports no more visible messages after the cursor.
    for (;;) {
      const page = await this.readPage(request.target, cursor);
      if (page.kind === "stop") {
        return this.stopped("incremental", page.status, counters, frontier.seq, page.detail);
      }
      if (page.kind === "reset") {
        this.deps.log.info(
          `[lcm] transcript cursor reset conversation=${request.conversationId} ${request.label} reason=${page.reason}; resyncing`,
        );
        const outcome = await this.resync(request, page.cursor, {
          unanchored: "match-or-fresh",
          origin: state.origin,
          reason: page.reason,
        });
        return {
          ...outcome,
          importedMessages: outcome.importedMessages + counters.imported,
          importedHeartbeatAck: outcome.importedHeartbeatAck || counters.heartbeatAck,
        };
      }
      const isFinal = !page.hasMore;
      const changed = page.entries.length > 0 || page.cursor !== cursor;
      if (changed || (isFinal && request.finalize)) {
        frontier = await this.commitPage({
          request,
          origin: state.origin,
          cursor: page.cursor,
          entries: page.entries,
          firstIndex: 0,
          frontier,
          counters,
          handle: (entry, _index, pageCounters) =>
            this.applyAppendedEntry(request, entry, pageCounters),
          finalize: isFinal ? request.finalize : undefined,
        });
      }
      if (isFinal) {
        return this.synced("incremental", counters, frontier.seq);
      }
      cursor = page.cursor;
      await this.yieldToEventLoop();
    }
  }

  /**
   * Enter cursor mode for a conversation with zero rows: import the newest
   * bootstrap-budget suffix of the window after the latest same-session reset.
   */
  async freshStart(request: TranscriptSyncRequest): Promise<TranscriptSyncOutcome> {
    const counters: Counters = { imported: 0, restamped: 0, heartbeatAck: false };
    let startCursor: string | undefined;
    for (let attempt = 0; attempt < MAX_RESYNC_ATTEMPTS; attempt += 1) {
      const scan = await this.scan(request.target, startCursor, true);
      if (scan.kind === "reset") {
        startCursor = scan.cursor;
        continue;
      }
      if (scan.kind === "stop") {
        return this.stopped("fresh", scan.status, counters, null, scan.detail);
      }
      const resetStart = await this.resolveResetStart(request, scan.entries);
      let start =
        request.freshStartBudgetTokens === null
          ? resetStart
          : budgetStartIndex(scan.entries, resetStart, request.freshStartBudgetTokens);
      const includeIndex = importFromIndex(request, scan.entries);
      if (includeIndex >= 0) {
        start = Math.min(start, Math.max(includeIndex, resetStart));
      }
      const written = await this.writeFrom({
        request,
        origin: "fresh",
        scan,
        startIndex: start,
        counters,
        handle: (entry, _index, pageCounters) =>
          this.applyAppendedEntry(request, entry, pageCounters),
      });
      if (written.kind === "reset") {
        startCursor = written.cursor ?? startCursor;
        continue;
      }
      if (written.kind === "stop") {
        return this.stopped("fresh", written.status, counters, null, written.detail);
      }
      this.deps.log.info(
        `[lcm] transcript cursor mode entered conversation=${request.conversationId} ${request.label} origin=fresh visible=${scan.entries.length} postResetStart=${resetStart} importStart=${start} imported=${counters.imported}`,
      );
      return this.synced("fresh", counters, written.frontierSeq);
    }
    return this.stopped("fresh", "blocked", counters, null, "transcript kept changing during fresh start");
  }

  /**
   * Re-establish the watermark from a fresh host cursor and reconcile in bulk.
   *
   * One stored-id query plus a payload-free scan decides the import window:
   * entries after the last known (or supersedes-restamped) visible id, or,
   * with no anchor, the post-reset window handled per `UnanchoredResyncPolicy`.
   * Window entries are content-matched in order against stored rows whose
   * ids left the projection or were never stamped: matches restamp, and only
   * entries after the last match import, so history is never appended out of
   * order. Resync only adds or re-issues ids; it never clears an id or
   * deletes a row.
   */
  async resync(
    request: TranscriptSyncRequest,
    startCursor: string | undefined,
    options: { unanchored: UnanchoredResyncPolicy; origin: TranscriptCursorOrigin; reason: string },
  ): Promise<TranscriptSyncOutcome> {
    const counters: Counters = { imported: 0, restamped: 0, heartbeatAck: false };
    let cursor = startCursor;
    for (let attempt = 0; attempt < MAX_RESYNC_ATTEMPTS; attempt += 1) {
      const scan = await this.scan(request.target, cursor, false);
      if (scan.kind === "reset") {
        cursor = scan.cursor;
        continue;
      }
      if (scan.kind === "stop") {
        return this.stopped("resync", scan.status, counters, null, scan.detail, options.reason);
      }
      const stored = this.deps.cursorStore.listStampedRows(request.conversationId);
      const plan = planResync(scan.entries, stored);
      const gaps = findHistoryGaps(scan.entries, plan.knownRows, (lowSeq, highSeq) =>
        this.deps.cursorStore.countRowsBetweenSeq(request.conversationId, lowSeq, highSeq),
      );
      let newGaps = 0;
      const visibleIds = new Set(scan.entries.map((entry) => entry.entryId));
      const claimed = new Set([...plan.restamps.values()].map((row) => row.messageId));

      // The import window starts after the last known id; without an anchor
      // it is the post-reset window (or empty for legacy migration).
      const anchored = plan.lastKnownIndex >= 0;
      const windowStart = anchored
        ? plan.lastKnownIndex + 1
        : options.unanchored !== "skip"
          ? await this.resolveResetStart(request, scan.entries)
          : scan.entries.length;
      const rows =
        windowStart < scan.entries.length
          ? this.listUnclaimedRowsAfter(request, anchored ? (plan.anchorRowSeq ?? 0) : 0, visibleIds, claimed)
          : [];
      const needsTokens = !anchored && windowStart < scan.entries.length;
      const matched =
        rows.length > 0 || needsTokens
          ? await this.matchWindow(request, scan, windowStart, new SuffixContentMatcher(rows), needsTokens)
          : { kind: "done" as const, matches: new Map<number, StoredTranscriptRow>(), multiCandidateClaims: 0 };
      if (matched.kind === "reset") {
        cursor = matched.cursor ?? cursor;
        continue;
      }
      if (matched.kind === "stop") {
        return this.stopped("resync", matched.status, counters, null, matched.detail, options.reason);
      }

      // Matched entries restamp; only entries after the last match import.
      const matchIndexes = [...matched.matches.keys()];
      const lastMatch = matchIndexes.reduce((max, index) => Math.max(max, index), -1);
      const firstMatch = matchIndexes.reduce((min, index) => Math.min(min, index), scan.entries.length);
      const start =
        lastMatch >= 0
          ? firstMatch
          : !anchored && options.unanchored === "match-only"
            ? scan.entries.length
            : needsTokens && request.freshStartBudgetTokens !== null
              ? budgetStartIndex(scan.entries, windowStart, request.freshStartBudgetTokens)
              : windowStart;
      // A known-new committed range imports even before the last match, but
      // never before the window: nothing imports ahead of the anchor.
      const requestedIndex = importFromIndex(request, scan.entries);
      const includeIndex = requestedIndex >= 0 ? Math.max(requestedIndex, windowStart) : -1;
      const importStart = includeIndex >= 0 ? Math.min(start, includeIndex) : start;
      const handle: EntryHandler = (entry, index, pageCounters) =>
        this.applyWindowEntry({
          request,
          entry,
          index,
          importAfter: includeIndex >= 0 ? Math.min(lastMatch, includeIndex - 1) : lastMatch,
          matches: matched.matches,
          counters: pageCounters,
        });
      const matchSummary = () =>
        `windowStart=${windowStart} contentMatches=${matchIndexes.length} multiCandidateMatches=${matched.multiCandidateClaims}`;

      const written = await this.writeFrom({
        request,
        origin: options.origin,
        scan,
        startIndex: importStart,
        counters,
        beforeFirstPage: async (pageCounters) => {
          newGaps += this.deps.gapStore.record(request.conversationId, gaps, options.reason);
          this.recordScannedReplayKeys(request.conversationId, scan.entries, stored, visibleIds);
          await this.applyPlannedRestamps(scan.entries, plan.restamps, pageCounters);
        },
        handle,
      });
      if (written.kind === "reset") {
        cursor = written.cursor ?? cursor;
        continue;
      }
      if (written.kind === "stop") {
        return this.stopped("resync", written.status, counters, null, written.detail, options.reason);
      }
      const summary: ResyncSummary = {
        visibleEntries: scan.entries.length,
        anchorIndex: plan.lastKnownIndex,
        contentMatches: matchIndexes.length,
        supersedesRestamps: plan.restamps.size,
        unimportedBeforeAnchor: plan.unimportedBeforeAnchor,
        unstampedRowsBeforeAnchor:
          plan.anchorRowSeq === null
            ? 0
            : this.deps.cursorStore.countUnstampedRowsThroughSeq(request.conversationId, plan.anchorRowSeq),
        historyGaps: gaps.length,
        historyGapEntries: gaps.reduce((total, gap) => total + gap.entryCount, 0),
        newHistoryGaps: newGaps,
      };
      this.deps.log.info(
        `[lcm] transcript resync conversation=${request.conversationId} ${request.label} reason=${options.reason} visible=${scan.entries.length} anchorIndex=${plan.lastKnownIndex} importStart=${importStart} imported=${counters.imported} restamped=${counters.restamped} supersedesRestamps=${plan.restamps.size} unimportedBeforeAnchor=${plan.unimportedBeforeAnchor} unstampedRowsBeforeAnchor=${summary.unstampedRowsBeforeAnchor} historyGaps=${gaps.length} ${matchSummary()}`,
      );
      if (newGaps > 0) {
        this.warnHistoryGaps(request, options.reason, gaps, newGaps);
      }
      return {
        ...this.synced("resync", counters, written.frontierSeq),
        resetReason: options.reason,
        resync: summary,
      };
    }
    return this.stopped("resync", "blocked", counters, null, "transcript kept changing during resync", options.reason);
  }

  /**
   * Warn once when a resync records new history-gap markers: those entries
   * were never stored, sit before the anchor, and are never imported
   * automatically, so recall and summaries do not cover them.
   */
  private warnHistoryGaps(
    request: TranscriptSyncRequest,
    reason: string,
    gaps: readonly TranscriptHistoryGap[],
    newGaps: number,
  ): void {
    const entries = gaps.reduce((total, gap) => total + gap.entryCount, 0);
    const largest = gaps.reduce((max, gap) => Math.max(max, gap.entryCount), 0);
    this.deps.log.warn(
      `[lcm] transcript history gaps recorded conversation=${request.conversationId} ${request.label} reason=${reason} newGaps=${newGaps} gaps=${gaps.length} entries=${entries} largestGap=${largest}; these transcript entries were never stored and are not imported automatically (see /lcm doctor)`,
    );
  }

  /**
   * Refresh the stored replay keys from a complete scan: every visible user
   * entry records its current key, and stored ids that left the projection
   * record '' so assembly never restores replay identity for them.
   */
  private recordScannedReplayKeys(
    conversationId: number,
    entries: readonly ScannedVisibleEntry[],
    stored: ReadonlyMap<string, StoredTranscriptRow>,
    visibleIds: ReadonlySet<string>,
  ): void {
    const keys: TranscriptUserReplayKey[] = [];
    for (const entry of entries) {
      if (entry.userReplay) {
        keys.push({ entryId: entry.entryId, ...entry.userReplay });
      }
    }
    for (const entryId of stored.keys()) {
      if (!visibleIds.has(entryId)) {
        keys.push({ entryId, idempotencyKey: "", signature: "" });
      }
    }
    this.deps.replayKeyStore.record(conversationId, keys);
  }

  /** Restamp rows whose stored id a visible entry declares it supersedes. */
  private async applyPlannedRestamps(
    entries: readonly ScannedVisibleEntry[],
    restamps: ReadonlyMap<number, StoredTranscriptRow>,
    counters: Counters,
  ): Promise<void> {
    for (const [index, row] of restamps) {
      if (await this.deps.conversationStore.restampTranscriptEntryId(row.messageId, entries[index]!.entryId)) {
        counters.restamped += 1;
      }
    }
  }

  /**
   * Read-only pass over the window: claim in-order content matches without
   * writing so the caller knows the last matched index before importing, and
   * optionally record storage token estimates for a fresh-start budget.
   */
  private async matchWindow(
    request: TranscriptSyncRequest,
    scan: Extract<ScanResult, { kind: "complete" }>,
    windowStart: number,
    matcher: SuffixContentMatcher,
    collectTokens: boolean,
  ): Promise<
    | { kind: "done"; matches: Map<number, StoredTranscriptRow>; multiCandidateClaims: number }
    | { kind: "reset"; cursor?: string }
    | { kind: "stop"; status: Exclude<TranscriptSyncStatus, "synced">; detail?: string }
  > {
    const matches = new Map<number, StoredTranscriptRow>();
    const replayed = await this.replayFrom(request.target, scan, windowStart, async (page, firstIndex) => {
      for (let offset = 0; offset < page.entries.length; offset += 1) {
        const index = firstIndex + offset;
        if (index < windowStart || index >= scan.entries.length) {
          continue;
        }
        const entry = page.entries[offset]!;
        if (collectTokens) {
          scan.entries[index]!.tokens = hasPersistableMessageRole(entry.message)
            ? Math.max(1, toStoredMessage(entry.message).tokenCount)
            : 0;
        }
        const key = matcher.isEmpty ? null : contentMatchKeyForEntry(entry);
        const row = key ? matcher.claim(key) : null;
        if (row) {
          matches.set(index, row);
        }
      }
    });
    return replayed.kind === "done"
      ? { kind: "done", matches, multiCandidateClaims: matcher.multiCandidateClaims }
      : replayed;
  }

  /** Read one page, growing the byte bound for a single oversized entry. */
  private async readPage(
    target: SessionTranscriptReadTarget,
    cursor: string | undefined,
  ): Promise<PageResult> {
    let maxBytes = PAGE_MAX_BYTES;
    for (;;) {
      let result: SessionTranscriptVisibleMessageDeltaResult;
      try {
        result = await this.deps.readVisibleDelta({
          ...target,
          ...(cursor !== undefined ? { cursor } : {}),
          maxBytes,
          maxMessages: PAGE_MAX_MESSAGES,
        });
      } catch (error) {
        if (isTranscriptReadFenceError(error)) {
          return { kind: "stop", status: "fenced", detail: (error as Error).message };
        }
        throw error;
      }
      if (result.kind === "unavailable") {
        return { kind: "stop", status: "unavailable", detail: result.reason };
      }
      if (result.kind === "missing") {
        return { kind: "stop", status: "missing" };
      }
      if (result.kind === "page" && result.entries.length === 0 && result.hasMore) {
        const required = result.requiredBytes ?? maxBytes * 2;
        if (required > PAGE_HARD_MAX_BYTES) {
          return {
            kind: "stop",
            status: "blocked",
            detail: `visible transcript entry needs ${required} bytes, above the ${PAGE_HARD_MAX_BYTES}-byte page cap`,
          };
        }
        maxBytes = Math.max(maxBytes, required);
        continue;
      }
      return result;
    }
  }

  /** Scan the whole visible projection from `startCursor`, retaining no payloads. */
  private async scan(
    target: SessionTranscriptReadTarget,
    startCursor: string | undefined,
    collectTokens: boolean,
  ): Promise<ScanResult> {
    const entries: ScannedVisibleEntry[] = [];
    const pages: ScanPage[] = [];
    let cursor = startCursor;
    for (;;) {
      const page = await this.readPage(target, cursor);
      if (page.kind !== "page") {
        return page.kind === "reset"
          ? { kind: "reset", cursor: page.cursor, reason: page.reason }
          : page;
      }
      pages.push({ cursorBefore: cursor, startIndex: entries.length });
      for (const entry of page.entries) {
        const userReplay = userReplayForEntry(entry);
        entries.push({
          entryId: entry.entryId,
          parentId: entry.parentId,
          seq: entry.seq,
          ...(typeof entry.supersedesEntryId === "string" && entry.supersedesEntryId
            ? { supersedesEntryId: entry.supersedesEntryId }
            : {}),
          tokens:
            collectTokens && hasPersistableMessageRole(entry.message)
              ? Math.max(1, toStoredMessage(entry.message).tokenCount)
              : 0,
          ...(userReplay ? { userReplay } : {}),
          gapEligible: isGapEligibleMessage(entry.message),
        });
      }
      cursor = page.cursor;
      if (!page.hasMore) {
        return { kind: "complete", entries, pages, finalCursor: page.cursor };
      }
      await this.yieldToEventLoop();
    }
  }

  /**
   * Re-read the projection from the scanned page that holds `startIndex` to
   * the frontier, calling `onPage` for each page. A re-read that does not
   * replay the scanned ids exactly reports `reset` without a cursor, meaning
   * "restart from the same start cursor"; a host reset reports its cursor.
   */
  private async replayFrom(
    target: SessionTranscriptReadTarget,
    scan: Extract<ScanResult, { kind: "complete" }>,
    startIndex: number,
    onPage: (
      page: Extract<SessionTranscriptVisibleMessageDeltaResult, { kind: "page" }>,
      firstIndex: number,
      isFinal: boolean,
    ) => Promise<void>,
  ): Promise<
    | { kind: "done" }
    | { kind: "reset"; cursor?: string }
    | { kind: "stop"; status: Exclude<TranscriptSyncStatus, "synced">; detail?: string }
  > {
    // Locate the scan page holding startIndex and resume from the cursor before it.
    let pageIndex = scan.pages.length - 1;
    while (pageIndex > 0 && scan.pages[pageIndex]!.startIndex > startIndex) {
      pageIndex -= 1;
    }
    let cursor = scan.pages[pageIndex]!.cursorBefore;
    let index = scan.pages[pageIndex]!.startIndex;
    for (;;) {
      const page = await this.readPage(target, cursor);
      if (page.kind === "stop") {
        return page;
      }
      if (page.kind === "reset") {
        return { kind: "reset", cursor: page.cursor };
      }
      for (let offset = 0; offset < page.entries.length; offset += 1) {
        const scanned = scan.entries[index + offset];
        if (scanned && scanned.entryId !== page.entries[offset]!.entryId) {
          return { kind: "reset" };
        }
      }
      const isFinal = !page.hasMore;
      await onPage(page, index, isFinal);
      index += page.entries.length;
      if (isFinal) {
        return { kind: "done" };
      }
      cursor = page.cursor;
      await this.yieldToEventLoop();
    }
  }

  /**
   * Apply `handle` to every entry at or after `startIndex`, committing rows
   * and cursor per page. When nothing needs re-reading, the scan's final
   * cursor is committed directly in one transaction.
   */
  private async writeFrom(params: {
    request: TranscriptSyncRequest;
    origin: TranscriptCursorOrigin;
    scan: Extract<ScanResult, { kind: "complete" }>;
    startIndex: number;
    counters: Counters;
    handle: EntryHandler;
    beforeFirstPage?: (counters: Counters) => Promise<void>;
  }): Promise<
    | { kind: "done"; frontierSeq: number | null }
    | { kind: "reset"; cursor?: string }
    | { kind: "stop"; status: Exclude<TranscriptSyncStatus, "synced">; detail?: string }
  > {
    const { request, scan } = params;
    const last = scan.entries.at(-1);
    let frontier = { entryId: last?.entryId ?? null, seq: last?.seq ?? null };
    if (params.startIndex >= scan.entries.length) {
      frontier = await this.commitPage({
        request,
        origin: params.origin,
        cursor: scan.finalCursor,
        entries: [],
        firstIndex: scan.entries.length,
        frontier,
        counters: params.counters,
        handle: params.handle,
        beforeEntries: params.beforeFirstPage,
        finalize: request.finalize,
      });
      return { kind: "done", frontierSeq: frontier.seq };
    }

    let beforeEntries = params.beforeFirstPage;
    const replayed = await this.replayFrom(request.target, scan, params.startIndex, async (page, firstIndex, isFinal) => {
      frontier = await this.commitPage({
        request,
        origin: params.origin,
        cursor: page.cursor,
        entries: page.entries,
        firstIndex,
        skipBefore: Math.max(0, params.startIndex - firstIndex),
        frontier,
        counters: params.counters,
        handle: params.handle,
        beforeEntries,
        finalize: isFinal ? request.finalize : undefined,
      });
      beforeEntries = undefined;
    });
    return replayed.kind === "done" ? { kind: "done", frontierSeq: frontier.seq } : replayed;
  }

  /**
   * Apply one page in a single transaction: run the entry handler for every
   * entry at or after `skipBefore`, persist the advanced cursor, and run the
   * optional finalizer. Returns the new frontier.
   */
  private async commitPage(params: {
    request: TranscriptSyncRequest;
    origin: TranscriptCursorOrigin;
    cursor: string;
    entries: VisibleSessionTranscriptMessageEntry[];
    firstIndex: number;
    skipBefore?: number;
    frontier: { entryId: string | null; seq: number | null };
    counters: Counters;
    handle: EntryHandler;
    beforeEntries?: (counters: Counters) => Promise<void>;
    finalize?: TranscriptSyncRequest["finalize"];
  }): Promise<{ entryId: string | null; seq: number | null }> {
    const lastEntry = params.entries.at(-1);
    const frontier = lastEntry
      ? { entryId: lastEntry.entryId, seq: lastEntry.seq }
      : params.frontier;
    await this.deps.conversationStore.withTransaction(async () => {
      // Counters merge only after commit so a rolled-back page reports nothing.
      const pageCounters: Counters = { imported: 0, restamped: 0, heartbeatAck: false };
      await params.beforeEntries?.(pageCounters);
      const importedMessages: AgentMessage[] = [];
      const replayKeys: TranscriptUserReplayKey[] = [];
      for (let offset = params.skipBefore ?? 0; offset < params.entries.length; offset += 1) {
        const before = pageCounters.imported;
        const entry = params.entries[offset]!;
        await params.handle(entry, params.firstIndex + offset, pageCounters);
        if (pageCounters.imported > before) {
          importedMessages.push(entry.message);
        }
        const userReplay = userReplayForEntry(entry);
        if (userReplay) {
          replayKeys.push({ entryId: entry.entryId, ...userReplay });
        }
      }
      this.deps.replayKeyStore.record(params.request.conversationId, replayKeys);
      pageCounters.heartbeatAck = batchLooksLikeHeartbeatAckTurn(importedMessages);
      this.deps.cursorStore.upsert({
        conversationId: params.request.conversationId,
        cursor: params.cursor,
        frontierEntryId: frontier.entryId,
        frontierSeq: frontier.seq,
        origin: params.origin,
      });
      await params.finalize?.({
        frontierSeq: frontier.seq,
        importedMessages: params.counters.imported + pageCounters.imported,
      });
      params.counters.imported += pageCounters.imported;
      params.counters.restamped += pageCounters.restamped;
      params.counters.heartbeatAck ||= pageCounters.heartbeatAck;
    });
    return frontier;
  }

  /**
   * Steady-state policy for one appended entry: skip ids already stored,
   * restamp a stored predecessor named by `supersedesEntryId`, else ingest.
   */
  private async applyAppendedEntry(
    request: TranscriptSyncRequest,
    entry: VisibleSessionTranscriptMessageEntry,
    counters: Counters,
  ): Promise<void> {
    const store = this.deps.conversationStore;
    const conversationId = request.conversationId;
    if (await store.hasMessageByTranscriptEntryId(conversationId, entry.entryId)) {
      return;
    }
    const predecessor =
      typeof entry.supersedesEntryId === "string" && entry.supersedesEntryId
        ? await store.getTranscriptEntryAnchorCandidate(conversationId, entry.supersedesEntryId)
        : null;
    if (predecessor) {
      if (
        await store.restampTranscriptEntryId(
          predecessor.messageId,
          entry.entryId,
          extractOpenClawSenderMetadata(entry.message),
        )
      ) {
        counters.restamped += 1;
      }
      return;
    }
    if (await request.ingest(messageFromVisibleEntry(entry))) {
      counters.imported += 1;
    }
  }

  /**
   * Resync window policy: restamp content-matched entries, import entries
   * after the last match (including entries appended after the scan), and
   * leave unmatched entries inside the matched span unimported because
   * appending them would reorder history; their rows already hold the older
   * content under the superseded ids.
   */
  private async applyWindowEntry(params: {
    request: TranscriptSyncRequest;
    entry: VisibleSessionTranscriptMessageEntry;
    index: number;
    /** Unmatched entries import only after this index. */
    importAfter: number;
    matches: ReadonlyMap<number, StoredTranscriptRow>;
    counters: Counters;
  }): Promise<void> {
    const row = params.matches.get(params.index);
    if (row) {
      if (
        await this.deps.conversationStore.restampTranscriptEntryId(
          row.messageId,
          params.entry.entryId,
          extractOpenClawSenderMetadata(params.entry.message),
        )
      ) {
        params.counters.restamped += 1;
      }
      return;
    }
    if (params.index > params.importAfter) {
      await this.applyAppendedEntry(params.request, params.entry, params.counters);
    }
  }

  /** Stored rows after `afterSeq` whose ids left the projection or were never stamped. */
  private listUnclaimedRowsAfter(
    request: TranscriptSyncRequest,
    afterSeq: number,
    visibleIds: ReadonlySet<string>,
    claimed: ReadonlySet<number>,
  ): ContentMatchCandidate[] {
    return this.deps.cursorStore
      .listContentMatchCandidatesAfterSeq(request.conversationId, afterSeq)
      .filter(
        (row) =>
          !claimed.has(row.messageId) &&
          (row.transcriptEntryId === null || !visibleIds.has(row.transcriptEntryId)),
      );
  }

  /**
   * Index of the first visible entry after the latest on-path `/reset`, found
   * from the raw event stream. Returns 0 when no gap could hide a reset or when
   * the raw stream is unreadable (logged).
   */
  private async resolveResetStart(
    request: TranscriptSyncRequest,
    entries: readonly ScannedVisibleEntry[],
  ): Promise<number> {
    // A reset can trail a gapless visible list, so only an empty list skips the scan.
    if (entries.length === 0) {
      return 0;
    }
    if (!this.deps.readRawDelta) {
      this.deps.log.debug(
        `[lcm] transcript reset boundary unknown conversation=${request.conversationId} ${request.label}: raw transcript reader unavailable`,
      );
      return 0;
    }
    const navigation = await collectRawTranscriptNavigation({
      read: this.deps.readRawDelta,
      target: request.target,
      yieldToEventLoop: this.yieldToEventLoop,
    });
    if (!navigation) {
      this.deps.log.warn(
        `[lcm] transcript reset boundary unknown conversation=${request.conversationId} ${request.label}: raw transcript scan incomplete`,
      );
      return 0;
    }
    return resolvePostResetStartIndex(entries, navigation);
  }

  private synced(
    path: TranscriptSyncPath,
    counters: Counters,
    frontierSeq: number | null,
  ): TranscriptSyncOutcome {
    return {
      status: "synced",
      path,
      importedMessages: counters.imported,
      restampedMessages: counters.restamped,
      frontierSeq,
      importedHeartbeatAck: counters.heartbeatAck,
    };
  }

  private stopped(
    path: TranscriptSyncPath,
    status: Exclude<TranscriptSyncStatus, "synced">,
    counters: Counters,
    frontierSeq: number | null,
    detail?: string,
    resetReason?: string,
  ): TranscriptSyncOutcome {
    return {
      status,
      path,
      importedMessages: counters.imported,
      restampedMessages: counters.restamped,
      frontierSeq,
      importedHeartbeatAck: counters.heartbeatAck,
      ...(detail ? { detail } : {}),
      ...(resetReason ? { resetReason } : {}),
    };
  }
}
