import { homedir } from "node:os";
import { resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type ListSortField = "latest" | "earliest" | "messages";

export interface ListOptions {
  dbPath: string;
  agent?: string;
  provider?: string;
  since?: string;
  before?: string;
  minMessages: number;
  sort: ListSortField;
  limit: number;
  offset: number;
  json: boolean;
}

export interface ConversationListItem {
  conversationId: number;
  agentScope: string | null;
  sessionKey: string | null;
  provider: string | null;
  sourceLabel: string | null;
  messageCount: number;
  earliestAt: string;
  latestAt: string;
}

interface ConversationListRow {
  conversation_id: number;
  agent_scope: string | null;
  session_key: string | null;
  provider: string | null;
  source_label: string | null;
  message_count: number;
  earliest_at: string;
  latest_at: string;
}

interface CountRow {
  total_count: number;
}

const DEFAULT_DB_PATH = "~/.openclaw/lcm.db";
const DEFAULT_LIMIT = 50;
const DEFAULT_OFFSET = 0;
const DEFAULT_MIN_MESSAGES = 1;
const DEFAULT_SORT: ListSortField = "latest";

function parseNonNegativeInteger(value: string, flagName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`${flagName} must be a non-negative integer.`);
  }
  return parsed;
}

function parsePositiveInteger(value: string, flagName: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer.`);
  }
  return parsed;
}

function parseIsoTimestamp(value: string, flagName: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${flagName} must be a valid ISO timestamp.`);
  }
  return parsed.toISOString();
}

export function resolveDbPath(inputPath?: string): string {
  const raw = (inputPath ?? DEFAULT_DB_PATH).trim();
  if (raw === "") {
    return resolve(homedir(), ".openclaw", "lcm.db");
  }
  if (raw === "~") {
    return homedir();
  }
  if (raw.startsWith("~/")) {
    return resolve(homedir(), raw.slice(2));
  }
  return resolve(raw);
}

export function parseListOptions(argv: string[]): ListOptions {
  const options: ListOptions = {
    dbPath: resolveDbPath(DEFAULT_DB_PATH),
    minMessages: DEFAULT_MIN_MESSAGES,
    sort: DEFAULT_SORT,
    limit: DEFAULT_LIMIT,
    offset: DEFAULT_OFFSET,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    switch (token) {
      case "--db": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--db requires a value.");
        }
        options.dbPath = resolveDbPath(value);
        index += 1;
        break;
      }
      case "--agent": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--agent requires a value.");
        }
        options.agent = value;
        index += 1;
        break;
      }
      case "--provider": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--provider requires a value.");
        }
        options.provider = value;
        index += 1;
        break;
      }
      case "--since": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--since requires a value.");
        }
        options.since = parseIsoTimestamp(value, "--since");
        index += 1;
        break;
      }
      case "--before": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--before requires a value.");
        }
        options.before = parseIsoTimestamp(value, "--before");
        index += 1;
        break;
      }
      case "--min-messages": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--min-messages requires a value.");
        }
        const minMessages = parsePositiveInteger(value, "--min-messages");
        options.minMessages = minMessages;
        index += 1;
        break;
      }
      case "--sort": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--sort requires a value.");
        }
        if (value !== "latest" && value !== "earliest" && value !== "messages") {
          throw new Error('--sort must be one of: "latest", "earliest", "messages".');
        }
        options.sort = value;
        index += 1;
        break;
      }
      case "--limit": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--limit requires a value.");
        }
        options.limit = parsePositiveInteger(value, "--limit");
        index += 1;
        break;
      }
      case "--offset": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--offset requires a value.");
        }
        options.offset = parseNonNegativeInteger(value, "--offset");
        index += 1;
        break;
      }
      case "--json": {
        options.json = true;
        break;
      }
      default:
        throw new Error(`Unknown list option: ${token}`);
    }
  }

  if (options.since && options.before && options.since >= options.before) {
    throw new Error("--since must be earlier than --before.");
  }

  return options;
}

function getOrderClause(sort: ListSortField): string {
  switch (sort) {
    case "latest":
      return "ORDER BY latest_at DESC, c.conversation_id ASC";
    case "earliest":
      return "ORDER BY earliest_at ASC, c.conversation_id ASC";
    case "messages":
      return "ORDER BY message_count DESC, latest_at DESC, c.conversation_id ASC";
  }
}

function toIsoTimestamp(rawTimestamp: string): string {
  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return rawTimestamp;
  }
  return parsed.toISOString();
}

function formatHumanTimestamp(rawTimestamp: string): string {
  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return rawTimestamp;
  }
  const yyyy = parsed.getUTCFullYear();
  const mm = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(parsed.getUTCDate()).padStart(2, "0");
  const hh = String(parsed.getUTCHours()).padStart(2, "0");
  const min = String(parsed.getUTCMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${hh}:${min}Z`;
}

function mapConversationRow(row: ConversationListRow): ConversationListItem {
  return {
    conversationId: row.conversation_id,
    agentScope: row.agent_scope,
    sessionKey: row.session_key,
    provider: row.provider,
    sourceLabel: row.source_label,
    messageCount: row.message_count,
    earliestAt: toIsoTimestamp(row.earliest_at),
    latestAt: toIsoTimestamp(row.latest_at),
  };
}

function buildWhereAndHaving(options: ListOptions): {
  whereClause: string;
  whereArgs: Array<string | number>;
  havingClause: string;
  havingArgs: Array<string | number>;
} {
  const where: string[] = [];
  const whereArgs: Array<string | number> = [];
  const having: string[] = ["COUNT(m.message_id) >= ?"];
  const havingArgs: Array<string | number> = [options.minMessages];

  if (options.agent) {
    where.push("c.agent_scope = ?");
    whereArgs.push(options.agent);
  }

  if (options.provider) {
    where.push("c.provider = ?");
    whereArgs.push(options.provider);
  }

  if (options.since) {
    having.push("MAX(julianday(m.created_at)) >= julianday(?)");
    havingArgs.push(options.since);
  }

  if (options.before) {
    having.push("MIN(julianday(m.created_at)) < julianday(?)");
    havingArgs.push(options.before);
  }

  return {
    whereClause: where.length > 0 ? `WHERE ${where.join(" AND ")}` : "",
    whereArgs,
    havingClause: `HAVING ${having.join(" AND ")}`,
    havingArgs,
  };
}

export function listConversations(
  db: DatabaseSync,
  options: ListOptions,
): { conversations: ConversationListItem[]; totalCount: number } {
  const { whereClause, whereArgs, havingClause, havingArgs } = buildWhereAndHaving(options);
  const orderClause = getOrderClause(options.sort);

  const baseQuery = `
    FROM conversations c
    INNER JOIN messages m ON m.conversation_id = c.conversation_id
    ${whereClause}
    GROUP BY c.conversation_id
    ${havingClause}
  `;

  const rows = db
    .prepare(
      `SELECT
         c.conversation_id,
         c.agent_scope,
         c.session_key,
         c.provider,
         c.source_label,
         COUNT(m.message_id) AS message_count,
         MIN(m.created_at) AS earliest_at,
         MAX(m.created_at) AS latest_at
       ${baseQuery}
       ${orderClause}
       LIMIT ? OFFSET ?`,
    )
    .all(...whereArgs, ...havingArgs, options.limit, options.offset) as unknown as ConversationListRow[];

  const total = db
    .prepare(`SELECT COUNT(*) AS total_count FROM (SELECT c.conversation_id ${baseQuery}) q`)
    .get(...whereArgs, ...havingArgs) as unknown as CountRow;

  return {
    conversations: rows.map(mapConversationRow),
    totalCount: total.total_count,
  };
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

export function formatListTable(result: {
  conversations: ConversationListItem[];
  totalCount: number;
}): string {
  const rows = result.conversations;
  const header = `Conversations (showing ${rows.length} of ${result.totalCount})`;

  const idWidth = Math.max(2, ...rows.map((row) => String(row.conversationId).length));
  const agentWidth = Math.max(5, ...rows.map((row) => (row.agentScope ?? "-").length));
  const sourceWidth = Math.max(6, ...rows.map((row) => (row.sourceLabel ?? "-").length));
  const messagesWidth = Math.max(8, ...rows.map((row) => String(row.messageCount).length));
  const firstWidth = Math.max(5, ...rows.map((row) => formatHumanTimestamp(row.earliestAt).length));
  const lastWidth = Math.max(4, ...rows.map((row) => formatHumanTimestamp(row.latestAt).length));

  const lines: string[] = [header, "", "  ID  Agent  Source  Messages  First  Last"];
  lines[2] =
    `  ${pad("ID", idWidth)}  ${pad("Agent", agentWidth)}  ${pad("Source", sourceWidth)}  ${pad("Messages", messagesWidth)}  ${pad("First", firstWidth)}  ${pad("Last", lastWidth)}`;

  for (const row of rows) {
    lines.push(
      `  ${pad(String(row.conversationId), idWidth)}  ${pad(row.agentScope ?? "-", agentWidth)}  ${pad(row.sourceLabel ?? "-", sourceWidth)}  ${pad(String(row.messageCount), messagesWidth)}  ${pad(formatHumanTimestamp(row.earliestAt), firstWidth)}  ${pad(formatHumanTimestamp(row.latestAt), lastWidth)}`,
    );
  }

  return lines.join("\n");
}
