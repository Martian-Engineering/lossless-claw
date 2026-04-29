import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type {
  ObservedWorkKind,
  ObservedWorkStatus,
  ObservedWorkStore,
} from "./store/observed-work-store.js";
import type {
  EventObservationKind,
  EventObservationStore,
} from "./store/event-observation-store.js";

type LeafSummaryRow = {
  summary_rowid: number;
  summary_id: string;
  conversation_id: number;
  content: string;
  token_count: number;
  source_message_token_count: number;
  source_message_count: number;
  created_at: string;
  effective_at: string | null;
};

export type ObservedWorkExtractionResult = {
  summariesScanned: number;
  workItemsUpserted: number;
  eventsUpserted: number;
};

type WorkCandidate = {
  title: string;
  observedStatus: ObservedWorkStatus;
  kind: ObservedWorkKind;
  confidence: number;
  confidenceBand: "low" | "medium" | "medium-high" | "high";
  evidenceKind: "created" | "reinforced" | "possible_completion" | "completed" | "contradicted" | "dismissed";
  topicKey: string;
  rationale: string;
  completed: boolean;
};

type EventCandidate = {
  eventKind: EventObservationKind;
  title: string;
  queryKey: string;
  confidence: number;
  rationale: string;
};

const COMPLETED_RE = /\b(completed|done|fixed|implemented|merged|shipped|landed|passed|green|resolved|closed)\b/i;
const UNFINISHED_RE = /\b(todo|follow[- ]?up|needs?|remaining|blocked|blocker|failing|failed|pending|unresolved|changes requested|not done|regression|risk)\b/i;
const DECISION_RE = /\b(decision|decided|agreed|settled|approved|chose)\b/i;
const AMBIGUOUS_RE = /\b(unclear|ambiguous|maybe|suspect|investigate|verify|question|unknown|possibly)\b/i;
const EVENT_RE = /\b(first occurrence|original event|started|created|opened|reported|incident|restart|deploy|error|failed|merged|shipped|decision|retell|recalled|cortex|memory injection|imported|backfill|historical|echo)\b/i;

function hashId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value).digest("hex").slice(0, 24)}`;
}

function normalizeSpace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripLinePrefix(line: string): string {
  return normalizeSpace(
    line
      .replace(/^#{1,6}\s+/, "")
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .replace(/^\[(?:x| )\]\s+/i, "")
  );
}

function truncate(value: string, maxLength: number): string {
  const normalized = normalizeSpace(value);
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function slug(value: string): string {
  return normalizeSpace(value)
    .toLowerCase()
    .replace(/[^a-z0-9#/\- ]+/g, "")
    .split(/\s+/)
    .filter((part) => part.length > 2 && !["the", "and", "for", "with", "from", "that"].includes(part))
    .slice(0, 6)
    .join("-");
}

function topicKeyFor(line: string, kind: ObservedWorkKind): string {
  const pr = /\b(?:pr|pull request)\s*#?(\d{1,6})\b/i.exec(line) ?? /\/pull\/(\d{1,6})\b/i.exec(line);
  if (pr?.[1]) {
    return `pr-${pr[1]}`;
  }
  const path = /\b([\w.-]+\/[\w./-]+\.[a-z0-9]+)\b/i.exec(line);
  if (path?.[1]) {
    return path[1].toLowerCase();
  }
  const fallback = slug(line);
  return fallback || kind;
}

function confidenceBand(confidence: number): "low" | "medium" | "medium-high" | "high" {
  if (confidence >= 0.85) return "high";
  if (confidence >= 0.72) return "medium-high";
  if (confidence >= 0.55) return "medium";
  return "low";
}

function toIso(value: string | null | undefined): string {
  if (!value) {
    return new Date().toISOString();
  }
  const normalized = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function classifyKind(line: string, status: ObservedWorkStatus): ObservedWorkKind {
  if (/\b(blocked|blocker|risk|regression|failing|failed)\b/i.test(line)) return "blocker";
  if (/\b(pr|pull request|review|comment|coderabbit|changes requested)\b/i.test(line)) return "review";
  if (/\b(test|ci|build|suite|vitest|npm test|green|passed)\b/i.test(line)) return "test";
  if (/\b(deploy|release|ship|shipped|launch)\b/i.test(line)) return "deploy";
  if (/\b(decision|decided|agreed|settled|chose)\b/i.test(line)) return "decision";
  if (/\b(question|unclear|ambiguous|unknown)\b/i.test(line)) return "question";
  if (/\b(audit|research|investigate|verify|analysis)\b/i.test(line)) return "research";
  if (/\b(todo|follow[- ]?up|remaining|next)\b/i.test(line)) return "follow_up";
  if (status === "observed_completed") return "implementation";
  return "other";
}

function classifyWork(line: string): WorkCandidate | null {
  const hasCompleted = COMPLETED_RE.test(line);
  const hasUnfinished = UNFINISHED_RE.test(line);
  const hasDecision = DECISION_RE.test(line);
  const hasAmbiguous = AMBIGUOUS_RE.test(line);
  if (!hasCompleted && !hasUnfinished && !hasDecision && !hasAmbiguous) {
    return null;
  }
  let observedStatus: ObservedWorkStatus = "observed_ambiguous";
  if (hasDecision && !hasUnfinished && !hasAmbiguous) {
    observedStatus = "decision_recorded";
  } else if (hasUnfinished) {
    observedStatus = "observed_unfinished";
  } else if (hasCompleted) {
    observedStatus = "observed_completed";
  }
  const kind = classifyKind(line, observedStatus);
  const explicitLabel = /^(completed|done|todo|follow[- ]?up|blocker|decision|ambiguous|question|risk|issue)\s*:/i.test(line);
  const baseConfidence =
    observedStatus === "observed_completed"
      ? 0.78
      : observedStatus === "decision_recorded"
        ? 0.82
        : observedStatus === "observed_unfinished"
          ? 0.72
          : 0.58;
  const confidence = Math.min(0.93, baseConfidence + (explicitLabel ? 0.08 : 0));
  const title = truncate(line, 140);
  return {
    title,
    observedStatus,
    kind,
    confidence,
    confidenceBand: confidenceBand(confidence),
    evidenceKind:
      observedStatus === "observed_completed"
        ? "completed"
        : observedStatus === "observed_ambiguous"
          ? "possible_completion"
          : "created",
    topicKey: topicKeyFor(line, kind),
    rationale: `Deterministic LCM extraction from a leaf summary line: ${truncate(line, 220)}`,
    completed: observedStatus === "observed_completed",
  };
}

function classifyEvent(line: string): EventCandidate | null {
  if (!EVENT_RE.test(line)) {
    return null;
  }
  let eventKind: EventObservationKind = "primary";
  if (/\b(retell|retold|recalled|mentioned again)\b/i.test(line)) eventKind = "retelling";
  else if (/\b(cortex|memory injection|injected memory)\b/i.test(line)) eventKind = "memory_injection";
  else if (/\b(imported|backfill|historical)\b/i.test(line)) eventKind = "imported";
  else if (/\b(echo|dream|reference)\b/i.test(line)) eventKind = "echo";
  else if (/\b(incident|root cause|restart|error|failed|failing|outage|blocked)\b/i.test(line)) eventKind = "operational_incident";
  else if (DECISION_RE.test(line)) eventKind = "decision";
  const confidence =
    eventKind === "primary" || eventKind === "decision"
      ? 0.72
      : eventKind === "operational_incident"
        ? 0.76
        : 0.62;
  return {
    eventKind,
    title: truncate(line, 140),
    queryKey: topicKeyFor(line, eventKind === "decision" ? "decision" : "other"),
    confidence,
    rationale: "Observed event cue from a leaf summary; event time is evidence time, not necessarily original occurrence time.",
  };
}

function extractLines(content: string): string[] {
  const lines = content
    .split(/\r?\n/)
    .map(stripLinePrefix)
    .filter((line) => line.length >= 12 && line.length <= 500);
  if (lines.length > 0) {
    return lines;
  }
  return content
    .split(/(?<=[.!?])\s+/)
    .map(stripLinePrefix)
    .filter((line) => line.length >= 12 && line.length <= 500);
}

export class ObservedWorkExtractor {
  constructor(
    private readonly db: DatabaseSync,
    private readonly observedWorkStore: ObservedWorkStore,
    private readonly eventObservationStore?: EventObservationStore,
  ) {}

  processConversation(
    conversationId: number,
    options?: { limit?: number },
  ): ObservedWorkExtractionResult {
    const state = this.observedWorkStore.getState(conversationId);
    const limit = Math.max(1, Math.min(options?.limit ?? 200, 1000));
    const rows = this.listUnprocessedLeafSummaries(conversationId, state, limit);
    let workItemsUpserted = 0;
    let eventsUpserted = 0;
    for (const row of rows) {
      const observedAt = toIso(row.effective_at ?? row.created_at);
      const createdAt = toIso(row.created_at);
      let ordinal = 0;
      for (const line of extractLines(row.content)) {
        const work = classifyWork(line);
        if (work) {
          const fingerprint = `${conversationId}:${work.kind}:${work.topicKey}:${slug(work.title)}`;
          const workItemId = hashId("ow", fingerprint);
          const existing = this.observedWorkStore.getItem(workItemId);
          const evidenceCount = (existing?.evidenceCount ?? 0) + 1;
          const confidence = Math.min(0.98, Math.max(work.confidence, (existing?.confidence ?? 0) + 0.05));
          this.observedWorkStore.upsertItem({
            workItemId,
            conversationId,
            title: work.title,
            observedStatus: work.observedStatus,
            kind: work.kind,
            confidence,
            confidenceBand: confidenceBand(confidence),
            rationale: work.rationale,
            topicKey: work.topicKey,
            firstSeenAt: existing?.firstSeenAt ?? observedAt,
            lastSeenAt: observedAt,
            completedAt: work.completed ? observedAt : undefined,
            completionConfidence: work.completed ? confidence : undefined,
            evidenceCount,
            sourceMessageCount: row.source_message_count,
            sourceTokenCount: row.source_message_token_count || row.token_count,
            fingerprint,
            fingerprintVersion: 2,
          });
          this.observedWorkStore.addSource({
            workItemId,
            sourceType: "summary",
            sourceId: row.summary_id,
            ordinal,
            evidenceKind: existing ? "reinforced" : work.evidenceKind,
          });
          workItemsUpserted += 1;
        }
        const event = classifyEvent(line);
        if (event && this.eventObservationStore) {
          const eventId = hashId("ev", `${conversationId}:${row.summary_id}:${ordinal}:${event.eventKind}:${event.title}`);
          this.eventObservationStore.upsertObservation({
            eventId,
            conversationId,
            eventKind: event.eventKind,
            title: event.title,
            queryKey: event.queryKey,
            eventTime: observedAt,
            ingestTime: createdAt,
            confidence: event.confidence,
            rationale: event.rationale,
            sourceType: "summary",
            sourceId: row.summary_id,
            sourceIds: [row.summary_id],
          });
          eventsUpserted += 1;
        }
        ordinal += 1;
      }
      this.observedWorkStore.upsertState({
        conversationId,
        lastProcessedSummaryCreatedAt: row.created_at,
        lastProcessedSummaryId: row.summary_id,
        lastProcessedSummaryRowid: row.summary_rowid,
        pendingRebuild: false,
      });
    }
    return {
      summariesScanned: rows.length,
      workItemsUpserted,
      eventsUpserted,
    };
  }

  private listUnprocessedLeafSummaries(
    conversationId: number,
    state: ReturnType<ObservedWorkStore["getState"]>,
    limit: number,
  ): LeafSummaryRow[] {
    const args: Array<string | number> = [conversationId];
    const where = ["s.conversation_id = ?", "s.kind = 'leaf'"];
    const cursorRowid =
      state?.lastProcessedSummaryRowid ??
      (state?.lastProcessedSummaryId
        ? this.lookupSummaryRowid(state.lastProcessedSummaryId)
        : undefined);
    if (cursorRowid != null) {
      where.push("s.rowid > ?");
      args.push(cursorRowid);
    } else if (state?.lastProcessedSummaryCreatedAt) {
      where.push(
        `(julianday(s.created_at) > julianday(?) OR (julianday(s.created_at) = julianday(?) AND s.summary_id > ?))`,
      );
      args.push(
        state.lastProcessedSummaryCreatedAt,
        state.lastProcessedSummaryCreatedAt,
        state.lastProcessedSummaryId ?? "",
      );
    }
    args.push(limit);
    return this.db.prepare(
      `SELECT
         s.rowid AS summary_rowid,
         s.summary_id,
         s.conversation_id,
         s.content,
         s.token_count,
         s.source_message_token_count,
         s.created_at,
         coalesce(s.latest_at, s.earliest_at, s.created_at) AS effective_at,
         (
           SELECT COUNT(*)
           FROM summary_messages sm
           WHERE sm.summary_id = s.summary_id
         ) AS source_message_count
       FROM summaries s
       WHERE ${where.join(" AND ")}
       ORDER BY s.rowid ASC
       LIMIT ?`,
    ).all(...args) as LeafSummaryRow[];
  }

  private lookupSummaryRowid(summaryId: string): number | undefined {
    const row = this.db.prepare(
      `SELECT rowid AS summary_rowid
       FROM summaries
       WHERE summary_id = ?`,
    ).get(summaryId) as { summary_rowid: number } | undefined;
    return row?.summary_rowid;
  }
}
