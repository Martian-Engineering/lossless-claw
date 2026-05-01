#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const SERVER_NAME = "codex-lcm-reader";
const SERVER_VERSION = "0.1.0";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const DEFAULT_SCAN_LIMIT = 5_000;
const MAX_EXPAND_TOKENS = 120_000;

function textResult(text, details = undefined) {
  return {
    content: [{ type: "text", text }],
    ...(details === undefined ? {} : { structuredContent: details }),
  };
}

function jsonTextResult(payload) {
  return textResult(JSON.stringify(payload, null, 2), payload);
}

function clampInt(value, fallback, min, max) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function readString(value, fallback = undefined) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function parseDateParam(value, name) {
  if (value == null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${name} must be an ISO timestamp string.`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid ISO timestamp.`);
  return date.toISOString();
}

function resolveOpenclawStateDir(env = process.env) {
  return env.OPENCLAW_STATE_DIR?.trim() || join(homedir(), ".openclaw");
}

export function resolveDatabasePath(env = process.env) {
  const explicit =
    env.LCM_CODEX_DB_PATH?.trim() ||
    env.LCM_DATABASE_PATH?.trim() ||
    env.LOSSLESS_CLAW_DB_PATH?.trim() ||
    env.OPENCLAW_LCM_DB_PATH?.trim();
  return explicit ? resolve(explicit) : join(resolveOpenclawStateDir(env), "lcm.db");
}

export function openReadOnlyDatabase(dbPath = resolveDatabasePath()) {
  if (!existsSync(dbPath)) {
    throw new Error(
      `LCM database not found at ${dbPath}. Set LCM_CODEX_DB_PATH or LCM_DATABASE_PATH.`,
    );
  }
  const db = new DatabaseSync(dbPath, { readOnly: true });
  db.exec("PRAGMA query_only = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function tableExists(db, tableName) {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(tableName);
  return !!row;
}

function requiredSchema(db) {
  const required = ["conversations", "messages", "summaries", "summary_parents", "summary_messages"];
  const missing = required.filter((name) => !tableExists(db, name));
  if (missing.length > 0) {
    throw new Error(`LCM database is missing required tables: ${missing.join(", ")}`);
  }
}

function sanitizeFts5Query(raw) {
  const parts = [];
  const phraseRegex = /"([^"]+)"/g;
  let match;
  let lastIndex = 0;
  while ((match = phraseRegex.exec(raw)) !== null) {
    const before = raw.slice(lastIndex, match.index);
    for (const token of before.split(/\s+/).filter(Boolean)) {
      parts.push(`"${token.replace(/"/g, "")}"`);
    }
    const phrase = match[1].replace(/"/g, "").trim();
    if (phrase) parts.push(`"${phrase}"`);
    lastIndex = match.index + match[0].length;
  }
  for (const token of raw.slice(lastIndex).split(/\s+/).filter(Boolean)) {
    parts.push(`"${token.replace(/"/g, "")}"`);
  }
  return parts.length > 0 ? parts.join(" ") : '""';
}

function escapeLike(term) {
  return term.replace(/([\\%_])/g, "\\$1");
}

function likeTerms(query) {
  const terms = [];
  const rawTermRe = /"([^"]+)"|(\S+)/g;
  const edge = /^[`'"()[\]{}<>.,:;!?*_+=|\\/-]+|[`'"()[\]{}<>.,:;!?*_+=|\\/-]+$/g;
  for (const match of query.matchAll(rawTermRe)) {
    const normalized = (match[1] ?? match[2] ?? "").trim().replace(edge, "").toLowerCase();
    if (normalized && !terms.includes(normalized)) terms.push(normalized);
  }
  return terms;
}

function createSnippet(content, query, maxLen = 220) {
  const text = String(content ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLen) return text;
  const terms = likeTerms(query);
  const haystack = text.toLowerCase();
  let index = -1;
  for (const term of terms) {
    const found = haystack.indexOf(term);
    if (found >= 0 && (index < 0 || found < index)) index = found;
  }
  if (index < 0) return `${text.slice(0, maxLen - 3).trimEnd()}...`;
  const start = Math.max(0, index - 60);
  const end = Math.min(text.length, start + maxLen);
  return `${start > 0 ? "..." : ""}${text.slice(start, end).trim()}${end < text.length ? "..." : ""}`;
}

function buildScope(params, alias = "") {
  const prefix = alias ? `${alias}.` : "";
  const where = [];
  const args = [];
  if (params.conversationId != null) {
    const id = Number(params.conversationId);
    if (!Number.isInteger(id) || id <= 0) throw new Error("conversationId must be a positive integer.");
    where.push(`${prefix}conversation_id = ?`);
    args.push(id);
  }
  const since = parseDateParam(params.since, "since");
  const before = parseDateParam(params.before, "before");
  if (since && before && new Date(since).getTime() >= new Date(before).getTime()) {
    throw new Error("since must be earlier than before.");
  }
  return { where, args, since, before };
}

function orderBy(sort, createdExpr, rankExpr = "rank") {
  switch (sort) {
    case "relevance":
      return `${rankExpr} ASC, ${createdExpr} DESC`;
    case "hybrid":
      return `(${rankExpr} / (1 + ((julianday('now') - julianday(${createdExpr})) * 24 * 0.001))) ASC, ${createdExpr} DESC`;
    default:
      return `${createdExpr} DESC`;
  }
}

function searchMessages(db, params) {
  const query = readString(params.pattern ?? params.query);
  if (!query) throw new Error("pattern is required.");
  const mode = params.mode === "full_text" ? "full_text" : "regex";
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const sort = params.sort === "relevance" || params.sort === "hybrid" ? params.sort : "recency";
  const scope = buildScope(params, "m");

  if (mode === "full_text" && tableExists(db, "messages_fts")) {
    const where = ["messages_fts MATCH ?", ...scope.where];
    const args = [sanitizeFts5Query(query), ...scope.args];
    if (scope.since) {
      where.push("julianday(m.created_at) >= julianday(?)");
      args.push(scope.since);
    }
    if (scope.before) {
      where.push("julianday(m.created_at) < julianday(?)");
      args.push(scope.before);
    }
    args.push(limit);
    return db
      .prepare(
        `SELECT
           'message:' || m.message_id AS id,
           m.message_id,
           m.conversation_id,
           m.role AS kind,
           snippet(messages_fts, 0, '', '', '...', 32) AS snippet,
           m.created_at,
           rank
         FROM messages_fts
         JOIN messages m ON m.message_id = messages_fts.rowid
         WHERE ${where.join(" AND ")}
         ORDER BY ${orderBy(sort, "m.created_at")}
         LIMIT ?`,
      )
      .all(...args)
      .map((row) => ({ type: "message", ...row }));
  }

  const terms = mode === "full_text" ? likeTerms(query) : [];
  const where = [...scope.where];
  const args = [...scope.args];
  if (scope.since) {
    where.push("julianday(m.created_at) >= julianday(?)");
    args.push(scope.since);
  }
  if (scope.before) {
    where.push("julianday(m.created_at) < julianday(?)");
    args.push(scope.before);
  }
  if (mode === "full_text") {
    for (const term of terms) {
      where.push("LOWER(m.content) LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(term)}%`);
    }
  }
  args.push(clampInt(params.scanLimit, DEFAULT_SCAN_LIMIT, limit, 50_000));
  const rows = db
    .prepare(
      `SELECT
         'message:' || m.message_id AS id,
         m.message_id,
         m.conversation_id,
         m.role AS kind,
         m.content,
         m.created_at
       FROM messages m
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY m.created_at DESC
       LIMIT ?`,
    )
    .all(...args);
  const regex = mode === "regex" ? new RegExp(query, params.caseSensitive === true ? "" : "i") : undefined;
  return rows
    .filter((row) => (regex ? regex.test(String(row.content ?? "")) : true))
    .slice(0, limit)
    .map((row) => ({
      type: "message",
      id: row.id,
      message_id: row.message_id,
      conversation_id: row.conversation_id,
      kind: row.kind,
      snippet: createSnippet(row.content, query),
      created_at: row.created_at,
    }));
}

function searchSummaries(db, params) {
  const query = readString(params.pattern ?? params.query);
  if (!query) throw new Error("pattern is required.");
  const mode = params.mode === "full_text" ? "full_text" : "regex";
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const sort = params.sort === "relevance" || params.sort === "hybrid" ? params.sort : "recency";
  const scope = buildScope(params, "s");
  const timeExpr = "COALESCE(s.latest_at, s.created_at)";

  if (mode === "full_text" && tableExists(db, "summaries_fts")) {
    const where = ["summaries_fts MATCH ?", ...scope.where];
    const args = [sanitizeFts5Query(query), ...scope.args];
    if (scope.since) {
      where.push(`julianday(${timeExpr}) >= julianday(?)`);
      args.push(scope.since);
    }
    if (scope.before) {
      where.push(`julianday(${timeExpr}) < julianday(?)`);
      args.push(scope.before);
    }
    args.push(limit);
    return db
      .prepare(
        `SELECT
           s.summary_id AS id,
           s.summary_id,
           s.conversation_id,
           s.kind,
           snippet(summaries_fts, 1, '', '', '...', 32) AS snippet,
           ${timeExpr} AS created_at,
           rank
         FROM summaries_fts
         JOIN summaries s ON s.summary_id = summaries_fts.summary_id
         WHERE ${where.join(" AND ")}
         ORDER BY ${orderBy(sort, timeExpr)}
         LIMIT ?`,
      )
      .all(...args)
      .map((row) => ({ type: "summary", ...row }));
  }

  const terms = mode === "full_text" ? likeTerms(query) : [];
  const where = [...scope.where];
  const args = [...scope.args];
  if (scope.since) {
    where.push(`julianday(${timeExpr}) >= julianday(?)`);
    args.push(scope.since);
  }
  if (scope.before) {
    where.push(`julianday(${timeExpr}) < julianday(?)`);
    args.push(scope.before);
  }
  if (mode === "full_text") {
    for (const term of terms) {
      where.push("LOWER(s.content) LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(term)}%`);
    }
  }
  args.push(clampInt(params.scanLimit, DEFAULT_SCAN_LIMIT, limit, 50_000));
  const rows = db
    .prepare(
      `SELECT
         s.summary_id AS id,
         s.summary_id,
         s.conversation_id,
         s.kind,
         s.content,
         ${timeExpr} AS created_at
       FROM summaries s
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${timeExpr} DESC
       LIMIT ?`,
    )
    .all(...args);
  const regex = mode === "regex" ? new RegExp(query, params.caseSensitive === true ? "" : "i") : undefined;
  return rows
    .filter((row) => (regex ? regex.test(String(row.content ?? "")) : true))
    .slice(0, limit)
    .map((row) => ({
      type: "summary",
      id: row.id,
      summary_id: row.summary_id,
      conversation_id: row.conversation_id,
      kind: row.kind,
      snippet: createSnippet(row.content, query),
      created_at: row.created_at,
    }));
}

function lcmGrep(db, params) {
  const scope = params.scope === "messages" || params.scope === "summaries" ? params.scope : "both";
  const results = [];
  if (scope === "messages" || scope === "both") results.push(...searchMessages(db, params));
  if (scope === "summaries" || scope === "both") results.push(...searchSummaries(db, params));
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  results.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  return jsonTextResult({
    tool: "lcm_grep",
    databasePath: resolveDatabasePath(),
    mode: params.mode === "full_text" ? "full_text" : "regex",
    scope,
    count: Math.min(results.length, limit),
    results: results.slice(0, limit),
    note: "Codex LCM Reader is read-only and bounded. Expand IDs before treating snippets as proof.",
  });
}

function describeSummary(db, id) {
  const summary = db
    .prepare(
      `SELECT summary_id, conversation_id, kind, depth, content, token_count, file_ids,
              earliest_at, latest_at, descendant_count, descendant_token_count,
              source_message_token_count, model, created_at
       FROM summaries WHERE summary_id = ?`,
    )
    .get(id);
  if (!summary) return undefined;
  const parentIds = db
    .prepare(`SELECT parent_summary_id FROM summary_parents WHERE summary_id = ? ORDER BY ordinal ASC`)
    .all(id)
    .map((row) => row.parent_summary_id);
  const childIds = db
    .prepare(`SELECT summary_id FROM summary_parents WHERE parent_summary_id = ? ORDER BY ordinal ASC`)
    .all(id)
    .map((row) => row.summary_id);
  const messageIds = db
    .prepare(`SELECT message_id FROM summary_messages WHERE summary_id = ? ORDER BY ordinal ASC`)
    .all(id)
    .map((row) => row.message_id);
  return { type: "summary", ...summary, parentIds, childIds, messageIds };
}

function describeFile(db, id) {
  if (!tableExists(db, "large_files")) return undefined;
  const file = db
    .prepare(
      `SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri,
              exploration_summary, created_at
       FROM large_files WHERE file_id = ?`,
    )
    .get(id);
  return file ? { type: "file", ...file } : undefined;
}

function lcmDescribe(db, params) {
  const id = readString(params.id);
  if (!id) throw new Error("id is required.");
  const result = id.startsWith("file_") ? describeFile(db, id) : describeSummary(db, id);
  if (!result) return jsonTextResult({ error: `Not found: ${id}` });
  if (params.conversationId != null && result.conversation_id !== Number(params.conversationId)) {
    return jsonTextResult({ error: `Not found in conversation ${params.conversationId}: ${id}` });
  }
  return jsonTextResult({
    tool: "lcm_describe",
    item: result,
    note: "This is source evidence. Use expand for subtree context.",
  });
}

function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

function truncateTokens(text, maxTokens) {
  const maxChars = Math.max(0, maxTokens * 4);
  const value = String(text ?? "");
  return value.length <= maxChars ? value : `${value.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n...(truncated)`;
}

function expandSummary(db, summaryId, options = {}) {
  const maxDepth = clampInt(options.maxDepth, 4, 0, 24);
  const rows = db
    .prepare(
      `WITH RECURSIVE subtree(summary_id, parent_summary_id, depth_from_root, path) AS (
         SELECT ?, NULL, 0, ''
         UNION ALL
         SELECT sp.summary_id, sp.parent_summary_id, subtree.depth_from_root + 1,
                CASE WHEN subtree.path = '' THEN printf('%04d', sp.ordinal)
                     ELSE subtree.path || '.' || printf('%04d', sp.ordinal)
                END
         FROM summary_parents sp
         JOIN subtree ON sp.parent_summary_id = subtree.summary_id
         WHERE subtree.depth_from_root < ?
       )
       SELECT s.summary_id, s.conversation_id, s.kind, s.depth, s.content, s.token_count,
              s.earliest_at, s.latest_at, s.created_at, subtree.depth_from_root,
              subtree.parent_summary_id, subtree.path
       FROM subtree
       JOIN summaries s ON s.summary_id = subtree.summary_id
       ORDER BY subtree.depth_from_root ASC, subtree.path ASC, s.created_at ASC`,
    )
    .all(summaryId, maxDepth);
  return rows;
}

function lcmExpand(db, params) {
  const rawIds = Array.isArray(params.summaryIds)
    ? params.summaryIds
    : readString(params.summaryId)
      ? [readString(params.summaryId)]
      : [];
  const summaryIds = rawIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim());
  if (summaryIds.length === 0) throw new Error("summaryId or summaryIds is required.");
  const tokenCap = clampInt(params.tokenCap, 24_000, 1_000, MAX_EXPAND_TOKENS);
  const expanded = [];
  let rendered = "";
  for (const id of summaryIds) {
    const rows = expandSummary(db, id, params);
    if (rows.length === 0) {
      expanded.push({ summaryId: id, error: "not found" });
      continue;
    }
    const items = [];
    for (const row of rows) {
      const header = `[${row.summary_id}] ${row.kind} depth=${row.depth} conversation=${row.conversation_id} time=${row.latest_at ?? row.created_at}`;
      const block = `${header}\n${row.content ?? ""}`.trim();
      if (estimateTokens(`${rendered}\n\n${block}`) > tokenCap) {
        items.push({ summaryId: row.summary_id, omitted: true, reason: "tokenCap" });
        continue;
      }
      rendered += `${rendered ? "\n\n" : ""}${block}`;
      items.push(row);
    }
    expanded.push({ summaryId: id, items });
  }
  return jsonTextResult({
    tool: "lcm_expand",
    summaryIds,
    tokenCap,
    text: truncateTokens(rendered, tokenCap),
    expanded,
    note: "Read-only Codex expansion. Use the returned source IDs as evidence anchors.",
  });
}

function lcmExpandQuery(db, params) {
  const prompt = readString(params.prompt, "");
  let summaryIds = Array.isArray(params.summaryIds)
    ? params.summaryIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim())
    : [];
  const query = readString(params.query);
  if (summaryIds.length === 0) {
    if (!query) throw new Error("summaryIds or query is required.");
    const matches = searchSummaries(db, {
      ...params,
      pattern: query,
      mode: params.mode === "regex" ? "regex" : "full_text",
      limit: clampInt(params.seedLimit, 12, 1, 50),
    });
    summaryIds = matches.map((row) => row.summary_id).filter(Boolean);
  }
  if (summaryIds.length === 0) {
    return jsonTextResult({ tool: "lcm_expand_query", prompt, query, summaryIds: [], text: "", note: "No seed summaries matched." });
  }
  const expansion = lcmExpand(db, { ...params, summaryIds });
  const details = expansion.structuredContent;
  return jsonTextResult({
    tool: "lcm_expand_query",
    prompt,
    query,
    summaryIds,
    text: details.text,
    expanded: details.expanded,
    note: "Codex-local adapter: returns expanded evidence for Codex to synthesize. It does not spawn an OpenClaw sub-agent.",
  });
}

const currentTools = [
  {
    name: "lcm_grep",
    description: "Search local LCM messages and summaries. Defaults to bounded all-conversation search because Codex Desktop has no OpenClaw session identity.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string" },
        mode: { type: "string", enum: ["regex", "full_text"], default: "regex" },
        scope: { type: "string", enum: ["messages", "summaries", "both"], default: "both" },
        limit: { type: "number", default: DEFAULT_LIMIT },
        scanLimit: { type: "number", default: DEFAULT_SCAN_LIMIT },
        conversationId: { type: "number" },
        since: { type: "string" },
        before: { type: "string" },
        sort: { type: "string", enum: ["recency", "relevance", "hybrid"], default: "recency" },
      },
      required: ["pattern"],
      additionalProperties: true,
    },
    handler: lcmGrep,
  },
  {
    name: "lcm_describe",
    description: "Describe one LCM summary or file ID from the local database.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        conversationId: { type: "number" },
      },
      required: ["id"],
      additionalProperties: true,
    },
    handler: lcmDescribe,
  },
  {
    name: "lcm_expand",
    description: "Expand one or more known summary IDs into bounded source evidence.",
    inputSchema: {
      type: "object",
      properties: {
        summaryId: { type: "string" },
        summaryIds: { type: "array", items: { type: "string" } },
        maxDepth: { type: "number", default: 4 },
        tokenCap: { type: "number", default: 24000 },
      },
      additionalProperties: true,
    },
    handler: lcmExpand,
  },
  {
    name: "lcm_expand_query",
    description: "Find seed summaries by query or use provided IDs, then return expanded evidence for Codex to synthesize from.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" },
        query: { type: "string" },
        summaryIds: { type: "array", items: { type: "string" } },
        seedLimit: { type: "number", default: 12 },
        tokenCap: { type: "number", default: 24000 },
        conversationId: { type: "number" },
      },
      additionalProperties: true,
    },
    handler: lcmExpandQuery,
  },
];

export function createTools() {
  return currentTools;
}

export async function callTool(name, args, options = {}) {
  const tool = createTools().find((entry) => entry.name === name);
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  const db = options.db ?? openReadOnlyDatabase(options.dbPath);
  const shouldClose = !options.db;
  try {
    requiredSchema(db);
    return await tool.handler(db, args ?? {});
  } finally {
    if (shouldClose) db.close();
  }
}

class McpServer {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  start() {
    process.stdin.on("data", (chunk) => this.onData(chunk));
    process.stdin.on("end", () => process.exit(0));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        return;
      }
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + length;
      if (this.buffer.length < bodyEnd) return;
      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      this.handleMessage(body).catch((error) => {
        this.respond(null, undefined, { code: -32603, message: error.message });
      });
    }
  }

  async handleMessage(body) {
    const message = JSON.parse(body);
    if (message.id == null) return;
    try {
      if (message.method === "initialize") {
        this.respond(message.id, {
          protocolVersion: message.params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      if (message.method === "tools/list") {
        this.respond(message.id, {
          tools: createTools().map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        });
        return;
      }
      if (message.method === "tools/call") {
        const result = await callTool(message.params?.name, message.params?.arguments ?? {});
        this.respond(message.id, result);
        return;
      }
      this.respond(message.id, undefined, { code: -32601, message: `Unknown method: ${message.method}` });
    } catch (error) {
      this.respond(message.id, undefined, {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  respond(id, result, error = undefined) {
    const payload = JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) });
    process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf8")}\r\n\r\n${payload}`);
  }
}

function isEntrypoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  }
}

if (isEntrypoint()) {
  new McpServer().start();
}
