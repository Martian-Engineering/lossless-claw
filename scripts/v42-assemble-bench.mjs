#!/usr/bin/env node
/**
 * v4.2 assemble-bench — measure assembled context cost on a snapshot DB.
 *
 * Calls engine.assemble() for the most-active session and captures token
 * counts, item composition (summaries vs raw vs fresh-tail), and segment
 * breakdowns. Used to compare baseline v4.1 vs proposed v4.2 variants.
 *
 * USAGE:
 *   VOYAGE_API_KEY=$(cat ~/.openclaw/credentials/voyage-api-key) \
 *   LCM_TEST_VEC0_PATH=$HOME/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib \
 *     node scripts/v42-assemble-bench.mjs --db <path>
 *
 * NEVER touches the live DB; pass an explicit --db.
 *
 * EXIT CODES:
 *   0 — measurement complete
 *   1 — usage / setup error
 *   2 — engine.assemble() threw (bug or DB malformed)
 */

import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

const args = process.argv.slice(2);
const getArg = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && i < args.length - 1 ? args[i + 1] : undefined;
};
const hasFlag = (n) => args.includes(`--${n}`);

const dbPath = getArg("db");
const variantLabel = getArg("variant") ?? "baseline";
const tokenBudget = Number(getArg("budget") ?? 258000);
const sessionId = getArg("session-id") ?? "boot-2026-05-05_11-44-39-074-95d65b06";
const sessionKey = getArg("session-key") ?? "agent:main:main";
const jsonOut = getArg("json-out");
const verbose = hasFlag("verbose");

if (!dbPath) {
  console.error("Usage: v42-assemble-bench.mjs --db <path> [--variant LABEL] [--budget N] [--session-id ID]");
  process.exit(1);
}
if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}
const log = (msg) => { if (verbose) console.error(`[bench] ${msg}`); };

const cwd = process.cwd();
const repoRootHint = `Run from repo root (cwd has src/db/migration.ts). Current cwd: ${cwd}`;
if (!existsSync(`${cwd}/src/db/migration.ts`)) {
  console.error(`Bench must run from repo root. ${repoRootHint}`);
  process.exit(1);
}

// ── Open DB + load extensions ──
const db = new DatabaseSync(dbPath, { allowExtension: true });
db.exec("PRAGMA foreign_keys = ON");
db.exec("PRAGMA journal_mode = WAL");

const { runLcmMigrations } = await import(`${cwd}/src/db/migration.ts`);
runLcmMigrations(db, { fts5Available: true, seedDefaultPrompts: false });
log("migration complete");

// ── Build engine deps (minimal stand-ins, since assemble() doesn't need LLM/Voyage) ──
const { LcmContextEngine } = await import(`${cwd}/src/engine.ts`);

const config = {
  enabled: true,
  databasePath: dbPath,
  largeFilesDir: `${homedir()}/.openclaw/lcm-files`,
  ignoreSessionPatterns: [],
  statelessSessionPatterns: [],
  skipStatelessSessions: false,
  contextThreshold: 0.6,
  freshTailCount: 64,
  freshTailMaxTokens: 24000,
  promptAwareEviction: false,
  newSessionRetainDepth: 2,
  leafMinFanout: 8,
  condensedMinFanout: 4,
  condensedMinFanoutHard: 2,
  incrementalMaxDepth: 1,
  leafChunkTokens: 20000,
  leafTargetTokens: 2400,
  condensedTargetTokens: 900,
  maxExpandTokens: 4000,
  largeFileTokenThreshold: 25000,
  summaryProvider: "",
  summaryModel: "",
  largeFileSummaryProvider: "",
  largeFileSummaryModel: "",
  expansionProvider: "",
  expansionModel: "",
  delegationTimeoutMs: 120000,
  summaryTimeoutMs: 60000,
  timezone: "UTC",
  pruneHeartbeatOk: false,
  transcriptGcEnabled: false,
  proactiveThresholdCompactionMode: "deferred",
  autoRotateSessionFiles: { enabled: false, sizeBytes: 2097152, startup: "warn", runtime: "warn" },
  summaryMaxOverageFactor: 3,
  customInstructions: "",
  circuitBreakerThreshold: 5,
  circuitBreakerCooldownMs: 1800000,
  fallbackProviders: [],
  cacheAwareCompaction: {
    enabled: true, cacheTTLSeconds: 300, maxColdCacheCatchupPasses: 2,
    hotCachePressureFactor: 4, hotCacheBudgetHeadroomRatio: 0.2,
    coldCacheObservationThreshold: 3, criticalBudgetPressureRatio: 0.7,
  },
  dynamicLeafChunkTokens: { enabled: true, max: 40000 },
  // v4.2 §B — picked up by engine.assemble() via the cast; on for the
  // "v42-stubs" variant, off for "baseline".
  stubLargeToolPayloads: variantLabel === "v42-stubs",
};

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const deps = {
  config,
  log: noopLog,
  complete: async () => ({ content: [{ type: "text", text: "noop" }] }),
  callGateway: async () => ({}),
  resolveModel: () => ({ provider: "openai-codex", model: "gpt-5.4-mini" }),
  getApiKey: async () => "noop",
  requireApiKey: async () => "noop",
  parseAgentSessionKey: (sk) => {
    const t = sk.trim();
    if (!t.startsWith("agent:")) return null;
    const parts = t.split(":");
    if (parts.length < 3) return null;
    return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
  },
  isSubagentSessionKey: (sk) => sk.includes(":subagent:"),
  normalizeAgentId: (id) => (id?.trim() ? id : "main"),
  buildSubagentSystemPrompt: () => "subagent prompt",
  readLatestAssistantReply: () => undefined,
  resolveAgentDir: () => process.env.HOME ?? "/tmp",
  resolveSessionIdFromSessionKey: async () => undefined,
};

const engine = new LcmContextEngine(deps, db);

// ── Find a session to bench against ──
// Try the configured one first, fall back to the most-active session in the DB.
let sessionToBench = sessionId;
const sessionRow = db.prepare(`SELECT session_id, session_key, conversation_id FROM conversations WHERE session_id = ? LIMIT 1`).get(sessionId);
if (!sessionRow) {
  // Fall back: pick the conversation with the most messages.
  const fallback = db.prepare(`
    SELECT c.session_id, c.session_key, c.conversation_id, COUNT(m.message_id) AS msg_count
    FROM conversations c
    LEFT JOIN messages m ON m.conversation_id = c.conversation_id
    GROUP BY c.conversation_id
    ORDER BY msg_count DESC
    LIMIT 1
  `).get();
  if (!fallback) {
    console.error("No conversations in DB");
    process.exit(2);
  }
  sessionToBench = fallback.session_id;
  log(`session "${sessionId}" not found; falling back to most-active: ${sessionToBench} (conv ${fallback.conversation_id}, ${fallback.msg_count} msgs)`);
}

// ── Resolve conversationId for direct assembler invocation. ──
// The engine.assemble path strips debug fields; calling the assembler
// directly preserves stub diagnostics + selection-mode breakdown.
const convRow = db
  .prepare(`SELECT conversation_id FROM conversations WHERE session_id = ? AND session_key = ? AND active = 1 ORDER BY conversation_id DESC LIMIT 1`)
  .get(sessionToBench, sessionKey)
  ?? db
  .prepare(`SELECT conversation_id FROM conversations WHERE session_id = ? ORDER BY conversation_id DESC LIMIT 1`)
  .get(sessionToBench);
if (!convRow) {
  console.error(`No conversation found for session ${sessionToBench}`);
  process.exit(2);
}
const conversationId = convRow.conversation_id;
log(`assembling against conversation ${conversationId}`);

// Build assembler with the same dependencies the engine wires up.
const { ContextAssembler } = await import(`${cwd}/src/assembler.ts`);
const { ConversationStore } = await import(`${cwd}/src/store/conversation-store.ts`);
const { SummaryStore } = await import(`${cwd}/src/store/summary-store.ts`);
const conversationStore = new ConversationStore(db);
const summaryStore = new SummaryStore(db);
const assembler = new ContextAssembler(conversationStore, summaryStore, config.timezone);

const t0 = performance.now();
let result, error;
try {
  result = await assembler.assemble({
    conversationId,
    tokenBudget,
    freshTailCount: config.freshTailCount,
    freshTailMaxTokens: config.freshTailMaxTokens,
    promptAwareEviction: config.promptAwareEviction,
    stubLargeToolPayloads: variantLabel === "v42-stubs",
  });
} catch (err) {
  error = String(err?.stack ?? err);
}
const elapsedMs = performance.now() - t0;

if (error) {
  console.error(`assemble() threw: ${error}`);
  process.exit(2);
}

// ── Analyze breakdown ──
// Count message vs summary kinds in the result.
const breakdown = { message: 0, summary: 0, other: 0 };
let totalMessageTokens = 0;
let totalSummaryTokens = 0;
const itemTypes = {};
for (const item of result.messages ?? []) {
  // Each item is an AgentMessage. We can't tell from the surface alone whether
  // it's from a summary; need to check via DB join. For now, count roles.
  const role = item.role ?? "other";
  itemTypes[role] = (itemTypes[role] ?? 0) + 1;
  // Estimate tokens by length / 4 (rough).
  const text = typeof item.content === "string" ? item.content : JSON.stringify(item.content ?? "");
  totalMessageTokens += Math.ceil(text.length / 4);
}

// v4.2 §B — pull stub diagnostics out of the assembled debug bag.
const stubStats = result.debug?.stubStats ?? null;

// ── Output ──
const report = {
  variant: variantLabel,
  db: dbPath,
  dbSizeBytes: statSync(dbPath).size,
  sessionId: sessionToBench,
  sessionKey,
  tokenBudget,
  measurement: {
    estimatedTokens: result.estimatedTokens ?? 0,
    contextItems: (result.messages ?? []).length,
    elapsedMs: Math.round(elapsedMs),
    rolesBreakdown: itemTypes,
    stubStats,
    selectionMode: result.debug?.selectionMode ?? null,
    freshTailCount: result.debug?.freshTailCount ?? 0,
  },
  // Raw counts from DB for context
  dbStats: {
    conversations: db.prepare(`SELECT COUNT(*) AS n FROM conversations`).get().n,
    messages: db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n,
    summaries: db.prepare(`SELECT COUNT(*) AS n FROM summaries`).get().n,
    messagesForSession: db.prepare(`
      SELECT COUNT(*) AS n FROM messages m
      JOIN conversations c ON c.conversation_id = m.conversation_id
      WHERE c.session_id = ?
    `).get(sessionToBench).n,
    summariesForSession: db.prepare(`
      SELECT COUNT(*) AS n FROM summaries s
      JOIN conversations c ON c.conversation_id = s.conversation_id
      WHERE c.session_id = ?
    `).get(sessionToBench).n,
    // v4.2 §B — surface stratification state of the DB so the bench
    // report makes it obvious whether large_content was populated for
    // this run.
    messagesWithLargeContent: (() => {
      try {
        return db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE large_content IS NOT NULL`).get().n;
      } catch { return 0; }
    })(),
    largeContentTotalBytes: (() => {
      try {
        return Number(db.prepare(`SELECT COALESCE(SUM(length(large_content)), 0) AS n FROM messages`).get().n);
      } catch { return 0; }
    })(),
  },
  timestamp: new Date().toISOString(),
};

console.log(JSON.stringify(report, null, 2));

if (jsonOut) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  log(`written: ${jsonOut}`);
}

db.close();
process.exit(0);
