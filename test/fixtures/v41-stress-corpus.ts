/**
 * Synthetic LCM v4.1 STRESS test corpus — large, realistic-shape fixture
 * for corpus-shape stress tests (Wave-10 antipattern A4 closure).
 *
 * # Why this is separate from `v41-test-corpus.ts`
 *
 * The small fixture (`v41-test-corpus.ts`, ~80 leaves) is designed for
 * fast, scenario-anchored unit tests. It cannot stress-test:
 *   - ranking under many overlapping leaves
 *   - recency floor (K=200 most recent + last 6h)
 *   - slot tier for dense days (e.g. Eva's real DB had Apr 8 = 846 leaves
 *     in a single 24h window)
 *   - FTS5 performance at scale
 *   - vec0 KNN with realistic vector counts
 *   - suppression cascade across many shared parent condenseds
 *   - adversarial content (prompt injection, malformed JSON metadata)
 *
 * This module builds 1500-2500 leaves shaped to model the user's real
 * `~/.openclaw/lcm.db` (4187 leaves, 1.62M tokens dense day). All output
 * is deterministic (seeded PRNG = mulberry32(seed=42)) so tests can
 * assert byte-identical row counts and content hashes across runs.
 *
 * # Distribution targets
 *
 * Volume:
 *   - 1500-2500 leaves
 *   - 8-15 conversations across 4-6 session_keys
 *   - 30-60 entities (mention counts 2..100)
 *   - 100-200 condensed summaries (multi-level depth)
 *
 * Time bucketing (modeling Eva's DB):
 *   - ~30% in last 7 days
 *   - ~40% in last 30 days
 *   - ~30% older
 *   - 1 dense day with 100+ leaves in a single 24h window (Apr 8 case)
 *   - 5-10% suppressed (mix of recent + old)
 *
 * Content diversity:
 *   - mix of short (<100 token) and long (1000+ token) leaves
 *   - realistic topic overlap (5-10 leaves per topic)
 *   - 2 near-duplicates (90% similar, different timestamps)
 *   - ~5% CJK content (mix of zh / ja)
 *   - ~2% emoji-heavy content
 *   - ~2% with malformed JSON in metadata fields
 *
 * Adversarial content (small but present):
 *   - 1 leaf containing `{{date_range}}` literally
 *   - 1 leaf containing `</leaf-content-abc12345>` envelope close-tag
 *   - 1 leaf containing `<script>alert(1)</script>` XSS payload
 *   - 1 leaf with `'; DROP TABLE summaries; --` SQL injection in content
 *   - 1 leaf with extreme length (50K tokens, exceeds embedding cap)
 *
 * # Determinism
 *
 * `BASE_DATE` is fixed (2026-05-07T12:00:00Z). PRNG is mulberry32(42).
 * Re-running `buildStressTestCorpus()` produces byte-identical row
 * counts and content hashes.
 */

import type { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../../src/db/migration.js";

/** Anchor for the stress fixture — same date convention as the small fixture. */
export const STRESS_BASE_DATE = new Date("2026-05-07T12:00:00Z");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Subtract N ms from BASE_DATE → ISO string. */
function timeAgo(ms: number): string {
  return new Date(STRESS_BASE_DATE.getTime() - ms).toISOString();
}

// ────────────────────────────────────────────────────────────────────
// Deterministic PRNG (mulberry32) — seeded so corpus is reproducible.
// ────────────────────────────────────────────────────────────────────

/** mulberry32 — small, well-distributed 32-bit PRNG. */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pick an integer in [min, max] inclusive. */
function intIn(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** Pick a random element. */
function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

// ────────────────────────────────────────────────────────────────────
// Realistic content templates
// ────────────────────────────────────────────────────────────────────

/**
 * Topics — 30 realistic phrases pulled from the OpenClaw / LCM problem
 * domain so FTS5 has a believable token distribution. Topics with
 * shared terms (Voyage, rerank, race, plan, gateway, …) are intentional
 * — they create the topic overlap a real DB exhibits.
 */
const TOPICS = [
  "Voyage embedding backfill worker",
  "Voyage rerank-2.5 token budget",
  "Voyage rate limiting Retry-After",
  "rerank fallback to RRF fusion",
  "rebase PR #71676 onto main",
  "rebase conflict resolution",
  "gateway timeout 30s plugin install",
  "gateway healthz worker restart cycle",
  "race condition empty plan body",
  "race condition reconcileSessionKeys TOCTOU",
  "plan mode persistence snapshot",
  "plan mode UI regression split sidebar",
  "compaction marker durability",
  "compaction reserveTokensFloor tuning",
  "lcm_recent rejection synthesize_around",
  "lcm_grep verbatim mode citation",
  "lcm_describe expandChildren cap raise",
  "lcm_semantic_recall confidence band",
  "operator-VM customer escalation thread",
  "operator-VM CPU spike worker hang",
  "smarter-claw plugin disable workflow",
  "smarter-claw plugin port audit",
  "Eva approval shipping cycle",
  "Eva first-principles design pass",
  "FTS5 unicode61 tokenizer CJK gap",
  "FTS5 trigram fallback for CJK",
  "vec0 metadata column suppressed flag",
  "vec0 KNN over-fetch trim post-JOIN",
  "summary cascade trigger DELETE",
  "summary cascade trigger UPDATE",
] as const;

/** Aspects — modifier phrases mixed into leaf content. */
const ASPECTS = [
  "performance regression",
  "security review",
  "test coverage gap",
  "production rollout plan",
  "rollback procedure",
  "monitoring alert config",
  "retry policy tuning",
  "timeout budget allocation",
  "lock TTL extension",
  "transaction boundary",
  "idempotency key",
  "audit trail entry",
  "schema migration step",
  "feature flag toggle",
  "breaking-change announcement",
] as const;

/** CJK fragments — model the bilingual content the user has. */
const CJK_FRAGMENTS = [
  "机器学习 (machine learning)",
  "我们应该测试一下 (we should test)",
  "嵌入向量 (embedding vector)",
  "缓存命中率 (cache hit rate)",
  "用户反馈 (user feedback)",
  "重排序 (reranking)",
  "文本检索 (text retrieval)",
  "数据迁移 (data migration)",
] as const;

/** Emoji-heavy phrases (small slice — tests emoji-tolerant paths). */
const EMOJI_PHRASES = [
  "🚀 ship it 🚀 LGTM ✅ approved by Eva 👍",
  "🔥 production fire 🔥 escalated to oncall 📟 fixed in 15m ⚡",
  "🐛 bug found 🐛 reproduced locally 🔧 patch incoming 🩹",
  "📊 metrics show +15% improvement 📈 dashboard at /grafana",
  "🎯 target hit: p99 latency < 200ms 💯 sustained for 7 days",
] as const;

// ────────────────────────────────────────────────────────────────────
// Adversarial leaves — fixed content, present in known positions
// ────────────────────────────────────────────────────────────────────

/**
 * Adversarial fixture leaves — these target specific defensive code
 * paths. Indexed by tag so stress tests can fetch them by ID.
 *
 * Each one contains content designed to break a specific parser or
 * rendering surface if defenses are missing.
 */
export const ADVERSARIAL_LEAVES = [
  {
    summary_id: "sum_adv_template",
    content:
      "Discussion of {{date_range}} interpolation: the renderer should NOT substitute this " +
      "since the leaf is data, not a template. If you see {{actual_date_range}} replaced, " +
      "we have a bug. Original phrasing preserved by Wave-10 stress fixture.",
    tag: "adversarial:template-injection",
    note: "Tests Mustache-style template guard in renderer.",
  },
  {
    summary_id: "sum_adv_envelope",
    content:
      "The envelope close-tag </leaf-content-abc12345> should not break parsing. " +
      "Wave-9 P1.6 added a pre-scan that strips envelope-shaped text from leaf content " +
      "before passing to the entity extractor. This leaf verifies that pre-scan still works.",
    tag: "adversarial:envelope-injection",
    note: "Tests entity-extractor envelope pre-scan.",
  },
  {
    summary_id: "sum_adv_xss",
    content:
      "Reproduction notes: <script>alert(1)</script> was reported in a leaf. The agent " +
      "tools must NEVER pass raw leaf content to a renderer that interprets HTML. Markdown " +
      "is fine; HTML is not. Test asserts no script execution downstream.",
    tag: "adversarial:xss",
    note: "Tests defense-in-depth against XSS via leaf content.",
  },
  {
    summary_id: "sum_adv_sql",
    content:
      "SQL injection probe in leaf body: '; DROP TABLE summaries; -- and ' OR 1=1 --. " +
      "All read paths use prepared statements with placeholders, so this should be quoted " +
      "as a string literal and stored as-is. If summaries table disappears, defenses failed.",
    tag: "adversarial:sql-injection",
    note: "Tests prepared-statement parameter binding.",
  },
  {
    summary_id: "sum_adv_extreme_length",
    // Will be expanded at build time to ~50K tokens (~200K chars) so it
    // exceeds the Voyage embedding cap (32K tokens) and forces the
    // chunker to split or skip.
    content: "extreme-length placeholder",
    tag: "adversarial:extreme-length",
    note: "Tests long-leaf handling: chunker, embedding cap, FTS5 ingestion.",
  },
  {
    summary_id: "sum_adv_malformed_json",
    content:
      "Leaf with malformed JSON in description (synthetic): {\"unterminated_string: \"value, " +
      "\"valid_key\": 42, \"trailing_comma\": [1, 2, 3,]}. Defensive JSON.parse paths must " +
      "catch the exception and continue. This leaf's CONTENT is fine SQL-wise; only the " +
      "embedded JSON-shaped substring is malformed.",
    tag: "adversarial:malformed-json",
    note: "Tests JSON.parse defensiveness.",
  },
] as const;

// ────────────────────────────────────────────────────────────────────
// Public types
// ────────────────────────────────────────────────────────────────────

export interface StressLeaf {
  summary_id: string;
  conversation_id: number;
  session_key: string;
  content: string;
  token_count: number;
  /** Hours-ago from STRESS_BASE_DATE for created_at. */
  agedHours: number;
  /** True if leaf is suppressed at construction time. */
  suppressed: boolean;
  /** Tags grouping the leaf into topical / adversarial cohorts. */
  tags: readonly string[];
}

export interface StressCondensed {
  summary_id: string;
  conversation_id: number;
  session_key: string;
  content: string;
  token_count: number;
  agedHours: number;
  /** Child leaves (can be many — modeling Eva's dense days). */
  childIds: readonly string[];
}

export interface StressEntity {
  entity_id: string;
  session_key: string;
  canonical_text: string;
  entity_type: string;
  occurrence_count: number;
  mentionedIn: readonly string[];
}

export interface StressCorpusOptions {
  /** Override RNG seed for reproducibility (default 42). */
  seed?: number;
  /** Total leaves to generate (default 2000; clamped 1500..2500). */
  targetLeafCount?: number;
}

export interface StressCorpusMetadata {
  baseDate: Date;
  seed: number;
  leafCount: number;
  condensedCount: number;
  entityCount: number;
  conversationCount: number;
  suppressedCount: number;
  /** Hash of all (summary_id, content_first_64chars) — verifies determinism. */
  contentDigest: string;
  /** Per-bucket leaf counts: last7d / last30d / older. */
  bucketCounts: { last7d: number; last30d: number; older: number };
  /** Dense-day window info: when it is and how many leaves fell in it. */
  denseDay: { centerHoursAgo: number; leafCount: number };
}

// ────────────────────────────────────────────────────────────────────
// Generator
// ────────────────────────────────────────────────────────────────────

/**
 * Build the stress test corpus. Caller owns the DB (we run migrations
 * if not already applied). Returns metadata including a content digest
 * for determinism assertions.
 */
export function buildStressTestCorpus(
  db: DatabaseSync,
  options: StressCorpusOptions = {},
): StressCorpusMetadata {
  const seed = options.seed ?? 42;
  // Clamp to allowed band; default to 2000.
  const target = Math.max(
    1500,
    Math.min(2500, options.targetLeafCount ?? 2000),
  );

  runLcmMigrations(db, { fts5Available: true, seedDefaultPrompts: false });

  const rng = makeRng(seed);

  // 1. Conversations + session_keys --------------------------------
  // 5 session_keys × 1-3 convs each → 8-15 conversations total.
  const sessionKeys = [
    "agent:main:main",
    "agent:operator-vm:main",
    "agent:eva-research:main",
    "agent:main:subagent:harness",
    "legacy:conv_stress",
  ] as const;

  const conversations: Array<{
    conversation_id: number;
    session_id: string;
    session_key: string;
    active: number;
    created_at: string;
  }> = [];

  let convId = 0;
  for (const sk of sessionKeys) {
    const numConvs = sk.startsWith("legacy:") ? 1 : intIn(rng, 2, 3);
    for (let i = 0; i < numConvs; i++) {
      convId++;
      conversations.push({
        conversation_id: convId,
        session_id: `stress-conv-${String(convId).padStart(3, "0")}`,
        session_key: sk,
        // First conv in each session_key family is active (mod legacy);
        // older convs are inactive (rolled-over).
        active: !sk.startsWith("legacy:") && i === 0 ? 1 : 0,
        created_at: timeAgo(intIn(rng, 1, 90) * DAY),
      });
    }
  }

  // 2. Generate leaves with realistic distribution -----------------

  const leaves: StressLeaf[] = [];

  // 2a. Adversarial leaves — fixed positions, deterministic.
  for (const adv of ADVERSARIAL_LEAVES) {
    const conv = pick(rng, conversations);
    let content = adv.content;
    let tokenCount = Math.ceil(content.length / 4); // rough chars/token
    // Expand the extreme-length leaf to ~50K tokens (~200K chars).
    if (adv.summary_id === "sum_adv_extreme_length") {
      const filler = " word ".repeat(40000); // ~200K chars → ~50K tokens
      content = `Extreme-length leaf for embedding-cap stress: ${filler}`.slice(
        0,
        200_000,
      );
      tokenCount = 50_000;
    }
    leaves.push({
      summary_id: adv.summary_id,
      conversation_id: conv.conversation_id,
      session_key: conv.session_key,
      content,
      token_count: tokenCount,
      agedHours: intIn(rng, 12, 72), // recent so adversarial is fresh
      suppressed: false,
      tags: [adv.tag],
    });
  }

  // 2b. Bulk leaves — distributed across time buckets.
  const bulkTarget = target - leaves.length - 4; // reserve for near-dups + dense-day
  const bucketTargets = {
    last7d: Math.round(bulkTarget * 0.3),
    last30d: Math.round(bulkTarget * 0.4),
    older: bulkTarget - Math.round(bulkTarget * 0.3) - Math.round(bulkTarget * 0.4),
  };

  let leafCounter = 0;

  // Helper: generate one bulk leaf in a given hour-band.
  function makeBulkLeaf(minHours: number, maxHours: number, tag: string): StressLeaf {
    leafCounter++;
    const id = `sum_bulk_${String(leafCounter).padStart(5, "0")}`;
    const conv = pick(rng, conversations);
    const topic = pick(rng, TOPICS);
    const aspect = pick(rng, ASPECTS);
    const N = intIn(rng, 1, 50);

    // Mix in CJK / emoji at ~5% / ~2% rates.
    const roll = rng();
    let body: string;
    let tokenCount: number;
    if (roll < 0.05) {
      const cjk = pick(rng, CJK_FRAGMENTS);
      body =
        `${topic} #${N} discussion about ${aspect}. ${cjk} considered as approach. ` +
        `Decision pending Eva review. Status: open.`;
      tokenCount = intIn(rng, 35, 85);
    } else if (roll < 0.07) {
      body = pick(rng, EMOJI_PHRASES);
      tokenCount = intIn(rng, 20, 50);
    } else if (roll < 0.09) {
      // Malformed JSON in body — tests JSON.parse defensiveness.
      body =
        `${topic} #${N} debug log captured: { "level": "warn", "msg": "${aspect}" ` +
        `unterminated_string, trailing_comma: [1,2,3,] }. Continuing investigation.`;
      tokenCount = intIn(rng, 40, 80);
    } else if (roll < 0.5) {
      // Short leaf (~30-100 tokens)
      body =
        `${topic} #${N}: short note on ${aspect}. ` +
        `Refer to PR #${intIn(rng, 100, 999)} for details.`;
      tokenCount = intIn(rng, 30, 100);
    } else if (roll < 0.95) {
      // Medium leaf (~150-400 tokens)
      const aspect2 = pick(rng, ASPECTS);
      body =
        `${topic} #${N}: detailed discussion of ${aspect}. ` +
        `Touched on ${aspect2}, with implications for downstream pipelines. ` +
        `Action: assigned to engineering. Status: ${pick(rng, ["open", "in-review", "shipped"] as const)}. ` +
        `Linked PR #${intIn(rng, 100, 999)}.`;
      tokenCount = intIn(rng, 150, 400);
    } else {
      // Long leaf (~1000-2000 tokens) — dense write-up
      const aspect2 = pick(rng, ASPECTS);
      const aspect3 = pick(rng, ASPECTS);
      const para = (s: string) =>
        s.repeat(8) + `. Continuing analysis: ${aspect2}, ${aspect3}.`;
      body = [
        `${topic} #${N}: long-form analysis. `,
        para(`First-pass review covered ${aspect}`),
        para(`Mitigation strategy depends on ${aspect2}`),
        para(`Success criteria captured in ${aspect3}`),
        `Final decision: ship in next cycle.`,
      ].join("\n");
      tokenCount = intIn(rng, 1000, 2000);
    }

    return {
      summary_id: id,
      conversation_id: conv.conversation_id,
      session_key: conv.session_key,
      content: body,
      token_count: tokenCount,
      agedHours: intIn(rng, minHours, maxHours),
      suppressed: rng() < 0.07, // ~7% suppressed (within 5-10% target)
      tags: [tag, "bulk"],
    };
  }

  for (let i = 0; i < bucketTargets.last7d; i++) {
    leaves.push(makeBulkLeaf(1, 7 * 24, "bucket:last7d"));
  }
  for (let i = 0; i < bucketTargets.last30d; i++) {
    leaves.push(makeBulkLeaf(7 * 24 + 1, 30 * 24, "bucket:last30d"));
  }
  for (let i = 0; i < bucketTargets.older; i++) {
    leaves.push(makeBulkLeaf(30 * 24 + 1, 90 * 24, "bucket:older"));
  }

  // 2c. Dense day — 120 leaves clustered in a 24h window centered at
  //     ~14 days ago (modeling Eva's Apr 8 = 846-leaf dense day, scaled).
  const denseDayCenter = 14 * 24;
  const DENSE_DAY_LEAF_COUNT = 120;
  for (let i = 0; i < DENSE_DAY_LEAF_COUNT; i++) {
    leafCounter++;
    const id = `sum_dense_${String(i + 1).padStart(3, "0")}`;
    const conv = conversations[0]!; // all dense leaves on one conv
    // Randomly distributed within ±12h of center
    const offset = (rng() - 0.5) * 24;
    leaves.push({
      summary_id: id,
      conversation_id: conv.conversation_id,
      session_key: conv.session_key,
      content:
        `Dense-day work item #${i + 1}: ${pick(rng, TOPICS)} — quick iteration cycle, ` +
        `${pick(rng, ASPECTS)}. Burst session captured ${DENSE_DAY_LEAF_COUNT} items.`,
      token_count: intIn(rng, 50, 150),
      agedHours: denseDayCenter + offset,
      suppressed: false,
      tags: ["dense-day"],
    });
  }

  // 2d. Near-duplicate pair — same content, slightly different timestamps.
  //     Tests dedup logic without silent collapse.
  const nearDupContent =
    "Review of voyage-4-large embedding model: 1024 dimensions, " +
    "rerank-2.5 lifts paraphrastic recall by +52.5pp on eva-baseline-v2. " +
    "Cost analysis: $0.58 per 1K queries. Status: shipping in PR #614.";
  leaves.push({
    summary_id: "sum_neardup_a",
    conversation_id: conversations[0]!.conversation_id,
    session_key: conversations[0]!.session_key,
    content: nearDupContent,
    token_count: 70,
    agedHours: 4 * 24,
    suppressed: false,
    tags: ["near-dup-pair"],
  });
  leaves.push({
    summary_id: "sum_neardup_b",
    conversation_id: conversations[0]!.conversation_id,
    session_key: conversations[0]!.session_key,
    // 90% similar — only the trailing PR number changes.
    content: nearDupContent.replace("PR #614", "PR #615"),
    token_count: 70,
    agedHours: 4 * 24 + 8,
    suppressed: false,
    tags: ["near-dup-pair"],
  });

  // 2e. Two more suppressed leaves to ensure at least one in last7d AND last30d
  leaves.push({
    summary_id: "sum_supp_recent",
    conversation_id: conversations[0]!.conversation_id,
    session_key: conversations[0]!.session_key,
    content: "PII redacted via /lcm purge — recent (within 7 days).",
    token_count: 12,
    agedHours: 36,
    suppressed: true,
    tags: ["bucket:last7d", "suppressed"],
  });
  leaves.push({
    summary_id: "sum_supp_old",
    conversation_id: conversations[0]!.conversation_id,
    session_key: conversations[0]!.session_key,
    content: "Sensitive data purged from old archive (older than 30 days).",
    token_count: 14,
    agedHours: 45 * 24,
    suppressed: true,
    tags: ["bucket:older", "suppressed"],
  });

  // 3. Generate condensed summaries (multi-level, 100-200 of them) ----
  //
  // Strategy:
  //   - Level-1 condenseds: each covers 5-15 children leaves.
  //     Choose ~15% of leaves to be covered by a condensed.
  //   - Level-2 condenseds: each covers 2-5 level-1 condenseds.
  //     ~10% of level-1s are roots for level-2.
  const condenseds: StressCondensed[] = [];
  const leavesByConv = new Map<number, StressLeaf[]>();
  for (const l of leaves) {
    const arr = leavesByConv.get(l.conversation_id) ?? [];
    arr.push(l);
    leavesByConv.set(l.conversation_id, arr);
  }

  let condCounter = 0;
  const level1Ids: string[] = [];
  for (const [cid, convLeaves] of leavesByConv) {
    // Bin leaves by week so condenseds reflect time clustering.
    // Use a wider fanout (8-20) so we land 100-200 condenseds for
    // ~2000 leaves (target band per the briefing).
    const sorted = [...convLeaves].sort((a, b) => a.agedHours - b.agedHours);
    let i = 0;
    while (i < sorted.length) {
      const fanout = intIn(rng, 8, 20);
      const slice = sorted.slice(i, i + fanout);
      i += fanout;
      if (slice.length < 3) break;
      // Skip if condensed would only cover suppressed leaves (rare).
      if (slice.every((l) => l.suppressed)) continue;
      condCounter++;
      const id = `sum_cond1_${String(condCounter).padStart(4, "0")}`;
      const conv = conversations.find((c) => c.conversation_id === cid)!;
      const avgAge = slice.reduce((s, l) => s + l.agedHours, 0) / slice.length;
      condenseds.push({
        summary_id: id,
        conversation_id: cid,
        session_key: conv.session_key,
        content: `Level-1 condensed (${slice.length} children) covering ${pick(rng, TOPICS)}.`,
        token_count: intIn(rng, 40, 100),
        agedHours: Math.round(avgAge),
        childIds: slice.map((l) => l.summary_id),
      });
      level1Ids.push(id);
    }
  }

  // Level-2 condenseds — group every ~5 level-1 condenseds.
  let level2Counter = 0;
  for (let i = 0; i < level1Ids.length; i += 5) {
    const slice = level1Ids.slice(i, i + 5);
    if (slice.length < 2) break;
    if (rng() > 0.5) continue; // only ~50% of groups get a level-2
    level2Counter++;
    const id = `sum_cond2_${String(level2Counter).padStart(4, "0")}`;
    // Use the first child's session_key/conv for parent (real DB has
    // condenseds within a single conv).
    const firstChild = condenseds.find((c) => c.summary_id === slice[0])!;
    condenseds.push({
      summary_id: id,
      conversation_id: firstChild.conversation_id,
      session_key: firstChild.session_key,
      content: `Level-2 (root) condensed: ${slice.length} sub-condenseds, sweep across topics.`,
      token_count: intIn(rng, 80, 180),
      agedHours: firstChild.agedHours,
      childIds: slice,
    });
  }

  // 4. Entities — 30-60 entities with mention counts 2..100. -------
  //
  // We pick ~50 distinct canonical names (mix of vendor/tool/customer/PR
  // numbers/etc) and for each, draw a target mention count, then sample
  // that many leaves whose content contains a related word to "place"
  // the mention. Mentions don't have to be perfectly aligned to content
  // — entity tooling reads from `lcm_entity_mentions`, not regex.
  const entityNames: Array<{
    canonical: string;
    type: string;
    targetMentions: number;
  }> = [];
  // Known dense entities (model real DB)
  entityNames.push(
    { canonical: "Voyage", type: "vendor", targetMentions: 100 },
    { canonical: "rerank-2.5", type: "model", targetMentions: 60 },
    { canonical: "Eva", type: "person", targetMentions: 80 },
    { canonical: "operator-VM customer", type: "customer", targetMentions: 30 },
  );
  // Plus 60 randomly generated PR numbers + tool names with 2-30 mentions.
  // Use a Set guard for name uniqueness (the previous `some()` skip burned
  // slots when names collided, ending below the 30-entity target).
  const seenNames = new Set(entityNames.map((e) => e.canonical));
  let attempts = 0;
  while (
    entityNames.length < 50 + 4 /* dense */ &&
    attempts < 200
  ) {
    attempts++;
    const isToolName = rng() < 0.5;
    const name = isToolName
      ? `lcm_${pick(rng, ["grep", "describe", "synthesize_around", "semantic_recall", "get_entity", "expand_query", "search_entities", "purge"] as const)}_v${intIn(rng, 1, 9)}`
      : `PR #${intIn(rng, 100, 999)}`;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    entityNames.push({
      canonical: name,
      type: isToolName ? "tool_name" : "pr_number",
      targetMentions: intIn(rng, 2, 30),
    });
  }

  const entities: StressEntity[] = [];
  let entityCounter = 0;
  // Only attribute mentions to non-suppressed bulk leaves (suppressed
  // leaves may still have entities but entity tooling filters them).
  const candidateLeaves = leaves.filter(
    (l) => !l.suppressed && l.tags.includes("bulk"),
  );

  // Restrict entity-host session_keys to those that actually have bulk
  // candidates (skip `legacy:conv_stress` which has only 1 conv with
  // limited leaves and may yield <2 candidates).
  const skWithCandidates = sessionKeys.filter(
    (sk) => candidateLeaves.filter((l) => l.session_key === sk).length >= 5,
  );

  for (const ent of entityNames) {
    entityCounter++;
    const id = `ent_stress_${String(entityCounter).padStart(3, "0")}`;
    const sk = pick(rng, skWithCandidates);
    // Sample without replacement up to `targetMentions` leaves.
    const pool = candidateLeaves.filter((l) => l.session_key === sk);
    const sample: string[] = [];
    const taken = new Set<number>();
    const wanted = Math.min(ent.targetMentions, pool.length);
    while (sample.length < wanted) {
      const idx = Math.floor(rng() * pool.length);
      if (taken.has(idx)) continue;
      taken.add(idx);
      sample.push(pool[idx]!.summary_id);
    }
    if (sample.length < 2) continue; // skip if can't reach 2 mentions
    entities.push({
      entity_id: id,
      session_key: sk,
      canonical_text: ent.canonical,
      entity_type: ent.type,
      occurrence_count: sample.length,
      mentionedIn: sample,
    });
  }

  // ────────────────────────────────────────────────────────────────────
  // Insert into DB
  // ────────────────────────────────────────────────────────────────────

  const insertConv = db.prepare(
    `INSERT OR IGNORE INTO conversations (conversation_id, session_id, session_key, active, created_at)
       VALUES (?, ?, ?, ?, ?)`,
  );
  for (const c of conversations) {
    insertConv.run(c.conversation_id, c.session_id, c.session_key, c.active, c.created_at);
  }

  // Messages: one per leaf. Per-conv seq counter to satisfy
  // UNIQUE(conversation_id, seq).
  const insertMsg = db.prepare(
    `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at, identity_hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMsgFts = db.prepare(
    `INSERT INTO messages_fts(rowid, content) VALUES (?, ?)`,
  );
  const seqByConv = new Map<number, number>();
  let messageId = 0;
  for (const leaf of leaves) {
    messageId++;
    const seq = (seqByConv.get(leaf.conversation_id) ?? 0) + 1;
    seqByConv.set(leaf.conversation_id, seq);
    insertMsg.run(
      messageId,
      leaf.conversation_id,
      seq,
      "user",
      leaf.content,
      leaf.token_count,
      timeAgo(leaf.agedHours * HOUR),
      `stress_msg_${messageId}`,
    );
    insertMsgFts.run(messageId, leaf.content);
    if (leaf.suppressed) {
      db.prepare(
        `UPDATE messages SET suppressed_at = datetime('now') WHERE message_id = ?`,
      ).run(messageId);
    }
  }

  // Summaries (leaves + condenseds), with FTS populated correctly using
  // the (summary_id, content) column shape so JOINs work.
  const insertSum = db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, session_key, kind, depth, content, token_count, created_at, latest_at, suppressed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertSumFts = db.prepare(
    `INSERT INTO summaries_fts(summary_id, content) VALUES (?, ?)`,
  );

  for (const leaf of leaves) {
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
      createdAt,
      leaf.suppressed ? createdAt : null,
    );
    insertSumFts.run(leaf.summary_id, leaf.content);
  }
  for (const cond of condenseds) {
    const createdAt = timeAgo(cond.agedHours * HOUR);
    // Level-2 condenseds are depth 2.
    const depth = cond.summary_id.startsWith("sum_cond2_") ? 2 : 1;
    insertSum.run(
      cond.summary_id,
      cond.conversation_id,
      cond.session_key,
      "condensed",
      depth,
      cond.content,
      cond.token_count,
      createdAt,
      createdAt,
      null,
    );
    insertSumFts.run(cond.summary_id, cond.content);
  }

  // summary_parents: link each child to its parent.
  const insertParent = db.prepare(
    `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)`,
  );
  for (const cond of condenseds) {
    for (let i = 0; i < cond.childIds.length; i++) {
      insertParent.run(cond.childIds[i], cond.summary_id, i);
    }
  }

  // Entities + mentions.
  const insertEntity = db.prepare(
    `INSERT INTO lcm_entities (entity_id, session_key, canonical_text, entity_type, occurrence_count, alternate_surfaces, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, '[]', datetime('now', '-30 days'), datetime('now'))`,
  );
  const insertMention = db.prepare(
    `INSERT INTO lcm_entity_mentions (mention_id, entity_id, summary_id, surface_form, span_start, span_end, mentioned_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  let mentionCounter = 0;
  for (const ent of entities) {
    insertEntity.run(
      ent.entity_id,
      ent.session_key,
      ent.canonical_text,
      ent.entity_type,
      ent.occurrence_count,
    );
    for (const sumId of ent.mentionedIn) {
      mentionCounter++;
      const leaf = leaves.find((l) => l.summary_id === sumId);
      if (!leaf) continue;
      insertMention.run(
        `mention_stress_${mentionCounter}`,
        ent.entity_id,
        sumId,
        ent.canonical_text,
        0,
        ent.canonical_text.length,
        timeAgo(leaf.agedHours * HOUR),
      );
    }
  }

  // ────────────────────────────────────────────────────────────────────
  // Compute determinism metadata
  // ────────────────────────────────────────────────────────────────────

  // Content digest: sum-of-(charCode * position) over (summary_id, first
  // 64 chars of content), as a 32-bit hex. Cheap, stable, reproducible.
  let digest = 2166136261; // FNV-1a basis
  for (const leaf of leaves) {
    const s = leaf.summary_id + "|" + leaf.content.slice(0, 64);
    for (let i = 0; i < s.length; i++) {
      digest ^= s.charCodeAt(i);
      digest = Math.imul(digest, 16777619);
    }
  }
  const contentDigest = (digest >>> 0).toString(16).padStart(8, "0");

  const last7dCount = leaves.filter((l) => l.agedHours <= 7 * 24).length;
  const last30dCount = leaves.filter(
    (l) => l.agedHours > 7 * 24 && l.agedHours <= 30 * 24,
  ).length;
  const olderCount = leaves.filter((l) => l.agedHours > 30 * 24).length;
  const denseDayLeafCount = leaves.filter(
    (l) =>
      l.agedHours >= denseDayCenter - 12 &&
      l.agedHours <= denseDayCenter + 12 &&
      l.tags.includes("dense-day"),
  ).length;

  return {
    baseDate: STRESS_BASE_DATE,
    seed,
    leafCount: leaves.length,
    condensedCount: condenseds.length,
    entityCount: entities.length,
    conversationCount: conversations.length,
    suppressedCount: leaves.filter((l) => l.suppressed).length,
    contentDigest,
    bucketCounts: {
      last7d: last7dCount,
      last30d: last30dCount,
      older: olderCount,
    },
    denseDay: { centerHoursAgo: denseDayCenter, leafCount: denseDayLeafCount },
  };
}
