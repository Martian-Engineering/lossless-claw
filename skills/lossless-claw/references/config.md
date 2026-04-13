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

### `leafChunkTokens`

Caps how much raw material gets summarized into one leaf summary.

Why it matters:

- Larger chunks reduce summarization frequency.
- Smaller chunks create more summaries and more DAG fragmentation.

Use this when:

- Your summarizer is rate-limited or expensive.
- You want fewer but broader leaf summaries.

### `cacheAwareCompaction`

Controls how strongly lossless-claw preserves a healthy prompt cache during incremental maintenance.

Why it matters:

- Hot cache now prefers to keep the cache intact instead of eagerly compacting old raw history.
- Cold cache still allows bounded catch-up passes so stale sessions can converge.
- The new defaults are intentionally more aggressive about preserving cache than earlier builds.

Good defaults:

- `enabled: true`
- `maxColdCacheCatchupPasses: 2`
- `hotCachePressureFactor: 4`
- `hotCacheBudgetHeadroomRatio: 0.2`

Operationally:

- hot cache stretches the incremental leaf trigger to `dynamicLeafChunkTokens.max`
- hot cache skips incremental maintenance entirely when the assembled context is comfortably below the real token budget
- hot cache gets a short hysteresis window so a recent cache hit stays "hot" briefly unless telemetry shows a break
- if hot-cache maintenance still runs, it stays leaf-only and suppresses follow-on condensed passes

### `dynamicLeafChunkTokens`

Controls the working leaf-trigger size used by incremental compaction.

Why it matters:

- dynamic sizing is now enabled by default
- busier sessions can use a larger working chunk without changing the static floor
- hot cache uses the dynamic max as the working leaf trigger

Good defaults:

- `enabled: true`
- `max: 2 * leafChunkTokens`

With the default `leafChunkTokens=20000`, that means:

- `dynamicLeafChunkTokens.max = 40000`

### `incrementalMaxDepth`

Controls how far automatic condensation cascades after leaf compaction.

Why it matters:

- `0` keeps only leaf summaries moving automatically.
- `1` is a practical default for long-running sessions.
- `-1` allows unlimited cascading, which can be useful for very long histories but is more aggressive.

### `summaryModel` and `summaryProvider`

Override the model used for compaction summarization.

Why they matter:

- Summary quality compounds upward in the DAG.
- Cheaper models can reduce cost, but weak summaries create weak recalled context later.

Guidance:

- Pick a cheaper model only if it remains reliably structured and faithful.
- `summaryProvider` only matters when `summaryModel` is a bare model name rather than a canonical provider/model ref.

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

### `proactiveThresholdCompactionMode`

Controls whether proactive threshold compaction is deferred into maintenance debt or kept inline for legacy behavior.

Why it matters:

- `deferred` is the default and avoids foreground turn stalls by recording one coalesced maintenance row per conversation
- `deferred` also stores provider/model/cache telemetry so Anthropic-family sessions can avoid rewriting a still-hot prompt cache
- `inline` preserves the legacy foreground compaction path for hosts that do not yet support deferred execution
- `/lossless status` and `/lcm status` surface pending/running/last-failure maintenance state so operators can see when compaction is queued
- background `maintain()` can still do non-prompt-mutating work, but prompt-mutating debt is consumed pre-assembly once cache is cold or the next turn is already approaching overflow

## Compaction timing and shape

### `contextThreshold`

See high-impact settings above.

### `freshTailCount`

See high-impact settings above.

### `freshTailMaxTokens`

See high-impact settings above.

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

### `incrementalMaxDepth`

See high-impact settings above.

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

## Nested objects

### `cacheAwareCompaction`

#### `cacheAwareCompaction.enabled`

Defers incremental leaf compaction more aggressively when prompt-cache telemetry indicates a hot cache.

#### `cacheAwareCompaction.cacheTTLSeconds`

Fallback cache TTL used when deferred Anthropic compaction has provider/model telemetry but no explicit runtime cache-retention window.

Why it matters:

- lets cache-safe deferred compaction stay conservative even when the host only knows that the turn was Anthropic-family, not the exact retention tier
- keeps prompt-mutating debt pending until the cached prefix is likely cold

Default:

- `300`

#### `cacheAwareCompaction.maxColdCacheCatchupPasses`

Maximum bounded catch-up passes allowed in one maintenance cycle when cache telemetry is cold.

#### `cacheAwareCompaction.hotCachePressureFactor`

Multiplier applied to the hot-cache leaf trigger before raw-history pressure overrides cache preservation.

Why it matters:

- higher values preserve hot cache longer
- lower values revert toward more eager incremental compaction

Default:

- `4`

#### `cacheAwareCompaction.hotCacheBudgetHeadroomRatio`

Minimum fraction of the real token budget that must remain free before hot-cache incremental compaction is skipped entirely.

Why it matters:

- higher values make hot-cache skip behavior stricter
- lower values allow more hot-cache maintenance before real budget pressure exists

Default:

- `0.2`

### `dynamicLeafChunkTokens`

#### `dynamicLeafChunkTokens.enabled`

Enables dynamic working leaf chunk sizes for busier sessions.

Default:

- `true`

#### `dynamicLeafChunkTokens.max`

Upper bound for the dynamic working chunk size. The static `leafChunkTokens` value remains the floor.

Default:

- `max(leafChunkTokens, floor(leafChunkTokens * 2))`

## Summary quality and prompt controls

### `summaryMaxOverageFactor`

Maximum allowed overage factor before an oversized summary is truncated/downgraded.

Why it matters:

- guards against runaway summaries that are much larger than their target budget
- useful when summary models are verbose or unstable

### `customInstructions`

Natural-language instructions injected into summarization prompts.

Why it matters:

- lets operators steer formatting or emphasis without patching code
- should be used sparingly; low-quality instructions can degrade summary quality system-wide

## Practical operator workflow

1. Install and enable the plugin.
2. Set the context-engine slot to `lossless-claw`.
3. Start with conservative defaults.
4. Run `/lossless` after startup to confirm path, size, and summary health.
5. If hot-cache turns still compact too often, inspect the decision logs before changing anything else:
   - `reason=hot-cache-budget-headroom` means the new skip path is working.
   - `reason=hot-cache-defer` means raw-history pressure is below the configured hot-cache factor.
   - `allowCondensedPasses=false` on hot-cache turns is expected.
6. If recall feels weak, revisit `freshTailCount`, `leafChunkTokens`, and summarizer model quality before changing anything else.
7. Touch advanced knobs like fanout, large-file thresholds, custom instructions, and assembly caps only after a concrete symptom appears.

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
