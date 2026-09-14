# Tasks: fix-compaction-runtime-overhead-sign

## 1. Add failing regression tests (TDD — red phase)

- [ ] 1.1 Add a vitest case to `test/engine-compaction.test.ts` named
      `"observedRuntimeOverhead is positive when observed exceeds stored and arms sweep target"`
      that:
      - Mocks `evaluate` to return
        `{ shouldCompact: true, reason: "threshold",
          storedTokens: 7_000, observedTokens: 12_000,
          currentTokens: 12_000, threshold: 8_200 }`.
      - Mocks `compactFullSweep` to return
        `{ actionTaken: true, tokensBefore: 7_000,
          tokensAfter: 3_200, condensed: false }`.
      - Calls `engine.compact(...)` with
        `tokenBudget: 10_000, currentTokenCount: 12_000,
        compactionTarget: "threshold"`.
      - Asserts `compactFullSweep` was called with
        `stopAtTokens: 3_200` (i.e. `Math.max(1, 8_200 - 5_000)`).
      - Asserts `result.result.details.observedOverheadTokens`
        equals `5_000`.
      - (This test ALREADY passes on current main — it documents
        that positive-overhead behavior is unchanged.)
- [ ] 1.2 Add a vitest case to `test/engine-compaction.test.ts` named
      `"observedRuntimeOverhead preserves negative sign and omits stopAtTokens"`
      that:
      - Mocks `evaluate` to return
        `{ shouldCompact: true, reason: "threshold",
          storedTokens: 92_171, observedTokens: 88_235,
          currentTokens: 88_235, threshold: 8_200 }`.
      - Mocks `compactFullSweep` to return
        `{ actionTaken: true, tokensBefore: 92_171,
          tokensAfter: 70_000, condensed: false }`.
      - Calls `engine.compact(...)` with
        `tokenBudget: 10_000, currentTokenCount: 88_235,
        compactionTarget: "threshold"`.
      - Captures a `debug` log mock by passing a custom `log` via
        `createEngineWithDeps({}, { log })`.
      - Asserts `compactFullSweep` was called with an input that
        does NOT contain a `stopAtTokens` field (use
        `expect.objectContaining` plus
        `expect.not.objectContaining({ stopAtTokens: expect.anything() })`
        or assert directly on the spy call args).
      - Asserts `result.result.details.observedOverheadTokens`
        equals `-3_936` (the signed overhead), proving the sign
        is preserved end-to-end through the result details.
      - Asserts `log.debug` was called with a message containing
        both `[lcm] compact: observed runtime overhead negative`
        and `observedRuntimeOverhead=-3936` (or `-3_936`).
      - (This test FAILS on current main because
        `Math.max(0, 88_235 - 92_171) = 0` silently truncates the
        discrepancy, so the debug log is NOT emitted and the
        result details would show `0`, not `-3_936`.)
- [ ] 1.3 Add a vitest case to `test/engine-compaction.test.ts` named
      `"observedRuntimeOverhead zero does not arm sweep target and emits no debug log"`
      that:
      - Mocks `evaluate` to return
        `{ shouldCompact: true, reason: "threshold",
          storedTokens: 9_000, observedTokens: 9_000,
          currentTokens: 9_000, threshold: 8_200 }`.
      - Mocks `compactFullSweep` to return
        `{ actionTaken: true, tokensBefore: 9_000,
          tokensAfter: 7_000, condensed: false }`.
      - Calls `engine.compact(...)` with
        `tokenBudget: 10_000, currentTokenCount: 9_000,
        compactionTarget: "threshold"`.
      - Asserts `compactFullSweep` was called with an input that
        does NOT contain a `stopAtTokens` field (because the gate
        is `> 0`, not `>= 0`).
      - Asserts `result.result.details.observedOverheadTokens`
        equals `0`.
      - Asserts `log.debug` was NOT called with a message
        containing `observed runtime overhead negative`.
      - (This test ALREADY passes on current main — it documents
        that zero-overhead behavior is unchanged.)
- [ ] 1.4 Run `npm test -- test/engine-compaction.test.ts` and
  confirm:
  - Test 1.1 PASSES (positive overhead unchanged).
  - Test 1.2 FAILS (negative overhead truncated, debug log not
    emitted).
  - Test 1.3 PASSES (zero overhead unchanged).
  - Red phase confirmed.

## 2. Implement the fix in `src/engine.ts` (green phase)

- [ ] 2.1 In `executeCompactionCore` at src/engine.ts:2048-2051,
  replace
  ```ts
  const observedRuntimeOverhead =
    params.compactionTarget === "threshold" && compactableObservedTokens !== undefined
      ? Math.max(0, compactableObservedTokens - decisionStoredTokens)
      : 0;
  ```
  with
  ```ts
  const observedRuntimeOverhead =
    params.compactionTarget === "threshold" && compactableObservedTokens !== undefined
      ? compactableObservedTokens - decisionStoredTokens
      : 0;
  ```
- [ ] 2.2 Right after the existing `[lcm] compact: decision …`
  info log at src/engine.ts:2084-2086, add a debug log when the
  overhead is negative:
  ```ts
  if (observedRuntimeOverhead < 0) {
    this.deps.log.debug(
      `[lcm] compact: observed runtime overhead negative conversation=${conversationId} ${sessionLabel} storedTokens=${decisionStoredTokens} observedTokens=${compactableObservedTokens} observedRuntimeOverhead=${observedRuntimeOverhead} — LCM stored counter exceeds host-observed prompt; methodology gap, no runtime sweep target adjustment`,
    );
  }
  ```
- [ ] 2.3 Confirm no new imports are needed (`deps.log` and
  `sessionLabel` are already in scope).
- [ ] 2.4 Run the failing tests from §1 — they MUST now pass.

## 3. Verify no regressions

- [ ] 3.1 Run
      `npm test -- test/engine-compaction.test.ts
      test/engine-maintenance.test.ts
      test/engine-after-turn.test.ts`.
      All previously-passing tests SHALL continue to pass; the
      three new tests SHALL pass.
- [ ] 3.2 Run `npm run typecheck` and confirm no new TypeScript
  errors.
- [ ] 3.3 Manually trace the call path from
      `executeCompactionCore` →
      `observedRuntimeOverhead` →
      `runtimeAdjustedSweepTargetTokens` →
      `compactFullSweep` and confirm:
  - Positive overhead → `stopAtTokens` passed (unchanged).
  - Negative overhead → `stopAtTokens` omitted, debug log emitted
    (new).
  - Zero overhead → `stopAtTokens` omitted, no debug log
    (unchanged).
  - `observedRuntimeOverhead = 0` short-circuits to `undefined`
    via the existing `> 0` guard (unchanged).
- [ ] 3.4 Manually confirm `CompactResult.result.details.observedOverheadTokens`
  now carries the signed overhead for negative cases.

## 4. Release notes & PR

- [ ] 4.1 Add a Changeset entry:
      `cat > .changeset/fix-compaction-runtime-overhead-sign.md <<'EOF'
      ---
      "@martian-engineering/lossless-claw": patch
      ---

      Fix LCM compaction `observedRuntimeOverhead` to preserve the
      sign of the LCM-vs-host methodology gap instead of silently
      truncating negative values to zero. Surfaces the discrepancy
      in a debug log when the host-observed prompt is smaller than
      LCM's stored-side counter (e.g. cache hits shrinking the
      visible prompt below LCM's JSON-length estimate) without
      changing sweep behavior: positive overhead still arms the
      runtime-adjusted sweep target, negative and zero overhead
      both leave it unset.
      EOF`
- [ ] 4.2 Open a PR referencing the failure-analysis report and
  this change. Confirm the PR description calls out:
  - The single file / single-expression change
    (`src/engine.ts:2048-2051`).
  - The three new regression tests.
  - The out-of-scope P1/P2 items (transcript-wedge widening,
    backoff tuning, `/new` automation) explicitly deferred to
    follow-up changes.
- [ ] 4.3 Run
      `openspec validate --changes
      changes/fix-compaction-runtime-overhead-sign --strict` and
      confirm the change is well-formed before requesting review.

## 5. Post-merge

- [ ] 5.1 Confirm CI is green on the merged commit.
- [ ] 5.2 Confirm a maintainer has linked the changeset to the next
  release per `RELEASING.md` before publishing.
- [ ] 5.3 Do NOT begin work on the deferred P1/P2 items in this
  PR. Each gets its own OpenSpec change.