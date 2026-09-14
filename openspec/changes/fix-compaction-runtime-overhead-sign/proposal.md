# Proposal: fix-compaction-runtime-overhead-sign

## Why

`executeCompactionCore` (src/engine.ts:2048-2051) derives the
runtime-side overhead as

```typescript
const observedRuntimeOverhead =
  params.compactionTarget === "threshold" && compactableObservedTokens !== undefined
    ? Math.max(0, compactableObservedTokens - decisionStoredTokens)
    : 0;
```

The `Math.max(0, …)` is an implicit assumption that the host's
observed prompt is always at least as large as LCM's internal stored
counter. In reality the two are computed by different methods and
`storedTokens > observedTokens` is observable:

- LCM uses `JSON.stringify().length/4` (rough heuristic, source
  tokens perspective).
- The host reports a tiktoken-style precise count, frequently after
  cache hits and after prompt caching has collapsed repeated system
  blocks. Host-visible prompt is smaller than LCM's self-estimate.
- Session 996 evidence (a 128k third-party model deployment):
  `decisionStoredTokens = 92_171`, true
  `observedTokens = 88_235`, so
  `Math.max(0, 88_235 - 92_171) = 0` — the discrepancy is silently
  truncated and the runtime-adjustment branch
  (`runtimeAdjustedSweepTargetTokens`) is never armed, so the sweep
  target stays at the stored-side threshold and the session keeps
  wedging on "compacted but still over target".

This is item 2 (P0 priority) of the failure-analysis report
produced for this engagement. The fix is a one-line semantic
change mirroring an existing pattern: stop truncating and let the
sign of the discrepancy flow downstream so operators can see it.

## What Changes

### `executeCompactionCore` — drop the `Math.max(0, …)` truncation

Replace at src/engine.ts:2048-2051

```typescript
const observedRuntimeOverhead =
  params.compactionTarget === "threshold" && compactableObservedTokens !== undefined
    ? Math.max(0, compactableObservedTokens - decisionStoredTokens)
    : 0;
```

with

```typescript
const observedRuntimeOverhead =
  params.compactionTarget === "threshold" && compactableObservedTokens !== undefined
    ? compactableObservedTokens - decisionStoredTokens
    : 0;
```

The downstream consumer at src/engine.ts:2052-2057 already gates
the runtime-adjusted sweep target on `observedRuntimeOverhead > 0`,
so:

- **Positive overhead** (host sees more than LCM stored, e.g. live
  system prompt + tool schemas push observed above stored):
  identical behavior, `runtimeAdjustedSweepTargetTokens` is armed
  and the sweep stops at the lower target.
- **Negative overhead** (host sees less than LCM stored, e.g. cache
  hits shrink the visible prompt below LCM's JSON-length estimate):
  no runtime-adjusted sweep target is armed (matches the
  `observedRuntimeOverhead > 0` gate), and the discrepancy is now
  visible in the existing `[lcm] compact: decision …` and
  `[lcm] compact: transcript wedge detected …` info/warn logs that
  already emit `observedRuntimeOverhead=<value>`.
- **Zero overhead** (host and LCM agree exactly): identical
  behavior. The `> 0` gate stays closed so no adjustment is armed.

### Debug log when overhead is negative

Add a `debug`-level log line under the existing `[lcm] compact: …`
prefix when `observedRuntimeOverhead < 0`. Format:

```typescript
if (observedRuntimeOverhead < 0) {
  this.deps.log.debug(
    `[lcm] compact: observed runtime overhead negative conversation=${conversationId} ${sessionLabel} storedTokens=${decisionStoredTokens} observedTokens=${compactableObservedTokens} observedRuntimeOverhead=${observedRuntimeOverhead} — LCM stored counter exceeds host-observed prompt; methodology gap, no runtime sweep target adjustment`,
  );
}
```

This surfaces the LCM-vs-host methodology gap at `debug` (so it does
not spam `info`), keeping operators informed that the host-visible
prompt is smaller than LCM's stored estimate.

### Regression tests (vitest, under `test/engine-compaction.test.ts`)

Add cases that verify, with `compaction.evaluate` and
`compaction.compactFullSweep` mocked:

- (a) **Positive overhead** — observed (12_000) > stored (7_000),
      `compactFullSweep` is called with `stopAtTokens: 3_200`
      (`Math.max(1, targetTokens − observedRuntimeOverhead)` =
      `Math.max(1, 8_200 − 5_000)`). Mirrors the existing
      "forces threshold sweeps to account for runtime prompt
      overhead" regression.
- (b) **Negative overhead** — observed (88_235) < stored (92_171),
      `compactFullSweep` is called **without** `stopAtTokens`, AND
      a debug log line prefixed
      `[lcm] compact: observed runtime overhead negative` is
      emitted. This is the new behavior the fix unblocks.
- (c) **Zero overhead** — observed == stored, no
      `stopAtTokens`, no negative-overhead debug log (because the
      gate is `> 0`, not `>= 0`; existing behavior preserved).

Tests follow the existing patterns (`createEngine`,
`createEngineWithDeps`, mock `evaluate` and `compactFullSweep` via
`vi.spyOn` on `privateEngine.compaction`, inspect the
`CompactResult.result.details.observedOverheadTokens` field that the
existing code already populates).

### Changeset

A `.changeset/*.md` entry will be added at PR time. Suggested bump:
**`patch`** (bug fix; no public API change; no schema change).

## Capabilities

### `compaction-runtime-overhead-sign` (modified)

- `observedRuntimeOverhead` is now the signed difference
  `compactableObservedTokens - decisionStoredTokens` whenever both
  are available, rather than the clamped non-negative form.
- The downstream guard at src/engine.ts:2052-2057 that turns the
  overhead into `runtimeAdjustedSweepTargetTokens` remains
  gated on `> 0` — positive values still arm the adjustment,
  negative and zero values leave it unset, matching the pre-fix
  observable behavior for zero-overhead sessions.
- A debug log line is emitted when the overhead is negative so
  operators see the LCM-vs-host methodology gap that previously
  vanished.

This change is additive on top of existing
`observedRuntimeOverhead` behavior: every prior call shape continues
to work; only the sign of the discrepancy is now exposed instead
of being silently clamped.

## Impact

- **User-facing behavior**: Sessions where the host's prompt token
  count is smaller than LCM's stored-side counter (e.g. cache hits
  shrinking the visible prompt below LCM's JSON-length estimate)
  now keep the discrepancy visible in the `[lcm] compact: …` debug
  log. The runtime-adjusted sweep target is still gated on
  positive overhead, so the conservative "do not adjust target"
  behavior is preserved for those sessions. For sessions with
  positive overhead, behavior is unchanged. For sessions with
  zero overhead, behavior is unchanged.
- **Public API**: No change. `ContextEngine.compact()` and the
  internal `executeCompactionCore` parameter shapes are unchanged.
- **Database schema**: No change. Existing rows continue to be read.
- **Performance**: No change. One new debug log call when
  `observedRuntimeOverhead < 0`; otherwise identical control flow.
- **Risk**: Low. The fix is a one-line change strictly within one
  expression, removing an implicit clamp. The downstream guard
  already restricts the side effect to positive values, so the
  observable behavior for positive overhead is identical and the
  observable behavior for negative overhead was already "no
  adjustment armed" (the truncation just hid the sign). Three
  regression tests cover both the new behavior and the unchanged
  behaviors.

## Out of Scope (deferred to follow-up changes)

The failure analysis report identifies additional items that are
explicitly **NOT** included in this change:

1. Widening the transcript-wedge trigger so it fires without an
   explicit `observedTokens` argument.
2. Tuning the summary-spend backoff duration so drained debt does
   not re-arm on the next turn.
3. Automating the `/new` reset recovery after a transcript wedge so
   users do not have to invoke it manually.

Each of these gets its own OpenSpec change proposal with its own
scoping and review.