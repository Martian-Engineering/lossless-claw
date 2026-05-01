import type { DatabaseSync } from "node:sqlite";

export type ObservedWorkStatus =
  | "observed_completed"
  | "observed_unfinished"
  | "observed_ambiguous"
  | "decision_recorded"
  | "dismissed";

export type ObservedWorkKind =
  | "implementation"
  | "review"
  | "blocker"
  | "decision"
  | "question"
  | "follow_up"
  | "test"
  | "deploy"
  | "research"
  | "other";

export type ObservedWorkItemInput = {
  workItemId: string;
  conversationId: number;
  ownerId?: string;
  title: string;
  description?: string;
  observedStatus: ObservedWorkStatus;
  kind: ObservedWorkKind;
  confidence?: number;
  confidenceBand?: "low" | "medium" | "medium-high" | "high";
  rationale?: string;
  topicKey?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  completedAt?: string;
  completionConfidence?: number;
  evidenceCount?: number;
  sourceMessageCount?: number;
  sourceTokenCount?: number;
  authoritySource?: string;
  sensitivity?: string;
  visibility?: string;
  fingerprint: string;
  fingerprintVersion?: number;
};

export type ObservedWorkDensityQuery = {
  conversationId?: number;
  since?: string;
  before?: string;
  statuses?: ObservedWorkStatus[];
  kinds?: ObservedWorkKind[];
  topic?: string;
  minConfidence?: number;
  includeSources?: boolean;
  includeTransitions?: boolean;
  staleAfterDays?: number;
  limit?: number;
};

export type ObservedWorkProcessingState = {
  conversationId: number;
  lastProcessedSummaryCreatedAt?: string;
  lastProcessedSummaryId?: string;
  lastProcessedSummaryRowid?: number;
  pendingRebuild: boolean;
  updatedAt: string;
};

export type ObservedWorkItemSnapshot = {
  workItemId: string;
  conversationId: number;
  observedStatus: ObservedWorkStatus;
  kind: ObservedWorkKind;
  title: string;
  topicKey?: string;
  rationale?: string;
  confidence: number;
  firstSeenAt: string;
  lastSeenAt: string;
  evidenceCount: number;
};

export type ObservedWorkTransitionType =
  | "opened"
  | "reinforced"
  | "possibly_resolved"
  | "resolved"
  | "dismissed"
  | "marked_stale";

export type ObservedWorkTransition = {
  transitionId: string;
  workItemId: string;
  transitionType: ObservedWorkTransitionType;
  fromStatus?: ObservedWorkStatus;
  toStatus?: ObservedWorkStatus;
  observedAt: string;
  confidence: number;
  rationale: string;
  sourceType?: "summary" | "rollup" | "message";
  sourceId?: string;
};

type ObservedWorkRow = {
  work_item_id: string;
  conversation_id: number;
  title: string;
  observed_status: ObservedWorkStatus;
  kind: ObservedWorkKind;
  confidence: number;
  confidence_band: string;
  rationale: string | null;
  topic_key: string | null;
  first_seen_at: string;
  last_seen_at: string;
  completed_at: string | null;
  evidence_count: number;
};

type ObservedWorkStateRow = {
  conversation_id: number;
  last_processed_summary_created_at: string | null;
  last_processed_summary_id: string | null;
  last_processed_summary_rowid: number | null;
  pending_rebuild: number;
  updated_at: string;
};

type ObservedWorkItemSnapshotRow = {
  work_item_id: string;
  conversation_id: number;
  observed_status: ObservedWorkStatus;
  kind: ObservedWorkKind;
  title: string;
  topic_key: string | null;
  rationale: string | null;
  confidence: number;
  first_seen_at: string;
  last_seen_at: string;
  evidence_count: number;
};

type ObservedWorkDensityCountRow = {
  total_observed: number;
  completed: number | null;
  unfinished: number | null;
  ambiguous: number | null;
  dismissed: number | null;
  decision_recorded: number | null;
};

type ObservedWorkSourceRow = {
  work_item_id: string;
  source_type: "summary" | "rollup" | "message";
  source_id: string;
  ordinal: number;
  evidence_kind:
    | "created"
    | "reinforced"
    | "possible_completion"
    | "completed"
    | "contradicted"
    | "dismissed";
};

type ObservedWorkTransitionRow = {
  transition_id: string;
  work_item_id: string;
  transition_type: ObservedWorkTransitionType;
  from_status: ObservedWorkStatus | null;
  to_status: ObservedWorkStatus | null;
  observed_at: string;
  confidence: number;
  rationale: string;
  source_type: "summary" | "rollup" | "message";
  source_id: string;
};

export type ObservedWorkSource = {
  sourceType: "summary" | "rollup" | "message";
  sourceId: string;
  ordinal: number;
  evidenceKind:
    | "created"
    | "reinforced"
    | "possible_completion"
    | "completed"
    | "contradicted"
    | "dismissed";
};

export type ObservedWorkDensityItem = {
  workItemId: string;
  conversationId: number;
  title: string;
  observedStatus: ObservedWorkStatus;
  kind: ObservedWorkKind;
  confidence: number;
  confidenceBand: string;
  rationale?: string;
  topicKey?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  completedAt?: string;
  evidenceCount: number;
  sources?: ObservedWorkSource[];
};

export type ObservedWorkDensityResult = {
  density: {
    totalObserved: number;
    completed: number;
    unfinished: number;
    ambiguous: number;
    dismissed: number;
    decisionRecorded: number;
  };
  topUnfinished: ObservedWorkDensityItem[];
  completedHighlights: ObservedWorkDensityItem[];
  ambiguous: ObservedWorkDensityItem[];
  decisions: ObservedWorkDensityItem[];
  dismissedItems: ObservedWorkDensityItem[];
  staleItems?: ObservedWorkDensityItem[];
  transitions?: ObservedWorkTransition[];
  itemsIncluded: number;
  itemsOmitted: number;
};

function rowToItem(
  row: ObservedWorkRow,
  sourcesByWorkItemId?: Map<string, ObservedWorkSource[]>
): ObservedWorkDensityItem {
  return {
    workItemId: row.work_item_id,
    conversationId: row.conversation_id,
    title: row.title,
    observedStatus: row.observed_status,
    kind: row.kind,
    confidence: row.confidence,
    confidenceBand: row.confidence_band,
    ...(row.rationale ? { rationale: row.rationale } : {}),
    ...(row.topic_key ? { topicKey: row.topic_key } : {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    evidenceCount: row.evidence_count,
    ...(sourcesByWorkItemId
      ? { sources: sourcesByWorkItemId.get(row.work_item_id) ?? [] }
      : {}),
  };
}

function rowToTransition(
  row: ObservedWorkTransitionRow,
  includeSources: boolean,
): ObservedWorkTransition {
  return {
    transitionId: row.transition_id,
    workItemId: row.work_item_id,
    transitionType: row.transition_type,
    ...(row.from_status ? { fromStatus: row.from_status } : {}),
    ...(row.to_status ? { toStatus: row.to_status } : {}),
    observedAt: row.observed_at,
    confidence: row.confidence,
    rationale: row.rationale,
    ...(includeSources
      ? {
          sourceType: row.source_type,
          sourceId: row.source_id,
        }
      : {}),
  };
}

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (part) => `\\${part}`);
}

function normalizeTopicQuery(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  const pr = /^(?:pr|pull request)\s*#?\s*(\d{1,6})$/.exec(normalized);
  return pr?.[1] ? `pr-${pr[1]}` : normalized;
}

export class ObservedWorkStore {
  constructor(private readonly db: DatabaseSync) {}

  getItem(workItemId: string): ObservedWorkItemSnapshot | null {
    const row = this.db.prepare(
      `SELECT work_item_id, conversation_id, observed_status, kind, title, topic_key, rationale,
              confidence, first_seen_at, last_seen_at, evidence_count
       FROM lcm_observed_work_items
       WHERE work_item_id = ?`,
    ).get(workItemId) as ObservedWorkItemSnapshotRow | undefined;
    if (!row) {
      return null;
    }
    return {
      workItemId: row.work_item_id,
      conversationId: row.conversation_id,
      observedStatus: row.observed_status,
      kind: row.kind,
      title: row.title,
      ...(row.topic_key ? { topicKey: row.topic_key } : {}),
      ...(row.rationale ? { rationale: row.rationale } : {}),
      confidence: row.confidence,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      evidenceCount: row.evidence_count,
    };
  }

  findActiveItemsByTopic(input: {
    conversationId: number;
    topicKey: string;
    limit?: number;
  }): ObservedWorkItemSnapshot[] {
    const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
    const rows = this.db.prepare(
      `SELECT work_item_id, conversation_id, observed_status, kind, title, topic_key, rationale,
              confidence, first_seen_at, last_seen_at, evidence_count
       FROM lcm_observed_work_items
       WHERE conversation_id = ?
         AND topic_key = ?
         AND observed_status IN ('observed_unfinished', 'observed_ambiguous')
       ORDER BY last_seen_at DESC, confidence DESC
       LIMIT ?`,
    ).all(input.conversationId, input.topicKey, limit) as ObservedWorkItemSnapshotRow[];
    return rows.map((row) => ({
      workItemId: row.work_item_id,
      conversationId: row.conversation_id,
      observedStatus: row.observed_status,
      kind: row.kind,
      title: row.title,
      ...(row.topic_key ? { topicKey: row.topic_key } : {}),
      ...(row.rationale ? { rationale: row.rationale } : {}),
      confidence: row.confidence,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      evidenceCount: row.evidence_count,
    }));
  }

  upsertItem(item: ObservedWorkItemInput): void {
    this.db.prepare(
      `INSERT INTO lcm_observed_work_items (
        work_item_id, conversation_id, owner_id, title, description, observed_status, kind,
        confidence, confidence_band, rationale, topic_key, first_seen_at, last_seen_at,
        completed_at, completion_confidence, evidence_count, source_message_count,
        source_token_count, authority_source, sensitivity, visibility, fingerprint,
        fingerprint_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(work_item_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        owner_id = excluded.owner_id,
        title = excluded.title,
        description = excluded.description,
        observed_status = excluded.observed_status,
        kind = excluded.kind,
        confidence = excluded.confidence,
        confidence_band = excluded.confidence_band,
        rationale = excluded.rationale,
        topic_key = excluded.topic_key,
        first_seen_at = CASE
          WHEN julianday(excluded.first_seen_at) < julianday(lcm_observed_work_items.first_seen_at)
            THEN excluded.first_seen_at
          ELSE lcm_observed_work_items.first_seen_at
        END,
        last_seen_at = CASE
          WHEN julianday(excluded.last_seen_at) > julianday(lcm_observed_work_items.last_seen_at)
            THEN excluded.last_seen_at
          ELSE lcm_observed_work_items.last_seen_at
        END,
        completed_at = CASE
          WHEN lcm_observed_work_items.completed_at IS NULL THEN excluded.completed_at
          WHEN excluded.completed_at IS NULL THEN lcm_observed_work_items.completed_at
          WHEN julianday(excluded.completed_at) < julianday(lcm_observed_work_items.completed_at)
            THEN excluded.completed_at
          ELSE lcm_observed_work_items.completed_at
        END,
        completion_confidence = CASE
          WHEN excluded.completion_confidence IS NULL THEN lcm_observed_work_items.completion_confidence
          WHEN lcm_observed_work_items.completion_confidence IS NULL THEN excluded.completion_confidence
          WHEN excluded.completion_confidence > lcm_observed_work_items.completion_confidence
            THEN excluded.completion_confidence
          ELSE lcm_observed_work_items.completion_confidence
        END,
        evidence_count = excluded.evidence_count,
        source_message_count = excluded.source_message_count,
        source_token_count = excluded.source_token_count,
        authority_source = excluded.authority_source,
        sensitivity = excluded.sensitivity,
        visibility = excluded.visibility,
        fingerprint = excluded.fingerprint,
        fingerprint_version = excluded.fingerprint_version,
        updated_at = datetime('now')`,
    ).run(
      item.workItemId,
      item.conversationId,
      item.ownerId ?? null,
      item.title,
      item.description ?? null,
      item.observedStatus,
      item.kind,
      item.confidence ?? 0.5,
      item.confidenceBand ?? "medium",
      item.rationale ?? null,
      item.topicKey ?? null,
      item.firstSeenAt,
      item.lastSeenAt,
      item.completedAt ?? null,
      item.completionConfidence ?? null,
      item.evidenceCount ?? 0,
      item.sourceMessageCount ?? 0,
      item.sourceTokenCount ?? 0,
      item.authoritySource ?? "lcm_observed",
      item.sensitivity ?? null,
      item.visibility ?? null,
      item.fingerprint,
      item.fingerprintVersion ?? 1,
    );
  }

  addSource(input: {
    workItemId: string;
    sourceType: "summary" | "rollup" | "message";
    sourceId: string;
    ordinal: number;
    evidenceKind: "created" | "reinforced" | "possible_completion" | "completed" | "contradicted" | "dismissed";
  }): void {
    this.db.prepare(
      `INSERT INTO lcm_observed_work_sources (
        work_item_id, source_type, source_id, ordinal, evidence_kind
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(work_item_id, source_type, source_id, evidence_kind) DO UPDATE SET
        ordinal = excluded.ordinal`,
    ).run(input.workItemId, input.sourceType, input.sourceId, input.ordinal, input.evidenceKind);
  }

  hasSource(input: {
    workItemId: string;
    sourceType: "summary" | "rollup" | "message";
    sourceId: string;
    evidenceKind?: "created" | "reinforced" | "possible_completion" | "completed" | "contradicted" | "dismissed";
  }): boolean {
    const evidenceClause = input.evidenceKind ? "AND evidence_kind = ?" : "";
    const args = input.evidenceKind
      ? [input.workItemId, input.sourceType, input.sourceId, input.evidenceKind]
      : [input.workItemId, input.sourceType, input.sourceId];
    const row = this.db.prepare(
      `SELECT 1 AS found
       FROM lcm_observed_work_sources
       WHERE work_item_id = ?
         AND source_type = ?
         AND source_id = ?
         ${evidenceClause}
       LIMIT 1`,
    ).get(...args);
    return row != null;
  }

  updateItemObservation(input: {
    workItemId: string;
    observedStatus: ObservedWorkStatus;
    confidence: number;
    confidenceBand: "low" | "medium" | "medium-high" | "high";
    lastSeenAt: string;
    completedAt?: string;
    completionConfidence?: number;
    rationale?: string;
    evidenceIncrement?: number;
  }): void {
    this.db.prepare(
      `UPDATE lcm_observed_work_items
       SET observed_status = CASE
             WHEN observed_status = 'observed_completed' AND ? != 'observed_completed'
               THEN observed_status
             ELSE ?
           END,
           confidence = max(confidence, ?),
           confidence_band = CASE
             WHEN ? >= confidence THEN ?
             ELSE confidence_band
           END,
           last_seen_at = CASE
             WHEN julianday(?) > julianday(last_seen_at) THEN ?
             ELSE last_seen_at
           END,
           completed_at = CASE WHEN ? IS NOT NULL THEN ? ELSE completed_at END,
           completion_confidence = COALESCE(?, completion_confidence),
           rationale = COALESCE(?, rationale),
           evidence_count = evidence_count + ?,
           updated_at = datetime('now')
       WHERE work_item_id = ?`,
    ).run(
      input.observedStatus,
      input.observedStatus,
      input.confidence,
      input.confidence,
      input.confidenceBand,
      input.lastSeenAt,
      input.lastSeenAt,
      input.completedAt ?? null,
      input.completedAt ?? null,
      input.completionConfidence ?? null,
      input.rationale ?? null,
      input.evidenceIncrement ?? 1,
      input.workItemId,
    );
  }

  addTransition(input: {
    transitionId: string;
    workItemId: string;
    transitionType: ObservedWorkTransitionType;
    fromStatus?: ObservedWorkStatus;
    toStatus?: ObservedWorkStatus;
    observedAt: string;
    confidence: number;
    rationale: string;
    sourceType: "summary" | "rollup" | "message";
    sourceId: string;
  }): void {
    this.db.prepare(
      `INSERT OR IGNORE INTO lcm_observed_work_transitions (
        transition_id, work_item_id, transition_type, from_status, to_status,
        observed_at, confidence, rationale, source_type, source_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      input.transitionId,
      input.workItemId,
      input.transitionType,
      input.fromStatus ?? null,
      input.toStatus ?? null,
      input.observedAt,
      input.confidence,
      input.rationale,
      input.sourceType,
      input.sourceId,
    );
  }

  upsertState(input: {
    conversationId: number;
    lastProcessedSummaryCreatedAt?: string;
    lastProcessedSummaryId?: string;
    lastProcessedSummaryRowid?: number;
    pendingRebuild?: boolean;
  }): void {
    const pendingRebuild =
      input.pendingRebuild == null ? null : input.pendingRebuild ? 1 : 0;
    this.db.prepare(
      `INSERT INTO lcm_observed_work_state (
        conversation_id, last_processed_summary_created_at, last_processed_summary_id,
        last_processed_summary_rowid, pending_rebuild, updated_at
      ) VALUES (?, ?, ?, ?, COALESCE(?, 0), datetime('now'))
      ON CONFLICT(conversation_id) DO UPDATE SET
        last_processed_summary_created_at = CASE
          WHEN ? IS NULL THEN lcm_observed_work_state.last_processed_summary_created_at
          ELSE excluded.last_processed_summary_created_at
        END,
        last_processed_summary_id = CASE
          WHEN ? IS NULL THEN lcm_observed_work_state.last_processed_summary_id
          ELSE excluded.last_processed_summary_id
        END,
        last_processed_summary_rowid = CASE
          WHEN ? IS NULL THEN lcm_observed_work_state.last_processed_summary_rowid
          ELSE excluded.last_processed_summary_rowid
        END,
        pending_rebuild = CASE
          WHEN ? IS NULL THEN lcm_observed_work_state.pending_rebuild
          ELSE excluded.pending_rebuild
        END,
        updated_at = datetime('now')`,
    ).run(
      input.conversationId,
      input.lastProcessedSummaryCreatedAt ?? null,
      input.lastProcessedSummaryId ?? null,
      input.lastProcessedSummaryRowid ?? null,
      pendingRebuild,
      input.lastProcessedSummaryCreatedAt ?? null,
      input.lastProcessedSummaryId ?? null,
      input.lastProcessedSummaryRowid ?? null,
      pendingRebuild,
    );
  }

  getState(conversationId: number): ObservedWorkProcessingState | null {
    const row = this.db.prepare(
      `SELECT conversation_id, last_processed_summary_created_at, last_processed_summary_id,
              last_processed_summary_rowid, pending_rebuild, updated_at
       FROM lcm_observed_work_state
       WHERE conversation_id = ?`,
    ).get(conversationId) as ObservedWorkStateRow | undefined;
    if (!row) {
      return null;
    }
    return {
      conversationId: row.conversation_id,
      ...(row.last_processed_summary_created_at
        ? { lastProcessedSummaryCreatedAt: row.last_processed_summary_created_at }
        : {}),
      ...(row.last_processed_summary_id
        ? { lastProcessedSummaryId: row.last_processed_summary_id }
        : {}),
      ...(row.last_processed_summary_rowid != null
        ? { lastProcessedSummaryRowid: row.last_processed_summary_rowid }
        : {}),
      pendingRebuild: row.pending_rebuild === 1,
      updatedAt: row.updated_at,
    };
  }

  getDensity(query: ObservedWorkDensityQuery): ObservedWorkDensityResult {
    const where: string[] = [
      `EXISTS (
        SELECT 1
        FROM lcm_observed_work_sources src
        WHERE src.work_item_id = lcm_observed_work_items.work_item_id
      )`,
    ];
    const args: unknown[] = [];
    if (query.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(query.conversationId);
    }
    if (query.since) {
      where.push("julianday(last_seen_at) >= julianday(?)");
      args.push(query.since);
    }
    if (query.before) {
      where.push("julianday(first_seen_at) < julianday(?)");
      args.push(query.before);
    }
    if (query.statuses?.length) {
      where.push(`observed_status IN (${placeholders(query.statuses)})`);
      args.push(...query.statuses);
    }
    if (query.kinds?.length) {
      where.push(`kind IN (${placeholders(query.kinds)})`);
      args.push(...query.kinds);
    }
    const topic = normalizeTopicQuery(query.topic);
    if (topic) {
      const topicPattern = `%${escapeLikePattern(topic)}%`;
      where.push(
        `(lower(coalesce(topic_key, '')) = ?
          OR lower(coalesce(topic_key, '')) LIKE ? ESCAPE '\\'
          OR lower(title) LIKE ? ESCAPE '\\'
          OR lower(coalesce(rationale, '')) LIKE ? ESCAPE '\\')`
      );
      args.push(topic, topicPattern, topicPattern, topicPattern);
    }
    if (query.minConfidence != null) {
      where.push("confidence >= ?");
      args.push(query.minConfidence);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.max(1, Math.min(query.limit ?? 10, 50));
    const ambiguousLimit = limit;
    const counts = this.db.prepare(
      `SELECT
         COUNT(*) AS total_observed,
         SUM(CASE WHEN observed_status = 'observed_completed' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN observed_status = 'observed_unfinished' THEN 1 ELSE 0 END) AS unfinished,
         SUM(CASE WHEN observed_status = 'observed_ambiguous' THEN 1 ELSE 0 END) AS ambiguous,
         SUM(CASE WHEN observed_status = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
         SUM(CASE WHEN observed_status = 'decision_recorded' THEN 1 ELSE 0 END) AS decision_recorded
       FROM lcm_observed_work_items
       ${whereSql}`,
    ).get(...args) as ObservedWorkDensityCountRow;

    const statusAllowed = (status: ObservedWorkStatus): boolean =>
      !query.statuses?.length || query.statuses.includes(status);
    const getRowsForStatus = (
      status: ObservedWorkStatus,
      statusLimit: number,
    ): ObservedWorkRow[] => {
      if (!statusAllowed(status) || statusLimit <= 0) {
        return [];
      }
      const statusWhereSql =
        where.length > 0
          ? `WHERE ${where.join(" AND ")} AND observed_status = ?`
          : "WHERE observed_status = ?";
      return this.db.prepare(
        `SELECT work_item_id, conversation_id, title, observed_status, kind, confidence,
                confidence_band, rationale, topic_key, first_seen_at, last_seen_at,
                completed_at, evidence_count
         FROM lcm_observed_work_items
         ${statusWhereSql}
         ORDER BY last_seen_at DESC, confidence DESC
         LIMIT ?`,
      ).all(...args, status, statusLimit) as ObservedWorkRow[];
    };

    const unfinishedRows = getRowsForStatus("observed_unfinished", limit);
    const completedRows = getRowsForStatus("observed_completed", limit);
    const ambiguousRows = getRowsForStatus("observed_ambiguous", ambiguousLimit);
    const decisionRows = getRowsForStatus("decision_recorded", limit);
    const dismissedRows = getRowsForStatus("dismissed", limit);
    const staleRows = this.getStaleRows(
      where,
      args,
      Math.min(limit, 10),
      query.staleAfterDays,
    );
    const includedRows = [
      ...unfinishedRows,
      ...completedRows,
      ...ambiguousRows,
      ...decisionRows,
      ...dismissedRows,
      ...staleRows,
    ];
    const includedIds = new Set<string>(includedRows.map((row) => row.work_item_id));
    const sourcesByWorkItemId = query.includeSources
      ? this.getSourcesForWorkItems([...includedIds])
      : undefined;
    const transitions = query.includeTransitions
      ? this.getTransitionsForWorkItems([...includedIds], query.includeSources === true)
      : undefined;
    return {
      density: {
        totalObserved: counts.total_observed ?? 0,
        completed: counts.completed ?? 0,
        unfinished: counts.unfinished ?? 0,
        ambiguous: counts.ambiguous ?? 0,
        dismissed: counts.dismissed ?? 0,
        decisionRecorded: counts.decision_recorded ?? 0,
      },
      topUnfinished: unfinishedRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      completedHighlights: completedRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      ambiguous: ambiguousRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      decisions: decisionRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      dismissedItems: dismissedRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
      ...(query.staleAfterDays != null
        ? {
            staleItems: staleRows.map((row) => rowToItem(row, sourcesByWorkItemId)),
          }
        : {}),
      ...(transitions ? { transitions } : {}),
      itemsIncluded: includedIds.size,
      itemsOmitted: Math.max(0, (counts.total_observed ?? 0) - includedIds.size),
    };
  }

  private getStaleRows(
    where: string[],
    args: unknown[],
    limit: number,
    staleAfterDays: number | undefined,
  ): ObservedWorkRow[] {
    if (staleAfterDays == null || limit <= 0) {
      return [];
    }
    const days = Math.max(1, Math.min(Math.trunc(staleAfterDays), 365));
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const staleWhere = [
      ...where,
      "observed_status IN ('observed_unfinished', 'observed_ambiguous')",
      "julianday(last_seen_at) < julianday(?)",
    ];
    return this.db.prepare(
      `SELECT work_item_id, conversation_id, title, observed_status, kind, confidence,
              confidence_band, rationale, topic_key, first_seen_at, last_seen_at,
              completed_at, evidence_count
       FROM lcm_observed_work_items
       WHERE ${staleWhere.join(" AND ")}
       ORDER BY last_seen_at ASC, confidence DESC
       LIMIT ?`,
    ).all(...args, cutoff, limit) as ObservedWorkRow[];
  }

  private getTransitionsForWorkItems(
    workItemIds: string[],
    includeSources: boolean,
    perItemLimit = 20,
  ): ObservedWorkTransition[] {
    if (workItemIds.length === 0) {
      return [];
    }
    const transitionLimit = Math.max(1, Math.min(Math.trunc(perItemLimit), 50));
    const rows = this.db.prepare(
      `WITH ranked_transitions AS (
         SELECT transition_id, work_item_id, transition_type, from_status, to_status,
                observed_at, confidence, rationale, source_type, source_id,
                ROW_NUMBER() OVER (
                  PARTITION BY work_item_id
                  ORDER BY observed_at DESC, created_at DESC
                ) AS source_rank
         FROM lcm_observed_work_transitions
         WHERE work_item_id IN (${placeholders(workItemIds)})
       )
       SELECT transition_id, work_item_id, transition_type, from_status, to_status,
              observed_at, confidence, rationale, source_type, source_id
       FROM ranked_transitions
       WHERE source_rank <= ?
       ORDER BY work_item_id ASC, observed_at DESC`,
    ).all(...workItemIds, transitionLimit) as ObservedWorkTransitionRow[];
    return rows.map((row) => rowToTransition(row, includeSources));
  }

  private getSourcesForWorkItems(
    workItemIds: string[],
    perItemLimit = 20,
  ): Map<string, ObservedWorkSource[]> {
    if (workItemIds.length === 0) {
      return new Map();
    }
    const sourceLimit = Math.max(1, Math.min(Math.trunc(perItemLimit), 50));
    const rows = this.db
      .prepare(
        `WITH ranked_sources AS (
           SELECT work_item_id, source_type, source_id, ordinal, evidence_kind,
                  ROW_NUMBER() OVER (
                    PARTITION BY work_item_id
                    ORDER BY ordinal ASC, created_at ASC
                  ) AS source_rank
           FROM lcm_observed_work_sources
           WHERE work_item_id IN (${placeholders(workItemIds)})
         )
         SELECT work_item_id, source_type, source_id, ordinal, evidence_kind
         FROM ranked_sources
         WHERE source_rank <= ?
         ORDER BY work_item_id ASC, ordinal ASC`
      )
      .all(...workItemIds, sourceLimit) as ObservedWorkSourceRow[];
    const grouped = new Map<string, ObservedWorkSource[]>();
    for (const row of rows) {
      const sources = grouped.get(row.work_item_id) ?? [];
      sources.push({
        sourceType: row.source_type,
        sourceId: row.source_id,
        ordinal: row.ordinal,
        evidenceKind: row.evidence_kind,
      });
      grouped.set(row.work_item_id, sources);
    }
    return grouped;
  }
}
