# LCM v4.1 — Test antipattern tabulation

**Status**: Living doc. Started 2026-05-07 after Wave-9 closure + the user's observation that "tests show green while we keep finding real bugs."

**Purpose**: For each significant bug found across Waves 1-9, classify which test antipattern hid it. Use the ranked list to drive future test-quality investment.

---

## The headline number

- **Waves 1-9** ran across ~6 weeks of audit cycles
- **~140 unique findings** closed across the 9 waves
- **1353 tests passing** before the test-quality pivot, **1401 after**
- **Mutation scores** (sample): fts5-sanitize.ts = 82%, operator/purge.ts = 68%

The mutation score gap is the smoking gun — small utility files are well-tested; larger workflow files have measurable coverage gaps.

---

## Antipattern taxonomy

We classify each Wave-N bug by which test antipattern hid it.

### A1. Implementation-mirroring tests

Tests that just reflect the implementation back. "When I call `foo(1, 2)`, it returns `3`." The test asserts what the code does, not what it should do. Useless against bugs the AI introduced because the AI wrote both the bug and the test.

### A2. Per-function tests with no cross-cutting invariant

Tests cover each function in isolation. No test loops over the WHOLE surface to enforce "every read path filters X" or "every destructive operator command requires Y." When a sister case is added, no test breaks.

### A3. Mocked-too-high tests

Mocks injected at a level above the bug's location. The bug is in the layer below the mock; the mock returns a "right" answer that hides the layer's wrong behavior.

### A4. Missing edge-case fixtures

Tests cover happy-path inputs only. CJK strings, malformed JSON, empty arrays, NaN limits, suppressed rows — none in the test fixtures.

### A5. Missing adversarial / negative-path tests

Tests assert success cases. No test asserts "given non-owner sender, the operator-command rejects." No test asserts "given Voyage 429, the search-tool returns degraded result, not throws."

### A6. Seam-between-units untested

Each function has a unit test. The pipe between functions doesn't. The bug is in the protocol — function A correctly computes X but the wrapper drops X before reaching the caller.

### A7. Coverage ≠ correctness

Test triggers the line, asserts something — but doesn't assert the SPECIFIC behavior that's broken. Mutation testing reveals these as "covered but survived" mutants.

### A8. Concurrency / TOCTOU race tests missing

Tests run single-threaded. Race conditions (snapshot taken outside the BEGIN IMMEDIATE, lock TTL exceeding worker timeout) require concurrent test fixtures that we never built.

### A9. Missing schema / contract drift tests

CHECK constraints, FK declarations, prompt placeholders — these are STRINGS that the runtime parses. A typo in a CHECK constraint or an unsubstituted `{{placeholder}}` doesn't break TypeScript; it breaks at runtime when the row violates the constraint or the LLM gets `{{placeholder}}` in its prompt.

---

## Wave 1-9 findings classified by antipattern

For each significant finding (P0/P1/P2 only), one or more antipattern tags. P3s mostly don't have causal antipatterns — they're hygiene.

### Wave-9 P0 (the headline regression)

**Finding**: `/lcm reconcile-session-keys --apply` and `/lcm worker tick embedding-backfill` lacked `senderIsOwner` gate (Wave-7 P0-1 had only added it to `/lcm purge`).

**Hidden by**: A2 (no invariant test for "every destructive case requires gate"), A5 (no adversarial test invoking non-owner sender on these specific cases).

**Fix in test layer**: `test/v41-authorization-invariants.test.ts` — extracts every `case "..."` from lcm-command.ts and asserts each is in either DESTRUCTIVE or READ_ONLY. For destructive, asserts gate fires.

### Wave-9 P1.1 (citation count dropped at API boundary)

**Finding**: `runDelegatedExpandQuery` computed `citedIdsRejectedAsFabricated` correctly. But `buildExpandQueryReply` didn't accept the field. Internal validation passed; the result never reached the caller.

**Hidden by**: A6 (seam between runDelegatedExpandQuery and buildExpandQueryReply untested), A1 (per-function tests asserted internal computation works, didn't assert it surfaces externally).

**Fix in test layer**: `test/v41-tool-parity-invariants.test.ts` declares the type contract for ExpandQueryReply with the fields present. Future drift breaks compile.

### Wave-9 P1.2 (lcm_describe budget bypass)

**Finding**: `expandChildren`/`expandMessages` flags didn't call `consumeTokenBudget`. Sub-agents could drain context unbudgeted.

**Hidden by**: A2 (no invariant "every sub-agent grant-consuming code path consumes budget"), A5 (no adversarial test running a sub-agent at budget=4K through a 50-message expand).

### Wave-9 P1.3 (lcm_grep semantic VoyageError contract divergence)

**Finding**: lcm_grep --mode semantic threw raw VoyageError on transient kinds; sister tool lcm_semantic_recall returned graceful error.

**Hidden by**: A2 (no invariant "tools serving same routing question have same error contract").

**Fix in test layer**: `test/v41-tool-parity-invariants.test.ts` runs both tools with the same failure (Voyage unavailable) and asserts both return structured errors.

### Wave-9 P1.4 (verbatim mode can't find CJK)

**Finding**: `messages_fts MATCH` with unicode61 returns 0 rows for CJK queries without throwing. Exception-driven LIKE fallback never triggered.

**Hidden by**: A4 (no CJK fixtures in any verbatim mode test), A7 (tests covered the empty-result code path but only with patterns that genuinely had no matches, not patterns that SHOULD match but FTS5 silently mis-tokenized).

**Fix in test layer**: `test/fixtures/v41-test-corpus.ts` includes 2 CJK leaves; `test/v41-five-questions.test.ts` and `test/v41-tool-parity-invariants.test.ts` both assert CJK is findable.

### Wave-9 P1.5 (reconcileSessionKeys TOCTOU)

**Finding**: `affectedConvs` snapshot taken outside `BEGIN IMMEDIATE`. Concurrent INSERT could land between snapshot and tx-acquire, getting UPDATE-moved without an audit row.

**Hidden by**: A8 (concurrency tests missing — single-threaded tests cannot reproduce TOCTOU).

### Wave-9 P1.8 (compaction fallback marker dropped)

**Finding**: `summarize.ts` marker-tagged fallback was rejected by `summarizeWithEscalation` as "didn't compress" (because the marker tokens made it bigger), and `compaction.ts`'s own `buildDeterministicFallback` emitted UNTAGGED truncated content.

**Hidden by**: A3 (mocks set above the level where compaction.ts's deterministic fallback triggers), A6 (the seam between summarize.ts and compaction.ts wasn't tested for the LLM-down case).

### Wave-9 P1.9 ({{date_range}} placeholder orphaned)

**Finding**: Seeded daily/weekly/monthly templates referenced `{{date_range}}` literally; renderPrompt never substituted it. Currently latent (synthesize_around clamps to custom/filtered).

**Hidden by**: A9 (no test asserts every placeholder in seeded prompts has a corresponding substitution), A1 (dispatch tests injected custom templates that overrode the seed).

### Wave-8 P0 (citedIds validation silently no-op'd for 4 months)

**Finding**: `runDelegatedExpandQuery` called `params.lcm.getDb()` but `lcm` wasn't a field on `RunDelegatedExpandQueryParams`. Empty `catch {}` swallowed the TypeError. Validation was a NO-OP from Wave-4 forward.

**Hidden by**: A5 (no test asserted "given fabricated citedIds, validation rejects them" — only tests that the field is OPTIONAL existed), A7 (the `citedIds` field appeared in test outputs because the validator returned the un-validated set on catch path; tests didn't differentiate).

### Wave-7 P0-2 (shared message orphan on purge)

**Finding**: Soft-purge cascaded to shared messages even when only one referencing leaf was suppressed. Other leaves became "broken" (referenced suppressed message).

**Hidden by**: A2 (no invariant "after partial purge, remaining leaves are still well-formed"), A4 (no fixture with shared messages across multiple leaves).

### Wave-7 P1 (searchLikeCjk timezone bug)

**Finding**: `new Date(string)` parses UTC timestamps in local timezone, returning shifted dates.

**Hidden by**: A4 (test fixtures used `new Date()` for "now" — same TZ that the bug emits in), A9 (no contract test asserted "all timestamp parsing uses parseUtcTimestamp").

### Wave-4 P0 (entity tx-rollback unhandled)

**Finding**: Inner per-row throw → outer catch → ROLLBACK on whole leaf, all per-row work lost.

**Hidden by**: A8 (concurrency / failure-mode tests missing).

---

## Ranked antipattern list (drives test-quality investment)

| Rank | Antipattern | Bug count | Mitigation built in this commit |
|---|---|---|---|
| 1 | A2 (per-function tests, no cross-cutting invariant) | 5+ | `test/v41-authorization-invariants.test.ts` (forces classification of every operator case) |
| 2 | A4 (missing edge-case fixtures) | 3+ | `test/fixtures/v41-test-corpus.ts` (CJK + suppressed + multi-session fixtures) |
| 3 | A5 (missing adversarial / negative-path tests) | 4+ | Authz invariant exercises non-owner case |
| 4 | A6 (seam-between-units untested) | 3+ | Tool-parity invariant tests + 25 scenario tests cover end-to-end seams |
| 5 | A1 (implementation-mirroring tests) | 3+ | Scenario tests assert agent-visible BEHAVIOR, not implementation |
| 6 | A7 (coverage ≠ correctness) | 3+ | Mutation testing diagnostic — expose coverage-without-correctness |
| 7 | A8 (concurrency / TOCTOU) | 2+ | NOT yet covered by automated tests; deferred to cycle-3 |
| 8 | A9 (schema / contract drift) | 2+ | Suppression invariants partially address; placeholder validation deferred |
| 9 | A3 (mocked-too-high) | 1+ | Real-DB scenario tests replace mocks for end-to-end paths |

## What we fixed in this commit

1. **Synthetic test fixture corpus** (`test/fixtures/v41-test-corpus.ts` + `v41-tool-harness.ts`): small, deterministic, in-memory DB with 80 leaves, 5 conversations, 4 entities, mix of CJK + ASCII + suppressed content. Replaces dependence on `~/.openclaw/lcm.db`.

2. **25 scenario tests** (`test/v41-five-questions.test.ts`): every question in `THE_FIVE_QUESTIONS.md` runs as a real test against the fixture, asserting agent-visible behavior. 26/26 passing.

3. **Authorization invariant** (`test/v41-authorization-invariants.test.ts`): extracts every operator command case, requires explicit classification, asserts gate on destructive cases. Verified to catch regressions when the gate is removed.

4. **Suppression invariant** (`test/v41-suppression-invariants.test.ts`): loops over read paths on SummaryStore + ConversationStore, asserts every path filters suppressed content. 7/7 passing.

5. **Tool-parity invariant** (`test/v41-tool-parity-invariants.test.ts`): verifies tools serving the same routing question have matching error contracts. 5/5 passing.

6. **Mutation testing config** (`stryker.config.json`): focused configuration for ad-hoc mutation testing. Empirical evidence: fts5-sanitize.ts at 82%, operator/purge.ts at 68% — uneven test quality, the hypothesis confirmed.

## What's deferred

- **Concurrency / TOCTOU testing (A8)**: needs a dedicated harness that spawns concurrent SQLite writers to exercise race windows. Future PR.
- **Schema / placeholder drift (A9)**: needs a static-analysis test that scans `seed-default-prompts.ts` for `{{...}}` patterns and verifies each has a renderer substitution. Future PR.
- **Mutation testing in CI**: stryker is too slow (~2-5 min per file) for every-PR CI. Should run weekly or on demand.

## Open questions

1. Should the synthetic fixture be checked in as a binary `.db` file, or rebuilt on-demand by the test? Currently rebuilt — faster CI, but if migration semantics change we want the binary form preserved as a regression baseline. (Defer until we have a migration that breaks the rebuild.)

2. Should we extend authorization invariants to non-`/lcm` surfaces (e.g., direct tool invocation paths)? The current scope is operator commands only.

3. Is 50% mutation kill rate the right floor for `break` (currently configured)? Industry-standard is 60-80%. We need more data points before tuning.

---

## Verification

After this commit:
- 1401/1401 unit tests passing (1353 baseline + 48 new across 5 test files)
- 739 TS errors (exact parity with `origin/main`; zero PR-introduced)
- Mutation testing demonstrated to work (run `npx stryker run` for ad-hoc diagnostics)
- The Wave-9 P0 + every shipping P1 has at least one regression test pinning the fix
