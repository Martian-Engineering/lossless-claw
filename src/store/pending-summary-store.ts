import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { parseUtcTimestampOrNull } from "./parse-utc-timestamp.js";
import type { SummaryKind } from "./summary-store.js";

export type PendingCompactionBatchStatus =
  | "planning"
  | "ready"
  | "publishing"
  | "published"
  | "stale"
  | "failed";

export type PendingSummaryNodeStatus =
  | "planned"
  | "running"
  | "ready"
  | "promoted"
  | "stale"
  | "failed";

export type PendingCompactionBatchRecord = {
  batchId: string;
  conversationId: number;
  sessionKey: string | null;
  sessionTargetJson: string;
  status: PendingCompactionBatchStatus;
  sourceProjectionFingerprint: string;
  compactableStartOrdinal: number;
  compactableEndOrdinal: number;
  plannedFreshTailStartOrdinal: number | null;
  promptVersion: string;
  model: string;
  failureSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
};

export type CreatePendingCompactionBatchInput = {
  batchId: string;
  conversationId: number;
  sessionKey?: string | null;
  sessionTargetJson?: string;
  status?: PendingCompactionBatchStatus;
  sourceProjectionFingerprint: string;
  compactableStartOrdinal: number;
  compactableEndOrdinal: number;
  plannedFreshTailStartOrdinal?: number | null;
  promptVersion: string;
  model: string;
};

export type PendingSummaryNodeRecord = {
  nodeId: string;
  batchId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  status: PendingSummaryNodeStatus;
  ordinalStart: number;
  ordinalEnd: number;
  sourceFingerprint: string;
  sourceContextHash: string | null;
  content: string | null;
  tokenCount: number | null;
  promptVersion: string;
  model: string;
  canonicalSummaryId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  failureSummary: string | null;
  createdAt: Date;
  updatedAt: Date;
  readyAt: Date | null;
  promotedAt: Date | null;
};

export type InsertPendingSummaryNodeInput = {
  nodeId: string;
  batchId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  status?: PendingSummaryNodeStatus;
  ordinalStart: number;
  ordinalEnd: number;
  sourceFingerprint: string;
  sourceContextHash?: string | null;
  content?: string | null;
  tokenCount?: number | null;
  promptVersion: string;
  model: string;
};

export type PendingSummaryNodeMessageInput = {
  messageId: number;
  transcriptEntryId?: string | null;
  identityHash?: string | null;
};

export type PendingSummaryNodeMessageRecord = {
  messageId: number;
  transcriptEntryId: string | null;
  identityHash: string | null;
};

export type PendingSummaryNodeChildInput = {
  childNodeId?: string | null;
  childSummaryId?: string | null;
};

export type PendingSummaryNodeChildRecord = {
  childNodeId: string | null;
  childSummaryId: string | null;
};

type PendingCompactionBatchRow = {
  batch_id: string;
  conversation_id: number;
  session_key: string | null;
  session_target_json: string;
  status: PendingCompactionBatchStatus;
  source_projection_fingerprint: string;
  compactable_start_ordinal: number;
  compactable_end_ordinal: number;
  planned_fresh_tail_start_ordinal: number | null;
  prompt_version: string;
  model: string;
  failure_summary: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};

type PendingSummaryNodeRow = {
  node_id: string;
  batch_id: string;
  conversation_id: number;
  kind: SummaryKind;
  depth: number;
  status: PendingSummaryNodeStatus;
  ordinal_start: number;
  ordinal_end: number;
  source_fingerprint: string;
  source_context_hash: string | null;
  content: string | null;
  token_count: number | null;
  prompt_version: string;
  model: string;
  canonical_summary_id: string | null;
  lease_owner: string | null;
  lease_expires_at: string | null;
  failure_summary: string | null;
  created_at: string;
  updated_at: string;
  ready_at: string | null;
  promoted_at: string | null;
};

type PendingSummaryNodeMessageRow = {
  message_id: number;
  transcript_entry_id: string | null;
  identity_hash: string | null;
};

type PendingSummaryNodeChildRow = {
  child_node_id: string | null;
  child_summary_id: string | null;
};

function toBatchRecord(row: PendingCompactionBatchRow): PendingCompactionBatchRecord {
  return {
    batchId: row.batch_id,
    conversationId: row.conversation_id,
    sessionKey: row.session_key,
    sessionTargetJson: row.session_target_json,
    status: row.status,
    sourceProjectionFingerprint: row.source_projection_fingerprint,
    compactableStartOrdinal: row.compactable_start_ordinal,
    compactableEndOrdinal: row.compactable_end_ordinal,
    plannedFreshTailStartOrdinal: row.planned_fresh_tail_start_ordinal,
    promptVersion: row.prompt_version,
    model: row.model,
    failureSummary: row.failure_summary,
    createdAt: parseUtcTimestampOrNull(row.created_at) ?? new Date(0),
    updatedAt: parseUtcTimestampOrNull(row.updated_at) ?? new Date(0),
    publishedAt: parseUtcTimestampOrNull(row.published_at),
  };
}

function toNodeRecord(row: PendingSummaryNodeRow): PendingSummaryNodeRecord {
  return {
    nodeId: row.node_id,
    batchId: row.batch_id,
    conversationId: row.conversation_id,
    kind: row.kind,
    depth: row.depth,
    status: row.status,
    ordinalStart: row.ordinal_start,
    ordinalEnd: row.ordinal_end,
    sourceFingerprint: row.source_fingerprint,
    sourceContextHash: row.source_context_hash,
    content: row.content,
    tokenCount: row.token_count,
    promptVersion: row.prompt_version,
    model: row.model,
    canonicalSummaryId: row.canonical_summary_id,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: parseUtcTimestampOrNull(row.lease_expires_at),
    failureSummary: row.failure_summary,
    createdAt: parseUtcTimestampOrNull(row.created_at) ?? new Date(0),
    updatedAt: parseUtcTimestampOrNull(row.updated_at) ?? new Date(0),
    readyAt: parseUtcTimestampOrNull(row.ready_at),
    promotedAt: parseUtcTimestampOrNull(row.promoted_at),
  };
}

function toNodeMessageRecord(
  row: PendingSummaryNodeMessageRow,
): PendingSummaryNodeMessageRecord {
  return {
    messageId: row.message_id,
    transcriptEntryId: row.transcript_entry_id,
    identityHash: row.identity_hash,
  };
}

function toNodeChildRecord(row: PendingSummaryNodeChildRow): PendingSummaryNodeChildRecord {
  return {
    childNodeId: row.child_node_id,
    childSummaryId: row.child_summary_id,
  };
}

function nullableDateToIso(value: Date | null | undefined): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

function normalizeNonNegativeInteger(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}`);
  }
  return Math.floor(value);
}

function normalizeOrdinalRange(start: number, end: number): { start: number; end: number } {
  const normalizedStart = normalizeNonNegativeInteger(start);
  const normalizedEnd = normalizeNonNegativeInteger(end);
  if (normalizedEnd < normalizedStart) {
    throw new Error(`Expected ordinal end ${normalizedEnd} to be >= start ${normalizedStart}`);
  }
  return { start: normalizedStart, end: normalizedEnd };
}

/**
 * Store for hidden pending summary batches and nodes.
 *
 * Pending rows are intentionally separate from canonical summaries. The context
 * engine can prepare and retry work here without making it visible to canonical
 * summary readers, FTS, assembly, or expansion.
 */
export class PendingSummaryStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Execute multiple pending-summary writes atomically. */
  withTransaction<T>(operation: () => Promise<T> | T): Promise<T> {
    return withDatabaseTransaction(this.db, "BEGIN", operation);
  }

  /** Create a pending compaction batch. */
  async createBatch(
    input: CreatePendingCompactionBatchInput,
  ): Promise<PendingCompactionBatchRecord> {
    const compactableRange = normalizeOrdinalRange(
      input.compactableStartOrdinal,
      input.compactableEndOrdinal,
    );
    this.db
      .prepare(
        `INSERT INTO pending_compaction_batches (
           batch_id,
           conversation_id,
           session_key,
           session_target_json,
           status,
           source_projection_fingerprint,
           compactable_start_ordinal,
           compactable_end_ordinal,
           planned_fresh_tail_start_ordinal,
           prompt_version,
           model
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.batchId,
        input.conversationId,
        input.sessionKey ?? null,
        input.sessionTargetJson ?? "{}",
        input.status ?? "planning",
        input.sourceProjectionFingerprint,
        compactableRange.start,
        compactableRange.end,
        typeof input.plannedFreshTailStartOrdinal === "number"
          ? normalizeNonNegativeInteger(input.plannedFreshTailStartOrdinal)
          : null,
        input.promptVersion,
        input.model,
      );

    const batch = await this.getBatch(input.batchId);
    if (!batch) {
      throw new Error(`Failed to create pending compaction batch ${input.batchId}`);
    }
    return batch;
  }

  /** Load a pending compaction batch by id. */
  async getBatch(batchId: string): Promise<PendingCompactionBatchRecord | null> {
    const row = this.db
      .prepare(
        `SELECT batch_id,
                conversation_id,
                session_key,
                session_target_json,
                status,
                source_projection_fingerprint,
                compactable_start_ordinal,
                compactable_end_ordinal,
                planned_fresh_tail_start_ordinal,
                prompt_version,
                model,
                failure_summary,
                created_at,
                updated_at,
                published_at
         FROM pending_compaction_batches
         WHERE batch_id = ?`,
      )
      .get(batchId) as PendingCompactionBatchRow | undefined;
    return row ? toBatchRecord(row) : null;
  }

  /** Load the newest active pending compaction batch for a conversation. */
  async getActiveBatchForConversation(
    conversationId: number,
  ): Promise<PendingCompactionBatchRecord | null> {
    const row = this.db
      .prepare(
        `SELECT batch_id,
                conversation_id,
                session_key,
                session_target_json,
                status,
                source_projection_fingerprint,
                compactable_start_ordinal,
                compactable_end_ordinal,
                planned_fresh_tail_start_ordinal,
                prompt_version,
                model,
                failure_summary,
                created_at,
                updated_at,
                published_at
         FROM pending_compaction_batches
         WHERE conversation_id = ?
           AND status IN ('planning', 'ready', 'publishing')
         ORDER BY created_at DESC, batch_id DESC
         LIMIT 1`,
      )
      .get(conversationId) as PendingCompactionBatchRow | undefined;
    return row ? toBatchRecord(row) : null;
  }

  /** Mark a pending compaction batch as published. */
  async markBatchPublished(input: { batchId: string; publishedAt?: Date }): Promise<void> {
    this.db
      .prepare(
        `UPDATE pending_compaction_batches
         SET status = 'published',
             failure_summary = NULL,
             published_at = COALESCE(?, datetime('now')),
             updated_at = datetime('now')
         WHERE batch_id = ?`,
      )
      .run(nullableDateToIso(input.publishedAt), input.batchId);
  }

  /** Mark a pending compaction batch as stale. */
  async markBatchStale(input: { batchId: string; failureSummary?: string | null }): Promise<void> {
    this.db
      .prepare(
        `UPDATE pending_compaction_batches
         SET status = 'stale',
             failure_summary = ?,
             updated_at = datetime('now')
         WHERE batch_id = ?`,
      )
      .run(input.failureSummary ?? null, input.batchId);
  }

  /** Insert a pending summary node into a batch. */
  async insertNode(input: InsertPendingSummaryNodeInput): Promise<PendingSummaryNodeRecord> {
    const ordinalRange = normalizeOrdinalRange(input.ordinalStart, input.ordinalEnd);
    this.db
      .prepare(
        `INSERT INTO pending_summary_nodes (
           node_id,
           batch_id,
           conversation_id,
           kind,
           depth,
           status,
           ordinal_start,
           ordinal_end,
           source_fingerprint,
           source_context_hash,
           content,
           token_count,
           prompt_version,
           model
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.nodeId,
        input.batchId,
        input.conversationId,
        input.kind,
        normalizeNonNegativeInteger(input.depth),
        input.status ?? "planned",
        ordinalRange.start,
        ordinalRange.end,
        input.sourceFingerprint,
        input.sourceContextHash ?? null,
        input.content ?? null,
        typeof input.tokenCount === "number" ? normalizeNonNegativeInteger(input.tokenCount) : null,
        input.promptVersion,
        input.model,
      );

    const node = await this.getNode(input.nodeId);
    if (!node) {
      throw new Error(`Failed to create pending summary node ${input.nodeId}`);
    }
    return node;
  }

  /** Load a pending summary node by id. */
  async getNode(nodeId: string): Promise<PendingSummaryNodeRecord | null> {
    const row = this.db
      .prepare(
        `SELECT node_id,
                batch_id,
                conversation_id,
                kind,
                depth,
                status,
                ordinal_start,
                ordinal_end,
                source_fingerprint,
                source_context_hash,
                content,
                token_count,
                prompt_version,
                model,
                canonical_summary_id,
                lease_owner,
                lease_expires_at,
                failure_summary,
                created_at,
                updated_at,
                ready_at,
                promoted_at
         FROM pending_summary_nodes
         WHERE node_id = ?`,
      )
      .get(nodeId) as PendingSummaryNodeRow | undefined;
    return row ? toNodeRecord(row) : null;
  }

  /** List pending nodes in batch order. */
  async getNodesByBatch(batchId: string): Promise<PendingSummaryNodeRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT node_id,
                batch_id,
                conversation_id,
                kind,
                depth,
                status,
                ordinal_start,
                ordinal_end,
                source_fingerprint,
                source_context_hash,
                content,
                token_count,
                prompt_version,
                model,
                canonical_summary_id,
                lease_owner,
                lease_expires_at,
                failure_summary,
                created_at,
                updated_at,
                ready_at,
                promoted_at
         FROM pending_summary_nodes
         WHERE batch_id = ?
         ORDER BY ordinal_start, depth, node_id`,
      )
      .all(batchId) as PendingSummaryNodeRow[];
    return rows.map(toNodeRecord);
  }

  /** Link a leaf pending node to the raw messages it summarizes. */
  async linkNodeToMessages(
    nodeId: string,
    messages: PendingSummaryNodeMessageInput[],
  ): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO pending_summary_node_messages (
         node_id,
         message_id,
         ordinal,
         transcript_entry_id,
         identity_hash
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (node_id, message_id) DO UPDATE SET
         ordinal = excluded.ordinal,
         transcript_entry_id = excluded.transcript_entry_id,
         identity_hash = excluded.identity_hash`,
    );

    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      stmt.run(
        nodeId,
        message.messageId,
        index,
        message.transcriptEntryId ?? null,
        message.identityHash ?? null,
      );
    }
  }

  /** Read the raw message coverage for a pending leaf node. */
  async getNodeMessages(nodeId: string): Promise<PendingSummaryNodeMessageRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT message_id, transcript_entry_id, identity_hash
         FROM pending_summary_node_messages
         WHERE node_id = ?
         ORDER BY ordinal`,
      )
      .all(nodeId) as PendingSummaryNodeMessageRow[];
    return rows.map(toNodeMessageRecord);
  }

  /** Link a pending condensed node to pending or canonical child summaries. */
  async linkNodeToChildren(
    nodeId: string,
    children: PendingSummaryNodeChildInput[],
  ): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO pending_summary_node_children (
         node_id,
         ordinal,
         child_node_id,
         child_summary_id
       ) VALUES (?, ?, ?, ?)
       ON CONFLICT (node_id, ordinal) DO UPDATE SET
         child_node_id = excluded.child_node_id,
         child_summary_id = excluded.child_summary_id`,
    );

    for (let index = 0; index < children.length; index++) {
      const child = children[index];
      stmt.run(nodeId, index, child.childNodeId ?? null, child.childSummaryId ?? null);
    }
  }

  /** Read the ordered children for a pending condensed node. */
  async getNodeChildren(nodeId: string): Promise<PendingSummaryNodeChildRecord[]> {
    const rows = this.db
      .prepare(
        `SELECT child_node_id, child_summary_id
         FROM pending_summary_node_children
         WHERE node_id = ?
         ORDER BY ordinal`,
      )
      .all(nodeId) as PendingSummaryNodeChildRow[];
    return rows.map(toNodeChildRecord);
  }

  /** Claim the oldest planned node or expired running node. */
  async claimNextPlannedNode(input: {
    conversationId: number;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now?: Date;
  }): Promise<PendingSummaryNodeRecord | null> {
    return this.withTransaction(async () => {
      const nowIso = (input.now ?? new Date()).toISOString();
      const row = this.db
        .prepare(
          `SELECT node_id,
                  batch_id,
                  conversation_id,
                  kind,
                  depth,
                  status,
                  ordinal_start,
                  ordinal_end,
                  source_fingerprint,
                  source_context_hash,
                  content,
                  token_count,
                  prompt_version,
                  model,
                  canonical_summary_id,
                  lease_owner,
                  lease_expires_at,
                  failure_summary,
                  created_at,
                  updated_at,
                  ready_at,
                  promoted_at
           FROM pending_summary_nodes
           WHERE conversation_id = ?
             AND (
               status = 'planned'
               OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
             AND NOT EXISTS (
               SELECT 1
               FROM pending_summary_node_children pc
               JOIN pending_summary_nodes child ON child.node_id = pc.child_node_id
               WHERE pc.node_id = pending_summary_nodes.node_id
                 AND child.status NOT IN ('ready', 'promoted')
             )
           ORDER BY ordinal_start, depth, node_id
           LIMIT 1`,
        )
        .get(input.conversationId, nowIso) as PendingSummaryNodeRow | undefined;

      if (!row) {
        return null;
      }

      const result = this.db
        .prepare(
          `UPDATE pending_summary_nodes
           SET status = 'running',
               lease_owner = ?,
               lease_expires_at = ?,
               failure_summary = NULL,
               updated_at = datetime('now')
           WHERE node_id = ?
             AND (
               status = 'planned'
               OR (status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
             AND NOT EXISTS (
               SELECT 1
               FROM pending_summary_node_children pc
               JOIN pending_summary_nodes child ON child.node_id = pc.child_node_id
               WHERE pc.node_id = pending_summary_nodes.node_id
                 AND child.status NOT IN ('ready', 'promoted')
             )`,
        )
        .run(input.leaseOwner, input.leaseExpiresAt.toISOString(), row.node_id, nowIso);
      if (Number(result.changes ?? 0) === 0) {
        return null;
      }

      return this.getNode(row.node_id);
    });
  }

  /** Mark a running pending node ready with generated content. */
  async markNodeReady(input: {
    nodeId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    content: string;
    tokenCount: number;
    readyAt?: Date;
  }): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE pending_summary_nodes
         SET status = 'ready',
             content = ?,
             token_count = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             failure_summary = NULL,
             ready_at = COALESCE(?, datetime('now')),
             updated_at = datetime('now')
         WHERE node_id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_expires_at = ?`,
      )
      .run(
        input.content,
        normalizeNonNegativeInteger(input.tokenCount),
        nullableDateToIso(input.readyAt),
        input.nodeId,
        input.leaseOwner,
        input.leaseExpiresAt.toISOString(),
      );
    return Number(result.changes ?? 0) > 0;
  }

  /** Mark a pending node failed and release its lease. */
  async markNodeFailed(input: {
    nodeId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    failureSummary: string;
  }): Promise<boolean> {
    const result = this.db
      .prepare(
        `UPDATE pending_summary_nodes
         SET status = 'failed',
             lease_owner = NULL,
             lease_expires_at = NULL,
             failure_summary = ?,
             updated_at = datetime('now')
         WHERE node_id = ?
           AND status = 'running'
           AND lease_owner = ?
           AND lease_expires_at = ?`,
      )
      .run(
        input.failureSummary,
        input.nodeId,
        input.leaseOwner,
        input.leaseExpiresAt.toISOString(),
      );
    return Number(result.changes ?? 0) > 0;
  }

  /** Record the canonical summary id created from a pending node. */
  async markNodePromoted(input: {
    nodeId: string;
    canonicalSummaryId: string;
    promotedAt?: Date;
  }): Promise<void> {
    this.db
      .prepare(
        `UPDATE pending_summary_nodes
         SET status = 'promoted',
             canonical_summary_id = ?,
             lease_owner = NULL,
             lease_expires_at = NULL,
             failure_summary = NULL,
             promoted_at = COALESCE(?, datetime('now')),
             updated_at = datetime('now')
         WHERE node_id = ?`,
      )
      .run(input.canonicalSummaryId, nullableDateToIso(input.promotedAt), input.nodeId);
  }
}
