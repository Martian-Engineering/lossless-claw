# Configuration

This reference covers the current `lossless-claw` config surface on `main`, based on `openclaw.plugin.json`, [`docs/configuration.md`](../../../docs/configuration.md), and the runtime defaults in [`src/db/config.ts`](../../../src/db/config.ts).

`lossless-claw` is most effective when the operator understands which settings change compaction behavior and why.

## First checks

- Ensure the plugin is installed and enabled.
- Ensure the context-engine slot points at `lossless-claw` when you want it to own compaction.
- Run `/lossless` (`/lcm` alias) to confirm the plugin is active and see the live DB path.

## High-impact settings

These are the settings most operators should understand first.

### `contextThreshold`

Controls how full the model context can get before LCM compacts older material.

- Lower values compact earlier.
- Higher values compact later.

Why it matters:

- Too low increases summarization cost and churn.
- Too high risks hitting the model window with large tool output or long replies.

Good default:

- `0.75`

### `contextThresholdOverrides`

Optional ordered rules that choose a different compaction threshold for matching runtime contexts.

Supported match fields:

- `model`: exact runtime model id, such as `openai/gpt-5.5`
- `modelContextWindowMin`: match models/windows at or above this token count
- `modelContextWindowMax`: match models/windows at or below this token count
- `sessionPattern`: session-key glob, using the same `*` and `**` semantics as ignored/stateless sessions

Rules are AND-matched: if a rule includes both `model` and `sessionPattern`, both must match. If multiple rules match, Lossless picks the highest-specificity rule, then the earliest rule in the array for ties. If no rule matches, it falls back to global `contextThreshold`.

Example:

```json
{
  "contextThreshold": 0.75,
  "contextThresholdOverrides": [
    {
      "name": "large-context-models",
      "match": { "modelContextWindowMin": 900000 },
      "contextThreshold": 0.15
    },
    {
      "name": "telegram-sessions",
      "match": { "sessionPattern": "agent:*:telegram:**" },
      "contextThreshold": 0.3
    }
  ]
}
```

Debugging:

- threshold-selection logs include the selected threshold, source, rule index/name, token budget, threshold tokens, model, context-window value, and match reason
- there is no env-var override for `contextThresholdOverrides`; use plugin config for structured rules

### `freshTailCount`

Keeps the newest messages raw instead of compacting them.

Why it matters:

- Higher values preserve near-term conversational nuance.
- Lower values free context budget sooner.

Good starting range:

- `32` to `64`

### `freshTailMaxTokens`

Optional token cap for the protected fresh tail.

Why it matters:

- Prevents a few huge tool results from making the "fresh" suffix effectively uncompactable.
- Still preserves the newest message even if that single message exceeds the cap.

Good starting range:

- Leave unset unless large tool outputs are forcing avoidable cost or overflow.
- Start around `12000` to `32000` when you want a softer, size-aware fresh tail.

### `promptAwareEviction`

Controls whether budget-constrained assembly keeps older context by prompt relevance or pure chronology.

Why it matters:

- when enabled, lossless-claw can keep an older but on-topic summary instead of a newer irrelevant one
- this can improve retrieval quality when the assembled context is tight
- it also makes the preserved prompt prefix less stable, which can reduce prefix-based prompt-cache hit rates

Good default:

- `false`
- enable it only when topical older-context recall under tight budgets matters more than prompt-cache stability

### `stubLargeToolPayloads`

Controls whether older, evictable tool-result rows that were backfilled into the `large_files` store are assembled as compact `[LCM Tool Output: file_xxx ...]` stubs instead of full inline payloads.

Why it matters:

- it reuses the existing `large_files` drilldown path for old tool output without changing the fresh tail
- it can recover substantially more historical context at the same token budget in tool-heavy sessions
- it should stay off until the operator has run `scripts/lcm-blob-migrate.mjs` for the target database

Good default:

- `false`
- enable it only after migration and live validation

### `leafChunkTokens`

Caps how much raw material gets summarized into one leaf summary.

Why it matters:

- Larger chunks reduce summarization frequency.
- Smaller chunks create more summaries and more DAG fragmentation.
- The default is 20000 tokens.

Use this when:

- Your summarizer is rate-limited or expensive.
- You want fewer but broader leaf summaries.

### `cacheAwareCompaction`

Deprecated compatibility object. Lossless still accepts and reports these settings, but automatic compaction no longer uses prompt-cache hot/cold state.

Why it matters:

- Existing OpenClaw configs continue to load without schema errors.
- Operators can see that the settings are deprecated instead of silently losing familiar keys.
- Prompt-cache telemetry remains useful for diagnostics, but it no longer gates compaction.

Good defaults:

- Leave existing values in place during migration.
- Do not tune these settings to affect automatic compaction; use `contextThreshold`, `leafChunkTokens`, and fanout instead.

Operationally:

- threshold debt does not wait for cache TTL
- cold-cache catch-up passes have been removed
- cache-aware raw-history pressure no longer triggers automatic maintenance

### `dynamicLeafChunkTokens`

Deprecated compatibility object. Automatic compaction now uses `leafChunkTokens` directly.

Why it matters:

- Existing config stays accepted.
- The resolved default still appears in status/config output.
- It no longer changes automatic compaction chunk size.

Good defaults:

- `enabled: true`
- `max: 2 * leafChunkTokens`

With the default `leafChunkTokens=20000`, that means:

- `dynamicLeafChunkTokens.max = 40000`

### `sweepMaxDepth`

Controls how far routine threshold full-sweep condensation tries to cascade after leaf compaction.

Why it matters:

- `0` keeps only leaf summaries moving automatically.
- `1` is a practical default for long-running sessions.
- `-1` allows unlimited cascading, which can be useful for very long histories but is more aggressive.
- This is a preferred depth, not an absolute cap. Pressure sweeps may go deeper when summarized context remains too large.

### `summaryPrefixTargetTokens`

Optional target for summarized-prefix tokens after a full sweep.

Why it matters:

- Gives Lossless an escape hatch when too many summaries at the preferred depth still leave the prompt near full.
- When unset, Lossless derives a target from `contextThreshold`, the active token budget, and `leafChunkTokens`.
- Sweeps first exhaust eligible raw-message leaf chunks, then honor `sweepMaxDepth`; pressure condensation can go deeper only when summary-prefix pressure remains.

### `maxSweepIterations`

Hard cap on summarizer passes within a single full sweep. Default `12`.

Why it matters:

- A large conversation can otherwise drive an unbounded number of leaf/condensed passes in one sweep.
- On hitting the cap the sweep stops cleanly and returns the partial result; the next sweep resumes the remaining work.
- Bounds how long a sweep can run on the turn-critical path (the `assemble()` deferred-debt drain).

### `sweepDeadlineMs`

Wall-clock budget for a single full sweep, in milliseconds. Default `120000`.

Why it matters:

- A slow or rate-limited summarizer can burn a full `summaryTimeoutMs` per pass; without a deadline, many passes compound into tens of minutes.
- When the deadline is exceeded the sweep stops before starting another pass and returns the partial result.
- Pairs with `maxSweepIterations`: whichever limit is reached first stops the sweep.

### `compactUntilUnderDeadlineMs`

Wall-clock budget for a whole `compactUntilUnder` (overflow recovery) operation, in milliseconds. Default `300000`.

Why it matters:

- `compactUntilUnder` runs up to `maxRounds` sweeps, and each sweep re-arms its own `sweepDeadlineMs`; without an operation-wide budget the worst case is `maxRounds × sweepDeadlineMs` (~20 minutes at the defaults).
- The deadline is shared into each round's sweep — a sweep stops at whichever deadline is sooner — and is also checked before starting the next round.
- On hitting it, `compactUntilUnder` returns the consistent partial result; the default leaves room for a few full-deadline sweeps while capping the worst case well below 20 minutes.

### `incrementalMaxDepth`

Deprecated alias for `sweepMaxDepth`.

Why it matters:

- Existing OpenClaw configs continue to load.
- New config should use `sweepMaxDepth`.
- If both aliases are set in the same source, `sweepMaxDepth` wins.

### `summaryModel` and `summaryProvider`

Override the model used for compaction summarization.

Why they matter:

- Summary quality compounds upward in the DAG.
- Cheaper models can reduce cost, but weak summaries create weak recalled context later.

Guidance:

- Pick a cheaper model only if it remains reliably structured and faithful.
- `summaryProvider` only matters when `summaryModel` is a bare model name rather than a canonical provider/model ref.
- Summary calls go through OpenClaw's `api.runtime.llm.complete`; Lossless does not resolve provider credentials directly.
- Explicit summary model overrides require `plugins.entries.lossless-claw.llm.allowModelOverride` plus matching `allowedModels` entries, or `openclaw doctor --fix` to add them.

### `expansionModel` and `expansionProvider`

Override the model used by delegated recall flows such as `lcm_expand_query`.

Why they matter:

- This lets recall-heavy work use a different cost/latency profile than normal compaction.
- These are recall-path settings, not compaction-path settings.

## Complete config surface

## Core enablement and storage

### `enabled`

Boolean on/off switch for the plugin entry.

Use this when:

- you need the plugin installed but temporarily disabled
- you want to distinguish “installed” from “selected and active”

### `dbPath`

Overrides the SQLite DB location.

Why it matters:

- useful for custom deployments, testing, or isolating environments
- wrong path selection is a common reason operators think LCM is empty or not growing
- the default resolves to `${OPENCLAW_STATE_DIR}/lcm.db` (falls back to `~/.openclaw/lcm.db`)

### `databasePath`

Preferred alias of `dbPath`.

Why it matters:

- this is the documented key new config should use
- `dbPath` is still accepted for compatibility

### `largeFilesDir`

Directory for persisting large-file text payloads externalised from the transcript.

Why it matters:

- defaults to `${OPENCLAW_STATE_DIR}/lcm-files`; on multi-profile hosts each profile stores files in its own state directory automatically
- override with `LCM_LARGE_FILES_DIR` or set `largeFilesDir` in plugin config when you want an explicit path
### `largeFileThresholdTokens`

Threshold for externalizing oversized tool/file payloads out of the main transcript into large-file storage.

Why it matters:

- lower values externalize more aggressively
- higher values keep more payload inline but can bloat storage and compaction inputs

### `transcriptGcEnabled`

Controls whether `maintain()` rewrites transcript entries for already-externalized tool results.

Why it matters:

- keep this off unless you want transcript GC to mutate the live session file during maintenance
- the default is `false`

### `enableSummaryThinking`

Controls whether the summarization model receives a low reasoning budget.

Why it matters:

- when `true` (default), summarization calls request `reasoningIfSupported: "low"`, allowing the model to think before producing summaries — this is the current default behavior
- when `false`, no explicit reasoning budget is requested, which can reduce cost and keep summarization output more concise when reasoning is not needed for faithful summaries
- set to `false` when you want to minimize token spend on reasoning during compaction, especially with reasoning-capable models

Env override:

- `LCM_ENABLE_SUMMARY_THINKING`

### `proactiveThresholdCompactionMode`

Controls whether proactive threshold compaction is deferred into maintenance debt or kept inline for legacy behavior.

Why it matters:

- `deferred` is the default and avoids foreground turn stalls by recording one coalesced maintenance row per conversation
- `deferred` also stores provider/model/cache telemetry so Anthropic-family sessions can avoid rewriting a still-hot prompt cache
- `inline` preserves the legacy foreground compaction path for hosts that do not yet support deferred execution
- `/lossless status` and `/lcm status` surface pending/running/last-failure maintenance state so operators can see when compaction is queued
- after-turn background drain and host-approved `maintain()` consume routine threshold debt; `assemble()` only drains pending threshold debt synchronously as an emergency safeguard when the live prompt estimate is already over budget

### `autoRotateSessionFiles`

Automatically rotates oversized LCM-managed session JSONL files.

Defaults:

- `enabled: true`
- `createBackups: false`
- `sizeBytes: 2097152`
- `startup: "rotate"`
- `runtime: "rotate"`

Why it matters:

- prevents very large OpenClaw session JSONL files from choking fallback/gateway startup while LCM owns the durable context
- runtime rotation only creates or replaces the rolling `rotate-latest` DB backup when `createBackups` is `true`; manual `/lossless rotate` / `/lcm rotate` always keeps its backup-backed behavior
- runtime JSONL rewrites run from `afterTurn()` after the host turn completes; `maintain()` skips rotation and leaves it to `afterTurn()` or startup because background maintenance can overlap an embedded model call
- startup scans OpenClaw's current indexed session stores for configured agents, intersects those candidates with active LCM bootstrap state, and creates one pre-rotation DB backup for the startup batch only when `createBackups` is `true`
- only runs for active, writable LCM conversations; ignored sessions, stateless sessions, sessions outside the indexed startup candidate set, and sessions without active LCM state are skipped
- the preserved transcript tail follows the normal rotate behavior controlled by `freshTailCount`

Operational logging:

- every decision is logged with the prefix `[lcm] auto-rotate:`
- startup emits one compact `action=summary` line with `scanned`, `eligible`, `rotated`, `warned`, `skipped`, `durationMs`, and `bytesRemoved`
- rotate logs include `phase`, `action`, `sessionId`, `sessionKey`, `sessionFile`, `sizeBytes`, `thresholdBytes`, `durationMs`, `backupPath`, `bytesRemoved`, `preservedTailMessageCount`, and `checkpointSize`
- real warning logs include the same available context plus `reason` or `error`; quiet startup skips such as missing files, missing bootstrap mappings, and below-threshold files are counted in the summary instead of logged per candidate

### `independentLogFile`

Writes lossless-claw JSONL logs to an independent plugin-owned file in addition to OpenClaw's runtime logger.

Defaults:

- `enabled: true`
- `file: /tmp/openclaw/lossless-claw-YYYY-MM-DD.log`
- `maxFileBytes: 104857600`

Why it matters:

- keeps high-volume `[lcm]` operational traces separate from the shared OpenClaw gateway log
- still sends startup banners and warning/error lines through OpenClaw's runtime logger, so gateway-level startup and failure diagnostics remain visible
- a dated `lossless-claw-YYYY-MM-DD.log` path rolls over daily, stale dated files are pruned after 3 days, and oversized files rotate through `.1.log` to `.5.log`

Env overrides:

- `LCM_LOG_FILE_ENABLED`
- `LCM_LOG_FILE`
- `LCM_LOG_MAX_FILE_BYTES`

## Compaction timing and shape

### `contextThreshold`

See high-impact settings above.

### `freshTailCount`

See high-impact settings above.

### `freshTailMaxTokens`

See high-impact settings above.

### `promptAwareEviction`

Boolean toggle for prompt-sensitive selection inside the evictable prefix during assembly.

Why it matters:

- only applies when the older evictable prefix does not fit the token budget
- the protected fresh tail is unaffected
- `true` keeps the most relevant older items for the current prompt
- `false` falls back to pure chronological retention for the older prefix

Env override:

- `LCM_PROMPT_AWARE_EVICTION_ENABLED`

### `stubLargeToolPayloads`

Boolean toggle for assemble-time stub substitution of migrated tool-result payloads outside the protected fresh tail.

Why it matters:

- only affects rows whose `messages.large_content` sidecar points at a `file_xxx` record
- the fresh tail is still emitted verbatim
- drilldown uses `lcm_describe(id=file_xxx, expandFile=true)`
- `scripts/lcm-blob-migrate.mjs` defaults to the same storage root as runtime LCM: `LCM_LARGE_FILES_DIR` or `${OPENCLAW_STATE_DIR}/lcm-files`

Env override:

- `LCM_STUB_LARGE_TOOL_PAYLOADS`

### `leafChunkTokens`

See high-impact settings above.

### `leafMinFanout`

Minimum number of leaf items required before creating a leaf compaction grouping.

Why it matters:

- higher values avoid tiny leaf summaries
- lower values compact sooner but can create overly granular summaries

### `condensedMinFanout`

Preferred minimum fanout for condensed summaries during normal condensation.

Why it matters:

- controls how eagerly summaries get grouped upward
- affects DAG breadth and readability of higher-level summaries

### `condensedMinFanoutHard`

Hard lower bound for condensed fanout decisions.

Why it matters:

- acts as the guardrail when normal fanout preferences cannot be met cleanly
- mostly useful for advanced tuning or pathological summary-tree shapes

### `sweepMaxDepth`

See high-impact settings above.

Env override:

- `LCM_SWEEP_MAX_DEPTH`

### `summaryPrefixTargetTokens`

See high-impact settings above.

Env override:

- `LCM_SUMMARY_PREFIX_TARGET_TOKENS`

### `maxSweepIterations`

See high-impact settings above.

Env override:

- `LCM_MAX_SWEEP_ITERATIONS`

### `sweepDeadlineMs`

See high-impact settings above.

Env override:

- `LCM_SWEEP_DEADLINE_MS`

### `compactUntilUnderDeadlineMs`

See high-impact settings above.

Env override:

- `LCM_COMPACT_UNTIL_UNDER_DEADLINE_MS`

### `incrementalMaxDepth`

Deprecated alias for `sweepMaxDepth`.

Env override:

- `LCM_INCREMENTAL_MAX_DEPTH`

### `bootstrapMaxTokens`

Maximum raw parent-history tokens imported when a brand-new LCM conversation bootstraps.

Why it matters:

- keeps first-time bootstrap from flooding the conversation with too much old transcript material
- defaults to `max(6000, floor(leafChunkTokens * 0.3))`
- only affects the first import path, not ordinary steady-state turns

## Session-selection controls

### `ignoreSessionPatterns`

Glob-style session-key patterns that should never enter LCM.

Why it matters:

- keeps low-value automation or noisy sessions out of the DB
- useful for excluding certain agent lanes or ephemeral traffic entirely
- cron scheduler keys are already isolated per runtime run, so ignore them only when they should bypass LCM compaction

### `statelessSessionPatterns`

Patterns for sessions that may read from LCM but should not write to it.

Why it matters:

- useful for sub-agents and ephemeral workers
- prevents recall helpers from polluting the main history

### `skipStatelessSessions`

Boolean that changes how stateless matches are treated.

Why it matters:

- when enabled, matching stateless sessions skip LCM persistence entirely
- use carefully, because it affects whether those sessions behave as readers only or are effectively bypassed for writes

## Recall-path and delegation controls

### `expansionModel`

See high-impact settings above.

### `expansionProvider`

See high-impact settings above.

### `delegationTimeoutMs`

Maximum time to wait for delegated recall completion.

Why it matters:

- lower values fail faster under slow sub-agent paths
- higher values tolerate deeper recall but can make calls feel stuck longer

### `maxAssemblyTokenBudget`

Hard ceiling for assembled LCM token budget.

Why it matters:

- useful when the runtime model window is smaller than the surrounding system assumes
- can prevent oversized assembly on smaller-context models

## Anti-replay flood guard

The ingest path runs `assertNoReplayTimestampFlood` to refuse batches that look like webhook-style replay attacks (many replay-like user messages or many identical internal messages at the same `created_at`). Because SQLite `datetime('now')` is second-granularity, legitimate idempotent bursts from sub-agents can also trip the guard if it is single-threshold. The role-aware thresholds below split the budget by message origin.

### `replayFloodThresholdExternal`

Max replay-like messages allowed in a single SQLite-second for `role=user` before the guard refuses the batch. Defaults to `3`.

Why it matters:

- preserves replay defense for third-partyly-rebroadcastable input
- lower values are stricter but risk rejecting legitimate dedup retries from upstream channels

### `replayFloodThresholdInternal`

Max identical messages allowed in a single SQLite-second for `role=tool/assistant/system` before the guard refuses the batch. Defaults to `32`.

Why it matters:

- absorbs legitimate same-second idempotent tool returns (for example, sub-agents emitting many `{"status":"ok"}` results)
- still bounded so a pathological loop cannot ingest unboundedly under the same timestamp
- raise it if you operate cron sub-agents that emit very tight bursts; lower it if you want stricter sanity protection

## Nested objects

### `cacheAwareCompaction`

#### `cacheAwareCompaction.enabled`

Deprecated compatibility setting. It remains accepted by config loading but no longer changes automatic compaction behavior.

#### `cacheAwareCompaction.cacheTTLSeconds`

Deprecated compatibility setting. Threshold debt no longer waits for a prompt-cache TTL.

Why it matters:

- existing configs continue to load
- prompt-cache telemetry remains diagnostic only

Default:

- `300`

#### `cacheAwareCompaction.maxColdCacheCatchupPasses`

Deprecated compatibility setting. Automatic cold-cache catch-up passes were removed.

#### `cacheAwareCompaction.hotCachePressureFactor`

Deprecated compatibility setting. Hot-cache raw-history pressure no longer drives automatic compaction.

Why it matters:

- use `contextThreshold`, `leafChunkTokens`, and fanout for active compaction tuning

Default:

- `4`

#### `cacheAwareCompaction.hotCacheBudgetHeadroomRatio`

Deprecated compatibility setting. Hot-cache budget headroom no longer defers automatic threshold compaction.

Why it matters:

- threshold debt runs when the context threshold is crossed

Default:

- `0.2`

#### `cacheAwareCompaction.coldCacheObservationThreshold`

Deprecated compatibility setting. Cold-cache streaks may still be observable telemetry, but they no longer trigger catch-up compaction.

Why it matters:

- cache state is not reliable enough to drive prompt-mutating compaction

Default:

- `3`

#### `cacheAwareCompaction.criticalBudgetPressureRatio`

Deprecated compatibility setting. `contextThreshold` is now the only automatic compaction threshold.

Why it matters:

- the hot-cache delay gate has been removed
- overflow recovery still uses explicit budget-targeted compaction

Default:

- `0.90`

Env override:

- `LCM_CRITICAL_BUDGET_PRESSURE_RATIO`

### `dynamicLeafChunkTokens`

#### `dynamicLeafChunkTokens.enabled`

Deprecated compatibility setting. Automatic compaction uses `leafChunkTokens` directly.

Default:

- `true`

#### `dynamicLeafChunkTokens.max`

Deprecated compatibility setting. The resolved value is still accepted and visible, but no longer changes automatic compaction.

Default:

- `max(leafChunkTokens, floor(leafChunkTokens * 2))`

## Summary quality and prompt controls

### `summaryMaxOverageFactor`

Maximum allowed overage factor before an oversized summary is truncated/downgraded.

Why it matters:

- guards against runaway summaries that are much larger than their target budget
- useful when summary models are verbose or unstable

### `summaryMaxCallsPerWindow`, `summaryCallWindowMs`, and `summarySpendBackoffMs`

Bounds model-backed compaction and large-file summarization calls per session.

Defaults:

- `summaryMaxCallsPerWindow`: `24`
- `summaryCallWindowMs`: `600000`
- `summarySpendBackoffMs`: `1800000`

Env overrides:

- `LCM_SUMMARY_MAX_CALLS_PER_WINDOW`
- `LCM_SUMMARY_CALL_WINDOW_MS`
- `LCM_SUMMARY_SPEND_BACKOFF_MS`

Why they matter:

- prevents non-auth provider failures, ineffective compaction, or repeated deferred debt from spending unbounded summarization calls
- keeps provider-auth failures on the separate auth circuit breaker path
- direct deterministic fallbacks remain available when model-backed large-file summaries are throttled

### `customInstructions`

Natural-language instructions injected into summarization prompts.

Why it matters:

- lets operators steer formatting or emphasis without patching code
- should be used sparingly; low-quality instructions can degrade summary quality system-wide

### `stripInjectedContextTags`

| | |
| --- | --- |
| Type | `string[]` |
| Default | `["active_memory_plugin", "relevant-memories", "relevant_memories", "hindsight_memories"]` |
| Env | `LCM_STRIP_INJECTED_CONTEXT_TAGS` (comma-separated) |

XML tag names whose blocks are stripped from message content before compaction summarization.

Why it matters:

- Memory and context plugins (active-memory, memory-lancedb, hindsight-openclaw) prepend XML-tagged blocks to user messages via the `prependContext` hook.  These blocks are ephemeral retrieval context — they helped the model on that specific turn but are not part of the actual conversation.
- Without stripping, the summarizer treats injected memories as real conversation content, permanently corrupting compacted summaries with auto-retrieved context that the user never said.
- The default list covers well-known OpenClaw memory plugin tags.  Add custom tag names if you use plugins that inject context via other tags.
- Set to `[]` (or empty env string) to disable stripping.

Design note: stripping happens at compaction time, not at message ingestion.  The raw message stored in the LCM database still contains the original injected blocks, so `lcm_expand` and `lcm_grep` can still surface the full context the model saw on any given turn.  Only the summarizer input is cleaned.

## Practical operator workflow

1. Install and enable the plugin.
2. Set the context-engine slot to `lossless-claw`.
3. Start with conservative defaults.
4. Run `/lossless` after startup to confirm path, size, and summary health.
5. If threshold sweeps happen too often, tune `contextThreshold`, `leafChunkTokens`, `summaryPrefixTargetTokens`, and fanout before adding new mechanisms.
6. If threshold sweeps happen too often, try a larger `leafChunkTokens` value such as 30000 before adding new mechanisms.
7. If recall feels weak, revisit `freshTailCount`, `leafChunkTokens`, and summarizer model quality before changing anything else.
8. Touch advanced knobs like fanout, large-file thresholds, custom instructions, and assembly caps only after a concrete symptom appears.

## Reading the status output

`/lossless` is the right command for LCM-local metrics.

Useful interpretation notes:

- `tokens in context` is the current LCM frontier token count in the live LCM state.
- `compression ratio` is shown as a rounded `1:N`, which is easier to read than a tiny percentage for heavily compacted conversations.
- `/status` may still show a different context number because it reflects the runtime prompt that was actually assembled and sent on the last turn.

## Keep this reference aligned

This file should stay consistent with:

- [`docs/configuration.md`](../../../docs/configuration.md)
- [`openclaw.plugin.json`](../../../openclaw.plugin.json)
- [`src/db/config.ts`](../../../src/db/config.ts)

When config keys, aliases, defaults, or precedence rules change, update all of them together.
