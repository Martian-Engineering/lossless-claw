# Compaction Redesign Map

Status: implementation pass  
Date: 2026-05-14  
Branch: `josh/compaction-redesign`

## Goal

Lossless should stop trying to infer whether a provider prompt cache is hot or cold before deciding whether to compact. The old cache-aware incremental strategy could not be made sound with the signals available to Lossless: by the time a low cache-read observation arrives, the provider has usually already rewritten the cache for that turn. Without a reliable `expiresAt` signal, Lossless cannot safely tell "cold before this turn" from "cold during this turn, now hot again."

The new design is intentionally simpler:

1. Do not run automatic incremental compaction from raw-history pressure.
2. Let context grow in the assembled transcript until the configured threshold is crossed.
3. When `contextThreshold` is crossed, run the existing full-sweep mechanism.
4. Keep the fresh tail as the protected boundary for recent verbatim context.
5. Reuse existing summary sizing and fanout configuration.
6. Use a summarized-prefix pressure target only as the escape hatch when a preferred-depth sweep does not reduce enough context.

## Implemented Decisions

| Decision | Outcome |
| --- | --- |
| Automatic compaction trigger | `contextThreshold` only. |
| Raw leaf trigger | Kept as a diagnostic/manual helper; removed from automatic scheduling. |
| Deferred debt | New automatic debt uses only reason `"threshold"`. |
| Cache hotness | No longer delays automatic threshold compaction. |
| Legacy non-threshold debt | Revalidated against threshold, then swept or marked finished as obsolete. |
| Full sweep trigger | No longer starts only because `evaluateLeafTrigger()` is true. |
| Full sweep preferred depth | `compactFullSweep()` now respects `sweepMaxDepth` during routine condensation. |
| Fresh tail | Kept. It remains independent of incremental compaction. |
| Default leaf chunk size | Kept at 20k tokens. |
| Deprecated depth key | `incrementalMaxDepth` remains accepted as an alias for `sweepMaxDepth`. |
| Pressure escape hatch | `summaryPrefixTargetTokens` lets sweeps condense beyond the preferred depth when summarized context remains too large. |
| `cacheAwareCompaction.*` | Still visible and accepted, but documented as deprecated compatibility config. |
| `dynamicLeafChunkTokens.*` | Still visible and accepted, but documented as deprecated compatibility config. |
| Engine `compactLeafAsync()` | Removed. Automatic and public engine compaction should go through threshold/full-sweep paths. |
| `CompactionEngine.compactLeaf()` | Kept as a lower-level helper and for focused tests. |
| Stable hot-cache orphan stripping | Removed with the cache-state-dependent assembly behavior. |

## Current Lifecycle

### Ingestion and After-Turn Scheduling

`LcmContextEngine.afterTurn()` now follows one automatic policy:

```text
afterTurn -> ingest messages -> update telemetry -> evaluate contextThreshold

if below threshold:
  do not compact
  do not record maintenance debt

if threshold is crossed and mode is inline:
  run threshold full sweep inline

if threshold is crossed and mode is deferred:
  record one threshold maintenance row
  schedule the background drain
```

The raw-history leaf trigger is no longer part of this lifecycle. `evaluateLeafTrigger()` can still answer "is there enough old raw material for a leaf pass?", but that answer does not cause automatic maintenance.

Relevant code:

- `src/engine.ts`: `afterTurn()`
- `src/engine.ts`: `recordDeferredCompactionDebt()`
- `src/store/compaction-maintenance-store.ts`: one coalesced maintenance row per conversation
- `src/compaction.ts`: `evaluateLeafTrigger()`

### Deferred Debt

Deferred maintenance still exists because threshold sweeps can be expensive and should often happen outside the critical response path.

New automatic debt should always use:

```text
reason = "threshold"
```

When the debt drains, Lossless calls threshold full sweep via `executeCompactionCore({ compactionTarget: "threshold" })`. Prompt-cache telemetry and TTLs are not consulted. Session queue idleness remains relevant because compaction should not race active session work.

Old databases may contain pending non-threshold debt from previous builds. The compatibility behavior is:

- re-evaluate `contextThreshold` at consumption time
- if the conversation is over threshold, run threshold full sweep
- if it is under threshold, mark the old debt finished with a no-op legacy reason

This clears obsolete maintenance rows without deleting persisted conversation data.

Relevant code:

- `src/engine.ts`: `drainDeferredCompactionDebtNow()`
- `src/engine.ts`: `consumeDeferredCompactionDebt()`
- `src/engine.ts`: `maintain()`
- `src/engine.ts`: pre-assembly maintenance drain

### Full Sweep

`CompactionEngine.compact()` delegates to `compactFullSweep()`.

The sweep has two phases:

1. Leaf phase: repeatedly summarize the oldest raw chunks outside the fresh tail.
2. Condensed phase: if summarized-prefix tokens exceed `summaryPrefixTargetTokens`, repeatedly summarize same-depth summary chunks, shallowest first.

Routine threshold sweeps use `contextThreshold` to decide when to start compaction. Once started, the leaf phase runs until no eligible raw-message chunk remains outside the fresh tail. Condensation is controlled by `summaryPrefixTargetTokens`, not by total context pressure. Forced sweeps still stop when no eligible chunk remains or when a pass stops making token progress.

`sweepMaxDepth` is the preferred source-depth cap for routine full-sweep condensation:

- `0`: leaf summaries only
- `1`: depth-0 summaries may condense into depth 1, then stop
- `2`: depth 0 -> 1 and depth 1 -> 2 are allowed
- `-1`: unlimited

The cap is intentionally aspirational. If summary tokens outside the fresh tail exceed `summaryPrefixTargetTokens` after routine condensation, Lossless runs a pressure condensation phase that may go deeper using `condensedMinFanoutHard`.

Relevant code:

- `src/compaction.ts`: `compactFullSweep()`
- `src/compaction.ts`: `selectOldestLeafChunk()`
- `src/compaction.ts`: `selectShallowestCondensationCandidate()`
- `src/compaction.ts`: `resolveSweepMaxDepth()`
- `src/compaction.ts`: `resolveSummaryPrefixTargetTokens()`

### Fresh Tail

The fresh tail is not incremental compaction. It stays because it protects recent verbatim context and gives both assembly and compaction a stable boundary.

The fresh tail:

- is always included during assembly
- is excluded from leaf summarization
- may be capped by `freshTailMaxTokens`
- still preserves the newest message even when that one message exceeds the cap

Relevant code:

- `src/assembler.ts`: `resolveFreshTailOrdinal()`
- `src/assembler.ts`: `Assembler.assemble()`
- `src/compaction.ts`: `resolveFreshTailOrdinal()`
- `src/compaction.ts`: `countRawTokensOutsideFreshTail()`

## Removed Automatic Policy

The old `evaluateIncrementalCompaction()` path combined:

- prompt-cache telemetry
- hot/cold/unknown cache-state heuristics
- cache TTL guesses
- dynamic leaf chunk sizing
- raw-history pressure outside the fresh tail
- bounded cold-cache catch-up
- hot-cache leaf-only behavior
- budget-headroom gates

That policy is removed from automatic scheduling. The important reason is not that each individual heuristic was unreasonable; it is that the combined decision depended on cache state that Lossless cannot reliably observe at the time it must decide whether to mutate the prompt prefix.

## Config Semantics

### Active Settings

| Key | Role |
| --- | --- |
| `contextThreshold` | The only automatic compaction trigger. |
| `proactiveThresholdCompactionMode` | Chooses inline vs deferred threshold full sweep. |
| `freshTailCount` | Protects newest raw messages during assembly and compaction. |
| `freshTailMaxTokens` | Optional cap for protected fresh-tail size. |
| `leafChunkTokens` | Maximum raw material per leaf summary during sweep; default remains 20k. |
| `leafMinFanout` | Minimum raw-message or depth-0 summary fanout for useful compaction. |
| `condensedMinFanout` | Normal same-depth condensation grouping for depth 1+. |
| `condensedMinFanoutHard` | Hard-trigger/repair condensation grouping. |
| `sweepMaxDepth` | Preferred source-depth cap for routine threshold full sweep. |
| `summaryPrefixTargetTokens` | Optional target for summarized-prefix tokens; pressure condensation may go deeper if this target is missed. |
| `leafTargetTokens` | Leaf summary target. |
| `condensedTargetTokens` | Condensed summary target. |

### Deprecated Compatibility Settings

| Key | Status |
| --- | --- |
| `incrementalMaxDepth` | Accepted as a deprecated alias for `sweepMaxDepth`. New config should use `sweepMaxDepth`. |
| `cacheAwareCompaction.*` | Accepted and visible as deprecated config. It no longer changes automatic compaction decisions. |
| `dynamicLeafChunkTokens.*` | Accepted and visible as deprecated config. Automatic compaction uses `leafChunkTokens` directly. |

Keeping these settings visible avoids breaking existing OpenClaw config and gives operators an explicit deprecation signal instead of silently hiding known keys.

## Stable Orphan Stripping Tradeoff

The old cache-aware assembly path could preserve a stable hot-cache boundary by overriding tool-call orphan stripping at a previously observed ordinal. This was removed with the rest of the cache-state-dependent assembly behavior.

Benefits of removal:

- the assembled prompt no longer changes based on inferred cache hotness
- assembly has fewer hidden stateful branches
- prompt-prefix behavior is easier to reason about and test
- cache telemetry remains diagnostic instead of controlling prompt mutation

Cost of removal:

- Lossless gives up one cache-oriented prefix-stability optimization for tool-call boundaries
- in some hot-cache sessions, ordinary tool-pair repair may alter the prefix sooner than the old stable-boundary override would have

The ordinary assembler still sanitizes tool-use/tool-result pairing, so this is a cache-efficiency tradeoff rather than a transcript-correctness tradeoff.

## Test Coverage

The implementation should cover:

- below-threshold turns do not compact and do not record debt
- threshold crossings record only `"threshold"` debt in deferred mode
- inline mode runs threshold full sweep rather than leaf-trigger compaction
- background drain consumes threshold debt without prompt-cache telemetry or TTL
- `maintain()` consumes threshold debt without prompt-cache delay
- pre-assembly drain consumes threshold debt without prompt-cache delay
- legacy non-threshold debt is cleared when threshold no longer applies
- legacy non-threshold debt is upgraded to threshold full sweep when threshold still applies
- `compactFullSweep()` treats `sweepMaxDepth` as a preferred depth
- `compactFullSweep()` pressure-condenses past `sweepMaxDepth` when threshold or summary-prefix pressure remains
- the fresh tail remains verbatim and un-compacted

Removed or rewritten coverage:

- hot-cache delay gate tests
- cold-cache catch-up tests
- dynamic automatic leaf chunk tests
- automatic leaf debt tests
- engine-level `compactLeafAsync()` tests
- stable hot-cache orphan-stripping tests

## Non-Goals

- Do not add a total-context target floor in this pass.
- Do not remove persisted telemetry or maintenance tables.
- Do not parallelize full-sweep leaf summaries yet. The current leaf prompt uses prior summary continuity, so parallelization would require a separate semantic design.
- Do not depend on provider cache `expiresAt`.
- Do not remove accepted deprecated config keys until a separate migration decision is made.

## Follow-Up Watch Items

1. If repeated threshold re-entry happens in live use, tune `summaryPrefixTargetTokens`, `contextThreshold`, `leafChunkTokens`, and fanout before adding a total-context target floor.
2. If 20k leaf chunks make threshold sweeps too frequent, consider 30k before adding new mechanisms.
3. If stable orphan stripping removal causes measurable cache regressions in tool-heavy sessions, revisit it as an assembly feature independent of cache-hotness inference.
