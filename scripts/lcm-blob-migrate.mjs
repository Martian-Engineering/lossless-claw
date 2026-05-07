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

// Pull the tool_call_id off this row's parts so we can JOIN back to the
// preceding assistant tool_use and lift its `tool_input` into the
// large_files row's `exploration_summary`. Option F: gives the agent
// a disambiguator it can match to a user's natural-language reference
// ("the ripgrep against openclaw-ui-source", "the read of foo.json",
// etc.) without seeing the assistant tool_use block.
const candidatesSql = `
  SELECT m.message_id, m.conversation_id, length(m.content) AS bytes, m.content,
         (SELECT mp.tool_name FROM message_parts mp
            WHERE mp.message_id = m.message_id AND mp.tool_name IS NOT NULL LIMIT 1) AS tool_name,
         (SELECT mp.tool_call_id FROM message_parts mp
            WHERE mp.message_id = m.message_id AND mp.tool_call_id IS NOT NULL LIMIT 1) AS tool_call_id
  FROM messages m
  WHERE m.role = 'tool' AND m.large_content IS NULL AND length(m.content) > ?
  ORDER BY bytes DESC ${limit ? "LIMIT ?" : ""}
`;
// JOIN: given a tool_call_id, find the assistant tool_use that produced
// it and return the tool_input. Same tool_call_id appears on both sides
// of the pairing; we want the row with tool_input set.
const inputLookupStmt = db.prepare(
  `SELECT tool_input FROM message_parts WHERE tool_call_id = ? AND tool_input IS NOT NULL LIMIT 1`,
);

/**
 * Render a one-line disambiguator from a JSON tool_input. The agent only
 * needs enough to match a user reference like "the bash command from
 * earlier" or "your read of foo.json"; full input is in lcm_describe.
 */
function renderToolInputDisambiguator(rawInput, toolName) {
  if (typeof rawInput !== "string" || rawInput.length === 0) return null;
  let inp;
  try { inp = JSON.parse(rawInput); } catch { return null; }
  if (!inp || typeof inp !== "object") return null;
  const oneLine = (s, n = 200) =>
    String(s).split(/\r?\n/)[0].slice(0, n) + (String(s).length > n ? " …" : "");
  if (typeof inp.path === "string") return `Tool: ${toolName} | Path: ${inp.path}`;
  if (typeof inp.command === "string") return `Tool: ${toolName} | Command: ${oneLine(inp.command, 240)}`;
  if (typeof inp.pattern === "string") {
    const scope = inp.path ? ` | Path: ${inp.path}` : "";
    return `Tool: ${toolName} | Pattern: ${oneLine(inp.pattern, 160)}${scope}`;
  }
  if (typeof inp.sessionId === "string") {
    return `Tool: ${toolName} | Action: ${inp.action ?? "(unknown)"} | Session: ${inp.sessionId}`;
  }
  if (typeof inp.url === "string") return `Tool: ${toolName} | URL: ${inp.url}`;
  // Fallback: dump the keys + first value as a hint.
  const keys = Object.keys(inp).slice(0, 4).join(",");
  return `Tool: ${toolName} | Input keys: ${keys}`;
}
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
   VALUES (?, ?, ?, ?, ?, ?, ?)`,
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
      // Option F: lift tool_input into exploration_summary so the
      // assembler's [LCM Tool Output: …] reference carries an
      // agent-recognizable disambiguator.
      let inputSummary = null;
      if (row.tool_call_id) {
        const inpRow = inputLookupStmt.get(row.tool_call_id);
        if (inpRow?.tool_input) {
          inputSummary = renderToolInputDisambiguator(inpRow.tool_input, row.tool_name ?? "tool");
        }
      }
      insertFileStmt.run(fileId, row.conversation_id, fileName, "text/plain", row.bytes, storageUri, inputSummary);
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
