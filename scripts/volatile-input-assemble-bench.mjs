#!/usr/bin/env node
// Exercise the public engine assembly boundary with synthetic SQLite history.
// npm install; node scripts/volatile-input-assemble-bench.mjs [--source-root ../baseline]
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Session } from "node:inspector";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";

const scriptRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    "source-root": { type: "string", default: scriptRoot },
    messages: { type: "string", default: "200" },
    events: { type: "string", default: "24" },
    bytes: { type: "string", default: "1400" },
    profile: { type: "string" },
  },
});
const sourceRoot = resolve(values["source-root"]);
const counts = Object.fromEntries(["messages", "events", "bytes"].map((key) => {
  const value = Number(values[key]);
  if (!Number.isSafeInteger(value) || value < (key === "events" ? 0 : 1)) {
    throw new Error(`--${key} must be a ${key === "events" ? "nonnegative" : "positive"} integer`);
  }
  return [key, value];
}));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
const work = await mkdtemp(join(tmpdir(), "lossless-assemble-bench-"));
let db;
let engine;
try {
  const bundle = join(work, "engine.mjs");
  await build({
    stdin: {
      contents: 'export { LcmContextEngine } from "./src/engine.ts"; export { resolveLcmConfig } from "./src/db/config.ts";',
      resolveDir: sourceRoot,
      loader: "ts",
    },
    outfile: bundle, bundle: true, platform: "node", target: "node24", format: "esm",
    external: ["openclaw", "@earendil-works/*"],
    nodePaths: [join(scriptRoot, "node_modules")],
    logLevel: "silent",
  });
  const { LcmContextEngine, resolveLcmConfig } = await import(pathToFileURL(bundle).href);
  const logs = [];
  const log = Object.fromEntries(["info", "warn", "error", "debug"].map((level) =>
    [level, (message) => logs.push({ level, message })]));
  db = new DatabaseSync(join(work, "lcm.db"));
  db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON");
  const config = resolveLcmConfig({}, {
    databasePath: join(work, "lcm.db"), largeFilesDir: join(work, "files"),
    freshTailCount: 8, contextThreshold: 0.95, independentLogFile: { enabled: false },
  });
  const unexpectedCall = async () => { throw new Error("Assembly must not call a model or Gateway"); };
  engine = new LcmContextEngine({
    config, log, complete: unexpectedCall, callGateway: unexpectedCall,
    resolveModel: () => ({ provider: "test", model: "synthetic" }),
    parseAgentSessionKey: () => ({ agentId: "main", suffix: "bench" }),
    isSubagentSessionKey: () => false, normalizeAgentId: (id) => id || "main",
    buildSubagentSystemPrompt: () => "", readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => work, agentLaneSubagent: "subagent",
  }, db);
  const sessionId = "bench-session";
  const sessionKey = "agent:main:bench";
  const store = engine.getConversationStore();
  const conversation = await store.createConversation({ sessionId, sessionKey });
  const inputs = Array.from({ length: counts.messages }, (_, index) => {
    const sentence = `Report ${index}: checked implementation, runtime boundaries, and regression evidence. `;
    return {
      conversationId: conversation.conversationId, seq: index + 1,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
      role: index % 2 ? "assistant" : "user",
      content: sentence.repeat(Math.ceil(counts.bytes / sentence.length)).slice(0, counts.bytes),
      tokenCount: Math.ceil(counts.bytes / 4),
    };
  });
  const rows = await store.createMessagesBulk(inputs);
  await engine.getSummaryStore().appendContextMessages(conversation.conversationId, rows.map((row) => row.messageId));
  const live = Array.from({ length: counts.events }, (_, index) => ({
    role: "user",
    content: `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n[Internal task completion event]\nWorker ${index} completed independent review. All owned outputs preserved.\n<<<END_OPENCLAW_INTERNAL_CONTEXT>>>`,
  }));
  const expected = [...inputs.map(({ role, content }) => ({ role, content: role === "assistant" ? [{ type: "text", text: content }] : content })), ...live];
  const snapshot = () => Object.fromEntries(["messages", "message_parts", "summaries", "context_items"]
    .map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const original = hash(snapshot());
  const phases = [];
  for (const phase of ["cold", "warm"]) {
    let previous = performance.now();
    let maxHeartbeatGapMs = 0;
    const heartbeatGaps = [];
    let assemblyStarted;
    let assemblyFinished;
    let heartbeat;
    let profiler;
    try {
      heartbeat = setInterval(() => {
        const now = performance.now();
        maxHeartbeatGapMs = Math.max(maxHeartbeatGapMs, now - previous);
        heartbeatGaps.push({ start: previous, end: now });
        previous = now;
      }, 10);
      await delay(35);
      let post;
      if (values.profile) {
        profiler = new Session();
        profiler.connect();
        post = promisify(profiler.post).bind(profiler);
        await post("Profiler.enable");
        await post("Profiler.setSamplingInterval", { interval: 1000 });
        await post("Profiler.start");
      }
      logs.length = 0;
      assemblyStarted = performance.now();
      const result = await engine.assemble({
        sessionId, sessionKey, messages: live, tokenBudget: 128000,
        availableTools: new Set(), prompt: "Continue.",
      });
      assemblyFinished = performance.now();
      const elapsedMs = assemblyFinished - assemblyStarted;
      let profilePath;
      if (post) {
        const { profile } = await post("Profiler.stop");
        await mkdir(resolve(values.profile), { recursive: true });
        profilePath = join(resolve(values.profile), `${basename(sourceRoot)}-${phase}-${Date.now()}.cpuprofile`);
        await writeFile(profilePath, JSON.stringify(profile));
      }
      await delay(25);
      // Retain the full observation window; intersecting intervals may also include time outside assembly.
      const gaps = heartbeatGaps.map(({ start, end }) => ({
        startFromAssemblyMs: start - assemblyStarted, endFromAssemblyMs: end - assemblyStarted,
        durationMs: end - start, intersectsAssembly: start < assemblyFinished && end > assemblyStarted,
      }));
      const maxAssemblyHeartbeatGapMs = Math.max(0, ...gaps.filter((gap) => gap.intersectsAssembly).map((gap) => gap.durationMs));
      const comparable = { messages: result.messages, estimatedTokens: result.estimatedTokens, systemPromptAddition: result.systemPromptAddition };
      const preserved = hash(result.messages.map(({ role, content }) => ({ role, content }))) === hash(expected);
      const unchanged = hash(snapshot()) === original;
      const fallbackLogs = logs.filter(({ message }) => /fallback|falling back|assemble: failed|lookup missed|no context items/i.test(message));
      phases.push({
        phase, elapsedMs, maxHeartbeatGapMs, maxAssemblyHeartbeatGapMs, heartbeatGaps: gaps, maxRSSKiB: process.resourceUsage().maxRSS, outputMessages: result.messages.length,
        estimatedTokens: result.estimatedTokens, outputHash: hash(comparable),
        allExpectedMessagesPreserved: preserved, canonicalDataUnchanged: unchanged,
        fallbackLogs, profilePath,
      });
      if (!preserved || !unchanged || fallbackLogs.length) process.exitCode = 1;
    } finally {
      clearInterval(heartbeat);
      profiler?.disconnect();
    }
  }
  console.log(JSON.stringify({ sourceRoot, node: process.version, ...counts, phases }, null, 2));
} finally {
  try { await engine?.dispose(); } finally {
    try { db?.close(); } finally { await rm(work, { recursive: true, force: true }); }
  }
}
