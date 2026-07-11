/**
 * Transcript reconciliation: aligns the session JSONL transcript (host ground
 * truth) with the persisted LCM conversation. Covers bootstrap/after-turn
 * tail reconciliation by entry id and by content identity, append-only read
 * optimization, replay/flood analysis, and bootstrap-state refresh.
 *
 * Extracted from engine.ts (Phase 4 of the engine decomposition). The
 * bootstrap-path (reconcileSessionTail) and after-turn-path
 * (reconcileTranscriptTailForAfterTurnInSessionQueue) overlap is real but
 * not mechanical; unifying them is follow-up work tracked in #867.
 */
import type { DatabaseSync } from "node:sqlite";
import type { LcmConfig } from "./db/config.js";
import type { AgentMessage, IngestResult } from "./openclaw-bridge.js";
import type { TranscriptReconcileResult } from "./reconcile-plan.js";
import { SessionRolloverDetector } from "./session-rollover.js";
import type { ConversationRecord, ConversationStore } from "./store/conversation-store.js";
import type { SummaryStore } from "./store/summary-store.js";
import type { LcmDependencies } from "./types.js";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { trimBootstrapMessagesToBudget, resolveBootstrapMaxTokens } from "./bootstrap-budget.js";
import { batchLooksLikeHeartbeatAckTurn, filterSyntheticHeartbeatMessages } from "./heartbeat-filter.js";
import {
  buildMessageParts,
  isLikelyInjectedDeliveryOnlyTranscript,
  isLikelyInjectedMetadataPreambleRecord,
  toStoredMessage,
  type StoredMessage,
} from "./message-content.js";
import { isOpenClawAmbientInboundRecord } from "./openclaw-inbound-metadata.js";
import {
  createBootstrapEntryHash,
  createLosslessMessageSignature,
  isBootstrapReplayCandidateMessage,
  messageIdentity,
} from "./message-signatures.js";
import { resolveEpochRoute, selectEntryIdTail, transcriptImportCap } from "./reconcile-plan.js";
import { isBaseChannelSessionKey, isIsolatedCronSessionKey, sessionKeyChannelScope } from "./session-patterns.js";
import {
  externalizedReplayMetadataMatches,
  extractPlainToolReplayTextsById,
  extractRawBlockIdsFromPartMetadata,
  extractRawBlockSignatureFromPartMetadata,
  extractRawIdsFromPartMetadata,
} from "./replay-metadata.js";
import { buildMessageIdentityHash } from "./store/message-identity.js";
import {
  getTranscriptEntryId,
  getTranscriptEntryMeta,
  readAppendedLeafPathMessages,
  readLastJsonlEntryBeforeOffset,
  readLeafPathMessages,
  readTranscriptHeader,
  resolveTranscriptMessageCreatedAt,
  resolveTranscriptMessageInnerTimestamp,
} from "./transcript.js";
import { asRecord, formatDurationMs, isMissingFileError, safeString } from "./value-utils.js";

/**
 * How deep into the conversation tail a flush-lagged runtime row can sit.
 * Flush lag is a same-turn phenomenon (the runtime persisted a row moments
 * before the transcript caught up), so matches deeper than this are legacy
 * unstamped rows, not flush lag.
 */
const FLUSH_LAG_ADOPTION_TAIL_WINDOW = 16;

// Upper bound on the persisted-frontier scan used to decide placeholder-checkpoint
// recovery eligibility (#822). A genuinely stuck placeholder frontier is a handful
// of injected-metadata rows; a frontier larger than this conservatively freezes
// rather than scan an arbitrarily large real DB tail (#649 no-proof-no-advance).
const NON_ANCHORING_FRONTIER_SCAN_LIMIT = 32;

// No-anchor recovery reasons that can proceed from checkpoint/frontier metadata
// instead of a content anchor. Block them if raw IDs are already owned by another
// active conversation.
const CROSS_CONVERSATION_RAW_ID_GUARDED_NO_ANCHOR_REASONS = new Set([
  "same-path-shrink",
  "checkpoint-missing-recovery",
  "rotate-checkpoint-missing",
  "placeholder-checkpoint-recovery",
]);

export type BootstrapCheckpointFileState = {
  lastProcessedOffset: number;
  lastSeenSize: number;
};

export function checkpointIsPastTranscriptEof(
  checkpoint: BootstrapCheckpointFileState | null | undefined,
  fileSize: number,
): boolean {
  if (!checkpoint) {
    return false;
  }
  return checkpoint.lastProcessedOffset > fileSize || checkpoint.lastSeenSize > fileSize;
}

/** The slice of LcmContextEngine that transcript reconciliation depends on. */
export type ReconcileHost = {
  readonly config: LcmConfig;
  readonly db: DatabaseSync;
  readonly deps: LcmDependencies;
  readonly conversationStore: ConversationStore;
  readonly summaryStore: SummaryStore;
  shouldIgnoreSession(params: { sessionId?: string; sessionKey?: string }): boolean;
  resolveSessionQueueKey(sessionId?: string, sessionKey?: string): string;
  withSessionQueue<T>(
    queueKey: string,
    operation: () => Promise<T>,
    options?: { operationName?: string; context?: string },
  ): Promise<T>;
  formatSessionLogContext(params: {
    conversationId: number;
    sessionId: string;
    sessionKey?: string;
  }): string;
  recordRecentBootstrapImport(
    conversationId: number,
    importedMessages: number,
    reason: string | null,
  ): void;
  ingestSingle(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
    createdAt?: Date | string;
    skipReplayTimestampFloodGuard?: boolean;
  }): Promise<IngestResult>;
};

export class TranscriptReconciler {
  /** Last file state successfully covered by `reconcileTranscriptTailForAfterTurn`
   *  slow-path full re-reads, keyed by `${sessionQueueKey}\u0000${sessionFile}`
   *  (same NUL-escape separator pattern as `messageIdentity`). Long-running
   *  sessions where the bootstrap checkpoint is missing or path-mismatched
   *  would otherwise pay O(file-size) on every afterTurn; repeated attempts
   *  for the same unchanged file state are skipped.
   *
   *  Bounded with FIFO eviction at `AFTER_TURN_RECONCILE_KEY_CAP` entries
   *  so hosts churning through many sessions/files don't accumulate this
   *  map indefinitely. When the cap is exceeded we drop the oldest entry
   *  (Map iteration order is insertion order in JS); a session whose
   *  entry eventually evicts may pay the slow path once again, which is
   *  acceptable since the bound is well above realistic concurrent-session
   *  counts. */
  private afterTurnReconcileFullReadStates = new Map<string, { size: number; mtimeMs: number }>();
  private static readonly AFTER_TURN_RECONCILE_KEY_CAP = 4096;

  constructor(
    private readonly host: ReconcileHost,
    private readonly rolloverDetector: SessionRolloverDetector,
  ) {}

  async analyzePersistedTranscriptIdentityOverlaps(params: {
    conversationId: number;
    messages: AgentMessage[];
  }): Promise<{ overlaps: number; firstNonOverlappingIndex: number }> {
    const existingCounts = new Map<string, number>();
    const seenCounts = new Map<string, number>();
    let overlaps = 0;
    let firstNonOverlappingIndex = -1;

    for (const [index, message] of params.messages.entries()) {
      const stored = toStoredMessage(message);
      const key = `${stored.role}\u0000${stored.content}`;
      const seen = (seenCounts.get(key) ?? 0) + 1;
      seenCounts.set(key, seen);

      let existing = existingCounts.get(key);
      if (existing === undefined) {
        existing = await this.host.conversationStore.countMessagesByIdentity(
          params.conversationId,
          stored.role,
          stored.content,
        );
        existingCounts.set(key, existing);
      }

      if (seen <= existing) {
        overlaps += 1;
      } else if (firstNonOverlappingIndex < 0) {
        firstNonOverlappingIndex = index;
      }
    }

    return { overlaps, firstNonOverlappingIndex };
  }

  private async countPersistedTranscriptIdentityOverlaps(params: {
    conversationId: number;
    messages: AgentMessage[];
  }): Promise<number> {
    const analysis = await this.analyzePersistedTranscriptIdentityOverlaps(params);
    return analysis.overlaps;
  }

  async appendOnlyMessagesOverlapPersistedTranscript(params: {
    conversationId: number;
    messages: AgentMessage[];
    /**
     * The appended slice BEFORE replay/heartbeat filtering. Filtered-out
     * entries are legitimate parents for surviving entries, so the linear-
     * chain check consults their ids to avoid false rewrite verdicts.
     */
    unfilteredMessages?: AgentMessage[];
    sessionContext: string;
    source: string;
  }): Promise<boolean> {
    // Entry-id-bearing messages are judged by id, not content identity: a
    // fresh entry id is a NEW entry even when its content is byte-identical
    // to persisted history. Repeated identical tool calls are legitimate
    // (lossless-claw-3071: a tool loop re-reading the same file made the
    // identity check scream "already persisted" every iteration, forcing a
    // full re-read per tool call). Two cases still defer to full
    // reconciliation: an already-persisted entry id (genuine replay), and a
    // fresh id whose content matches an UNSTAMPED persisted row (flush-lag
    // catch-up — the full path adopts the id onto that row instead of
    // importing a duplicate).
    const idLessMessages: AgentMessage[] = [];
    let persistedEntryIdOverlaps = 0;
    let adoptableFlushLagOverlaps = 0;
    for (const message of params.messages) {
      const entryId = getTranscriptEntryId(message);
      if (entryId === null) {
        idLessMessages.push(message);
        continue;
      }
      if (
        await this.host.conversationStore.hasMessageByTranscriptEntryId(
          params.conversationId,
          entryId,
        )
      ) {
        persistedEntryIdOverlaps += 1;
        continue;
      }
      const stored = toStoredMessage(message);
      // Empty stored content (pure tool-call rows) matches trivially against
      // legacy unstamped rows and proves nothing — and "adopting" onto a
      // random old empty row would mis-stamp it. Only non-empty identities
      // indicate a real flush-lagged runtime row.
      if (stored.content.trim().length === 0) {
        continue;
      }
      if (
        await this.host.conversationStore.hasRecentUnstampedMessageByIdentity(
          params.conversationId,
          stored.role,
          stored.content,
          FLUSH_LAG_ADOPTION_TAIL_WINDOW,
        )
      ) {
        adoptableFlushLagOverlaps += 1;
      }
    }
    if (persistedEntryIdOverlaps > 0 || adoptableFlushLagOverlaps > 0) {
      this.host.deps.log.warn(
        `[lcm] transcript import guard: ${params.source} found ${persistedEntryIdOverlaps} already-persisted transcript entry ids and ${adoptableFlushLagOverlaps} adoptable flush-lagged identities across ${params.messages.length} messages for ${params.sessionContext}; falling back to full reconciliation`,
      );
      return true;
    }
    // Fresh ids must also EXTEND the persisted tail rather than branch from
    // an ancestor: a host history rewrite re-issues content under new ids by
    // reparenting onto an OLDER persisted entry, and those entries need the
    // full path's stale-id re-stamping, not a blind append. The rewrite
    // signature is a parent that IS persisted but is NOT the tip and not
    // part of this appended slice. Parents unknown to the DB are benign —
    // the append-only checkpoint already verified the file prefix, and
    // pruned rows, replay-filtered entries, and flush gaps all leave
    // unknown-parent links that are genuine continuation.
    if (params.messages.length > idLessMessages.length) {
      const newestPersistedEntryId = await this.host.conversationStore.getNewestTranscriptEntryId(
        params.conversationId,
      );
      if (newestPersistedEntryId !== null) {
        const sliceEntryIds = new Set<string>();
        for (const message of params.unfilteredMessages ?? params.messages) {
          const entryId = getTranscriptEntryMeta(message)?.entryId;
          if (entryId) {
            sliceEntryIds.add(entryId);
          }
        }
        for (const message of params.messages) {
          const meta = getTranscriptEntryMeta(message);
          const parentId = meta?.parentId ?? null;
          if (
            parentId === null ||
            parentId === newestPersistedEntryId ||
            sliceEntryIds.has(parentId)
          ) {
            continue;
          }
          if (
            await this.host.conversationStore.hasMessageByTranscriptEntryId(
              params.conversationId,
              parentId,
            )
          ) {
            this.host.deps.log.warn(
              `[lcm] transcript import guard: ${params.source} appended entry reparents onto a non-tip persisted entry (suffix rewrite) for ${params.sessionContext}; falling back to full reconciliation`,
            );
            return true;
          }
        }
      }
    }
    if (idLessMessages.length === 0) {
      return false;
    }

    const overlaps = await this.countPersistedTranscriptIdentityOverlaps({
      conversationId: params.conversationId,
      messages: idLessMessages,
    });
    if (overlaps === 0) {
      return false;
    }

    this.host.deps.log.warn(
      `[lcm] transcript import guard: ${params.source} found ${overlaps}/${idLessMessages.length} already-persisted message identities (id-less entries) for ${params.sessionContext}; falling back to full reconciliation`,
    );
    return true;
  }

  /**
   * Reconcile session-file history with persisted messages and append only the
   * tail that is present in JSONL but missing from LCM.
   */
  /**
   * Exact reconciliation for transcripts whose entries all carry stable
   * envelope ids: anchor on the checkpoint's last processed entry id (or the
   * newest id already persisted), then import only the tail entries whose
   * ids are missing — adopting identity-matched rows that were persisted
   * without an id (runtime flush lag, pre-migration data) instead of
   * importing duplicates. Entry-id matching is immune to content rewriting
   * (externalized tool results), which defeats content-identity anchors.
   *
   * Returns null when no id lineage links the transcript to this
   * conversation; the caller's content-identity machinery and no-anchor
   * guards then decide.
   */
  async reconcileSessionTailByEntryIds(params: {
    sessionId: string;
    sessionKey?: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
    entryIds: string[];
    lastProcessedEntryId?: string | null;
    existingDbCount: number;
    sessionContext: string;
    startedAt: number;
  }): Promise<TranscriptReconcileResult | null> {
    const { conversationId, historicalMessages, entryIds, sessionContext, startedAt } = params;

    // Query existence only for the tail when the checkpoint anchor is still
    // in the transcript; otherwise probe every id to find the newest
    // persisted one.
    const checkpointAnchorIndex = params.lastProcessedEntryId
      ? entryIds.lastIndexOf(params.lastProcessedEntryId)
      : -1;
    const knownExisting = await this.host.conversationStore.filterExistingTranscriptEntryIds(
      conversationId,
      checkpointAnchorIndex >= 0 ? entryIds.slice(checkpointAnchorIndex + 1) : entryIds,
    );
    const selection = selectEntryIdTail({
      entryIds,
      existingEntryIds: knownExisting,
      lastProcessedEntryId: params.lastProcessedEntryId,
    });

    if (selection.kind === "no-id-lineage") {
      return null;
    }
    if (selection.kind === "at-tip") {
      this.host.deps.log.debug(
        `[lcm] reconcileSessionTail: entry-id anchor at tip for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=true`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: true };
    }

    const anchorIndex = selection.anchorIndex;
    const candidates = selection.missingIndexes.map((index) => historicalMessages[index]!);
    const missingTail = this.filterSyntheticHeartbeatTranscriptMessages({
      messages: candidates,
      sessionContext,
      source: "reconcileSessionTail entry-id",
    });

    // Entry-id anchored backlogs are exact — lineage is proven by the id
    // anchor and every import is individually id-verified — so a backlog
    // beyond the cap drains in bounded oldest-first chunks instead of
    // freezing, mirroring the anchored content path. The checkpoint does
    // not advance while a pass is capped, so repeated passes converge.
    const entryIdImportCap = transcriptImportCap(params.existingDbCount);
    const entryIdImportCapped =
      params.existingDbCount > 0 && missingTail.length > entryIdImportCap;
    if (entryIdImportCapped) {
      this.host.deps.log.warn(
        `[lcm] reconcileSessionTail: entry-id import cap chunking for ${sessionContext} — importing ${entryIdImportCap}/${missingTail.length} anchored backlog messages this pass (existing: ${params.existingDbCount}, cap: ${entryIdImportCap}); remaining backlog continues next pass`,
      );
    }

    // Ids on the current leaf path. A persisted row whose entry id is NOT in
    // this set was stranded by a host history rewrite (the suffix was
    // re-appended under new ids) and is eligible for stale-id re-stamping.
    const leafEntryIds = new Set(entryIds);

    const replayTwinIndex = this.buildReplayTwinIndex(historicalMessages);
    let importedMessages = 0;
    let adoptedMessages = 0;
    let restampedMessages = 0;
    let replayTwinsSkipped = 0;
    let cappedImportProgress = 0;
    let cappedWithRemaining = false;
    for (const message of missingTail) {
      const entryId = getTranscriptEntryId(message)!;
      const stored = toStoredMessage(message);
      const adopted = await this.host.conversationStore.adoptTranscriptEntryId(
        conversationId,
        stored.role,
        stored.content,
        entryId,
      );
      if (adopted) {
        adoptedMessages += 1;
        cappedImportProgress += 1;
        continue;
      }
      const restamped = await this.adoptStaleTranscriptEntryId({
        conversationId,
        leafEntryIds,
        role: stored.role,
        content: stored.content,
        entryId,
      });
      if (restamped) {
        restampedMessages += 1;
        cappedImportProgress += 1;
        continue;
      }
      if (await this.candidateHasPersistedReplayTwin(conversationId, message, replayTwinIndex)) {
        // Re-appended replay: an already-persisted entry in this tail shares the
        // role, canonical content, and frozen inner timestamp under a different
        // id. Skip it rather than insert a duplicate row.
        replayTwinsSkipped += 1;
        this.host.deps.log.debug(
          `[lcm] reconcileSessionTailByEntryIds: skipped source-identity replay twin entry=${entryId} for ${sessionContext}`,
        );
        continue;
      }
      if (entryIdImportCapped && cappedImportProgress >= entryIdImportCap) {
        cappedWithRemaining = true;
        break;
      }
      // Entry-id-verified imports are exact (the id is proven absent), so the
      // same-second replay flood heuristic does not apply.
      const result = await this.host.ingestSingle({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        message,
        createdAt: resolveTranscriptMessageCreatedAt(message),
        skipReplayTimestampFloodGuard: true,
      });
      if (result.ingested) {
        importedMessages += 1;
        cappedImportProgress += 1;
      }
    }

    this.host.deps.log.debug(
      `[lcm] reconcileSessionTail: entry-id path for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} anchorIndex=${anchorIndex} missingTail=${missingTail.length} importedMessages=${importedMessages} adoptedMessages=${adoptedMessages} restampedMessages=${restampedMessages} replayTwinsSkipped=${replayTwinsSkipped} capped=${entryIdImportCapped}`,
    );
    if (entryIdImportCapped && cappedWithRemaining) {
      return {
        blockedByImportCap: true,
        blockedReason: "import-cap",
        importedMessages,
        hasOverlap: true,
      };
    }
    return { blockedByImportCap: false, importedMessages, hasOverlap: true };
  }

  /**
   * Re-stamp an identity-matched row whose stored entry id has left the
   * transcript's leaf path. Host history rewrites (rewriteTranscriptEntries,
   * the host's own tool-result truncation, gateway chat edits) re-append the
   * active suffix under freshly generated ids; the stranded rows are the
   * same messages, so they adopt the re-issued id instead of importing a
   * duplicate. Rows whose ids are still on the leaf path are live entries
   * and never touched. Returns true when a row was re-stamped.
   */
  async adoptStaleTranscriptEntryId(params: {
    conversationId: number;
    leafEntryIds: ReadonlySet<string>;
    role: StoredMessage["role"];
    content: string;
    entryId: string;
  }): Promise<boolean> {
    const candidates = await this.host.conversationStore.listTranscriptEntryIdsByIdentity(
      params.conversationId,
      params.role,
      params.content,
    );
    for (const candidate of candidates) {
      if (params.leafEntryIds.has(candidate.transcriptEntryId)) {
        continue;
      }
      const restamped = await this.host.conversationStore.restampTranscriptEntryId(
        candidate.messageId,
        params.entryId,
      );
      if (restamped) {
        return true;
      }
    }
    return false;
  }

  /**
   * Twin-replay key for a reconcile candidate: the same identity canonicalization
   * used for identity_hash (role plus canonicalized content) joined to the
   * full-precision INNER source timestamp. Returns null when the message carries
   * no inner timestamp, which makes the guard fail open. The per-entry envelope
   * timestamp is deliberately excluded: OpenClaw re-stamps it fresh on every
   * re-append, so only the frozen inner timestamp identifies one source event.
   */
  private replayTwinKey(message: AgentMessage): string | null {
    const inner = resolveTranscriptMessageInnerTimestamp(message);
    if (inner === null) {
      return null;
    }
    const stored = toStoredMessage(message);
    const innerTag = typeof inner === "number" ? `n:${inner}` : `s:${inner}`;
    return `${buildMessageIdentityHash(stored.role, stored.content)}\u0000${innerTag}`;
  }

  private buildReplayTwinIndex(tail: AgentMessage[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const message of tail) {
      const entryId = getTranscriptEntryId(message);
      if (!entryId) {
        continue;
      }
      const key = this.replayTwinKey(message);
      if (key === null) {
        continue;
      }
      const ids = index.get(key);
      if (ids) {
        ids.push(entryId);
      } else {
        index.set(key, [entryId]);
      }
    }
    return index;
  }

  /**
   * True when `candidate` (a proven-absent transcript entry) is a re-appended
   * replay of a logical source event that is ALREADY persisted under a different
   * entry id: another entry in the same parsed transcript tail shares its role,
   * canonical content, and frozen inner millisecond timestamp, and that entry's
   * id is already in the store. OpenClaw retry/failover storms re-append the same
   * inbound event under fresh uuids with the same frozen inner timestamp;
   * genuinely repeated messages are distinct source events with distinct inner
   * timestamps, so they are never twins. Second-granularity created_at is never
   * consulted, so same-second legitimate repeats survive.
   */
  private async candidateHasPersistedReplayTwin(
    conversationId: number,
    candidate: AgentMessage,
    twinIndex: Map<string, string[]>,
  ): Promise<boolean> {
    const key = this.replayTwinKey(candidate);
    if (key === null) {
      return false;
    }
    const candidateId = getTranscriptEntryId(candidate);
    const siblingIds = twinIndex.get(key);
    if (!siblingIds) {
      return false;
    }
    for (const siblingId of siblingIds) {
      if (siblingId === candidateId) {
        continue;
      }
      if (
        await this.host.conversationStore.hasMessageByTranscriptEntryId(conversationId, siblingId)
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Decide whether a placeholder-checkpoint conversation may recover by importing
   * its on-disk transcript as a new epoch (#822). Safe ONLY when the persisted
   * frontier holds no real conversation content that a rotated/unrelated transcript
   * could overwrite. Generalizes #837's single-injected-metadata-preamble check to
   * any frontier composed entirely of non-anchoring injected-metadata rows; an
   * empty frontier is trivially safe, and a larger or non-metadata frontier
   * conservatively returns false so the conversation freezes (#649) rather than
   * risk contaminating real history (the failure that closed #824).
   */
  private async conversationFrontierIsEntirelyNonAnchoring(
    conversationId: number,
  ): Promise<boolean> {
    const existingMessageCount = await this.host.conversationStore.getMessageCount(conversationId);
    if (existingMessageCount === 0) {
      return true;
    }
    if (existingMessageCount > NON_ANCHORING_FRONTIER_SCAN_LIMIT) {
      return false;
    }
    const frontier = await this.host.conversationStore.getMessages(conversationId, {
      limit: NON_ANCHORING_FRONTIER_SCAN_LIMIT,
    });
    return (
      frontier.length === existingMessageCount &&
      frontier.every(
        (message) =>
          isLikelyInjectedMetadataPreambleRecord(message) ||
          isOpenClawAmbientInboundRecord(message.role, message.content),
      )
    );
  }

  async reconcileSessionTail(params: {
    sessionId: string;
    sessionKey?: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
    checkpointEntryHash?: string | null;
    lastProcessedEntryId?: string | null;
    skipContentAnchorScan?: boolean;
    allowNoAnchorImport?: boolean;
    // Lift the no-anchor import cap because the caller proved a full new-epoch
    // import is safe. Bounded by the transcript length, never unbounded.
    allowFullNonAnchoringFrontierImport?: boolean;
    // Fresh rollover proof establishes timestamped non-overlap already; generic
    // replay-prefix dropping would discard valid repeated template turns.
    skipNoAnchorReplayGuard?: boolean;
    // Fresh rollover entry ids are new epoch rows, not restamped identities from
    // the preserved pre-rebind history.
    skipNoAnchorEntryIdAdoption?: boolean;
    noAnchorImportReason?: string;
  }): Promise<TranscriptReconcileResult> {
    const { sessionId, conversationId, historicalMessages } = params;
    const startedAt = Date.now();
    const sessionContext = this.host.formatSessionLogContext({
      conversationId,
      sessionId,
      sessionKey: params.sessionKey,
    });
    if (historicalMessages.length === 0) {
      this.host.deps.log.debug(
        `[lcm] reconcileSessionTail: skipped for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=0 reason=empty-history`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }

    const latestDbMessage = await this.host.conversationStore.getLastMessage(conversationId);
    if (!latestDbMessage) {
      this.host.deps.log.debug(
        `[lcm] reconcileSessionTail: skipped for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} reason=no-db-tail`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }
    const existingDbCount = await this.host.conversationStore.getMessageCount(conversationId);

    // Exact path: when every transcript entry carries a stable envelope id,
    // anchor and diff by id instead of content identity.
    const candidateEntryIds = historicalMessages.map((message) => getTranscriptEntryId(message));
    if (candidateEntryIds.every((entryId): entryId is string => entryId !== null)) {
      const entryIdResult = await this.reconcileSessionTailByEntryIds({
        sessionId,
        sessionKey: params.sessionKey,
        conversationId,
        historicalMessages,
        entryIds: candidateEntryIds,
        lastProcessedEntryId: params.lastProcessedEntryId,
        existingDbCount,
        sessionContext,
        startedAt,
      });
      if (entryIdResult) {
        return entryIdResult;
      }
    }

    const storedHistoricalMessages = historicalMessages.map((message) => toStoredMessage(message));

    // Fast path: one tail comparison for the common in-sync case.
    const latestHistorical = storedHistoricalMessages[storedHistoricalMessages.length - 1];
    const latestIdentity = messageIdentity(latestDbMessage.role, latestDbMessage.content);
    if (
      !params.skipContentAnchorScan &&
      latestIdentity === messageIdentity(latestHistorical.role, latestHistorical.content)
    ) {
      const dbOccurrences = await this.host.conversationStore.countMessagesByIdentity(
        conversationId,
        latestDbMessage.role,
        latestDbMessage.content,
      );
      let historicalOccurrences = 0;
      for (const stored of storedHistoricalMessages) {
        if (messageIdentity(stored.role, stored.content) === latestIdentity) {
          historicalOccurrences += 1;
        }
      }
      if (dbOccurrences === historicalOccurrences) {
        this.host.deps.log.debug(
          `[lcm] reconcileSessionTail: fast path for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=true`,
        );
        return { blockedByImportCap: false, importedMessages: 0, hasOverlap: true };
      }
    }

    // Slow path: walk backward through JSONL to find the most recent anchor
    // message that already exists in LCM, then append everything after it.
    let anchorIndex = -1;
    const historicalIdentityTotals = new Map<string, number>();
    for (const stored of storedHistoricalMessages) {
      const identity = messageIdentity(stored.role, stored.content);
      historicalIdentityTotals.set(identity, (historicalIdentityTotals.get(identity) ?? 0) + 1);
    }

    if (!params.skipContentAnchorScan) {
      const historicalIdentityCountsAfterIndex = new Map<string, number>();
      const dbIdentityCounts = new Map<string, number>();
      for (let index = storedHistoricalMessages.length - 1; index >= 0; index--) {
        const stored = storedHistoricalMessages[index];
        const identity = messageIdentity(stored.role, stored.content);
        const seenAfter = historicalIdentityCountsAfterIndex.get(identity) ?? 0;
        const total = historicalIdentityTotals.get(identity) ?? 0;
        const occurrencesThroughIndex = total - seenAfter;
        const exists = await this.host.conversationStore.hasMessage(
          conversationId,
          stored.role,
          stored.content,
        );
        historicalIdentityCountsAfterIndex.set(identity, seenAfter + 1);
        if (!exists) {
          continue;
        }

        let dbCountForIdentity = dbIdentityCounts.get(identity);
        if (dbCountForIdentity === undefined) {
          dbCountForIdentity = await this.host.conversationStore.countMessagesByIdentity(
            conversationId,
            stored.role,
            stored.content,
          );
          dbIdentityCounts.set(identity, dbCountForIdentity);
        }

        // Match the same occurrence index as the DB tail so repeated empty
        // tool messages do not anchor against a later, still-missing entry.
        if (dbCountForIdentity !== occurrencesThroughIndex) {
          continue;
        }

        anchorIndex = index;
        break;
      }
    }

    if (anchorIndex < 0) {
      const checkpointEntryHash = params.checkpointEntryHash;
      if (checkpointEntryHash) {
        // Externalized bootstrap rows no longer match raw JSONL content, so
        // fall back to the transcript checkpoint before declaring no overlap.
        // Refuse duplicate hash matches: canonical OpenClaw metadata can make
        // repeated same-text inbound entries share a hash, and anchoring the
        // later occurrence would skip intervening transcript history.
        let checkpointHashAnchorIndex = -1;
        let checkpointHashAmbiguous = false;
        for (let index = storedHistoricalMessages.length - 1; index >= 0; index--) {
          if (createBootstrapEntryHash(storedHistoricalMessages[index]) === checkpointEntryHash) {
            if (checkpointHashAnchorIndex >= 0) {
              checkpointHashAmbiguous = true;
              break;
            }
            checkpointHashAnchorIndex = index;
          }
        }
        if (!checkpointHashAmbiguous) {
          anchorIndex = checkpointHashAnchorIndex;
        }
      }

      if (anchorIndex < 0) {
        if (params.allowNoAnchorImport) {
          return this.importNoAnchorEpoch({
            sessionId,
            sessionKey: params.sessionKey,
            conversationId,
            historicalMessages,
            noAnchorImportReason: params.noAnchorImportReason,
            allowFullNonAnchoringFrontierImport: params.allowFullNonAnchoringFrontierImport,
            skipNoAnchorReplayGuard: params.skipNoAnchorReplayGuard,
            skipNoAnchorEntryIdAdoption: params.skipNoAnchorEntryIdAdoption,
            existingDbCount,
            sessionContext,
            startedAt,
          });
        }
        this.host.deps.log.debug(
          `[lcm] reconcileSessionTail: no anchor for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=false`,
        );
        return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
      }
    }
    if (anchorIndex >= historicalMessages.length - 1) {
      this.host.deps.log.debug(
        `[lcm] reconcileSessionTail: anchor at tip for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} importedMessages=0 overlap=true`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: true };
    }

    const missingTailFiltered = await this.filterBootstrapReplayMessages({
      messages: historicalMessages.slice(anchorIndex + 1),
      sessionContext,
      source: "reconcileSessionTail",
      priorMessages: historicalMessages.slice(0, anchorIndex + 1),
    });
    const missingTail = this.filterSyntheticHeartbeatTranscriptMessages({
      messages: missingTailFiltered.messages,
      sessionContext,
      source: "reconcileSessionTail",
    });

    // Anchored missing tails are this conversation's own continuation
    // (lineage proven by the identity anchor), so a tail larger than the
    // cap must not freeze reconcile forever — that wedges afterTurn
    // persistence while the backlog keeps growing. Import a capped
    // oldest-first chunk per pass instead: order is preserved, per-pass
    // flood exposure stays bounded, and the growing existing count raises
    // the cap so repeated passes converge. The checkpoint/frontier still
    // does not advance until the backlog fully drains (blockedByImportCap
    // stays true on partial passes).
    const anchoredImportCap = transcriptImportCap(existingDbCount);
    const importCapped = existingDbCount > 0 && missingTail.length > anchoredImportCap;
    const importableTail = importCapped ? missingTail.slice(0, anchoredImportCap) : missingTail;
    if (importCapped) {
      this.host.deps.log.warn(
        `[lcm] reconcileSessionTail: import cap chunking for ${sessionContext} — importing ${importableTail.length}/${missingTail.length} anchored backlog messages this pass (existing: ${existingDbCount}, cap: ${anchoredImportCap}); remaining backlog continues next pass`,
      );
    }

    const importedMessages = await this.ingestBatch({
      sessionId,
      sessionKey: params.sessionKey,
      messages: importableTail,
      replayGuardExemptPrefixLength: missingTailFiltered.replayGuardExemptPrefixLength,
    });

    if (importCapped) {
      this.host.deps.log.debug(
        `[lcm] reconcileSessionTail: capped chunk for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} anchorIndex=${anchorIndex} missingTail=${missingTail.length} importedMessages=${importedMessages} existingDbCount=${existingDbCount} cap=${anchoredImportCap}`,
      );
      return {
        blockedByImportCap: true,
        blockedReason: "import-cap",
        importedMessages,
        hasOverlap: true,
      };
    }

    this.host.deps.log.debug(
      `[lcm] reconcileSessionTail: slow path for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} anchorIndex=${anchorIndex} missingTail=${missingTail.length} importedMessages=${importedMessages}`,
    );
    return { blockedByImportCap: false, importedMessages, hasOverlap: true };
  }

  /**
   * Import a transcript after the ambiguous-rollover freshness proof has already
   * shown it is a new runtime epoch for the same session key. That proof replaces
   * content anchoring here: recurring template text from the old lane must not
   * make us skip the beginning of the fresh transcript.
   */
  async importFreshAmbiguousRolloverTranscript(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
  }): Promise<TranscriptReconcileResult> {
    const existingCount = await this.host.conversationStore.getMessageCount(params.conversationId);
    if (existingCount === 0) {
      let importedMessages = 0;
      for (const message of params.historicalMessages) {
        const result = await this.host.ingestSingle({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          message,
          createdAt: resolveTranscriptMessageCreatedAt(message),
          skipReplayTimestampFloodGuard: true,
        });
        if (result.ingested) {
          importedMessages += 1;
        }
      }
      await this.host.conversationStore.markConversationBootstrapped(params.conversationId);
      await this.recordImportAndRefreshCheckpoint({
        conversationId: params.conversationId,
        sessionFile: params.sessionFile,
        importedMessages,
      });
      return {
        importedMessages,
        blockedByImportCap: false,
        hasOverlap: true,
        transcriptCovered: importedMessages > 0,
      };
    }

    const reconcile = await this.reconcileSessionTail({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      conversationId: params.conversationId,
      historicalMessages: params.historicalMessages,
      skipContentAnchorScan: true,
      allowNoAnchorImport: true,
      allowFullNonAnchoringFrontierImport: true,
      skipNoAnchorReplayGuard: true,
      skipNoAnchorEntryIdAdoption: true,
      noAnchorImportReason: "fresh-ambiguous-rollover-rebind",
    });
    if (!reconcile.blockedByImportCap && reconcile.importedMessages > 0) {
      await this.host.conversationStore.markConversationBootstrapped(params.conversationId);
      await this.recordImportAndRefreshCheckpoint({
        conversationId: params.conversationId,
        sessionFile: params.sessionFile,
        importedMessages: reconcile.importedMessages,
      });
      return { ...reconcile, transcriptCovered: true };
    }
    return {
      ...reconcile,
      transcriptCovered: reconcile.hasOverlap || reconcile.importedMessages > 0,
    };
  }

  /**
   * No-anchor recovery: the transcript shares no anchor with persisted
   * history, but the caller has lineage evidence (path mismatch, declared
   * epoch rollover, same-path shrink, checkpoint recovery) that this file is
   * still this conversation's continuation. Import it as a bounded new
   * epoch: delivery-only and replay-flood transcripts are blocked, the
   * import cap chunks oversized batches (entry-id-bearing epochs drain
   * oldest-first), and identity matches adopt re-issued entry ids instead of
   * duplicating rows.
   */
  private async importNoAnchorEpoch(params: {
    sessionId: string;
    sessionKey?: string;
    conversationId: number;
    historicalMessages: AgentMessage[];
    noAnchorImportReason?: string;
    allowFullNonAnchoringFrontierImport?: boolean;
    skipNoAnchorReplayGuard?: boolean;
    skipNoAnchorEntryIdAdoption?: boolean;
    existingDbCount: number;
    sessionContext: string;
    startedAt: number;
  }): Promise<TranscriptReconcileResult> {
    const { sessionId, conversationId, historicalMessages, existingDbCount } = params;
    const { startedAt, sessionContext } = params;

    if (
      (params.noAnchorImportReason === "path-mismatch" ||
        params.noAnchorImportReason === "checkpoint-missing-recovery" ||
        params.noAnchorImportReason === "placeholder-checkpoint-recovery") &&
      isLikelyInjectedDeliveryOnlyTranscript(historicalMessages)
    ) {
      this.host.deps.log.warn(
        `[lcm] reconcileSessionTail: blocked delivery-only path-mismatched transcript for ${sessionContext}; preserving existing checkpoint because the rotated transcript contains only injected delivery/config traffic`,
      );
      this.host.deps.log.debug(
        `[lcm] reconcileSessionTail: blocked delivery-only path mismatch for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} overlap=false`,
      );
      return { blockedByImportCap: false, importedMessages: 0, hasOverlap: false };
    }

    const replayAnalysis = await this.analyzePersistedTranscriptIdentityOverlaps({
      conversationId,
      messages: historicalMessages,
    });
    const persistedIdentityOverlaps = replayAnalysis.overlaps;
    let noAnchorImportMessages = this.filterSyntheticHeartbeatTranscriptMessages({
      messages: historicalMessages,
      sessionContext,
      source: "reconcileSessionTail no-anchor",
    });
    // A fully id-bearing batch resolves identity overlaps exactly:
    // identity matches adopt the re-issued entry id (host rewrites and
    // rotations re-append the surviving suffix under new ids) and only
    // genuinely-new entries import. The replay-overlap block below
    // exists for id-less ambiguity, where overlap could equally mean a
    // replayed file; applying it here would freeze rewritten-epoch
    // transcripts instead of healing them.
    const allEntryIdBearing =
      noAnchorImportMessages.length > 0 &&
      noAnchorImportMessages.every((message) => getTranscriptEntryId(message) !== null);
    const replayThreshold = Math.max(3, Math.ceil(historicalMessages.length * 0.5));
    if (
      !params.skipNoAnchorReplayGuard &&
      !allEntryIdBearing &&
      persistedIdentityOverlaps >= replayThreshold
    ) {
      if (replayAnalysis.firstNonOverlappingIndex < 0) {
        this.host.deps.log.warn(
          `[lcm] reconcileSessionTail: duplicate transcript replay blocked for ${sessionContext} - ${persistedIdentityOverlaps}/${historicalMessages.length} candidate messages already exist (reason: ${params.noAnchorImportReason ?? "unspecified"}). Aborting to prevent replay flood.`,
        );
        this.host.deps.log.debug(
          `[lcm] reconcileSessionTail: blocked duplicate transcript replay for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} persistedIdentityOverlaps=${persistedIdentityOverlaps} overlap=false`,
        );
        return {
          blockedByImportCap: true,
          blockedReason: "duplicate-transcript-replay",
          importedMessages: 0,
          hasOverlap: false,
        };
      }

      if (replayAnalysis.firstNonOverlappingIndex > 0) {
        noAnchorImportMessages = this.filterSyntheticHeartbeatTranscriptMessages({
          messages: historicalMessages.slice(replayAnalysis.firstNonOverlappingIndex),
          sessionContext,
          source: "reconcileSessionTail no-anchor replay-prefix",
        });
        this.host.deps.log.warn(
          `[lcm] reconcileSessionTail: duplicate transcript replay guard dropped ${replayAnalysis.firstNonOverlappingIndex}/${historicalMessages.length} already-persisted prefix messages for ${sessionContext} before no-anchor import (reason: ${params.noAnchorImportReason ?? "unspecified"})`,
        );
      }
    }

    const importCap = transcriptImportCap(existingDbCount);
    let noAnchorImportCapped = false;
    // #822: when the caller proved the persisted frontier holds no real
    // conversation content (entirely injected-metadata rows), the cap serves
    // no anti-flood purpose — there is nothing real to flood or duplicate —
    // and chunked draining would leave the conversation degraded for many
    // turns. Import the whole transcript in one bounded pass instead (bounded
    // by the transcript length, never unbounded).
    if (!params.allowFullNonAnchoringFrontierImport && noAnchorImportMessages.length > importCap) {
      if (allEntryIdBearing) {
        // A fully id-bearing new epoch is exact (every entry adopts or
        // imports by verified id), so a large rollover — e.g. a host
        // rewrite or compaction successor with a kept tail beyond the
        // cap — drains in bounded oldest-first chunks instead of
        // freezing before adoption can heal it. After the first chunk
        // persists ids, the entry-id anchor takes over on later passes.
        noAnchorImportCapped = true;
        this.host.deps.log.warn(
          `[lcm] reconcileSessionTail: no-anchor entry-id import cap chunking for ${sessionContext} — importing ${importCap}/${noAnchorImportMessages.length} new-epoch messages this pass (existing: ${existingDbCount}, cap: ${importCap}, reason: ${params.noAnchorImportReason ?? "unspecified"}); remaining backlog continues next pass`,
        );
        noAnchorImportMessages = noAnchorImportMessages.slice(0, importCap);
      } else {
        this.host.deps.log.warn(
          `[lcm] reconcileSessionTail: no anchor import cap exceeded for ${sessionContext} - would import ${noAnchorImportMessages.length} messages (existing: ${existingDbCount}, cap: ${importCap}, reason: ${params.noAnchorImportReason ?? "unspecified"}). Aborting to prevent flood.`,
        );
        this.host.deps.log.debug(
          `[lcm] reconcileSessionTail: blocked no-anchor import for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} candidateMessages=${noAnchorImportMessages.length} existingDbCount=${existingDbCount} cap=${importCap} overlap=false`,
        );
        return {
          blockedByImportCap: true,
          blockedReason: "import-cap",
          importedMessages: 0,
          hasOverlap: false,
        };
      }
    }

    if (
      params.noAnchorImportReason &&
      CROSS_CONVERSATION_RAW_ID_GUARDED_NO_ANCHOR_REASONS.has(params.noAnchorImportReason)
    ) {
      const rawIdMatches = this.countActiveCrossConversationRawIdMatches({
        conversationId,
        sessionId,
        sessionKey: params.sessionKey,
        messages: noAnchorImportMessages,
      });
      if (rawIdMatches.matchedRawIds > 0) {
        this.host.deps.log.warn(
          `[lcm] reconcileSessionTail: blocked ${params.noAnchorImportReason} no-anchor import for ${sessionContext} because ${rawIdMatches.matchedRawIds}/${rawIdMatches.candidateRawIds} candidate raw ids already exist in other active conversations`,
        );
        this.host.deps.log.debug(
          `[lcm] reconcileSessionTail: blocked cross-conversation raw-id duplicate for ${sessionContext} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} candidateRawIds=${rawIdMatches.candidateRawIds} matchedRawIds=${rawIdMatches.matchedRawIds} overlap=false`,
        );
        return {
          blockedByImportCap: true,
          blockedReason: "cross-conversation-raw-id",
          importedMessages: 0,
          hasOverlap: false,
        };
      }
    }

    // Ids on the current leaf path, for stale-id re-stamping of rows
    // stranded by the rewrite/rotation that produced this new epoch.
    const noAnchorLeafEntryIds = new Set(
      historicalMessages
        .map((message) => getTranscriptEntryId(message))
        .filter((id): id is string => id !== null),
    );
    let importedMessages = 0;
    let adoptedMessages = 0;
    for (const message of noAnchorImportMessages) {
      const entryId = getTranscriptEntryId(message);
      if (entryId) {
        const alreadyPersisted = await this.host.conversationStore.hasMessageByTranscriptEntryId(
          conversationId,
          entryId,
        );
        if (alreadyPersisted) {
          continue;
        }
        if (!params.skipNoAnchorEntryIdAdoption) {
          const stored = toStoredMessage(message);
          const adopted =
            (await this.host.conversationStore.adoptTranscriptEntryId(
              conversationId,
              stored.role,
              stored.content,
              entryId,
            )) ||
            (await this.adoptStaleTranscriptEntryId({
              conversationId,
              leafEntryIds: noAnchorLeafEntryIds,
              role: stored.role,
              content: stored.content,
              entryId,
            }));
          if (adopted) {
            adoptedMessages += 1;
            continue;
          }
        }
      }
      const result = await this.host.ingestSingle({
        sessionId,
        sessionKey: params.sessionKey,
        message,
        createdAt: resolveTranscriptMessageCreatedAt(message),
        skipReplayTimestampFloodGuard: true,
      });
      if (result.ingested) {
        importedMessages += 1;
      }
    }
    // A fresh-ambiguous-rollover rebind imports the rolled transcript as a new
    // epoch by design (the lane just healed), so record it at info. Every other
    // no-anchor new-epoch import is an unexpected reconciliation worth a warn.
    const noAnchorEpochImport = `[lcm] reconcileSessionTail: no anchor for ${sessionContext}; imported transcript as new epoch reason=${params.noAnchorImportReason ?? "unspecified"} duration=${formatDurationMs(Date.now() - startedAt)} historicalMessages=${historicalMessages.length} candidateMessages=${noAnchorImportMessages.length} importedMessages=${importedMessages} adoptedMessages=${adoptedMessages} capped=${noAnchorImportCapped} overlap=${adoptedMessages > 0}`;
    if (params.noAnchorImportReason === "fresh-ambiguous-rollover-rebind") {
      this.host.deps.log.info(noAnchorEpochImport);
    } else {
      this.host.deps.log.warn(noAnchorEpochImport);
    }
    if (noAnchorImportCapped) {
      // Partial pass: keep the checkpoint un-advanced so the next pass
      // continues the drain (via the entry-id anchor once this chunk's
      // ids are persisted).
      return {
        blockedByImportCap: true,
        blockedReason: "import-cap",
        importedMessages,
        hasOverlap: adoptedMessages > 0,
      };
    }
    // Adoption proves the "new epoch" overlaps persisted history (the
    // host re-issued ids for messages we already hold), so report the
    // overlap — the caller then refreshes the checkpoint instead of
    // re-entering this path every turn.
    return { blockedByImportCap: false, importedMessages, hasOverlap: adoptedMessages > 0 };
  }

  /**
   * Count candidate raw event IDs that already belong to a foreign active
   * conversation. A base channel session may collide with rows from its forked
   * thread and active-memory sessions because they inherit the parent prefix.
   * Thread and variant candidates are still checked against sibling rows.
   */
  private countActiveCrossConversationRawIdMatches(params: {
    conversationId: number;
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
  }): { candidateRawIds: number; matchedRawIds: number } {
    const candidateRawIds = new Set<string>();
    for (const message of params.messages) {
      const stored = toStoredMessage(message);
      const parts = buildMessageParts({
        sessionId: params.sessionId,
        message,
        fallbackContent: stored.content,
      });
      for (const part of parts) {
        for (const rawId of extractRawIdsFromPartMetadata(part.metadata)) {
          candidateRawIds.add(rawId);
        }
      }
    }

    if (candidateRawIds.size === 0) {
      return { candidateRawIds: 0, matchedRawIds: 0 };
    }

    const siblingScope = isBaseChannelSessionKey(params.sessionKey)
      ? sessionKeyChannelScope(params.sessionKey)
      : null;
    const siblingClause = siblingScope
      ? `AND NOT (
           c.session_key IS NOT NULL
           AND (
             c.session_key = $siblingScope
             OR c.session_key LIKE $siblingThreadPrefix ESCAPE '\\'
             OR c.session_key LIKE $siblingMemoryPrefix ESCAPE '\\'
           )
         )`
      : "";
    const escapeLike = (value: string): string => value.replace(/[\\%_]/g, "\\$&");
    const siblingBindings: Record<string, string> = siblingScope
      ? {
          $siblingScope: siblingScope,
          $siblingThreadPrefix: `${escapeLike(siblingScope)}:thread:%`,
          $siblingMemoryPrefix: `${escapeLike(siblingScope)}:active-memory:%`,
        }
      : {};

    const matchStmt = this.host.db.prepare(
      `SELECT 1 AS found
       FROM message_parts mp
       JOIN messages m ON m.message_id = mp.message_id
       JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE c.active = 1
         AND m.conversation_id <> $conversationId
         ${siblingClause}
         AND mp.metadata IS NOT NULL
         AND json_valid(mp.metadata)
         AND (
           json_extract(mp.metadata, '$.raw.id') = $rawId
           OR json_extract(mp.metadata, '$.raw.call_id') = $rawId
           OR json_extract(mp.metadata, '$.raw.toolCallId') = $rawId
           OR json_extract(mp.metadata, '$.raw.tool_call_id') = $rawId
           OR json_extract(mp.metadata, '$.raw.toolUseId') = $rawId
           OR json_extract(mp.metadata, '$.raw.tool_use_id') = $rawId
           OR mp.tool_call_id = $rawId
           OR json_extract(mp.metadata, '$.id') = $rawId
           OR json_extract(mp.metadata, '$.call_id') = $rawId
           OR json_extract(mp.metadata, '$.toolCallId') = $rawId
           OR json_extract(mp.metadata, '$.tool_call_id') = $rawId
           OR json_extract(mp.metadata, '$.toolUseId') = $rawId
           OR json_extract(mp.metadata, '$.tool_use_id') = $rawId
         )
       LIMIT 1`,
    );

    let matchedRawIds = 0;
    for (const rawId of candidateRawIds) {
      const row = matchStmt.get({
        ...siblingBindings,
        $conversationId: params.conversationId,
        $rawId: rawId,
      } as Record<string, string | number>) as { found: number } | undefined;
      if (row?.found === 1) {
        matchedRawIds += 1;
      }
    }

    return { candidateRawIds: candidateRawIds.size, matchedRawIds };
  }

  /** Drop exact raw-id transcript replays while preserving content-only repeated user turns. */
  async filterPersistedRawIdReplayBatch(params: {
    conversationId: number;
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
  }): Promise<AgentMessage[]> {
    const idMatchPredicate = `(
      json_extract(mp.metadata, '$.raw.id') = ?
      OR json_extract(mp.metadata, '$.raw.call_id') = ?
      OR json_extract(mp.metadata, '$.raw.toolCallId') = ?
      OR json_extract(mp.metadata, '$.raw.tool_call_id') = ?
      OR json_extract(mp.metadata, '$.raw.toolUseId') = ?
      OR json_extract(mp.metadata, '$.raw.tool_use_id') = ?
      OR mp.tool_call_id = ?
      OR json_extract(mp.metadata, '$.id') = ?
      OR json_extract(mp.metadata, '$.call_id') = ?
      OR json_extract(mp.metadata, '$.toolCallId') = ?
      OR json_extract(mp.metadata, '$.tool_call_id') = ?
      OR json_extract(mp.metadata, '$.toolUseId') = ?
      OR json_extract(mp.metadata, '$.tool_use_id') = ?
    )`;
    const rawCoverageStmt = this.host.db.prepare(
      `SELECT m.message_id AS messageId
       FROM message_parts mp
       JOIN messages m ON m.message_id = mp.message_id
       WHERE m.conversation_id = ?
         AND m.role = ?
         AND mp.metadata IS NOT NULL
         AND json_valid(mp.metadata)
         AND ${idMatchPredicate}`,
    );
    const identityCoverageStmt = this.host.db.prepare(
      `SELECT m.message_id AS messageId
       FROM message_parts mp
       JOIN messages m ON m.message_id = mp.message_id
       WHERE m.conversation_id = ?
         AND m.role = ?
         AND m.identity_hash = ?
         AND mp.metadata IS NOT NULL
         AND json_valid(mp.metadata)
         AND ${idMatchPredicate}`,
    );
    const externalizedCoverageStmt = this.host.db.prepare(
      `SELECT
         m.message_id AS messageId,
         json_extract(mp.metadata, '$.externalizedFileId') AS fileId,
         json_extract(mp.metadata, '$.originalByteSize') AS originalByteSize,
         mp.metadata AS metadata
       FROM message_parts mp
       JOIN messages m ON m.message_id = mp.message_id
       WHERE m.conversation_id = ?
         AND m.role = ?
         AND mp.metadata IS NOT NULL
         AND json_valid(mp.metadata)
         AND json_extract(mp.metadata, '$.externalizationReason') = 'large_tool_result'
         AND ${idMatchPredicate}`,
    );
    const rawBlockSignatureStmt = this.host.db.prepare(
      `SELECT metadata
       FROM message_parts
       WHERE message_id = ?
       ORDER BY ordinal ASC`,
    );

    const filtered: AgentMessage[] = [];
    let replayedMessages = 0;

    for (const message of params.messages) {
      const stored = toStoredMessage(message);
      const replayIds = new Set<string>();
      const rawBlockIds = new Set<string>();
      const rawBlockSignatures: string[] = [];
      const replayIdsByPart: string[][] = [];
      let everyPartHasRawBlockId = true;
      const parts = buildMessageParts({
        sessionId: params.sessionId,
        message,
        fallbackContent: stored.content,
      });
      for (const part of parts) {
        const partRawBlockIds = extractRawBlockIdsFromPartMetadata(part.metadata);
        if (partRawBlockIds.length === 0) {
          everyPartHasRawBlockId = false;
        }
        for (const rawId of partRawBlockIds) {
          rawBlockIds.add(rawId);
        }
        const rawBlockSignature = extractRawBlockSignatureFromPartMetadata(part.metadata);
        if (rawBlockSignature) {
          rawBlockSignatures.push(rawBlockSignature);
        }
        const partReplayIds = extractRawIdsFromPartMetadata(part.metadata);
        replayIdsByPart.push(partReplayIds);
        for (const rawId of partReplayIds) {
          replayIds.add(rawId);
        }
      }

      if (replayIds.size === 0) {
        filtered.push(message);
        continue;
      }

      const canMatchWithoutIdentity = rawBlockIds.size > 0 && everyPartHasRawBlockId;
      const matchedIds = canMatchWithoutIdentity ? rawBlockIds : replayIds;
      const externalizedTextsById = extractPlainToolReplayTextsById(message);
      const coverageByMessageId = new Map<number, Set<string>>();
      for (const rawId of matchedIds) {
        const rawIdArgs = [
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
          rawId,
        ];
        let rows: Array<{ messageId: number }>;
        if (canMatchWithoutIdentity) {
          rows = rawCoverageStmt.all(
            params.conversationId,
            stored.role,
            ...rawIdArgs,
          ) as Array<{ messageId: number }>;
        } else {
          const identityHash = buildMessageIdentityHash(stored.role, stored.content);
          rows = identityCoverageStmt.all(
            params.conversationId,
            stored.role,
            identityHash,
            ...rawIdArgs,
          ) as Array<{ messageId: number }>;
        }
        for (const row of rows) {
          const matchedRawIds = coverageByMessageId.get(row.messageId) ?? new Set<string>();
          matchedRawIds.add(rawId);
          coverageByMessageId.set(row.messageId, matchedRawIds);
        }
      }

      let alreadyPersisted = false;
      if (canMatchWithoutIdentity) {
        for (const [messageId, rawIds] of coverageByMessageId.entries()) {
          if (rawIds.size !== matchedIds.size) {
            continue;
          }
          const rows = rawBlockSignatureStmt.all(messageId) as Array<{ metadata: string | null }>;
          if (rows.length !== parts.length) {
            continue;
          }
          let allPartsMatch = true;
          for (let index = 0; index < rows.length; index += 1) {
            const persistedMetadata = rows[index]!.metadata;
            const persistedSignature = extractRawBlockSignatureFromPartMetadata(persistedMetadata);
            if (
              persistedSignature === rawBlockSignatures[index] &&
              externalizedReplayMetadataMatches(persistedMetadata, parts[index]?.metadata)
            ) {
              continue;
            }
            let externalizedPartMatches = false;
            for (const rawId of replayIdsByPart[index] ?? []) {
              if (!extractRawIdsFromPartMetadata(persistedMetadata).includes(rawId)) {
                continue;
              }
              const externalizedText = externalizedTextsById.get(rawId);
              if (externalizedText === undefined) {
                continue;
              }
              let persistedParsed: unknown;
              try {
                persistedParsed = persistedMetadata ? JSON.parse(persistedMetadata) : undefined;
              } catch {
                continue;
              }
              const persistedRecord = asRecord(persistedParsed);
              const fileId = safeString(persistedRecord?.externalizedFileId);
              const originalByteSize = persistedRecord?.originalByteSize;
              if (
                !fileId ||
                Number(originalByteSize) !== Buffer.byteLength(externalizedText, "utf8")
              ) {
                continue;
              }
              const largeFile = await this.host.summaryStore.getLargeFile(fileId);
              if (!largeFile) {
                continue;
              }
              let storedText: string;
              try {
                storedText = readFileSync(largeFile.storageUri, "utf8");
              } catch {
                continue;
              }
              if (
                storedText === externalizedText &&
                externalizedReplayMetadataMatches(persistedMetadata, parts[index]?.metadata)
              ) {
                externalizedPartMatches = true;
                break;
              }
            }
            if (!externalizedPartMatches) {
              allPartsMatch = false;
              break;
            }
          }
          if (allPartsMatch) {
            alreadyPersisted = true;
            break;
          }
        }
      } else {
        for (const [messageId, rawIds] of coverageByMessageId.entries()) {
          if (rawIds.size !== matchedIds.size) {
            continue;
          }
          const rows = rawBlockSignatureStmt.all(messageId) as Array<{ metadata: string | null }>;
          if (
            rows.length === parts.length &&
            rows.every((row, index) => row.metadata === (parts[index]?.metadata ?? null))
          ) {
            alreadyPersisted = true;
            break;
          }
        }
      }

      const canUseExternalizedFallback = parts.length === 1 || everyPartHasRawBlockId;
      if (!alreadyPersisted && canUseExternalizedFallback && externalizedTextsById.size > 0) {
        const externalizedCoverageByMessageId = new Map<number, Set<string>>();
        for (const rawId of matchedIds) {
          const externalizedText = externalizedTextsById.get(rawId);
          if (externalizedText === undefined) {
            continue;
          }
          const externalizedByteSize = Buffer.byteLength(externalizedText, "utf8");
          const rawIdArgs = [
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
            rawId,
          ];
          const rows = externalizedCoverageStmt.all(
            params.conversationId,
            stored.role,
            ...rawIdArgs,
          ) as Array<{
            messageId: number;
            fileId: unknown;
            originalByteSize: unknown;
            metadata: string | null;
          }>;
          for (const row of rows) {
            if (
              typeof row.fileId !== "string" ||
              Number(row.originalByteSize) !== externalizedByteSize
            ) {
              continue;
            }
            const largeFile = await this.host.summaryStore.getLargeFile(row.fileId);
            if (!largeFile) {
              continue;
            }
            let storedText: string;
            try {
              storedText = readFileSync(largeFile.storageUri, "utf8");
            } catch {
              continue;
            }
            if (
              storedText !== externalizedText ||
              !externalizedReplayMetadataMatches(row.metadata, parts[0]?.metadata)
            ) {
              continue;
            }
            const matchedRawIds =
              externalizedCoverageByMessageId.get(row.messageId) ?? new Set<string>();
            matchedRawIds.add(rawId);
            externalizedCoverageByMessageId.set(row.messageId, matchedRawIds);
          }
        }
        alreadyPersisted = Array.from(externalizedCoverageByMessageId.values()).some(
          (rawIds) => rawIds.size === matchedIds.size,
        );
      }

      if (alreadyPersisted) {
        replayedMessages += 1;
      } else {
        filtered.push(message);
      }
    }

    if (replayedMessages > 0) {
      const sessionContext = this.host.formatSessionLogContext({
        conversationId: params.conversationId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
      });
      this.host.deps.log.warn(
        `[lcm] ingestBatch: dropped ${replayedMessages}/${params.messages.length} raw-id replay messages for ${sessionContext}`,
      );
    }

    return filtered;
  }

  /**
   * Existing-conversation bootstrap is a rehydrate path. It may repair small
   * crash gaps, but it must not replay already persisted transcript rows as
   * fresh LCM seqs after a runtime re-instantiation.
   */
  async filterBootstrapReplayMessages(params: {
    messages: AgentMessage[];
    sessionContext: string;
    source: string;
    priorMessages?: AgentMessage[];
    sessionFile?: string;
  }): Promise<{ messages: AgentMessage[]; replayGuardExemptPrefixLength: number }> {
    if (params.messages.length < 3) {
      return { messages: params.messages, replayGuardExemptPrefixLength: 0 };
    }

    let replayCandidateLength = 0;
    while (
      replayCandidateLength < params.messages.length &&
      isBootstrapReplayCandidateMessage(params.messages[replayCandidateLength]!)
    ) {
      replayCandidateLength += 1;
    }
    if (replayCandidateLength < 3) {
      return { messages: params.messages, replayGuardExemptPrefixLength: 0 };
    }

    const priorMessages =
      params.priorMessages ??
      (params.sessionFile ? await readLeafPathMessages(params.sessionFile) : undefined);
    if (!priorMessages || priorMessages.length === 0) {
      return { messages: params.messages, replayGuardExemptPrefixLength: 0 };
    }

    const replayCandidates = params.messages.slice(0, replayCandidateLength);
    const earlierReplayCandidates = (
      params.priorMessages ? priorMessages : priorMessages.slice(0, Math.max(0, priorMessages.length - params.messages.length))
    ).filter(isBootstrapReplayCandidateMessage);
    if (earlierReplayCandidates.length < 3) {
      return { messages: params.messages, replayGuardExemptPrefixLength: 0 };
    }

    const incomingSignatures = replayCandidates.map(createLosslessMessageSignature);
    const earlierSignatures = earlierReplayCandidates.map(createLosslessMessageSignature);

    let replayPrefixLength = 0;
    prefixLoop:
    for (
      let candidatePrefixLength = incomingSignatures.length;
      candidatePrefixLength >= 3;
      candidatePrefixLength -= 1
    ) {
      for (
        let startIndex = 0;
        startIndex <= earlierSignatures.length - candidatePrefixLength;
        startIndex += 1
      ) {
        let matched = true;
        for (let offset = 0; offset < candidatePrefixLength; offset += 1) {
          if (earlierSignatures[startIndex + offset] !== incomingSignatures[offset]) {
            matched = false;
            break;
          }
        }
        if (matched) {
          replayPrefixLength = candidatePrefixLength;
          break prefixLoop;
        }
      }
    }

    if (replayPrefixLength > 0) {
      this.host.deps.log.warn(
        `[lcm] bootstrap replay guard: ${params.source} dropped ${replayPrefixLength}/${params.messages.length} replayed transcript messages for ${params.sessionContext}`,
      );
    }

    if (replayPrefixLength > 0) {
      return {
        messages: params.messages.slice(replayPrefixLength),
        replayGuardExemptPrefixLength: Math.max(0, replayCandidateLength - replayPrefixLength),
      };
    }

    return {
      messages: params.messages,
      replayGuardExemptPrefixLength: replayCandidateLength,
    };
  }

  /**
   * Ingest a reconciled batch in order, returning how many rows persisted.
   * Indexes below `replayGuardExemptPrefixLength` skip the replay-timestamp
   * flood guard (transcript-proven history); pass Infinity to exempt all.
   */
  private async ingestBatch(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    replayGuardExemptPrefixLength: number;
    // When both are set, each candidate runs the two-tier replay-twin gate below
    // (used by the append-only fast path, whose parsed delta cannot see a
    // persisted twin from a prior pass).
    replayTwinConversationId?: number;
    replayTwinSessionFile?: string;
    onReplayTwinSkipped?: () => void;
  }): Promise<number> {
    let importedMessages = 0;
    // Tier 2 full-tail index, built lazily at most once per batch: only a Tier-1
    // store hit (a persisted same-identity, same-second row) justifies the full
    // leaf-path re-read.
    let replayTwinIndex: Map<string, string[]> | null = null;
    for (const [index, message] of params.messages.entries()) {
      const { replayTwinConversationId, replayTwinSessionFile } = params;
      if (
        replayTwinConversationId !== undefined &&
        replayTwinSessionFile !== undefined &&
        this.replayTwinKey(message) !== null
      ) {
        const stored = toStoredMessage(message);
        const tier1 = await this.host.conversationStore.hasPersistedIdentityAtCreatedAtSecond(
          replayTwinConversationId,
          stored.role,
          stored.content,
          resolveTranscriptMessageCreatedAt(message),
        );
        if (tier1) {
          replayTwinIndex ??= this.buildReplayTwinIndex(
            await readLeafPathMessages(replayTwinSessionFile),
          );
          if (
            await this.candidateHasPersistedReplayTwin(
              replayTwinConversationId,
              message,
              replayTwinIndex,
            )
          ) {
            this.host.deps.log.debug(
              `[lcm] ingestBatch: skipped source-identity replay twin entry=${getTranscriptEntryId(message) ?? "?"} conversation=${replayTwinConversationId}`,
            );
            params.onReplayTwinSkipped?.();
            continue;
          }
        }
      }
      const result = await this.host.ingestSingle({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        message,
        createdAt: resolveTranscriptMessageCreatedAt(message),
        skipReplayTimestampFloodGuard: index < params.replayGuardExemptPrefixLength,
      });
      if (result.ingested) {
        importedMessages += 1;
      }
    }
    return importedMessages;
  }

  /**
   * Record a successful reconcile import and refresh the bootstrap
   * checkpoint to the transcript frontier. No-op when nothing imported.
   */
  private async recordImportAndRefreshCheckpoint(params: {
    conversationId: number;
    sessionFile: string;
    importedMessages: number;
  }): Promise<void> {
    if (params.importedMessages <= 0) {
      return;
    }
    this.host.recordRecentBootstrapImport(
      params.conversationId,
      params.importedMessages,
      "reconciled missing session messages",
    );
    await this.refreshBootstrapState({
      conversationId: params.conversationId,
      sessionFile: params.sessionFile,
    });
  }

  /**
   * Seed an offset-0 placeholder bootstrap_state row so the next turn can
   * recover via the incremental path. Used only when no checkpoint exists;
   * failures are logged and swallowed (the slow path retries later).
   */
  private async seedPlaceholderBootstrapState(params: {
    conversationId: number;
    sessionFile: string;
  }): Promise<void> {
    try {
      await this.host.summaryStore.upsertConversationBootstrapState({
        conversationId: params.conversationId,
        sessionFilePath: params.sessionFile,
        lastSeenSize: 0,
        lastSeenMtimeMs: 0,
        lastProcessedOffset: 0,
        lastProcessedEntryHash: null,
      });
    } catch (seedError) {
      this.host.deps.log.warn(
        `[lcm] afterTurn: transcript reconcile slow path failed to seed placeholder bootstrap_state conversation=${params.conversationId} sessionFile=${params.sessionFile} error=${seedError instanceof Error ? seedError.message : String(seedError)}`,
      );
    }
  }

  /**
   * First-contact import: no persisted conversation exists for this session
   * yet, so the transcript (not the runtime delta) seeds it — foreground
   * prompts can be omitted from afterTurn's messages array. Bounded by the
   * bootstrap budget; heartbeat-ack turns defer to the runtime batch path,
   * which owns conversation creation and heartbeat pruning.
   */
  private async importInitialAfterTurnTranscript(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    isHeartbeat?: boolean;
  }): Promise<TranscriptReconcileResult> {
      if (params.isHeartbeat) {
        return { importedMessages: 0, blockedByImportCap: false, hasOverlap: true };
      }
      // No persisted conversation exists yet. Prefer the transcript over
      // the runtime delta so foreground prompts that are omitted from
      // afterTurn's messages array are not lost.
      let sessionFileState: { size: number } | undefined;
      try {
        const sessionFileStats = await stat(params.sessionFile);
        sessionFileState = { size: sessionFileStats.size };
      } catch {
        // Missing files are common for brand-new live sessions; allow the
        // runtime batch to seed the conversation in that case.
      }
      const historicalMessages = await readLeafPathMessages(params.sessionFile);
      if (historicalMessages.length === 0) {
        if ((sessionFileState?.size ?? 0) > 0) {
          this.host.deps.log.warn(
            `[lcm] afterTurn: initial transcript read returned no messages from non-empty file; skipping live afterTurn persistence to avoid anchoring past unreadable history session=${params.sessionId}${params.sessionKey?.trim() ? ` sessionKey=${params.sessionKey.trim()}` : ""} sessionFile=${params.sessionFile}`,
          );
          return { importedMessages: 0, blockedByImportCap: false, hasOverlap: false };
        }
        return { importedMessages: 0, blockedByImportCap: false, hasOverlap: true };
      }
      if (batchLooksLikeHeartbeatAckTurn(historicalMessages)) {
        // Not covered: the runtime batch path owns conversation creation
        // and heartbeat-ack pruning for brand-new sessions.
        return { importedMessages: 0, blockedByImportCap: false, hasOverlap: true };
      }
      const bootstrapMessages = trimBootstrapMessagesToBudget(
        historicalMessages,
        resolveBootstrapMaxTokens(this.host.config),
      );
      if (bootstrapMessages.length === 0) {
        this.host.deps.log.warn(
          `[lcm] afterTurn: initial transcript import exceeded bootstrap budget; skipping live afterTurn persistence to avoid anchoring past unreconciled history session=${params.sessionId}${params.sessionKey?.trim() ? ` sessionKey=${params.sessionKey.trim()}` : ""} sessionFile=${params.sessionFile} sourceMessages=${historicalMessages.length}`,
        );
        return { importedMessages: 0, blockedByImportCap: true, hasOverlap: false };
      }
      const importedMessages = await this.ingestBatch({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        messages: bootstrapMessages,
        replayGuardExemptPrefixLength: Number.POSITIVE_INFINITY,
      });
      if (importedMessages > 0) {
        const activeConversation = await this.host.conversationStore.getConversationForSession({
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        if (activeConversation) {
          this.host.recordRecentBootstrapImport(
            activeConversation.conversationId,
            importedMessages,
            "imported initial afterTurn transcript",
          );
          await this.refreshBootstrapState({
            conversationId: activeConversation.conversationId,
            sessionFile: params.sessionFile,
          });
        }
      }
      return {
        importedMessages,
        blockedByImportCap: bootstrapMessages.length < historicalMessages.length,
        hasOverlap: true,
        transcriptCovered: true,
      };
  }

  /**
   * Append-only fast path: when the checkpoint matches this transcript file
   * and the file only grew, judge just the appended slice. Returns the
   * reconcile result when the append-only read fully covered the turn, or
   * null when the slice is ineligible (overlap with persisted rows, suffix
   * rewrite, shrink) and the caller must fall back to a full re-read.
   */
  private async tryAppendOnlyReconcile(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    isHeartbeat?: boolean;
    conversation: ConversationRecord;
    checkpoint: Awaited<ReturnType<SummaryStore["getConversationBootstrapState"]>>;
    transcriptEpochShrank: boolean;
  }): Promise<TranscriptReconcileResult | null> {
    const { conversation, checkpoint, transcriptEpochShrank } = params;
    if (
      checkpoint &&
      checkpoint.sessionFilePath === params.sessionFile &&
      checkpoint.lastProcessedOffset >= 0 &&
      !transcriptEpochShrank
    ) {
      const appended = await readAppendedLeafPathMessages({
        sessionFile: params.sessionFile,
        offset: checkpoint.lastProcessedOffset,
      });
      if (appended.canUseAppendOnly) {
        const placeholderCheckpoint =
          checkpoint.lastSeenSize === 0 &&
          checkpoint.lastSeenMtimeMs === 0 &&
          checkpoint.lastProcessedOffset === 0 &&
          checkpoint.lastProcessedEntryHash === null;
        if (params.isHeartbeat) {
          if (!placeholderCheckpoint) {
            await this.refreshBootstrapState({
              conversationId: conversation.conversationId,
              sessionFile: params.sessionFile,
            });
            this.host.deps.log.debug(
              `[lcm] afterTurn: skipped heartbeat transcript append-only delta and refreshed checkpoint conversation=${conversation.conversationId} sessionFile=${params.sessionFile} appendedMessages=${appended.messages.length}`,
            );
          }
          // Heartbeat turns are never persisted; the append-only delta is
          // intentionally skipped, so the transcript counts as covered.
          return {
            importedMessages: 0,
            blockedByImportCap: false,
            hasOverlap: true,
            transcriptCovered: true,
          };
        }
        if (placeholderCheckpoint && appended.messages.length > 0) {
          // #822: a placeholder checkpoint means this conversation was never
          // ingested, so its on-disk transcript is the source of truth and
          // importing it as a new epoch is the correct recovery — but ONLY when
          // the persisted frontier holds no real conversation content a
          // rotated/unrelated transcript could overwrite. When eligible we also
          // lift the no-anchor import cap because there is no real content to
          // flood/duplicate (bounded by the transcript, never unbounded — the
          // failure that closed #824). Otherwise allowNoAnchorImport stays false
          // and the conversation freezes exactly as before (#649).
          const placeholderFrontierIsNonAnchoring =
            await this.conversationFrontierIsEntirelyNonAnchoring(
              conversation.conversationId,
            );
          const reconcile = await this.reconcileSessionTail({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            conversationId: conversation.conversationId,
            historicalMessages: appended.messages,
            allowNoAnchorImport: placeholderFrontierIsNonAnchoring,
            allowFullNonAnchoringFrontierImport: placeholderFrontierIsNonAnchoring,
            noAnchorImportReason: "placeholder-checkpoint-recovery",
          });
          await this.recordImportAndRefreshCheckpoint({
            conversationId: conversation.conversationId,
            sessionFile: params.sessionFile,
            importedMessages: reconcile.importedMessages,
          });
          return {
            ...reconcile,
            transcriptCovered: reconcile.hasOverlap || reconcile.importedMessages > 0,
          };
        }

        const appendOnlySessionContext = this.host.formatSessionLogContext({
          conversationId: conversation.conversationId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        });
        const replayFiltered = await this.filterBootstrapReplayMessages({
          messages: appended.messages,
          sessionContext: appendOnlySessionContext,
          source: "afterTurn transcript reconcile append-only",
          sessionFile: params.sessionFile,
        });
        const replayFilteredMessages = replayFiltered.messages;
        const appendOnlyOverlapsPersisted = await this.appendOnlyMessagesOverlapPersistedTranscript({
          conversationId: conversation.conversationId,
          messages: replayFilteredMessages,
          unfilteredMessages: appended.messages,
          sessionContext: appendOnlySessionContext,
          source: "afterTurn transcript reconcile append-only",
        });
        if (!appendOnlyOverlapsPersisted) {
          let replayTwinsSkipped = 0;
          const importedMessages = await this.ingestBatch({
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            messages: replayFilteredMessages,
            replayGuardExemptPrefixLength: replayFiltered.replayGuardExemptPrefixLength,
            replayTwinConversationId: conversation.conversationId,
            replayTwinSessionFile: params.sessionFile,
            onReplayTwinSkipped: () => {
              replayTwinsSkipped += 1;
            },
          });
          if (importedMessages > 0) {
            await this.recordImportAndRefreshCheckpoint({
              conversationId: conversation.conversationId,
              sessionFile: params.sessionFile,
              importedMessages,
            });
          } else if (replayTwinsSkipped > 0) {
            await this.refreshBootstrapState({
              conversationId: conversation.conversationId,
              sessionFile: params.sessionFile,
            });
          }
          return {
            importedMessages,
            blockedByImportCap: false,
            hasOverlap: true,
            transcriptCovered: true,
          };
        }
      }
    }
    return null;
  }

  /**
   * Full re-read slow path: the checkpoint is missing, path-mismatched,
   * shrunk, or append-only-ineligible. Re-reads the whole transcript, runs
   * ambiguous-rollover tier-2 checks on path mismatches, decides whether a
   * no-anchor epoch import is permitted (declared epoch rollover, shrink,
   * checkpoint recovery), delegates to reconcileSessionTail, and refreshes
   * the checkpoint only when the read proved coverage. Unchanged file states
   * are memoized per process so stale checkpoints do not force a full
   * O(file-size) read on every turn.
   */
  private async fullReadAfterTurnReconcile(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    allowNoAnchorImportOnCheckpointMissing?: boolean;
    queueKey: string;
    conversation: ConversationRecord;
    checkpoint: Awaited<ReturnType<SummaryStore["getConversationBootstrapState"]>>;
    sessionFileState: { size: number; mtimeMs: number } | undefined;
    sessionFileStatError: unknown;
    transcriptEpochShrank: boolean;
  }): Promise<TranscriptReconcileResult> {
    const {
      queueKey,
      conversation,
      checkpoint,
      sessionFileState,
      sessionFileStatError,
      transcriptEpochShrank,
    } = params;
    // Slow path: checkpoint missing, path mismatched, or non-append-only.
    // Cap full re-reads only for unchanged file states. If the transcript
    // changed since the last full read, reconcile again; if it did not,
    // skip without advancing the checkpoint so stale state can be retried
    // after a later file change, process restart, or cap eviction.
    const fullReadKey = `${queueKey}\u0000${params.sessionFile}`;
    const reason = !checkpoint
      ? "checkpoint-missing"
      : checkpoint.sessionFilePath !== params.sessionFile
        ? "path-mismatch"
        : transcriptEpochShrank
          ? "same-path-shrink"
          : "append-only-ineligible";
    if (reason === "same-path-shrink") {
      this.afterTurnReconcileFullReadStates.delete(fullReadKey);
    }
    const rememberedFileState = this.afterTurnReconcileFullReadStates.get(fullReadKey);
    if (
      rememberedFileState
      && sessionFileState
      && rememberedFileState.size === sessionFileState.size
      && rememberedFileState.mtimeMs === sessionFileState.mtimeMs
    ) {
      this.host.deps.log.debug(
        `[lcm] afterTurn: transcript reconcile slow path skipped (file state already read this process) conversation=${conversation.conversationId} reason=${reason} sessionFile=${params.sessionFile}`,
      );
      // The memo is only populated after a successful covered full read,
      // and the file has not changed since — still covered.
      return {
        importedMessages: 0,
        blockedByImportCap: false,
        hasOverlap: true,
        transcriptCovered: true,
      };
    }

    const rememberSlowReadState = (): void => {
      if (!sessionFileState) {
        return;
      }
      if (
        !this.afterTurnReconcileFullReadStates.has(fullReadKey)
        && this.afterTurnReconcileFullReadStates.size
          >= TranscriptReconciler.AFTER_TURN_RECONCILE_KEY_CAP
      ) {
        const oldest = this.afterTurnReconcileFullReadStates.keys().next().value;
        if (typeof oldest === "string") {
          this.afterTurnReconcileFullReadStates.delete(oldest);
        }
      }
      this.afterTurnReconcileFullReadStates.set(fullReadKey, sessionFileState);
    };
    const slowPathStartedAt = Date.now();

    if (isMissingFileError(sessionFileStatError)) {
      if (!checkpoint) {
        await this.seedPlaceholderBootstrapState({
          conversationId: conversation.conversationId,
          sessionFile: params.sessionFile,
        });
        this.host.deps.log.warn(
          `[lcm] afterTurn: session file missing; skipping transcript reconcile full reread; could not stat/read transcript; allowing live afterTurn persistence and seeding placeholder bootstrap_state at offset=0 to unblock next-turn recovery conversation=${conversation.conversationId} reason=${reason} sessionFile=${params.sessionFile}`,
        );
      } else {
        this.host.deps.log.warn(
          `[lcm] afterTurn: session file missing; skipping transcript reconcile full reread; preserving existing checkpoint (offset=${checkpoint.lastProcessedOffset}) conversation=${conversation.conversationId} reason=${reason} sessionFile=${params.sessionFile}`,
        );
      }
      return {
        importedMessages: 0,
        blockedByImportCap: false,
        hasOverlap: true,
      };
    }

    // Distinguish empty-file from read/parse error: stat the file and
    // only treat it as "actually empty" when size is 0. A non-zero file
    // returning empty `historicalMessages` indicates the parser hit an
    // error (and `readLeafPathMessages` swallows those into `[]`); in
    // that case we must NOT mark the bootstrap checkpoint as fully
    // processed, otherwise future afterTurns will skip reconciliation
    // and we lose messages.
    const historicalMessages = await readLeafPathMessages(params.sessionFile);
    if (reason === "path-mismatch") {
      const ambiguousRollover =
        await this.rolloverDetector.findAmbiguousSessionKeyRuntimeRollover({
          phase: "afterTurn",
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
        });
      if (ambiguousRollover) {
        const activeBootstrapState =
          await this.host.summaryStore.getConversationBootstrapState(
            ambiguousRollover.conversationId,
          );
        const hasFrontierAnchor =
          await this.rolloverDetector.transcriptContainsCurrentConversationTailAnchor({
            conversationId: ambiguousRollover.conversationId,
            historicalMessages,
            checkpointEntryHash: activeBootstrapState?.lastProcessedEntryHash,
          });
        if (!hasFrontierAnchor) {
          // Tier-2 resolution: rebind the frozen conversation and import the
          // fresh transcript now. The freshness proof is the extra safety signal
          // that lets the no-anchor path ingest the full id-less transcript.
          const rolloverResolution =
            await this.rolloverDetector.rotateAmbiguousRolloverForProvablyFreshTranscript({
              phase: "afterTurn",
              sessionId: params.sessionId,
              rollover: ambiguousRollover,
              candidateMessages: historicalMessages,
              createReplacement: true,
            });
          if (rolloverResolution.rebound) {
            const reconcile = await this.importFreshAmbiguousRolloverTranscript({
              sessionId: params.sessionId,
              sessionKey: params.sessionKey,
              sessionFile: params.sessionFile,
              conversationId: ambiguousRollover.conversationId,
              historicalMessages,
            });
            return reconcile.blockedByImportCap
              ? {
                  ...reconcile,
                  blockedReason: "ambiguous-rollover-rotated-fresh-transcript",
                }
              : reconcile;
          }
          this.rolloverDetector.logAmbiguousSessionKeyRuntimeRollover({
            phase: "afterTurn",
            rollover: ambiguousRollover,
            sessionId: params.sessionId,
            sessionFile: params.sessionFile,
            expected: rolloverResolution.preserveExpected,
            alreadyWarned: rolloverResolution.alreadyWarned,
          });
          return {
            importedMessages: 0,
            blockedByImportCap: false,
            blockedReason: "ambiguous-session-key-runtime-rollover",
            hasOverlap: false,
          };
        }
      }
    }
    if (historicalMessages.length === 0) {
      if (!sessionFileState) {
        // #649 added this permissive stat-fail fallback expecting the
        // afterTurn-tail `refreshAfterTurnBootstrapState` hook to refresh
        // the checkpoint. That hook delegates to refreshBootstrapState,
        // which itself calls `stat(sessionFile)` and throws on failure;
        // the hook's catch then logs a warn and leaves
        // conversation_bootstrap_state NULL. Subsequent turns re-enter
        // the slow path with reason="checkpoint-missing" (excluded from
        // allowNoAnchorImport) and the conversation gets stuck in a
        // transparent-passthrough state where compaction never runs.
        //
        // Seed a placeholder bootstrap_state row ONLY when no checkpoint
        // already exists. If a valid checkpoint is present (with a
        // non-zero offset), a transient stat/read failure must NOT reset
        // it to zero — that would cause the next successful read to
        // replay every message from offset=0, duplicating rows in the
        // messages table (identity_hash is not a uniqueness guard).
        if (!checkpoint) {
          await this.seedPlaceholderBootstrapState({
            conversationId: conversation.conversationId,
            sessionFile: params.sessionFile,
          });
          this.host.deps.log.warn(
            `[lcm] afterTurn: transcript reconcile slow path could not stat/read transcript; allowing live afterTurn persistence and seeding placeholder bootstrap_state at offset=0 to unblock next-turn recovery conversation=${conversation.conversationId} sessionFile=${params.sessionFile}`,
          );
        } else {
          // Checkpoint exists with a valid offset — a transient stat/read
          // failure must NOT overwrite it. Leave the existing checkpoint
          // intact so the next successful read resumes from the right offset.
          this.host.deps.log.warn(
            `[lcm] afterTurn: transcript reconcile slow path could not stat/read transcript; preserving existing checkpoint (offset=${checkpoint.lastProcessedOffset}) instead of reseeding conversation=${conversation.conversationId} sessionFile=${params.sessionFile}`,
          );
        }
        return {
          importedMessages: 0,
          blockedByImportCap: false,
          hasOverlap: true,
        };
      }
      if (sessionFileState.size === 0) {
        // File is genuinely empty — refresh the checkpoint so the next
        // afterTurn takes the incremental path.
        await this.refreshBootstrapState({
          conversationId: conversation.conversationId,
          sessionFile: params.sessionFile,
        });
        rememberSlowReadState();
      } else {
        this.host.deps.log.warn(
          `[lcm] afterTurn: transcript reconcile slow path read empty messages from non-empty file (${sessionFileState?.size ?? "?"} bytes) — skipping checkpoint refresh to avoid dropping messages on parser failure conversation=${conversation.conversationId} sessionFile=${params.sessionFile}`,
        );
      }
      // An empty transcript cannot carry the turn — let the runtime
      // batch persist it (transcriptCovered stays false).
      return {
        importedMessages: 0,
        blockedByImportCap: false,
        hasOverlap: sessionFileState.size === 0,
      };
    }
    // #837: a conversation with bootstrapped_at SET but no bootstrap_state
    // row reaches reason="checkpoint-missing" with a non-anchoring frontier
    // (e.g. injected metadata preambles). Without a no-anchor import it
    // imports 0 messages and never persists a checkpoint, so afterTurn
    // loops the "did not cover the transcript frontier" warning forever and
    // compaction never runs. The rotate lane already recovers via
    // allowNoAnchorImportOnCheckpointMissing; mirror that on the afterTurn
    // lane, but ONLY for a frontier composed entirely of injected-metadata
    // rows (#822 generalizes #837's single-row check: hosts inject one
    // metadata preamble per delivery, so stuck frontiers can hold several).
    // A real historical DB tail with a divergent rewritten transcript must
    // still freeze per #649's no-proof-no-advance guard, so do not treat
    // bootstrapped_at alone as lineage proof. The downstream no-anchor
    // import path is itself guarded (replay-overlap detection, import cap,
    // delivery-only block).
    // An idle-created channel session carries an ALL-ZERO placeholder
    // bootstrap_state row, so a row EXISTS and reason resolves to
    // "append-only-ineligible", never "checkpoint-missing". Both lanes were
    // never ingested, so the slow path treats the placeholder like a missing
    // checkpoint and recovers via the same non-anchoring-frontier guard the
    // checkpoint-missing lane uses; otherwise the frontier freezes forever.
    const placeholderCheckpoint =
      !!checkpoint &&
      checkpoint.lastSeenSize === 0 &&
      checkpoint.lastSeenMtimeMs === 0 &&
      checkpoint.lastProcessedOffset === 0 &&
      checkpoint.lastProcessedEntryHash === null;
    const neverIngestedCheckpoint = reason === "checkpoint-missing" || placeholderCheckpoint;
    let checkpointMissingMetadataFrontier = false;
    if (
      neverIngestedCheckpoint &&
      conversation.sessionId === params.sessionId &&
      conversation.bootstrappedAt !== null
    ) {
      checkpointMissingMetadataFrontier =
        await this.conversationFrontierIsEntirelyNonAnchoring(conversation.conversationId);
    }
    const recoverCheckpointMissingNoAnchor =
      neverIngestedCheckpoint &&
      (params.allowNoAnchorImportOnCheckpointMissing === true ||
        checkpointMissingMetadataFrontier);
    // A transcript whose session header id differs from the checkpoint's
    // is a *declared* epoch change (rewrite/rotation) — no heuristics
    // needed, so a same-path full rewrite may import as a new epoch
    // instead of freezing on "no anchor". The no-anchor path's replay
    // guards and import caps still apply as sanity bounds.
    const transcriptHeader = await readTranscriptHeader(params.sessionFile);
    const declaredEpochRollover =
      resolveEpochRoute({
        checkpointHeaderId: checkpoint?.sessionHeaderId,
        transcriptHeaderId: transcriptHeader.sessionHeaderId,
      }) === "declared-rollover";
    if (declaredEpochRollover) {
      this.host.deps.log.warn(
        `[lcm] afterTurn: transcript session header changed (${checkpoint?.sessionHeaderId} -> ${transcriptHeader.sessionHeaderId}); treating as declared epoch rollover conversation=${conversation.conversationId} reason=${reason} sessionFile=${params.sessionFile}`,
      );
    }
    const reconcile = await this.reconcileSessionTail({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      conversationId: conversation.conversationId,
      historicalMessages,
      lastProcessedEntryId: declaredEpochRollover
        ? null
        : checkpoint?.lastProcessedEntryId ?? null,
      skipContentAnchorScan: reason === "same-path-shrink",
      allowNoAnchorImport:
        reason === "path-mismatch" ||
        reason === "same-path-shrink" ||
        declaredEpochRollover ||
        recoverCheckpointMissingNoAnchor,
      // #822: when the checkpoint-missing frontier is a proven non-anchoring
      // metadata frontier, lift the no-anchor import cap too. Otherwise a large
      // real transcript (hundreds of messages) is blocked by the cap, stays
      // unimported, and the host keeps sending it raw until the provider context
      // window overflows. Same safety property as the placeholder lane; gated on
      // the proven metadata frontier, never the caller-asserted rotate flag.
      allowFullNonAnchoringFrontierImport: checkpointMissingMetadataFrontier,
      noAnchorImportReason: recoverCheckpointMissingNoAnchor
        ? params.allowNoAnchorImportOnCheckpointMissing === true
          ? "rotate-checkpoint-missing"
          : reason === "checkpoint-missing"
            ? "checkpoint-missing-recovery"
            : "placeholder-checkpoint-recovery"
        : declaredEpochRollover && reason === "append-only-ineligible"
          ? "declared-epoch-rollover"
          : reason,
    });
    if (reconcile.blockedByImportCap) {
      // Capped passes import a bounded chunk of anchored backlog; report
      // the partial progress while leaving the checkpoint un-advanced so
      // the next pass continues the drain.
      return {
        importedMessages: reconcile.importedMessages,
        blockedByImportCap: true,
        hasOverlap: reconcile.hasOverlap,
      };
    }
    if (reconcile.importedMessages > 0) {
      this.host.recordRecentBootstrapImport(
        conversation.conversationId,
        reconcile.importedMessages,
        "reconciled missing session messages",
      );
    }
    if (!reconcile.hasOverlap && reconcile.importedMessages === 0) {
      this.host.deps.log.warn(
        `[lcm] afterTurn: transcript reconcile found no anchor and imported 0 messages; skipping checkpoint refresh conversation=${conversation.conversationId} reason=${reason} sessionFile=${params.sessionFile} historicalMessages=${historicalMessages.length}`,
      );
      return { importedMessages: 0, blockedByImportCap: false, hasOverlap: false };
    }
    // Refresh only after the slow-path read either found an overlap or
    // imported the bounded no-anchor epoch. A no-overlap/no-import result
    // leaves the checkpoint stale on purpose so future turns can retry.
    await this.refreshBootstrapState({
      conversationId: conversation.conversationId,
      sessionFile: params.sessionFile,
    });
    rememberSlowReadState();
    this.host.deps.log.warn(
      `[lcm] afterTurn: transcript reconcile slow path (full re-read) conversation=${conversation.conversationId} reason=${reason} sessionFile=${params.sessionFile} historicalMessages=${historicalMessages.length} importedMessages=${reconcile.importedMessages} duration=${formatDurationMs(Date.now() - slowPathStartedAt)}`,
    );
    return {
      importedMessages: reconcile.importedMessages,
      blockedByImportCap: false,
      hasOverlap: reconcile.hasOverlap,
      transcriptCovered: true,
    };
  }

  async reconcileTranscriptTailForAfterTurnInSessionQueue(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    isHeartbeat?: boolean;
    allowNoAnchorImportOnCheckpointMissing?: boolean;
  }): Promise<TranscriptReconcileResult> {
    const queueKey = this.host.resolveSessionQueueKey(params.sessionId, params.sessionKey);
    const resolved = await this.resolveAfterTurnConversation(params);
    if (resolved.staleIsolatedCron) {
      return {
        importedMessages: 0,
        blockedByImportCap: false,
        blockedReason: "stale-isolated-cron-afterturn",
        hasOverlap: false,
      };
    }
    const conversation = resolved.conversation;
    if (!conversation) {
      return this.importInitialAfterTurnTranscript({
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        isHeartbeat: params.isHeartbeat,
      });
    }

    // OpenClaw can submit the foreground prompt outside the mutable
    // messages array passed to afterTurn. The transcript has the complete
    // turn by this point, so reconcile it before accepting assistant-only
    // deltas from the runtime snapshot.
    const checkpoint = await this.host.summaryStore.getConversationBootstrapState(
      conversation.conversationId,
    );
    let sessionFileState: { size: number; mtimeMs: number } | undefined;
    let sessionFileStatError: unknown;
    try {
      const sessionFileStats = await stat(params.sessionFile);
      sessionFileState = {
        size: sessionFileStats.size,
        mtimeMs: Math.trunc(sessionFileStats.mtimeMs),
      };
    } catch (error) {
      sessionFileStatError = error;
      // Leave undefined: without stat proof, do not use append-only guards or slow-read caps.
    }
    const transcriptEpochShrank = checkpointIsPastTranscriptEof(
      checkpoint,
      sessionFileState?.size ?? Number.POSITIVE_INFINITY,
    );
    const appendOnlyResult = await this.tryAppendOnlyReconcile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      isHeartbeat: params.isHeartbeat,
      conversation,
      checkpoint,
      transcriptEpochShrank,
    });
    if (appendOnlyResult) {
      return appendOnlyResult;
    }

    return this.fullReadAfterTurnReconcile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionFile: params.sessionFile,
      allowNoAnchorImportOnCheckpointMissing: params.allowNoAnchorImportOnCheckpointMissing,
      queueKey,
      conversation,
      checkpoint,
      sessionFileState,
      sessionFileStatError,
      transcriptEpochShrank,
    });
  }

  // Isolated cron keys identify a scheduled job family; the runtime sessionId
  // identifies one run. Resolve by runtime session first so a late afterTurn
  // from an archived run cannot archive or import into a newer active run.
  private async resolveAfterTurnConversation(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<{ conversation: ConversationRecord | null; staleIsolatedCron: boolean }> {
    const normalizedSessionKey = params.sessionKey?.trim();
    if (isIsolatedCronSessionKey(normalizedSessionKey)) {
      const cronSessionKey = normalizedSessionKey ?? "";
      const byRuntimeSession = await this.host.conversationStore.getConversationBySessionId(
        params.sessionId,
      );
      if (
        byRuntimeSession &&
        byRuntimeSession.sessionKey?.trim() === cronSessionKey
      ) {
        if (byRuntimeSession.active) {
          return { conversation: byRuntimeSession, staleIsolatedCron: false };
        }
        this.host.deps.log.warn(
          `[lcm] afterTurn: stale isolated cron runtime session; preserving active cron conversation session=${params.sessionId} sessionKey=${cronSessionKey}`,
        );
        return { conversation: null, staleIsolatedCron: true };
      }
      if (byRuntimeSession) {
        this.host.deps.log.warn(
          `[lcm] afterTurn: isolated cron runtime session is bound to another session key; skipping ambiguous import session=${params.sessionId} sessionKey=${cronSessionKey} boundSessionKey=${byRuntimeSession.sessionKey ?? ""}`,
        );
        return { conversation: null, staleIsolatedCron: true };
      }

      const activeByCronKey = await this.host.conversationStore.getConversationBySessionKey(
        cronSessionKey,
      );
      if (activeByCronKey && activeByCronKey.sessionId !== params.sessionId) {
        const historicalMessages = await readLeafPathMessages(params.sessionFile);
        const freshRuntime =
          await this.rolloverDetector.transcriptIsProvablyFreshForRuntimeRollover({
            phase: "afterTurn",
            conversationId: activeByCronKey.conversationId,
            sessionKey: cronSessionKey,
            activeSessionId: activeByCronKey.sessionId,
            nextSessionId: params.sessionId,
            candidateMessages: historicalMessages,
            source: "isolated-cron",
          });
        if (!freshRuntime) {
          this.host.deps.log.warn(
            `[lcm] afterTurn: isolated cron key is owned by another active runtime; preserving active cron conversation session=${params.sessionId} sessionKey=${cronSessionKey} activeSession=${activeByCronKey.sessionId}`,
          );
          return { conversation: null, staleIsolatedCron: true };
        }

        const rotated = await this.rolloverDetector.rotateIsolatedCronConversationIfRuntimeChanged({
          phase: "afterTurn",
          sessionId: params.sessionId,
          sessionKey: cronSessionKey,
          createReplacement: false,
        });
        if (!rotated) {
          return { conversation: null, staleIsolatedCron: true };
        }
        const conversation = await this.host.conversationStore.getConversationBySessionId(
          params.sessionId,
        );
        return { conversation, staleIsolatedCron: false };
      }

      return {
        conversation: activeByCronKey?.sessionId === params.sessionId ? activeByCronKey : null,
        staleIsolatedCron: false,
      };
    }

    await this.host.conversationStore.withTransaction(async () => {
      await this.rolloverDetector.rotateIsolatedCronConversationIfRuntimeChanged({
        phase: "afterTurn",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        createReplacement: false,
      });
      await this.rolloverDetector.rotateStaleSessionKeyConversationIfTrackedTranscriptMissing({
        phase: "afterTurn",
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        sessionFile: params.sessionFile,
        createReplacement: false,
      });
    });
    const conversation = await this.host.conversationStore.getConversationForSession({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    });
    return { conversation, staleIsolatedCron: false };
  }

  filterSyntheticHeartbeatTranscriptMessages(params: {
    messages: AgentMessage[];
    sessionContext: string;
    source: string;
  }): AgentMessage[] {
    const filtered = filterSyntheticHeartbeatMessages(params.messages);
    if (filtered.skipped > 0) {
      this.host.deps.log.debug(
        `[lcm] ${params.source}: skipped ${filtered.skipped}/${params.messages.length} synthetic heartbeat transcript messages for ${params.sessionContext}`,
      );
    }
    return filtered.messages;
  }

  async reconcileTranscriptTailForAfterTurn(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    isHeartbeat?: boolean;
    allowNoAnchorImportOnCheckpointMissing?: boolean;
  }): Promise<TranscriptReconcileResult> {
    const queueKey = this.host.resolveSessionQueueKey(params.sessionId, params.sessionKey);
    return await this.host.withSessionQueue(
      queueKey,
      () => this.reconcileTranscriptTailForAfterTurnInSessionQueue(params),
      {
        operationName: "afterTurnTranscriptReconcile",
        context: [
          `session=${params.sessionId}`,
          ...(params.sessionKey?.trim() ? [`sessionKey=${params.sessionKey.trim()}`] : []),
        ].join(" "),
      },
    );
  }

  /**
   * Persist bootstrap checkpoint metadata anchored to the current DB frontier.
   *
   * By default, the frontier hash follows the latest persisted DB message. The
   * first-time bootstrap path can override it with the raw transcript hash so
   * later reconciliation can anchor entries whose DB content was externalized.
   */
  async refreshBootstrapState(params: {
    conversationId: number;
    sessionFile: string;
    fileStats?: { size: number; mtimeMs: number };
    lastProcessedEntryHash?: string | null;
    forkBounded?: boolean;
    forkSourceMessageCount?: number;
  }): Promise<void> {
    const latestDbMessage = await this.host.conversationStore.getLastMessage(params.conversationId);
    const fileStats = params.fileStats ?? (await stat(params.sessionFile));
    // The checkpoint marks the whole file processed (offset = size), so the
    // exact resume anchor is the envelope id of the file's last message entry.
    let lastProcessedEntryId: string | null = null;
    const lastEntryLine = await readLastJsonlEntryBeforeOffset(
      params.sessionFile,
      fileStats.size,
      true,
    );
    if (lastEntryLine) {
      try {
        const parsed = JSON.parse(lastEntryLine) as { id?: unknown; uuid?: unknown };
        const rawId = typeof parsed.id === "string" ? parsed.id : typeof parsed.uuid === "string" ? parsed.uuid : "";
        lastProcessedEntryId = rawId.trim() || null;
      } catch {
        // Bare-message lines have no envelope id.
      }
    }
    const header = await readTranscriptHeader(params.sessionFile);
    await this.host.summaryStore.upsertConversationBootstrapState({
      conversationId: params.conversationId,
      sessionFilePath: params.sessionFile,
      lastSeenSize: fileStats.size,
      lastSeenMtimeMs: Math.trunc(fileStats.mtimeMs),
      lastProcessedOffset: fileStats.size,
      lastProcessedEntryHash:
        params.lastProcessedEntryHash !== undefined
          ? params.lastProcessedEntryHash
          : latestDbMessage
            ? createBootstrapEntryHash({
                role: latestDbMessage.role,
                content: latestDbMessage.content,
                tokenCount: latestDbMessage.tokenCount,
              })
            : null,
      sessionHeaderId: header.sessionHeaderId,
      lastProcessedEntryId,
      forkBounded: params.forkBounded,
      forkSourceMessageCount: params.forkSourceMessageCount,
    });
  }
}
