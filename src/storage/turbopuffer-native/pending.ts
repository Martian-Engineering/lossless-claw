import type { PendingSummaryStore } from "../../store/pending-summary-store.js";
import type {
  PendingCompactionBatchRecord as Batch,
  PendingSummaryNodeRecord as Node,
  PendingSummaryNodeMessageRecord,
  PendingSummaryNodeChildRecord,
} from "../../store/pending-summary-types.js";
import { NativeRepository, collect, n, h } from "./repository.js";
import type { NativeTransaction } from "./database.js";
type Input<K extends keyof PendingSummaryStore> = Parameters<
  PendingSummaryStore[K]
>[0];
const bk = (id: string) => `pending-batches/${h(id)}`,
  nk = (id: string) => `pending-nodes/${h(id)}`;
const np = (id: string) => `pending-batch-node/${h(id)}/`;
const now = () => new Date(Math.floor(Date.now() / 1000) * 1000);
const integer = (v: number) => {
  if (!Number.isFinite(v) || v < 0)
    throw new Error(`Expected a non-negative integer, got ${v}`);
  return Math.floor(v);
};
const range = (start: number, end: number) => {
  const s = integer(start),
    e = integer(end);
  if (e < s) throw new Error("Invalid pending ordinal range");
  return [s, e];
};
export class NativePendingSummaryStore
  extends NativeRepository
  implements Pick<PendingSummaryStore, keyof PendingSummaryStore>
{
  createBatch(input: Input<"createBatch">): Promise<Batch> {
    return this.write(async (tx) => {
      range(input.compactableStartOrdinal, input.compactableEndOrdinal);
      if (await tx.get(bk(input.batchId)))
        throw new Error(
          "UNIQUE constraint failed: pending_compaction_batches.batch_id"
        );
      if (!(await tx.get(`conversations/${n(input.conversationId)}`)))
        throw new Error("Conversation does not exist");
      const row: Batch = {
        ...input,
        sessionKey: input.sessionKey ?? null,
        sessionTargetJson: input.sessionTargetJson ?? "{}",
        status: input.status ?? "planning",
        plannedFreshTailStartOrdinal:
          input.plannedFreshTailStartOrdinal ?? null,
        failureSummary: null,
        createdAt: now(),
        updatedAt: now(),
        publishedAt: null,
      };
      await tx.put(bk(row.batchId), row);
      await tx.put(
        `pending-conversation/${n(
          row.conversationId
        )}/${row.createdAt.toISOString()}/${h(row.batchId)}`,
        row.batchId
      );
      return row;
    });
  }
  getBatch(id: string): Promise<Batch | null> {
    return this.read((v) => v.get(bk(id)));
  }
  private async batches(cid: number): Promise<Batch[]> {
    return this.read(async (v) => {
      const ids = await collect<string>(v, `pending-conversation/${n(cid)}/`, {
        reverse: true,
      });
      return (await v.getMany<Batch>(ids.map(bk)))
        .filter((r): r is Batch => r !== null)
        .sort(
          (a, b) =>
            b.createdAt.getTime() - a.createdAt.getTime() ||
            b.batchId.localeCompare(a.batchId)
        );
    });
  }
  updateBatchPlanningTarget(
    input: Input<"updateBatchPlanningTarget">
  ): Promise<boolean> {
    return this.write(async (tx) => {
      range(input.compactableStartOrdinal, input.compactableEndOrdinal);
      const row = await tx.get<Batch>(bk(input.batchId));
      if (!row || !["planning", "ready"].includes(row.status)) return false;
      await tx.put(bk(row.batchId), {
        ...row,
        ...input,
        plannedFreshTailStartOrdinal:
          input.plannedFreshTailStartOrdinal ?? null,
        updatedAt: now(),
      });
      return true;
    });
  }
  async getActiveBatchForConversation(cid: number): Promise<Batch | null> {
    return this.read(
      async () =>
        (await this.batches(cid)).find((row) =>
          ["planning", "ready", "publishing"].includes(row.status)
        ) ?? null
    );
  }
  async hasPublishedBatchSince(cid: number, since: Date): Promise<boolean> {
    return this.read(async () =>
      (await this.batches(cid)).some(
        (row) =>
          row.status === "published" &&
          row.publishedAt !== null &&
          row.publishedAt >= since
      )
    );
  }
  markBatchPublished(input: Input<"markBatchPublished">): Promise<void> {
    return this.write(async (tx) => {
      const row = await tx.get<Batch>(bk(input.batchId));
      if (row)
        await tx.put(bk(row.batchId), {
          ...row,
          status: "published",
          failureSummary: null,
          publishedAt: input.publishedAt ?? now(),
          updatedAt: now(),
        });
    });
  }
  markBatchStale(input: Input<"markBatchStale">): Promise<void> {
    return this.write(async (tx) => {
      const row = await tx.get<Batch>(bk(input.batchId));
      if (row)
        await tx.put(bk(row.batchId), {
          ...row,
          status: "stale",
          failureSummary: input.failureSummary ?? null,
          updatedAt: now(),
        });
      for (const node of await this.getNodesByBatch(input.batchId))
        if (["planned", "running", "ready", "failed"].includes(node.status))
          await tx.put(nk(node.nodeId), {
            ...(await tx.get<Node>(nk(node.nodeId)))!,
            status: "stale",
            leaseOwner: null,
            leaseExpiresAt: null,
            failureSummary: input.failureSummary ?? null,
            updatedAt: now(),
          });
    });
  }
  insertNode(input: Input<"insertNode">): Promise<Node> {
    return this.write(async (tx) => {
      range(input.ordinalStart, input.ordinalEnd);
      integer(input.depth);
      const batch = await tx.get<Batch>(bk(input.batchId));
      if (!batch || batch.conversationId !== input.conversationId)
        throw new Error("Pending node batch belongs to another conversation");
      if (await tx.get(nk(input.nodeId)))
        throw new Error(
          "UNIQUE constraint failed: pending_summary_nodes.node_id"
        );
      const row: Node = {
        ...input,
        status: input.status ?? "planned",
        sourceContextHash: input.sourceContextHash ?? null,
        content: input.content ?? null,
        tokenCount: input.tokenCount ?? null,
        canonicalSummaryId: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        failureSummary: null,
        retryCount: 0,
        nextAttemptAfter: null,
        createdAt: now(),
        updatedAt: now(),
        readyAt: null,
        promotedAt: null,
      };
      await tx.put(nk(row.nodeId), row);
      await tx.put(
        `${np(row.batchId)}${n(row.ordinalStart)}/${n(row.depth)}/${h(
          row.nodeId
        )}`,
        row.nodeId
      );
      return row;
    });
  }
  getNode(id: string): Promise<Node | null> {
    return this.read(async (v) => {
      const row = await v.get<Node>(nk(id));
      if (!row) return null;
      const context = await v.get<{
        ordinalStart: number;
        ordinalEnd: number;
        sourceContextHash: string | null;
      }>(`pending-node-context/${h(id)}`);
      return context ? { ...row, ...context } : row;
    });
  }
  getNodesByBatch(id: string): Promise<Node[]> {
    return this.read(async (v) => {
      const ids = await collect<string>(v, np(id)),
        rows: Node[] = [];
      for (const id of ids) {
        const row = await this.getNode(id);
        if (row) rows.push(row);
      }
      return rows.sort(
        (a, b) =>
          a.ordinalStart - b.ordinalStart ||
          a.depth - b.depth ||
          a.nodeId.localeCompare(b.nodeId)
      );
    });
  }
  linkNodeToMessages(
    id: string,
    messages: Parameters<PendingSummaryStore["linkNodeToMessages"]>[1]
  ): Promise<void> {
    return this.write(async (tx) => {
      const node = await tx.get<Node>(nk(id));
      if (!node) throw new Error("Pending node does not exist");
      for (let at = 0; at < messages.length; at++) {
        const row = messages[at],
          message = await tx.get<{ conversationId: number }>(
            `messages/${n(row.messageId)}`
          );
        if (message?.conversationId !== node.conversationId)
          throw new Error("Pending source belongs to another conversation");
        const unique = `pending-node-message-id/${h(id)}/${n(row.messageId)}`,
          old = await tx.get<string>(unique);
        if (old) await tx.remove(old);
        const key = `pending-node-message/${h(id)}/${n(at)}/${n(
          row.messageId
        )}`;
        await tx.put(key, {
          messageId: row.messageId,
          transcriptEntryId: row.transcriptEntryId ?? null,
          identityHash: row.identityHash ?? null,
        });
        await tx.put(unique, key);
        await tx.put(`pending-message/${n(row.messageId)}/${h(id)}`, id);
      }
    });
  }
  getNodeMessages(id: string): Promise<PendingSummaryNodeMessageRecord[]> {
    return this.read((v) => collect(v, `pending-node-message/${h(id)}/`));
  }
  linkNodeToChildren(
    id: string,
    children: Parameters<PendingSummaryStore["linkNodeToChildren"]>[1]
  ): Promise<void> {
    return this.write(async (tx) => {
      const node = await tx.get<Node>(nk(id));
      if (!node) throw new Error("Pending node does not exist");
      for (let at = 0; at < children.length; at++) {
        const child = children[at];
        if (!!child.childNodeId === !!child.childSummaryId)
          throw new Error("Pending edge must name one source");
        const source = await tx.get<{ conversationId: number }>(
          child.childNodeId
            ? nk(child.childNodeId)
            : `summaries/${h(child.childSummaryId!)}`
        );
        if (source?.conversationId !== node.conversationId)
          throw new Error("Pending edge crosses conversation authority");
        await tx.put(`pending-node-child/${h(id)}/${n(at)}`, {
          childNodeId: child.childNodeId ?? null,
          childSummaryId: child.childSummaryId ?? null,
        });
      }
    });
  }
  getNodeChildren(id: string): Promise<PendingSummaryNodeChildRecord[]> {
    return this.read((v) => collect(v, `pending-node-child/${h(id)}/`));
  }
  claimNextPlannedNode(
    input: Input<"claimNextPlannedNode">
  ): Promise<Node | null> {
    return this.write(async (tx) => {
      const timestamp = input.now ?? new Date(),
        nodes: Node[] = [];
      for (const batch of await this.batches(input.conversationId))
        if (["planning", "ready", "publishing"].includes(batch.status))
          nodes.push(...(await this.getNodesByBatch(batch.batchId)));
      nodes.sort(
        (a, b) =>
          a.ordinalStart - b.ordinalStart ||
          a.depth - b.depth ||
          a.nodeId.localeCompare(b.nodeId)
      );
      for (const node of nodes) {
        if (
          !(
            node.status === "planned" ||
            (node.status === "running" &&
              node.leaseExpiresAt !== null &&
              node.leaseExpiresAt <= timestamp) ||
            (node.status === "failed" &&
              node.retryCount < 3 &&
              (!node.nextAttemptAfter || node.nextAttemptAfter <= timestamp))
          )
        )
          continue;
        let ready = true;
        for (const child of await this.getNodeChildren(node.nodeId))
          if (child.childNodeId) {
            const source = await this.getNode(child.childNodeId);
            if (source && !["ready", "promoted"].includes(source.status))
              ready = false;
          }
        if (!ready) continue;
        const base = (await tx.get<Node>(nk(node.nodeId)))!;
        const next = {
          ...base,
          status: "running" as const,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt: input.leaseExpiresAt,
          failureSummary: null,
          updatedAt: now(),
        };
        await tx.put(nk(node.nodeId), next);
        return (await this.getNode(node.nodeId))!;
      }
      return null;
    });
  }
  private leased(
    input: { nodeId: string; leaseOwner: string; leaseExpiresAt: Date },
    update: (node: Node) => Partial<Node>
  ): Promise<boolean> {
    return this.write(async (tx) => {
      const node = await tx.get<Node>(nk(input.nodeId));
      if (
        !node ||
        node.status !== "running" ||
        node.leaseOwner !== input.leaseOwner ||
        node.leaseExpiresAt?.getTime() !== input.leaseExpiresAt.getTime()
      )
        return false;
      await tx.put(nk(node.nodeId), {
        ...node,
        ...update(node),
        updatedAt: now(),
      });
      return true;
    });
  }
  markNodeReady(input: Input<"markNodeReady">): Promise<boolean> {
    return this.leased(input, (node) => ({
      status: "ready",
      content: input.content,
      tokenCount: integer(input.tokenCount),
      model: input.model ?? node.model,
      leaseOwner: null,
      leaseExpiresAt: null,
      failureSummary: null,
      retryCount: 0,
      nextAttemptAfter: null,
      readyAt: input.readyAt ?? now(),
    }));
  }
  releaseNodeClaim(input: Input<"releaseNodeClaim">): Promise<boolean> {
    return this.leased(input, () => ({
      status: "planned",
      leaseOwner: null,
      leaseExpiresAt: null,
    }));
  }
  markNodeFailed(input: Input<"markNodeFailed">): Promise<boolean> {
    return this.leased(input, (node) => ({
      status: "failed",
      leaseOwner: null,
      leaseExpiresAt: null,
      failureSummary: input.failureSummary,
      retryCount: node.retryCount + 1,
      nextAttemptAfter: new Date(
        (input.now ?? new Date()).getTime() +
          Math.min(60000 * 2 ** node.retryCount, 900000)
      ),
    }));
  }
  pruneSupersededNodes(id: string): Promise<number> {
    return this.write(async (tx) => {
      const nodes = await this.getNodesByBatch(id);
      let count = 0;
      for (const node of nodes) {
        if (
          node.kind !== "condensed" ||
          node.status !== "ready" ||
          !nodes.some(
            (w) =>
              w.nodeId !== node.nodeId &&
              ["ready", "promoted"].includes(w.status) &&
              w.depth === node.depth &&
              w.ordinalStart === node.ordinalStart &&
              w.ordinalEnd > node.ordinalEnd
          )
        )
          continue;
        let referenced = false;
        for (const parent of nodes)
          if (
            !["stale", "failed"].includes(parent.status) &&
            (await this.getNodeChildren(parent.nodeId)).some(
              (child) => child.childNodeId === node.nodeId
            )
          )
            referenced = true;
        if (!referenced) {
          await this.removeNode(tx, node);
          count++;
        }
      }
      return count;
    });
  }
  clearPromotedPayloads(id: string): Promise<number> {
    return this.write(async (tx) => {
      let count = 0;
      for (const node of await this.getNodesByBatch(id))
        if (node.status === "promoted" && node.content !== null) {
          await tx.put(nk(node.nodeId), {
            ...(await tx.get<Node>(nk(node.nodeId)))!,
            content: null,
            updatedAt: now(),
          });
          count++;
        }
      return count;
    });
  }
  deleteFinishedBatches(
    input: Input<"deleteFinishedBatches">
  ): Promise<number> {
    return this.write(async (tx) => {
      let count = 0;
      for (const batch of await this.batches(input.conversationId))
        if (
          ["stale", "failed", "published"].includes(batch.status) &&
          batch.updatedAt <= input.olderThan
        ) {
          for (const node of await this.getNodesByBatch(batch.batchId))
            await this.removeNode(tx, node);
          await tx.remove(bk(batch.batchId));
          count++;
        }
      return count;
    });
  }
  private async removeNode(tx: NativeTransaction, node: Node): Promise<void> {
    for (const message of await this.getNodeMessages(node.nodeId))
      await tx.remove(
        `pending-message/${n(message.messageId)}/${h(node.nodeId)}`
      );
    for (const prefix of [
      `pending-node-message/${h(node.nodeId)}/`,
      `pending-node-message-id/${h(node.nodeId)}/`,
      `pending-node-child/${h(node.nodeId)}/`,
    ])
      for await (const row of tx.scan({ prefix })) await tx.remove(row.key);
    await tx.remove(nk(node.nodeId));
    await tx.remove(`pending-node-context/${h(node.nodeId)}`);
    // Batch indexes can retain a tombstone pointer; reads always verify reachability.
  }
  updateNodeContext(input: Input<"updateNodeContext">): Promise<void> {
    return this.write(async (tx) => {
      range(input.ordinalStart, input.ordinalEnd);
      if (await tx.get(nk(input.nodeId)))
        await tx.put(`pending-node-context/${h(input.nodeId)}`, {
          ordinalStart: input.ordinalStart,
          ordinalEnd: input.ordinalEnd,
          sourceContextHash: input.sourceContextHash,
        });
    });
  }
  markNodePromoted(input: Input<"markNodePromoted">): Promise<void> {
    return this.write(async (tx) => {
      const node = await tx.get<Node>(nk(input.nodeId));
      if (node)
        await tx.put(nk(node.nodeId), {
          ...node,
          status: "promoted",
          canonicalSummaryId: input.canonicalSummaryId,
          leaseOwner: null,
          leaseExpiresAt: null,
          failureSummary: null,
          promotedAt: input.promotedAt ?? now(),
          updatedAt: now(),
        });
    });
  }
}
