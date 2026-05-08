#!/usr/bin/env node
/**
 * LCM tool call wrapper — for use by the agent harness.
 *
 * Spawns the LCM tool registry against a harness DB and executes ONE tool
 * call. Stdout is the tool's JSON result (or error). This is the bridge
 * between Sonnet subagents (running in Claude Code Agent tool) and the
 * actual LCM tool surface.
 *
 * USAGE:
 *   node scripts/lcm-tool-call.mjs \
 *     --db /Volumes/LEXAR/lcm-tmp/agent-harness-2026-05-06/lcm-agent-harness.db \
 *     --tool lcm_grep \
 *     --args '{"pattern":"race condition","mode":"hybrid","conversationId":1872,"limit":10}'
 *
 * SUPPORTED TOOLS (all 8 from the v4.1 ship):
 *   - lcm_grep
 *       args: {pattern, mode?, limit?, conversationId?, allConversations?,
 *              since?, before?, sessionKey?}
 *       modes: regex / full_text / hybrid / semantic / verbatim
 *       NOTE: pass `allConversations: true` when running against a session
 *       key that has no resolved conversation (e.g. agent:main:main on a
 *       fresh snapshot) — otherwise the scope resolver returns no rows.
 *   (note: standalone lcm_semantic_recall removed in Wave-12 SA — pure-vector
 *    KNN now lives at lcm_grep mode='semantic' with the same shape)
 *   - lcm_synthesize_around (returns assembled source text only — no LLM call;
 *     the calling subagent should synthesize itself given the source)
 *   - lcm_describe (with expandChildren / expandMessages)
 *       args: {id, expandChildren?, expandMessages?, messageOffset?}
 *   - lcm_expand (sub-agent only; harness fakes a sub-agent session_key)
 *   - lcm_expand_query (would normally delegate; harness returns the
 *     would-be candidate IDs only)
 *   - lcm_get_entity
 *   - lcm_search_entities
 *       NOTE: returns empty on snapshots where the entity-coreference
 *       worker has not run. Live DBs have it; VACUUM INTO snapshots do not.
 *
 * REQUIREMENTS:
 *   - VOYAGE_API_KEY env var (for hybrid / semantic modes)
 *   - LCM_TEST_VEC0_PATH env var (path to vec0.dylib)
 *   - DB must have v4.1 migration applied + voyage-4-large profile registered
 *     + at least some leaves embedded (run scripts/v41-agent-harness-preflight.mjs first)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";

// ── Parse CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}
const dbPath = getArg("db");
const toolName = getArg("tool");
const toolArgsRaw = getArg("args") ?? "{}";

if (!dbPath || !toolName) {
  console.error(
    JSON.stringify({
      error: "Usage: lcm-tool-call.mjs --db <path> --tool <name> --args '<json>'",
    }),
  );
  process.exit(1);
}

let toolArgs;
try {
  toolArgs = JSON.parse(toolArgsRaw);
} catch (e) {
  console.error(
    JSON.stringify({ error: `--args must be valid JSON: ${e instanceof Error ? e.message : String(e)}` }),
  );
  process.exit(1);
}

if (!existsSync(dbPath)) {
  console.error(JSON.stringify({ error: `DB not found: ${dbPath}` }));
  process.exit(1);
}

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH ??
  `${homedir()}/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib`;

// ── Open DB + load vec0 ──────────────────────────────────────────
const db = new DatabaseSync(dbPath, { allowExtension: true });
db.exec("PRAGMA foreign_keys=ON;");
const { tryLoadSqliteVec, vec0Version } = await import(`${process.cwd()}/src/embeddings/store.ts`);
tryLoadSqliteVec(db, { path: VEC0_PATH, silent: true });

// ── Build minimal LcmDependencies + LcmContextEngine ─────────────
// Use the REAL stores + RetrievalEngine so lcm_grep / lcm_describe / etc.
// exercise their actual production code paths (not no-op stubs). This is
// what makes the harness a real test instead of a structural fake.
const { SummaryStore } = await import(`${process.cwd()}/src/store/summary-store.ts`);
const { ConversationStore } = await import(`${process.cwd()}/src/store/conversation-store.ts`);
const { RetrievalEngine } = await import(`${process.cwd()}/src/retrieval.ts`);

const summaryStore = new SummaryStore(db);
const conversationStoreReal = new ConversationStore(db, { fts5Available: true });
const retrievalEngine = new RetrievalEngine(conversationStoreReal, summaryStore);

// Wrapper that adapts ConversationStore to the production-interface shape
// lcm-conversation-scope.ts expects (see src/tools/lcm-conversation-scope.ts:10-21).
//
// HARNESS BUG H1 FIX: getConversationFamilyIds takes an object input
// ({conversationId?, sessionId?, sessionKey?}) in production, NOT a positional
// number. Earlier shim was object-mismatched and threw "Unknown named parameter
// 'conversationId'" on every call that hit the family-resolution path.
const conversationStoreShim = {
  getConversationBySessionId: async (sessionId) => {
    const row = db
      .prepare(`SELECT conversation_id FROM conversations WHERE session_id = ? LIMIT 1`)
      .get(sessionId);
    return row ? { conversationId: row.conversation_id } : null;
  },
  getConversationBySessionKey: async (sessionKey) => {
    const row = db
      .prepare(
        `SELECT conversation_id FROM conversations WHERE session_key = ? ORDER BY conversation_id DESC LIMIT 1`,
      )
      .get(sessionKey);
    return row ? { conversationId: row.conversation_id } : null;
  },
  // Production signature: ({conversationId?, sessionId?, sessionKey?}) => Promise<number[]>
  getConversationFamilyIds: async ({ conversationId, sessionKey }) => {
    let resolvedSessionKey = sessionKey;
    if (!resolvedSessionKey && conversationId != null) {
      const sk = db
        .prepare(`SELECT session_key FROM conversations WHERE conversation_id = ?`)
        .get(conversationId);
      resolvedSessionKey = sk?.session_key;
    }
    if (!resolvedSessionKey) {
      return conversationId != null ? [conversationId] : [];
    }
    const fam = db
      .prepare(
        `SELECT conversation_id FROM conversations WHERE session_key = ? ORDER BY conversation_id`,
      )
      .all(resolvedSessionKey);
    const ids = fam.map((r) => r.conversation_id);
    return ids.length > 0 ? ids : conversationId != null ? [conversationId] : [];
  },
};

const lcmEngine = {
  info: { id: "lcm", name: "LCM", version: "harness" },
  timezone: "UTC",
  getDb: () => db,
  getRetrieval: () => retrievalEngine,
  getConversationStore: () => conversationStoreShim,
  getSummaryStore: () => summaryStore,
};

const deps = {
  config: {
    enabled: true,
    databasePath: dbPath,
    ignoreSessionPatterns: [],
    statelessSessionPatterns: [],
    skipStatelessSessions: true,
    contextThreshold: 0.75,
    freshTailCount: 8,
    newSessionRetainDepth: 2,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    summaryProvider: "",
    summaryModel: "",
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    timezone: "UTC",
    pruneHeartbeatOk: false,
    transcriptGcEnabled: false,
    proactiveThresholdCompactionMode: "deferred",
    autoRotateSessionFiles: {
      enabled: true,
      sizeBytes: 2 * 1024 * 1024,
      startup: "rotate",
      runtime: "rotate",
    },
    summaryMaxOverageFactor: 3,
  },
  complete: async () => ({ text: "[harness mock — synthesis not exercised here]" }),
  callGateway: async () => ({}),
  // Silent log shim — production deps would route to gateway logger
  log: {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  },
  resolveModel: () => ({ provider: "anthropic", model: "claude-sonnet-4-5" }),
  getApiKey: async () => process.env.VOYAGE_API_KEY,
  requireApiKey: async () => process.env.VOYAGE_API_KEY ?? "",
  parseAgentSessionKey: (sk) => {
    const parts = sk.split(":");
    if (parts.length < 3 || parts[0] !== "agent") return null;
    return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
  },
  isSubagentSessionKey: (sk) => typeof sk === "string" && sk.includes(":subagent:"),
  normalizeAgentId: (id) => (id?.trim() ? id : "main"),
  buildSubagentSystemPrompt: () => "",
  readLatestAssistantReply: () => undefined,
  resolveSessionIdFromSessionKey: async (_sessionKey) => undefined,
};

// Default session key is agent:main:main; scenarios that need sub-agent
// access can pass --session-key agent:main:subagent:test
const sessionKey = getArg("session-key") ?? "agent:main:main";

// ── Tool dispatch ────────────────────────────────────────────────
async function callTool() {
  const t0 = Date.now();
  let tool;
  switch (toolName) {
    case "lcm_grep": {
      const { createLcmGrepTool } = await import(`${process.cwd()}/src/tools/lcm-grep-tool.js`);
      tool = createLcmGrepTool({ deps, lcm: lcmEngine, sessionKey });
      break;
    }
    // Wave-12 SA: lcm_semantic_recall removed; route via lcm_grep mode='semantic'.
    case "lcm_synthesize_around": {
      const { createLcmSynthesizeAroundTool } = await import(
        `${process.cwd()}/src/tools/lcm-synthesize-around-tool.js`
      );
      tool = createLcmSynthesizeAroundTool({ deps, lcm: lcmEngine, sessionKey });
      break;
    }
    case "lcm_describe": {
      const { createLcmDescribeTool } = await import(`${process.cwd()}/src/tools/lcm-describe-tool.js`);
      tool = createLcmDescribeTool({ deps, lcm: lcmEngine, sessionKey });
      break;
    }
    case "lcm_expand": {
      // lcm_expand is sub-agent-only; harness fakes a sub-agent session_key
      const { createLcmExpandTool } = await import(`${process.cwd()}/src/tools/lcm-expand-tool.js`);
      tool = createLcmExpandTool({
        deps,
        lcm: lcmEngine,
        sessionKey: "agent:main:subagent:harness",
      });
      break;
    }
    case "lcm_expand_query": {
      const { createLcmExpandQueryTool } = await import(
        `${process.cwd()}/src/tools/lcm-expand-query-tool.js`
      );
      tool = createLcmExpandQueryTool({
        deps,
        lcm: lcmEngine,
        sessionKey,
        requesterSessionKey: sessionKey,
      });
      break;
    }
    case "lcm_get_entity": {
      const { createLcmGetEntityTool } = await import(
        `${process.cwd()}/src/tools/lcm-get-entity-tool.js`
      );
      tool = createLcmGetEntityTool({ deps, lcm: lcmEngine, sessionKey });
      break;
    }
    case "lcm_search_entities": {
      const { createLcmSearchEntitiesTool } = await import(
        `${process.cwd()}/src/tools/lcm-search-entities-tool.js`
      );
      tool = createLcmSearchEntitiesTool({ deps, lcm: lcmEngine, sessionKey });
      break;
    }
    default: {
      console.error(JSON.stringify({ error: `Unknown tool: ${toolName}` }));
      process.exit(1);
    }
  }

  try {
    const result = await tool.execute(`harness_${Date.now()}`, toolArgs);
    const durationMs = Date.now() - t0;
    // Tools return { content: [{type:'text', text}], details } — we surface
    // both. Truncate the text to 8K chars to keep subagent context manageable.
    const text = result.content?.[0]?.text ?? "";
    const truncatedText =
      text.length > 8000 ? text.slice(0, 8000) + `\n\n[...truncated ${text.length - 8000} chars]` : text;
    console.log(
      JSON.stringify(
        {
          tool: toolName,
          durationMs,
          text: truncatedText,
          textChars: text.length,
          details: result.details,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    console.error(
      JSON.stringify({
        tool: toolName,
        error: e instanceof Error ? e.message : String(e),
        stack: process.env.LCM_HARNESS_STACK === "true" && e instanceof Error ? e.stack : undefined,
        durationMs: Date.now() - t0,
      }),
    );
    process.exit(2);
  } finally {
    db.close();
  }
}

await callTool();
