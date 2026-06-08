# Configuration

Lossless-claw reads plugin configuration from `plugins.entries.lossless-claw.config`.

Lossless-claw requires OpenClaw `2026.5.22` or newer so the host can enforce
context-engine runtime capabilities before an agent run starts. Agent runs need
a native host that provides the full context-engine lifecycle: session bootstrap,
pre-prompt assembly, after-turn ingestion, maintenance, compaction, and runtime
LLM completion. Native Codex and Pi embedded runs provide those capabilities;
generic CLI harnesses such as `claude-cli` and `codex-cli` do not. If you must
use a generic CLI harness, set `plugins.slots.contextEngine` to `legacy` for
that run instead of `lossless-claw`.

Configuration precedence is:

1. Environment variables
2. `plugins.entries.lossless-claw.config`
3. Built-in defaults from [`src/db/config.ts`](../src/db/config.ts)

Most installations only need to override a handful of keys. If you want a complete starting point, use the full example below and then delete entries you do not need.

## Complete `plugins.entries.lossless-claw.config` example

```json
{
  "enabled": true,
  "databasePath": "/Users/alice/.openclaw/lcm.db",
  "largeFilesDir": "/Users/alice/.openclaw/lcm-files",
  "ignoreSessionPatterns": [],
  "statelessSessionPatterns": [],
  "skipStatelessSessions": true,
  "contextThreshold": 0.75,
  "contextThresholdOverrides": [
    {
      "name": "large-context-models",
      "match": { "modelContextWindowMin": 900000 },
      "contextThreshold": 0.15
    },
    {
      "name": "small-context-models",
      "match": { "modelContextWindowMax": 250000 },
      "contextThreshold": 0.2
    },
    {
      "name": "telegram-sessions",
      "match": { "sessionPattern": "agent:*:telegram:**" },
      "contextThreshold": 0.3
    }
  ],
  "freshTailCount": 64,
  "freshTailMaxTokens": 24000,
  "promptAwareEviction": false,
  "stubLargeToolPayloads": false,
  "newSessionRetainDepth": 2,
  "leafMinFanout": 8,
  "condensedMinFanout": 4,
  "condensedMinFanoutHard": 2,
  "sweepMaxDepth": 1,
  "incrementalMaxDepth": 1,
  "leafChunkTokens": 20000,
  "summaryPrefixTargetTokens": 20000,
  "maxSweepIterations": 12,
  "sweepDeadlineMs": 120000,
  "compactUntilUnderDeadlineMs": 300000,
  "bootstrapMaxTokens": 6000,
  "leafTargetTokens": 2400,
  "condensedTargetTokens": 2000,
  "maxExpandTokens": 4000,
  "largeFileThresholdTokens": 25000,
  "summaryProvider": "",
  "summaryModel": "",
  "largeFileSummaryProvider": "",
  "largeFileSummaryModel": "",
  "expansionProvider": "",
  "expansionModel": "",
  "delegationTimeoutMs": 120000,
  "summaryTimeoutMs": 60000,
  "summaryCallWindowMs": 600000,
  "summaryMaxCallsPerWindow": 24,
  "summarySpendBackoffMs": 1800000,
  "timezone": "America/Los_Angeles",
  "pruneHeartbeatOk": false,
  "transcriptGcEnabled": false,
  "enableSummaryThinking": true,
  "maxAssemblyTokenBudget": 30000,
  "summaryMaxOverageFactor": 3,
  "customInstructions": "",
  "circuitBreakerThreshold": 5,
  "circuitBreakerCooldownMs": 1800000,
  "replayFloodThresholdExternal": 3,
  "replayFloodThresholdInternal": 32,
  "fallbackProviders": [],
  "proactiveThresholdCompactionMode": "deferred",
  "autoRotateSessionFiles": {
    "enabled": true,
    "createBackups": false,
    "sizeBytes": 2097152,
    "startup": "rotate",
    "runtime": "rotate"
  },
  "independentLogFile": {
    "enabled": true,
    "file": "/tmp/openclaw/lossless-claw-2026-05-19.log",
    "maxFileBytes": 104857600
  },
  "cacheAwareCompaction": {
    "enabled": true,
    "cacheTTLSeconds": 300,
    "maxColdCacheCatchupPasses": 2,
    "hotCachePressureFactor": 4,
    "hotCacheBudgetHeadroomRatio": 0.2,
    "coldCacheObservationThreshold": 3,
    "criticalBudgetPressureRatio": 0.90
  },
  "dynamicLeafChunkTokens": {
    "enabled": true,
    "max": 40000
  },
  "stripInjectedContextTags": [
    "active_memory_plugin",
    "relevant-memories",
    "relevant_memories",
    "hindsight_memories"
  ]
}
```

Notes on the example:

- Values shown are the runtime defaults when a fixed default exists.
- `databasePath` shows the expanded default path shape. Use an absolute path in config rather than `~`.
- `largeFilesDir` shows the expanded default path shape. Both `databasePath` and `largeFilesDir` default to paths under `OPENCLAW_STATE_DIR` (which in turn falls back to `~/.openclaw`).
- `timezone` has no fixed hardcoded default; at runtime it resolves from `TZ` first, then the system timezone. The example uses `America/Los_Angeles`.
- `maxAssemblyTokenBudget` has no default. The example uses `30000` as a realistic cap for a 32k-class model.
- `summaryPrefixTargetTokens` has no fixed default. The example uses `20000`, which matches the derived default for large-context models with the default `leafChunkTokens`.
- `databasePath` is the preferred key. `dbPath` is an accepted alias.
- `largeFileThresholdTokens` is the preferred key. `largeFileTokenThreshold` is an accepted alias.

## Install and enable

Install with OpenClaw's plugin installer:

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

If you are running from a local OpenClaw checkout:

```bash
pnpm openclaw plugins install @martian-engineering/lossless-claw
```

For local plugin development, link a working copy:

```bash
openclaw plugins install --link /path/to/lossless-claw
```

## Reference

### Core storage and session behavior

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | `LCM_ENABLED` | Enables or disables lossless-claw without uninstalling it. |
| `databasePath` | `string` | `${OPENCLAW_STATE_DIR}/lcm.db` | `LCM_DATABASE_PATH` | Preferred path for the SQLite database. |
| `dbPath` | `string` | alias of `databasePath` | `LCM_DATABASE_PATH` | Legacy alias for `databasePath`. Prefer `databasePath` in new config. |
| `largeFilesDir` | `string` | `${OPENCLAW_STATE_DIR}/lcm-files` | `LCM_LARGE_FILES_DIR` | Directory where externalized large files and inline images are persisted. Automatically follows the active state directory. |
| `ignoreSessionPatterns` | `string[]` | `[]` | `LCM_IGNORE_SESSION_PATTERNS` | Session-key glob patterns that skip LCM entirely. |
| `statelessSessionPatterns` | `string[]` | `[]` | `LCM_STATELESS_SESSION_PATTERNS` | Session-key glob patterns that may read from LCM but never write to it. |
| `skipStatelessSessions` | `boolean` | `true` | `LCM_SKIP_STATELESS_SESSIONS` | Enforces `statelessSessionPatterns` when enabled. |
| `newSessionRetainDepth` | `integer` | `2` | `LCM_NEW_SESSION_RETAIN_DEPTH` | Controls what survives `/new`. `-1` keeps all context, `0` keeps summaries only, higher values keep only deeper summaries. |
| `timezone` | `string` | `TZ` or system timezone | `TZ` | IANA timezone used for timestamp rendering in summaries. |
| `pruneHeartbeatOk` | `boolean` | `false` | `LCM_PRUNE_HEARTBEAT_OK` | Retroactively removes `HEARTBEAT_OK` turn cycles from persisted storage. |
| `transcriptGcEnabled` | `boolean` | `false` | `LCM_TRANSCRIPT_GC_ENABLED` | Enables transcript rewrite GC during `maintain()`; disabled by default so transcript rewrites stay opt-in. |
| `enableSummaryThinking` | `boolean` | `true` | `LCM_ENABLE_SUMMARY_THINKING` | When true, requests low reasoning budget from the model during summarization calls. Set to false to disable reasoning and keep summarization output concise. |
| `proactiveThresholdCompactionMode` | `"deferred" \| "inline"` | `"deferred"` | `LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE` | Controls whether proactive threshold compaction is deferred into maintenance debt by default or run inline for legacy behavior. |
| `autoRotateSessionFiles.enabled` | `boolean` | `true` | `LCM_AUTO_ROTATE_SESSION_FILES_ENABLED` | Enables automatic rotation for oversized LCM-managed session JSONL files. |
| `autoRotateSessionFiles.createBackups` | `boolean` | `false` | `LCM_AUTO_ROTATE_SESSION_FILES_CREATE_BACKUPS` | Creates or replaces the rolling `rotate-latest` SQLite backup before automatic session-file rotation. Manual `/lcm rotate` backups are always created. |
| `autoRotateSessionFiles.sizeBytes` | `integer` | `2097152` | `LCM_AUTO_ROTATE_SESSION_FILES_SIZE_BYTES` | Byte threshold that triggers automatic session-file rotation. |
| `autoRotateSessionFiles.startup` | `"rotate" \| "warn" \| "off"` | `"rotate"` | `LCM_AUTO_ROTATE_SESSION_FILES_STARTUP` | Startup behavior for oversized indexed OpenClaw session transcripts that also have active LCM bootstrap state. |
| `autoRotateSessionFiles.runtime` | `"rotate" \| "warn" \| "off"` | `"rotate"` | `LCM_AUTO_ROTATE_SESSION_FILES_RUNTIME` | Runtime behavior after post-turn checks. Runtime `rotate` logs deferral for active session JSONL rewrites and leaves direct rotation to startup or manual `/lcm rotate`. |
| `independentLogFile.enabled` | `boolean` | `true` | `LCM_LOG_FILE_ENABLED` | Writes lossless-claw JSONL logs to an independent plugin-owned file in addition to OpenClaw's runtime logger. |
| `independentLogFile.file` | `string` | `/tmp/openclaw/lossless-claw-YYYY-MM-DD.log` | `LCM_LOG_FILE` | Optional log path. A dated `lossless-claw-YYYY-MM-DD.log` path rolls over daily. |
| `independentLogFile.maxFileBytes` | `integer` | `104857600` | `LCM_LOG_MAX_FILE_BYTES` | Size threshold for rotating the active lossless-claw log file to `.1.log` through `.5.log`. |

> **Multi-profile note:** `OPENCLAW_STATE_DIR` (set by the host OpenClaw gateway) controls where state is stored. When two gateways run on the same host (e.g. separate bot personas), each gateway sets its own `OPENCLAW_STATE_DIR` and lossless-claw automatically uses that directory for the database, large-file payloads, auth-profile lookups, and legacy secrets — no per-profile plugin config is needed.

Automatic session-file rotation rewrites only the live session transcript, keeps the active LCM conversation and durable history intact, and refreshes the bootstrap checkpoint. Before manual or startup rewrites, rotation forces leaf-only compaction for raw context outside the preserved tail so trimmed transcript messages are covered by LCM summaries without running unrelated summary-condensation passes. Startup rotation first scans OpenClaw's current indexed session stores for configured agents, then intersects those candidates with active LCM conversations and matching bootstrap file mappings. Runtime rotation checks from `afterTurn()` and `maintain()` intentionally do not directly rewrite active session JSONL because embedded prompt-lock fences can still be open while tool-call loops and host background maintenance overlap; runtime `rotate` logs a deferral until startup, manual `/lcm rotate`, or a future host-owned full-transcript rewrite primitive is available. Automatic rotation does not create a SQLite backup by default; set `autoRotateSessionFiles.createBackups` to `true` to make startup rotation create one pre-rotation LCM database backup for the batch before any transcript is rewritten. Manual `/lcm rotate` always keeps its backup-backed behavior regardless of this flag. Rotation never runs for ignored sessions, stateless sessions, or sessions without active LCM state. The preserved JSONL tail follows the existing rotate behavior, which is controlled by `freshTailCount`. Transcript GC uses the host-provided `rewriteTranscriptEntries` primitive and defers until host-approved background maintenance when `transcriptGcEnabled` is enabled.

Lossless-claw writes routine operational JSONL logs by default at `/tmp/openclaw/lossless-claw-YYYY-MM-DD.log`, beside OpenClaw's `/tmp/openclaw/openclaw-YYYY-MM-DD.log`. Routine info and debug lines go to the independent file instead of the shared OpenClaw log. Startup banners and warning/error lines still go through OpenClaw's runtime logger so gateway-level startup and failure diagnostics remain visible. The independent file follows the same practical rotation model as OpenClaw: a dated filename rolls over when the local date changes, stale dated files are pruned after 3 days, and an oversized active file is rotated through `.1.log` to `.5.log`.

Every automatic decision emits grep-able log lines prefixed with `[lcm] auto-rotate:`. Startup emits one compact summary line with `phase=startup`, `action=summary`, `scanned`, `eligible`, `rotated`, `warned`, `skipped`, `durationMs`, `bytesRemoved`, and backup fields when a batch backup was created; quiet skips such as missing files, missing bootstrap mappings, and below-threshold files are counted there instead of producing one line per candidate. Rotation detail lines include `phase`, `action`, `sessionId`, `sessionKey`, `sessionFile`, `sizeBytes`, `thresholdBytes`, `durationMs`, `backupPath`, `bytesRemoved`, `preservedTailMessageCount`, and `checkpointSize`; real warning lines include the same available context plus `reason` or `error`.

### Compaction thresholds and summary sizing

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `contextThreshold` | `number` | `0.75` | `LCM_CONTEXT_THRESHOLD` | Fraction of the active model context window that triggers compaction. |
| `contextThresholdOverrides` | `Array<{ name?: string; match: object; contextThreshold: number }>` | `[]` | none | Optional ordered rules that override `contextThreshold` by model id, model context-window range, or session glob pattern. |
| `freshTailCount` | `integer` | `64` | `LCM_FRESH_TAIL_COUNT` | Number of newest messages always kept raw. |
| `freshTailMaxTokens` | `integer` | unset | `LCM_FRESH_TAIL_MAX_TOKENS` | Optional token cap for the protected fresh tail. The newest message is always preserved even if it exceeds the cap. |
| `promptAwareEviction` | `boolean` | `false` | `LCM_PROMPT_AWARE_EVICTION_ENABLED` | When enabled, budget-constrained assembly keeps older evictable items by prompt relevance instead of pure chronology. This improves retrieval under tight budgets, but it can reduce prompt-cache hit rates because the preserved prefix changes as prompts change. |
| `stubLargeToolPayloads` | `boolean` | `false` | `LCM_STUB_LARGE_TOOL_PAYLOADS` | When enabled, evictable tool-result rows backfilled with `messages.large_content` are assembled as `[LCM Tool Output: file_xxx ...]` stubs while the fresh tail stays inline. Requires `scripts/lcm-blob-migrate.mjs`, which defaults to the same large-files root as runtime LCM (`LCM_LARGE_FILES_DIR` or `${OPENCLAW_STATE_DIR}/lcm-files`). |
| `leafMinFanout` | `integer` | `8` | `LCM_LEAF_MIN_FANOUT` | Minimum number of raw messages required before a leaf pass runs. |
| `condensedMinFanout` | `integer` | `4` | `LCM_CONDENSED_MIN_FANOUT` | Number of same-depth summaries needed before condensation is attempted. |
| `condensedMinFanoutHard` | `integer` | `2` | `LCM_CONDENSED_MIN_FANOUT_HARD` | Hard floor for condensation grouping during maintenance and repair flows. |
| `sweepMaxDepth` | `integer` | `1` | `LCM_SWEEP_MAX_DEPTH` | Preferred maximum condensation source depth during routine threshold sweeps. Use `0` for leaf-only and `-1` for unlimited depth. Pressure sweeps may go deeper when summarized context remains above target. |
| `incrementalMaxDepth` | `integer` | alias of `sweepMaxDepth` | `LCM_INCREMENTAL_MAX_DEPTH` | Deprecated alias for `sweepMaxDepth`. Kept so existing configs continue to load. |
| `leafChunkTokens` | `integer` | `20000` | `LCM_LEAF_CHUNK_TOKENS` | Maximum source-token budget for a leaf compaction chunk. Larger chunks reduce sweep frequency at the cost of slower individual summary calls. |
| `summaryPrefixTargetTokens` | `integer` | derived | `LCM_SUMMARY_PREFIX_TARGET_TOKENS` | Optional target for summarized-prefix tokens after a full sweep. If unset, Lossless derives `max(condensedTargetTokens, min(leafChunkTokens, floor(contextThreshold * tokenBudget * 0.5)))`. |
| `maxSweepIterations` | `integer` | `12` | `LCM_MAX_SWEEP_ITERATIONS` | Hard cap on summarizer passes within a single full sweep. On hitting the cap the sweep stops cleanly and returns the partial result; bounds how long a sweep can run on the turn-critical path. |
| `sweepDeadlineMs` | `integer` | `120000` | `LCM_SWEEP_DEADLINE_MS` | Wall-clock budget for a single full sweep, in milliseconds. When exceeded the sweep stops before starting another pass, so a slow or rate-limited summarizer cannot hang the agent turn. |
| `compactUntilUnderDeadlineMs` | `integer` | `300000` | `LCM_COMPACT_UNTIL_UNDER_DEADLINE_MS` | Wall-clock budget for a whole `compactUntilUnder` operation, in milliseconds. `compactUntilUnder` runs up to `maxRounds` sweeps; without this the worst case is `maxRounds × sweepDeadlineMs` (~20 min at the defaults). The deadline is shared into each round's sweep and checked before the next round. |
| `bootstrapMaxTokens` | `integer` | `max(6000, floor(leafChunkTokens * 0.3))` | `LCM_BOOTSTRAP_MAX_TOKENS` | Maximum parent-history tokens imported when a new LCM conversation bootstraps. |
| `leafTargetTokens` | `integer` | `2400` | `LCM_LEAF_TARGET_TOKENS` | Prompt target for leaf summary size. |
| `condensedTargetTokens` | `integer` | `2000` | `LCM_CONDENSED_TARGET_TOKENS` | Prompt target for condensed summary size. |
| `summaryMaxOverageFactor` | `number` | `3` | `LCM_SUMMARY_MAX_OVERAGE_FACTOR` | Hard ceiling multiplier before oversized summaries are deterministically truncated. |
| `largeFileThresholdTokens` | `integer` | `25000` | `LCM_LARGE_FILE_TOKEN_THRESHOLD` | Preferred key for the token threshold that routes text attachments into large-file summarization. |
| `largeFileTokenThreshold` | `integer` | alias of `largeFileThresholdTokens` | `LCM_LARGE_FILE_TOKEN_THRESHOLD` | Legacy alias accepted by the runtime. Prefer `largeFileThresholdTokens` in new config. |
| `maxAssemblyTokenBudget` | `integer` | unset | `LCM_MAX_ASSEMBLY_TOKEN_BUDGET` | Optional hard cap for assembly and threshold evaluation, useful with smaller-context models. |
| `maxExpandTokens` | `integer` | `4000` | `LCM_MAX_EXPAND_TOKENS` | Default token cap for `lcm_expand_query` responses. |

Forked child transcripts are also bounded by `bootstrapMaxTokens` when a host
copies a raw parent JSONL branch into the child file. This protects the LCM
database from importing unbounded parent history, but the host must still honor
the `thread-bootstrap-projection` context-engine capability for subagent or
thread forks so the model starts from the LCM-assembled compact view instead of
the raw copied transcript.

### Model selection, execution, and prompts

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `summaryModel` | `string` | `""` | `LCM_SUMMARY_MODEL` | Summarizer model override. Bare model names reuse the chosen provider; `provider/model` strings force a specific provider. |
| `summaryProvider` | `string` | `""` | `LCM_SUMMARY_PROVIDER` | Provider hint used only when `summaryModel` is a bare model name. |
| `largeFileSummaryModel` | `string` | `""` | `LCM_LARGE_FILE_SUMMARY_MODEL` | Large-file summarizer model override. |
| `largeFileSummaryProvider` | `string` | `""` | `LCM_LARGE_FILE_SUMMARY_PROVIDER` | Large-file summarizer provider hint for bare model names. |
| `expansionModel` | `string` | `""` | `LCM_EXPANSION_MODEL` | `lcm_expand_query` sub-agent model override. |
| `expansionProvider` | `string` | `""` | `LCM_EXPANSION_PROVIDER` | `lcm_expand_query` sub-agent provider hint for bare model names. |
| `delegationTimeoutMs` | `integer` | `120000` | `LCM_DELEGATION_TIMEOUT_MS` | Maximum time to wait for delegated expansion work. `lcm_expand_query` advertises a dynamic tool `timeoutMs` default with 30 seconds of extra RPC headroom so OpenClaw's tool watchdog does not fire before this wait completes. |
| `summaryTimeoutMs` | `integer` | `60000` | `LCM_SUMMARY_TIMEOUT_MS` | Maximum time to wait for one model-backed summarizer call. |
| `summaryCallWindowMs` | `integer` | `600000` | `LCM_SUMMARY_CALL_WINDOW_MS` | Rolling window for the per-session summarization spend guard. |
| `summaryMaxCallsPerWindow` | `integer` | `24` | `LCM_SUMMARY_MAX_CALLS_PER_WINDOW` | Maximum model-backed summarization calls per session/window before Lossless opens a non-auth spend backoff. |
| `summarySpendBackoffMs` | `integer` | `1800000` | `LCM_SUMMARY_SPEND_BACKOFF_MS` | Cooldown after the summarization spend guard opens. |
| `customInstructions` | `string` | `""` | `LCM_CUSTOM_INSTRUCTIONS` | Extra natural-language instructions injected into every summarization prompt. |

Summary calls are executed through OpenClaw's `api.runtime.llm.complete` capability. If you configure an explicit Lossless summary model (`summaryModel`, `largeFileSummaryModel`, or `fallbackProviders`), OpenClaw must allow that runtime LLM override under `plugins.entries.lossless-claw.llm.allowModelOverride` and `plugins.entries.lossless-claw.llm.allowedModels`. `openclaw doctor --fix` can add the minimal policy entries for configured Lossless summary models. Delegated expansion calls use OpenClaw's runtime sub-agent layer; explicit `expansionModel` values require `plugins.entries.lossless-claw.subagent.allowModelOverride` and a matching `subagent.allowedModels` entry, or `"*"` if you intentionally trust any expansion target. `openclaw doctor --fix` can add the minimal subagent policy, and `lcm_expand_query` retries once without the override if the host rejects it.

### Fallbacks, circuit breaking, and safety rails

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `fallbackProviders` | `Array<{ provider: string; model: string }>` | `[]` | `LCM_FALLBACK_PROVIDERS` | Explicit provider/model fallback chain for compaction summarization. Format for env vars is `provider/model,provider/model`. |
| `circuitBreakerThreshold` | `integer` | `5` | `LCM_CIRCUIT_BREAKER_THRESHOLD` | Consecutive auth failures before the summarization circuit breaker trips. |
| `circuitBreakerCooldownMs` | `integer` | `1800000` | `LCM_CIRCUIT_BREAKER_COOLDOWN_MS` | Cooldown before the summarization circuit breaker resets automatically. |
| `stripInjectedContextTags` | `string[]` | `["active_memory_plugin", "relevant-memories", "relevant_memories", "hindsight_memories"]` | `LCM_STRIP_INJECTED_CONTEXT_TAGS` | XML tag names whose blocks are stripped from message content before compaction summarization. Memory/context plugins inject these via `prependContext`; stripping prevents ephemeral retrieval context from polluting compacted summaries. Env var format is comma-separated tag names. Set to `[]` (or empty env string) to disable. |
| `replayFloodThresholdExternal` | `integer` | `3` | `LCM_REPLAY_FLOOD_THRESHOLD_EXTERNAL` | Max replay-like messages allowed in a single SQLite-second for `role=user` before `assertNoReplayTimestampFlood` refuses the batch. Defaults to `3` to preserve replay defense for third-partyly-rebroadcastable input. |
| `replayFloodThresholdInternal` | `integer` | `32` | `LCM_REPLAY_FLOOD_THRESHOLD_INTERNAL` | Max identical messages allowed in a single SQLite-second for `role=tool/assistant/system` before the anti-replay guard refuses the batch. Defaults to `32` to absorb legitimate idempotent sub-agent bursts (same-second tool returns like `{"status":"ok"}`). |

### Nested objects

#### `cacheAwareCompaction`

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `cacheAwareCompaction.enabled` | `boolean` | `true` | `LCM_CACHE_AWARE_COMPACTION_ENABLED` | Deprecated. Accepted for config compatibility but no longer used for automatic compaction decisions. |
| `cacheAwareCompaction.cacheTTLSeconds` | `integer` | `300` | `LCM_CACHE_TTL_SECONDS` | Deprecated. Accepted for config compatibility; threshold debt no longer waits for cache TTL. |
| `cacheAwareCompaction.maxColdCacheCatchupPasses` | `integer` | `2` | `LCM_MAX_COLD_CACHE_CATCHUP_PASSES` | Deprecated. Automatic cold-cache catch-up passes were removed. |
| `cacheAwareCompaction.hotCachePressureFactor` | `number` | `4` | `LCM_HOT_CACHE_PRESSURE_FACTOR` | Deprecated. Hot-cache raw-history pressure no longer drives automatic compaction. |
| `cacheAwareCompaction.hotCacheBudgetHeadroomRatio` | `number` | `0.2` | `LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO` | Deprecated. Hot-cache budget headroom no longer defers automatic threshold compaction. |
| `cacheAwareCompaction.coldCacheObservationThreshold` | `integer` | `3` | `LCM_COLD_CACHE_OBSERVATION_THRESHOLD` | Deprecated. Cold-cache streaks remain observable telemetry only. |
| `cacheAwareCompaction.criticalBudgetPressureRatio` | `number` | `0.90` | `LCM_CRITICAL_BUDGET_PRESSURE_RATIO` | Deprecated. `contextThreshold` is the only automatic compaction threshold. |

#### `dynamicLeafChunkTokens`

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `dynamicLeafChunkTokens.enabled` | `boolean` | `true` | `LCM_DYNAMIC_LEAF_CHUNK_TOKENS_ENABLED` | Deprecated. Accepted for config compatibility but no longer used by automatic compaction. |
| `dynamicLeafChunkTokens.max` | `integer` | `max(leafChunkTokens, floor(leafChunkTokens * 2))` | `LCM_DYNAMIC_LEAF_CHUNK_TOKENS_MAX` | Deprecated. With the default `leafChunkTokens=20000`, this resolves to `40000`, but automatic compaction uses `leafChunkTokens`. |

### Threshold full-sweep compaction

Automatic compaction is threshold-only:

- `afterTurn()` evaluates the resolved context threshold against the active token budget
- below threshold, no automatic compaction runs and no leaf debt is recorded
- at or above threshold, inline mode runs a threshold full sweep immediately
- deferred mode records one coalesced `"threshold"` maintenance row and normally drains it in the background or host-approved `maintain()`
- pre-assembly drain is reserved as an emergency safeguard when the live prompt is already over the active token budget

Lossless still records prompt-cache telemetry for status and diagnostics, but cache hotness no longer delays threshold debt. Legacy `cacheAwareCompaction.*` and `dynamicLeafChunkTokens.*` settings remain accepted so existing OpenClaw config continues to load, but they do not change automatic compaction behavior.

`contextThresholdOverrides` are optional and never replace the global fallback. Each rule's `match` object can include `model`, `modelContextWindowMin`, `modelContextWindowMax`, and `sessionPattern`; all fields in a rule must match. If several rules match, Lossless picks the highest-specificity rule, then the earliest rule in the array for ties. Exact `model` matches have higher specificity than `sessionPattern` matches, and session-pattern matches have higher specificity than context-window range matches. Threshold selection logs include the chosen threshold, source, rule index/name, token budget, threshold tokens, model, context-window value, and match reason.

Full sweeps first run leaf passes until there are no more eligible raw-message chunks outside the fresh tail. Condensation is then driven by summarized-prefix pressure: the routine condensation phase obeys `sweepMaxDepth`, and if the summarized prefix still exceeds `summaryPrefixTargetTokens`, a pressure phase may use `condensedMinFanoutHard` and condense deeper. Total context pressure starts the sweep, but does not by itself force deeper condensation once the raw prefix has been summarized.

A single sweep is bounded by both `maxSweepIterations` (a hard cap on summarizer passes) and `sweepDeadlineMs` (a wall-clock budget). When either limit is reached the sweep stops before starting another pass and returns the consistent partial result built so far, logging a `compactFullSweep stopped at …` warning. This keeps a slow or rate-limited summarizer from hanging the agent turn — remaining context pressure is picked up by the next sweep.

Overflow recovery (`compactUntilUnder`) runs up to `maxRounds` sweeps to drive context under a target. Because every sweep re-arms its own `sweepDeadlineMs`, the whole operation is separately bounded by `compactUntilUnderDeadlineMs` (default 300000): the operation deadline is shared into each round's sweep — a sweep stops at whichever deadline is sooner — and is also checked before starting the next round. On hitting it, `compactUntilUnder` returns the consistent partial result and logs a `compactUntilUnder stopped at …` warning, so the worst case is the operation budget rather than `maxRounds × sweepDeadlineMs`.

### Prompt-aware eviction

When `promptAwareEviction` is enabled:

- the protected fresh tail is still preserved exactly as usual
- only the older evictable prefix is affected
- if the evictable prefix does not fit and the current prompt has searchable terms, lossless-claw keeps the most relevant older items instead of just the newest older items

Tradeoff:

- this can improve retrieval quality when the prompt is asking about an older topic and the assembled context is tight
- it also makes the assembled prefix less stable for providers with prefix-based prompt caching, because different prompts can keep different older items

If Anthropic prompt-cache stability matters more than topical recall under pressure, set `promptAwareEviction: false`.

## Behavior notes

### Summary model resolution

Compaction summarization resolves candidates in this order:

1. `LCM_SUMMARY_MODEL` and `LCM_SUMMARY_PROVIDER`
2. `plugins.entries.lossless-claw.config.summaryModel` and `summaryProvider`
3. OpenClaw's default compaction model
4. Runtime/session provider and model hints from OpenClaw
5. `fallbackProviders`

If `summaryModel` already contains a provider prefix such as `anthropic/claude-sonnet-4-20250514`, `summaryProvider` is ignored for that candidate.

Lossless does not resolve provider credentials directly for compaction summaries. OpenClaw's runtime LLM layer owns provider/model preparation, auth profiles, OAuth refresh, base URLs, and dispatch. Lossless only selects the requested summary target and passes it to the host runtime, where model override policy is enforced.

A practical starting point for cost-sensitive setups is:

```env
LCM_SUMMARY_MODEL=openai/gpt-5.4-mini
LCM_EXPANSION_MODEL=openai/gpt-5.4-mini
```

### Session pattern matching

`ignoreSessionPatterns` and `statelessSessionPatterns` use full session keys.

- `*` matches any characters except `:`
- `**` matches anything, including `:`

Cron scheduler keys (`agent:<agent>:cron:<job>...`) are isolated automatically when a new runtime `sessionId` reuses the same `sessionKey`. Configure `ignoreSessionPatterns` for cron only when the run should bypass LCM entirely; leave cron sessions included when they need in-run compaction.

Example:

```json
{
  "ignoreSessionPatterns": [
    "agent:*:cron:**"
  ],
  "statelessSessionPatterns": [
    "agent:*:subagent:**",
    "agent:ops:subagent:**"
  ],
  "skipStatelessSessions": true
}
```

### `/new` and `/reset`

Lossless-claw treats OpenClaw reset commands differently:

- `/new` keeps the active LCM conversation and prunes active context according to `newSessionRetainDepth`
- `/reset` archives the active conversation row and creates a fresh active row for the same stable `sessionKey`

This keeps long-term history available while still giving users a real clean-slate reset.

### Deferred proactive compaction

Lossless-claw now defaults `proactiveThresholdCompactionMode` to `deferred`.

- deferred mode records a single coalesced maintenance debt row per conversation
- new deferred compaction debt is only created for `contextThreshold` pressure and uses reason `"threshold"`
- `maintain()` consumes threshold debt when the host explicitly opts in to deferred execution
- `assemble()` leaves pending threshold debt for after-turn background drain or host-approved `maintain()` while the live prompt is still within budget
- `assemble()` only consumes pending threshold debt synchronously as an emergency safeguard when the live prompt estimate is already over the active token budget
- old non-threshold debt from earlier builds is revalidated; if the conversation is no longer over threshold, it is cleared as a no-op
- `/lcm status` / `/lossless status` shows the current maintenance state, including pending/running/last-failure details
- status output also surfaces the latest API/cache telemetry as diagnostics, not as a deferral gate
- set `proactiveThresholdCompactionMode` to `inline` only if you need the legacy inline proactive compaction behavior for compatibility

### `/lcm rotate`

`/lcm rotate` exists for a different use case than `/new` or `/reset`:

- `/new` keeps the same active LCM conversation row and only prunes context.
- `/reset` changes OpenClaw session flow, which is sometimes more disruptive than users want.
- `/lcm rotate` keeps the live OpenClaw session identity and the same active LCM conversation row, but rewrites the backing transcript into a compact preserved-tail form.

Before rotating, Lossless-claw replaces one rolling `rotate-latest` SQLite backup. It then rewrites the current session transcript and checkpoints the same conversation at the new transcript frontier so bootstrap does not replay the dropped transcript history. Existing summaries, context items, and conversation identity stay in place. If you want additional timestamped snapshots, run `/lcm backup` explicitly before `/lcm rotate`.

## Environment-only knobs outside plugin config

These settings are not part of `plugins.entries.lossless-claw.config`, but they still affect the system:

| Env var | Default | Purpose |
| --- | --- | --- |
| `OPENCLAW_STATE_DIR` | `~/.openclaw` | Active state directory for the OpenClaw gateway. When set, all path defaults (database, large files, auth profiles, secrets) resolve relative to this directory instead of `~/.openclaw`. Set automatically by OpenClaw for non-default profiles. |
| `LCM_TUI_CONVERSATION_WINDOW_SIZE` | `200` | Number of messages `lcm-tui` loads per keyset-paged conversation window. |

## Database operations

The SQLite database lives at `databasePath` or `LCM_DATABASE_PATH`. The default path is `${OPENCLAW_STATE_DIR}/lcm.db` (resolves to `~/.openclaw/lcm.db` when `OPENCLAW_STATE_DIR` is not set).

Inspect it with:

```bash
sqlite3 "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/lcm.db"

SELECT COUNT(*) FROM conversations;
SELECT * FROM context_items WHERE conversation_id = 1 ORDER BY ordinal;
SELECT depth, COUNT(*) FROM summaries GROUP BY depth;
SELECT summary_id, depth, token_count FROM summaries ORDER BY token_count DESC LIMIT 10;
```

Back it up with:

```bash
cp "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/lcm.db" "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/lcm.db.backup"
sqlite3 "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/lcm.db" ".backup ${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/lcm.db.backup"
```

Or from a supported OpenClaw chat/native command surface:

```text
/lcm backup
```

## Disabling lossless-claw

To disable the plugin but keep it installed:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "enabled": false
      }
    }
  }
}
```

To switch back to OpenClaw's legacy context engine instead:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```
