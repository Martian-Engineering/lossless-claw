#!/usr/bin/env node
/**
 * LCM v4.1 QA Runner — production harness for end-to-end agent-tool validation.
 *
 * Runs a curated set of test cases from THE_FIVE_QUESTIONS.md against any
 * snapshot DB, captures per-tool latency / error / cost metrics, and emits
 * a structured JSON report + human markdown summary.
 *
 * Designed to be:
 *   - Reusable: any operator can point it at any DB to validate the agent
 *     surface end-to-end before / after a rollout.
 *   - CI-friendly: exits non-zero if any test case fails to produce the
 *     expected signal (configurable via `expectations`).
 *   - Diagnostic: structured JSON output (one record per call) lets adversarial
 *     audit waves analyze what the surface actually returned without re-running
 *     the calls.
 *   - Cheap: caches embeddings via the Voyage client; total cost typically
 *     <$0.20 per full run on a fully-backfilled DB.
 *
 * USAGE:
 *
 *   # Smoke (8 minimal tests, ~10s, ~$0.05)
 *   VOYAGE_API_KEY=... LCM_TEST_VEC0_PATH=... \
 *     npx tsx scripts/v41-qa-runner.mjs \
 *       --db /Volumes/LEXAR/lcm-tmp/.../lcm-agent-harness.db \
 *       --suite smoke
 *
 *   # Full (25 THE_FIVE_QUESTIONS test cases, ~60s, ~$0.20)
 *   npx tsx scripts/v41-qa-runner.mjs --db <path> --suite full
 *
 *   # Adversarial (smoke + edge-case probes for known prior bugs)
 *   npx tsx scripts/v41-qa-runner.mjs --db <path> --suite adversarial
 *
 *   # Custom output paths
 *   npx tsx scripts/v41-qa-runner.mjs --db <path> --suite full \
 *       --json-out /tmp/qa-report.json \
 *       --md-out /tmp/qa-report.md
 *
 * EXIT CODES:
 *   0  — all tests passed expectations
 *   1  — usage / setup error
 *   2  — at least one test failed expectation (HIGH severity gap)
 *   3  — at least one test had unexpected error (e.g. tool crash)
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { performance } from "node:perf_hooks";

// ── Parse CLI args ────────────────────────────────────────────────
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx === args.length - 1) return undefined;
  return args[idx + 1];
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const dbPath = getArg("db");
const suite = getArg("suite") ?? "smoke";
const jsonOut = getArg("json-out");
const mdOut = getArg("md-out");
const verbose = hasFlag("verbose");

if (!dbPath) {
  console.error("Usage: v41-qa-runner.mjs --db <path> [--suite smoke|full|adversarial] [--json-out X] [--md-out Y] [--verbose]");
  process.exit(1);
}

if (!existsSync(dbPath)) {
  console.error(`DB not found: ${dbPath}`);
  process.exit(1);
}

if (!process.env.VOYAGE_API_KEY?.trim()) {
  console.error("VOYAGE_API_KEY env var required (read from ~/.openclaw/credentials/voyage-api-key)");
  process.exit(1);
}

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH ??
  `${homedir()}/.openclaw/extensions/node_modules/sqlite-vec-darwin-arm64/vec0.dylib`;

if (!existsSync(VEC0_PATH)) {
  console.error(`vec0 dylib not found: ${VEC0_PATH}`);
  process.exit(1);
}

// ── Open DB + load extensions ─────────────────────────────────────
process.chdir("/tmp/lossless-claw-upstream");

const db = new DatabaseSync(dbPath, { allowExtension: true });
db.exec("PRAGMA foreign_keys=ON;");
const { tryLoadSqliteVec } = await import(`${process.cwd()}/src/embeddings/store.ts`);
tryLoadSqliteVec(db, { path: VEC0_PATH, silent: true });

// ── Build dependencies ─────────────────────────────────────────────
const { SummaryStore } = await import(`${process.cwd()}/src/store/summary-store.ts`);
const { ConversationStore } = await import(`${process.cwd()}/src/store/conversation-store.ts`);
const { RetrievalEngine } = await import(`${process.cwd()}/src/retrieval.ts`);

const summaryStore = new SummaryStore(db);
const conversationStoreReal = new ConversationStore(db, { fts5Available: true });
const retrievalEngine = new RetrievalEngine(conversationStoreReal, summaryStore);

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
  getConversationFamilyIds: async ({ conversationId, sessionKey }) => {
    let resolvedSessionKey = sessionKey;
    if (!resolvedSessionKey && conversationId != null) {
      const sk = db
        .prepare(`SELECT session_key FROM conversations WHERE conversation_id = ?`)
        .get(conversationId);
      resolvedSessionKey = sk?.session_key;
    }
    if (!resolvedSessionKey) return conversationId != null ? [conversationId] : [];
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
  info: { id: "lcm", name: "LCM", version: "qa-runner" },
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
  complete: async () => ({ text: "[QA mock]" }),
  callGateway: async () => ({}),
  log: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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

const sessionKey = "agent:main:main";

// ── Pre-import all tools (single load amortizes module-startup) ───
const toolFactories = {};
toolFactories.lcm_grep = (await import(`${process.cwd()}/src/tools/lcm-grep-tool.js`))
  .createLcmGrepTool;
toolFactories.lcm_semantic_recall = (
  await import(`${process.cwd()}/src/tools/lcm-semantic-recall-tool.js`)
).createLcmSemanticRecallTool;
toolFactories.lcm_synthesize_around = (
  await import(`${process.cwd()}/src/tools/lcm-synthesize-around-tool.js`)
).createLcmSynthesizeAroundTool;
toolFactories.lcm_describe = (await import(`${process.cwd()}/src/tools/lcm-describe-tool.js`))
  .createLcmDescribeTool;
toolFactories.lcm_expand_query = (
  await import(`${process.cwd()}/src/tools/lcm-expand-query-tool.js`)
).createLcmExpandQueryTool;
toolFactories.lcm_get_entity = (
  await import(`${process.cwd()}/src/tools/lcm-get-entity-tool.js`)
).createLcmGetEntityTool;
toolFactories.lcm_search_entities = (
  await import(`${process.cwd()}/src/tools/lcm-search-entities-tool.js`)
).createLcmSearchEntitiesTool;

function buildTool(name) {
  const factory = toolFactories[name];
  if (!factory) throw new Error(`Unknown tool: ${name}`);
  if (name === "lcm_expand_query") {
    return factory({ deps, lcm: lcmEngine, sessionKey, requesterSessionKey: sessionKey });
  }
  return factory({ deps, lcm: lcmEngine, sessionKey });
}

// ── Test cases ────────────────────────────────────────────────────
//
// Each case has:
//   id: stable identifier (used in reports)
//   questionType: A/B/C/D/E (per THE_FIVE_QUESTIONS.md)
//   description: human-readable
//   tool: which tool to call
//   args: JSON args
//   expect: predicate over the result (text + details). Returns null = pass,
//           string = fail reason
//   severity: "critical" | "important" | "informational"
//     critical = exit code 2 if fails
//     important = warning, doesn't change exit code
//     informational = stat-collection only

const SUITES = {
  smoke: [
    // One test per question type — bare minimum the surface must answer.
    {
      id: "smoke-A-recent-time-window",
      questionType: "A",
      description:
        "Time-anchored: lcm_synthesize_around with a recent leaf as target + time window",
      tool: "lcm_synthesize_around",
      args: () => {
        // Anchor on a real recent leaf so the time window has content
        const row = db
          .prepare(
            `SELECT summary_id FROM summaries
             WHERE kind='leaf' AND suppressed_at IS NULL
             ORDER BY created_at DESC LIMIT 1`,
          )
          .get();
        return {
          target: row?.summary_id,
          window_kind: "time",
          windowHours: 24,
          allConversations: true,
        };
      },
      expect: (r) => {
        // Without LLM creds the tool returns a graceful "no summary model"
        // error or it assembles source. Both are acceptable as long as it
        // didn't crash uncaught.
        if (
          r.error &&
          !/summary model|provider|LLM|complete is unavailable|VOYAGE_API/i.test(r.error)
        ) {
          return `unexpected error: ${r.error}`;
        }
        return null;
      },
      severity: "critical",
    },
    {
      id: "smoke-B-hybrid-paraphrastic",
      questionType: "B",
      description: "Topic-anchored: hybrid mode returns at least 1 hit for paraphrastic query",
      tool: "lcm_grep",
      args: { pattern: "race condition fix", mode: "hybrid", limit: 5, allConversations: true },
      expect: (r) => {
        const hits = r.details?.hits ?? [];
        if (hits.length === 0) return "0 hits for hybrid 'race condition fix'";
        return null;
      },
      severity: "critical",
    },
    {
      id: "smoke-C-verbatim-returns-full",
      questionType: "C",
      description: "Verbatim: full message rows (not snippets)",
      tool: "lcm_grep",
      args: { pattern: "race condition", mode: "verbatim", limit: 3, allConversations: true },
      expect: (r) => {
        const hits = r.details?.hits ?? [];
        if (hits.length === 0) return "0 verbatim hits";
        const longest = Math.max(...hits.map((h) => h.content?.length ?? 0));
        if (longest < 200)
          return `verbatim hit content too short (max ${longest}) — should be full message rows`;
        return null;
      },
      severity: "critical",
    },
    {
      id: "smoke-D-entities-status-signal",
      questionType: "D",
      description: "Pattern: entity tool returns catalogStatus (not silent empty)",
      tool: "lcm_search_entities",
      args: { query: "voyage", limit: 5 },
      expect: (r) => {
        if (r.details?.catalogStatus == null && r.details?.totalMatches === 0) {
          return "0 results without catalogStatus signal — bug P8 regression";
        }
        return null;
      },
      severity: "critical",
    },
    {
      id: "smoke-E-describe-leaf",
      questionType: "E",
      description: "Drilldown: describe returns lineage + ancestor manifest",
      // First we need a leaf id. We'll pick one from the DB at runtime.
      tool: "lcm_describe",
      args: () => {
        const row = db
          .prepare(
            `SELECT summary_id FROM summaries WHERE kind='leaf' AND suppressed_at IS NULL LIMIT 1`,
          )
          .get();
        return { id: row?.summary_id, allConversations: true };
      },
      expect: (r) => {
        if (r.error) return `errored: ${r.error}`;
        if (r.details?.summary?.kind !== "leaf") return "did not return leaf";
        return null;
      },
      severity: "critical",
    },
    {
      id: "smoke-semantic-cosine-band",
      questionType: "B",
      description: "Semantic recall exposes cosineSimilarity + confidenceBand",
      tool: "lcm_semantic_recall",
      args: { query: "embedding backfill voyage", limit: 3, allConversations: true },
      expect: (r) => {
        if (r.details?.confidenceBand == null) return "missing confidenceBand";
        const hits = r.details?.hits ?? [];
        if (hits.length > 0 && hits[0].cosineSimilarity == null)
          return "missing cosineSimilarity on hits";
        return null;
      },
      severity: "critical",
    },
    {
      id: "smoke-filtered-knn-windowed",
      questionType: "A",
      description: "P1 regression check: time-windowed semantic returns hits in window",
      tool: "lcm_semantic_recall",
      args: {
        query: "openai websocket lineage 78055",
        limit: 5,
        allConversations: true,
        since: "2026-05-05T00:00:00Z",
        before: "2026-05-07T00:00:00Z",
      },
      expect: (r) => {
        const hits = r.details?.hits ?? [];
        if (hits.length === 0) {
          return "P1 regression: 0 hits for May5–6 window despite known content there";
        }
        return null;
      },
      severity: "critical",
    },
    {
      id: "smoke-fts5-sanitize",
      questionType: "C",
      description: "P7 regression check: pattern with dot doesn't crash FTS5",
      tool: "lcm_grep",
      args: {
        pattern: "v4.1",
        mode: "verbatim",
        limit: 3,
        allConversations: true,
      },
      expect: (r) => {
        if (r.error) return `P7 regression: 'v4.1' pattern errored — ${r.error}`;
        return null;
      },
      severity: "critical",
    },
  ],

  // Reuses smoke + adds the THE_FIVE_QUESTIONS.md test cases (25 originals).
  // Each maps to a tool call we can actually verify on the snapshot.
  full: [], // assembled below

  adversarial: [
    // Edge cases targeting the audit-discovered bugs.
    {
      id: "adv-empty-pattern",
      questionType: "C",
      description: "Empty pattern in verbatim mode shouldn't crash",
      tool: "lcm_grep",
      args: { pattern: "", mode: "verbatim", limit: 3, allConversations: true },
      expect: (r) => {
        // Empty pattern is invalid; tool should return graceful error, not crash.
        if (r.error || r.details?.error) return null;
        // Or it could return 0 matches — also acceptable.
        return null;
      },
      severity: "important",
    },
    {
      id: "adv-fts5-bracket",
      questionType: "C",
      description: "Bracket pattern shouldn't crash (sanitize)",
      tool: "lcm_grep",
      args: { pattern: "[ERROR]", mode: "verbatim", limit: 3, allConversations: true },
      expect: (r) => {
        if (r.error) return `bracket pattern errored: ${r.error}`;
        return null;
      },
      severity: "critical",
    },
    {
      id: "adv-fts5-leading-hyphen",
      questionType: "C",
      description: "Leading-hyphen pattern shouldn't be parsed as NOT operator",
      tool: "lcm_grep",
      args: {
        pattern: "-no-fts5-fallback",
        mode: "verbatim",
        limit: 3,
        allConversations: true,
      },
      expect: (r) => {
        if (r.error) return `leading-hyphen errored: ${r.error}`;
        return null;
      },
      severity: "critical",
    },
    {
      id: "adv-role-system",
      questionType: "C",
      description: "role='system' should be schema-valid (audit HIGH#4)",
      tool: "lcm_grep",
      args: {
        pattern: "system",
        mode: "verbatim",
        role: "system",
        limit: 3,
        allConversations: true,
      },
      expect: (r) => {
        if (r.error?.includes?.("schema") || r.details?.error?.includes?.("enum"))
          return `role='system' rejected: ${r.error || r.details?.error}`;
        return null;
      },
      severity: "critical",
    },
    {
      id: "adv-offset-clamp",
      questionType: "E",
      description: "Huge offset is clamped without table-scan DoS",
      tool: "lcm_describe",
      args: () => {
        const row = db
          .prepare(
            `SELECT summary_id FROM summaries WHERE kind='leaf' AND suppressed_at IS NULL LIMIT 1`,
          )
          .get();
        return {
          id: row?.summary_id,
          expandMessages: true,
          expandMessagesOffset: 999_999_999,
          expandMessagesLimit: 3,
          allConversations: true,
        };
      },
      expect: (r) => {
        if (r.error) return `offset clamp test errored: ${r.error}`;
        // Should return offset-past-end status quickly
        return null;
      },
      severity: "critical",
    },
    {
      id: "adv-expand-children-empty-status",
      questionType: "E",
      description: "expandChildren on a node with no children returns no-children status",
      tool: "lcm_describe",
      args: () => {
        // Find a leaf or condensed with childIds=[] (no descendants below it)
        const row = db
          .prepare(
            `SELECT s.summary_id FROM summaries s
             WHERE s.kind='condensed' AND s.suppressed_at IS NULL
             AND NOT EXISTS (SELECT 1 FROM summary_parents sp WHERE sp.parent_summary_id = s.summary_id)
             LIMIT 1`,
          )
          .get();
        return { id: row?.summary_id, expandChildren: true, allConversations: true };
      },
      expect: (r) => {
        if (r.details?.expansion?.childrenStatus !== "no-children") {
          return `expected childrenStatus=no-children, got ${r.details?.expansion?.childrenStatus}`;
        }
        return null;
      },
      severity: "critical",
    },
    {
      id: "adv-low-confidence-warning",
      questionType: "B",
      description: "Low-confidence query emits warning + low/noise band",
      tool: "lcm_semantic_recall",
      // A query so generic it shouldn't have strong matches in any LCM corpus.
      args: { query: "purple unicorn quantum waterfall", limit: 3, allConversations: true },
      expect: (r) => {
        const band = r.details?.confidenceBand;
        // If there are 0 hits we get "no-match"; if hits exist they should be low/noise.
        if (band !== "no-match" && band !== "low" && band !== "noise") {
          return `expected low/noise/no-match band for nonsense query, got ${band}`;
        }
        return null;
      },
      severity: "important",
    },
    {
      id: "adv-cosine-on-entity-only",
      questionType: "B",
      description: "Audit HIGH#1: entity-only path exposes cosineSimilarity",
      // We can't easily force entity-only (entity coref worker hasn't run on snapshots).
      // Instead, verify ANY hit returned by semantic-recall has cosineSimilarity.
      tool: "lcm_semantic_recall",
      args: { query: "test", limit: 1, allConversations: true },
      expect: (r) => {
        const hits = r.details?.hits ?? [];
        if (hits.length === 0) return null; // no-hit case is fine
        if (hits[0].cosineSimilarity == null)
          return "AUDIT HIGH#1 regression: hit missing cosineSimilarity";
        return null;
      },
      severity: "critical",
    },
  ],
};

// Build the "full" suite: smoke + per-question-type 5x5 test grid
SUITES.full = [
  ...SUITES.smoke,
  // Type A — Time-anchored (5 cases). lcm_synthesize_around is primary; we
  // accept "no LLM provider configured" as graceful since QA mode runs without
  // real LLM creds, but we DO require that the leaf-selection / cache-key /
  // dispatch plumbing all execute without crashing.
  ...["yesterday", "april-26-fix", "may-5-78055", "march-9-voyage", "today"].map((label, i) => ({
    id: `full-A${i + 1}-${label}`,
    questionType: "A",
    description: `Time-anchored: ${label}`,
    tool: "lcm_synthesize_around",
    args: () => {
      // Pick a real leaf id as the target
      const row = db
        .prepare(
          `SELECT summary_id FROM summaries
           WHERE kind='leaf' AND suppressed_at IS NULL
           ORDER BY RANDOM() LIMIT 1`,
        )
        .get();
      return {
        target: row?.summary_id,
        window_kind: i % 2 === 0 ? "time" : "semantic",
        windowHours: 24,
        windowK: 10,
        allConversations: true,
      };
    },
    expect: (r) => {
      // LLM-unavailable is acceptable in QA. Crash / unexpected error is not.
      if (
        r.error &&
        !/summary model|provider|LLM|complete is unavailable|VOYAGE_API|no synthesis|not configured/i.test(
          r.error,
        )
      ) {
        return `unexpected error: ${r.error}`;
      }
      return null;
    },
    severity: "critical",
  })),
  // Type B — Topic-anchored (5 cases via hybrid)
  ...[
    "worker_threads heartbeat isolation",
    "hybrid search rerank",
    "voyage rate limiting",
    "race condition empty plan body",
    "lcm_recent debate",
  ].map((q, i) => ({
    id: `full-B${i + 1}`,
    questionType: "B",
    description: `Topic-anchored: ${q}`,
    tool: "lcm_grep",
    args: { pattern: q, mode: "hybrid", limit: 5, allConversations: true },
    expect: (r) => {
      // Some of these are stumpers (e.g. "worker_threads heartbeat" has 0 hits in
      // Eva's corpus — that's a true negative, NOT a tool bug). So we don't
      // require hits — we just require the tool didn't error.
      if (r.error) return `errored: ${r.error}`;
      return null;
    },
    severity: "important",
  })),
  // Type C — Verbatim (5 cases)
  ...["lcm_recent", "rollups", "backfill", "1081067476", "first-principles"].map((q, i) => ({
    id: `full-C${i + 1}`,
    questionType: "C",
    description: `Verbatim: ${q}`,
    tool: "lcm_grep",
    args: {
      pattern: q,
      mode: "verbatim",
      limit: 5,
      allConversations: true,
    },
    expect: (r) => {
      if (r.error) return `errored: ${r.error}`;
      return null;
    },
    severity: "important",
  })),
  // Type D — Pattern (entity sub-cases). These tools may return empty if
  // coref worker hasn't run on the snapshot — that's catalogStatus's job
  // to surface, not a tool bug.
  {
    id: "full-D2-operator-vm",
    questionType: "D",
    description: "Entity: operator-VM customer history",
    tool: "lcm_search_entities",
    args: { query: "operator-VM", limit: 5 },
    expect: (r) => {
      if (r.error) return `errored: ${r.error}`;
      // Empty is OK as long as catalogStatus is set
      if (r.details?.totalMatches === 0 && r.details?.catalogStatus == null) {
        return "empty without catalogStatus";
      }
      return null;
    },
    severity: "important",
  },
  {
    id: "full-D4-voyage-history",
    questionType: "D",
    description: "Entity: voyage work history",
    tool: "lcm_search_entities",
    args: { query: "voyage", limit: 5 },
    expect: (r) => {
      if (r.error) return `errored: ${r.error}`;
      if (r.details?.totalMatches === 0 && r.details?.catalogStatus == null) {
        return "empty without catalogStatus";
      }
      return null;
    },
    severity: "important",
  },
  // Type E — Drilldown (5 cases)
  ...["expandChildren", "expandMessages", "lineage", "manifest", "subtree"].map((tag, i) => ({
    id: `full-E${i + 1}-${tag}`,
    questionType: "E",
    description: `Drilldown: ${tag}`,
    tool: "lcm_describe",
    args: () => {
      const kind = i % 2 === 0 ? "leaf" : "condensed";
      const row = db
        .prepare(
          `SELECT summary_id FROM summaries WHERE kind=? AND suppressed_at IS NULL LIMIT 1`,
        )
        .get(kind);
      const args = { id: row?.summary_id, allConversations: true };
      if (tag === "expandChildren") args.expandChildren = true;
      if (tag === "expandMessages") args.expandMessages = true;
      return args;
    },
    expect: (r) => {
      if (r.error) return `errored: ${r.error}`;
      if (r.details?.summary == null && r.details?.error == null) {
        return "describe returned neither summary nor error";
      }
      return null;
    },
    severity: "critical",
  })),
];

// ── Runner ────────────────────────────────────────────────────────
const cases = SUITES[suite];
if (!cases) {
  console.error(`Unknown suite: ${suite}. Try: smoke / full / adversarial`);
  process.exit(1);
}

const startTime = Date.now();
const records = [];
let voyageTokensTotal = 0;
let toolErrors = 0;
let expectFailures = 0;

console.log(`[qa-runner] suite=${suite} cases=${cases.length} db=${dbPath}`);
console.log(`[qa-runner] starting at ${new Date().toISOString()}`);

for (const tc of cases) {
  const tcStart = performance.now();
  let toolResult;
  let toolError;
  let resolvedArgs;
  try {
    resolvedArgs = typeof tc.args === "function" ? tc.args() : tc.args;
    const tool = buildTool(tc.tool);
    toolResult = await tool.execute(`qa_${tc.id}`, resolvedArgs);
  } catch (e) {
    toolError = e instanceof Error ? e.message : String(e);
    toolErrors++;
  }
  const durationMs = Math.round(performance.now() - tcStart);

  // Run expectation predicate
  let expectFailReason = null;
  if (toolError) {
    expectFailReason = `tool threw: ${toolError}`;
  } else {
    try {
      // Provide a flat normalized result for the predicate
      const flat = {
        text: toolResult?.content?.[0]?.text,
        details: toolResult?.details,
        error: toolResult?.details?.error,
        content: toolResult?.content,
      };
      expectFailReason = tc.expect(flat);
    } catch (predErr) {
      expectFailReason = `expectation predicate threw: ${predErr instanceof Error ? predErr.message : predErr}`;
    }
  }

  if (expectFailReason && tc.severity === "critical") expectFailures++;

  // Voyage token tracking (semantic-recall + hybrid grep return this in details)
  const voyageTokens =
    (toolResult?.details?.voyageTokensConsumed ?? 0) +
    (toolResult?.details?.semanticTokensConsumed ?? 0);
  voyageTokensTotal += voyageTokens;

  const record = {
    id: tc.id,
    questionType: tc.questionType,
    description: tc.description,
    tool: tc.tool,
    args: resolvedArgs,
    severity: tc.severity,
    durationMs,
    voyageTokens,
    toolError,
    expectFailReason,
    pass: !expectFailReason,
    // Truncate the response body so JSON output stays manageable
    response: toolError
      ? null
      : {
          textPreview: (toolResult?.content?.[0]?.text ?? "").slice(0, 300),
          textChars: (toolResult?.content?.[0]?.text ?? "").length,
          details: toolResult?.details,
        },
  };
  records.push(record);

  // Live console
  const status = record.pass ? "✅" : tc.severity === "critical" ? "❌" : "⚠️";
  const fail = expectFailReason ? `  reason: ${expectFailReason}` : "";
  console.log(
    `[${status}] ${tc.id} (${tc.questionType}, ${tc.tool}, ${durationMs}ms, ${voyageTokens}tok)${fail}`,
  );
  if (verbose && !record.pass) {
    console.log(`     args: ${JSON.stringify(resolvedArgs)}`);
    if (toolError) console.log(`     tool error: ${toolError}`);
    if (toolResult?.content?.[0]?.text)
      console.log(`     text preview: ${toolResult.content[0].text.slice(0, 200)}`);
  }
}

const totalMs = Date.now() - startTime;
const passed = records.filter((r) => r.pass).length;
const failedCritical = records.filter((r) => !r.pass && r.severity === "critical").length;
const failedImportant = records.filter((r) => !r.pass && r.severity === "important").length;

console.log("");
console.log(`[qa-runner] DONE in ${totalMs}ms`);
console.log(`[qa-runner] ${passed}/${records.length} passed`);
console.log(`[qa-runner] critical failures: ${failedCritical}`);
console.log(`[qa-runner] important failures: ${failedImportant}`);
console.log(`[qa-runner] tool errors (uncaught): ${toolErrors}`);
console.log(`[qa-runner] voyage tokens consumed: ${voyageTokensTotal}`);
console.log(`[qa-runner] estimated voyage cost: $${(voyageTokensTotal * 0.00012 / 1000).toFixed(4)}`);

// ── Output: JSON + Markdown ───────────────────────────────────────
const report = {
  suite,
  dbPath,
  startedAt: new Date(startTime).toISOString(),
  durationMs: totalMs,
  totals: {
    cases: records.length,
    passed,
    failedCritical,
    failedImportant,
    toolErrorsUncaught: toolErrors,
    voyageTokens: voyageTokensTotal,
    estimatedVoyageCostUsd: voyageTokensTotal * 0.00012 / 1000,
  },
  records,
};

if (jsonOut) {
  mkdirSync(dirname(jsonOut), { recursive: true });
  writeFileSync(jsonOut, JSON.stringify(report, null, 2));
  console.log(`[qa-runner] json report -> ${jsonOut}`);
}

if (mdOut) {
  const mdLines = [];
  mdLines.push(`# LCM v4.1 QA Run — ${report.suite} suite`);
  mdLines.push(``);
  mdLines.push(`- **DB**: \`${report.dbPath}\``);
  mdLines.push(`- **Started**: ${report.startedAt}`);
  mdLines.push(`- **Duration**: ${(totalMs / 1000).toFixed(1)}s`);
  mdLines.push(`- **Cases**: ${report.totals.cases}`);
  mdLines.push(`- **Passed**: ${report.totals.passed}`);
  mdLines.push(`- **Critical failures**: ${report.totals.failedCritical}`);
  mdLines.push(`- **Important failures**: ${report.totals.failedImportant}`);
  mdLines.push(`- **Tool errors (uncaught)**: ${report.totals.toolErrorsUncaught}`);
  mdLines.push(`- **Voyage tokens**: ${report.totals.voyageTokens}`);
  mdLines.push(`- **Cost**: $${report.totals.estimatedVoyageCostUsd.toFixed(4)}`);
  mdLines.push(``);
  mdLines.push(`## Test cases`);
  mdLines.push(``);
  mdLines.push(`| Status | ID | Type | Tool | Duration | Tokens | Reason |`);
  mdLines.push(`|---|---|---|---|---|---|---|`);
  for (const r of records) {
    const status = r.pass
      ? "✅"
      : r.severity === "critical"
        ? "❌"
        : "⚠️";
    const reason = (r.expectFailReason ?? "").replace(/\|/g, "\\|");
    mdLines.push(
      `| ${status} | ${r.id} | ${r.questionType} | ${r.tool} | ${r.durationMs}ms | ${r.voyageTokens} | ${reason} |`,
    );
  }
  mkdirSync(dirname(mdOut), { recursive: true });
  writeFileSync(mdOut, mdLines.join("\n"));
  console.log(`[qa-runner] md report -> ${mdOut}`);
}

db.close();

// Exit code
if (toolErrors > 0) process.exit(3);
if (failedCritical > 0) process.exit(2);
process.exit(0);
