#!/usr/bin/env node
/**
 * v4.2 §B live watcher — tails the gateway log + LCM DB to surface
 * stub-tier telemetry in real time during a live session.
 *
 * What it surfaces (every event hits stdout as one line):
 *
 *   [STUB n=86 saved=409449 conv=1872 sess=…]    assemble emitted N stubs
 *   [DRILL  file_xxx tool=Bash]                  agent invoked lcm_describe(id=file_xxx)
 *   [PAIR-WARN tool_use without tool_result]     potential sanitizer issue
 *   [INGEST n=… tokens=…]                        afterTurn ingest summary
 *   [COMPACT reason=… …]                         compaction events
 *   [ERROR …]                                    any [lcm] error
 *   [DB stubbedRows=… diskUsageMB=…]             periodic DB-state snapshot (every 30s)
 *
 * USAGE:
 *   node scripts/v42-live-watcher.mjs
 *     [--log PATH]           default ~/.openclaw/logs/gateway.log
 *     [--db PATH]            default ~/.openclaw/lcm.db
 *     [--snapshot-secs N]    default 30
 *     [--quiet]              suppress periodic snapshots
 *
 * NEVER writes to anything. Read-only.
 */

import { existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const getArg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined;
};
const hasFlag = (n) => args.includes(`--${n}`);

const logPath = getArg("log") ?? join(homedir(), ".openclaw", "logs", "gateway.log");
const dbPath = getArg("db") ?? join(homedir(), ".openclaw", "lcm.db");
const snapshotSecs = Number(getArg("snapshot-secs") ?? 30);
const quiet = hasFlag("quiet");

if (!existsSync(logPath)) {
  console.error(`Log not found: ${logPath}`);
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

// ── Log tailer ────────────────────────────────────────────────────────────────
let fd = openSync(logPath, "r");
let pos = statSync(logPath).size; // start at the END — only NEW lines
let buf = "";

function pollLog() {
  let stat;
  try {
    stat = statSync(logPath);
  } catch {
    return;
  }
  if (stat.size < pos) {
    // File rotated or truncated — re-open from start of new file.
    try { closeSync(fd); } catch {}
    fd = openSync(logPath, "r");
    pos = 0;
  }
  const toRead = stat.size - pos;
  if (toRead <= 0) return;
  const chunk = Buffer.allocUnsafe(toRead);
  const got = readSync(fd, chunk, 0, toRead, pos);
  pos += got;
  buf += chunk.slice(0, got).toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    handleLine(line);
  }
}

// ── State ─────────────────────────────────────────────────────────────────────
const counters = {
  assembleCalls: 0,
  stubbedAssembles: 0,
  totalStubsEmitted: 0,
  totalTokensSaved: 0,
  drilldowns: 0,
  drilldownsByFileId: new Map(),
  ingestCalls: 0,
  compactionEvents: 0,
  errors: 0,
  pairingWarns: 0,
};

function emit(level, kind, payload) {
  const ts = new Date().toISOString();
  const line = `${ts} [${kind}] ${payload}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

// ── Line handlers ─────────────────────────────────────────────────────────────
function handleLine(line) {
  if (!line.includes("[lcm]") && !line.includes("lcm_describe")) return;

  // [lcm] assemble: done conversation=X ... estimatedTokens=Y stubbed=N tokensSaved=M
  const assembleMatch = line.match(
    /\[lcm\] assemble: done conversation=(\d+) .*?contextItems=(\d+) .*?outputMessages=(\d+) .*?estimatedTokens=(\d+)(?: stubbed=(\d+) tokensSaved=(\d+))?/,
  );
  if (assembleMatch) {
    counters.assembleCalls += 1;
    const [, conv, items, output, tokens, stubbed, saved] = assembleMatch;
    if (stubbed && Number(stubbed) > 0) {
      counters.stubbedAssembles += 1;
      counters.totalStubsEmitted += Number(stubbed);
      counters.totalTokensSaved += Number(saved);
      emit(
        "info",
        "STUB",
        `n=${stubbed} saved=${saved} conv=${conv} items=${items}/${output} tokens=${tokens}`,
      );
    }
    return;
  }

  // [lcm] tool lcm_describe called  (or similar)
  // Heuristic: any line with `lcm_describe` and `file_` in it indicates an attempted drilldown.
  const drilldownMatch = line.match(/lcm_describe[^\n]*?(file_[a-zA-Z0-9_-]+)/);
  if (drilldownMatch) {
    counters.drilldowns += 1;
    const fileId = drilldownMatch[1];
    counters.drilldownsByFileId.set(
      fileId,
      (counters.drilldownsByFileId.get(fileId) ?? 0) + 1,
    );
    // Try to extract tool name if present.
    const toolNameMatch = line.match(/tool=(\w+)|toolName=(\w+)/);
    const toolName = toolNameMatch?.[1] ?? toolNameMatch?.[2] ?? "?";
    emit("info", "DRILL", `${fileId} tool=${toolName}`);
    return;
  }

  // afterTurn ingest summary
  const ingestMatch = line.match(
    /\[lcm\] afterTurn: done conversation=\d+ .*?ingestedMessages=(\d+)/,
  );
  if (ingestMatch) {
    counters.ingestCalls += 1;
    if (Number(ingestMatch[1]) > 0) {
      emit("info", "INGEST", `n=${ingestMatch[1]}`);
    }
    return;
  }

  // Compaction
  if (line.match(/\[lcm\].*?compact(?:ion|ed)/i)) {
    if (line.match(/error|fail/i)) {
      counters.errors += 1;
      emit("error", "ERROR", line.slice(line.indexOf("[lcm]")).slice(0, 240));
      return;
    }
    counters.compactionEvents += 1;
    if (line.includes("debt") || line.includes("synchronous") || line.includes("done")) {
      const m = line.match(/\[lcm\][^\n]{0,200}/);
      if (m) emit("info", "COMPACT", m[0].replace(/^\[lcm\]\s*/, ""));
    }
    return;
  }

  // Pairing/sanitizer warnings
  if (line.match(/sanitize|tool_use without|orphan tool/i)) {
    counters.pairingWarns += 1;
    emit("error", "PAIR-WARN", line.slice(line.indexOf("[lcm]") || 0).slice(0, 240));
    return;
  }

  // Generic [lcm] errors
  if (line.match(/\[lcm\][^\n]*(?:error|failed)/i)) {
    counters.errors += 1;
    emit("error", "ERROR", line.slice(line.indexOf("[lcm]")).slice(0, 240));
  }
}

// ── DB-state snapshot ─────────────────────────────────────────────────────────
function snapshotDb() {
  if (quiet) return;
  let stubbedRows = { n: null };
  let filesRow = { n: null, bytes: 0 };
  let schemaState = "ready";
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only = 1");
    try {
      stubbedRows = db
        .prepare(`SELECT COUNT(*) AS n FROM messages WHERE large_content IS NOT NULL`)
        .get();
    } catch {
      schemaState = "pre-v4.2-migration";
    }
    try {
      filesRow = db
        .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(byte_size),0) AS bytes FROM large_files`)
        .get();
    } catch {
      schemaState = schemaState === "ready" ? "no-large-files-table" : schemaState;
    }
    db.close();
  } catch (err) {
    emit("error", "DB", `snapshot failed: ${String(err?.message ?? err)}`);
    return;
  }
  const mb = (filesRow?.bytes ?? 0) / (1024 * 1024);
  emit(
    "info",
    "DB",
    `schema=${schemaState} stubbedRows=${stubbedRows?.n ?? "n/a"} largeFiles=${filesRow?.n ?? "n/a"} diskUsageMB=${mb.toFixed(2)} | session: ` +
      `assembles=${counters.assembleCalls} stubbedAssembles=${counters.stubbedAssembles} ` +
      `stubsEmitted=${counters.totalStubsEmitted} tokensSaved=${counters.totalTokensSaved} ` +
      `drilldowns=${counters.drilldowns} ingests=${counters.ingestCalls} ` +
      `compaction=${counters.compactionEvents} errors=${counters.errors}`,
  );
}

// ── Run ───────────────────────────────────────────────────────────────────────
emit("info", "START", `watching ${logPath} | DB ${dbPath}`);
const logTimer = setInterval(pollLog, 250);
const dbTimer = setInterval(snapshotDb, snapshotSecs * 1000);
snapshotDb(); // baseline immediately

process.on("SIGINT", () => {
  clearInterval(logTimer);
  clearInterval(dbTimer);
  emit("info", "END", JSON.stringify(counters, (k, v) => (v instanceof Map ? Object.fromEntries(v) : v)));
  try { closeSync(fd); } catch {}
  process.exit(0);
});
