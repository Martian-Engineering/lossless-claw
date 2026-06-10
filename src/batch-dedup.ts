/**
 * After-turn batch deduplication: guards ingest against gateway replays of
 * full history by aligning the runtime turn delta with the persisted
 * conversation tail (exact frontier alignment after a covered transcript
 * reconcile, heuristic overlap dedup otherwise).
 *
 * Extracted from engine.ts (Phase 2 of the engine decomposition).
 */
import { toStoredMessage } from "./message-content.js";
import { messageIdentity } from "./message-signatures.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import type { ConversationStore } from "./store/conversation-store.js";
import type { LcmDependencies } from "./types.js";

export class BatchDeduplicator {
  constructor(
    private readonly conversationStore: ConversationStore,
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
    const tail = await this.conversationStore.getLastMessages(conversationId, batch.length);
    for (let k = Math.min(tail.length, batch.length); k > 0; k -= 1) {
      const tailSlice = tail.slice(tail.length - k);
      let aligned = true;
      for (let i = 0; i < k; i += 1) {
        if (
          messageIdentity(tailSlice[i]!.role, tailSlice[i]!.content) !==
          messageIdentity(storedBatch[i]!.role, storedBatch[i]!.content)
        ) {
          aligned = false;
          break;
        }
      }
      if (aligned) {
        return batch.slice(k);
      }
    }

    let persistedIdentityOverlaps = 0;
    for (const stored of storedBatch) {
      if (await this.conversationStore.hasMessage(conversationId, stored.role, stored.content)) {
        persistedIdentityOverlaps += 1;
      }
    }
    if (persistedIdentityOverlaps > 0) {
      this.deps.log.warn(
        `[lcm] afterTurn: runtime batch does not align with the covered transcript frontier and overlaps persisted history (${persistedIdentityOverlaps}/${batch.length}); failing closed — the transcript reconcile delivers real messages next turn conversation=${conversationId}`,
      );
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

    const lastDbMessage = await this.conversationStore.getLastMessage(conversationId);
    if (!lastDbMessage) return batch;

    const storedBatch = batch.map((m) => toStoredMessage(m));

    // When the DB already has more messages than the incoming batch,
    // the batch may be a tail-only replay. Try tail-matching first,
    // then fall back to suffix-matching.
    if (storedMessageCount > batch.length) {
      return this.deduplicateOversizedBatch(
        conversationId,
        batch,
        storedBatch,
        storedMessageCount,
        lastDbMessage,
        options,
      );
    }

    // Aligned-tail check: DB's last message must match the message at the
    // exact replay boundary in the incoming batch. This replaces the
    // hasMessage() check which could false-positive on any repeated content.
    const batchAtBoundary = storedBatch[storedMessageCount - 1]!;
    if (
      messageIdentity(lastDbMessage.role, lastDbMessage.content) !==
      messageIdentity(batchAtBoundary.role, batchAtBoundary.content)
    ) {
      // Prefix mismatch — attempt suffix fallback before giving up.
      return this.deduplicateSuffixFallback(
        conversationId,
        batch,
        storedBatch,
        storedMessageCount,
        "prefix-mismatch",
      );
    }

    // Full proof: incoming batch must start with the entire stored transcript
    // in exact order before we trim anything.
    const storedMessages = await this.conversationStore.getMessages(conversationId, {
      limit: storedMessageCount,
    });
    if (storedMessages.length !== storedMessageCount) {
      return batch;
    }
    for (let i = 0; i < storedMessageCount; i += 1) {
      const storedConversationMessage = storedMessages[i]!;
      const incomingMessage = storedBatch[i]!;
      if (
        messageIdentity(storedConversationMessage.role, storedConversationMessage.content) !==
        messageIdentity(incomingMessage.role, incomingMessage.content)
      ) {
        return batch;
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
    storedMessageCount: number,
    lastDbMessage: { role: string; content: string },
    options?: { oversizedNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    const lastBatchIdentity = messageIdentity(
      storedBatch[storedBatch.length - 1]!.role,
      storedBatch[storedBatch.length - 1]!.content,
    );
    const lastDbIdentity = messageIdentity(lastDbMessage.role, lastDbMessage.content);

    // Quick check: if the last DB message matches the last batch message,
    // verify that the entire batch matches the actual DB tail. Message seq
    // can have gaps after maintenance deletes, so do not derive seq from count.
    if (lastDbIdentity === lastBatchIdentity) {
      const storedMessages = await this.conversationStore.getMessages(conversationId, {
        limit: storedMessageCount,
      });
      const tailMessages = storedMessages.slice(-batch.length);
      if (tailMessages.length === batch.length) {
        let tailMatch = true;
        for (let i = 0; i < batch.length; i++) {
          if (
            messageIdentity(tailMessages[i]!.role, tailMessages[i]!.content) !==
            messageIdentity(storedBatch[i]!.role, storedBatch[i]!.content)
          ) {
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

    // Fall back to suffix matching. If the DB is already longer than the
    // incoming afterTurn batch and no suffix overlap exists, fail closed:
    // importing the whole short batch as new would duplicate/pollute LCM with
    // stale runtime tail snapshots. The transcript reconcile path runs before
    // this and is responsible for importing genuine missing JSONL tail turns.
    return this.deduplicateSuffixFallback(
      conversationId,
      batch,
      storedBatch,
      storedMessageCount,
      "oversized",
      { onNoOverlap: options?.oversizedNoOverlap ?? "skip" },
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
    storedMessageCount: number,
    context: string,
    options?: { onNoOverlap?: "ingest" | "skip" },
  ): Promise<AgentMessage[]> {
    const allStored = await this.conversationStore.getMessages(conversationId, {
      limit: storedMessageCount,
    });
    if (allStored.length === 0) return batch;

    const lastStoredIdentity = messageIdentity(
      allStored[allStored.length - 1]!.role,
      allStored[allStored.length - 1]!.content,
    );

    for (let k = batch.length - 1; k >= 0; k--) {
      if (
        messageIdentity(storedBatch[k]!.role, storedBatch[k]!.content) !== lastStoredIdentity
      ) {
        continue;
      }
      const matchLen = Math.min(k + 1, allStored.length);
      const startDb = allStored.length - matchLen;
      let suffixMatch = true;
      for (let j = 0; j < matchLen; j++) {
        if (
          messageIdentity(
            allStored[startDb + j]!.role,
            allStored[startDb + j]!.content,
          ) !==
          messageIdentity(
            storedBatch[k - matchLen + 1 + j]!.role,
            storedBatch[k - matchLen + 1 + j]!.content,
          )
        ) {
          suffixMatch = false;
          break;
        }
      }
      const newSlice = batch.slice(k + 1);
      if (suffixMatch && (newSlice.length > 0 || matchLen > 1)) {
        this.deps.log.debug(
          `[lcm] dedup: ${context} suffix-match at batch[${k}], ` +
            `returning ${newSlice.length} new messages ` +
            `(storedCount=${storedMessageCount} batchLen=${batch.length})`,
        );
        return newSlice;
      }
    }

    if (options?.onNoOverlap === "skip") {
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
}
