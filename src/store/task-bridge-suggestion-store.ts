import type { DatabaseSync } from "node:sqlite";

export type TaskBridgeSuggestionKind =
  | "create_task"
  | "link_task"
  | "mark_task_done"
  | "mark_task_blocked"
  | "add_task_evidence";

export type TaskBridgeSuggestionStatus =
  | "pending"
  | "accepted"
  | "rejected"
  | "dismissed"
  | "expired";

export type TaskBridgeSuggestionInput = {
  suggestionId: string;
  workItemId: string;
  taskId?: string;
  suggestionKind: TaskBridgeSuggestionKind;
  status?: TaskBridgeSuggestionStatus;
  confidence: number;
  rationale: string;
  sourceIds: string[];
  createdBy?: string;
};

export type TaskBridgeSuggestion = {
  suggestionId: string;
  workItemId: string;
  taskId?: string;
  suggestionKind: TaskBridgeSuggestionKind;
  status: TaskBridgeSuggestionStatus;
  confidence: number;
  rationale: string;
  sourceIds: string[];
  createdBy: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
};

type TaskBridgeSuggestionRow = {
  suggestion_id: string;
  work_item_id: string;
  task_id: string | null;
  suggestion_kind: TaskBridgeSuggestionKind;
  status: TaskBridgeSuggestionStatus;
  confidence: number;
  rationale: string;
  source_ids: string;
  created_by: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
};

const REVIEW_STATUSES = new Set<TaskBridgeSuggestionStatus>([
  "accepted",
  "rejected",
  "dismissed",
  "expired",
]);

function normalizeSourceIds(sourceIds: string[]): string[] {
  return [
    ...new Set(
      sourceIds
        .map((sourceId) => sourceId.trim())
        .filter((sourceId) => sourceId.length > 0)
    ),
  ];
}

function rowToSuggestion(row: TaskBridgeSuggestionRow): TaskBridgeSuggestion {
  let sourceIds: string[] = [];
  try {
    const parsed = JSON.parse(row.source_ids) as unknown;
    sourceIds = Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    sourceIds = [];
  }
  return {
    suggestionId: row.suggestion_id,
    workItemId: row.work_item_id,
    ...(row.task_id ? { taskId: row.task_id } : {}),
    suggestionKind: row.suggestion_kind,
    status: row.status,
    confidence: row.confidence,
    rationale: row.rationale,
    sourceIds,
    createdBy: row.created_by,
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class TaskBridgeSuggestionStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertSuggestion(input: TaskBridgeSuggestionInput): void {
    if (!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1) {
      throw new Error("confidence must be between 0 and 1.");
    }
    if (input.rationale.trim().length === 0) {
      throw new Error("rationale is required.");
    }
    const sourceIds = normalizeSourceIds(input.sourceIds);
    if (sourceIds.length === 0) {
      throw new Error("at least one source ID is required.");
    }
    this.db.prepare(
      `INSERT INTO lcm_task_bridge_suggestions (
        suggestion_id, work_item_id, task_id, suggestion_kind, status, confidence,
        rationale, source_ids, created_by, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(suggestion_id) DO UPDATE SET
        work_item_id = excluded.work_item_id,
        task_id = excluded.task_id,
        suggestion_kind = excluded.suggestion_kind,
        status = excluded.status,
        confidence = excluded.confidence,
        rationale = excluded.rationale,
        source_ids = excluded.source_ids,
        created_by = excluded.created_by,
        updated_at = datetime('now')`,
    ).run(
      input.suggestionId,
      input.workItemId,
      input.taskId ?? null,
      input.suggestionKind,
      input.status ?? "pending",
      input.confidence,
      input.rationale.trim(),
      JSON.stringify(sourceIds),
      input.createdBy ?? "lcm_observed",
    );
  }

  listSuggestions(input?: {
    status?: TaskBridgeSuggestionStatus;
    suggestionKind?: TaskBridgeSuggestionKind;
    workItemId?: string;
    taskId?: string;
    limit?: number;
  }): TaskBridgeSuggestion[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (input?.status) {
      where.push("status = ?");
      args.push(input.status);
    }
    if (input?.suggestionKind) {
      where.push("suggestion_kind = ?");
      args.push(input.suggestionKind);
    }
    if (input?.workItemId) {
      where.push("work_item_id = ?");
      args.push(input.workItemId);
    }
    if (input?.taskId) {
      where.push("task_id = ?");
      args.push(input.taskId);
    }
    const limit = Math.max(1, Math.min(input?.limit ?? 20, 100));
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT suggestion_id, work_item_id, task_id, suggestion_kind, status,
              confidence, rationale, source_ids, created_by, reviewed_by, reviewed_at,
              created_at, updated_at
       FROM lcm_task_bridge_suggestions
       ${whereSql}
       ORDER BY created_at DESC
       LIMIT ?`,
    ).all(...args, limit) as TaskBridgeSuggestionRow[];
    return rows.map(rowToSuggestion);
  }

  reviewSuggestion(input: {
    suggestionId: string;
    status: Exclude<TaskBridgeSuggestionStatus, "pending">;
    reviewedBy?: string;
  }): boolean {
    if (!REVIEW_STATUSES.has(input.status)) {
      throw new Error("review status must be accepted, rejected, dismissed, or expired.");
    }
    const result = this.db.prepare(
      `UPDATE lcm_task_bridge_suggestions
       SET status = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now')
       WHERE suggestion_id = ?`,
    ).run(input.status, input.reviewedBy ?? null, input.suggestionId);
    return result.changes > 0;
  }
}
