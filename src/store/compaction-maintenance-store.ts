import type { DatabaseSync } from "node:sqlite";
import { withDatabaseTransaction } from "../transaction-mutex.js";
import { parseUtcTimestampOrNull } from "./parse-utc-timestamp.js";

export type ConversationCompactionMaintenanceRecord = {
  conversationId: number;
  pending: boolean;
  requestedAt: Date | null;
  reason: string | null;
  running: boolean;
  lastStartedAt: Date | null;
  lastFinishedAt: Date | null;
  lastFailureSummary: string | null;
  tokenBudget: number | null;
  currentTokenCount: number | null;
  updatedAt: Date;
};

type ConversationCompactionMaintenanceRow = {
  conversation_id: number;
  pending: number;
  requested_at: string | null;
  reason: string | null;
  running: number;
  last_started_at: string | null;
  last_finished_at: string | null;
  last_failure_summary: string | null;
  token_budget: number | null;
  current_token_count: number | null;
  updated_at: string;
};

function toMaintenanceRecord(
  row: ConversationCompactionMaintenanceRow,
): ConversationCompactionMaintenanceRecord {
  return {
    conversationId: row.conversation_id,
    pending: row.pending === 1,
    requestedAt: parseUtcTimestampOrNull(row.requested_at),
    reason: row.reason,
    running: row.running === 1,
    lastStartedAt: parseUtcTimestampOrNull(row.last_started_at),
    lastFinishedAt: parseUtcTimestampOrNull(row.last_finished_at),
    lastFailureSummary: row.last_failure_summary,
    tokenBudget: row.token_budget,
    currentTokenCount: row.current_token_count,
    updatedAt: parseUtcTimestampOrNull(row.updated_at) ?? new Date(0),
  };
}

function mergeMaintenanceRecord(
  conversationId: number,
  existing: ConversationCompactionMaintenanceRecord | null,
  patch: Partial<ConversationCompactionMaintenanceRecord>,
): ConversationCompactionMaintenanceRecord {
  return {
    conversationId,
    pending: patch.pending !== undefined ? patch.pending : existing?.pending ?? false,
    requestedAt: patch.requestedAt !== undefined ? patch.requestedAt : existing?.requestedAt ?? null,
    reason: patch.reason !== undefined ? patch.reason : existing?.reason ?? null,
    running: patch.running !== undefined ? patch.running : existing?.running ?? false,
    lastStartedAt:
      patch.lastStartedAt !== undefined ? patch.lastStartedAt : existing?.lastStartedAt ?? null,
    lastFinishedAt:
      patch.lastFinishedAt !== undefined ? patch.lastFinishedAt : existing?.lastFinishedAt ?? null,
    lastFailureSummary:
      patch.lastFailureSummary !== undefined
        ? patch.lastFailureSummary
        : existing?.lastFailureSummary ?? null,
    tokenBudget: patch.tokenBudget !== undefined ? patch.tokenBudget : existing?.tokenBudget ?? null,
    currentTokenCount:
      patch.currentTokenCount !== undefined ? patch.currentTokenCount : existing?.currentTokenCount ?? null,
    updatedAt: new Date(),
  };
}

/**
 * Persist and query per-conversation proactive-compaction maintenance state.
 *
 * The plugin records deferred compaction debt here and the host/runtime may opt
 * in to consume it later. The row is intentionally coalesced: there is one
 * maintenance record per conversation, not a queue of pending jobs.
 */
export class CompactionMaintenanceStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Execute multiple maintenance writes atomically. */
  withTransaction<T>(fn: () => Promise<T>): Promise<T> {
    return withDatabaseTransaction(this.db, "BEGIN", fn);
  }

  /** Load the latest persisted maintenance state for a conversation. */
  async getConversationCompactionMaintenance(
    conversationId: number,
  ): Promise<ConversationCompactionMaintenanceRecord | null> {
    const row = this.db
      .prepare(
        `SELECT
           conversation_id,
           pending,
           requested_at,
           reason,
           running,
           last_started_at,
           last_finished_at,
           last_failure_summary,
           token_budget,
           current_token_count,
           updated_at
         FROM conversation_compaction_maintenance
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as ConversationCompactionMaintenanceRow | undefined;
    return row ? toMaintenanceRecord(row) : null;
  }

  private async saveConversationCompactionMaintenance(
    record: ConversationCompactionMaintenanceRecord,
  ): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO conversation_compaction_maintenance (
           conversation_id,
           pending,
           requested_at,
         reason,
         running,
         last_started_at,
         last_finished_at,
         last_failure_summary,
         token_budget,
         current_token_count,
         updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(conversation_id) DO UPDATE SET
           pending = excluded.pending,
           requested_at = excluded.requested_at,
           reason = excluded.reason,
           running = excluded.running,
           last_started_at = excluded.last_started_at,
           last_finished_at = excluded.last_finished_at,
           last_failure_summary = excluded.last_failure_summary,
           token_budget = excluded.token_budget,
           current_token_count = excluded.current_token_count,
           updated_at = datetime('now')`,
      )
      .run(
        record.conversationId,
        record.pending ? 1 : 0,
        record.requestedAt?.toISOString() ?? null,
        record.reason ?? null,
        record.running ? 1 : 0,
        record.lastStartedAt?.toISOString() ?? null,
        record.lastFinishedAt?.toISOString() ?? null,
        record.lastFailureSummary ?? null,
        record.tokenBudget ?? null,
        record.currentTokenCount ?? null,
      );
  }

  /** Record or refresh deferred proactive-compaction debt for a conversation. */
  async requestProactiveCompactionDebt(input: {
    conversationId: number;
    reason: string;
    requestedAt?: Date;
    tokenBudget?: number | null;
    currentTokenCount?: number | null;
  }): Promise<void> {
    const existing = await this.getConversationCompactionMaintenance(input.conversationId);
    await this.saveConversationCompactionMaintenance(
      mergeMaintenanceRecord(input.conversationId, existing, {
        pending: true,
        requestedAt: input.requestedAt ?? new Date(),
        reason: input.reason,
        running: false,
        tokenBudget: input.tokenBudget ?? existing?.tokenBudget ?? null,
        currentTokenCount: input.currentTokenCount ?? existing?.currentTokenCount ?? null,
      }),
    );
  }

  /** Mark deferred proactive compaction as actively running. */
  async markProactiveCompactionRunning(input: {
    conversationId: number;
    startedAt?: Date;
  }): Promise<void> {
    const existing = await this.getConversationCompactionMaintenance(input.conversationId);
    await this.saveConversationCompactionMaintenance(
      mergeMaintenanceRecord(input.conversationId, existing, {
        pending: false,
        running: true,
        lastStartedAt: input.startedAt ?? new Date(),
      }),
    );
  }

  /** Mark deferred proactive compaction as finished. */
  async markProactiveCompactionFinished(input: {
    conversationId: number;
    finishedAt?: Date;
    failureSummary?: string | null;
    keepPending?: boolean;
  }): Promise<void> {
    const existing = await this.getConversationCompactionMaintenance(input.conversationId);
    const finishedAt = input.finishedAt ?? new Date();
    const isFailure = input.failureSummary != null;
    await this.saveConversationCompactionMaintenance(
      mergeMaintenanceRecord(input.conversationId, existing, {
        pending: input.keepPending ?? isFailure,
        running: false,
        lastFinishedAt: finishedAt,
        lastFailureSummary:
          input.failureSummary === undefined
            ? existing?.lastFailureSummary ?? null
            : input.failureSummary,
      }),
    );
  }
}
