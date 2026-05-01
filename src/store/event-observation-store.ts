import type { DatabaseSync } from "node:sqlite";

export type EventObservationKind =
  | "primary"
  | "retelling"
  | "memory_injection"
  | "echo"
  | "imported"
  | "operational_incident"
  | "decision";

export type EventObservationInput = {
  eventId: string;
  conversationId: number;
  eventKind: EventObservationKind;
  title: string;
  description?: string;
  queryKey?: string;
  eventTime?: string;
  ingestTime: string;
  confidence?: number;
  rationale: string;
  sourceType: "summary" | "rollup" | "message";
  sourceId: string;
  sourceIds?: string[];
};

export type EventObservation = {
  eventId: string;
  conversationId: number;
  eventKind: EventObservationKind;
  title: string;
  description?: string;
  queryKey?: string;
  eventTime?: string;
  ingestTime: string;
  confidence: number;
  rationale: string;
  sources?: Array<{ sourceType: "summary" | "rollup" | "message"; sourceId: string }>;
  createdAt: string;
  updatedAt: string;
};

type EventObservationRow = {
  event_id: string;
  conversation_id: number;
  event_kind: EventObservationKind;
  title: string;
  description: string | null;
  query_key: string | null;
  event_time: string | null;
  ingest_time: string;
  confidence: number;
  rationale: string;
  source_type: "summary" | "rollup" | "message";
  source_id: string;
  source_ids: string;
  created_at: string;
  updated_at: string;
};

function placeholders(values: readonly unknown[]): string {
  return values.map(() => "?").join(", ");
}

function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (part) => `\\${part}`);
}

function normalizeSourceIds(sourceIds: string[] | undefined, fallbackSourceId: string): string[] {
  return [
    ...new Set(
      [fallbackSourceId, ...(sourceIds ?? [])]
        .map((sourceId) => sourceId.trim())
        .filter((sourceId) => sourceId.length > 0)
    ),
  ];
}

function normalizeQueryKey(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase().replace(/\s+/g, " ");
  if (!normalized) {
    return null;
  }
  const pr =
    /^(?:pr|pull request)\s*#?\s*(\d{1,6})$/.exec(normalized) ??
    /^pr[-\s#]*(\d{1,6})$/.exec(normalized);
  if (pr?.[1]) {
    return `pr-${pr[1]}`;
  }
  return normalized;
}

function parseSourceIds(raw: string, sourceType: "summary" | "rollup" | "message"): Array<{
  sourceType: "summary" | "rollup" | "message";
  sourceId: string;
}> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((sourceId): sourceId is string => typeof sourceId === "string" && sourceId.trim().length > 0)
      .map((sourceId) => ({ sourceType, sourceId }));
  } catch {
    return [];
  }
}

function rowToEvent(row: EventObservationRow, includeSources: boolean): EventObservation {
  return {
    eventId: row.event_id,
    conversationId: row.conversation_id,
    eventKind: row.event_kind,
    title: row.title,
    ...(row.description ? { description: row.description } : {}),
    ...(row.query_key ? { queryKey: row.query_key } : {}),
    ...(row.event_time ? { eventTime: row.event_time } : {}),
    ingestTime: row.ingest_time,
    confidence: row.confidence,
    rationale: row.rationale,
    ...(includeSources
      ? { sources: parseSourceIds(row.source_ids, row.source_type) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class EventObservationStore {
  constructor(private readonly db: DatabaseSync) {}

  upsertObservation(input: EventObservationInput): void {
    if (!Number.isFinite(input.confidence ?? 0.5) || (input.confidence ?? 0.5) < 0 || (input.confidence ?? 0.5) > 1) {
      throw new Error("confidence must be between 0 and 1.");
    }
    if (input.title.trim().length === 0) {
      throw new Error("event title is required.");
    }
    if (input.rationale.trim().length === 0) {
      throw new Error("event rationale is required.");
    }
    const sourceId = input.sourceId.trim();
    if (sourceId.length === 0) {
      throw new Error("event source ID is required.");
    }
    const sourceIds = normalizeSourceIds(input.sourceIds, sourceId);
    this.db.prepare(
      `INSERT INTO lcm_event_observations (
        event_id, conversation_id, event_kind, title, description, query_key,
        event_time, ingest_time, confidence, rationale, source_type, source_id,
        source_ids, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(event_id) DO UPDATE SET
        conversation_id = excluded.conversation_id,
        event_kind = excluded.event_kind,
        title = excluded.title,
        description = excluded.description,
        query_key = excluded.query_key,
        event_time = excluded.event_time,
        ingest_time = excluded.ingest_time,
        confidence = excluded.confidence,
        rationale = excluded.rationale,
        source_type = excluded.source_type,
        source_id = excluded.source_id,
        source_ids = excluded.source_ids,
        updated_at = datetime('now')`,
    ).run(
      input.eventId,
      input.conversationId,
      input.eventKind,
      input.title.trim(),
      input.description?.trim() || null,
      normalizeQueryKey(input.queryKey),
      input.eventTime ?? null,
      input.ingestTime,
      input.confidence ?? 0.5,
      input.rationale.trim(),
      input.sourceType,
      sourceId,
      JSON.stringify(sourceIds),
    );
  }

  listObservations(input?: {
    conversationId?: number;
    eventKinds?: EventObservationKind[];
    query?: string;
    since?: string;
    before?: string;
    first?: boolean;
    includeSources?: boolean;
    limit?: number;
  }): EventObservation[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (input?.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(input.conversationId);
    }
    if (input?.eventKinds?.length) {
      where.push(`event_kind IN (${placeholders(input.eventKinds)})`);
      args.push(...input.eventKinds);
    }
    const query = normalizeQueryKey(input?.query);
    if (query) {
      const likeQuery = `%${escapeLikePattern(query)}%`;
      where.push(
        "(lower(coalesce(query_key, '')) = ? OR lower(title) LIKE ? ESCAPE '\\' OR lower(coalesce(description, '')) LIKE ? ESCAPE '\\')"
      );
      args.push(query, likeQuery, likeQuery);
    }
    if (input?.since) {
      where.push("julianday(coalesce(event_time, ingest_time)) >= julianday(?)");
      args.push(input.since);
    }
    if (input?.before) {
      where.push("julianday(coalesce(event_time, ingest_time)) < julianday(?)");
      args.push(input.before);
    }
    const limit = Math.max(1, Math.min(input?.limit ?? 20, 100));
    const order = input?.first ? "ASC" : "DESC";
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT event_id, conversation_id, event_kind, title, description, query_key,
              event_time, ingest_time, confidence, rationale, source_type, source_id,
              source_ids, created_at, updated_at
       FROM lcm_event_observations
       ${whereSql}
       ORDER BY julianday(coalesce(event_time, ingest_time)) ${order}, confidence DESC
       LIMIT ?`,
    ).all(...args, limit) as EventObservationRow[];
    return rows.map((row) => rowToEvent(row, input?.includeSources === true));
  }
}
