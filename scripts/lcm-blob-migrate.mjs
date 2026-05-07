#!/usr/bin/env node
/**
 * v4.2 §B blob-migrate — populate `messages.large_content` for existing
 * tool-result rows whose payload exceeds the bytewise threshold.
 *
 * Strategy: COPY content -> large_content. Leaves messages.content
 * untouched, so all v4.1 readers (FTS, regex grep, lcm_describe,
 * lcm_grep, transcript reconcile) keep working without schema
 * awareness. The assembler's stub-emit path activates only when
 * stubLargeToolPayloads=true is enabled in config — so this migration
 * is reversible (UPDATE messages SET large_content = NULL WHERE …)
 * and decoupled from the runtime feature flag.
 *
 * USAGE:
 *   node scripts/lcm-blob-migrate.mjs --db <path> [--dry-run]
 *     [--threshold-bytes N]   default 8000   (~2k tokens)
 *     [--limit N]             cap rows visited
 *
 * EXIT CODES:
 *   0 — migration complete (or dry-run finished cleanly)
 *   1 — usage / setup error
 *   2 — DB write failed
 */

import { existsSync } from "node:fs";
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
const limit = getArg("limit") ? Number(getArg("limit")) : undefined;
const verbose = hasFlag("verbose");

if (!dbPath) {
  console.error(
    "Usage: lcm-blob-migrate.mjs --db <path> [--dry-run] [--threshold-bytes N] [--limit N] [--verbose]",
  );
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}
if (!Number.isFinite(thresholdBytes) || thresholdBytes <= 0) {
  console.error(`--threshold-bytes must be a positive integer; got ${thresholdBytes}`);
  process.exit(1);
}

const log = (msg) => { if (verbose) console.error(`[blob-migrate] ${msg}`); };

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

// Confirm the column exists (v4.2 migration must have run).
const cols = db.prepare(`PRAGMA table_info(messages)`).all();
const hasLargeContent = cols.some((c) => c.name === "large_content");
if (!hasLargeContent) {
  console.error(
    "messages.large_content column missing — run runLcmMigrations against this DB first.",
  );
  process.exit(1);
}

// Selection rule: tool messages whose content is bigger than the threshold,
// AND whose large_content is still NULL (idempotent re-runs are no-ops).
const candidatesQuery = limit
  ? `SELECT message_id, length(content) AS bytes
     FROM messages
     WHERE role = 'tool'
       AND large_content IS NULL
       AND length(content) > ?
     ORDER BY bytes DESC
     LIMIT ?`
  : `SELECT message_id, length(content) AS bytes
     FROM messages
     WHERE role = 'tool'
       AND large_content IS NULL
       AND length(content) > ?
     ORDER BY bytes DESC`;
const candidatesStmt = db.prepare(candidatesQuery);
const candidates = limit
  ? candidatesStmt.all(thresholdBytes, limit)
  : candidatesStmt.all(thresholdBytes);

log(`candidates: ${candidates.length}`);

const totalBytes = candidates.reduce((sum, row) => sum + row.bytes, 0);
const summary = {
  db: dbPath,
  thresholdBytes,
  candidateCount: candidates.length,
  totalCandidateBytes: totalBytes,
  meanBytes: candidates.length > 0 ? Math.round(totalBytes / candidates.length) : 0,
  largestBytes: candidates[0]?.bytes ?? 0,
  dryRun,
  applied: 0,
  errors: [],
};

if (dryRun) {
  console.log(JSON.stringify(summary, null, 2));
  db.close();
  process.exit(0);
}

// Apply: copy content -> large_content. Single statement, no per-row
// JS round-trip. Bound by the same predicate as the SELECT above so we
// only touch rows still eligible.
const updateSql = limit
  ? `UPDATE messages
     SET large_content = content
     WHERE message_id IN (
       SELECT message_id FROM messages
       WHERE role = 'tool'
         AND large_content IS NULL
         AND length(content) > ?
       ORDER BY length(content) DESC
       LIMIT ?
     )`
  : `UPDATE messages
     SET large_content = content
     WHERE role = 'tool'
       AND large_content IS NULL
       AND length(content) > ?`;

try {
  db.exec("BEGIN");
  const stmt = db.prepare(updateSql);
  const result = limit ? stmt.run(thresholdBytes, limit) : stmt.run(thresholdBytes);
  db.exec("COMMIT");
  summary.applied = Number(result.changes ?? 0);
} catch (err) {
  try { db.exec("ROLLBACK"); } catch { /* noop */ }
  summary.errors.push(String(err?.stack ?? err));
  console.error(JSON.stringify(summary, null, 2));
  db.close();
  process.exit(2);
}

console.log(JSON.stringify(summary, null, 2));
db.close();
process.exit(0);
