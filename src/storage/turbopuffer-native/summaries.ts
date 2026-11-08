import { isTextLikeMimeType } from "../../store/large-file-mime.js";
import type {
  SummaryStore,
  SummaryRecord,
  CreateSummaryInput,
  SummarySubtreeNodeRecord,
  ContextItemRecord,
  SummarySearchInput,
  SummarySearchResult,
  CreateLargeFileInput,
  LargeFileRecord,
  LargeFileReadOptions,
  LargeFileSearchInput,
  LargeFileSearchResult,
} from "../../store/summary-store.js";
import type { MessageRecord } from "../../store/conversation-store.js";
import { NativeRepository, collect, nextId, n, h } from "./repository.js";
import {
  NativeConflict,
  type NativeTransaction,
  type NativeView,
} from "./database.js";
import { searchRecords } from "./search.js";
import { compileSafeSearchRegex } from "../../store/search-regex.js";
import {
  buildLikeSearchPlan,
  createFallbackSnippet,
} from "../../store/full-text-fallback.js";
const rk = (id: string) => `summary-range/${h(id)}`;
const sk = (id: string) => `summaries/${h(id)}`;
const cp = (cid: number) => `context/${n(cid)}/`;
const sp = (id: string) => `summary-source/${h(id)}/`;
const pp = (id: string) => `summary-parent/${h(id)}/`;
const chp = (id: string) => `summary-child/${h(id)}/`;
const fk = (id: string) => `large-files/${h(id)}`;
const now = () => new Date(Math.floor(Date.now() / 1000) * 1000);
const nonnegative = (value: number | undefined, fallback = 0) =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : fallback;
type FileValue = LargeFileRecord & { base64?: string };
export class NativeSummaryStore
  extends NativeRepository
  implements Pick<SummaryStore, keyof SummaryStore>
{
  insertSummary(input: CreateSummaryInput): Promise<SummaryRecord> {
    return this.write(async (tx) => {
      if (await tx.get(sk(input.summaryId)))
        throw new Error("UNIQUE constraint failed: summaries.summary_id");
      if (!(await tx.get(`conversations/${n(input.conversationId)}`)))
        throw new Error("Conversation does not exist");
      const row: SummaryRecord = {
        ...input,
        depth: nonnegative(input.depth, input.kind === "leaf" ? 0 : 1),
        fileIds: input.fileIds ?? [],
        earliestAt: input.earliestAt ?? null,
        latestAt: input.latestAt ?? null,
        descendantCount: nonnegative(input.descendantCount),
        descendantTokenCount: nonnegative(input.descendantTokenCount),
        sourceMessageTokenCount: nonnegative(input.sourceMessageTokenCount),
        model: input.model ?? "unknown",
        createdAt: now(),
      };
      await tx.put(sk(row.summaryId), row);
      await tx.put(rk(row.summaryId), { minSeq: null, maxSeq: null });
      await tx.put(
        `summary-conversation/${n(
          row.conversationId
        )}/${row.createdAt.toISOString()}/${h(row.summaryId)}`,
        row.summaryId
      );
      return row;
    });
  }
  restoreSummary(row: SummaryRecord): Promise<void> {
    return this.write(async (tx) => {
      if (await tx.get(sk(row.summaryId)))
        throw new Error("Restore requires an empty summary ID");
      if (!(await tx.get(`conversations/${n(row.conversationId)}`)))
        throw new Error("Restore summary conversation missing");
      await tx.put(sk(row.summaryId), row);
      await tx.put(rk(row.summaryId), { minSeq: null, maxSeq: null });
      await tx.put(
        `summary-conversation/${n(
          row.conversationId
        )}/${row.createdAt.toISOString()}/${h(row.summaryId)}`,
        row.summaryId
      );
    });
  }
  getSummary(id: string): Promise<SummaryRecord | null> {
    return this.read((v) => v.get(sk(id)));
  }
  getSummariesByConversation(cid: number): Promise<SummaryRecord[]> {
    return this.read(async (v) => {
      const ids = await collect<string>(v, `summary-conversation/${n(cid)}/`);
      return (await v.getMany<SummaryRecord>(ids.map(sk))).filter(
        (row): row is SummaryRecord => row !== null
      );
    });
  }
  linkSummaryToMessages(id: string, ids: number[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.write(async (tx) => {
      const summary = await tx.get<SummaryRecord>(sk(id));
      if (!summary) throw new Error("Summary does not exist");
      for (let ordinal = 0; ordinal < ids.length; ordinal++) {
        const mid = ids[ordinal],
          message = await tx.get<MessageRecord>(`messages/${n(mid)}`);
        if (!message || message.conversationId !== summary.conversationId)
          throw new Error("Source message belongs to another conversation");
        const unique = `summary-source-id/${h(id)}/${n(mid)}`;
        if (await tx.get(unique)) continue;
        await tx.put(unique, true);
        await tx.put(`${sp(id)}${n(ordinal)}/${n(mid)}`, mid);
        await tx.put(`message-summary/${n(mid)}/${h(id)}`, id);
      }
      await this.refreshRanges(tx, id);
    });
  }
  linkSummaryToParents(id: string, ids: string[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.write(async (tx) => {
      const summary = await tx.get<SummaryRecord>(sk(id));
      if (!summary) throw new Error("Summary does not exist");
      for (let ordinal = 0; ordinal < ids.length; ordinal++) {
        const parent = await tx.get<SummaryRecord>(sk(ids[ordinal]));
        if (!parent || parent.conversationId !== summary.conversationId)
          throw new Error("Source summary belongs to another conversation");
        if (
          id === parent.summaryId ||
          (await this.getSummarySubtree(id)).some(
            (row) => row.summaryId === parent.summaryId
          )
        )
          throw new Error("Summary graph must be acyclic");
        const unique = `summary-parent-id/${h(id)}/${h(parent.summaryId)}`;
        if (await tx.get(unique)) continue;
        await tx.put(unique, true);
        await tx.put(
          `${pp(id)}${n(ordinal)}/${h(parent.summaryId)}`,
          parent.summaryId
        );
        await tx.put(`${chp(parent.summaryId)}${n(ordinal)}/${h(id)}`, id);
      }
      await this.refreshRanges(tx, id);
    });
  }
  /** Keep bounded source-range metadata coherent with edges in the same root.
   * This avoids hydrating the source DAG merely to assemble active context.
   */
  private async refreshRanges(
    tx: NativeTransaction,
    id: string
  ): Promise<void> {
    const closure = new Set<string>(),
      edges = new Map<string, string[]>(),
      pending = [id];
    while (pending.length) {
      const current = pending.pop()!;
      if (closure.has(current)) continue;
      closure.add(current);
      const children = await collect<string>(tx, chp(current));
      edges.set(current, children);
      pending.push(...children);
    }
    const incoming = new Map([...closure].map((id) => [id, 0]));
    for (const children of edges.values())
      for (const child of children)
        incoming.set(child, (incoming.get(child) ?? 0) + 1);
    const ready = [...incoming]
      .filter(([, count]) => count === 0)
      .map(([id]) => id);
    let processed = 0;
    while (ready.length) {
      const current = ready.pop()!,
        mids = await collect<number>(tx, sp(current)),
        parents = await collect<string>(tx, pp(current));
      let minSeq: number | null = null,
        maxSeq: number | null = null;
      for (const row of await tx.getMany<MessageRecord>(
        mids.map((id) => `messages/${n(id)}`)
      ))
        if (row) {
          minSeq = Math.min(minSeq ?? row.seq, row.seq);
          maxSeq = Math.max(maxSeq ?? row.seq, row.seq);
        }
      for (const range of await tx.getMany<{
        minSeq: number | null;
        maxSeq: number | null;
      }>(parents.map(rk)))
        if (range) {
          if (range.minSeq !== null)
            minSeq = Math.min(minSeq ?? range.minSeq, range.minSeq);
          if (range.maxSeq !== null)
            maxSeq = Math.max(maxSeq ?? range.maxSeq, range.maxSeq);
        }
      await tx.put(rk(current), { minSeq, maxSeq });
      processed++;
      for (const child of edges.get(current) ?? []) {
        const count = incoming.get(child)! - 1;
        incoming.set(child, count);
        if (count === 0) ready.push(child);
      }
    }
    if (processed !== closure.size)
      throw new NativeConflict("Summary range graph is cyclic");
  }
  getSummaryMessages(id: string): Promise<number[]> {
    return this.read((v) => collect(v, sp(id)));
  }
  getConversationMaxSummaryDepth(cid: number): Promise<number | null> {
    return this.read(async () => {
      const rows = await this.getSummariesByConversation(cid);
      return rows.length ? Math.max(...rows.map((row) => row.depth)) : null;
    });
  }
  getLeafSummaryLinksForMessageIds(
    cid: number,
    ids: number[]
  ): Promise<{ messageId: number; summaryId: string }[]> {
    return this.read(async (v) => {
      const result: { messageId: number; summaryId: string }[] = [];
      for (const messageId of ids)
        for (const summaryId of await collect<string>(
          v,
          `message-summary/${n(messageId)}/`
        )) {
          const row = await v.get<SummaryRecord>(sk(summaryId));
          if (row?.conversationId === cid && row.kind === "leaf")
            result.push({ messageId, summaryId });
        }
      return result;
    });
  }
  getSummaryChildren(id: string): Promise<SummaryRecord[]> {
    return this.related(chp(id));
  }
  getSummaryParents(id: string): Promise<SummaryRecord[]> {
    return this.related(pp(id));
  }
  private related(prefix: string): Promise<SummaryRecord[]> {
    return this.read(async (v) => {
      const ids = await collect<string>(v, prefix);
      return (await v.getMany<SummaryRecord>(ids.map(sk))).filter(
        (row): row is SummaryRecord => row !== null
      );
    });
  }
  getSummarySubtree(id: string): Promise<SummarySubtreeNodeRecord[]> {
    return this.read(async (v) => {
      // Preserve upstream's historical direction: children reference this node as
      // a source. Expansion uses getSummaryParents in the opposite direction.
      const queue = [{ id, parent: null as string | null, path: "", depth: 0 }],
        seen = new Set<string>(),
        result: SummarySubtreeNodeRecord[] = [];
      for (let at = 0; at < queue.length; at++) {
        const item = queue[at];
        if (seen.has(item.id)) continue;
        seen.add(item.id);
        const row = await v.get<SummaryRecord>(sk(item.id));
        if (!row) continue;
        const children: { id: string; ordinal: number }[] = [];
        for await (const edge of v.scan<string>({ prefix: chp(item.id) }))
          children.push({
            id: edge.value,
            ordinal: Number(edge.key.split("/").at(-2)),
          });
        result.push({
          ...row,
          parentSummaryId: item.parent,
          path: item.path,
          depthFromRoot: item.depth,
          childCount: children.length,
        });
        children.forEach((child) =>
          queue.push({
            id: child.id,
            parent: item.id,
            path: [item.path, String(child.ordinal).padStart(4, "0")]
              .filter(Boolean)
              .join("."),
            depth: item.depth + 1,
          })
        );
        queue.splice(
          at + 1,
          queue.length - at - 1,
          ...queue
            .slice(at + 1)
            .sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path))
        );
      }
      return result.sort(
        (a, b) =>
          a.depthFromRoot - b.depthFromRoot ||
          a.path.localeCompare(b.path) ||
          a.createdAt.getTime() - b.createdAt.getTime()
      );
    });
  }
  getSummaryMessageSeqRange(
    id: string
  ): Promise<{ minSeq: number | null; maxSeq: number | null }> {
    return this.read(async (v) => {
      const cached = await v.get<{
        minSeq: number | null;
        maxSeq: number | null;
      }>(rk(id));
      if (cached) return cached;
      const pending = [id],
        seen = new Set<string>();
      let minSeq: number | null = null,
        maxSeq: number | null = null;
      while (pending.length) {
        const current = pending.pop()!;
        if (seen.has(current)) continue;
        seen.add(current);
        const ids = await collect<number>(v, sp(current));
        for (const row of await v.getMany<MessageRecord>(
          ids.map((id) => `messages/${n(id)}`)
        ))
          if (row) {
            minSeq = Math.min(minSeq ?? row.seq, row.seq);
            maxSeq = Math.max(maxSeq ?? row.seq, row.seq);
          }
        pending.push(...(await collect<string>(v, pp(current))));
      }
      return { minSeq, maxSeq };
    });
  }
  getContextItems(cid: number): Promise<ContextItemRecord[]> {
    return this.read(async (v) => {
      const items = await collect<ContextItemRecord>(v, cp(cid));
      return items.map((item, ordinal) => ({ ...item, ordinal }));
    });
  }
  prefetchContextItems(items: ContextItemRecord[]): Promise<void> {
    return this.read(async (v) => {
      const records = await v.getMany<any>(
        items.flatMap((item) =>
          item.itemType === "message"
            ? [`messages/${n(item.messageId!)}`]
            : [sk(item.summaryId!), rk(item.summaryId!)]
        )
      );
      await v.getMany(
        records.flatMap((row) =>
          row &&
          typeof row.messageId === "number" &&
          typeof row.transcriptEntryId === "string"
            ? [
                `message-trust-entry/${n(row.conversationId)}/${h(
                  row.transcriptEntryId
                )}/${n(row.messageId)}`,
              ]
            : []
        )
      );
    });
  }
  getDistinctDepthsInContext(
    cid: number,
    options?: { maxOrdinalExclusive?: number }
  ): Promise<number[]> {
    return this.read(async () => {
      const depths = new Set<number>();
      for (const item of await this.getContextItems(cid))
        if (
          item.summaryId &&
          (options?.maxOrdinalExclusive === undefined ||
            item.ordinal < options.maxOrdinalExclusive)
        ) {
          const row = await this.getSummary(item.summaryId);
          if (row) depths.add(row.depth);
        }
      return [...depths].sort((a, b) => a - b);
    });
  }
  pruneForNewSession(cid: number, retainDepth: number): Promise<void> {
    if (Number.isFinite(retainDepth) && retainDepth < 0)
      return Promise.resolve();
    return this.write(async (tx) => {
      for await (const item of tx.scan<ContextItemRecord>({
        prefix: cp(cid),
      })) {
        const summary = item.value.summaryId
          ? await tx.get<SummaryRecord>(sk(item.value.summaryId))
          : null;
        if (
          item.value.itemType === "message" ||
          !Number.isFinite(retainDepth) ||
          (summary && summary.depth < Math.floor(retainDepth))
        )
          await tx.remove(item.key);
      }
    });
  }
  appendContextMessage(cid: number, id: number): Promise<void> {
    return this.appendContextMessages(cid, [id]);
  }
  appendContextMessages(cid: number, ids: number[]): Promise<void> {
    if (!ids.length) return Promise.resolve();
    return this.write(async (tx) => {
      for (const id of ids)
        await this.append(tx, cid, {
          messageId: id,
          summaryId: null,
          itemType: "message",
        });
    });
  }
  appendContextSummary(cid: number, id: string): Promise<void> {
    return this.write((tx) =>
      this.append(tx, cid, {
        messageId: null,
        summaryId: id,
        itemType: "summary",
      })
    );
  }
  private async append(
    tx: NativeTransaction,
    cid: number,
    body: Pick<ContextItemRecord, "messageId" | "summaryId" | "itemType">
  ): Promise<void> {
    const target = body.summaryId
      ? await tx.get<SummaryRecord>(sk(body.summaryId))
      : await tx.get<MessageRecord>(`messages/${n(body.messageId!)}`);
    if (!target || target.conversationId !== cid)
      throw new Error("Context target belongs to another conversation");
    const position = await nextId(tx, `context/${n(cid)}`);
    await tx.put(`${cp(cid)}${n(position)}`, {
      conversationId: cid,
      ordinal: position,
      ...body,
      createdAt: now(),
    });
  }
  replaceContextRangeWithSummary(input: {
    conversationId: number;
    startOrdinal: number;
    endOrdinal: number;
    summaryId: string;
  }): Promise<void> {
    return this.replaceContextRangesWithSummaries({
      conversationId: input.conversationId,
      replacements: [input],
    });
  }
  replaceContextRangesWithSummaries(input: {
    conversationId: number;
    replacements: {
      startOrdinal: number;
      endOrdinal: number;
      summaryId: string;
    }[];
  }): Promise<void> {
    return this.write(async (tx) => {
      const replacements = [...input.replacements].sort(
        (a, b) => a.startOrdinal - b.startOrdinal
      );
      let end = -1;
      for (const r of replacements) {
        if (
          !Number.isInteger(r.startOrdinal) ||
          !Number.isInteger(r.endOrdinal) ||
          r.startOrdinal < 0 ||
          r.endOrdinal < r.startOrdinal
        )
          throw new Error(
            `Invalid context replacement range ${r.startOrdinal}-${r.endOrdinal}`
          );
        if (r.startOrdinal <= end)
          throw new Error("Context replacement ranges must not overlap");
        end = r.endOrdinal;
        const row = await tx.get<SummaryRecord>(sk(r.summaryId));
        if (row?.conversationId !== input.conversationId)
          throw new Error(
            "Replacement summary belongs to another conversation"
          );
      }
      const items: { key: string; value: ContextItemRecord }[] = [];
      for await (const item of tx.scan<ContextItemRecord>({
        prefix: cp(input.conversationId),
      }))
        items.push(item);
      for (const r of replacements) {
        if (r.startOrdinal >= items.length)
          throw new Error(
            "Context replacement range exceeds committed context"
          );
        const activeSummaries = new Set(
          items.flatMap((item) =>
            item.value.summaryId ? [item.value.summaryId] : []
          )
        );
        const coverage: string[] = [],
          visiting = new Set<string>();
        const visit = async (id: string): Promise<void> => {
          if (activeSummaries.has(id)) {
            coverage.push(`summary:${id}`);
            return;
          }
          if (visiting.has(id))
            throw new NativeConflict(
              "Replacement source graph contains a cycle"
            );
          visiting.add(id);
          for (const mid of await this.getSummaryMessages(id))
            coverage.push(`message:${mid}`);
          for (const parent of await this.getSummaryParents(id))
            await visit(parent.summaryId);
          visiting.delete(id);
        };
        await visit(r.summaryId);
        const expected = items
          .slice(r.startOrdinal, r.endOrdinal + 1)
          .map((item) =>
            item.value.summaryId
              ? `summary:${item.value.summaryId}`
              : `message:${item.value.messageId}`
          );
        if (JSON.stringify(coverage) !== JSON.stringify(expected))
          throw new NativeConflict(
            "Compaction source projection changed; recompute against committed context"
          );
        for (
          let at = r.startOrdinal;
          at <= r.endOrdinal && at < items.length;
          at++
        )
          await tx.remove(items[at].key);
        await tx.put(items[r.startOrdinal].key, {
          conversationId: input.conversationId,
          ordinal: r.startOrdinal,
          itemType: "summary",
          messageId: null,
          summaryId: r.summaryId,
          createdAt: now(),
        });
      }
    });
  }
  getContextTokenCount(cid: number): Promise<number> {
    return this.read(async (v) => {
      let total = 0;
      const items = await this.getContextItems(cid),
        keys = items.map((item) =>
          item.summaryId ? sk(item.summaryId) : `messages/${n(item.messageId!)}`
        );
      for (const row of await v.getMany<{ tokenCount: number }>(keys))
        total += row?.tokenCount ?? 0;
      return total;
    });
  }
  async searchSummaries(
    input: SummarySearchInput
  ): Promise<SummarySearchResult[]> {
    return (
      await searchRecords<SummaryRecord>(this.database, "summaries", input)
    ).map(({ value, snippet, rank }) => ({
      summaryId: value.summaryId,
      conversationId: value.conversationId,
      kind: value.kind,
      snippet,
      createdAt: value.latestAt ?? value.createdAt,
      rank,
    }));
  }
  insertLargeFile(input: CreateLargeFileInput): Promise<LargeFileRecord> {
    return this.write(async (tx) => {
      if (await tx.get(fk(input.fileId)))
        throw new Error("UNIQUE constraint failed: large_files.file_id");
      if (!(await tx.get(`conversations/${n(input.conversationId)}`)))
        throw new Error("Conversation does not exist");
      const row: LargeFileRecord = {
        fileId: input.fileId,
        conversationId: input.conversationId,
        fileName: input.fileName ?? null,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize ?? null,
        lineCount: input.lineCount ?? null,
        storageUri: input.storageUri,
        explorationSummary: input.explorationSummary ?? null,
        createdAt: now(),
      };
      await tx.put(fk(row.fileId), row);
      await tx.put(
        `file-conversation/${n(row.conversationId)}/${h(row.fileId)}`,
        row.fileId
      );
      return row;
    });
  }
  async storeLargeFileBytes(
    input: CreateLargeFileInput,
    bytes: Buffer
  ): Promise<LargeFileRecord> {
    return this.write(async (tx) => {
      const row = await this.insertLargeFile({
        ...input,
        storageUri: `turbopuffer://${this.database.namespace}/${input.fileId}`,
        byteSize: bytes.length,
      });
      const chunkBytes = 256 * 1024;
      await tx.put(`file-bytes/${h(row.fileId)}`, {
        format: "native-file-chunks-v1",
        bytes: bytes.length,
        chunks: Math.ceil(bytes.length / chunkBytes),
      });
      for (let at = 0, index = 0; at < bytes.length; at += chunkBytes, index++)
        await tx.put(`file-chunks/${h(row.fileId)}/${n(index)}`, {
          base64: bytes.subarray(at, at + chunkBytes).toString("base64"),
        });
      return row;
    });
  }
  getLargeFile(id: string): Promise<LargeFileRecord | null> {
    return this.read((v) => v.get(fk(id)));
  }
  getLargeFilesByConversation(cid: number): Promise<LargeFileRecord[]> {
    return this.read(async (v) => {
      const ids = await collect<string>(v, `file-conversation/${n(cid)}/`);
      return (await v.getMany<LargeFileRecord>(ids.map(fk)))
        .filter((row): row is LargeFileRecord => row !== null)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    });
  }
  getAllLargeFiles(): Promise<LargeFileRecord[]> {
    return this.read(async (v) =>
      (await collect<LargeFileRecord>(v, "large-files/")).sort(
        (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
      )
    );
  }
  getLargeFileBytes(
    id: string,
    options: { maxBytes?: number } = {}
  ): Promise<Buffer | null> {
    return this.read(async (v) => {
      const row = await v.get<{
        format?: string;
        base64?: string;
        bytes?: number;
        chunks?: number;
      }>(`file-bytes/${h(id)}`);
      if (!row) return null;
      if (row.base64 !== undefined) {
        const bytes = Buffer.from(row.base64, "base64");
        return options.maxBytes === undefined
          ? bytes
          : bytes.subarray(0, Math.max(0, options.maxBytes));
      }
      if (
        row.format !== "native-file-chunks-v1" ||
        !Number.isSafeInteger(row.bytes) ||
        !Number.isSafeInteger(row.chunks)
      )
        throw new Error("Native file manifest invalid");
      const maxBytes = Math.max(
          0,
          Math.min(options.maxBytes ?? row.bytes!, row.bytes!)
        ),
        buffers: Buffer[] = [];
      let remaining = maxBytes,
        count = 0;
      for await (const { value } of v.scan<{ base64: string }>({
        prefix: `file-chunks/${h(id)}/`,
        limit: Math.ceil(maxBytes / (256 * 1024)),
      })) {
        const chunk = Buffer.from(value.base64, "base64");
        buffers.push(chunk.subarray(0, remaining));
        remaining -= Math.min(remaining, chunk.length);
        count++;
      }
      if (remaining > 0 || count !== Math.ceil(maxBytes / (256 * 1024)))
        throw new Error("Native file chunks missing");
      return Buffer.concat(buffers, maxBytes);
    });
  }
  async getLargeFileContent(
    id: string,
    options: LargeFileReadOptions
  ): Promise<string | null> {
    const bytes = await this.getLargeFileBytes(id, options);
    return bytes?.toString("utf8") ?? null;
  }
  async largeFileContentEquals(
    id: string,
    content: string,
    options: LargeFileReadOptions
  ): Promise<boolean> {
    return this.largeFileBufferEquals(id, Buffer.from(content), options);
  }
  async largeFileBufferEquals(
    id: string,
    content: Buffer,
    _options: LargeFileReadOptions
  ): Promise<boolean> {
    const bytes = await this.getLargeFileBytes(id);
    return bytes?.equals(content) ?? false;
  }
  searchLargeFiles(
    input: LargeFileSearchInput
  ): Promise<LargeFileSearchResult[]> {
    return this.read(async () => {
      const ids =
        input.conversationIds ??
        (input.conversationId !== undefined
          ? [input.conversationId]
          : undefined);
      if (
        ids?.length === 0 ||
        (!ids && !input.fileIds && !input.allConversations)
      )
        return [];
      const files = (await this.getAllLargeFiles())
        .filter(
          (file) =>
            isTextLikeMimeType(file.mimeType) &&
            (!ids || ids.includes(file.conversationId)) &&
            (!input.fileIds || input.fileIds.includes(file.fileId)) &&
            (!input.since || file.createdAt >= input.since) &&
            (!input.before || file.createdAt < input.before)
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      if (
        !input.query.trim() ||
        (input.limit !== undefined && input.limit <= 0)
      )
        return [];
      const results: LargeFileSearchResult[] = [],
        limit = input.limit ?? 50,
        maxBytes = input.maxBytesPerFile ?? 512000;
      const regex =
          input.mode === "regex"
            ? compileSafeSearchRegex(input.query, "g")
            : null,
        terms = buildLikeSearchPlan("", input.query).terms;
      if (input.mode === "regex" && !regex) return [];
      for (const file of files) {
        if (results.length >= limit) break;
        const bytes = await this.getLargeFileBytes(file.fileId, { maxBytes });
        if (!bytes) continue;
        const content = bytes.toString("utf8");
        const matches: { index: number; text: string }[] = [];
        if (regex) {
          regex.lastIndex = 0;
          for (const match of content.matchAll(regex)) {
            matches.push({ index: match.index, text: match[0] });
            if (matches.length >= limit - results.length) break;
          }
        } else if (
          terms.every((term) => content.toLowerCase().includes(term))
        ) {
          const term = terms[0] ?? "";
          matches.push({
            index: content.toLowerCase().indexOf(term),
            text: term,
          });
        }
        for (const match of matches)
          results.push({
            fileId: file.fileId,
            conversationId: file.conversationId,
            fileName: file.fileName,
            matchedText: match.text,
            lineNumber: content.slice(0, match.index).split("\n").length,
            byteOffset: Buffer.byteLength(content.slice(0, match.index)),
            snippet: createFallbackSnippet(content, [match.text]),
            scannedBytes: bytes.length,
            scanByteLimit: maxBytes,
            scanTruncated: (file.byteSize ?? bytes.length) > bytes.length,
            createdAt: file.createdAt,
          });
      }
      return results;
    });
  }
}
