import type {
  TranscriptCursorRecord,
  TranscriptCursorStore,
  StoredTranscriptRow,
  ContentMatchCandidate,
} from "../../store/transcript-cursor-store.js";
import type {
  TranscriptUserReplayKey,
  RawUserReplayKeyState,
} from "../../store/user-replay-key-store.js";
import type {
  TranscriptHistoryGap,
  TranscriptGapRecord,
  TranscriptGapTotals,
} from "../../store/transcript-gap-store.js";
import type { MessageRecord } from "../../store/conversation-store.js";
import { NativeRepository, collect, n, h, nextId } from "./repository.js";
import { NativeConversationStore } from "./conversations.js";
import { NativeSummaryStore } from "./summaries.js";
export class NativeTranscriptCursorStore extends NativeRepository {
  get(cid: number): Promise<TranscriptCursorRecord | null> {
    return this.read((v) => v.get(`cursor/${n(cid)}`));
  }
  upsert(input: Parameters<TranscriptCursorStore["upsert"]>[0]): Promise<void> {
    return this.write(async (tx) => {
      const old = await this.get(input.conversationId);
      await tx.put(`cursor/${n(input.conversationId)}`, {
        ...input,
        mode: "cursor_v1",
        origin: old?.origin ?? input.origin,
      });
    });
  }
  private async rows(cid: number, afterSeq = -1) {
    return this.read(async (v) => {
      const ids = await collect<number>(v, `message-seq/${n(cid)}/`),
        rows = await v.getMany<MessageRecord & { identityHash: string }>(
          ids.map((id) => `messages/${n(id)}`)
        );
      return rows.filter(
        (r): r is MessageRecord & { identityHash: string } =>
          r !== null && r.seq > afterSeq
      );
    });
  }
  listStampedRows(cid: number): Promise<Map<string, StoredTranscriptRow>> {
    return this.read(
      async () =>
        new Map(
          (await this.rows(cid))
            .filter((r) => r.transcriptEntryId !== null)
            .map((r) => [
              r.transcriptEntryId!,
              {
                messageId: r.messageId,
                seq: r.seq,
                identityHash: r.identityHash,
                transcriptEntryId: r.transcriptEntryId,
              },
            ])
        )
    );
  }
  countUnstampedRowsThroughSeq(cid: number, seq: number): Promise<number> {
    return this.read(
      async () =>
        (await this.rows(cid)).filter(
          (r) => r.seq <= seq && r.transcriptEntryId === null
        ).length
    );
  }
  countRowsBetweenSeq(cid: number, low: number, high: number): Promise<number> {
    return this.read(
      async () => (await this.rows(cid, low)).filter((r) => r.seq < high).length
    );
  }
  listContentMatchCandidatesAfterSeq(
    cid: number,
    afterSeq: number
  ): Promise<ContentMatchCandidate[]> {
    return this.read(async () => {
      const conversations = new NativeConversationStore(this.database),
        result: ContentMatchCandidate[] = [];
      for (const row of await this.rows(cid, afterSeq))
        result.push({
          messageId: row.messageId,
          seq: row.seq,
          identityHash: row.identityHash,
          transcriptEntryId: row.transcriptEntryId,
          hasContent: row.content.trim().length > 0,
          toolCallIds: (
            await conversations.getMessageParts(row.messageId)
          ).flatMap((part) => (part.toolCallId ? [part.toolCallId] : [])),
        });
      return result;
    });
  }
}
export class NativeUserReplayKeyStore extends NativeRepository {
  record(cid: number, keys: Iterable<TranscriptUserReplayKey>): Promise<void> {
    return this.write(async (tx) => {
      for (const key of keys)
        await tx.put(`replay/${n(cid)}/${h(key.entryId)}`, key);
    });
  }
  listRawUserContextKeys(cid: number): Promise<RawUserReplayKeyState[]> {
    return this.read(async (v) => {
      const summaries = new NativeSummaryStore(this.database),
        result: RawUserReplayKeyState[] = [];
      for (const item of await summaries.getContextItems(cid))
        if (item.messageId) {
          const row = await v.get<MessageRecord>(
            `messages/${n(item.messageId)}`
          );
          if (row?.role !== "user" || !row.transcriptEntryId) continue;
          const key = await v.get<TranscriptUserReplayKey>(
            `replay/${n(cid)}/${h(row.transcriptEntryId)}`
          );
          result.push({
            entryId: row.transcriptEntryId,
            observed: key
              ? { idempotencyKey: key.idempotencyKey, signature: key.signature }
              : null,
          });
        }
      return result;
    });
  }
}
export class NativeTranscriptGapStore extends NativeRepository {
  record(
    cid: number,
    gaps: readonly TranscriptHistoryGap[],
    source: string
  ): Promise<number> {
    return this.write(async (tx) => {
      let count = 0;
      for (const gap of gaps) {
        const unique = `gap-identity/${n(cid)}/${h([
          gap.firstEntryId,
          gap.lastEntryId,
        ])}`;
        if (await tx.get(unique)) continue;
        for (const id of [gap.prevMessageId, gap.nextMessageId]) {
          const row = await tx.get<MessageRecord>(`messages/${n(id)}`);
          if (row?.conversationId !== cid)
            throw new Error("Gap neighbor belongs to another conversation");
        }
        const gapId = await nextId(tx, "gaps"),
          row: TranscriptGapRecord = {
            ...gap,
            gapId,
            conversationId: cid,
            source,
            detectedAt: new Date().toISOString().replace("T", " ").slice(0, 19),
          };
        await tx.put(
          `gaps/${n(cid)}/${n(gap.firstVisibleSeq)}/${n(gapId)}`,
          row
        );
        await tx.put(unique, gapId);
        count++;
      }
      return count;
    });
  }
  listForConversation(cid: number): Promise<TranscriptGapRecord[]> {
    return this.read(async (v) => {
      const rows = await collect<TranscriptGapRecord>(v, `gaps/${n(cid)}/`);
      for (const row of rows) {
        if (
          row.prevMessageId &&
          !(await v.get(`messages/${n(row.prevMessageId)}`))
        )
          row.prevMessageId = null;
        if (
          row.nextMessageId &&
          !(await v.get(`messages/${n(row.nextMessageId)}`))
        )
          row.nextMessageId = null;
      }
      return rows;
    });
  }
  totals(): Promise<TranscriptGapTotals> {
    return this.read(async (v) => {
      const cids = new Set<number>();
      let gaps = 0,
        entries = 0,
        largestGap = 0;
      for await (const { value } of v.scan<TranscriptGapRecord>({
        prefix: "gaps/",
      })) {
        cids.add(value.conversationId);
        gaps++;
        entries += value.entryCount;
        largestGap = Math.max(largestGap, value.entryCount);
      }
      return { conversations: cids.size, gaps, entries, largestGap };
    });
  }
}
