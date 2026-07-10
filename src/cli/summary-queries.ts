import type { DatabaseSync } from "node:sqlite";
import {
  decodeCursor,
  encodeCursor,
  type ConversationSelector,
  type MessageRole,
  type SummaryKind,
  type TimeFilter,
} from "./args.js";
import { CliError, type PaginationMetadata } from "./output.js";

const SUMMARY_COVERAGE_TIME = "COALESCE(s.latest_at, s.created_at)";
const SUMMARY_SELECT = `
  SELECT
    s.summary_id AS summaryId,
    s.conversation_id AS conversationId,
    s.kind,
    s.depth,
    s.content,
    s.token_count AS tokenCount,
    s.earliest_at AS earliestAt,
    s.latest_at AS latestAt,
    ${SUMMARY_COVERAGE_TIME} AS coverageAt,
    s.descendant_count AS descendantCount,
    s.descendant_token_count AS descendantTokenCount,
    s.source_message_token_count AS sourceMessageTokenCount,
    s.created_at AS createdAt,
    s.file_ids AS fileIdsJson,
    s.model,
    (SELECT COUNT(*) FROM summary_parents sp
      JOIN summaries related ON related.summary_id = sp.summary_id
     WHERE sp.parent_summary_id = s.summary_id
       AND related.conversation_id = s.conversation_id) AS parentCount,
    (SELECT COUNT(*) FROM summary_parents sp
      JOIN summaries related ON related.summary_id = sp.parent_summary_id
     WHERE sp.summary_id = s.summary_id
       AND related.conversation_id = s.conversation_id) AS childCount,
    (SELECT COUNT(*) FROM summary_messages sm
      JOIN messages m ON m.message_id = sm.message_id
     WHERE sm.summary_id = s.summary_id
       AND m.conversation_id = s.conversation_id) AS sourceMessageCount
  FROM summaries s`;

export type SummaryListItem = {
  summaryId: string;
  conversationId: number;
  kind: SummaryKind;
  depth: number;
  tokenCount: number;
  earliestAt: string | null;
  latestAt: string | null;
  coverageAt: string;
  descendantCount: number;
  descendantTokenCount: number;
  sourceMessageTokenCount: number;
  createdAt: string;
  fileIds: string[];
  model: string;
  parentCount: number;
  childCount: number;
  sourceMessageCount: number;
  preview: string;
  content?: string;
};

export type SummaryPage = {
  conversationId: number | null;
  items: SummaryListItem[];
  pagination: PaginationMetadata;
};

export type SummarySourceMessage = {
  messageId: number;
  seq: number;
  role: MessageRole;
  tokenCount: number;
  createdAt: string;
  content: string;
};

export type SummaryDetails = {
  summary: SummaryListItem & { content: string };
  parents: Array<SummaryListItem & { content: string }>;
  children: Array<SummaryListItem & { content: string }>;
  sourceMessages: SummarySourceMessage[];
};

type SummaryRow = Omit<SummaryListItem, "fileIds" | "preview" | "content"> & {
  content: string;
  fileIdsJson: string;
};

// Resolve optional summary-list scope without importing the broader query module.
function resolveConversationId(db: DatabaseSync, selector: ConversationSelector): number {
  const row = selector.kind === "conversationId"
    ? db.prepare("SELECT conversation_id AS conversationId FROM conversations WHERE conversation_id = ?")
      .get(selector.value) as { conversationId: number } | undefined
    : db.prepare(`SELECT conversation_id AS conversationId
        FROM conversations WHERE session_key = ?
        ORDER BY active DESC, julianday(created_at) DESC, conversation_id DESC LIMIT 1`)
      .get(selector.value) as { conversationId: number } | undefined;
  if (!row) {
    throw new CliError(
      "CONVERSATION_NOT_FOUND",
      selector.kind === "conversationId"
        ? `No conversation matched id ${selector.value}.`
        : `No conversation matched session key ${selector.value}.`,
      3,
      selector,
    );
  }
  return row.conversationId;
}

// Parse persisted file identifiers while treating malformed legacy values as empty.
function parseFileIds(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

// Produce a bounded one-line summary preview.
function previewSummaryContent(content: string, maximumCharacters = 240): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length <= maximumCharacters
    ? normalized
    : `${normalized.slice(0, maximumCharacters - 1)}…`;
}

// Map a private SQLite row to the public summary representation.
function mapSummaryRow(row: SummaryRow, includeContent: boolean): SummaryListItem {
  return {
    summaryId: row.summaryId,
    conversationId: row.conversationId,
    kind: row.kind,
    depth: row.depth,
    tokenCount: row.tokenCount,
    earliestAt: row.earliestAt,
    latestAt: row.latestAt,
    coverageAt: row.coverageAt,
    descendantCount: row.descendantCount,
    descendantTokenCount: row.descendantTokenCount,
    sourceMessageTokenCount: row.sourceMessageTokenCount,
    createdAt: row.createdAt,
    fileIds: parseFileIds(row.fileIdsJson),
    model: row.model,
    parentCount: row.parentCount,
    childCount: row.childCount,
    sourceMessageCount: row.sourceMessageCount,
    preview: previewSummaryContent(row.content),
    ...(includeContent ? { content: row.content } : {}),
  };
}

/** Return one filtered, keyset-paginated page of summaries. */
export function listSummaries(
  db: DatabaseSync,
  input: {
    selector?: ConversationSelector;
    depth?: number;
    kind?: SummaryKind;
    time: TimeFilter;
    limit: number;
    cursor?: string;
    includeContent: boolean;
  },
): SummaryPage {
  const conversationId = input.selector ? resolveConversationId(db, input.selector) : null;
  const where: string[] = [];
  const args: Array<number | string> = [];

  // Add each optional filter with bound values and an enumerated column expression.
  if (conversationId !== null) {
    where.push("s.conversation_id = ?");
    args.push(conversationId);
  }
  if (input.depth !== undefined) {
    where.push("s.depth = ?");
    args.push(input.depth);
  }
  if (input.kind) {
    where.push("s.kind = ?");
    args.push(input.kind);
  }
  if (input.time.after) {
    where.push(`julianday(${SUMMARY_COVERAGE_TIME}) >= julianday(?)`);
    args.push(input.time.after.toISOString());
  }
  if (input.time.before) {
    where.push(`julianday(${SUMMARY_COVERAGE_TIME}) < julianday(?)`);
    args.push(input.time.before.toISOString());
  }
  if (input.cursor) {
    const cursor = decodeCursor(input.cursor, "summaries");
    if (typeof cursor.id !== "string" || !cursor.id) {
      throw new CliError("INVALID_CURSOR", "Invalid summaries cursor.", 2);
    }
    where.push(`(
      julianday(${SUMMARY_COVERAGE_TIME}) < julianday(?)
      OR (julianday(${SUMMARY_COVERAGE_TIME}) = julianday(?) AND s.summary_id < ?)
    )`);
    args.push(cursor.timestamp, cursor.timestamp, cursor.id);
  }
  args.push(input.limit + 1);

  const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db.prepare(`${SUMMARY_SELECT}
    ${whereClause}
    ORDER BY julianday(${SUMMARY_COVERAGE_TIME}) DESC, s.summary_id DESC
    LIMIT ?`
  ).all(...args) as SummaryRow[];
  const hasMore = rows.length > input.limit;
  const items = (hasMore ? rows.slice(0, input.limit) : rows)
    .map((row) => mapSummaryRow(row, input.includeContent));
  const last = items.at(-1);

  return {
    conversationId,
    items,
    pagination: {
      limit: input.limit,
      returned: items.length,
      hasMore,
      nextCursor: hasMore && last
        ? encodeCursor("summaries", last.coverageAt, last.summaryId)
        : null,
    },
  };
}

// Load one summary row and normalize the not-found error contract.
function getSummaryRow(db: DatabaseSync, summaryId: string): SummaryRow {
  const row = db.prepare(`${SUMMARY_SELECT} WHERE s.summary_id = ?`).get(summaryId) as
    | SummaryRow
    | undefined;
  if (!row) {
    throw new CliError("SUMMARY_NOT_FOUND", `No summary matched id ${summaryId}.`, 3, { summaryId });
  }
  return row;
}

// Load intuitive higher-depth parents that consume the selected summary.
function getSummaryParents(db: DatabaseSync, summary: SummaryRow): SummaryRow[] {
  return db.prepare(`${SUMMARY_SELECT}
    JOIN summary_parents edge ON edge.summary_id = s.summary_id
    WHERE edge.parent_summary_id = ? AND s.conversation_id = ?
    ORDER BY s.depth ASC, s.summary_id ASC`
  ).all(summary.summaryId, summary.conversationId) as SummaryRow[];
}

// Load lower-depth source children in their persisted compaction order.
function getSummaryChildren(db: DatabaseSync, summary: SummaryRow): SummaryRow[] {
  return db.prepare(`${SUMMARY_SELECT}
    JOIN summary_parents edge ON edge.parent_summary_id = s.summary_id
    WHERE edge.summary_id = ? AND s.conversation_id = ?
    ORDER BY edge.ordinal ASC`
  ).all(summary.summaryId, summary.conversationId) as SummaryRow[];
}

// Load direct raw sources and reject malformed cross-conversation links.
function getSummarySourceMessages(db: DatabaseSync, summary: SummaryRow): SummarySourceMessage[] {
  return db.prepare(`SELECT
      m.message_id AS messageId, m.seq, m.role, m.token_count AS tokenCount,
      m.created_at AS createdAt, m.content
    FROM summary_messages sm
    JOIN messages m ON m.message_id = sm.message_id
    WHERE sm.summary_id = ? AND m.conversation_id = ?
    ORDER BY sm.ordinal ASC`
  ).all(summary.summaryId, summary.conversationId) as SummarySourceMessage[];
}

/** Return one full summary with direct DAG relations and ordered raw sources. */
export function getSummaryDetails(db: DatabaseSync, summaryId: string): SummaryDetails {
  const row = getSummaryRow(db, summaryId);
  return {
    summary: mapSummaryRow(row, true) as SummaryListItem & { content: string },
    parents: getSummaryParents(db, row).map(
      (parent) => mapSummaryRow(parent, true) as SummaryListItem & { content: string },
    ),
    children: getSummaryChildren(db, row).map(
      (child) => mapSummaryRow(child, true) as SummaryListItem & { content: string },
    ),
    sourceMessages: getSummarySourceMessages(db, row),
  };
}
