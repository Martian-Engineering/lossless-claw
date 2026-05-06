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
// Wave-9 Agent #11 P1 fix: previously hardcoded `process.chdir("/tmp/...")`,
// which broke the harness on every machine except the one with that exact
// path checkout. Now the script must be run from the repo root (same as
// every other v41-* harness) — error fast with a clear message instead of
// silently chdir'ing to a non-existent path.
{
  const cwd = process.cwd();
  const sentinel = `${cwd}/src/embeddings/store.ts`;
  if (!existsSync(sentinel)) {
    console.error(
      `[v41-qa-runner] Run from the repo root (couldn't find ${sentinel}). ` +
        `cwd=${cwd}`,
    );
    process.exit(1);
  }
}

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
        // Wave-10 fix: filter to production-shaped IDs (sum_*) so harness-
        // inserted test leaves with non-conforming prefixes don't trip
        // synthesize_around's target validation. Anchor on a real recent
        // sum_-prefixed leaf so the time window has content.
        const row = db
          .prepare(
            `SELECT summary_id FROM summaries
             WHERE kind='leaf' AND suppressed_at IS NULL
               AND summary_id LIKE 'sum_%'
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
        // Wave-1 Auditor #9 finding #4: SELECT … LIMIT 1 without ORDER BY
        // is non-deterministic. Sort by summary_id (stable) so re-runs
        // pick the same leaf and report deltas vs prior runs cleanly.
        // Wave-10 fix: filter to sum_-prefixed IDs (production shape) so
        // harness-inserted test data with other prefixes doesn't trip the
        // describe tool's id-prefix validation.
        const row = db
          .prepare(
            `SELECT summary_id FROM summaries
               WHERE kind='leaf' AND suppressed_at IS NULL
                 AND summary_id LIKE 'sum_%'
               ORDER BY summary_id ASC LIMIT 1`,
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
      // Wave-10 fix v2: previously hardcoded 2026-05-05 to 2026-05-07
      // (time-bombed). Wave-10 v1 used a fixed query against latest-48h
      // (failed when snapshot had insufficient embedded content). Now
      // pick an actually-embedded leaf in the latest window and use its
      // own content as the query — guarantees the test can pass when
      // semantic recall is working, fails only when it's actually broken.
      args: () => {
        const seed = db
          .prepare(
            `SELECT s.summary_id, s.content, s.latest_at
               FROM summaries s
               JOIN lcm_embedding_meta m
                 ON m.embedded_id = s.summary_id AND m.embedded_kind='summary' AND m.archived = 0
               WHERE s.kind='leaf' AND s.suppressed_at IS NULL
               ORDER BY s.latest_at DESC
               LIMIT 1`,
          )
          .get();
        if (!seed) {
          // No embedded leaves at all — sentinel query that we'll accept
          // 0-hits on (predicate checks the same condition).
          return {
            query: "__qa_noop_no_embedded_content__",
            limit: 5,
            allConversations: true,
          };
        }
        const seedMs = new Date(seed.latest_at).getTime();
        const since = new Date(seedMs - 1 * 60 * 60 * 1000).toISOString();
        const before = new Date(seedMs + 1 * 60 * 60 * 1000).toISOString();
        // Use first 8 words of the seed leaf's content as the query.
        // Semantic recall on Voyage SHOULD find the seed itself or
        // very-close neighbors.
        const queryWords = String(seed.content)
          .replace(/\s+/g, " ")
          .trim()
          .split(" ")
          .slice(0, 8)
          .join(" ");
        return {
          query: queryWords,
          limit: 5,
          allConversations: true,
          since,
          before,
        };
      },
      expect: (r) => {
        // Re-check whether the snapshot has any embedded content at all.
        // If it doesn't, accept 0-hits as not-a-regression (the test is
        // gated on infrastructure availability, not on tool correctness).
        const embeddedCount = db
          .prepare(
            `SELECT COUNT(*) AS n FROM lcm_embedding_meta WHERE embedded_kind='summary' AND archived = 0`,
          )
          .get()?.n ?? 0;
        if (embeddedCount === 0) return null; // Snapshot empty; can't test.
        const hits = r.details?.hits ?? [];
        if (hits.length === 0) {
          return `P1 regression: 0 hits when querying with a seed leaf's own content (snapshot has ${embeddedCount} embedded leaves) — semantic recall pipeline is broken`;
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
      description:
        "Empty pattern in verbatim mode shouldn't crash + should produce an actionable error or 0 matches",
      tool: "lcm_grep",
      args: { pattern: "", mode: "verbatim", limit: 3, allConversations: true },
      // Wave-1 Auditor #9 finding #1: previous predicate returned null in
      // both branches (vacuous). Now we ASSERT either (a) graceful error
      // visible in details.error/text OR (b) 0 matches with no exception.
      // A tool that crashes hard would set toolError → expectFailReason
      // upstream regardless.
      expect: (r) => {
        const explicitError = Boolean(r.error || r.details?.error);
        const zeroMatches = (r.details?.totalMatches ?? r.details?.hits?.length ?? 0) === 0;
        if (!explicitError && !zeroMatches) {
          return "empty-pattern produced neither a graceful error nor 0 matches — verify FTS5 didn't process \"\" as a real query";
        }
        return null;
      },
      severity: "important",
    },
    // Wave-1 Auditor #9 finding #2: QA runner missed 3 of 8 tools
    // (lcm_get_entity, lcm_expand_query, lcm_expand). Add at least one
    // smoke per missing tool so the harness exercises the full surface.
    {
      id: "adv-lcm-get-entity-smoke",
      questionType: "D",
      description:
        "lcm_get_entity returns either entity record, graceful 'not-found' (found:false), or graceful error (auditor #9 #2 — tool was uncovered)",
      tool: "lcm_get_entity",
      args: { name: "voyage", allConversations: true },
      expect: (r) => {
        if (r.error) return `lcm_get_entity errored: ${r.error}`;
        // Acceptable shapes:
        //   1. {found: true, entityId, ...}
        //   2. {found: false, message, ...}
        //   3. {error, ...}
        const d = r.details ?? {};
        if (d.found === true) return d.entityId == null ? "found:true but no entityId" : null;
        if (d.found === false) return d.message ? null : "found:false but no message";
        if (d.entityId != null) return null;
        if (d.error) return null;
        return `unrecognized response shape — keys: ${Object.keys(d).join(",")}`;
      },
      severity: "critical",
    },
    {
      id: "adv-lcm-expand-query-smoke",
      questionType: "E",
      description:
        "lcm_expand_query (main wrapper for sub-agent expand) accepts query + prompt; returns dispatch handle or graceful error",
      tool: "lcm_expand_query",
      // Wave-9 Agent #11 P1 fix: previously omitted `prompt` (required by
      // schema), so test only hit the schema-validation early-return.
      // Now exercise the full dispatch path with a real prompt + query.
      args: {
        query: "voyage embeddings backfill",
        prompt: "What work has been done on Voyage embeddings backfill?",
        allConversations: true,
      },
      expect: (r) => {
        // Wave-9 Agent #11 P1 fix: actual predicate that distinguishes
        // graceful-degraded (LLM/grant missing) from catastrophic-crash.
        if (r.error) {
          // Graceful errors mention LLM, provider, delegated, subagent,
          // grant, prompt, or session. Anything else is unexpected.
          if (
            /LLM|provider|delegated|subagent|grant|prompt|sessionKey|caller|complete is unavailable|VOYAGE_API/i.test(
              String(r.error),
            )
          ) {
            return null;
          }
          return `unexpected error: ${r.error}`;
        }
        // Success path: should return answer + citedIds.
        if (typeof r.details?.answer !== "string") return "missing details.answer";
        if (!Array.isArray(r.details?.citedIds)) return "missing details.citedIds";
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
        // Determinism: stable ORDER BY per Auditor #9 finding #4
        const row = db
          .prepare(
            `SELECT summary_id FROM summaries
               WHERE kind='leaf' AND suppressed_at IS NULL
               ORDER BY summary_id ASC LIMIT 1`,
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
    // Wave-9 Agent #11 P1 fix: cover the regex + full_text grep modes
    // that previously had ZERO harness coverage. They return a different
    // shape (totalMatches/messageCount/summaryCount, not details.hits)
    // so the predicate validates that distinct contract.
    {
      id: "adv-grep-mode-regex-shape",
      questionType: "B",
      description: "lcm_grep mode='regex' returns totalMatches/messageCount/summaryCount shape (not hits)",
      tool: "lcm_grep",
      args: { pattern: "rebase", mode: "regex", limit: 5, allConversations: true },
      expect: (r) => {
        if (r.error) return `regex mode errored: ${r.error}`;
        if (typeof r.details?.totalMatches !== "number") return "missing details.totalMatches";
        if (typeof r.details?.messageCount !== "number") return "missing details.messageCount";
        if (typeof r.details?.summaryCount !== "number") return "missing details.summaryCount";
        return null;
      },
      severity: "important",
    },
    {
      id: "adv-grep-mode-fulltext-shape",
      questionType: "B",
      description: "lcm_grep mode='full_text' returns FTS-shape result (not hits)",
      tool: "lcm_grep",
      args: { pattern: "voyage embedding", mode: "full_text", limit: 5, allConversations: true },
      expect: (r) => {
        if (r.error) return `full_text mode errored: ${r.error}`;
        if (typeof r.details?.totalMatches !== "number") return "missing details.totalMatches";
        if (typeof r.details?.messageCount !== "number") return "missing details.messageCount";
        if (typeof r.details?.summaryCount !== "number") return "missing details.summaryCount";
        return null;
      },
      severity: "important",
    },
    // Wave-9 Agent #11 P1 fix: period mode is the lcm_recent replacement
    // and was never exercised by any harness. Cover the shortcut parser
    // and the period-mode dispatch path.
    {
      id: "adv-synthesize-period-yesterday",
      questionType: "A",
      description: "lcm_synthesize_around period='yesterday' (lcm_recent replacement)",
      tool: "lcm_synthesize_around",
      // Wave-10 reviewer P2 fix: previously omitted `window_kind: "period"`
      // which the tool requires — without it, the tool returned
      // `"window_kind must be 'time', 'semantic', or 'period'"` and the
      // predicate's regex match on `period` made it trivially pass without
      // ever exercising the period-dispatch code path.
      args: {
        window_kind: "period",
        period: "yesterday",
        allConversations: true,
      },
      expect: (r) => {
        // Same graceful-error shape as full-A1..A5: LLM unavailable OK,
        // crash / unexpected error not OK. Also accept "no leaves in
        // window" since a fresh corpus may legitimately have nothing
        // for "yesterday". (Removed bare 'period' from the regex so the
        // schema-validation early-return no longer trivially matches.)
        if (
          r.error &&
          !/summary model|provider|LLM|complete is unavailable|VOYAGE_API|no synthesis|not configured|no leaves|empty/i.test(
            String(r.error),
          )
        ) {
          return `unexpected error: ${r.error}`;
        }
        return null;
      },
      severity: "important",
    },
    {
      id: "adv-synthesize-period-last-7d",
      questionType: "A",
      description: "lcm_synthesize_around period='last-7d' (hyphenated short form)",
      tool: "lcm_synthesize_around",
      // Wave-10 reviewer P2 fix: same window_kind requirement.
      args: {
        window_kind: "period",
        period: "last-7d",
        allConversations: true,
      },
      expect: (r) => {
        if (
          r.error &&
          !/summary model|provider|LLM|complete is unavailable|VOYAGE_API|no synthesis|not configured|no leaves|empty/i.test(
            String(r.error),
          )
        ) {
          return `unexpected error: ${r.error}`;
        }
        return null;
      },
      severity: "important",
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
      // Determinism (Auditor #9 finding #3): instead of ORDER BY RANDOM(),
      // pick a different leaf per case index using OFFSET, sorted stably.
      // Same DB + same case = same leaf, every run.
      // Wave-2 Auditor #9 fix HIGH-2: if OFFSET exceeds row count, fall
      // back to OFFSET 0 (the first leaf) instead of getting `undefined`
      // and silently passing because the predicate accepts any error.
      const offset = i * 7;
      let row = db
        .prepare(
          `SELECT summary_id FROM summaries
           WHERE kind='leaf' AND suppressed_at IS NULL
           ORDER BY summary_id ASC LIMIT 1 OFFSET ?`,
        )
        .get(offset);
      if (!row?.summary_id) {
        row = db
          .prepare(
            `SELECT summary_id FROM summaries
             WHERE kind='leaf' AND suppressed_at IS NULL
             ORDER BY summary_id ASC LIMIT 1`,
          )
          .get();
      }
      if (!row?.summary_id) {
        // Empty corpus — return a sentinel that the predicate can detect.
        return { target: "__NO_LEAVES_IN_CORPUS__", window_kind: "time", windowHours: 24, windowK: 10, allConversations: true };
      }
      return {
        target: row.summary_id,
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
      // require hits — we just require the tool didn't error AND that it
      // returned a structured response with hits as an array.
      // Wave-2 Auditor #9 fix HIGH-3: tightened to assert response shape.
      if (r.error) return `errored: ${r.error}`;
      if (!Array.isArray(r.details?.hits)) {
        return `details.hits is not an array — broken response shape (got ${typeof r.details?.hits})`;
      }
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
      // Wave-2 Auditor #9 fix HIGH-3: also assert response shape, not
      // just that there was no error.
      if (r.error) return `errored: ${r.error}`;
      if (!Array.isArray(r.details?.hits)) {
        return `details.hits is not an array — broken response shape (got ${typeof r.details?.hits})`;
      }
      // Verbatim hits should ALL have content + role + createdAt fields.
      // If any hit is missing these, response shape regression.
      for (const h of r.details.hits) {
        if (typeof h.content !== "string") return "verbatim hit missing content";
        if (typeof h.role !== "string") return "verbatim hit missing role";
      }
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
      // Determinism: stable ORDER BY (Auditor #9 finding #4)
      const row = db
        .prepare(
          `SELECT summary_id FROM summaries
             WHERE kind=? AND suppressed_at IS NULL
             ORDER BY summary_id ASC LIMIT 1 OFFSET ?`,
        )
        .get(kind, i);
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
// Wave-1 Auditor #9 finding #12: cost rate constant was 0.00012/1000.
// voyage-4-large is $0.18 per 1M tokens = $0.00018 per 1K tokens.
// Previously we under-reported by ~33%.
const VOYAGE_4_LARGE_COST_PER_1K = 0.00018;
console.log(
  `[qa-runner] estimated voyage cost: $${((voyageTokensTotal * VOYAGE_4_LARGE_COST_PER_1K) / 1000).toFixed(4)}`,
);

// ── Output: JSON + Markdown ───────────────────────────────────────
const report = {
  // Wave-1 Auditor #9 finding #5: explicit schema version so downstream
  // consumers can detect breaking changes across QA-runner releases.
  schemaVersion: "1.0.0",
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
    // Wave-1 Auditor #9 finding #12: corrected rate (was 0.00012/1k → 0.00018/1k)
    estimatedVoyageCostUsd: (voyageTokensTotal * VOYAGE_4_LARGE_COST_PER_1K) / 1000,
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
// Wave-10 reviewer P2 fix: failedImportant previously had no exit branch,
// so an "important" failure printed in the report but the process still
// exited 0 — turning the runner into an advisory tool instead of a release
// gate. Exit codes:
//   3 = tool errors (uncaught exceptions; runner itself is broken)
//   2 = critical failure (must-pass scenario regressed)
//   1 = important failure (should-pass scenario regressed; release gate)
//   0 = all important+critical pass (warnings allowed)
if (toolErrors > 0) process.exit(3);
if (failedCritical > 0) process.exit(2);
if (failedImportant > 0) process.exit(1);
process.exit(0);
