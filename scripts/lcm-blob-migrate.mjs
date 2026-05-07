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

import { existsSync, mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

// Wave-2 P3: tell the operator early if Node is too old for node:sqlite.
const [nodeMajor] = process.versions.node.split(".").map(Number);
if (!Number.isFinite(nodeMajor) || nodeMajor < 22) {
  console.error(
    `node:sqlite requires Node ≥ 22.5.0; got ${process.versions.node}. ` +
    `Update Node before running this migration.`,
  );
  process.exit(1);
}

const args = process.argv.slice(2);
const getArg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined;
};
const hasFlag = (n) => args.includes(`--${n}`);

const dbPath = getArg("db");
const dryRun = hasFlag("dry-run");
const revert = hasFlag("revert");
const thresholdBytes = Number(getArg("threshold-bytes") ?? 8000);
const storageDir = getArg("storage-dir") ?? join(homedir(), ".openclaw", "lcm-files");
const limit = getArg("limit") ? Number(getArg("limit")) : undefined;
const verbose = hasFlag("verbose");

if (!dbPath) {
  console.error(
    "Usage: lcm-blob-migrate.mjs --db <path> [--dry-run | --revert] [--threshold-bytes N] [--storage-dir PATH] [--limit N] [--verbose]\n" +
    "  --revert: undo a previous migration. UPDATE messages SET large_content = NULL\n" +
    "            for migration-marked rows, DELETE matching large_files rows, and\n" +
    "            unlink the on-disk files. Reversible — re-run migration to restore.",
  );
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
// Wave-2 P1: use length(CAST(content AS BLOB)) for true byte counts.
// SQLite's length() on TEXT returns characters, not bytes — UTF-8 multi-byte
// content (CJK, emoji, etc.) was undercounted. The threshold and the
// `byte_size` we persist into large_files now both reflect on-disk bytes.
const candidatesSql = `
  SELECT m.message_id, m.conversation_id, length(CAST(m.content AS BLOB)) AS bytes, m.content,
         (SELECT mp.tool_name FROM message_parts mp
            WHERE mp.message_id = m.message_id AND mp.tool_name IS NOT NULL LIMIT 1) AS tool_name,
         (SELECT mp.tool_call_id FROM message_parts mp
            WHERE mp.message_id = m.message_id AND mp.tool_call_id IS NOT NULL LIMIT 1) AS tool_call_id
  FROM messages m
  WHERE m.role = 'tool' AND m.large_content IS NULL AND length(CAST(m.content AS BLOB)) > ?
  ORDER BY bytes DESC ${limit ? "LIMIT ?" : ""}
`;
// JOIN: given a tool_call_id, find the assistant tool_use that produced
// it and return the tool_input. Same tool_call_id appears on both sides
// of the pairing; we want the row with tool_input set.
const inputLookupStmt = db.prepare(
  `SELECT tool_input FROM message_parts WHERE tool_call_id = ? AND tool_input IS NOT NULL LIMIT 1`,
);

/**
 * Wave-2 P0-C fix: redact common credential patterns before persisting
 * the disambiguator into `large_files.exploration_summary`. These will
 * appear in EVERY assemble — the original ephemeral nature of tool
 * outputs (where commands could be evicted under budget pressure) is
 * lost when promoted into a stub summary. Redact aggressively.
 */
function redactCredentials(s) {
  if (typeof s !== "string") return s;
  return s
    // SSH/identity-file flag pointing at a secret path
    .replace(/(-i\s+)\S*secret\S*/gi, "$1<REDACTED:identity-file>")
    .replace(/(-i\s+)\S*\.openclaw\/secrets\S*/gi, "$1<REDACTED:identity-file>")
    .replace(/(-i\s+)\S*\.ssh\/[^\s]*id_(?:rsa|ed25519|ecdsa)[^\s]*/gi, "$1<REDACTED:ssh-key>")
    // Bearer / Authorization tokens
    .replace(/\b(Authorization:\s*Bearer\s+)\S+/gi, "$1<REDACTED:bearer>")
    .replace(/\b(-H\s+["']?Authorization:\s*Bearer\s+)\S+/gi, "$1<REDACTED:bearer>")
    // AWS access key id (format: AKIA + 16 alnums)
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<REDACTED:aws-key-id>")
    // GitHub-style PATs
    .replace(/\bgh[ps]_[A-Za-z0-9]{30,}\b/g, "<REDACTED:github-pat>")
    // Anthropic / OpenAI style keys
    .replace(/\b(sk-(?:ant-)?(?:proj-|live-|oat\d+-)?)[A-Za-z0-9_-]{20,}/g, "$1<REDACTED>")
    // Postgres / DB URLs with embedded passwords (scheme://user:pw@host)
    .replace(/(\b[a-z][a-z0-9+\-.]*:\/\/[^:\/\s@]+:)[^@\s]+(@)/gi, "$1<REDACTED:db-pass>$2")
    // API key env-var assignment style ((name)_API_KEY=value)
    .replace(/\b(([A-Z][A-Z0-9_]*?_)?(?:API_KEY|TOKEN|SECRET))=\S+/g, "$1=<REDACTED>");
}

/**
 * Render a one-line disambiguator from a JSON tool_input. The agent only
 * needs enough to match a user reference like "the bash command from
 * earlier" or "your read of foo.json"; full input is in lcm_describe.
 *
 * Wave-2 P0-C: command field is truncated to 80 chars (was 240) AND run
 * through `redactCredentials` so persisted summary doesn't leak secrets.
 */
function renderToolInputDisambiguator(rawInput, toolName) {
  if (typeof rawInput !== "string" || rawInput.length === 0) return null;
  let inp;
  try { inp = JSON.parse(rawInput); } catch { return null; }
  if (!inp || typeof inp !== "object") return null;
  const oneLine = (s, n = 200) =>
    String(s).split(/\r?\n/)[0].slice(0, n) + (String(s).length > n ? " …" : "");
  if (typeof inp.path === "string") return `Tool: ${toolName} | Path: ${inp.path}`;
  if (typeof inp.command === "string") {
    return `Tool: ${toolName} | Command: ${redactCredentials(oneLine(inp.command, 80))}`;
  }
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

if (revert) {
  // Wave-2 P1: complete reversibility — undo a previous migration.
  // Identifies migration-marked rows (large_content starts with `file_`),
  // looks up storage_uri from large_files, deletes the on-disk file,
  // deletes the large_files row, and clears the messages.large_content.
  const revertSummary = {
    db: dbPath, dryRun: false, mode: "revert",
    rowsCleared: 0, filesDeleted: 0, largeFilesRowsDeleted: 0, errors: [],
  };
  const revertCandidates = db
    .prepare(
      `SELECT m.message_id, m.large_content AS file_id, lf.storage_uri
       FROM messages m
       JOIN large_files lf ON lf.file_id = m.large_content
       WHERE m.large_content LIKE 'file_%'`,
    )
    .all();
  try {
    db.exec("BEGIN");
    const clearMsgStmt = db.prepare(`UPDATE messages SET large_content = NULL WHERE message_id = ?`);
    const deleteFileStmt = db.prepare(`DELETE FROM large_files WHERE file_id = ?`);
    for (const row of revertCandidates) {
      // Delete the disk file first; if SQL ROLLBACKs after this, the
      // file is gone but DB still references it — that's the same
      // "orphan" failure mode as forward-migration, but in reverse.
      // Acceptable because revert is operator-driven and recoverable.
      try {
        if (row.storage_uri && existsSync(row.storage_uri)) {
          unlinkSync(row.storage_uri);
          revertSummary.filesDeleted++;
        }
      } catch (err) {
        revertSummary.errors.push(`unlink ${row.storage_uri}: ${err}`);
      }
      deleteFileStmt.run(row.file_id);
      revertSummary.largeFilesRowsDeleted++;
      clearMsgStmt.run(row.message_id);
      revertSummary.rowsCleared++;
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* noop */ }
    revertSummary.errors.push(String(err?.stack ?? err));
    console.error(JSON.stringify(revertSummary, null, 2));
    db.close();
    process.exit(2);
  }
  try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
  console.log(JSON.stringify(revertSummary, null, 2));
  db.close();
  process.exit(0);
}

if (!existsSync(storageDir)) {
  // Wave-2 P1: 0700 so other users on the box can't list filenames.
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  log(`created storage dir ${storageDir} (mode 0700)`);
}

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
      // Wave-2 P1: 0600 so tool outputs (which can contain credentials)
      // aren't world-readable on multi-user boxes.
      writeFileSync(storageUri, row.content, { mode: 0o600 });
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
  // Wave-2 P1 fix: even on a partial-failure, report the chunks that DID
  // commit. Pre-fix, `summary.applied` stayed 0 and operators re-ran the
  // script, doubling the orphan-file count. Now the report tells the
  // truth: N rows committed before the failure.
  summary.applied = done;
  summary.errors.push(String(err?.stack ?? err));
  console.error(JSON.stringify(summary, null, 2));
  db.close();
  process.exit(2);
}

try { db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); } catch { /* best-effort */ }
console.log(JSON.stringify(summary, null, 2));
db.close();
process.exit(0);
