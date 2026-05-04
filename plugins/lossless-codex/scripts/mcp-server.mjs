#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const SERVER_NAME = "lossless-codex";
const SERVER_VERSION = "0.1.0";
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const DEFAULT_TIMEZONE = "UTC";
const MAX_SEARCH_TEXT_CHARS = 2_000;
const DEFAULT_DESCRIBE_CHARS = 24_000;
const MAX_DESCRIBE_CHARS = 120_000;

function sha(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function id(prefix, value, length = 16) {
  return `${prefix}_${sha(value).slice(0, length)}`;
}

function textResult(text, structuredContent = undefined) {
  return {
    content: [{ type: "text", text }],
    ...(structuredContent === undefined ? {} : { structuredContent }),
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

function readBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return fallback;
}

function escapeLike(term) {
  return String(term).replace(/([\\%_])/g, "\\$1");
}

function searchTerms(query) {
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
    .slice(0, 8);
}

function likeAllTerms(column, terms) {
  return {
    sql: terms.map(() => `${column} LIKE ? ESCAPE '\\'`).join(" AND "),
    args: terms.map((term) => `%${escapeLike(term)}%`),
  };
}

function truncateChars(text, maxChars) {
  const value = String(text ?? "");
  if (value.length <= maxChars) return { text: value, truncated: false, originalLength: value.length };
  return {
    text: `${value.slice(0, Math.max(0, maxChars - 32)).trimEnd()}\n...(truncated)`,
    truncated: true,
    originalLength: value.length,
  };
}

function boundTextRow(row, field, maxChars = MAX_SEARCH_TEXT_CHARS) {
  const bounded = { ...row };
  const truncated = truncateChars(bounded[field], maxChars);
  bounded[field] = truncated.text;
  bounded[`${field}_truncated`] = truncated.truncated;
  bounded[`${field}_original_length`] = truncated.originalLength;
  return bounded;
}

function normalizeDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error("period must be a YYYY-MM-DD date for this Lossless Codex slice.");
  }
  return value;
}

function normalizeTimezone(value = DEFAULT_TIMEZONE) {
  const timezone = readString(value, DEFAULT_TIMEZONE);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new Error(`Invalid IANA timezone for Lossless Codex: ${timezone}`);
  }
  return timezone;
}

function createDateKeyFormatter(timezone) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function dateKeyInTimeZone(isoTimestamp, timezone, formatter = null) {
  if (timezone === "UTC" || timezone === "Etc/UTC") {
    return typeof isoTimestamp === "string" && isoTimestamp.length >= 10
      ? isoTimestamp.slice(0, 10)
      : null;
  }
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) return null;
  const parts = (formatter ?? createDateKeyFormatter(timezone)).formatToParts(date);
  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  if (!lookup.year || !lookup.month || !lookup.day) return null;
  return `${lookup.year}-${lookup.month}-${lookup.day}`;
}

function isoOrNull(value) {
  if (typeof value !== "string" || value.trim() === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function nowIso() {
  return new Date().toISOString();
}

function resolveCodexHome(env = process.env) {
  return resolve(env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
}

export function resolveSidecarDatabasePath(env = process.env) {
  const explicit = env.LOSSLESS_CODEX_DB_PATH?.trim();
  return explicit ? resolve(explicit) : join(resolveCodexHome(env), "lossless-codex.sqlite");
}

export function resolveSourceDir(env = process.env) {
  return resolve(env.LOSSLESS_CODEX_SOURCE_DIR?.trim() || resolveCodexHome(env));
}

export function resolveStateDbPath(env = process.env) {
  return resolve(env.LOSSLESS_CODEX_STATE_DB_PATH?.trim() || join(resolveSourceDir(env), "state_5.sqlite"));
}

export function resolveLogsDbPath(env = process.env) {
  return resolve(env.LOSSLESS_CODEX_LOGS_DB_PATH?.trim() || join(resolveSourceDir(env), "logs_2.sqlite"));
}

export function openSidecarDatabase(dbPath = resolveSidecarDatabasePath(), options = {}) {
  const readOnly = options.readOnly ?? false;
  if (readOnly && !existsSync(dbPath)) {
    throw new Error(`Lossless Codex sidecar database not found at ${dbPath}. Run lossless_codex_import first.`);
  }
  if (!readOnly) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath, readOnly ? { readOnly: true } : {});
  if (readOnly) {
    db.exec("PRAGMA query_only = ON");
  } else {
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
  }
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

export function runSidecarMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lossless_codex_migration_state (
      step_name TEXT NOT NULL,
      algorithm_version INTEGER NOT NULL,
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (step_name, algorithm_version)
    );

    CREATE TABLE IF NOT EXISTS codex_source_files (
      source_file_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      path TEXT NOT NULL,
      path_hash TEXT NOT NULL,
      device TEXT,
      inode TEXT,
      generation INTEGER NOT NULL DEFAULT 1,
      size INTEGER NOT NULL DEFAULT 0,
      mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_scanned_at TEXT,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'closed', 'rotated', 'missing', 'error')),
      UNIQUE (path, generation)
    );

    CREATE TABLE IF NOT EXISTS codex_projects (
      project_id TEXT PRIMARY KEY,
      project_key TEXT NOT NULL UNIQUE,
      cwd_hash TEXT NOT NULL,
      cwd_display TEXT,
      cwd_display_policy TEXT NOT NULL DEFAULT 'basename',
      git_origin_hash TEXT,
      git_origin_display TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codex_threads (
      thread_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES codex_projects(project_id) ON DELETE CASCADE,
      rollout_path TEXT NOT NULL,
      rollout_source_file_id TEXT REFERENCES codex_source_files(source_file_id),
      title_hash TEXT,
      title_display TEXT,
      title_display_policy TEXT NOT NULL DEFAULT 'basename',
      source TEXT,
      model_provider TEXT,
      model TEXT,
      reasoning_effort TEXT,
      sandbox_policy TEXT,
      approval_mode TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at_ms INTEGER,
      updated_at_ms INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      raw_metadata_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codex_turns (
      turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      turn_seq INTEGER NOT NULL,
      started_at TEXT,
      completed_at TEXT,
      status TEXT NOT NULL DEFAULT 'unknown'
        CHECK (status IN ('running', 'complete', 'interrupted', 'unknown')),
      line_start INTEGER,
      line_end INTEGER,
      current_date TEXT,
      timezone TEXT,
      model TEXT,
      cwd_hash TEXT,
      UNIQUE (thread_id, turn_seq)
    );

    CREATE TABLE IF NOT EXISTS codex_events (
      event_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES codex_turns(turn_id) ON DELETE SET NULL,
      source_file_id TEXT NOT NULL REFERENCES codex_source_files(source_file_id) ON DELETE CASCADE,
      source_line INTEGER NOT NULL,
      source_offset INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT,
      top_type TEXT NOT NULL,
      payload_type TEXT,
      item_type TEXT,
      role TEXT,
      call_id TEXT,
      payload_sha256 TEXT NOT NULL,
      privacy_class TEXT NOT NULL DEFAULT 'metadata',
      raw_ref TEXT NOT NULL,
      raw_payload_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE (source_file_id, source_line, payload_sha256)
    );

    CREATE TABLE IF NOT EXISTS codex_tool_calls (
      call_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES codex_turns(turn_id) ON DELETE SET NULL,
      tool_kind TEXT,
      tool_name TEXT,
      namespace TEXT,
      status TEXT,
      duration_ms INTEGER,
      exit_code INTEGER,
      input_event_id TEXT REFERENCES codex_events(event_id) ON DELETE SET NULL,
      output_event_id TEXT REFERENCES codex_events(event_id) ON DELETE SET NULL,
      arg_ref TEXT,
      output_ref TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codex_touched_files (
      touched_file_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES codex_turns(turn_id) ON DELETE SET NULL,
      call_id TEXT,
      path_hash TEXT NOT NULL,
      path_display TEXT NOT NULL,
      path_display_policy TEXT NOT NULL DEFAULT 'basename',
      source_kind TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 1,
      event_id TEXT REFERENCES codex_events(event_id) ON DELETE SET NULL,
      UNIQUE (thread_id, path_hash, source_kind, event_id)
    );

    CREATE TABLE IF NOT EXISTS codex_observations (
      observation_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES codex_turns(turn_id) ON DELETE SET NULL,
      project_id TEXT NOT NULL REFERENCES codex_projects(project_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN (
        'outcome', 'decision', 'tradeoff', 'architecture_note', 'file_change',
        'test_result', 'blocker', 'follow_up', 'risk'
      )),
      status TEXT NOT NULL DEFAULT 'observed'
        CHECK (status IN ('observed', 'resolved', 'ambiguous', 'dismissed')),
      summary TEXT NOT NULL,
      confidence REAL NOT NULL DEFAULT 0.5,
      rationale TEXT NOT NULL DEFAULT '',
      privacy_class TEXT NOT NULL DEFAULT 'metadata',
      first_event_id TEXT REFERENCES codex_events(event_id) ON DELETE SET NULL,
      last_event_id TEXT REFERENCES codex_events(event_id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      UNIQUE (thread_id, kind, summary)
    );

    CREATE TABLE IF NOT EXISTS codex_log_metadata (
      log_metadata_id TEXT PRIMARY KEY,
      source_file_id TEXT NOT NULL REFERENCES codex_source_files(source_file_id) ON DELETE CASCADE,
      source_row_id INTEGER NOT NULL,
      ts INTEGER,
      ts_nanos INTEGER,
      level TEXT,
      target TEXT,
      module_path TEXT,
      file TEXT,
      line INTEGER,
      thread_id TEXT,
      process_uuid_hash TEXT,
      estimated_bytes INTEGER,
      body_sha256 TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (source_file_id, source_row_id)
    );

    CREATE TABLE IF NOT EXISTS codex_summaries (
      summary_id TEXT PRIMARY KEY,
      thread_id TEXT REFERENCES codex_threads(thread_id) ON DELETE CASCADE,
      project_id TEXT NOT NULL REFERENCES codex_projects(project_id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      content TEXT NOT NULL,
      token_count INTEGER NOT NULL DEFAULT 0,
      source_event_start TEXT,
      source_event_end TEXT,
      earliest_at TEXT,
      latest_at TEXT,
      model TEXT,
      prompt_version TEXT NOT NULL DEFAULT 'deterministic-v1',
      source_hash TEXT NOT NULL,
      privacy_class TEXT NOT NULL DEFAULT 'summary',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codex_summary_events (
      summary_id TEXT NOT NULL REFERENCES codex_summaries(summary_id) ON DELETE CASCADE,
      event_id TEXT NOT NULL REFERENCES codex_events(event_id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, event_id)
    );

    CREATE TABLE IF NOT EXISTS codex_summary_parents (
      summary_id TEXT NOT NULL REFERENCES codex_summaries(summary_id) ON DELETE CASCADE,
      parent_summary_id TEXT NOT NULL REFERENCES codex_summaries(summary_id) ON DELETE RESTRICT,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY (summary_id, parent_summary_id)
    );

    CREATE TABLE IF NOT EXISTS codex_project_day_rollups (
      rollup_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES codex_projects(project_id) ON DELETE CASCADE,
      project_key TEXT NOT NULL,
      period_key TEXT NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      coverage_status TEXT NOT NULL DEFAULT 'complete',
      source_ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (project_key, period_key, timezone)
    );

    CREATE TABLE IF NOT EXISTS codex_import_watermarks (
      source_file_id TEXT PRIMARY KEY REFERENCES codex_source_files(source_file_id) ON DELETE CASCADE,
      last_size INTEGER NOT NULL DEFAULT 0,
      last_mtime_ms INTEGER NOT NULL DEFAULT 0,
      last_offset INTEGER NOT NULL DEFAULT 0,
      last_line INTEGER NOT NULL DEFAULT 0,
      last_event_hash TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS codex_jobs (
      kind TEXT NOT NULL,
      job_key TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
      lease_expires_at TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT,
      last_error TEXT,
      input_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (kind, job_key)
    );

    CREATE TABLE IF NOT EXISTS codex_subagent_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      source_ref TEXT
    );

    CREATE INDEX IF NOT EXISTS codex_events_thread_time_idx
      ON codex_events (thread_id, timestamp, source_line);
    CREATE INDEX IF NOT EXISTS codex_events_time_thread_idx
      ON codex_events (timestamp, thread_id);
    CREATE INDEX IF NOT EXISTS codex_events_source_idx
      ON codex_events (source_file_id);
    CREATE INDEX IF NOT EXISTS codex_observations_project_kind_idx
      ON codex_observations (project_id, kind, status);
    CREATE INDEX IF NOT EXISTS codex_touched_files_path_idx
      ON codex_touched_files (path_hash);
    CREATE INDEX IF NOT EXISTS codex_log_metadata_thread_idx
      ON codex_log_metadata (thread_id, ts);
    CREATE INDEX IF NOT EXISTS codex_log_metadata_source_idx
      ON codex_log_metadata (source_file_id);
    CREATE INDEX IF NOT EXISTS codex_log_metadata_target_idx
      ON codex_log_metadata (target, level, ts);
    CREATE INDEX IF NOT EXISTS codex_project_day_rollups_period_idx
      ON codex_project_day_rollups (period_key, project_key);
  `);

  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS codex_safe_text_fts USING fts5(
        ref_id UNINDEXED,
        content,
        tokenize = 'unicode61'
      );
    `);
  } catch {
    // FTS5 is optional; tools fall back to LIKE queries.
  }
}

function tableExists(db, tableName) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(tableName);
}

function columnExists(db, tableName, columnName) {
  return db.prepare(`PRAGMA table_info(${tableName})`).all().some((row) => row.name === columnName);
}

function normalizeGitOrigin(origin) {
  const raw = readString(origin, "");
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    const parts = parsed.pathname.replace(/^\/+/, "").replace(/\.git$/i, "").split("/").filter(Boolean);
    if (parsed.hostname && parts.length >= 2) {
      return {
        key: `${parsed.hostname}/${parts.at(-2)}/${parts.at(-1)}`.toLowerCase(),
        display: `${parsed.protocol}//${parsed.hostname}/${parts.at(-2)}/${parts.at(-1)}.git`,
      };
    }
  } catch {
    // Fall through to SCP-like git remote parsing.
  }
  const scpLike = /^(?:([^@/:]+)@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(raw);
  if (scpLike) {
    return {
      key: `${scpLike[2]}/${scpLike[3]}/${scpLike[4]}`.toLowerCase(),
      display: `git@${scpLike[2]}:${scpLike[3]}/${scpLike[4]}.git`,
    };
  }
  return null;
}

function projectKeyFromThread(row) {
  const fromOrigin = normalizeGitOrigin(row.git_origin_url)?.key;
  const cwd = String(row.cwd ?? "");
  const fromCwd = cwd.split(/[\\/]/).filter(Boolean).pop();
  const cwdHashSuffix = cwd ? `-${sha(cwd).slice(0, 8)}` : "";
  return (fromOrigin || (fromCwd ? `${fromCwd}${cwdHashSuffix}` : "codex-project")).toLowerCase();
}

function sourceFileId(path, generation = 1) {
  return id("csrc", `${path}:${generation}`);
}

function statFile(path) {
  try {
    const stat = statSync(path);
    return {
      size: stat.size,
      mtimeMs: Math.floor(stat.mtimeMs),
      device: String(stat.dev),
      inode: String(stat.ino),
    };
  } catch {
    return { size: 0, mtimeMs: 0, device: null, inode: null };
  }
}

function purgeEventEvidence(db, eventIds) {
  if (eventIds.length === 0) return;
  const placeholders = eventIds.map(() => "?").join(", ");
  db.prepare(`DELETE FROM codex_tool_calls WHERE input_event_id IN (${placeholders}) OR output_event_id IN (${placeholders})`)
    .run(...eventIds, ...eventIds);
  db.prepare(`DELETE FROM codex_touched_files WHERE event_id IN (${placeholders})`).run(...eventIds);
  db.prepare(`DELETE FROM codex_observations WHERE first_event_id IN (${placeholders}) OR last_event_id IN (${placeholders})`)
    .run(...eventIds, ...eventIds);
  db.prepare(`DELETE FROM codex_summary_events WHERE event_id IN (${placeholders})`).run(...eventIds);
  db.prepare(`DELETE FROM codex_events WHERE event_id IN (${placeholders})`).run(...eventIds);
}

function purgeSourceEvidence(db, sourceId) {
  const eventIds = db
    .prepare("SELECT event_id FROM codex_events WHERE source_file_id = ?")
    .all(sourceId)
    .map((row) => row.event_id);
  purgeEventEvidence(db, eventIds);
}

function safePayload(raw) {
  const payload = raw && typeof raw === "object" ? raw : {};
  const out = {};
  const copySafeScalar = (key) => {
    const value = payload[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (value !== undefined && key === "status") {
      out[key] = "[object_redacted]";
    }
  };
  for (const key of [
    "type",
    "role",
    "call_id",
    "name",
    "status",
    "success",
    "turn_id",
    "started_at",
    "completed_at",
    "exit_code",
    "duration_ms",
  ]) {
    copySafeScalar(key);
  }
  if (payload.changes && typeof payload.changes === "object") {
    out.changed_files = Object.keys(payload.changes);
  }
  return out;
}

function readJsonl(path) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  let lineNo = 0;
  let offset = 0;
  for (const line of text.split(/\n/)) {
    lineNo += 1;
    const startOffset = offset;
    offset += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    try {
      rows.push({ lineNo, offset: startOffset, raw: line, value: JSON.parse(line) });
    } catch {
      rows.push({
        lineNo,
        offset: startOffset,
        raw: line,
        value: { timestamp: null, type: "parse_error", payload: { type: "parse_error" } },
      });
    }
  }
  return rows;
}

function listJsonlFiles(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && path.endsWith(".jsonl")) {
        out.push(path);
      }
    }
  }
  return out.sort();
}

function remapRolloutPath(storedPath, sourceDir) {
  if (!storedPath) return null;
  const normalized = String(storedPath).replace(/\\/g, "/");
  for (const marker of ["/sessions/", "/archived_sessions/"]) {
    const index = normalized.indexOf(marker);
    if (index < 0) continue;
    const candidate = join(sourceDir, normalized.slice(index + 1));
    if (existsSync(candidate)) return candidate;
  }
  if (existsSync(storedPath)) return storedPath;
  return storedPath;
}

function readSessionMeta(rows) {
  for (const row of rows) {
    if (row.value?.type !== "session_meta") continue;
    const payload = row.value.payload && typeof row.value.payload === "object" ? row.value.payload : {};
    return payload;
  }
  return {};
}

function buildSyntheticThreadFromJsonl(path, sourceDir, rows) {
  const meta = readSessionMeta(rows);
  const firstTimestamp = rows.find((row) => isoOrNull(row.value?.timestamp))?.value.timestamp;
  const lastTimestamp = [...rows].reverse().find((row) => isoOrNull(row.value?.timestamp))?.value.timestamp;
  const createdAtMs = firstTimestamp ? new Date(firstTimestamp).getTime() : Date.now();
  const updatedAtMs = lastTimestamp ? new Date(lastTimestamp).getTime() : createdAtMs;
  const threadId = readString(meta.id) ?? id("cthread", path);
  const sourceKind = path.replace(/\\/g, "/").includes("/archived_sessions/")
    ? "archived_jsonl"
    : "session_jsonl";
  return {
    id: threadId,
    rollout_path: path,
    created_at: Math.floor(createdAtMs / 1000),
    updated_at: Math.floor(updatedAtMs / 1000),
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    source: sourceKind,
    model_provider: readString(meta.model_provider) ?? "unknown",
    cwd: readString(meta.cwd) ?? sourceDir,
    title: readString(meta.title) ?? `Codex session ${threadId}`,
    sandbox_policy: readString(meta.sandbox_policy) ?? "unknown",
    approval_mode: readString(meta.approval_mode) ?? "unknown",
    git_branch: readString(meta.git_branch) ?? null,
    git_origin_url: readString(meta.git_origin_url) ?? null,
    model: readString(meta.model) ?? null,
    reasoning_effort: readString(meta.reasoning_effort) ?? null,
    archived: sourceKind === "archived_jsonl" ? 1 : 0,
  };
}

function ensureSourceFile(db, kind, path) {
  const stat = statFile(path);
  const existingRows = db
    .prepare(
      `SELECT source_file_id, generation, size, mtime_ms, inode
       FROM codex_source_files
       WHERE path = ?
       ORDER BY generation DESC
       LIMIT 1`,
    )
    .all(path);
  const latest = existingRows[0];
  const latestWatermark = latest
    ? db.prepare("SELECT last_event_hash FROM codex_import_watermarks WHERE source_file_id = ?").get(latest.source_file_id)
    : null;
  const sameStat =
    latest &&
    Number(latest.size) === Number(stat.size) &&
    Number(latest.mtime_ms) === Number(stat.mtimeMs);
  const replacedSameStat =
    sameStat &&
    (kind === "session_jsonl" || kind === "archived_jsonl") &&
    latestWatermark?.last_event_hash &&
    String(latestWatermark.last_event_hash) !== String(sourceContentHash(path) ?? "");
  const rotated =
    latest &&
    ((typeof latest.size === "number" && stat.size < latest.size) ||
      (latest.inode && stat.inode && latest.inode !== stat.inode) ||
      replacedSameStat);
  if (replacedSameStat) {
    purgeSourceEvidence(db, latest.source_file_id);
    db.prepare("UPDATE codex_source_files SET status = 'rotated' WHERE source_file_id = ?").run(latest.source_file_id);
  }
  const generation = latest ? Number(latest.generation) + (rotated ? 1 : 0) : 1;
  const sourceId = sourceFileId(path, generation);
  db.prepare(
    `INSERT INTO codex_source_files (
      source_file_id, kind, path, path_hash, device, inode, generation, size, mtime_ms,
      last_scanned_at, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(path, generation) DO UPDATE SET
      kind = excluded.kind,
      path_hash = excluded.path_hash,
      device = excluded.device,
      inode = excluded.inode,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      last_scanned_at = excluded.last_scanned_at,
      status = 'active'`,
  ).run(sourceId, kind, path, sha(path), stat.device, stat.inode, generation, stat.size, stat.mtimeMs, nowIso());
  return { sourceId, generation, kind, path, ...stat };
}

function sourceContentHash(path) {
  try {
    return sha(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function sourceWatermarkCurrent(db, source, kind) {
  const row = db
    .prepare(
      `SELECT last_size, last_mtime_ms, last_event_hash
       FROM codex_import_watermarks
       WHERE source_file_id = ?`,
    )
    .get(source.sourceId);
  if (!row) return false;
  if (Number(row.last_size) !== Number(source.size)) return false;
  if (Number(row.last_mtime_ms) !== Number(source.mtimeMs)) return false;
  if (source.kind === "session_jsonl" || source.kind === "archived_jsonl" || kind === "events") {
    return String(row.last_event_hash ?? "") === String(sourceContentHash(source.path) ?? "");
  }
  return true;
}

function sourceHasImportedRows(db, source, kind) {
  const table = kind === "logs" ? "codex_log_metadata" : "codex_events";
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_file_id = ?`)
    .get(source.sourceId);
  return Number(row?.count ?? 0) > 0;
}

function shouldSkipSourceImport(db, source, kind) {
  return Boolean(sourceWatermarkCurrent(db, source, kind) && sourceHasImportedRows(db, source, kind));
}

function markSourceWatermark(db, source, rows = []) {
  const lastRow = rows.length > 0 ? rows[rows.length - 1] : null;
  db.prepare(
    `INSERT INTO codex_import_watermarks (
      source_file_id, last_size, last_mtime_ms, last_offset, last_line, last_event_hash, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_file_id) DO UPDATE SET
      last_size = excluded.last_size,
      last_mtime_ms = excluded.last_mtime_ms,
      last_offset = excluded.last_offset,
      last_line = excluded.last_line,
      last_event_hash = excluded.last_event_hash,
      updated_at = excluded.updated_at`,
  ).run(
    source.sourceId,
    source.size,
    source.mtimeMs,
    lastRow?.offset ?? 0,
    lastRow?.lineNo ?? 0,
    sourceContentHash(source.path) ?? (lastRow?.raw ? sha(lastRow.raw) : null),
    nowIso(),
  );
}

function upsertProject(db, row) {
  const projectKey = projectKeyFromThread(row);
  const projectId = id("cproj", projectKey);
  const cwd = String(row.cwd ?? "");
  const rawOrigin = row.git_origin_url ? String(row.git_origin_url) : null;
  const origin = normalizeGitOrigin(rawOrigin);
  const seen = new Date(Number(row.updated_at_ms ?? row.updated_at ?? Date.now())).toISOString();
  db.prepare(
    `INSERT INTO codex_projects (
      project_id, project_key, cwd_hash, cwd_display, cwd_display_policy,
      git_origin_hash, git_origin_display, created_at, last_seen_at
    ) VALUES (?, ?, ?, ?, 'basename', ?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET
      project_key = excluded.project_key,
      cwd_hash = excluded.cwd_hash,
      cwd_display = excluded.cwd_display,
      git_origin_hash = excluded.git_origin_hash,
      git_origin_display = excluded.git_origin_display,
      last_seen_at = excluded.last_seen_at`,
  ).run(
    projectId,
    projectKey,
    sha(cwd),
    cwd,
    rawOrigin ? sha(rawOrigin) : null,
    origin?.display ?? null,
    seen,
    seen,
  );
  return { projectId, projectKey };
}

function upsertThread(db, row, project, rolloutSourceFileId) {
  const createdAt = new Date(Number(row.created_at_ms ?? row.created_at ?? Date.now())).toISOString();
  const updatedAt = new Date(Number(row.updated_at_ms ?? row.updated_at ?? Date.now())).toISOString();
  const existed = Boolean(db.prepare("SELECT 1 AS present FROM codex_threads WHERE thread_id = ?").get(row.id));
  const result = db.prepare(
    `INSERT INTO codex_threads (
      thread_id, project_id, rollout_path, rollout_source_file_id, title_hash, title_display,
      title_display_policy, source, model_provider, model, reasoning_effort, sandbox_policy,
      approval_mode, archived, created_at_ms, updated_at_ms, git_sha, git_branch, raw_metadata_ref,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'basename', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(thread_id) DO UPDATE SET
      project_id = excluded.project_id,
      rollout_path = excluded.rollout_path,
      rollout_source_file_id = excluded.rollout_source_file_id,
      title_hash = excluded.title_hash,
      title_display = excluded.title_display,
      source = excluded.source,
      model_provider = excluded.model_provider,
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      sandbox_policy = excluded.sandbox_policy,
      approval_mode = excluded.approval_mode,
      archived = excluded.archived,
      updated_at_ms = excluded.updated_at_ms,
      git_sha = excluded.git_sha,
      git_branch = excluded.git_branch,
      raw_metadata_ref = excluded.raw_metadata_ref,
      updated_at = excluded.updated_at`,
  ).run(
    row.id,
    project.projectId,
    row.rollout_path,
    rolloutSourceFileId,
    row.title ? sha(row.title) : null,
    row.title ?? null,
    row.source ?? null,
    row.model_provider ?? null,
    row.model ?? null,
    row.reasoning_effort ?? null,
    row.sandbox_policy ?? null,
    row.approval_mode ?? null,
    Number(row.archived ?? 0),
    row.created_at_ms ?? null,
    row.updated_at_ms ?? null,
    row.git_sha ?? null,
    row.git_branch ?? null,
    `sqlite://state_5.sqlite/table=threads/pk=${row.id}`,
    createdAt,
    updatedAt,
  );
  return !existed && result.changes > 0;
}

function ensureTurn(db, threadId, turnId, seq, patch = {}) {
  db.prepare(
    `INSERT INTO codex_turns (
      turn_id, thread_id, turn_seq, started_at, completed_at, status, line_start, line_end,
      current_date, timezone, model, cwd_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(turn_id) DO UPDATE SET
      completed_at = COALESCE(excluded.completed_at, codex_turns.completed_at),
      status = CASE
        WHEN excluded.status = 'complete' THEN 'complete'
        WHEN codex_turns.status = 'unknown' THEN excluded.status
        ELSE codex_turns.status
      END,
      line_start = COALESCE(codex_turns.line_start, excluded.line_start),
      line_end = COALESCE(excluded.line_end, codex_turns.line_end)`,
  ).run(
    turnId,
    threadId,
    seq,
    patch.startedAt ?? null,
    patch.completedAt ?? null,
    patch.status ?? "unknown",
    patch.lineStart ?? null,
    patch.lineEnd ?? null,
    patch.currentDate ?? null,
    patch.timezone ?? DEFAULT_TIMEZONE,
    patch.model ?? null,
    patch.cwdHash ?? null,
  );
}

function insertEvent(db, threadId, turnId, sourceId, sourcePath, row) {
  const value = row.value;
  const payload = value.payload && typeof value.payload === "object" ? value.payload : {};
  const payloadHash = sha(row.raw);
  const staleEventIds = db
    .prepare(
      `SELECT event_id
       FROM codex_events
       WHERE source_file_id = ?
         AND source_line = ?
         AND payload_sha256 != ?`,
    )
    .all(sourceId, row.lineNo, payloadHash)
    .map((eventRow) => eventRow.event_id);
  purgeEventEvidence(db, staleEventIds);
  const eventId = id("cevt", `${sourceId}:${row.lineNo}:${payloadHash}`);
  const result = db.prepare(
    `INSERT OR IGNORE INTO codex_events (
      event_id, thread_id, turn_id, source_file_id, source_line, source_offset, timestamp,
      top_type, payload_type, item_type, role, call_id, payload_sha256, privacy_class, raw_ref,
      raw_payload_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'metadata', ?, ?)`,
  ).run(
    eventId,
    threadId,
    turnId,
    sourceId,
    row.lineNo,
    row.offset,
    isoOrNull(value.timestamp),
    String(value.type ?? "unknown"),
    payload.type ? String(payload.type) : null,
    payload.item?.type ? String(payload.item.type) : null,
    payload.role ? String(payload.role) : null,
    payload.call_id ? String(payload.call_id) : null,
    payloadHash,
    `jsonl://${sourcePath}#line=${row.lineNo}`,
    JSON.stringify(safePayload(payload)),
  );
  return { eventId, inserted: result.changes > 0, payload };
}

function upsertToolCall(db, threadId, turnId, eventId, payload, rawRef) {
  const providerCallId = payload.call_id;
  if (!providerCallId) return;
  const callId = id("ctool", `${threadId}:${providerCallId}`);
  const payloadType = String(payload.type ?? "");
  const isOutput = payloadType.endsWith("_output") || payloadType.endsWith("_end");
  const toolName = payload.name ? String(payload.name) : null;
  db.prepare(
    `INSERT INTO codex_tool_calls (
      call_id, thread_id, turn_id, tool_kind, tool_name, namespace, status, duration_ms, exit_code,
      input_event_id, output_event_id, arg_ref, output_ref, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(call_id) DO UPDATE SET
      turn_id = COALESCE(excluded.turn_id, codex_tool_calls.turn_id),
      tool_kind = COALESCE(excluded.tool_kind, codex_tool_calls.tool_kind),
      tool_name = COALESCE(excluded.tool_name, codex_tool_calls.tool_name),
      status = COALESCE(excluded.status, codex_tool_calls.status),
      duration_ms = COALESCE(excluded.duration_ms, codex_tool_calls.duration_ms),
      exit_code = COALESCE(excluded.exit_code, codex_tool_calls.exit_code),
      input_event_id = COALESCE(excluded.input_event_id, codex_tool_calls.input_event_id),
      output_event_id = COALESCE(excluded.output_event_id, codex_tool_calls.output_event_id),
      arg_ref = COALESCE(excluded.arg_ref, codex_tool_calls.arg_ref),
      output_ref = COALESCE(excluded.output_ref, codex_tool_calls.output_ref),
      updated_at = excluded.updated_at`,
  ).run(
    callId,
    threadId,
    turnId,
    payloadType || null,
    toolName,
    toolName?.includes(".") ? toolName.split(".")[0] : null,
    payload.status ? String(payload.status) : payload.success === true ? "completed" : null,
    Number.isFinite(Number(payload.duration_ms)) ? Number(payload.duration_ms) : null,
    Number.isFinite(Number(payload.exit_code)) ? Number(payload.exit_code) : null,
    isOutput ? null : eventId,
    isOutput ? eventId : null,
    isOutput ? null : rawRef,
    isOutput ? rawRef : null,
    nowIso(),
  );
}

function relativeDisplayPath(sourceDir, filePath) {
  if (!filePath) return "";
  if (!filePath.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(filePath)) {
    return filePath.replace(/\\/g, "/");
  }
  const rel = relative(sourceDir, filePath);
  return rel && !rel.startsWith("..") ? rel.replace(/\\/g, "/") : filePath.replace(/^.*?([^/\\]+[/\\][^/\\]+)$/, "$1").replace(/\\/g, "/");
}

function insertTouchedFileAndObservation(db, params) {
  const { threadId, turnId, projectId, callId, eventId, sourceDir, filePath, sourceKind } = params;
  const display = relativeDisplayPath(sourceDir, filePath);
  const touchedId = id("ctouch", `${threadId}:${eventId}:${display}:${sourceKind}`);
  db.prepare(
    `INSERT OR IGNORE INTO codex_touched_files (
      touched_file_id, thread_id, turn_id, call_id, path_hash, path_display, path_display_policy,
      source_kind, confidence, event_id
    ) VALUES (?, ?, ?, ?, ?, ?, 'basename', ?, 1, ?)`,
  ).run(touchedId, threadId, turnId, callId ?? null, sha(display), display, sourceKind, eventId);

  const summary = `Updated ${display} from Codex ${sourceKind.replace(/_/g, " ")} evidence.`;
  const observationId = id("cobs", `${threadId}:file_change:${summary}`);
  db.prepare(
    `INSERT OR IGNORE INTO codex_observations (
      observation_id, thread_id, turn_id, project_id, kind, status, summary, confidence,
      rationale, privacy_class, first_event_id, last_event_id, created_at
    ) VALUES (?, ?, ?, ?, 'file_change', 'observed', ?, 0.95, ?, 'metadata', ?, ?, ?)`,
  ).run(
    observationId,
    threadId,
    turnId,
    projectId,
    summary,
    "Patch/apply event reported this file in changed-files metadata.",
    eventId,
    eventId,
    nowIso(),
  );
}

function buildThreadSummary(db, threadId, projectId) {
  const files = db
    .prepare("SELECT path_display FROM codex_touched_files WHERE thread_id = ? ORDER BY path_display LIMIT 20")
    .all(threadId)
    .map((row) => row.path_display);
  const observations = db
    .prepare("SELECT summary FROM codex_observations WHERE thread_id = ? ORDER BY created_at LIMIT 20")
    .all(threadId)
    .map((row) => row.summary);
  if (files.length === 0 && observations.length === 0) return;
  const eventRange = db
    .prepare(
      `SELECT MIN(event_id) AS first_event_id, MAX(event_id) AS last_event_id,
              MIN(timestamp) AS earliest_at, MAX(timestamp) AS latest_at
       FROM codex_events WHERE thread_id = ?`,
    )
    .get(threadId);
  const content = [
    `Codex coding-work summary for thread ${threadId}.`,
    files.length > 0 ? `Files touched: ${files.join(", ")}.` : "",
    observations.length > 0 ? `Observed work: ${observations.join(" ")}` : "",
  ].filter(Boolean).join("\n");
  const summaryId = id("csum", `${threadId}:thread_rollup:${sha(content)}`);
  db.prepare(
    `INSERT INTO codex_summaries (
      summary_id, thread_id, project_id, kind, depth, content, token_count, source_event_start,
      source_event_end, earliest_at, latest_at, model, prompt_version, source_hash, privacy_class, created_at
    ) VALUES (?, ?, ?, 'thread_rollup', 1, ?, ?, ?, ?, ?, ?, 'deterministic', 'deterministic-v1', ?, 'summary', ?)
    ON CONFLICT(summary_id) DO NOTHING`,
  ).run(
    summaryId,
    threadId,
    projectId,
    content,
    Math.ceil(content.length / 4),
    eventRange?.first_event_id ?? null,
    eventRange?.last_event_id ?? null,
    eventRange?.earliest_at ?? null,
    eventRange?.latest_at ?? null,
    sha(content),
    nowIso(),
  );
}

function runImmediateTransaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function rebuildProjectDayRollups(db, timezone = DEFAULT_TIMEZONE) {
  const normalizedTimezone = normalizeTimezone(timezone);
  const dateKeyFormatter =
    normalizedTimezone === "UTC" || normalizedTimezone === "Etc/UTC"
      ? null
      : createDateKeyFormatter(normalizedTimezone);
  db.prepare("DELETE FROM codex_project_day_rollups WHERE timezone = ?").run(normalizedTimezone);
  const groups = new Map();
  const groupFor = (row, timestamp) => {
    const periodKey = dateKeyInTimeZone(timestamp, normalizedTimezone, dateKeyFormatter);
    if (!periodKey) return null;
    const key = `${row.project_id}:${periodKey}`;
    if (!groups.has(key)) {
      groups.set(key, {
        project_id: row.project_id,
        project_key: row.project_key,
        period_key: periodKey,
        threadIds: new Set(),
        fileIds: new Set(),
        observations: {
          decisions: 0,
          tradeoffs: 0,
          architectureNotes: 0,
          openQuestions: 0,
        },
      });
    }
    return groups.get(key);
  };

  const eventRows = db.prepare(
    `SELECT p.project_id, p.project_key, e.thread_id, e.timestamp
     FROM codex_events e
     JOIN codex_threads t ON t.thread_id = e.thread_id
     JOIN codex_projects p ON p.project_id = t.project_id
     WHERE e.timestamp IS NOT NULL`,
  );
  const eventsIterable = typeof eventRows.iterate === "function" ? eventRows.iterate() : eventRows.all();
  for (const row of eventsIterable) {
    const group = groupFor(row, row.timestamp);
    if (group) group.threadIds.add(row.thread_id);
  }

  const touchedRows = db.prepare(
    `SELECT p.project_id, p.project_key, f.touched_file_id, e.timestamp
     FROM codex_touched_files f
     JOIN codex_threads t ON t.thread_id = f.thread_id
     JOIN codex_projects p ON p.project_id = t.project_id
     JOIN codex_events e ON e.event_id = f.event_id
     WHERE e.timestamp IS NOT NULL`,
  );
  const touchedIterable = typeof touchedRows.iterate === "function" ? touchedRows.iterate() : touchedRows.all();
  for (const row of touchedIterable) {
    const group = groupFor(row, row.timestamp);
    if (group) group.fileIds.add(row.touched_file_id);
  }

  const observationRows = db.prepare(
    `SELECT p.project_id, p.project_key, o.kind, e.timestamp
     FROM codex_observations o
     JOIN codex_threads t ON t.thread_id = o.thread_id
     JOIN codex_projects p ON p.project_id = t.project_id
     JOIN codex_events e ON e.event_id = o.first_event_id
     WHERE e.timestamp IS NOT NULL`,
  );
  const observationIterable =
    typeof observationRows.iterate === "function" ? observationRows.iterate() : observationRows.all();
  for (const row of observationIterable) {
    const group = groupFor(row, row.timestamp);
    if (!group) continue;
    if (row.kind === "decision") group.observations.decisions += 1;
    if (row.kind === "tradeoff") group.observations.tradeoffs += 1;
    if (row.kind === "architecture_note") group.observations.architectureNotes += 1;
    if (row.kind === "follow_up") group.observations.openQuestions += 1;
  }

  let rebuilt = 0;
  for (const row of [...groups.values()].sort((a, b) => {
    const periodCmp = String(a.period_key).localeCompare(String(b.period_key));
    if (periodCmp !== 0) return periodCmp;
    return String(a.project_key).localeCompare(String(b.project_key));
  })) {
    const threadIds = [...row.threadIds].sort();
    const threadCount = threadIds.length;
    const filesTouched = row.fileIds.size;
    const threadRefs = threadIds.slice(0, 20).map((threadId) => `lossless-codex://thread/${threadId}`);
    const projectDayRef = `lossless-codex://project-day/${encodeURIComponent(row.project_key)}/${row.period_key}/${encodeURIComponent(normalizedTimezone)}`;
    const payload = {
      projectsWorked: [
        {
          projectKey: row.project_key,
          threadCount,
          summary: `Codex worked on ${row.project_key} across ${threadCount} thread(s).`,
          observations: {
            decisions: row.observations.decisions,
            tradeoffs: row.observations.tradeoffs,
            architectureNotes: row.observations.architectureNotes,
            filesTouched,
            openQuestions: row.observations.openQuestions,
          },
          sidecarRefs: [
            projectDayRef,
            ...threadRefs,
          ],
        },
      ],
    };
    const summary = `Codex worked on ${row.project_key} across ${threadCount} thread(s), touching ${filesTouched} file(s).`;
    const rollupId = id("croll", `${row.project_key}:${row.period_key}:${normalizedTimezone}`);
    db.prepare(
      `INSERT INTO codex_project_day_rollups (
        rollup_id, project_id, project_key, period_key, timezone, summary, payload_json,
        coverage_status, source_ref, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'complete', ?, ?, ?)
      ON CONFLICT(project_key, period_key, timezone) DO UPDATE SET
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        coverage_status = excluded.coverage_status,
        source_ref = excluded.source_ref,
        updated_at = excluded.updated_at`,
    ).run(
      rollupId,
      row.project_id,
      row.project_key,
      row.period_key,
      normalizedTimezone,
      summary,
      JSON.stringify(payload),
      projectDayRef,
      nowIso(),
      nowIso(),
    );
    rebuilt += 1;
  }
  return rebuilt;
}

function importThreadJsonl(db, params) {
  const { thread, source, rows, sourceDir } = params;
  const project = upsertProject(db, thread);
  const insertedThread = upsertThread(db, thread, project, source.sourceId);
  db.prepare("DELETE FROM codex_summaries WHERE thread_id = ? AND prompt_version = 'deterministic-v1'").run(thread.id);
  let importedEvents = 0;
  let turnSeq = 0;
  let currentTurnId = null;
  const fallbackTurnId = `${thread.id}:turn:${turnSeq}`;
  ensureTurn(db, thread.id, fallbackTurnId, turnSeq, {
    status: "unknown",
    timezone: DEFAULT_TIMEZONE,
    cwdHash: sha(String(thread.cwd ?? "")),
    model: thread.model ?? null,
  });
  currentTurnId = fallbackTurnId;
  for (const row of rows) {
    const payload = row.value.payload && typeof row.value.payload === "object" ? row.value.payload : {};
    if (payload.turn_id && String(payload.type ?? "") === "task_started") {
      turnSeq += 1;
      currentTurnId = String(payload.turn_id);
      ensureTurn(db, thread.id, currentTurnId, turnSeq, {
        startedAt: isoOrNull(payload.started_at) ?? isoOrNull(row.value.timestamp),
        status: "running",
        lineStart: row.lineNo,
        timezone: DEFAULT_TIMEZONE,
        cwdHash: sha(String(thread.cwd ?? "")),
        model: thread.model ?? null,
      });
    }
    const event = insertEvent(db, thread.id, currentTurnId, source.sourceId, thread.rollout_path, row);
    if (event.inserted) importedEvents += 1;
    const rawRef = `jsonl://${thread.rollout_path}#line=${row.lineNo}`;
    upsertToolCall(db, thread.id, currentTurnId, event.eventId, payload, rawRef);
    if (payload.type === "patch_apply_end" && payload.changes && typeof payload.changes === "object") {
      for (const filePath of Object.keys(payload.changes)) {
        insertTouchedFileAndObservation(db, {
          threadId: thread.id,
          turnId: currentTurnId,
          projectId: project.projectId,
          callId: payload.call_id ? id("ctool", `${thread.id}:${payload.call_id}`) : null,
          eventId: event.eventId,
          sourceDir,
          filePath,
          sourceKind: "patch_apply",
        });
      }
    }
    if (payload.turn_id && String(payload.type ?? "") === "task_complete") {
      ensureTurn(db, thread.id, String(payload.turn_id), turnSeq, {
        completedAt: isoOrNull(payload.completed_at) ?? isoOrNull(row.value.timestamp),
        status: "complete",
        lineEnd: row.lineNo,
      });
    }
  }
  buildThreadSummary(db, thread.id, project.projectId);
  return { insertedThread, importedEvents };
}

function upsertThreadMetadataOnly(db, thread, source) {
  const project = upsertProject(db, thread);
  return upsertThread(db, thread, project, source.sourceId);
}

function importLogsMetadata(db, logsDbPath) {
  if (!logsDbPath || !existsSync(logsDbPath)) {
    return 0;
  }
  const logsDb = new DatabaseSync(logsDbPath, { readOnly: true });
  let imported = 0;
  try {
    logsDb.exec("PRAGMA query_only = ON");
    if (!tableExists(logsDb, "logs")) {
      return 0;
    }
    const source = ensureSourceFile(db, "logs_db", logsDbPath);
    if (shouldSkipSourceImport(db, source, "logs")) {
      return 0;
    }
    const rows = logsDb.prepare(
      `SELECT id, ts, ts_nanos, level, target, feedback_log_body, module_path, file,
              line, thread_id, process_uuid, estimated_bytes
       FROM logs
       ORDER BY id ASC`,
    );
    const insert = db.prepare(
      `INSERT OR IGNORE INTO codex_log_metadata (
        log_metadata_id, source_file_id, source_row_id, ts, ts_nanos, level, target,
        module_path, file, line, thread_id, process_uuid_hash, estimated_bytes,
        body_sha256, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const iterable = typeof rows.iterate === "function" ? rows.iterate() : rows.all();
    let batchCount = 0;
    let transactionOpen = false;
    const commitBatch = () => {
      if (!transactionOpen) return;
      db.exec("COMMIT");
      transactionOpen = false;
    };
    try {
      for (const row of iterable) {
        if (!transactionOpen) {
          db.exec("BEGIN IMMEDIATE");
          transactionOpen = true;
        }
        const body =
          typeof row.feedback_log_body === "string" && row.feedback_log_body.length > 0
            ? row.feedback_log_body
            : null;
        const result = insert.run(
          id("clog", `${source.sourceId}:${row.id}`),
          source.sourceId,
          row.id,
          row.ts ?? null,
          row.ts_nanos ?? null,
          row.level ?? null,
          row.target ?? null,
          row.module_path ?? null,
          row.file ?? null,
          row.line ?? null,
          row.thread_id ?? null,
          row.process_uuid ? sha(row.process_uuid) : null,
          row.estimated_bytes ?? null,
          body ? sha(body) : null,
          nowIso(),
        );
        imported += result.changes;
        batchCount += 1;
        if (batchCount >= 5000) {
          commitBatch();
          batchCount = 0;
        }
      }
      commitBatch();
    } catch (error) {
      if (transactionOpen) db.exec("ROLLBACK");
      throw error;
    }
    runImmediateTransaction(db, () => {
      markSourceWatermark(db, source);
    });
    return imported;
  } finally {
    logsDb.close();
  }
}

export async function importCodexArtifacts(options) {
  if (!options?.allowWrite) {
    throw new Error("Lossless Codex import requires explicit allowWrite=true.");
  }
  const dbPath = options.dbPath ?? resolveSidecarDatabasePath(options.env);
  const sourceDir = options.sourceDir ?? resolveSourceDir(options.env);
  const stateDbPath = options.stateDbPath ?? resolveStateDbPath(options.env);
  const logsDbPath = options.logsDbPath ?? resolveLogsDbPath({ ...options.env, LOSSLESS_CODEX_SOURCE_DIR: sourceDir });
  const timezone = normalizeTimezone(options.timezone ?? options.env?.LOSSLESS_CODEX_TIMEZONE ?? DEFAULT_TIMEZONE);
  if (!existsSync(stateDbPath)) {
    throw new Error(`Codex state database not found at ${stateDbPath}.`);
  }
  const db = openSidecarDatabase(dbPath, { readOnly: false });
  const stateDb = new DatabaseSync(stateDbPath, { readOnly: true });
  let importedThreads = 0;
  let importedEvents = 0;
  let importedTouchedFiles = 0;
  let importedObservations = 0;
  let importedLogRows = 0;
  let rebuiltRollups = 0;
  try {
    runSidecarMigrations(db);
    const stateSource = ensureSourceFile(db, "state_db", stateDbPath);
    const threads = stateDb.prepare("SELECT * FROM threads ORDER BY updated_at_ms DESC, id DESC").all();
    const tx = db.prepare("SELECT COUNT(*) AS count FROM codex_touched_files");
    const ox = db.prepare("SELECT COUNT(*) AS count FROM codex_observations");
    const touchedBefore = tx.get().count;
    const observationsBefore = ox.get().count;
    const importedRolloutPaths = new Set();
    const stateThreadIds = new Set();
    for (const thread of threads) {
      stateThreadIds.add(String(thread.id));
      const rolloutPath = remapRolloutPath(thread.rollout_path, sourceDir);
      if (!rolloutPath || !existsSync(rolloutPath)) continue;
      importedRolloutPaths.add(rolloutPath);
      const result = runImmediateTransaction(db, () => {
        const source = ensureSourceFile(db, "session_jsonl", rolloutPath);
        if (shouldSkipSourceImport(db, source, "events")) {
          return {
            insertedThread: upsertThreadMetadataOnly(db, { ...thread, rollout_path: rolloutPath }, source),
            importedEvents: 0,
          };
        }
        const rows = readJsonl(rolloutPath);
        const result = importThreadJsonl(db, {
          thread: { ...thread, rollout_path: rolloutPath },
          source,
          rows,
          sourceDir,
        });
        markSourceWatermark(db, source, rows);
        return result;
      });
      if (result.insertedThread) importedThreads += 1;
      importedEvents += result.importedEvents;
    }
    const jsonlFiles = [
      ...listJsonlFiles(join(sourceDir, "sessions")),
      ...listJsonlFiles(join(sourceDir, "archived_sessions")),
    ];
    for (const path of jsonlFiles) {
      if (importedRolloutPaths.has(path)) continue;
      const source = runImmediateTransaction(db, () => ensureSourceFile(db, "session_jsonl", path));
      if (shouldSkipSourceImport(db, source, "events")) continue;
      const rows = readJsonl(path);
      const thread = buildSyntheticThreadFromJsonl(path, sourceDir, rows);
      if (stateThreadIds.has(String(thread.id))) continue;
      const result = runImmediateTransaction(db, () => {
        const activeSource = ensureSourceFile(db, "session_jsonl", path);
        const result = importThreadJsonl(db, {
          thread,
          source: activeSource,
          rows,
          sourceDir,
        });
        markSourceWatermark(db, activeSource, rows);
        return result;
      });
      if (result.insertedThread) importedThreads += 1;
      importedEvents += result.importedEvents;
    }
    importedLogRows = importLogsMetadata(db, logsDbPath);
    runImmediateTransaction(db, () => {
      if (tableExists(stateDb, "thread_spawn_edges")) {
        const edges = stateDb.prepare("SELECT * FROM thread_spawn_edges").all();
        for (const edge of edges) {
          db.prepare(
            `INSERT INTO codex_subagent_edges (
              parent_thread_id, child_thread_id, status, source_kind, source_ref
            ) VALUES (?, ?, ?, 'state_db', ?)
            ON CONFLICT(child_thread_id) DO UPDATE SET
              parent_thread_id = excluded.parent_thread_id,
              status = excluded.status,
              source_kind = excluded.source_kind,
              source_ref = excluded.source_ref`,
          ).run(
            edge.parent_thread_id,
            edge.child_thread_id,
            edge.status,
            `sqlite://${stateDbPath}/table=thread_spawn_edges/pk=${edge.child_thread_id}`,
          );
        }
      }
      rebuiltRollups = rebuildProjectDayRollups(db, timezone);
      db.prepare(
        `INSERT INTO codex_import_watermarks (
          source_file_id, last_size, last_mtime_ms, last_offset, last_line, last_event_hash, updated_at
        ) VALUES (?, ?, ?, 0, 0, NULL, ?)
        ON CONFLICT(source_file_id) DO UPDATE SET
          last_size = excluded.last_size,
          last_mtime_ms = excluded.last_mtime_ms,
          updated_at = excluded.updated_at`,
      ).run(stateSource.sourceId, stateSource.size, stateSource.mtimeMs, nowIso());
    });
    importedTouchedFiles = tx.get().count - touchedBefore;
    importedObservations = ox.get().count - observationsBefore;
    return {
      importedThreads,
      importedEvents,
      importedTouchedFiles,
      importedObservations,
      importedLogRows,
      rebuiltRollups,
      databasePath: dbPath,
    };
  } finally {
    stateDb.close();
    db.close();
  }
}

function getRollups(db, params = {}) {
  const limit = clampInt(params.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const where = [];
  const args = [];
  if (params.projectKey) {
    where.push("project_key = ?");
    args.push(String(params.projectKey));
  }
  if (params.period) {
    where.push("period_key = ?");
    args.push(normalizeDate(String(params.period)));
  }
  if (params.timezone) {
    where.push("timezone = ?");
    args.push(normalizeTimezone(params.timezone));
  }
  const sql = `
    SELECT rollup_id, project_key, period_key, timezone, summary, payload_json,
           coverage_status, source_ref, updated_at
    FROM codex_project_day_rollups
    ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY period_key DESC, project_key ASC, updated_at DESC
    LIMIT ?`;
  const rows = db.prepare(sql).all(...args, params.timezone ? limit : MAX_LIMIT);
  const deduped = [];
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.project_key}:${row.period_key}`;
    if (!params.timezone && seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
    if (deduped.length >= limit) break;
  }
  return deduped.map((row) => ({
    ...row,
    payload: JSON.parse(row.payload_json),
  }));
}

function writeLcmEnrichment(lcmDbPath, rollup, env = process.env) {
  if (!readBool(env.LOSSLESS_CODEX_LCM_ENRICHMENT_ENABLED, false)) {
    return { written: false, reason: "LOSSLESS_CODEX_LCM_ENRICHMENT_ENABLED is not true" };
  }
  if (!lcmDbPath) {
    return { written: false, reason: "lcmDbPath is required" };
  }
  const db = new DatabaseSync(lcmDbPath);
  try {
    db.exec("PRAGMA busy_timeout = 5000");
    ensureLcmTemporalEnrichmentTable(db);
    const enrichmentId = id("lcmenr", `lossless_codex:day:${rollup.period_key}:${rollup.timezone}:${rollup.project_key}`);
    db.prepare(
      `INSERT INTO lcm_temporal_enrichments (
        enrichment_id, source_system, period_kind, period_key, timezone, project_key,
        summary, payload_json, source_ref, coverage_status, created_at, updated_at
      ) VALUES (?, 'lossless_codex', 'day', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_system, period_kind, period_key, timezone, project_key) DO UPDATE SET
        summary = excluded.summary,
        payload_json = excluded.payload_json,
        source_ref = excluded.source_ref,
        coverage_status = excluded.coverage_status,
        updated_at = excluded.updated_at`,
    ).run(
      enrichmentId,
      rollup.period_key,
      rollup.timezone,
      rollup.project_key,
      rollup.summary,
      rollup.payload_json,
      rollup.source_ref,
      rollup.coverage_status,
      nowIso(),
      nowIso(),
    );
    return { written: true, enrichmentId };
  } catch (error) {
    if (String(error?.message ?? error).toLowerCase().includes("database is locked")) {
      return { written: false, reason: "lcm database is busy; try again later" };
    }
    throw error;
  } finally {
    db.close();
  }
}

export function ensureLcmTemporalEnrichmentTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS lcm_temporal_enrichments (
      enrichment_id TEXT PRIMARY KEY,
      source_system TEXT NOT NULL,
      period_kind TEXT NOT NULL CHECK (period_kind IN ('day', 'week', 'month')),
      period_key TEXT NOT NULL,
      timezone TEXT NOT NULL,
      project_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      coverage_status TEXT NOT NULL DEFAULT 'complete',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (source_system, period_kind, period_key, timezone, project_key)
    );
    CREATE INDEX IF NOT EXISTS lcm_temporal_enrichments_period_idx
      ON lcm_temporal_enrichments (period_kind, period_key, timezone);
    CREATE INDEX IF NOT EXISTS lcm_temporal_enrichments_project_period_idx
      ON lcm_temporal_enrichments (project_key, period_kind, period_key, timezone);
  `);
}

function openReadDb(dbPath) {
  return openSidecarDatabase(dbPath, { readOnly: true });
}

function toolStatus(args, options) {
  const dbPath = options.dbPath ?? resolveSidecarDatabasePath(options.env);
  const sourceDir = options.sourceDir ?? resolveSourceDir(options.env);
  const exists = existsSync(dbPath);
  let counts = {};
  if (exists) {
    const db = openSidecarDatabase(dbPath, { readOnly: true });
    try {
      counts = {
        projects: db.prepare("SELECT COUNT(*) AS c FROM codex_projects").get().c,
        threads: db.prepare("SELECT COUNT(*) AS c FROM codex_threads").get().c,
        events: db.prepare("SELECT COUNT(*) AS c FROM codex_events").get().c,
        logMetadata: db.prepare("SELECT COUNT(*) AS c FROM codex_log_metadata").get().c,
        observations: db.prepare("SELECT COUNT(*) AS c FROM codex_observations").get().c,
        rollups: db.prepare("SELECT COUNT(*) AS c FROM codex_project_day_rollups").get().c,
      };
    } finally {
      db.close();
    }
  }
  return jsonTextResult({
    tool: "lossless_codex_status",
    databasePath: dbPath,
    sourceDir,
    exists,
    counts,
    config: {
      enabled: readBool(options.env?.LOSSLESS_CODEX_ENABLED, false),
      indexerEnabled: readBool(options.env?.LOSSLESS_CODEX_INDEXER_ENABLED, false),
      readOnly: readBool(options.env?.LOSSLESS_CODEX_READ_ONLY, true),
      summaryProvider: options.env?.LOSSLESS_CODEX_SUMMARY_PROVIDER?.trim() || null,
      summaryModel: options.env?.LOSSLESS_CODEX_SUMMARY_MODEL?.trim() || null,
      timezone: normalizeTimezone(options.env?.LOSSLESS_CODEX_TIMEZONE ?? DEFAULT_TIMEZONE),
      summaryMaxConcurrency: clampInt(
        options.env?.LOSSLESS_CODEX_SUMMARY_MAX_CONCURRENCY,
        1,
        1,
        4,
      ),
      lcmEnrichmentEnabled: readBool(
        options.env?.LOSSLESS_CODEX_LCM_ENRICHMENT_ENABLED,
        false,
      ),
    },
    privacy: {
      includeMessageText: false,
      includeToolOutputs: false,
      includeLogBodies: false,
    },
  });
}

async function toolImport(args, options) {
  const env = options.env ?? process.env;
  const explicitAllowWrite = options.allowWrite === true || readBool(args.allowWrite, false);
  const envIndexerEnabled = readBool(env.LOSSLESS_CODEX_INDEXER_ENABLED, false);
  const readOnlyMode = readBool(env.LOSSLESS_CODEX_READ_ONLY, true);
  const allowWrite =
    explicitAllowWrite || (envIndexerEnabled && !readOnlyMode);
  if (!allowWrite) {
    return jsonTextResult({
      tool: "lossless_codex_import",
      imported: false,
      reason:
        "Import is disabled. Pass allowWrite=true, or set LOSSLESS_CODEX_INDEXER_ENABLED=true and LOSSLESS_CODEX_READ_ONLY=false.",
    });
  }
  const result = await importCodexArtifacts({
    dbPath: options.dbPath ?? args.dbPath ?? resolveSidecarDatabasePath(env),
    sourceDir: options.sourceDir ?? args.sourceDir ?? resolveSourceDir(env),
    stateDbPath: options.stateDbPath ?? args.stateDbPath ?? resolveStateDbPath(env),
    logsDbPath: options.logsDbPath ?? args.logsDbPath,
    timezone: args.timezone ?? env.LOSSLESS_CODEX_TIMEZONE,
    allowWrite: true,
    env,
  });
  return jsonTextResult({ tool: "lossless_codex_import", imported: true, ...result });
}

function toolSearch(args, options) {
  const db = openReadDb(options.dbPath ?? resolveSidecarDatabasePath(options.env));
  try {
    const query = readString(args.query ?? args.pattern, "");
    if (!query) throw new Error("query is required.");
    const limit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const terms = searchTerms(query);
    if (terms.length === 0) throw new Error("query is required.");
    const fileWhere = likeAllTerms("LOWER(path_display)", terms);
    const observationWhere = likeAllTerms("LOWER(summary)", terms);
    const summaryWhere = likeAllTerms("LOWER(content)", terms);
    const includeSummaries = readBool(args.includeSummaries, false);
    const primaryRows = db.prepare(
      `SELECT 'file' AS type, touched_file_id AS id, path_display AS text, confidence,
              'lossless-codex://file/' || touched_file_id AS ref,
              1 AS rank
       FROM codex_touched_files
       WHERE ${fileWhere.sql}
       UNION ALL
       SELECT 'observation' AS type, observation_id AS id, summary AS text, confidence,
              'lossless-codex://observation/' || observation_id AS ref,
              2 AS rank
       FROM codex_observations
       WHERE kind != 'file_change'
         AND ${observationWhere.sql}
       ORDER BY rank ASC, confidence DESC, text ASC
       LIMIT ?`,
    ).all(...fileWhere.args, ...observationWhere.args, limit);
    const summaryRows =
      includeSummaries || primaryRows.length === 0
        ? db
            .prepare(
              `SELECT 'summary' AS type, summary_id AS id, content AS text, 1.0 AS confidence,
                      'lossless-codex://summary/' || summary_id AS ref,
                      3 AS rank
               FROM codex_summaries
               WHERE ${summaryWhere.sql}
               ORDER BY created_at DESC
               LIMIT ?`,
            )
            .all(...summaryWhere.args, Math.max(0, limit - primaryRows.length))
        : [];
    const rows = [...primaryRows, ...summaryRows]
      .slice(0, limit)
      .map(({ rank: _rank, ...row }) => boundTextRow(row, "text"));
    return jsonTextResult({
      tool: "lossless_codex_search",
      query,
      count: rows.length,
      results: rows,
      note: "Results are sidecar memory cues; use describe/source refs for proof.",
    });
  } finally {
    db.close();
  }
}

function toolRecent(args, options) {
  const db = openReadDb(options.dbPath ?? resolveSidecarDatabasePath(options.env));
  try {
    const period = args.period ? normalizeDate(String(args.period)) : undefined;
    const timezone = args.timezone ?? options.env?.LOSSLESS_CODEX_TIMEZONE;
    const rollups = getRollups(db, { period, projectKey: args.projectKey, timezone, limit: args.limit });
    return jsonTextResult({
      tool: "lossless_codex_recent",
      period: period ?? "latest",
      count: rollups.length,
      rollups,
      coverage: rollups.length > 0 ? "complete" : "missing",
    });
  } finally {
    db.close();
  }
}

function toolDescribe(args, options) {
  const db = openReadDb(options.dbPath ?? resolveSidecarDatabasePath(options.env));
  try {
    const rawId = readString(args.id, "");
    if (!rawId) throw new Error("id is required.");
    const parts = rawId.startsWith("lossless-codex://")
      ? rawId.slice("lossless-codex://".length).split("/")
      : ["thread", rawId];
    const [kind, ...valueParts] = parts;
    const decodedParts = valueParts.map((part) => decodeURIComponent(part));
    const value = decodedParts.join("/");
    const maxChars = clampInt(args.maxChars, DEFAULT_DESCRIBE_CHARS, 1_000, MAX_DESCRIBE_CHARS);
    const detailLimit = clampInt(args.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    if (kind === "thread") {
      const thread = db.prepare(
        `SELECT t.*, p.project_key
         FROM codex_threads t
         JOIN codex_projects p ON p.project_id = t.project_id
         WHERE t.thread_id = ?`,
      ).get(value);
      if (!thread) throw new Error(`No Lossless Codex thread found for ${value}`);
      const files = db
        .prepare("SELECT * FROM codex_touched_files WHERE thread_id = ? ORDER BY path_display LIMIT ?")
        .all(value, detailLimit);
      const observations = db
        .prepare("SELECT * FROM codex_observations WHERE thread_id = ? ORDER BY created_at LIMIT ?")
        .all(value, detailLimit)
        .map((row) => boundTextRow(row, "summary", maxChars));
      const summaries = db
        .prepare("SELECT summary_id, kind, content FROM codex_summaries WHERE thread_id = ? LIMIT ?")
        .all(value, detailLimit)
        .map((row) => boundTextRow(row, "content", maxChars));
      const counts = db
        .prepare(
          `SELECT
             (SELECT COUNT(*) FROM codex_touched_files WHERE thread_id = ?) AS files,
             (SELECT COUNT(*) FROM codex_observations WHERE thread_id = ?) AS observations,
             (SELECT COUNT(*) FROM codex_summaries WHERE thread_id = ?) AS summaries`,
        )
        .get(value, value, value);
      return jsonTextResult({
        tool: "lossless_codex_describe",
        type: "thread",
        thread,
        files,
        observations,
        summaries,
        limits: {
          detailLimit,
          filesOmitted: Math.max(0, Number(counts.files ?? 0) - files.length),
          observationsOmitted: Math.max(0, Number(counts.observations ?? 0) - observations.length),
          summariesOmitted: Math.max(0, Number(counts.summaries ?? 0) - summaries.length),
        },
        sidecarRefs: [
          `lossless-codex://thread/${value}`,
          ...summaries.map((summary) => `lossless-codex://summary/${summary.summary_id}`),
        ],
      });
    }
    if (kind === "summary") {
      const summary = db.prepare("SELECT * FROM codex_summaries WHERE summary_id = ?").get(value);
      if (!summary) throw new Error(`No Lossless Codex summary found for ${value}`);
      return jsonTextResult({
        tool: "lossless_codex_describe",
        type: "summary",
        summary: boundTextRow(summary, "content", maxChars),
      });
    }
    if (kind === "observation") {
      const observation = db.prepare("SELECT * FROM codex_observations WHERE observation_id = ?").get(value);
      if (!observation) throw new Error(`No Lossless Codex observation found for ${value}`);
      return jsonTextResult({ tool: "lossless_codex_describe", type: "observation", observation });
    }
    if (kind === "file") {
      const file = db.prepare(
        `SELECT f.*, t.title_display, p.project_key
         FROM codex_touched_files f
         JOIN codex_threads t ON t.thread_id = f.thread_id
         JOIN codex_projects p ON p.project_id = t.project_id
         WHERE f.touched_file_id = ?`,
      ).get(value);
      if (!file) throw new Error(`No Lossless Codex touched file found for ${value}`);
      const observations = db.prepare(
        `SELECT observation_id, kind, status, summary, confidence, first_event_id, last_event_id
         FROM codex_observations
         WHERE thread_id = ?
           AND first_event_id = ?
         ORDER BY created_at`,
      ).all(file.thread_id, file.event_id);
      return jsonTextResult({
        tool: "lossless_codex_describe",
        type: "file",
        file,
        observations,
        sidecarRefs: [
          `lossless-codex://file/${value}`,
          `lossless-codex://thread/${file.thread_id}`,
          ...observations.map((observation) => `lossless-codex://observation/${observation.observation_id}`),
        ],
      });
    }
    if (kind === "project-day") {
      const timezone = decodedParts.length >= 3 ? decodedParts.at(-1) : undefined;
      const periodKey = decodedParts.length >= 3 ? decodedParts.at(-2) : decodedParts.at(-1);
      const projectKey = decodedParts.length >= 3
        ? decodedParts.slice(0, -2).join("/")
        : decodedParts.slice(0, -1).join("/");
      if (!projectKey || !periodKey) throw new Error(`Invalid project-day ref: ${rawId}`);
      const where = ["project_key = ?", "period_key = ?"];
      const queryArgs = [projectKey, periodKey];
      if (timezone) {
        where.push("timezone = ?");
        queryArgs.push(normalizeTimezone(timezone));
      }
      const rollup = db
        .prepare(
          `SELECT rollup_id, project_key, period_key, timezone, summary, payload_json,
                  coverage_status, source_ref, updated_at
           FROM codex_project_day_rollups
           WHERE ${where.join(" AND ")}
           ORDER BY updated_at DESC
           LIMIT 1`,
        )
        .get(...queryArgs);
      if (!rollup) throw new Error(`No Lossless Codex project-day rollup found for ${projectKey}/${periodKey}`);
      return jsonTextResult({
        tool: "lossless_codex_describe",
        type: "project-day",
        rollup: {
          ...rollup,
          payload: JSON.parse(rollup.payload_json),
        },
      });
    }
    throw new Error(`Unsupported Lossless Codex describe id: ${rawId}`);
  } finally {
    db.close();
  }
}

function toolWorklog(args, options) {
  const db = openReadDb(options.dbPath ?? resolveSidecarDatabasePath(options.env));
  try {
    const period = args.period ? normalizeDate(String(args.period)) : undefined;
    const timezone = args.timezone ?? options.env?.LOSSLESS_CODEX_TIMEZONE;
    const rollups = getRollups(db, { period, projectKey: args.projectKey, timezone, limit: args.limit });
    const projectsWorked = rollups.flatMap((rollup) => rollup.payload.projectsWorked ?? []);
    let lcmEnrichment = { written: false, reason: "not requested" };
    if (readBool(args.writeLcmEnrichment, false) && rollups[0]) {
      if (!period || !args.projectKey || rollups.length !== 1) {
        lcmEnrichment = {
          written: false,
          reason: "LCM enrichment requires a single projectKey and period match.",
        };
      } else {
        lcmEnrichment = writeLcmEnrichment(options.lcmDbPath ?? args.lcmDbPath, rollups[0], options.env ?? process.env);
      }
    }
    return jsonTextResult({
      tool: "lossless_codex_worklog",
      period: period ?? "latest",
      projectsWorked,
      rollups,
      lcmEnrichment,
    });
  } finally {
    db.close();
  }
}

export function createTools() {
  const stringProp = (description) => ({ type: "string", description });
  const boolProp = (description) => ({ type: "boolean", description });
  const intProp = (description) => ({ type: "integer", description });
  return [
    {
      name: "lossless_codex_status",
      description: "Inspect Lossless Codex sidecar status.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: { dbPath: stringProp("Optional sidecar DB path override.") },
      },
    },
    {
      name: "lossless_codex_import",
      description: "Import local Codex coding-work evidence into the sidecar.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          allowWrite: boolProp("Explicitly allow sidecar import writes."),
          dbPath: stringProp("Optional sidecar DB path override."),
          sourceDir: stringProp("Optional Codex home/source directory."),
          stateDbPath: stringProp("Optional state_5.sqlite path."),
          logsDbPath: stringProp("Optional logs_2.sqlite path."),
          timezone: stringProp("Timezone used for project/day rollups."),
        },
      },
    },
    {
      name: "lossless_codex_search",
      description: "Search Lossless Codex coding-work memory.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: stringProp("Search query."),
          pattern: stringProp("Alias for query."),
          includeSummaries: boolProp("Include deterministic summaries when primary evidence also matches."),
          limit: intProp("Maximum result count, capped by the plugin."),
        },
      },
    },
    {
      name: "lossless_codex_recent",
      description: "Read recent Codex work rollups.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: stringProp("Date period key, for example YYYY-MM-DD."),
          projectKey: stringProp("Canonical project key such as github.com/org/repo."),
          timezone: stringProp("Rollup timezone."),
          limit: intProp("Maximum rollup count, capped by the plugin."),
        },
      },
    },
    {
      name: "lossless_codex_describe",
      description: "Describe sidecar threads, summaries, observations, files, or project-day refs.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["id"],
        properties: {
          id: stringProp("Sidecar ref or raw thread id."),
          maxChars: intProp("Maximum characters per summary text field."),
          limit: intProp("Maximum repeated files/observations/summaries for thread describe."),
        },
      },
    },
    {
      name: "lossless_codex_worklog",
      description: "Return project/day Codex worklogs and optional LCM enrichment.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          period: stringProp("Date period key, for example YYYY-MM-DD."),
          projectKey: stringProp("Canonical project key such as github.com/org/repo."),
          timezone: stringProp("Rollup timezone."),
          limit: intProp("Maximum rollup count, capped by the plugin."),
          writeLcmEnrichment: boolProp("Opt in to writing one compact LCM enrichment row."),
          lcmDbPath: stringProp("Optional LCM DB path for enrichment writes."),
        },
      },
    },
  ];
}

export async function callTool(name, args = {}, options = {}) {
  switch (name) {
    case "lossless_codex_status":
      return toolStatus(args, options);
    case "lossless_codex_import":
      return toolImport(args, options);
    case "lossless_codex_search":
      return toolSearch(args, options);
    case "lossless_codex_recent":
      return toolRecent(args, options);
    case "lossless_codex_describe":
      return toolDescribe(args, options);
    case "lossless_codex_worklog":
      return toolWorklog(args, options);
    default:
      throw new Error(`Unknown Lossless Codex tool: ${name}`);
  }
}

function encodeMessage(payload) {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function decodeMessages(buffer) {
  const messages = [];
  let rest = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf8");
  while (rest.length > 0) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = rest.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    messages.push(JSON.parse(rest.subarray(bodyStart, bodyEnd).toString("utf8")));
    rest = rest.subarray(bodyEnd);
  }
  return messages;
}

function extractMessagesFromBuffer(buffer) {
  const messages = [];
  let rest = buffer;
  while (rest.length > 0) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = rest.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    messages.push(JSON.parse(rest.subarray(bodyStart, bodyEnd).toString("utf8")));
    rest = rest.subarray(bodyEnd);
  }
  return { messages, rest };
}

async function handleMcpMessage(message) {
  const id = message.id;
  if (id == null) return undefined;
  try {
    if (message.method === "initialize") {
      return { jsonrpc: "2.0", id, result: { protocolVersion: "2024-11-05", serverInfo: { name: SERVER_NAME, version: SERVER_VERSION }, capabilities: { tools: {} } } };
    }
    if (message.method === "tools/list") {
      return { jsonrpc: "2.0", id, result: { tools: createTools() } };
    }
    if (message.method === "tools/call") {
      const result = await callTool(message.params?.name, message.params?.arguments ?? {});
      return { jsonrpc: "2.0", id, result };
    }
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${message.method}` } };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function main() {
  let buffer = Buffer.alloc(0);
  let queue = Promise.resolve();
  const processBuffer = async () => {
    const decoded = extractMessagesFromBuffer(buffer);
    buffer = decoded.rest;
    for (const message of decoded.messages) {
      const response = await handleMcpMessage(message);
      if (response) process.stdout.write(encodeMessage(response));
    }
  };
  process.stdin.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    queue = queue.then(processBuffer).catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    });
  });
  process.stdin.resume();
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
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
