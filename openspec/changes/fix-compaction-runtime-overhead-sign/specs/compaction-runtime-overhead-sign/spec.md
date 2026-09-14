# Spec delta: compaction-runtime-overhead-sign (MODIFIED capability)

## Purpose

Defines how `executeCompactionCore` derives
`observedRuntimeOverhead = compactableObservedTokens -
decisionStoredTokens` so the sign of the discrepancy between LCM's
stored-side counter and the host-observed prompt token count is
preserved, and a debug log surfaces the gap when the host sees a
smaller prompt than LCM estimates.

## MODIFIED Requirements

### Requirement: observedRuntimeOverhead preserves the sign of the LCM-vs-host discrepancy

When `executeCompactionCore` resolves the runtime-side overhead from
`compactableObservedTokens` and `decisionStoredTokens`, the system
SHALL compute the signed difference `compactableObservedTokens -
decisionStoredTokens`. The previous `Math.max(0, …)` clamp that
silently truncated negative values to zero is REMOVED.

The system SHALL keep the existing `> 0` guard on
`runtimeAdjustedSweepTargetTokens`, so negative and zero overhead
both leave the runtime-adjusted sweep target unset; positive
overhead continues to arm it identically to before.

#### Scenario: Positive overhead — runtime-adjusted sweep target is armed

- **WHEN** `compactableObservedTokens = 12_000` AND
  `decisionStoredTokens = 7_000` AND
  `compactionTarget = "threshold"` AND
  `targetTokens = 8_200` (from `decision.threshold`).
- **THEN** `observedRuntimeOverhead` SHALL equal `5_000` AND
  `runtimeAdjustedSweepTargetTokens` SHALL equal
  `Math.max(1, 8_200 - 5_000) = 3_200` AND
  `compaction.compactFullSweep` SHALL be invoked with
  `stopAtTokens: 3_200`. Behavior SHALL be identical to the
  pre-fix observable behavior for positive overhead.

#### Scenario: Negative overhead — discrepancy is preserved and debug-logged

- **WHEN** `compactableObservedTokens = 88_235` AND
  `decisionStoredTokens = 92_171` AND
  `compactionTarget = "threshold"`.
- **THEN** `observedRuntimeOverhead` SHALL equal `-3_936` AND
  `runtimeAdjustedSweepTargetTokens` SHALL be `undefined` (the
  existing `> 0` guard stays closed) AND
  `compaction.compactFullSweep` SHALL be invoked **without** a
  `stopAtTokens` field AND a `debug`-level log line prefixed
  `[lcm] compact: observed runtime overhead negative` SHALL be
  emitted that includes `conversationId`, the `sessionLabel`,
  `storedTokens=92_171`, `observedTokens=88_235`, and
  `observedRuntimeOverhead=-3_936`. This is the new behavior
  the fix unblocks: the LCM-vs-host methodology gap that was
  previously truncated to `0` is now visible.

#### Scenario: Zero overhead — behavior is unchanged

- **WHEN** `compactableObservedTokens` equals `decisionStoredTokens`
  AND `compactionTarget = "threshold"`.
- **THEN** `observedRuntimeOverhead` SHALL equal `0` AND
  `runtimeAdjustedSweepTargetTokens` SHALL be `undefined` (the
  existing `> 0` guard stays closed because `0 > 0` is false)
  AND `compaction.compactFullSweep` SHALL be invoked **without** a
  `stopAtTokens` field AND the negative-overhead debug log SHALL
  NOT be emitted (the gate is `< 0`, not `<= 0`). Behavior SHALL
  be identical to the pre-fix observable behavior for
  zero-overhead sessions.

### Requirement: Negative-overhead debug log is emitted exactly once per compact

When `observedRuntimeOverhead < 0`, the system SHALL emit one
`debug`-level log line under the `[lcm] compact:` prefix that
records the discrepancy. The log SHALL NOT be emitted when
`observedRuntimeOverhead >= 0`, and SHALL NOT be emitted more than
once per `executeCompactionCore` call.

#### Scenario: Negative overhead triggers the debug log

- **WHEN** the conditions for a negative overhead are met (see
  the "Negative overhead" scenario above).
- **THEN** exactly one `debug`-level call to `deps.log.debug`
  SHALL match a string containing both
  `[lcm] compact: observed runtime overhead negative` and
  `observedRuntimeOverhead=` with a negative numeric value, with
  the conversation id, stored tokens, observed tokens, and the
  signed overhead all present in the message.

#### Scenario: Zero overhead does not trigger the debug log

- **WHEN** `compactableObservedTokens` equals `decisionStoredTokens`
  AND `compactionTarget = "threshold"`.
- **THEN** the negative-overhead debug log SHALL NOT be emitted.

### Requirement: Backward compatibility — public API and persisted schema unchanged

The change SHALL NOT alter the public method signature of
`compact()`, SHALL NOT alter the `compaction_evaluator` argument
contract, and SHALL NOT add, remove, or rename any persisted
column. Persisted compaction-telemetry snapshots and maintenance
counters SHALL continue to be read and written exactly as before;
only the sign of the derived `observedRuntimeOverhead` is exposed
instead of being silently clamped.

#### Scenario: Public signatures unchanged

- **WHEN** the change is applied.
- **THEN** a static type-check (`tsc --noEmit` or equivalent)
  against the existing public API surfaces SHALL continue to pass
  with no new errors.

#### Scenario: Persisted schema unchanged

- **WHEN** the change is applied.
- **THEN** the database migrations SHALL be byte-for-byte
  unchanged and existing rows SHALL continue to be readable
  without a one-time backfill.

#### Scenario: Positive-overhead downstream behavior is unchanged

- **WHEN** `observedRuntimeOverhead > 0` (i.e. host sees a larger
  prompt than LCM estimates, e.g. live system prompt + tool
  schemas).
- **THEN** `runtimeAdjustedSweepTargetTokens` SHALL still equal
  `Math.max(1, targetTokens - observedRuntimeOverhead)`, the
  sweep SHALL still pass `stopAtTokens: runtimeAdjustedSweepTargetTokens`
  to `compaction.compactFullSweep`, and the
  `CompactResult.result.details.observedOverheadTokens` field
  SHALL still be populated with the (now signed) overhead value.