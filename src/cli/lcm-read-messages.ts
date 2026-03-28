import type { DatabaseSync } from "node:sqlite";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_AFTER_SEQ = 0;
const DEFAULT_MAX_CHARS = 4000;

export type MessageRole = "user" | "assistant" | "tool" | "system";

export interface MessageOptions {
  afterSeq: number;
  limit: number;
  maxTokens?: number;
  role?: MessageRole;
  noToolMessages: boolean;
  maxChars: number;
  json: boolean;
}

interface ConversationRow {
  conversation_id: number;
  agent_scope: string | null;
  source_label: string | null;
}

interface MessageRow {
  message_id: number;
  seq: number;
  role: string;
  content: string | null;
  token_count: number | null;
  created_at: string;
}

export interface MessageItem {
  seq: number;
  role: string;
  content: string;
  tokenCount: number;
  createdAt: string;
}

export interface MessagePage {
  conversation: {
    id: number;
    agent: string | null;
    source: string | null;
  };
  messages: MessageItem[];
  tokensReturned: number;
  nextCursor: number | null;
  totalMessages: number;
}

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

export function parseMessagesOptions(argv: string[]): MessageOptions {
  const options: MessageOptions = {
    afterSeq: DEFAULT_AFTER_SEQ,
    limit: DEFAULT_LIMIT,
    noToolMessages: false,
    maxChars: DEFAULT_MAX_CHARS,
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token) {
      continue;
    }

    switch (token) {
      case "--after-seq": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--after-seq requires a value.");
        }
        options.afterSeq = parseNonNegativeInteger(value, "--after-seq");
        index += 1;
        break;
      }
      case "--limit": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--limit requires a value.");
        }
        options.limit = Math.min(parsePositiveInteger(value, "--limit"), MAX_LIMIT);
        index += 1;
        break;
      }
      case "--max-tokens": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--max-tokens requires a value.");
        }
        options.maxTokens = parsePositiveInteger(value, "--max-tokens");
        index += 1;
        break;
      }
      case "--role": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--role requires a value.");
        }
        if (value !== "user" && value !== "assistant" && value !== "tool" && value !== "system") {
          throw new Error('--role must be one of: "user", "assistant", "tool", "system".');
        }
        options.role = value;
        index += 1;
        break;
      }
      case "--no-tool-messages": {
        options.noToolMessages = true;
        break;
      }
      case "--max-chars": {
        const value = argv[index + 1];
        if (!value) {
          throw new Error("--max-chars requires a value.");
        }
        options.maxChars = parsePositiveInteger(value, "--max-chars");
        index += 1;
        break;
      }
      case "--json": {
        options.json = true;
        break;
      }
      default:
        throw new Error(`Unknown messages option: ${token}`);
    }
  }

  return options;
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

function buildMessageWhere(
  options: MessageOptions,
  hasMessagePartsTable: boolean,
): { clause: string; args: Array<string | number> } {
  const where = ["m.conversation_id = ?", "m.seq > ?"];
  const args: Array<string | number> = [];

  if (options.role) {
    where.push("m.role = ?");
    args.push(options.role);
  }

  if (options.noToolMessages) {
    where.push("m.role != 'tool'");
    if (hasMessagePartsTable) {
      where.push(
        "NOT EXISTS (SELECT 1 FROM message_parts mp_tool WHERE mp_tool.message_id = m.message_id AND mp_tool.part_type = 'tool')",
      );
    }
  }

  return { clause: where.join(" AND "), args };
}

function hasMessagePartsTable(db: DatabaseSync): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'message_parts' LIMIT 1")
    .get() as unknown as Record<string, unknown> | undefined;
  return !!row;
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(0, maxChars);
}

function normalizeTokenCount(row: MessageRow): number {
  if (typeof row.token_count === "number" && Number.isFinite(row.token_count) && row.token_count >= 0) {
    return row.token_count;
  }
  return Math.ceil((row.content ?? "").length / 4);
}

export function readConversationMessages(
  db: DatabaseSync,
  conversationId: number,
  options: MessageOptions,
): MessagePage {
  const conversation = db
    .prepare("SELECT conversation_id, agent_scope, source_label FROM conversations WHERE conversation_id = ?")
    .get(conversationId) as unknown as ConversationRow | undefined;

  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  const includeMessageParts = hasMessagePartsTable(db);
  const { clause, args } = buildMessageWhere(options, includeMessageParts);
  const contentExpr = includeMessageParts
    ? `COALESCE(
         (
           SELECT group_concat(part_chunk, '\n')
           FROM (
             SELECT
               CASE
                 WHEN mp.part_type IN ('text', 'reasoning') THEN mp.text_content
                 WHEN mp.part_type = 'tool' THEN COALESCE(
                   mp.tool_output,
                   mp.tool_input,
                   mp.tool_error,
                   mp.text_content
                 )
                 ELSE mp.text_content
               END AS part_chunk
             FROM message_parts mp
             WHERE mp.message_id = m.message_id
             ORDER BY mp.ordinal ASC
           ) part_chunks
           WHERE part_chunk IS NOT NULL AND part_chunk != ''
         ),
         m.content,
         ''
       )`
    : "COALESCE(m.content, '')";

  const allRows = db
    .prepare(
      `SELECT m.message_id, m.seq, m.role, ${contentExpr} AS content, m.token_count, m.created_at
       FROM messages m
       WHERE ${clause}
       ORDER BY m.seq ASC`,
    )
    .all(conversationId, options.afterSeq, ...args) as unknown as MessageRow[];

  const totalCountRow = db
    .prepare(`SELECT COUNT(*) AS total_count FROM messages m WHERE ${clause.replace("m.seq > ?", "1 = 1")}`)
    .get(conversationId, ...args) as unknown as { total_count: number };

  const messages: MessageItem[] = [];
  let tokensReturned = 0;

  for (const row of allRows) {
    if (messages.length >= options.limit) {
      break;
    }

    const tokenCount = normalizeTokenCount(row);
    if (typeof options.maxTokens === "number" && messages.length > 0 && tokensReturned + tokenCount > options.maxTokens) {
      break;
    }

    messages.push({
      seq: row.seq,
      role: row.role,
      content: truncate(row.content ?? "", options.maxChars),
      tokenCount,
      createdAt: toIsoTimestamp(row.created_at),
    });
    tokensReturned += tokenCount;

    if (typeof options.maxTokens === "number" && tokensReturned >= options.maxTokens) {
      break;
    }
  }

  const hasMore = allRows.length > messages.length;
  const nextCursor = hasMore && messages.length > 0 ? messages[messages.length - 1]?.seq ?? null : null;

  return {
    conversation: {
      id: conversation.conversation_id,
      agent: conversation.agent_scope,
      source: conversation.source_label,
    },
    messages,
    tokensReturned,
    nextCursor,
    totalMessages: totalCountRow.total_count,
  };
}

function formatTokenCount(tokenCount: number): string {
  return tokenCount.toLocaleString("en-US");
}

export function formatMessagesOutput(page: MessagePage): string {
  const lines: string[] = [];
  lines.push(
    `Conversation ${page.conversation.id} | ${page.conversation.agent ?? "-"} | ${page.conversation.source ?? "-"}`,
  );

  const firstSeq = page.messages[0]?.seq;
  const lastSeq = page.messages[page.messages.length - 1]?.seq;
  const rangeText =
    typeof firstSeq === "number" && typeof lastSeq === "number" ? `${firstSeq}-${lastSeq}` : "(none returned)";
  const nextHint =
    typeof page.nextCursor === "number"
      ? `--after-seq ${page.nextCursor}`
      : "none";
  lines.push(
    `Messages ${rangeText} of ${page.totalMessages} | Tokens: ${formatTokenCount(page.tokensReturned)} | Next cursor: ${nextHint}`,
  );
  lines.push("");

  for (const message of page.messages) {
    lines.push(`[${message.seq}] ${message.role} (${formatHumanTimestamp(message.createdAt)})`);
    lines.push(message.content);
    lines.push("");
  }

  if (typeof page.nextCursor === "number") {
    lines.push(`--- next: lcm-read messages ${page.conversation.id} --after-seq ${page.nextCursor} ---`);
  } else {
    lines.push("--- next: none ---");
  }

  return lines.join("\n");
}
