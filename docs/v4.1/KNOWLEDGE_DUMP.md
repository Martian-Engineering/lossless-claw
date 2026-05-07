# Knowledge dump — context preservation for future maintainers

This is the architect's brain dump while the full context is hot. If you're reading this in a future session trying to understand or extend v4.1, START HERE.

## Why this PR exists in the shape it's in

### Why one omnibus PR vs split-by-group

I considered restacking into 7 PRs (one per group). Rejected because:
- Each individual PR would pass tests but the integration would only validate when ALL merge → strictly more risk than one PR
- The schema changes (Group A) are the foundation for everything else; a partial merge would leave the system in a half-state
- Reviewers reading 7 PRs vs 1 is cognitively harder, not easier
- The existing `PR #516` was the prior attempt; this PR replaces it cleanly

The cost: 21K LOC PR. Mitigated by per-group commit boundaries + adversarial review per group + comprehensive PR description.

### Why so many adversarial review passes

5 group-level + 1 final whole-PR. Each one caught real issues that the previous round missed. The pattern:

- **Spec-only review** (before code) found 27+ HIGH gaps but kept producing nearly-as-many new gaps as it fixed each cycle. The final pivot was "code is the ground truth" — write code, run it, let SQL/tests catch what spec review can't.
- **Code-level adversarial review per group** caught: SQLite TEXT-PK NOT-NULL quirk, vec0 PARTITION-KEY UPDATE corruption, CJK suppression leak, mention idempotency lie, prefilter false-positive cliffs, dispatch dry-run contract violation, and the **Final review's load-bearing find**: suppression bypass via `getSummary*` → `assembler.resolveSummaryItem`. Without that catch, every operator hard-purge would have been silently unwound by the next assemble pyramid build.

The lesson: **write code → adversarial review code → fix → repeat**. Pure-spec rounds are diminishing returns past the third pass.

## Load-bearing architectural decisions

### Lossless raw bedrock

`messages` table never gets DELETE except via operator explicit hard-purge with allowMainSession override. Suppression is via `suppressed_at` flag. This is THE foundation; everything else cascades from it.

**Why it matters**: every retrieval surface MUST filter `WHERE suppressed_at IS NULL` by default. If any path forgets, the operator can no longer trust the suppression model. The Final adversarial review caught 4+ paths where this filter was missing (5th was found in Group C review). This is the single most important invariant to protect in cycle-2.

### vec0 cascade via TRIGGERS, not FK CASCADE

vec0 corrupts when used with FK CASCADE. Discovered empirically + flagged by v4.1.1 review.

**The cleanup pattern**: per-model triggers on `summaries` (created in `ensureEmbeddingsTable`):
- `lcm_embed_suppress_<slug>` AFTER UPDATE OF suppressed_at → mirrors to vec0.suppressed
- `lcm_embed_delete_<slug>` AFTER DELETE → DELETE FROM vec0 row

PLUS shared trigger in migration for the meta sidecar (no FK because polymorphic embedded_id):
- `lcm_embedding_meta_cleanup_summary` AFTER DELETE ON summaries → DELETE FROM lcm_embedding_meta WHERE kind='summary'

**Don't unify these**. Per-model triggers are essential because vec0 SQL is per-table; meta cleanup is shared because the meta table is shared.

### vec0 schema: METADATA vs AUXILIARY columns

```sql
CREATE VIRTUAL TABLE lcm_embeddings_voyage4large USING vec0(
  embedding float[1024],
  +embedded_id text,        -- AUXILIARY: stored, NOT filterable in MATCH
  embedded_kind text,       -- METADATA: filterable in MATCH
  suppressed integer        -- METADATA: filterable in MATCH (BigInt!)
);
```

Discovered the hard way:
1. `embedded_kind` was originally AUXILIARY → `WHERE embedding MATCH ? AND embedded_kind IN (...)` threw "illegal WHERE constraint". Fixed by promoting to METADATA.
2. `suppressed integer` requires BigInt at the binding site (`0n` not `0`) — Node sqlite sees JS numbers as FLOAT and vec0 rejects them.

**These quirks are documented in `src/embeddings/store.ts` module header but the centralization is fragile**. If anyone refactors vec0 SQL to be inline (vs going through `recordEmbedding` / `searchSimilar` helpers), expect crashes.

### No LLM/network in DB write transactions

§0 invariant. Every LLM call OR Voyage HTTP call lives OUTSIDE the enclosing SQLite transaction. The pattern:

```typescript
db.exec("BEGIN IMMEDIATE");
const queryParams = db.prepare("SELECT ...").all();
db.exec("COMMIT");

// HTTP call OUTSIDE the transaction
const response = await voyageEmbed(queryParams);

db.exec("BEGIN IMMEDIATE");
db.prepare("INSERT ...").run(response);
db.exec("COMMIT");
```

**Why**: a slow LLM call inside a transaction holds the SQLite WAL lock, blocking every other writer. Worst-case 60-second LLM call = 60s of gateway latency. The lcm_voyage_rate_state UPDATE follows the same pattern: brief BEGIN IMMEDIATE → COMMIT → HTTP call.

**The Voyage retry budget (Group B Gap 1) is downstream of this**: even with the no-LLM-in-tx invariant, the worker_lock TTL (90s) limits how long a Voyage call can take. Capped retries (1) + capped timeoutMs (30s) keep worst-case batch wall time under 90s.

### Cross-process worker locks

`lcm_worker_lock` table with PRIMARY KEY (job_kind). Acquisition is atomic INSERT OR IGNORE. TTL+heartbeat for liveness. Worker uses shorter `busy_timeout` (5s) than gateway (30s) so gateway always wins on contention.

**Why this matters**: multiple processes can have the gateway running (dev box, CI, future test gateway). Without the lock, parallel backfill ticks would double-bill Voyage AND insert duplicate vec0 rows (no UNIQUE on auxiliary cols).

### Async extraction (v3.1 invariant)

Three independent adversarial agents converged on this in v3.1 review: entity coreference + procedure mining MUST be async (worker job), NEVER inline with leaf write. Inline coupling would put LLM-call latency in the gateway hot path.

**The wire-up** (Wire.1+2):
- `summary-store.insertSummary` enqueues an `lcm_extraction_queue` row for every leaf (best-effort try/catch — leaf-write must succeed even if queue insert fails)
- A separate worker process drains the queue (currently DEFERRED — manual drain via `runCoreferenceTick` only; auto-tick wiring is cycle-2)

**Critical**: do NOT make extraction inline. Even if the LLM is fast, the latency budget for leaf-write is <50ms; entity coref takes 500ms+.

### Per-tier synthesis dispatch (Group D)

```
daily   → single-pass             haiku-4-5
weekly  → single-pass             sonnet-4-5
monthly → single + verify_fidelity opus-4-7
yearly  → best-of-N (N=3) + judge opus-4-7-thinking
```

**Why no critique-revise**: literature consensus is that critique-revise underperforms single-pass for summarization. Don't add it back.

**Best-of-N + judge** is for yearly only because it's expensive (4 LLM calls per synthesis). For lower tiers, single-pass + (optional verify) is cheaper and good-enough.

**verify_fidelity** prompt contract: returns `OK` or `HALLUCINATION: <details>`. Whitespace-only output treated as not-OK (i.e. flagged). The dispatch parses this regex-ically; if you change the prompt, update `dispatch.ts:hallucinationFlagged` parser.

### Themes never in assemble pyramid

v4 RAG-leak adversarial agent finding: themes in the assemble pyramid violate the strategic principle (assemble is structural, never AI-decided per turn). Themes are agent-explicit only — agents can call `lcm_recent_themes` / `lcm_theme_explain` / `lcm_search_themes` (deferred tools) but the pyramid build never includes them.

**If you ever feel tempted to put themes in the pyramid**: re-read v4-rag-leak-agent-findings.md. The architectural reasoning is solid.

## What's wired vs what's cut (final post first-principles pass)

> **Updated 2026-05-06 (afternoon)**: First-principles pass + 8 challenger agents. Several previously-shipped tools/schemas were CUT to avoid half-shipped UX worse than not shipping. All cuts preserved in deferred-features draft PR (#616) for future-cycle pickup with complete worker + agent-tool wiring together.

| Component | Wired in this PR? | Notes |
|---|---|---|
| Schema (16 new tables — was 21, cut 5) | ✅ | Migration runs at boot, idempotent, live-DB-verified twice. Cut: lcm_themes, lcm_theme_sources, lcm_intentions, lcm_procedures, lcm_voyage_rate_state, lcm_purge_rebuild_queue. |
| Suppression filter on FTS/LIKE/CJK/regex search | ✅ | All 5 paths in summary-store + 3 in conversation-store + vec0 metadata filter |
| Suppression filter on getSummary/Parents/Children/Subtree | ✅ | Default exclude; opt-in via includeSuppressed=true |
| Suppression filter on getMessageById | ✅ | Final.review.3 fix (Loop 2 BLOCKER) |
| Suppression cascade trigger to vec0 | ✅ | Per-model AFTER UPDATE OF suppressed_at |
| Suppression cascade to context_items (summary + message) | ✅ | Inline in runPurge soft mode |
| Suppression cascade to lcm_synthesis_cache | ✅ | runPurge invalidates dependent cache rows |
| Leaf-write enqueues extraction | ✅ | Wire.1 |
| Backfill auto-runs on plugin init | ✅ | Wire.3 (gated on VOYAGE_API_KEY) |
| `/lcm worker tick embedding-backfill` operator command | ✅ | Wire.2 |
| `/lcm worker status` | ✅ | F.02 + F.03a |
| `/lcm health` | ✅ | F.02 |
| `/lcm reconcile-session-keys` | ✅ | F.04 |
| `/lcm eval` | ✅ | F.05 (recall only; quality judge primitive present, production wiring deferred) |
| `lcm_semantic_recall` agent tool | ✅ | C.01b (returns empty until backfill runs) |
| `lcm_grep --mode hybrid` | ✅ | C.02b (degrades to FTS-only without embeddings) |
| `lcm_grep --mode semantic` | ✅ | NEW (Phase 2) — pure semantic, no rerank cost |
| `lcm_grep --mode verbatim` | ✅ | NEW (Phase 2) — full untruncated message rows; closes Type C verbatim gap |
| `lcm_describe` extension (sessionKey + timeRange) | ✅ | C.05 |
| `lcm_describe expandChildren / expandMessages flags` | ✅ | NEW (Phase 2) — one-hop main-agent expansion without delegating to sub-agent |
| `lcm_synthesize_around` agent tool | ✅ | Group C cycle-2 wire; 754-line impl; 13 tests |
| `lcm_get_entity` agent tool | ✅ | Final.review.3 — 754 LOC + 9 tests |
| `lcm_search_entities` agent tool | ✅ | Final.review.3 — 240 LOC + 10 tests |
| Entity coref worker auto-tick | ✅ | Cycle-2 wire; LLM injected via worker-llm.ts adapter |
| **Themes** (3 agent tools + worker + schema) | ❌ CUT | Half-shipped UX. Preserved in PR #616 for focused future-cycle ship with worker auto-tick wired. |
| **Procedure mining** (worker + prefilter + schema) | ❌ CUT | 0% shipped (no agent tool, no LLM injection, no auto-tick). Preserved in PR #616. |
| **Intentions** (schema + prospective-extract prompt) | ❌ CUT | ZERO producer/consumer/agent tools. Preserved in PR #616. |
| **`runPurge --immediate`** (hard-delete drainer) | ❌ CUT | No drainer worker (~20-40h work, HIGH risk). Soft mode covers operational need. Preserved in PR #616. |
| **`lcm_voyage_rate_state`** schema | ❌ CUT | Table-only, ZERO production readers/writers. Per-process throttle covers single-gateway use. Preserved in PR #616. |
| **`lcm_describe` consolidation** (entity_id polymorphism) | ❌ DEFERRED | 400-LOC refactor; ergonomic-only; risk to canonical describe tool after 4 review rounds. Preserved in PR #616. |
| Quality eval (LLM judge) wiring in /lcm eval | ❌ deferred | Primitive `src/eval/judge.ts` present; production wiring (~10-60h depending on cross-family ensemble) deferred |
| `/lcm eval --register-set` CLI flag | ❌ deferred | Operator can seed via SQL today |

**This is the final shape.** No "Phase 2", no "Cycle 3" hidden in the docs. What ships here works end-to-end. What's preserved in PR #616 is documented with concrete cost/scope estimates for when each one ships as its own focused PR.

## Failure modes the architecture handles

### Voyage API down
- Backfill autostart sees 3 consecutive failures → stops itself, logs error, requires manual restart
- Agent tools (semantic_recall, hybrid grep) return error or degrade to FTS-only (hybrid only)
- New leaves still write + still enqueue extraction (FTS still works)

### sqlite-vec extension missing
- Plugin boots normally
- Backfill autostart returns NO_OP_HANDLE with a single warning
- Agent tools return `SemanticSearchUnavailableError` → tool surfaces "vec0 not loaded"
- Hybrid grep falls back to FTS-only with `degradedToFtsOnly: true` flag

### Operator runs hard-purge mid-backfill
- runPurge sets suppressed_at + cleans context_items + (immediate mode) enqueues rebuild
- Triggers cascade to vec0 → suppressed=1 in metadata
- Backfill cron's SELECT pre-filter excludes suppressed leaves
- No race; suppressed leaves never get embedded

### Two gateways pointing at same DB
- worker_lock (PK by job_kind) ensures only one backfill runs
- Migration ratchet uses BEGIN EXCLUSIVE (also gateway-only)
- Gateway with shorter busy_timeout always wins contention

### Plugin redeployed mid-backfill
- gateway_stop fires → autostart.stop() → setInterval cleared
- worker_lock TTL (90s) ensures lock auto-releases for next process
- Half-completed batch is just lost work; next tick re-selects

### LLM returns malformed best-of-N judge response
- `parseJudgeOutput` looks for `\d+` regex. If no digit OR out-of-range → throws SynthesisDispatchError("judge_failure")
- Caller (worker scheduler) records audit + skips this synthesis pass
- Operator sees the error in /lcm health (audit table)

## Debugging playbook

### "lcm_semantic_recall returns 0 hits"

```sql
-- Is vec0 loaded?
SELECT vec_version();  -- should return version string

-- Is there an active embedding profile?
SELECT * FROM lcm_embedding_profile WHERE active = 1;

-- Are there embeddings?
SELECT COUNT(*) FROM lcm_embedding_meta WHERE archived = 0;

-- If 0, backfill hasn't run. Check:
-- - VOYAGE_API_KEY set?
-- - Pending docs?
SELECT COUNT(*) FROM summaries WHERE kind='leaf' AND suppressed_at IS NULL
  AND NOT EXISTS (SELECT 1 FROM lcm_embedding_meta m WHERE m.embedded_id = summaries.summary_id);
```

Or just: `/lcm health` shows everything.

### "Operator hard-purge: suppressed content still showing in agent context"

This was the Final review BLOCKER. Check:
1. `summaries.suppressed_at` IS NOT NULL for the target?
2. `getSummary(id)` returns null (default behavior)?
3. `context_items` rows for that summary_id are deleted?
4. vec0 row has `suppressed=1` (trigger fired)?

If 1+2+3+4 all check, the assembler is no longer building it. If you see the content in agent output anyway, it might be a STALE cache row in `lcm_synthesis_cache` that was built BEFORE the suppression. Manual: `DELETE FROM lcm_synthesis_cache WHERE ...` (or wait for the cache invalidation to fire).

### "Backfill autostart not starting"

Check gateway log for one of these messages (each appears ONCE per boot):
- `[lcm] backfill autostart: VOYAGE_API_KEY not set` → set the env var, restart
- `[lcm] backfill autostart: sqlite-vec extension not loaded` → install sqlite-vec
- `[lcm] backfill autostart: no active embedding profile registered` → INSERT into lcm_embedding_profile, restart

### "Backfill is running but Voyage costs exploding"

Check:
- `lcm_voyage_rate_state.tokens_consumed_window` (cycle-2: rate state isn't actually consumed by the client; counts are cosmetic)
- `lcm_synthesis_audit` for cost telemetry per synthesis call

### "Tests pass but production behavior wrong"

Likely a wiring gap. The cycle-2 list flags every component that has tests but isn't called from production paths. Check:
- Is the function imported anywhere outside its test?
- Is there a code path from `register(api)` (plugin/index.ts) that reaches it?
- Is it called from a tool? An agent tool? An operator command?

## Why I made specific tradeoffs

### Why I deferred entity-coref auto-tick

The extraction worker needs an LLM extractor — that means plumbing model selection, credentials, retry policy through the plugin lifecycle. The existing `summarize.ts` does this with significant care; replicating it for the worker would be ~200 LOC of new wiring + tests. Cycle-2.

### Why backfill autostart but not extraction autostart

Backfill calls Voyage HTTP directly — no model selection ambiguity, no credential plumbing through pi-ai. Extraction needs an LLM call, which raises "which model? what auth profile? what fallback chain?" — questions the existing `summarize.ts` has good answers for, but I can't trivially reuse them in a worker context without significant integration work.

### Why per-tier model defaults are claude-* not gpt-*

Eva's environment is OpenClaw + Anthropic. The defaults match the existing summarizer's defaults. Operators can override per-prompt via `model_recommendation` or per-call via `modelOverride`.

### Why ml-hclust as a runtime dependency vs vendored

Library is small (~108KB minified after tree-shake), MIT-licensed, actively maintained. Vendoring would bloat the repo + lose upstream security fixes. The bundle size cost is acceptable.

### Why I didn't restack into 7 PRs

See "Why one omnibus PR" above. The integration is what matters; reviewing 7 chunks would just shift the review cost without changing total cost.

### Why the harness is a script not a test

The harness costs ~$0.05 in real Voyage tokens per run. Running it in CI on every PR would burn money + create network-dependent CI flakiness. As a manual script, operators run it before deployment / after major changes.

## What I'd do differently if starting over

1. **Wire as I go, not at the end.** I built 21K LOC of infrastructure before wiring any of it. Eva caught this. The wiring is small (Wire.1+2+3 = ~700 LOC) but should have been integrated per-group, not bolted on at the end.

2. **Live-DB harness should be the FIRST thing built**, not the last. The harness validates the integration is real. Building it at commit 47 of 47 was backwards — it should have been commit 5 (right after schema + Voyage client + minimal vec0 plumbing).

3. **Adversarial reviews per group is the right cadence.** This worked well; keep doing it. The Final whole-PR review caught the load-bearing BLOCKER (suppression bypass) that none of the group reviews caught — proves the meta-pattern.

4. **Subagent parallelism worked well for self-contained work** (eval harness, ml-hclust spike, F.02/F.04/F.05) but caused friction on shared-file work (lcm-command.ts had merge dance). Use subagents for new files; avoid for shared-file modifications.

5. **The B.fix pattern (fix adversarial findings in a follow-up commit, not amend) was right.** Each "X.fix" commit is a clear narrative: "review found N gaps, this commit closes BLOCKER+HIGH; MED+LOW deferred to cycle-2". Future maintainers can read the commit log and understand the history.

6. **Spec-iteration cycles plateau fast.** v4.0 → v4.1 → v4.1.1 spec rounds each found ~14 new gaps and fixed ~10 old ones. The right move is "stop spec-cycling, write code, let SQL catch what spec misses." Code is the ground truth.

## If you're inheriting this and need to ship cycle-2

The right order:
1. Wire entity-coref auto-tick (blocks: themes consolidation, procedure mining auto-ticks)
2. Add `lcm_synthesize_around` (Eva's most-asked-for synthesis tool)
3. Add `lcm_recent_themes` / `lcm_theme_explain` agent tools (themes are useless without these)
4. Quality eval LLM judge wiring in /lcm eval (proves synthesis tier dispatch quality)
5. worker_threads heartbeat isolation (production-grade stability for long-running workers)
6. /lcm eval --register-set CLI flag (operator QoL)

Each step is small (<300 LOC) and validatable independently. None of them needs more than what's already in this PR.

---

This is everything I know about v4.1. May it serve future maintainers well.
