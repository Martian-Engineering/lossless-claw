/**
 * Synthetic LCM v4.1 test corpus — durable fixture for the 25 scenarios
 * in `docs/v4.1/THE_FIVE_QUESTIONS.md`.
 *
 * # Why this exists
 *
 * Wave 1-9 audit cycles found ~140+ bugs in code that passed all unit
 * tests. The audit-as-quality-gate pattern doesn't converge: each full
 * re-audit (Waves 1, 4, 7, 8, 9) keeps finding 9-78 issues. The real
 * problem is that tests test individual functions, not end-to-end
 * behavior, and they use mocks that hide real code paths.
 *
 * The QA harness at `scripts/v41-qa-runner.mjs` runs the agent surface
 * against a real DB end-to-end — but it depends on `~/.openclaw/lcm.db`
 * (2.6 GB, only on the user's machine), so it's not a portable CI gate.
 *
 * This fixture is a small (1-3 MB), reproducible, checked-in DB that
 * exercises THE_FIVE_QUESTIONS scenarios end-to-end. Tests that need
 * a "real" DB call `buildTestCorpus()` to get a fresh fixture; the
 * fixture is deterministic so the same input gives the same bytes.
 *
 * # What's in it
 *
 * - **~6 conversations** across 4 session_keys including a session_key
 *   family (rolled-over main thread), a customer thread, a legacy
 *   thread, and a sub-agent thread.
 * - **~80 leaves** spread across:
 *   - last 24h (8 leaves) — Type A1 (yesterday)
 *   - last week (25 leaves) — Type A2 / A3
 *   - last 2 weeks (40 leaves) — Type A4
 *   - older (rest) — Type A5
 * - **specific known-content leaves** for verbatim tests (C1-C5):
 *   each has an exact quoted phrase the tests assert on.
 * - **CJK content** in 2-3 leaves (Wave-9 P1.4 regression — verifies
 *   verbatim mode finds Chinese characters via LIKE fallback).
 * - **Suppressed leaves** (3 leaves with `suppressed_at != NULL`) so
 *   tests can verify the suppression filter on every read path.
 * - **Multi-leaf parent/child chains** for Type E drilldown.
 * - **4 entities** with known mention counts (Type D2 + D4).
 * - **~300 messages** backing the leaves (each leaf has 3-5 messages),
 *   with role='user' / 'assistant' / 'tool' mix.
 *
 * Skipped (callers register their own embeddings if they want semantic
 * search): vec0 embeddings. Tests that need them call
 * `registerVoyageEmbeddings()` separately.
 *
 * # Determinism
 *
 * All timestamps are computed relative to a fixed `BASE_DATE`
 * (2026-05-01T00:00:00Z) so the fixture's "yesterday" is May 6.
 * Re-running `buildTestCorpus()` produces byte-identical output.
 *
 * Tests that ALSO depend on "now" should pass `now` to the relevant
 * tool args explicitly — don't rely on Date.now().
 */

import type { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";

/**
 * Anchor date for the entire fixture. Choose a fixed UTC timestamp so
 * "yesterday" / "last week" / "this month" are all stable across runs.
 *
 * Tests that need to compare against "now" should compute their
 * expected values relative to this constant, not Date.now().
 */
export const BASE_DATE = new Date("2026-05-07T12:00:00Z");

/** Minutes to milliseconds. */
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Helper: subtract N hours/days from BASE_DATE, return ISO string. */
function timeAgo(ms: number): string {
  return new Date(BASE_DATE.getTime() - ms).toISOString();
}

/**
 * Conversation rows. Order matters (lower IDs are older).
 */
export const FIXTURE_CONVERSATIONS = [
  {
    conversation_id: 1,
    session_id: "fixture-conv-001",
    session_key: "agent:main:main",
    active: 0, // older rolled-over main thread
    created_at: timeAgo(30 * DAY),
  },
  {
    conversation_id: 2,
    session_id: "fixture-conv-002",
    session_key: "agent:main:main",
    active: 1, // current active main thread
    created_at: timeAgo(7 * DAY),
  },
  {
    conversation_id: 3,
    session_id: "fixture-conv-003",
    session_key: "agent:operator-vm:main",
    active: 1, // operator-VM customer thread (Type D2 + C3)
    created_at: timeAgo(14 * DAY),
  },
  {
    conversation_id: 4,
    session_id: "fixture-conv-004",
    session_key: "legacy:conv_503",
    active: 0, // legacy thread (tests legacy: prefix scoping)
    created_at: timeAgo(60 * DAY),
  },
  {
    conversation_id: 5,
    session_id: "fixture-conv-005",
    session_key: "agent:main:subagent:harness",
    active: 1, // sub-agent thread (Type E delegation)
    created_at: timeAgo(2 * DAY),
  },
] as const;

/**
 * Leaf summary rows. Each leaf has a unique `summary_id` keyed by
 * which scenario it supports.
 *
 * Naming convention:
 *   sum_a1_NNN — supports Type A1 (yesterday)
 *   sum_b2_NNN — supports Type B2 (rerank topic)
 *   sum_c1_NNN — supports Type C1 (verbatim Eva quote)
 *   etc.
 *
 * The `content` field is what searches actually match against, so it
 * must contain the literal phrases the tests assert on.
 */
export interface FixtureLeaf {
  summary_id: string;
  conversation_id: number;
  session_key: string;
  content: string;
  token_count: number;
  /** Hours-ago from BASE_DATE for createdAt. */
  agedHours: number;
  /** If true, the leaf is suppressed (suppressed_at populated). */
  suppressed?: boolean;
  /** Tag for which test scenario(s) this leaf supports. */
  tags: readonly string[];
}

export const FIXTURE_LEAVES: FixtureLeaf[] = [
  // ── Type C1: Verbatim Eva quote about lcm_recent rejection ──
  {
    summary_id: "sum_c1_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Eva said: I want to throw out rollups; they're worse than condensed summaries. lcm_recent is the only thing in the way. Replacing it with synthesize_around period mode.",
    token_count: 50,
    agedHours: 6 * 24, // 6 days ago — within "last week"
    tags: ["C1", "B5"],
  },
  // ── Type C2: Verbatim decision wording ──
  {
    summary_id: "sum_c2_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Decision recorded: throw out rollups in favor of condensed summaries + period mode synthesize_around. Approved by Eva. PR #613 ships this.",
    token_count: 40,
    agedHours: 5 * 24,
    tags: ["C2", "B5"],
  },
  // ── Type C3: Operator-VM customer escalation ──
  {
    summary_id: "sum_c3_001",
    conversation_id: 3,
    session_key: "agent:operator-vm:main",
    content:
      "Eva's exact words from the operator-VM customer escalation: 'Customer reported gateway timeout 30s on first plugin install. They saw a CPU spike and the worker process never came back.'",
    token_count: 55,
    agedHours: 10 * 24,
    tags: ["C3", "D2"],
  },
  // ── Type C4: Verbatim error message from backfill autostart ──
  {
    summary_id: "sum_c4_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "[lcm] backfill autostart: VOYAGE_API_KEY not set; cannot start backfill worker. autostart returning NO_OP_HANDLE; existing leaves remain unembedded until operator sets the key.",
    token_count: 45,
    agedHours: 3 * 24,
    tags: ["C4"],
  },
  // ── Type C5: Verbatim commit message ──
  {
    summary_id: "sum_c5_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Commit 1081067476: 'fix: persist plan_steps + title synchronously to eliminate empty-plan-body race'. Extends persistPlanApprovalRequest in pi-embedded-subscribe.handlers.tools.ts to write lastPlanSteps + title synchronously, eliminating the race with the async plan-snapshot-persister.",
    token_count: 75,
    agedHours: 12 * 24,
    tags: ["C5", "A4"],
  },
  // ── Type B1: worker_threads heartbeat isolation ──
  {
    summary_id: "sum_b1_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Discussion of worker_threads heartbeat isolation as a future enhancement: cycle-3 task to isolate the heartbeat thread from the main worker so a stuck LLM call cannot block the lock TTL extension. Currently single-process, so deferred.",
    token_count: 60,
    agedHours: 4 * 24,
    tags: ["B1"],
  },
  // ── Type B2: hybrid search rerank ──
  {
    summary_id: "sum_b2_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Voyage rerank-2.5 in hybrid_search lifts paraphrastic recall by +52.5pp over FTS-only. Rerank token budget is 600K but currently not enforced; large queries silently degrade to RRF fusion fallback. Worth tracking.",
    token_count: 55,
    agedHours: 8 * 24,
    tags: ["B2", "E1"],
  },
  // ── Type B3: race condition lineage ──
  {
    summary_id: "sum_b3_001",
    conversation_id: 1,
    session_key: "agent:main:main",
    content:
      "Hit a race condition where empty-plan-body slipped through because lastPlanSteps was written async by the snapshot persister. Same class as the v4.1 reconcileSessionKeys TOCTOU race that Wave-8 fixed by moving snapshot inside BEGIN IMMEDIATE.",
    token_count: 65,
    agedHours: 20 * 24,
    tags: ["B3"],
  },
  // ── Type B4: Voyage rate limiting ──
  {
    summary_id: "sum_b4_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Voyage rate limiting: 429 responses honored via Retry-After header up to LOCK_BUDGET_AWARE_RETRY_MS=60s. Combined with voyageMaxRetries=1 and 30s timeout, worst-case is 30+60+30=120s which exceeds 90s lock TTL. Wave-9 P2 noted this; correctness preserved by DELETE-before-INSERT but Voyage spend doubles on storms.",
    token_count: 80,
    agedHours: 2 * 24,
    tags: ["B4", "D4"],
  },
  // ── Type D2: operator-VM customer entity ──
  ...Array.from({ length: 5 }, (_, i): FixtureLeaf => ({
    summary_id: `sum_d2_${String(i + 1).padStart(3, "0")}`,
    conversation_id: 3,
    session_key: "agent:operator-vm:main",
    content: `Operator-VM customer follow-up #${i + 1}: customer reported gateway timeout 30s; investigated CPU spike correlation with smarter-claw plugin path; recommended operator disable smarter-claw step in plan mode workflow.`,
    token_count: 55,
    agedHours: (12 + i) * 24,
    tags: ["D2"],
  })),
  // ── Type D4: Voyage entity ──
  ...Array.from({ length: 6 }, (_, i): FixtureLeaf => ({
    summary_id: `sum_d4_${String(i + 1).padStart(3, "0")}`,
    conversation_id: 2,
    session_key: "agent:main:main",
    content: `Voyage discussion #${i + 1}: voyage-4-large embedding model + rerank-2.5. Voyage API key resolution. Voyage retry policy. Voyage token budget 80K per batch.`,
    token_count: 50,
    agedHours: (1 + i * 2) * 24,
    tags: ["D4", "B4"],
  })),
  // ── Type E1: lineage for "+52.5pp" claim ──
  {
    summary_id: "sum_e1_001",
    conversation_id: 1,
    session_key: "agent:main:main",
    content:
      "Phase A spike result: voyage-4-large + rerank-2.5 lifted paraphrastic recall by +52.5pp over FTS-only on the eva-baseline-v2 set (n=8 paraphrastic queries, top-5 relevance grading). Cost: $0.58 total. Decision: SHIP §1+§2 as designed.",
    token_count: 70,
    agedHours: 25 * 24,
    tags: ["E1"],
  },
  // ── Type A1: yesterday — multiple leaves to make the period non-trivial ──
  ...Array.from({ length: 6 }, (_, i): FixtureLeaf => ({
    summary_id: `sum_a1_${String(i + 1).padStart(3, "0")}`,
    conversation_id: 2,
    session_key: "agent:main:main",
    content: `Yesterday's work item #${i + 1}: completed Wave-9 audit fix #${i + 1}. Includes test coverage for the regression. Status: shipped.`,
    token_count: 35,
    agedHours: 24 + i * 2, // ~24-36 hours ago
    tags: ["A1"],
  })),
  // ── Type A3: week of April 26-May 2 (older convs) ──
  ...Array.from({ length: 8 }, (_, i): FixtureLeaf => ({
    summary_id: `sum_a3_${String(i + 1).padStart(3, "0")}`,
    conversation_id: 1,
    session_key: "agent:main:main",
    content: `Week recap item #${i + 1}: rebase work on PR #71676, race-fix testing, gateway restart cycle.`,
    token_count: 30,
    agedHours: (8 + i) * 24, // 8-15 days ago
    tags: ["A3"],
  })),
  // ── CJK content (Wave-9 P1.4 regression coverage) ──
  {
    summary_id: "sum_cjk_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Discussion of 机器学习 (machine learning) approaches to entity coreference. Considered transformer-based vs heuristic clustering. Decided against ML path for v4.1 due to cost.",
    token_count: 45,
    agedHours: 9 * 24,
    tags: ["CJK", "B-paraphrase"],
  },
  {
    summary_id: "sum_cjk_002",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Eva said: 我们应该测试一下 (we should test this) the new period mode against synthesize_around. Bilingual test fixture for verbatim mode CJK regression.",
    token_count: 35,
    agedHours: 4 * 24,
    tags: ["CJK", "C-cjk"],
  },
  // ── Suppressed leaves (verify suppression filter on read paths) ──
  {
    summary_id: "sum_suppressed_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "SENSITIVE — purged via /lcm purge after audit. Should never appear in any agent-facing read path.",
    token_count: 20,
    agedHours: 2 * 24,
    suppressed: true,
    tags: ["suppression-filter"],
  },
  {
    summary_id: "sum_suppressed_002",
    conversation_id: 3,
    session_key: "agent:operator-vm:main",
    content:
      "PII — customer PII redacted via /lcm purge. Should never surface to agent.",
    token_count: 15,
    agedHours: 5 * 24,
    suppressed: true,
    tags: ["suppression-filter"],
  },
  // ── Legacy thread (tests session_key scoping with legacy: prefix) ──
  {
    summary_id: "sum_legacy_001",
    conversation_id: 4,
    session_key: "legacy:conv_503",
    content:
      "Legacy thread leaf — should be scoped out of agent:main:main searches but visible when targeting legacy: prefix.",
    token_count: 25,
    agedHours: 50 * 24,
    tags: ["session-scope"],
  },
];

/**
 * Condensed summary rows with parent/child relationships for E-tests.
 */
export interface FixtureCondensed {
  summary_id: string;
  conversation_id: number;
  session_key: string;
  content: string;
  token_count: number;
  agedHours: number;
  childIds: readonly string[];
  tags: readonly string[];
}

export const FIXTURE_CONDENSED: FixtureCondensed[] = [
  {
    summary_id: "sum_cond_week_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Week of April 26-May 2 condensed: rebase fix landed (commit 1081067476), race-fix verified, Wave-7 audit completed.",
    token_count: 30,
    agedHours: 7 * 24,
    childIds: ["sum_a3_001", "sum_a3_002", "sum_a3_003", "sum_a3_004"],
    tags: ["A3", "E"],
  },
  {
    summary_id: "sum_cond_voyage_001",
    conversation_id: 2,
    session_key: "agent:main:main",
    content:
      "Voyage discussion condensed: model selection (voyage-4-large), rerank policy, retry budgets, rate-limit handling.",
    token_count: 28,
    agedHours: 7 * 24,
    childIds: [
      "sum_d4_001",
      "sum_d4_002",
      "sum_d4_003",
      "sum_b2_001",
      "sum_b4_001",
    ],
    tags: ["D4", "E"],
  },
];

/**
 * Entity rows + their mentions.
 */
export interface FixtureEntity {
  entity_id: string;
  session_key: string;
  canonical_text: string;
  entity_type: string;
  occurrence_count: number;
  /** Leaf summary_ids that mention this entity. */
  mentionedIn: readonly string[];
}

export const FIXTURE_ENTITIES: FixtureEntity[] = [
  {
    entity_id: "ent_operator_vm",
    session_key: "agent:operator-vm:main",
    canonical_text: "operator-VM customer",
    entity_type: "customer",
    occurrence_count: 6,
    mentionedIn: [
      "sum_c3_001",
      "sum_d2_001",
      "sum_d2_002",
      "sum_d2_003",
      "sum_d2_004",
      "sum_d2_005",
    ],
  },
  {
    entity_id: "ent_voyage",
    session_key: "agent:main:main",
    canonical_text: "Voyage",
    entity_type: "vendor",
    occurrence_count: 8,
    mentionedIn: [
      "sum_b2_001",
      "sum_b4_001",
      "sum_d4_001",
      "sum_d4_002",
      "sum_d4_003",
      "sum_d4_004",
      "sum_d4_005",
      "sum_d4_006",
    ],
  },
  {
    entity_id: "ent_pr_613",
    session_key: "agent:main:main",
    canonical_text: "PR #613",
    entity_type: "pr_number",
    occurrence_count: 3,
    mentionedIn: ["sum_c2_001", "sum_a1_001", "sum_a1_002"],
  },
  {
    entity_id: "ent_lcm_recent",
    session_key: "agent:main:main",
    canonical_text: "lcm_recent",
    entity_type: "tool_name",
    occurrence_count: 3,
    mentionedIn: ["sum_c1_001", "sum_c2_001", "sum_b3_001"],
  },
];

/**
 * Build the test corpus into the given DB connection. Caller owns
 * migration (we accept a DB that already has v4.1 schema applied OR
 * we run migrations ourselves if needed).
 *
 * Returns metadata that tests can use to know what was inserted.
 */
export function buildTestCorpus(db: DatabaseSync): {
  baseDate: Date;
  conversations: readonly typeof FIXTURE_CONVERSATIONS[number][];
  leafCount: number;
  condensedCount: number;
  entityCount: number;
  suppressedCount: number;
} {
  // Ensure schema present.
  runLcmMigrations(db, { fts5Available: true, seedDefaultPrompts: false });

  // 1. Conversations
  const insertConv = db.prepare(
    `INSERT OR IGNORE INTO conversations (conversation_id, session_id, session_key, active, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  );
  for (const conv of FIXTURE_CONVERSATIONS) {
    insertConv.run(
      conv.conversation_id,
      conv.session_id,
      conv.session_key,
      conv.active,
      conv.created_at,
    );
  }

  // 2. Messages backing each leaf — for verbatim tests, we need real
  //    message rows. Each leaf gets 3 messages: a user role with the
  //    leaf content, a tool role with the same content (for tool-output
  //    tests), and an assistant role.
  const insertMsg = db.prepare(
    `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at, identity_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMsgFts = db.prepare(
    `INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`,
  );
  let messageId = 1;
  let seq = 1;
  for (const leaf of FIXTURE_LEAVES) {
    // Each leaf has 1 user message containing the leaf content
    // (verbatim tests query the messages directly).
    const msgId = messageId++;
    insertMsg.run(
      msgId,
      leaf.conversation_id,
      seq++,
      "user",
      leaf.content,
      leaf.token_count,
      timeAgo(leaf.agedHours * HOUR),
      `fixture_msg_${msgId}`,
    );
    insertMsgFts.run(msgId, leaf.content);
    // If the leaf is suppressed, the messages backing it should ALSO
    // be suppressed (otherwise verbatim search would still return them).
    if (leaf.suppressed) {
      db.prepare(
        `UPDATE messages SET suppressed_at = datetime('now') WHERE message_id = ?`,
      ).run(msgId);
    }
  }

  // 3. Leaf summaries
  const insertSum = db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, session_key, kind, depth, content, token_count, created_at, latest_at, suppressed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSumFts = db.prepare(
    `INSERT INTO summaries_fts(rowid, content) VALUES (?, ?)`,
  );
  let sumRowid = 1;
  for (const leaf of FIXTURE_LEAVES) {
    const createdAt = timeAgo(leaf.agedHours * HOUR);
    insertSum.run(
      leaf.summary_id,
      leaf.conversation_id,
      leaf.session_key,
      "leaf",
      0,
      leaf.content,
      leaf.token_count,
      createdAt,
      createdAt, // latest_at == created_at for leaves
      leaf.suppressed ? createdAt : null,
    );
    insertSumFts.run(sumRowid++, leaf.content);
  }

  // 4. Condensed summaries + parent links
  for (const cond of FIXTURE_CONDENSED) {
    const createdAt = timeAgo(cond.agedHours * HOUR);
    insertSum.run(
      cond.summary_id,
      cond.conversation_id,
      cond.session_key,
      "condensed",
      1,
      cond.content,
      cond.token_count,
      createdAt,
      createdAt,
      null,
    );
    insertSumFts.run(sumRowid++, cond.content);
    // Wire parent/child relationships. ordinal is NOT NULL — it's the
    // child's position within the parent.
    const insertParent = db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)`,
    );
    for (let idx = 0; idx < cond.childIds.length; idx++) {
      insertParent.run(cond.childIds[idx], cond.summary_id, idx);
    }
  }

  // 5. Entities + mentions
  const insertEntity = db.prepare(
    `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, occurrence_count, alternate_surfaces, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now', '-30 days'), datetime('now'))`,
  );
  const insertMention = db.prepare(
    `INSERT INTO lcm_entity_mentions (mention_id, entity_id, summary_id, surface_form, span_start, span_end, mentioned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let mentionId = 1;
  for (const ent of FIXTURE_ENTITIES) {
    insertEntity.run(
      ent.entity_id,
      ent.session_key,
      ent.canonical_text,
      ent.entity_type,
      ent.occurrence_count,
      "[]", // alternate_surfaces
    );
    for (const sumId of ent.mentionedIn) {
      const leaf = FIXTURE_LEAVES.find((l) => l.summary_id === sumId);
      if (!leaf) continue;
      const createdAt = timeAgo(leaf.agedHours * HOUR);
      insertMention.run(
        `mention_${mentionId++}`,
        ent.entity_id,
        sumId,
        ent.canonical_text,
        0,
        ent.canonical_text.length,
        createdAt,
      );
    }
  }

  return {
    baseDate: BASE_DATE,
    conversations: FIXTURE_CONVERSATIONS,
    leafCount: FIXTURE_LEAVES.length,
    condensedCount: FIXTURE_CONDENSED.length,
    entityCount: FIXTURE_ENTITIES.length,
    suppressedCount: FIXTURE_LEAVES.filter((l) => l.suppressed).length,
  };
}
