# Configuration

Lossless-claw reads plugin configuration from `plugins.entries.lossless-claw.config`.

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
  "freshTailCount": 64,
  "freshTailMaxTokens": 24000,
  "promptAwareEviction": false,
  "newSessionRetainDepth": 2,
  "leafMinFanout": 8,
  "condensedMinFanout": 4,
  "condensedMinFanoutHard": 2,
  "incrementalMaxDepth": 1,
  "leafChunkTokens": 20000,
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
  "timezone": "America/Los_Angeles",
  "pruneHeartbeatOk": false,
  "transcriptGcEnabled": false,
  "maxAssemblyTokenBudget": 30000,
  "summaryMaxOverageFactor": 3,
  "customInstructions": "",
  "circuitBreakerThreshold": 5,
  "circuitBreakerCooldownMs": 1800000,
  "fallbackProviders": [],
  "proactiveThresholdCompactionMode": "deferred",
  "autoRotateSessionFiles": {
    "enabled": true,
    "sizeBytes": 2097152,
    "startup": "rotate",
    "runtime": "rotate"
  },
  "cacheAwareCompaction": {
    "enabled": true,
    "cacheTTLSeconds": 300,
    "maxColdCacheCatchupPasses": 2,
    "hotCachePressureFactor": 4,
    "hotCacheBudgetHeadroomRatio": 0.2,
    "coldCacheObservationThreshold": 3,
    "criticalBudgetPressureRatio": 0.70
  },
  "dynamicLeafChunkTokens": {
    "enabled": true,
    "max": 40000
  }
}
```

Notes on the example:

- Values shown are the runtime defaults when a fixed default exists.
- `databasePath` shows the expanded default path shape. Use an absolute path in config rather than `~`.
- `largeFilesDir` shows the expanded default path shape. Both `databasePath` and `largeFilesDir` default to paths under `OPENCLAW_STATE_DIR` (which in turn falls back to `~/.openclaw`).
- `timezone` has no fixed hardcoded default; at runtime it resolves from `TZ` first, then the system timezone. The example uses `America/Los_Angeles`.
- `maxAssemblyTokenBudget` has no default. The example uses `30000` as a realistic cap for a 32k-class model.
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
| `proactiveThresholdCompactionMode` | `"deferred" \| "inline"` | `"deferred"` | `LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE` | Controls whether proactive threshold compaction is deferred into maintenance debt by default or run inline for legacy behavior. |
| `autoRotateSessionFiles.enabled` | `boolean` | `true` | `LCM_AUTO_ROTATE_SESSION_FILES_ENABLED` | Enables automatic rotation for oversized LCM-managed session JSONL files. |
| `autoRotateSessionFiles.sizeBytes` | `integer` | `2097152` | `LCM_AUTO_ROTATE_SESSION_FILES_SIZE_BYTES` | Byte threshold that triggers automatic session-file rotation. |
| `autoRotateSessionFiles.startup` | `"rotate" \| "warn" \| "off"` | `"rotate"` | `LCM_AUTO_ROTATE_SESSION_FILES_STARTUP` | Startup behavior for oversized indexed OpenClaw session transcripts that also have active LCM bootstrap state. |
| `autoRotateSessionFiles.runtime` | `"rotate" \| "warn" \| "off"` | `"rotate"` | `LCM_AUTO_ROTATE_SESSION_FILES_RUNTIME` | Runtime behavior after `afterTurn()` and `maintain()` check the current transcript size. |

> **Multi-profile note:** `OPENCLAW_STATE_DIR` (set by the host OpenClaw gateway) controls where state is stored. When two gateways run on the same host (e.g. separate bot personas), each gateway sets its own `OPENCLAW_STATE_DIR` and lossless-claw automatically uses that directory for the database, large-file payloads, auth-profile lookups, and legacy secrets — no per-profile plugin config is needed.

Automatic session-file rotation uses the same safe path as `/lcm rotate`: runtime rotation replaces the rolling `rotate-latest` SQLite backup, rewrites only the live session transcript, keeps the active LCM conversation and durable history intact, and refreshes the bootstrap checkpoint. Startup rotation first scans OpenClaw's current indexed session stores for configured agents, then intersects those candidates with active LCM conversations and matching bootstrap file mappings. If multiple startup candidates need rotation, one pre-rotation LCM database backup is created for the batch before any transcript is rewritten. Rotation never runs for ignored sessions, stateless sessions, or sessions without active LCM state. The preserved JSONL tail follows the existing rotate behavior, which is controlled by `freshTailCount`.

Every automatic decision emits grep-able log lines prefixed with `[lcm] auto-rotate:`. Startup emits one compact summary line with `phase=startup`, `action=summary`, `scanned`, `eligible`, `rotated`, `warned`, `skipped`, `durationMs`, `bytesRemoved`, and backup fields when a batch backup was created; quiet skips such as missing files, missing bootstrap mappings, and below-threshold files are counted there instead of producing one line per candidate. Rotation detail lines include `phase`, `action`, `sessionId`, `sessionKey`, `sessionFile`, `sizeBytes`, `thresholdBytes`, `durationMs`, `backupPath`, `bytesRemoved`, `preservedTailMessageCount`, and `checkpointSize`; real warning lines include the same available context plus `reason` or `error`.

### Compaction thresholds and summary sizing

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `contextThreshold` | `number` | `0.75` | `LCM_CONTEXT_THRESHOLD` | Fraction of the active model context window that triggers compaction. |
| `freshTailCount` | `integer` | `64` | `LCM_FRESH_TAIL_COUNT` | Number of newest messages always kept raw. |
| `freshTailMaxTokens` | `integer` | unset | `LCM_FRESH_TAIL_MAX_TOKENS` | Optional token cap for the protected fresh tail. The newest message is always preserved even if it exceeds the cap. |
| `promptAwareEviction` | `boolean` | `false` | `LCM_PROMPT_AWARE_EVICTION_ENABLED` | When enabled, budget-constrained assembly keeps older evictable items by prompt relevance instead of pure chronology. This improves retrieval under tight budgets, but it can reduce prompt-cache hit rates because the preserved prefix changes as prompts change. |
| `leafMinFanout` | `integer` | `8` | `LCM_LEAF_MIN_FANOUT` | Minimum number of raw messages required before a leaf pass runs. |
| `condensedMinFanout` | `integer` | `4` | `LCM_CONDENSED_MIN_FANOUT` | Number of same-depth summaries needed before condensation is attempted. |
| `condensedMinFanoutHard` | `integer` | `2` | `LCM_CONDENSED_MIN_FANOUT_HARD` | Hard floor for condensation grouping during maintenance and repair flows. |
| `incrementalMaxDepth` | `integer` | `1` | `LCM_INCREMENTAL_MAX_DEPTH` | Maximum automatic condensation depth after leaf compaction. Use `0` for leaf-only and `-1` for unlimited depth. |
| `leafChunkTokens` | `integer` | `20000` | `LCM_LEAF_CHUNK_TOKENS` | Maximum source-token budget for a leaf compaction chunk. |
| `bootstrapMaxTokens` | `integer` | `max(6000, floor(leafChunkTokens * 0.3))` | `LCM_BOOTSTRAP_MAX_TOKENS` | Maximum parent-history tokens imported when a new LCM conversation bootstraps. |
| `leafTargetTokens` | `integer` | `2400` | `LCM_LEAF_TARGET_TOKENS` | Prompt target for leaf summary size. |
| `condensedTargetTokens` | `integer` | `2000` | `LCM_CONDENSED_TARGET_TOKENS` | Prompt target for condensed summary size. |
| `summaryMaxOverageFactor` | `number` | `3` | `LCM_SUMMARY_MAX_OVERAGE_FACTOR` | Hard ceiling multiplier before oversized summaries are deterministically truncated. |
| `largeFileThresholdTokens` | `integer` | `25000` | `LCM_LARGE_FILE_TOKEN_THRESHOLD` | Preferred key for the token threshold that routes text attachments into large-file summarization. |
| `largeFileTokenThreshold` | `integer` | alias of `largeFileThresholdTokens` | `LCM_LARGE_FILE_TOKEN_THRESHOLD` | Legacy alias accepted by the runtime. Prefer `largeFileThresholdTokens` in new config. |
| `maxAssemblyTokenBudget` | `integer` | unset | `LCM_MAX_ASSEMBLY_TOKEN_BUDGET` | Optional hard cap for assembly and threshold evaluation, useful with smaller-context models. |
| `maxExpandTokens` | `integer` | `4000` | `LCM_MAX_EXPAND_TOKENS` | Default token cap for `lcm_expand_query` responses. |

### Model selection, execution, and prompts

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `summaryModel` | `string` | `""` | `LCM_SUMMARY_MODEL` | Summarizer model override. Bare model names reuse the chosen provider; `provider/model` strings force a specific provider. |
| `summaryProvider` | `string` | `""` | `LCM_SUMMARY_PROVIDER` | Provider hint used only when `summaryModel` is a bare model name. |
| `largeFileSummaryModel` | `string` | `""` | `LCM_LARGE_FILE_SUMMARY_MODEL` | Large-file summarizer model override. |
| `largeFileSummaryProvider` | `string` | `""` | `LCM_LARGE_FILE_SUMMARY_PROVIDER` | Large-file summarizer provider hint for bare model names. |
| `expansionModel` | `string` | `""` | `LCM_EXPANSION_MODEL` | `lcm_expand_query` sub-agent model override. |
| `expansionProvider` | `string` | `""` | `LCM_EXPANSION_PROVIDER` | `lcm_expand_query` sub-agent provider hint for bare model names. |
| `delegationTimeoutMs` | `integer` | `120000` | `LCM_DELEGATION_TIMEOUT_MS` | Maximum time to wait for delegated expansion work. |
| `summaryTimeoutMs` | `integer` | `60000` | `LCM_SUMMARY_TIMEOUT_MS` | Maximum time to wait for one model-backed summarizer call. |
| `customInstructions` | `string` | `""` | `LCM_CUSTOM_INSTRUCTIONS` | Extra natural-language instructions injected into every summarization prompt. |

### Fallbacks, circuit breaking, and safety rails

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `fallbackProviders` | `Array<{ provider: string; model: string }>` | `[]` | `LCM_FALLBACK_PROVIDERS` | Explicit provider/model fallback chain for compaction summarization. Format for env vars is `provider/model,provider/model`. |
| `circuitBreakerThreshold` | `integer` | `5` | `LCM_CIRCUIT_BREAKER_THRESHOLD` | Consecutive auth failures before the summarization circuit breaker trips. |
| `circuitBreakerCooldownMs` | `integer` | `1800000` | `LCM_CIRCUIT_BREAKER_COOLDOWN_MS` | Cooldown before the summarization circuit breaker resets automatically. |

### Nested objects

#### `cacheAwareCompaction`

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `cacheAwareCompaction.enabled` | `boolean` | `true` | `LCM_CACHE_AWARE_COMPACTION_ENABLED` | Defers incremental leaf compaction more aggressively when prompt-cache telemetry indicates a hot cache. |
| `cacheAwareCompaction.cacheTTLSeconds` | `integer` | `300` | `LCM_CACHE_TTL_SECONDS` | Fallback cache TTL used when deferred Anthropic compaction has provider/model telemetry but no explicit runtime cache-retention window. |
| `cacheAwareCompaction.maxColdCacheCatchupPasses` | `integer` | `2` | `LCM_MAX_COLD_CACHE_CATCHUP_PASSES` | Maximum bounded catch-up passes allowed in one maintenance cycle when cache telemetry is cold. |
| `cacheAwareCompaction.hotCachePressureFactor` | `number` | `4` | `LCM_HOT_CACHE_PRESSURE_FACTOR` | Multiplier applied to the hot-cache leaf trigger before raw-history pressure overrides cache preservation. |
| `cacheAwareCompaction.hotCacheBudgetHeadroomRatio` | `number` | `0.2` | `LCM_HOT_CACHE_BUDGET_HEADROOM_RATIO` | Minimum fraction of the real token budget that must remain free before hot-cache incremental compaction is skipped entirely. |
| `cacheAwareCompaction.coldCacheObservationThreshold` | `integer` | `3` | `LCM_COLD_CACHE_OBSERVATION_THRESHOLD` | Consecutive cold observations required before non-explicit cache misses are treated as truly cold. This dampens one-off routing noise and provider failover blips. |
| `cacheAwareCompaction.criticalBudgetPressureRatio` | `number` | `0.70` | `LCM_CRITICAL_BUDGET_PRESSURE_RATIO` | Fraction of the token budget at which deferred compaction bypasses hot-cache delay so prompt-mutating debt can run before overflow. Set to `1` to disable this bypass. |

#### `dynamicLeafChunkTokens`

| Key | Type | Default | Env override | Purpose |
| --- | --- | --- | --- | --- |
| `dynamicLeafChunkTokens.enabled` | `boolean` | `true` | `LCM_DYNAMIC_LEAF_CHUNK_TOKENS_ENABLED` | Enables dynamic working leaf chunk sizes for busier sessions. |
| `dynamicLeafChunkTokens.max` | `integer` | `max(leafChunkTokens, floor(leafChunkTokens * 2))` | `LCM_DYNAMIC_LEAF_CHUNK_TOKENS_MAX` | Upper bound for the dynamic working chunk size. With the default `leafChunkTokens=20000`, this resolves to `40000`. |

### Cache-aware incremental compaction

When cache-aware compaction is enabled:

- hot cache stretches the incremental leaf trigger to `dynamicLeafChunkTokens.max`
- hot cache skips incremental maintenance entirely when the assembled context is still comfortably below the real token budget
- hot cache also gets a short hysteresis window so one ambiguous turn does not immediately discard a recently healthy cache signal
- cold cache still allows bounded catch-up passes via `cacheAwareCompaction.maxColdCacheCatchupPasses`
- once `currentTokenCount >= criticalBudgetPressureRatio * tokenBudget`, deferred compaction bypasses hot-cache delay so prompt-mutating debt can run before emergency overflow handling

When incremental leaf compaction still runs on a hot cache, follow-on condensed passes are suppressed so the maintenance cycle only pays for the leaf pass that was explicitly justified.

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
4. Legacy per-call provider and model hints
5. `fallbackProviders`

If `summaryModel` already contains a provider prefix such as `anthropic/claude-sonnet-4-20250514`, `summaryProvider` is ignored for that candidate.

Runtime-managed OAuth providers are supported here too. In particular, `openai-codex` and `github-copilot` auth profiles can be used for summary and expansion calls without a separate API key.

A practical starting point for cost-sensitive setups is:

```env
LCM_SUMMARY_MODEL=openai/gpt-5.4-mini
LCM_EXPANSION_MODEL=openai/gpt-5.4-mini
```

### Session pattern matching

`ignoreSessionPatterns` and `statelessSessionPatterns` use full session keys.

- `*` matches any characters except `:`
- `**` matches anything, including `:`

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
- deferred mode persists provider/model/cache telemetry so Anthropic-family sessions can avoid rewriting a still-hot prompt cache
- `maintain()` can still process non-prompt-mutating work when the host explicitly opts in to deferred execution, but it leaves prompt-mutating debt pending while Anthropic cache is still hot
- `assemble()` consumes deferred prompt-mutating debt pre-assembly once the cache is cold or the next turn is already approaching overflow
- `/lcm status` / `/lossless status` shows the current maintenance state, including pending/running/last-failure details
- status output also surfaces the latest API/cache telemetry so operators can see whether a deferred debt item is being preserved for cache-safety reasons
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
