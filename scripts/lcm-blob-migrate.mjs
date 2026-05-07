#!/usr/bin/env node
/**
 * v4.2 §B blob-migrate (Option C) — externalize large tool-result payloads
 * to the v4.1 `large_files` storage model.
 *
 * For each `role='tool'` row whose `messages.content` exceeds the byte
 * threshold:
 *   1. Write the content to a file under `--storage-dir` (default
 *      $HOME/.openclaw/lcm-files) with a fresh `file_xxx` id.
 *   2. INSERT a row into `large_files`.
 *   3. Set `messages.large_content = '<file_xxx>'` (stores fileId, not content).
 *
 * `messages.content` is NEVER modified. The assembler's stub-emit path
 * reads the fileId from `large_content`, looks up `large_files` for
 * byteSize/toolName, and substitutes the standard `[LCM Tool Output:
 * file_xxx | tool=… | N bytes]` reference. Drilldown via the existing
 * `lcm_describe(id="file_xxx")` path (no schema changes to that tool).
 *
 * USAGE:
 *   node scripts/lcm-blob-migrate.mjs --db <path> [--dry-run]
 *     [--threshold-bytes N]  default 8000  (~2k tokens)
 *     [--storage-dir PATH]   default $HOME/.openclaw/lcm-files
 *     [--limit N] [--verbose]
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const getArg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined;
};
const hasFlag = (n) => args.includes(`--${n}`);

const dbPath = getArg("db");
const dryRun = hasFlag("dry-run");
const thresholdBytes = Number(getArg("threshold-bytes") ?? 8000);
const storageDir = getArg("storage-dir") ?? join(homedir(), ".openclaw", "lcm-files");
const limit = getArg("limit") ? Number(getArg("limit")) : undefined;
const verbose = hasFlag("verbose");

if (!dbPath) {
  console.error("Usage: lcm-blob-migrate.mjs --db <path> [--dry-run] [--threshold-bytes N] [--storage-dir PATH] [--limit N] [--verbose]");
  process.exit(1);
}
if (!existsSync(dbPath)) { console.error(`DB not found: ${dbPath}`); process.exit(1); }
if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) {
  console.error(`--threshold-bytes must be a positive integer; got ${thresholdBytes}`);
  process.exit(1);
}

const log = (msg) => { if (verbose) console.error(`[blob-migrate] ${msg}`); };

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA busy_timeout = 30000");

const cols = db.prepare(`PRAGMA table_info(messages)`).all();
if (!cols.some((c) => c.name === "large_content")) {
  console.error("messages.large_content column missing — run runLcmMigrations against this DB first.");
  process.exit(1);
}
const filesCols = db.prepare(`PRAGMA table_info(large_files)`).all();
if (filesCols.length === 0) {
  console.error("large_files table missing — run runLcmMigrations against this DB first.");
  process.exit(1);
}

const candidatesSql = `
  SELECT m.message_id, m.conversation_id, length(m.content) AS bytes, m.content,
         (SELECT mp.tool_name FROM message_parts mp
            WHERE mp.message_id = m.message_id AND mp.tool_name IS NOT NULL LIMIT 1) AS tool_name
  FROM messages m
  WHERE m.role = 'tool' AND m.large_content IS NULL AND length(m.content) > ?
  ORDER BY bytes DESC ${limit ? "LIMIT ?" : ""}
`;
const candidatesStmt = db.prepare(candidatesSql);
const candidates = limit ? candidatesStmt.all(thresholdBytes, limit) : candidatesStmt.all(thresholdBytes);
log(`candidates: ${candidates.length}`);

const totalBytes = candidates.reduce((s, r) => s + r.bytes, 0);
const summary = {
  db: dbPath, thresholdBytes, storageDir,
  candidateCount: candidates.length, totalCandidateBytes: totalBytes,
  meanBytes: candidates.length > 0 ? Math.round(totalBytes / candidates.length) : 0,
  largestBytes: candidates[0]?.bytes ?? 0,
  dryRun, applied: 0, filesWritten: 0, errors: [],
};

if (dryRun) { console.log(JSON.stringify(summary, null, 2)); db.close(); process.exit(0); }
if (!existsSync(storageDir)) { mkdirSync(storageDir, { recursive: true }); log(`created storage dir ${storageDir}`); }

const CHUNK = 200;
const insertFileStmt = db.prepare(
  `INSERT INTO large_files (file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary)
   VALUES (?, ?, ?, ?, ?, ?, NULL)`,
);
const updateMsgStmt = db.prepare(`UPDATE messages SET large_content = ? WHERE message_id = ?`);

let done = 0;
try {
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    db.exec("BEGIN");
    for (const row of chunk) {
      const fileId = `file_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
      const fileName = `tool-output-${row.message_id}.txt`;
      const storageUri = join(storageDir, `${fileId}.txt`);
      writeFileSync(storageUri, row.content);
      insertFileStmt.run(fileId, row.conversation_id, fileName, "text/plain", row.bytes, storageUri);
      updateMsgStmt.run(fileId, row.message_id);
      summary.filesWritten += 1;
    }
    db.exec("COMMIT");
    done += chunk.length;
    log(`chunk ${i / CHUNK + 1}: applied ${done}/${candidates.length}`);
  }
  summary.applied = done;
} catch (err) {
  try { db.exec("ROLLBACK"); } catch { /* noop */ }
  summary.errors.push(String(err?.stack ?? err));
  console.error(JSON.stringify(summary, null, 2));
  db.close();
  process.exit(2);
}

try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
console.log(JSON.stringify(summary, null, 2));
db.close();
process.exit(0);
