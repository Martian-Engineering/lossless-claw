# Configuration

This reference covers the current `lossless-claw` config surface on `main`, based on `openclaw.plugin.json`.

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

### `leafChunkTokens`

Caps how much raw material gets summarized into one leaf summary.

Why it matters:

- Larger chunks reduce summarization frequency.
- Smaller chunks create more summaries and more DAG fragmentation.

Use this when:

- Your summarizer is rate-limited or expensive.
- You want fewer but broader leaf summaries.

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

### `leafSkipReductionThreshold`

Controls the cache-aware compaction skip. Minimum per-pass reduction as a fraction of total assembled tokens to justify leaf compaction. Default `0.05` (5%).

- Lower (0.02): more aggressive compaction — good for Opus/expensive models
- Higher (0.10): more conservative — good for short sessions/cheap models
- Set to `0` to disable the cache-aware skip

### `leafBudgetHeadroomFactor`

Controls the budget headroom compaction skip. Skip leaf compaction when assembled tokens are below `factor x contextThreshold x tokenBudget`. Default `0.8`.

- Lower (0.45): start compacting earlier — important for expensive models
- Higher (0.90): delay compaction — acceptable for cheap models
- Set to `0` to disable headroom check (also disables budget pressure detection)

When assembled tokens reach or exceed the headroom ceiling, budget pressure overrides cache-aware skip — compaction fires unconditionally.

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

### `largeFileThresholdTokens`

Threshold for externalizing oversized tool/file payloads out of the main transcript into large-file storage.

Why it matters:

- lower values externalize more aggressively
- higher values keep more payload inline but can bloat storage and compaction inputs

## Compaction timing and shape

### `contextThreshold`

See high-impact settings above.

### `freshTailCount`

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
5. If recall feels weak, revisit `freshTailCount`, `leafChunkTokens`, and summarizer model quality before changing anything else.
6. Touch advanced knobs like fanout, large-file thresholds, custom instructions, and assembly caps only after a concrete symptom appears.

## Reading the status output

`/lossless` is the right command for LCM-local metrics.

Useful interpretation notes:

- `tokens in context` is the current LCM frontier token count in the live LCM state.
- `compression ratio` is shown as a rounded `1:N`, which is easier to read than a tiny percentage for heavily compacted conversations.
- `/status` may still show a different context number because it reflects the runtime prompt that was actually assembled and sent on the last turn.
