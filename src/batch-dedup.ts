/**
 * After-turn batch deduplication: guards ingest against gateway replays of
 * full history by aligning the runtime turn delta with the persisted
 * conversation tail (exact frontier alignment after a covered transcript
 * reconcile, heuristic overlap dedup otherwise).
 *
 * Extracted from engine.ts (Phase 2 of the engine decomposition).
 */
import {
  formatFileReference,
  formatRawPayloadReference,
  formatToolOutputReference,
  parseFileBlocks,
  type FileBlock,
} from "./large-files.js";
import { liveContentIsRecognizedDecoratedBareBody } from "./live-coverage.js";
import {
  extractStructuredText,
  RAW_PAYLOAD_EXTERNALIZATION_REASON,
  serializeRawPayloadContent,
  toStoredMessage,
  type StoredMessage,
} from "./message-content.js";
import { messageIdentity } from "./message-signatures.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import type { ConversationStore, MessageRecord } from "./store/conversation-store.js";
import { buildMessageIdentityHash } from "./store/message-identity.js";
import type { LargeFileRecord, SummaryStore } from "./store/summary-store.js";
import type { LcmDependencies } from "./types.js";

export class BatchDeduplicator {
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly summaryStore: SummaryStore,
    private readonly largeFilesDir: string,
    private readonly deps: Pick<LcmDependencies, "log">,
  ) {}

  /**
   * Remove messages from the batch that already exist in the DB for this session.
   * Conservative replay detection: only strip a prefix when the incoming
   * batch begins with the entire stored transcript for the session.
   *
   * Fixes two issues from #246:
   * 1. Replaced hasMessage() fast-path with aligned-tail check — the old
   *    approach false-positives on legitimate repeated first messages
   * 2. Dedup now runs on newMessages only, before autoCompactionSummary
   *    is prepended — synthetic summaries can no longer interfere with
   *    replay detection
   */
  /**
   * After a covered transcript reconcile the DB tail IS the transcript
   * frontier, so the runtime turn delta needs exact alignment, not heuristic
   * dedup. Three cases:
   *  - the transcript flushed the whole turn: the batch aligns fully with the
   *    DB tail — nothing to ingest;
   *  - the transcript flush lagged mid-turn: a prefix of the batch aligns
   *    with the DB tail — ingest only the remainder;
   *  - no tail alignment: a batch with zero persisted-identity overlap is a
   *    genuinely unflushed new turn (ingest all); any overlap means a stale
   *    replay snapshot — fail closed, because a covered transcript read will
   *    deliver anything real on the next turn idempotently.
   */
  /**
   * A runtime batch row is covered by a persisted frontier row when their
   * identities match, OR when the runtime copy is the DECORATED face of the
   * persisted bare body of the same turn. OpenClaw delivers the current turn
   * twice — the transcript persists the BARE body, while the runtime array
   * carries a per-turn DECORATED copy (for example, a leading channel
   * timestamp). Their identities differ, so the afterTurn
   * batch would otherwise persist the decorated copy as a second row (the store
   * double-write). liveContentIsRecognizedDecoratedBareBody collapses it only
   * when the runtime copy structurally contains the bare body AND carries
   * recognized timestamp decoration — user-role only. A genuinely distinct
   * turn, or one that merely quotes or authors metadata-shaped prose, is never
   * collapsed (silent data loss).
   */
  private runtimeRowCoversPersistedFrontierRow(
    persistedRole: string,
    persistedContent: string,
    batchRole: string,
    batchContent: string,
  ): boolean {
    if (
      messageIdentity(persistedRole, persistedContent) ===
      messageIdentity(batchRole, batchContent)
    ) {
      return true;
    }
    if (persistedRole !== "user" || batchRole !== "user") {
      return false;
    }
    return liveContentIsRecognizedDecoratedBareBody({
      liveContent: batchContent,
      bareContent: persistedContent,
    });
  }

  async alignRuntimeBatchAgainstCoveredFrontier(
    sessionId: string,
    sessionKey: string | undefined,
    batch: AgentMessage[],
  ): Promise<AgentMessage[]> {
    if (batch.length === 0) return batch;

    const conversation = await this.conversationStore.getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) return batch;
    const conversationId = conversation.conversationId;

    const storedBatch = batch.map((message) => toStoredMessage(message));
    const batchHashes = computeBatchIdentityHashes(storedBatch);
    const rawPayloadContents = computeBatchRawPayloadContents(batch, storedBatch);
    const tail = await this.conversationStore.getLastMessages(conversationId, batch.length);
    const tailHashes = await this.conversationStore.getRecentMessageIdentityHashes(
      conversationId,
      batch.length,
    );
    let unprovenExternalizedOverlap = false;
    for (let k = Math.min(tail.length, tailHashes.length, batch.length); k > 0; k -= 1) {
      const tailMessages = tail.slice(tail.length - k);
      const tailSlice = tailHashes.slice(tailHashes.length - k);
      let aligned = true;
      let exactAnchor = false;
      for (let i = 0; i < k; i += 1) {
        const match = await this.matchStoredMessageToIncoming(
          tailMessages[i]!,
          storedBatch[i]!,
          batchHashes[i]!,
          tailSlice[i]!,
          rawPayloadContents[i],
        );
        if (match === "unproven-externalized") {
          unprovenExternalizedOverlap = true;
          aligned = false;
          break;
        }
        if (!match) {
          // Identity_hash / externalized matching found no coverage. Recognize
          // the OpenClaw store double-write: a runtime row that is the DECORATED
          // face of the persisted bare body of the same turn — their
          // identity_hashes differ, so identity dedup cannot see it. Strictly
          // gated to genuine decoration; a distinct turn is never collapsed.
          if (
            this.runtimeRowCoversPersistedFrontierRow(
              tailMessages[i]!.role,
              tailMessages[i]!.content,
              storedBatch[i]!.role,
              storedBatch[i]!.content,
            )
          ) {
            exactAnchor = true;
            continue;
          }
          aligned = false;
          break;
        }
        exactAnchor ||= match === "exact";
      }
      // Externalized-only matches are ambiguous in the same way as suffix
      // fallback anchors: they may be a replay or a legitimate repeated upload.
      // Trim only when at least one matched message still has exact identity.
      if (aligned && exactAnchor) {
        return batch.slice(k);
      }
    }

    if (unprovenExternalizedOverlap) {
      this.deps.log.warn(
        `[lcm] afterTurn: runtime batch has an unproven externalized overlap with the covered transcript frontier; ingesting full batch conversation=${conversationId}`,
      );
      return batch;
    }

    const persistedIdentityOverlaps = await this.countPersistedIdentityOverlaps(
      conversationId,
      storedBatch,
    );
    if (persistedIdentityOverlaps > 0) {
      const overlapMessage = `[lcm] afterTurn: runtime batch does not align with the covered transcript frontier and overlaps persisted history (${persistedIdentityOverlaps}/${batch.length}); failing closed — the transcript reconcile delivers real messages next turn conversation=${conversationId}`;
      // Full overlap (N === batch.length) means every row is already persisted, so
      // failing closed drops nothing new: log at debug. A partial overlap still
      // defers genuinely new rows to the reconcile and stays at warn.
      if (await this.batchIsFullyPersistedByMultiplicity(conversationId, storedBatch)) {
        this.deps.log.debug(overlapMessage);
      } else {
        this.deps.log.warn(overlapMessage);
      }
      return [];
    }
    return batch;
  }

  async deduplicateAfterTurnBatch(
    sessionId: string,
    sessionKey: string | undefined,
    batch: AgentMessage[],
    options?: { oversizedNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    if (batch.length === 0) return batch;

    const conversation = await this.conversationStore.getConversationForSession({
      sessionId,
      sessionKey,
    });
    if (!conversation) return batch;

    const conversationId = conversation.conversationId;
    const storedMessageCount = await this.conversationStore.getMessageCount(conversationId);
    if (storedMessageCount === 0) return batch;

    const lastDbIdentityHash = await this.conversationStore.getLastMessageIdentityHash(conversationId);
    if (!lastDbIdentityHash) return batch;

    const storedBatch = batch.map((m) => toStoredMessage(m));
    const batchHashes = computeBatchIdentityHashes(storedBatch);
    const rawPayloadContents = computeBatchRawPayloadContents(batch, storedBatch);
    // When the DB already has more messages than the incoming batch,
    // the batch may be a tail-only replay. Try tail-matching first,
    // then fall back to suffix-matching.
    if (storedMessageCount > batch.length) {
      return this.deduplicateOversizedBatch(
        conversationId,
        batch,
        storedBatch,
        batchHashes,
        rawPayloadContents,
        storedMessageCount,
        lastDbIdentityHash,
        options,
      );
    }

    // Aligned-tail check: the DB's last message must align with the message at
    // the exact replay boundary in the incoming batch. Identity_hash is the
    // fast path; a hash mismatch still aligns when the boundary row is the
    // DECORATED face of the bare DB row (the store double-write — same turn,
    // different identity_hash), which is collapsed under a strict decoration
    // gate instead of ingested as a duplicate.
    const batchAtBoundaryHash = batchHashes[storedMessageCount - 1]!;
    if (batchAtBoundaryHash !== lastDbIdentityHash) {
      const lastDbMessage = await this.conversationStore.getLastMessage(conversationId);
      const batchAtBoundary = storedBatch[storedMessageCount - 1]!;
      if (
        !lastDbMessage ||
        !this.runtimeRowCoversPersistedFrontierRow(
          lastDbMessage.role,
          lastDbMessage.content,
          batchAtBoundary.role,
          batchAtBoundary.content,
        )
      ) {
        // Prefix mismatch — attempt suffix fallback before giving up.
        return this.deduplicateSuffixFallback(
          conversationId,
          batch,
          storedBatch,
          batchHashes,
          rawPayloadContents,
          storedMessageCount,
          "prefix-mismatch",
          { onNoOverlap: "ingest" },
        );
      }
    }

    // Full proof: incoming batch must start with the entire stored transcript
    // in exact order before we trim anything.
    const recentDbHashes = await this.conversationStore.getRecentMessageIdentityHashes(
      conversationId,
      storedMessageCount,
    );
    if (recentDbHashes.length !== storedMessageCount) {
      return batch;
    }
    const storedMessages = await this.conversationStore.getMessages(conversationId, {
      limit: storedMessageCount,
    });
    if (storedMessages.length !== storedMessageCount) {
      return batch;
    }
    for (let i = 0; i < storedMessageCount; i += 1) {
      const match = await this.matchStoredMessageToIncoming(
        storedMessages[i]!,
        storedBatch[i]!,
        batchHashes[i]!,
        recentDbHashes[i]!,
        rawPayloadContents[i],
      );
      if (match === "unproven-externalized") {
        return batch;
      }
      if (!match) {
        // Identity_hash / externalized matching found no coverage. Recognize
        // the OpenClaw store double-write: the incoming row is the DECORATED
        // face of the stored bare body of the same turn (different
        // identity_hash). Strictly gated to genuine decoration; a distinct turn
        // is never collapsed.
        if (
          !this.runtimeRowCoversPersistedFrontierRow(
            storedMessages[i]!.role,
            storedMessages[i]!.content,
            storedBatch[i]!.role,
            storedBatch[i]!.content,
          )
        ) {
          return batch;
        }
      }
    }

    return batch.slice(storedMessageCount);
  }

  /**
   * Handle the case where the DB has more messages than the incoming batch.
   * The batch is likely a tail-only replay after compaction — try to match
   * the entire batch against the tail of stored messages.
   */
  private async deduplicateOversizedBatch(
    conversationId: number,
    batch: AgentMessage[],
    storedBatch: ReturnType<typeof toStoredMessage>[],
    batchHashes: string[],
    rawPayloadContents: Array<string | null>,
    storedMessageCount: number,
    lastDbIdentityHash: string,
    options?: { oversizedNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    const lastBatchHash = batchHashes[batchHashes.length - 1]!;

    // Quick check: if the last DB identity_hash matches the last batch
    // identity_hash, verify that the entire batch matches the actual DB tail.
    if (lastDbIdentityHash === lastBatchHash) {
      const tailMessages = await this.conversationStore.getLastMessages(conversationId, batch.length);
      const tailHashes = await this.conversationStore.getRecentMessageIdentityHashes(
        conversationId,
        batch.length,
      );
      if (tailMessages.length === batch.length && tailHashes.length === batch.length) {
        let tailMatch = true;
        for (let i = 0; i < batch.length; i++) {
          const match = await this.matchStoredMessageToIncomingOrDecoratedCoverage(
            tailMessages[i]!,
            storedBatch[i]!,
            batchHashes[i]!,
            tailHashes[i]!,
            rawPayloadContents[i],
          );
          if (!match || match === "unproven-externalized") {
            tailMatch = false;
            break;
          }
        }
        if (tailMatch) {
          this.deps.log.debug(
            `[lcm] dedup: tail-match detected, batch already fully stored ` +
              `(storedCount=${storedMessageCount} batchLen=${batch.length}), skipping entire batch`,
          );
          return [];
        }
      }
    }

    // Fall back to suffix matching. Outside the transcript-covered path, a
    // short runtime batch with no overlap may be a genuine live turn after a
    // missing/unreadable transcript reconcile. Ingest on no-overlap unless the
    // caller has a stronger proof source and explicitly asks to skip.
    return this.deduplicateSuffixFallback(
      conversationId,
      batch,
      storedBatch,
      batchHashes,
      rawPayloadContents,
      storedMessageCount,
      "oversized",
      { onNoOverlap: options?.oversizedNoOverlap ?? "ingest" },
    );
  }

  /**
   * Suffix-matching fallback: scan the batch from the end looking for a
   * boundary where the stored transcript's tail aligns with a suffix of the
   * batch. Returns only the genuinely new messages after that boundary.
   */
  private async deduplicateSuffixFallback(
    conversationId: number,
    batch: AgentMessage[],
    storedBatch: ReturnType<typeof toStoredMessage>[],
    batchHashes: string[],
    rawPayloadContents: Array<string | null>,
    storedMessageCount: number,
    context: string,
    options?: { onNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    const allRecentHashes = await this.conversationStore.getRecentMessageIdentityHashes(
      conversationId,
      storedMessageCount,
    );
    if (allRecentHashes.length === 0) return batch;
    const allStored = await this.conversationStore.getMessages(conversationId, {
      limit: storedMessageCount,
    });
    if (allStored.length !== allRecentHashes.length) return batch;

    const lastStoredHash = allRecentHashes[allRecentHashes.length - 1]!;
    const lastStoredMessage = allStored[allStored.length - 1]!;
    let ambiguousExternalizedOverlap = false;

    for (let k = batch.length - 1; k >= 0; k--) {
      const lastMatch = await this.matchStoredMessageToIncomingOrDecoratedCoverage(
        lastStoredMessage,
        storedBatch[k]!,
        batchHashes[k]!,
        lastStoredHash,
        rawPayloadContents[k],
      );
      if (lastMatch === "unproven-externalized") {
        ambiguousExternalizedOverlap = true;
        continue;
      }
      if (!lastMatch) continue;

      const matchLen = Math.min(k + 1, allRecentHashes.length);
      const startDb = allRecentHashes.length - matchLen;
      let suffixMatch = true;
      let exactAnchor = lastMatch === "exact" || lastMatch === "decorated";
      for (let j = 0; j < matchLen; j++) {
        const match = await this.matchStoredMessageToIncomingOrDecoratedCoverage(
          allStored[startDb + j]!,
          storedBatch[k - matchLen + 1 + j]!,
          batchHashes[k - matchLen + 1 + j]!,
          allRecentHashes[startDb + j]!,
          rawPayloadContents[k - matchLen + 1 + j],
        );
        if (match === "unproven-externalized") {
          ambiguousExternalizedOverlap = true;
          suffixMatch = false;
          break;
        }
        if (!match) {
          suffixMatch = false;
          break;
        }
        exactAnchor ||= match === "exact" || match === "decorated";
      }
      const newSlice = batch.slice(k + 1);
      // Outside the transcript-covered path, an externalized-only anchor is
      // ambiguous: it may be a replay prefix or a new turn that repeats the
      // same upload. Require an exact anchor before trimming.
      if (
        suffixMatch &&
        exactAnchor &&
        (newSlice.length > 0 || matchLen > 1 || lastMatch === "decorated")
      ) {
        this.deps.log.debug(
          `[lcm] dedup: ${context} suffix-match at batch[${k}], ` +
            `returning ${newSlice.length} new messages ` +
            `(storedCount=${storedMessageCount} batchLen=${batch.length})`,
        );
        return newSlice;
      }
      if (suffixMatch && !exactAnchor) {
        ambiguousExternalizedOverlap = true;
      }
    }

    if (ambiguousExternalizedOverlap) {
      this.deps.log.warn(
        `[lcm] dedup: ${context}, storedCount=${storedMessageCount} batchLen=${batch.length}, ` +
          `externalized-only overlap is ambiguous — ingesting full batch`,
      );
      return batch;
    }

    const onNoOverlap = options?.onNoOverlap ?? "ingest";
    if (onNoOverlap === "skip") {
      this.deps.log.warn(
        `[lcm] dedup: ${context}, storedCount=${storedMessageCount} batchLen=${batch.length}, ` +
          `no overlap found — fail-closed skipping full batch`,
      );
      return [];
    }

    this.deps.log.warn(
      `[lcm] dedup: ${context}, storedCount=${storedMessageCount} batchLen=${batch.length}, ` +
        `no overlap found — ingesting full batch`,
    );
    return batch;
  }

  private async matchStoredMessageToIncomingOrDecoratedCoverage(
    storedMessage: MessageRecord,
    incoming: StoredMessage,
    incomingHash: string,
    storedHash: string,
    incomingRawPayloadContent?: string | null,
  ): Promise<"exact" | "externalized" | "unproven-externalized" | "decorated" | null> {
    const match = await this.matchStoredMessageToIncoming(
      storedMessage,
      incoming,
      incomingHash,
      storedHash,
      incomingRawPayloadContent,
    );
    if (match) {
      return match;
    }
    return this.runtimeRowCoversPersistedFrontierRow(
      storedMessage.role,
      storedMessage.content,
      incoming.role,
      incoming.content,
    )
      ? "decorated"
      : null;
  }

  private async matchStoredMessageToIncoming(
    storedMessage: MessageRecord,
    incoming: StoredMessage,
    incomingHash: string,
    storedHash: string,
    incomingRawPayloadContent?: string | null,
  ): Promise<"exact" | "externalized" | "unproven-externalized" | null> {
    if (
      storedHash === incomingHash &&
      storedMessage.role === incoming.role &&
      storedMessage.content === incoming.content
    ) {
      return "exact";
    }
    return this.messagesAreExternalizedEquivalent(
      storedMessage,
      incoming,
      incomingRawPayloadContent,
    );
  }

  private async countPersistedIdentityOverlaps(
    conversationId: number,
    incomingBatch: StoredMessage[],
  ): Promise<number> {
    let overlaps = 0;
    for (const incoming of incomingBatch) {
      if (await this.conversationStore.hasMessage(conversationId, incoming.role, incoming.content)) {
        overlaps += 1;
      }
    }
    return overlaps;
  }

  // Proves the debug-only case: every incoming occurrence has a distinct
  // persisted occurrence, so fail-closed cannot be hiding a new duplicate row.
  private async batchIsFullyPersistedByMultiplicity(
    conversationId: number,
    incomingBatch: StoredMessage[],
  ): Promise<boolean> {
    const requiredCounts = new Map<
      string,
      { role: StoredMessage["role"]; identityHash: string; count: number }
    >();
    for (const incoming of incomingBatch) {
      const identityHash = buildMessageIdentityHash(incoming.role, incoming.content);
      const key = `${incoming.role}\0${identityHash}`;
      const current = requiredCounts.get(key);
      if (current) {
        current.count += 1;
      } else {
        requiredCounts.set(key, { role: incoming.role, identityHash, count: 1 });
      }
    }

    for (const required of requiredCounts.values()) {
      const persistedCount = await this.conversationStore.countMessagesByIdentityHash(
        conversationId,
        required.role,
        required.identityHash,
      );
      if (persistedCount < required.count) {
        return false;
      }
    }
    return true;
  }

  private async messagesAreExternalizedEquivalent(
    storedMessage: MessageRecord,
    incoming: StoredMessage,
    incomingRawPayloadContent?: string | null,
  ): Promise<"externalized" | "unproven-externalized" | null> {
    if (storedMessage.role !== incoming.role) {
      return null;
    }
    let references = extractExternalizedReferences(storedMessage.content);
    if (references.length === 0) {
      return null;
    }
    const proofKeys = await this.getStoredExternalizedReferenceProofKeys(
      storedMessage,
      references,
    );
    if (proofKeys.size > 0) {
      references = references.filter((reference) => proofKeys.has(referenceProofKey(reference)));
      if (references.length === 0) {
        return null;
      }
    }
    const provenanceBacked =
      proofKeys.size > 0 &&
      references.every((reference) => proofKeys.has(referenceProofKey(reference)));

    if (
      references.length === 1 &&
      isWholeIncomingReference(references[0]!) &&
      (await this.referenceMatchesWholeIncoming(
        storedMessage,
        incoming,
        references[0]!,
        incomingRawPayloadContent,
      ))
    ) {
      return provenanceBacked ? "externalized" : "unproven-externalized";
    }

    const fileBlocks = parseFileBlocks(incoming.content);
    if (fileBlocks.length === 0) {
      if (
        await this.incomingNativeImagesMatchStoredContent(
          storedMessage.content,
          references,
          incomingRawPayloadContent,
        )
      ) {
        return provenanceBacked ? "externalized" : "unproven-externalized";
      }
      return (
        references.length === 1 &&
        isWholeIncomingReference(references[0]!) &&
        (await this.referenceMatchesWholeIncoming(
          storedMessage,
          incoming,
          references[0]!,
          incomingRawPayloadContent,
        ))
      )
        ? provenanceBacked ? "externalized" : "unproven-externalized"
        : null;
    }

    let rewritten = "";
    let cursor = 0;
    const usedReferenceIndexes = new Set<number>();
    for (const block of fileBlocks) {
      const referenceIndex = await this.findMatchingReferenceIndex(
        references,
        block,
        usedReferenceIndexes,
      );
      rewritten += incoming.content.slice(cursor, block.start);
      if (referenceIndex < 0) {
        rewritten += incoming.content.slice(block.start, block.end);
      } else {
        usedReferenceIndexes.add(referenceIndex);
        rewritten += references[referenceIndex]!.formattedReference;
      }
      cursor = block.end;
    }
    rewritten += incoming.content.slice(cursor);
    if (usedReferenceIndexes.size === references.length && rewritten === storedMessage.content) {
      return provenanceBacked ? "externalized" : "unproven-externalized";
    }
    return null;
  }

  private async incomingNativeImagesMatchStoredContent(
    storedContent: string,
    references: ExternalizedReference[],
    incomingRawPayloadContent?: string | null,
  ): Promise<boolean> {
    if (incomingRawPayloadContent == null || !references.every(isImageReference)) {
      return false;
    }
    const blocks = extractNativeImageReplayBlocks(incomingRawPayloadContent);
    if (!blocks) {
      return false;
    }

    let referenceIndex = 0;
    const rewritten: string[] = [];
    for (const block of blocks) {
      // Mirror extractStructuredText's array join while replacing each replayed
      // native image with the exact stored reference after byte proof.
      if (block.kind === "text") {
        rewritten.push(block.text);
        continue;
      }
      const reference = references[referenceIndex];
      if (!reference || !(await this.referenceMatchesNativeImage(reference, block.buffer))) {
        return false;
      }
      rewritten.push(reference.reference);
      referenceIndex += 1;
    }
    return referenceIndex === references.length && rewritten.join("\n") === storedContent;
  }

  private async getStoredExternalizedReferenceProofKeys(
    storedMessage: MessageRecord,
    references: ExternalizedReference[],
  ): Promise<Set<string>> {
    const proofKeys = new Set<string>();
    if (storedMessage.largeContent) {
      for (const reference of references) {
        if (reference.fileId === storedMessage.largeContent) {
          proofKeys.add(referenceProofKey(reference));
        }
      }
    }

    const parts = await this.conversationStore.getMessageParts(storedMessage.messageId);
    for (const part of parts) {
      const metadata = parsePartMetadata(part.metadata);
      if (!metadata) {
        continue;
      }
      if (
        metadata.rawPayloadExternalized === true &&
        metadata.externalizationReason === RAW_PAYLOAD_EXTERNALIZATION_REASON &&
        typeof metadata.externalizedFileId === "string"
      ) {
        proofKeys.add(`raw:${metadata.externalizedFileId}`);
      }
      if (
        metadata.fileBlocksExternalized === true &&
        metadata.externalizationReason === "large_file_block" &&
        Array.isArray(metadata.externalizedFileIds)
      ) {
        for (const fileId of metadata.externalizedFileIds) {
          if (typeof fileId === "string") {
            proofKeys.add(`file:${fileId}`);
          }
        }
      }
      if (
        metadata.toolOutputExternalized === true &&
        metadata.externalizationReason === "large_tool_result" &&
        typeof metadata.externalizedFileId === "string"
      ) {
        proofKeys.add(`tool:${metadata.externalizedFileId}`);
      }
      if (
        metadata.imageExternalized === true &&
        metadata.externalizationReason === "native_image" &&
        typeof metadata.externalizedFileId === "string"
      ) {
        proofKeys.add(`image:${metadata.externalizedFileId}`);
      }
    }

    return proofKeys;
  }

  private async referenceMatchesWholeIncoming(
    storedMessage: MessageRecord,
    incoming: StoredMessage,
    reference: ExternalizedReference,
    incomingRawPayloadContent?: string | null,
  ): Promise<boolean> {
    const largeFile = await this.summaryStore.getLargeFile(reference.fileId);
    if (!largeFile) {
      return false;
    }
    if (this.formatExternalizedReference(reference, largeFile, storedMessage) !== storedMessage.content) {
      return false;
    }
    if (isImageReference(reference)) {
      const incomingImage = extractSingleNativeImageBuffer(incomingRawPayloadContent ?? incoming.content);
      return incomingImage
        ? this.referenceMatchesNativeImage(reference, incomingImage)
        : false;
    }
    const contentToCompare =
      reference.reference.startsWith("[LCM Raw Payload:") && incomingRawPayloadContent != null
        ? incomingRawPayloadContent
        : incoming.content;
    if (
      await this.summaryStore.largeFileContentEquals(reference.fileId, contentToCompare, {
        largeFilesDir: this.largeFilesDir,
      })
    ) {
      return true;
    }
    if (
      !reference.reference.startsWith("[LCM Raw Payload:") ||
      incomingRawPayloadContent == null
    ) {
      return false;
    }
    const hasFileBlocks = parseFileBlocks(incomingRawPayloadContent).length > 0;
    const hasNativeImages = rawPayloadHasNativeImages(incomingRawPayloadContent);
    if (!hasFileBlocks && !hasNativeImages) {
      return false;
    }

    const storedPayload = await this.summaryStore.getLargeFileContent(reference.fileId, {
      largeFilesDir: this.largeFilesDir,
      maxBytes: largeFile.byteSize ?? Buffer.byteLength(incomingRawPayloadContent, "utf8"),
    });
    if (!storedPayload) {
      return false;
    }
    if (hasFileBlocks) {
      const rewrittenPayload = await this.rewriteIncomingFileBlocksFromStoredPayload(
        incomingRawPayloadContent,
        storedPayload,
      );
      if (rewrittenPayload === storedPayload) {
        return true;
      }
    }
    return hasNativeImages
      ? this.incomingNativeImageRawPayloadMatchesStoredPayload(
          incomingRawPayloadContent,
          storedPayload,
        )
      : false;
  }

  private async referenceMatchesNativeImage(
    reference: ExternalizedReference,
    incomingImage: Buffer,
  ): Promise<boolean> {
    const largeFile = await this.summaryStore.getLargeFile(reference.fileId);
    if (!largeFile?.mimeType?.toLowerCase().startsWith("image/")) {
      return false;
    }
    return this.summaryStore.largeFileBufferEquals(reference.fileId, incomingImage, {
      largeFilesDir: this.largeFilesDir,
    });
  }

  private async incomingNativeImageRawPayloadMatchesStoredPayload(
    incomingRawPayloadContent: string,
    storedPayload: string,
  ): Promise<boolean> {
    const incoming = parseJsonPayload(incomingRawPayloadContent);
    const stored = parseJsonPayload(storedPayload);
    if (!Array.isArray(incoming) || !Array.isArray(stored) || incoming.length !== stored.length) {
      return false;
    }

    for (let index = 0; index < incoming.length; index += 1) {
      const incomingEntry = incoming[index];
      const storedEntry = stored[index];
      const incomingImage = extractSingleNativeImageBufferFromValue(incomingEntry);
      if (!incomingImage) {
        // Non-image raw blocks must remain byte-for-byte JSON equivalent.
        if (isNativeImageEntry(incomingEntry) || JSON.stringify(incomingEntry) !== JSON.stringify(storedEntry)) {
          return false;
        }
        continue;
      }
      if (!(await this.storedRawPayloadImageEntryMatches(storedEntry, incomingImage))) {
        return false;
      }
    }
    return true;
  }

  private async storedRawPayloadImageEntryMatches(
    storedEntry: unknown,
    incomingImage: Buffer,
  ): Promise<boolean> {
    if (!storedEntry || typeof storedEntry !== "object" || Array.isArray(storedEntry)) {
      return false;
    }
    const record = storedEntry as Record<string, unknown>;
    if (
      record.type !== "text" ||
      record.imageExternalized !== true ||
      record.externalizationReason !== "native_image" ||
      typeof record.text !== "string" ||
      typeof record.externalizedFileId !== "string"
    ) {
      return false;
    }
    const references = extractExternalizedReferences(record.text);
    if (references.length !== 1 || references[0]!.fileId !== record.externalizedFileId) {
      return false;
    }
    return this.referenceMatchesNativeImage(references[0]!, incomingImage);
  }

  private async rewriteIncomingFileBlocksFromStoredPayload(
    incomingContent: string,
    storedPayload: string,
  ): Promise<string | null> {
    const references = extractExternalizedReferences(storedPayload);
    const fileBlocks = parseFileBlocks(incomingContent);
    if (references.length === 0 || fileBlocks.length === 0) {
      return null;
    }

    let rewritten = "";
    let cursor = 0;
    const usedReferenceIndexes = new Set<number>();
    for (const block of fileBlocks) {
      const referenceIndex = await this.findMatchingReferenceIndex(
        references,
        block,
        usedReferenceIndexes,
      );
      rewritten += incomingContent.slice(cursor, block.start);
      if (referenceIndex < 0) {
        rewritten += incomingContent.slice(block.start, block.end);
      } else {
        usedReferenceIndexes.add(referenceIndex);
        rewritten += references[referenceIndex]!.formattedReference;
      }
      cursor = block.end;
    }
    rewritten += incomingContent.slice(cursor);
    return usedReferenceIndexes.size === references.length ? rewritten : null;
  }

  private async findMatchingReferenceIndex(
    references: ExternalizedReference[],
    block: FileBlock,
    usedReferenceIndexes: Set<number>,
  ): Promise<number> {
    for (let index = 0; index < references.length; index += 1) {
      if (usedReferenceIndexes.has(index)) {
        continue;
      }
      const reference = references[index]!;
      const largeFile = await this.summaryStore.getLargeFile(reference.fileId);
      if (!largeFile) {
        continue;
      }
      if (
        (largeFile.fileName ?? undefined) !== block.fileName ||
        (largeFile.mimeType ?? undefined) !== block.mimeType
      ) {
        continue;
      }
      if (
        await this.summaryStore.largeFileContentEquals(reference.fileId, block.text, {
          largeFilesDir: this.largeFilesDir,
        })
      ) {
        reference.formattedReference = this.formatFileReference(largeFile);
        return index;
      }
    }
    return -1;
  }

  private formatExternalizedReference(
    reference: ExternalizedReference,
    largeFile: LargeFileRecord,
    storedMessage: MessageRecord,
  ): string {
    if (isImageReference(reference)) {
      return reference.reference;
    }

    if (reference.reference.startsWith("[LCM Tool Output:")) {
      return formatToolOutputReference({
        fileId: largeFile.fileId,
        toolName: extractReferenceField(reference.reference, "tool"),
        byteSize: largeFile.byteSize ?? 0,
        summary: largeFile.explorationSummary ?? "",
      });
    }

    if (reference.reference.startsWith("[LCM Raw Payload:")) {
      return formatRawPayloadReference({
        fileId: largeFile.fileId,
        role: extractReferenceField(reference.reference, "role") ?? storedMessage.role,
        reason:
          extractReferenceField(reference.reference, "reason") ??
          RAW_PAYLOAD_EXTERNALIZATION_REASON,
        byteSize: largeFile.byteSize ?? 0,
        summary: largeFile.explorationSummary ?? "",
      });
    }

    return this.formatFileReference(largeFile);
  }

  private formatFileReference(largeFile: LargeFileRecord): string {
    return formatFileReference({
      fileId: largeFile.fileId,
      fileName: largeFile.fileName ?? undefined,
      mimeType: largeFile.mimeType ?? undefined,
      byteSize: largeFile.byteSize ?? 0,
      summary: largeFile.explorationSummary ?? "",
    });
  }
}

function storedMessageIdentityHash(stored: StoredMessage): string {
  return buildMessageIdentityHash(stored.role, stored.content);
}

function computeBatchIdentityHashes(batch: StoredMessage[]): string[] {
  return batch.map((m) => storedMessageIdentityHash(m));
}

function computeBatchRawPayloadContents(
  batch: AgentMessage[],
  storedBatch: StoredMessage[],
): Array<string | null> {
  return batch.map((message, index) => {
    const rawPayload = serializeRawPayloadContent(message, storedBatch[index]?.content ?? "");
    return rawPayload?.content ?? null;
  });
}

type ExternalizedReference = {
  fileId: string;
  reference: string;
  formattedReference: string;
  end: number;
};

type NativeImageReplayBlock =
  | { kind: "text"; text: string }
  | { kind: "image"; buffer: Buffer };

function extractExternalizedReferences(content: string): ExternalizedReference[] {
  const references: ExternalizedReference[] = [];
  const summaryMarker = "\n\nExploration Summary:";
  const referencePattern = /\[LCM (?:File|Raw Payload|Tool Output):\s*(file_[a-f0-9]{16})\b/gi;
  let match: RegExpExecArray | null;
  while ((match = referencePattern.exec(content)) !== null) {
    const fileId = match[1]?.toLowerCase();
    if (!fileId) continue;
    const markerIndex = content.indexOf(summaryMarker, referencePattern.lastIndex);
    if (markerIndex < 0 || content[markerIndex - 1] !== "]") {
      continue;
    }
    const headerRemainder = content.slice(referencePattern.lastIndex, markerIndex);
    if (/\][\s\S]*\[LCM (?:File|Raw Payload|Tool Output):\s*file_[a-f0-9]{16}\b/i.test(headerRemainder)) {
      continue;
    }
    references.push({
      fileId,
      reference: content.slice(match.index, markerIndex),
      formattedReference: content.slice(match.index, markerIndex),
      end: markerIndex,
    });
    referencePattern.lastIndex = markerIndex;
  }
  const imageReferencePattern =
    /\[(?:(?:User|System|Tool|Assistant) image|Image): [^\]]*?\bLCM file:\s*(file_[a-f0-9]{16})\]/gi;
  while ((match = imageReferencePattern.exec(content)) !== null) {
    const fileId = match[1]?.toLowerCase();
    if (!fileId) continue;
    references.push({
      fileId,
      reference: match[0],
      formattedReference: match[0],
      end: imageReferencePattern.lastIndex,
    });
  }
  return references;
}

function extractReferenceField(reference: string, field: "tool" | "role" | "reason"): string | undefined {
  const match = new RegExp(`\\b${field}=([^|\\]]+)`).exec(reference);
  return match?.[1]?.trim() || undefined;
}

function referenceProofKey(reference: ExternalizedReference): string {
  if (reference.reference.startsWith("[LCM Raw Payload:")) {
    return `raw:${reference.fileId}`;
  }
  if (reference.reference.startsWith("[LCM File:")) {
    return `file:${reference.fileId}`;
  }
  if (reference.reference.startsWith("[LCM Tool Output:")) {
    return `tool:${reference.fileId}`;
  }
  if (isImageReference(reference)) {
    return `image:${reference.fileId}`;
  }
  return `other:${reference.fileId}`;
}

function isWholeIncomingReference(reference: ExternalizedReference): boolean {
  return (
    reference.reference.startsWith("[LCM Raw Payload:") ||
    reference.reference.startsWith("[LCM Tool Output:") ||
    isImageReference(reference)
  );
}

function isImageReference(reference: ExternalizedReference): boolean {
  return /^\[(?:(?:User|System|Tool|Assistant) image|Image): /i.test(reference.reference);
}

function extractSingleNativeImageBuffer(content: string): Buffer | null {
  const parsed = parseJsonPayload(content);
  const imageBlocks = parsed === undefined
    ? extractNativeImageBuffersFromValue(content)
    : extractNativeImageBuffersFromValue(parsed);
  return imageBlocks.length === 1 ? imageBlocks[0]! : null;
}

function extractNativeImageReplayBlocks(content: string): NativeImageReplayBlock[] | null {
  const parsed = parseJsonPayload(content);
  if (!Array.isArray(parsed)) {
    return null;
  }

  const blocks: NativeImageReplayBlock[] = [];
  let sawImage = false;
  for (const entry of parsed) {
    const image = extractSingleNativeImageBufferFromValue(entry);
    if (image) {
      blocks.push({ kind: "image", buffer: image });
      sawImage = true;
      continue;
    }
    if (isNativeImageEntry(entry)) {
      return null;
    }
    const text = extractStructuredText(entry);
    if (typeof text === "string" && text.trim().length > 0) {
      blocks.push({ kind: "text", text });
    }
  }

  return sawImage ? blocks : null;
}

function rawPayloadHasNativeImages(content: string): boolean {
  const parsed = parseJsonPayload(content);
  return Array.isArray(parsed) && parsed.some((entry) => extractSingleNativeImageBufferFromValue(entry));
}

function extractSingleNativeImageBufferFromValue(value: unknown): Buffer | null {
  const images = extractNativeImageBuffersFromValue(value);
  return images.length === 1 ? images[0]! : null;
}

function isNativeImageEntry(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "image"
  );
}

function extractNativeImageBuffersFromValue(value: unknown): Buffer[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractNativeImageBuffersFromValue(entry));
  }
  if (!value || typeof value !== "object") {
    return [];
  }

  const record = value as Record<string, unknown>;
  if (record.type === "image") {
    const data = typeof record.data === "string" ? record.data : undefined;
    const decoded = data ? decodeBase64ImageData(data) : null;
    return decoded ? [decoded] : [];
  }

  return [];
}

function decodeBase64ImageData(rawData: string): Buffer | null {
  const dataUrlMatch = rawData.match(/^data:([^;,]+);base64,(.*)$/s);
  const base64Data = (dataUrlMatch?.[2] ?? rawData).replace(/\s+/g, "");
  if (!base64Data || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64Data)) {
    return null;
  }
  try {
    return Buffer.from(base64Data, "base64");
  } catch {
    return null;
  }
}

function parseJsonPayload(content: string): unknown {
  const trimmed = content.trim();
  if (
    !((trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]")))
  ) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function parsePartMetadata(metadata: string | null): Record<string, unknown> | null {
  if (!metadata) {
    return null;
  }
  try {
    const parsed = JSON.parse(metadata);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
