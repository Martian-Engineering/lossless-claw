import { createHash } from "node:crypto";
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

export type EventSource = {
  sourceType?: "summary" | "rollup" | "message";
  sourceId: string;
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
  sources?: EventSource[];
  createdAt: string;
  updatedAt: string;
};

export type EventEpisode = {
  episodeId: string;
  conversationId: number;
  episodeKind: EventObservationKind;
  topicKey: string;
  title: string;
  firstEventTime: string;
  lastEventTime: string;
  observationCount: number;
  confidence: number;
  sources?: EventSource[];
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

type EventEpisodeRow = {
  episode_id: string;
  conversation_id: number;
  episode_kind: EventObservationKind;
  topic_key: string;
  title: string;
  first_event_time: string;
  last_event_time: string;
  observation_count: number;
  confidence: number;
  source_ids: string;
  created_at: string;
  updated_at: string;
};

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

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

function isEventSourceType(value: unknown): value is "summary" | "rollup" | "message" {
  return value === "summary" || value === "rollup" || value === "message";
}

function parseSources(
  raw: string,
  fallbackSourceType?: "summary" | "rollup" | "message",
): EventSource[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .map((source): EventSource | null => {
        if (typeof source === "string" && source.trim().length > 0) {
          return {
            ...(fallbackSourceType ? { sourceType: fallbackSourceType } : {}),
            sourceId: source.trim(),
          };
        }
        if (
          typeof source === "object" &&
          source != null &&
          "sourceId" in source &&
          typeof source.sourceId === "string" &&
          source.sourceId.trim().length > 0
        ) {
          const sourceType = "sourceType" in source ? source.sourceType : undefined;
          return {
            ...(isEventSourceType(sourceType) ? { sourceType } : {}),
            sourceId: source.sourceId.trim(),
          };
        }
        return null;
      })
      .filter((source): source is EventSource => source != null);
  } catch {
    return [];
  }
}

function normalizeSources(sources: EventSource[]): EventSource[] {
  const seen = new Set<string>();
  const normalized: EventSource[] = [];
  for (const source of sources) {
    const sourceId = source.sourceId.trim();
    if (!sourceId) {
      continue;
    }
    const key = `${source.sourceType ?? ""}:${sourceId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    normalized.push({
      ...(source.sourceType ? { sourceType: source.sourceType } : {}),
      sourceId,
    });
  }
  return normalized;
}

function sourcesFromIds(
  sourceType: "summary" | "rollup" | "message",
  sourceIds: string[],
): EventSource[] {
  return normalizeSources(
    sourceIds.map((sourceId) => ({ sourceType, sourceId })),
  );
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
      ? { sources: parseSources(row.source_ids, row.source_type) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToEpisode(row: EventEpisodeRow, includeSources: boolean): EventEpisode {
  return {
    episodeId: row.episode_id,
    conversationId: row.conversation_id,
    episodeKind: row.episode_kind,
    topicKey: row.topic_key,
    title: row.title,
    firstEventTime: row.first_event_time,
    lastEventTime: row.last_event_time,
    observationCount: row.observation_count,
    confidence: row.confidence,
    ...(includeSources
      ? { sources: parseSources(row.source_ids) }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function compareIso(a: string, b: string, pick: "min" | "max"): string {
  const aTime = new Date(a).getTime();
  const bTime = new Date(b).getTime();
  if (!Number.isFinite(aTime)) return b;
  if (!Number.isFinite(bTime)) return a;
  if (pick === "min") {
    return aTime <= bTime ? a : b;
  }
  return aTime >= bTime ? a : b;
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
    const queryKey = normalizeQueryKey(input.queryKey) ?? "uncategorized";
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
      queryKey,
      input.eventTime ?? null,
      input.ingestTime,
      input.confidence ?? 0.5,
      input.rationale.trim(),
      input.sourceType,
      sourceId,
      JSON.stringify(sourceIds),
    );
    this.upsertEpisodeFromObservation({
      eventId: input.eventId,
      conversationId: input.conversationId,
      eventKind: input.eventKind,
      title: input.title.trim(),
      queryKey,
      eventTime: input.eventTime ?? input.ingestTime,
      confidence: input.confidence ?? 0.5,
      sourceType: input.sourceType,
      sourceIds,
    });
  }

  private upsertEpisodeFromObservation(input: {
    eventId: string;
    conversationId: number;
    eventKind: EventObservationKind;
    title: string;
    queryKey: string;
    eventTime: string;
    confidence: number;
    sourceType: "summary" | "rollup" | "message";
    sourceIds: string[];
  }): void {
    const episodeId = hashId(
      "ep",
      `${input.conversationId}:${input.eventKind}:${input.queryKey}`,
    );
    const existing = this.db.prepare(
      `SELECT episode_id, conversation_id, episode_kind, topic_key, title,
              first_event_time, last_event_time, observation_count, confidence,
              source_ids, created_at, updated_at
       FROM lcm_event_episodes
       WHERE episode_id = ?`,
    ).get(episodeId) as EventEpisodeRow | undefined;
    const sources = normalizeSources([
      ...(existing ? parseSources(existing.source_ids) : []),
      ...sourcesFromIds(
        input.sourceType,
        input.sourceIds.length > 0 ? input.sourceIds : [input.eventId],
      ),
    ]);
    const firstEventTime = existing
      ? compareIso(existing.first_event_time, input.eventTime, "min")
      : input.eventTime;
    const lastEventTime = existing
      ? compareIso(existing.last_event_time, input.eventTime, "max")
      : input.eventTime;
    this.db.prepare(
      `INSERT INTO lcm_event_episodes (
        episode_id, conversation_id, episode_kind, topic_key, title,
        first_event_time, last_event_time, observation_count, confidence,
        source_ids, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, datetime('now'))
      ON CONFLICT(episode_id) DO UPDATE SET
        title = CASE
          WHEN julianday(excluded.first_event_time) < julianday(lcm_event_episodes.first_event_time)
          THEN excluded.title
          ELSE lcm_event_episodes.title
        END,
        first_event_time = excluded.first_event_time,
        last_event_time = excluded.last_event_time,
        confidence = max(lcm_event_episodes.confidence, excluded.confidence),
        source_ids = excluded.source_ids,
        updated_at = datetime('now')`,
    ).run(
      episodeId,
      input.conversationId,
      input.eventKind,
      input.queryKey,
      input.title,
      firstEventTime,
      lastEventTime,
      input.confidence,
      JSON.stringify(sources),
    );
    this.db.prepare(
      `INSERT OR IGNORE INTO lcm_event_episode_observations (
        episode_id, event_id, ordinal
      ) VALUES (
        ?,
        ?,
        COALESCE((SELECT MAX(ordinal) + 1 FROM lcm_event_episode_observations WHERE episode_id = ?), 0)
      )`,
    ).run(episodeId, input.eventId, episodeId);
    const count = this.db.prepare(
      `SELECT COUNT(*) AS count
       FROM lcm_event_episode_observations
       WHERE episode_id = ?`,
    ).get(episodeId) as { count: number };
    this.db.prepare(
      `UPDATE lcm_event_episodes
       SET observation_count = ?, updated_at = datetime('now')
       WHERE episode_id = ?`,
    ).run(count.count, episodeId);
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

  listEpisodes(input?: {
    conversationId?: number;
    eventKinds?: EventObservationKind[];
    query?: string;
    since?: string;
    before?: string;
    first?: boolean;
    includeSources?: boolean;
    limit?: number;
  }): EventEpisode[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (input?.conversationId != null) {
      where.push("conversation_id = ?");
      args.push(input.conversationId);
    }
    if (input?.eventKinds?.length) {
      where.push(`episode_kind IN (${placeholders(input.eventKinds)})`);
      args.push(...input.eventKinds);
    }
    const query = input?.query?.trim().toLowerCase();
    if (query) {
      const likeQuery = `%${escapeLikePattern(query)}%`;
      where.push(
        "(lower(topic_key) = ? OR lower(title) LIKE ? ESCAPE '\\')"
      );
      args.push(query, likeQuery);
    }
    if (input?.since) {
      where.push("julianday(last_event_time) >= julianday(?)");
      args.push(input.since);
    }
    if (input?.before) {
      where.push("julianday(first_event_time) < julianday(?)");
      args.push(input.before);
    }
    const limit = Math.max(1, Math.min(input?.limit ?? 20, 100));
    const order = input?.first ? "ASC" : "DESC";
    const orderColumn = input?.first ? "first_event_time" : "last_event_time";
    const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
    const rows = this.db.prepare(
      `SELECT episode_id, conversation_id, episode_kind, topic_key, title,
              first_event_time, last_event_time, observation_count, confidence,
              source_ids, created_at, updated_at
       FROM lcm_event_episodes
       ${whereSql}
       ORDER BY julianday(${orderColumn}) ${order}, confidence DESC
       LIMIT ?`,
    ).all(...args, limit) as EventEpisodeRow[];
    return rows.map((row) => rowToEpisode(row, input?.includeSources === true));
  }
}
