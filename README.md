# lossless-claw

Lossless Context Management plugin for [OpenClaw](https://github.com/openclaw/openclaw), based on the [LCM paper](https://papers.voltropy.com/LCM) from [Voltropy](https://x.com/Voltropy). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands And Skill](#commands-and-skill)
- [Session Migration CLI](#session-migration-cli)
- [Documentation](#documentation)
- [Development](#development)
  - [Line endings](#line-endings)
- [Security](#security)
- [License](#license)

## What it does

Two ways to learn: read the below, or [check out this super cool animated visualization](https://losslesscontext.ai).

When a conversation grows beyond the model's context window, OpenClaw (just like all of the other agents) normally truncates older messages. LCM instead:

1. **Persists every message** in a SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) so agents can search and recall details from compacted history

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

**It feels like talking to an agent that never forgets. Because it doesn't. In normal operation, you'll never need to think about compaction again.**

## Commands And Skill

The package installs an agent-oriented `lcm` shell CLI and includes a bundled `lossless-claw` skill plus plugin commands for supported OpenClaw chat/native command providers.

The shell CLI reads `lcm.db` without modifying conversation data. Its only write command sets one validated Lossless config value in `openclaw.json`:

```bash
lcm status
lcm conversations show --session-key 'agent:main:example'
lcm messages tail --conversation-id 42
lcm summaries list --conversation-id 42 --depth 0 --recency 7d
lcm config get freshTailCount
lcm config set freshTailCount 96
```

JSON is the default output. List commands use bounded keyset pagination. See [Lossless Claw CLI](docs/cli.md) for commands, filters, path precedence, output fields, config-write safety, and exit codes.

The native OpenClaw command surface provides in-session operations:

- `/lossless` shows version, enablement/selection state, DB path and size, summary counts, and summary-health status
- `/lossless backup` creates a timestamped backup of the current LCM SQLite database
- `/lossless rotate` rewrites the active session transcript into a compact tail-preserving form without changing the live OpenClaw session identity or current LCM conversation
- `/lossless doctor` scans for broken or truncated summaries
- `/lossless doctor apply` repairs broken summaries in the current conversation after the normal safety preflight
- `/lossless doctor apply <conversation-id> confirm-offline` repairs a specific conversation after its active channel path has been paused or moved away; targeted repair is restricted to authorized OpenClaw command senders and always requires the explicit offline confirmation
- `/lossless doctor clean` shows read-only high-confidence junk diagnostics for archived subagents, cron sessions, and NULL-key orphaned subagent runs
- `/lossless status` shows plugin, conversation, and maintenance state including deferred compaction debt
- `/lcm` is the shorter alias for `/lossless`

Supported native command examples:

- `/lossless`
- `/lossless backup`
- `/lossless rotate`
- `/lossless doctor`
- `/lossless doctor apply 42 confirm-offline`
- `/lossless doctor clean`
- `/lcm`

The package does not register these OpenClaw root subcommands:

- `openclaw lossless`
- `openclaw lcm`
- `openclaw /lossless`
- `openclaw /lcm`

The bundled skill focuses on configuration, diagnostics, architecture, and recall-tool usage. Its reference set lives under `skills/lossless-claw/references/`.

### Programmatic control

Lossless-claw also exposes an optional host-facing context-engine control contract for OpenClaw gateways that support context-engine capabilities and control dispatch. The contract is intentionally smaller than the native slash command surface:

- `status` returns whether an LCM conversation is active and the current stored message count.
- `doctor` returns a bounded, sanitized warning list for summary-health issues.
- `rotate` runs the same safe transcript rotation path as `/lossless rotate` and returns the post-rotate message count plus the timestamp for that successful rotate operation.

Programmatic control never returns transcript text, local database paths, backup paths, credentials, provider debug, or shell output. `status` does not report `lastRotatedAt`; hosts that need durable rotation timestamps should persist that product state themselves after a successful `rotate` result.

This surface is capability-gated by the OpenClaw host. At the time of this change there is not yet a stable OpenClaw release with the required context-engine control endpoints; downstream users should treat it as unavailable unless their host advertises the matching capability, for example through the pending `openclaw/openclaw#98060` contract or an equivalent downstream gateway.

## Session Migration CLI

`lossless-claw-migrate-sessions` is a one-time shell CLI for backfilling OpenClaw JSONL session files into `lcm.db` after lossless-claw was disabled, missing, or installed after sessions already existed. It is not a background replay loop and it does not run summarization.

Run it in dry-run mode first:

```bash
npx --package @martian-engineering/lossless-claw@latest lossless-claw-migrate-sessions --state-dir ~/.openclaw
```

Apply the import only after reviewing the dry-run output:

```bash
npx --package @martian-engineering/lossless-claw@latest lossless-claw-migrate-sessions --state-dir ~/.openclaw --apply
```

The command defaults to `${OPENCLAW_STATE_DIR:-~/.openclaw}` and `${OPENCLAW_STATE_DIR:-~/.openclaw}/lcm.db`. `--apply` creates a timestamped SQLite backup before writing when the database already exists. Use `--file <path>` or repeatable `--sessions-dir <path>` for targeted imports, `--since <iso-date>` or `--limit <n>` to narrow a batch, and `--json` for machine-readable output.

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

> **Compatibility:** `lossless-claw@0.10.0` and newer require OpenClaw `2026.5.12` or newer for OpenClaw's `api.runtime.llm.complete` summarization capability. Releases that include context-engine memory supplement support require OpenClaw `2026.5.28` or newer for `buildMemorySystemPromptAddition`. If you cannot upgrade OpenClaw yet, stay on `lossless-claw@0.9.4` and remove `0.10.x`-only config such as `sweepMaxDepth`.

### Install the plugin

Use OpenClaw's plugin installer (recommended):

```bash
openclaw plugins install @martian-engineering/lossless-claw@latest
```

If you're running from a local OpenClaw checkout, use:

```bash
pnpm openclaw plugins install @martian-engineering/lossless-claw@latest
```

Use exact versions only for rollback or reproducible canary testing. OpenClaw records an exact install spec such as `@martian-engineering/lossless-claw@0.12.0` as a pinned update track, so OpenClaw plugin update sync will keep that version until you move back to the stable track:

```bash
openclaw plugins update @martian-engineering/lossless-claw@latest
```

For local plugin development, build your working copy first, then link it instead of copying files:

```bash
cd /path/to/lossless-claw
pnpm build

openclaw plugins install --link /path/to/lossless-claw
# or from a local OpenClaw checkout:
# pnpm openclaw plugins install --link /path/to/lossless-claw
```

Re-run `pnpm build` after local source changes so the linked plugin's `dist/` output stays current.

The install command records the plugin, enables it, and applies compatible slot selection (including `contextEngine` when applicable).

> **Note:** If your OpenClaw config uses `plugins.allow`, allowlist the plugin id `lossless-claw` plus any other active plugins you rely on. Do not add command tokens or aliases like `lossless` or `/lcm` to `plugins.allow`; that setting only accepts plugin ids. In some setups, narrowing the allowlist can prevent plugin-backed integrations from loading, even if `lossless-claw` itself is installed correctly. Restart the gateway after plugin config changes.

### Configure OpenClaw

In most cases, no manual JSON edits are needed after `openclaw plugins install`.

If you need to set it manually, ensure the context engine slot points at lossless-claw:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "lossless-claw"
    }
  }
}
```

Restart OpenClaw after configuration changes.

## Configuration

LCM is configured through a combination of plugin config and environment variables. Environment variables take precedence for backward compatibility.

### Plugin config

Add a `lossless-claw` entry under `plugins.entries` in your OpenClaw config:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "enabled": true,
        "llm": {
          "allowModelOverride": true,
          "allowedModels": ["openai/gpt-5.4-mini"]
        },
        "config": {
          "freshTailCount": 64,
          "leafChunkTokens": 80000,
          "newSessionRetainDepth": 2,
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
          ],
          "incrementalMaxDepth": 1,
          "cacheAwareCompaction": {
            "enabled": true,
            "cacheTTLSeconds": 300
          },
          "ignoreSessionPatterns": [
            "agent:*:cron:**",
            "agent:*:**:active-memory:**",
            "agent:*:dreaming-narrative-**"
          ],
          "transcriptGcEnabled": false,
          "proactiveThresholdCompactionMode": "deferred",
          "summaryModel": "openai/gpt-5.4-mini",
          "expansionModel": "openai/gpt-5.4-mini",
          "delegationTimeoutMs": 300000,
          "summaryTimeoutMs": 60000,
          "summaryCallWindowMs": 600000,
          "summaryMaxCallsPerWindow": 24,
          "summarySpendBackoffMs": 1800000
        }
      }
    }
  }
}
```

The `ignoreSessionPatterns` entries in this example are storage exclusions. Matching cron, active-memory, and OpenClaw memory-core dreaming narrative sessions do not create LCM conversation rows or store messages in LCM.

`leafChunkTokens` controls how many source tokens can accumulate in a leaf compaction chunk before summarization is triggered. The default is `20000`, but quota-limited summary providers may benefit from a larger value to reduce compaction frequency. `summaryModel` and `summaryProvider` let you request a cheaper or faster compaction model through OpenClaw's `api.runtime.llm.complete` capability; OpenClaw still owns provider dispatch and auth. Explicit summary model requests require `llm.allowModelOverride` and matching `llm.allowedModels` policy entries for `lossless-claw`. `expansionModel` does the same for `lcm_expand_query` sub-agent calls (drilling into summaries to recover detail). `delegationTimeoutMs` controls how long `lcm_expand_query` waits for that delegated sub-agent to finish before returning a timeout error; it defaults to `120000` (120s). `summaryTimeoutMs` controls the per-call timeout for model-backed LCM summarization; it defaults to `60000` (60s). `summaryMaxCallsPerWindow`, `summaryCallWindowMs`, and `summarySpendBackoffMs` bound repeated non-auth summarization spend per session. When unset, the model settings still fall back to OpenClaw's configured default model/provider. See [Expansion model override requirements](#expansion-model-override-requirements) for the required `subagent` trust policy when using `expansionModel`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `LCM_IGNORE_SESSION_PATTERNS` | `""` | Comma-separated glob patterns for session keys to exclude from LCM storage |
| `LCM_STATELESS_SESSION_PATTERNS` | `""` | Comma-separated glob patterns for session keys that may read from LCM but never write to it |
| `LCM_SKIP_STATELESS_SESSIONS` | `true` | Enable stateless-session write skipping for matching session keys |
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0–1.0) |
| `LCM_FRESH_TAIL_COUNT` | `64` | Number of recent messages protected from compaction |
| `LCM_NEW_SESSION_RETAIN_DEPTH` | `2` | Context retained after `/new` (`-1` keeps all context, `2` keeps d2+) |
| `LCM_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `LCM_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `LCM_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `LCM_INCREMENTAL_MAX_DEPTH` | `1` | How deep incremental compaction goes (0 = leaf only, 1 = one condensed pass, -1 = unlimited) |
| `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction chunk |
| `LCM_LEAF_TARGET_TOKENS` | `1200` | Target token count for leaf summaries |
| `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target token count for condensed summaries |
| `LCM_MAX_EXPAND_TOKENS` | `4000` | Token cap for sub-agent expansion queries |
| `LCM_LARGE_FILE_TOKEN_THRESHOLD` | `25000` | File blocks above this size are intercepted and stored separately |
| `LCM_LARGE_FILE_SUMMARY_PROVIDER` | `""` | Provider override for large-file summarization |
| `LCM_LARGE_FILE_SUMMARY_MODEL` | `""` | Model override for large-file summarization |
| `LCM_SUMMARY_MODEL` | `""` | Model override for compaction summarization; falls back to OpenClaw's default model when unset |
| `LCM_SUMMARY_PROVIDER` | `""` | Provider override for compaction summarization; falls back to `OPENCLAW_PROVIDER` or the provider embedded in the model ref |
| `LCM_SUMMARY_BASE_URL` | *(from OpenClaw / provider default)* | Base URL override for summarization API calls |
| `LCM_EXPANSION_MODEL` | *(from OpenClaw)* | Model override for `lcm_expand_query` sub-agent (e.g. `openai/gpt-5.4-mini`) |
| `LCM_EXPANSION_PROVIDER` | *(from OpenClaw)* | Provider override for `lcm_expand_query` sub-agent |
| `LCM_DELEGATION_TIMEOUT_MS` | `120000` | Max time to wait for delegated `lcm_expand_query` sub-agent completion |
| `LCM_SUMMARY_TIMEOUT_MS` | `60000` | Max time to wait for a single model-backed LCM summarizer call |
| `LCM_SUMMARY_CALL_WINDOW_MS` | `600000` | Rolling window used by the per-session summarization spend guard |
| `LCM_SUMMARY_MAX_CALLS_PER_WINDOW` | `24` | Max model-backed summarization calls per session/window before spend backoff opens |
| `LCM_SUMMARY_SPEND_BACKOFF_MS` | `1800000` | Cooldown after the summarization spend guard opens |
| `LCM_PRUNE_HEARTBEAT_OK` | `false` | Retroactively delete `HEARTBEAT_OK` turn cycles from LCM storage |
| `LCM_TRANSCRIPT_GC_ENABLED` | `false` | Enable transcript rewrite GC during `maintain()` |
| `LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE` | `deferred` | Choose whether proactive threshold compaction is deferred into maintenance debt or kept inline for legacy behavior |
| `LCM_CACHE_TTL_SECONDS` | `300` | Cache TTL used by cache-aware deferred compaction when provider/runtime telemetry does not supply a more specific retention window |

Transcript GC rewrites are disabled by default. Set `transcriptGcEnabled` or `LCM_TRANSCRIPT_GC_ENABLED` to turn them on explicitly.
Deferred proactive compaction is also the default. Set `proactiveThresholdCompactionMode` or `LCM_PROACTIVE_THRESHOLD_COMPACTION_MODE` to `inline` only if you need legacy foreground compaction behavior. In deferred mode, lossless-claw records one coalesced prompt-mutating debt item after the turn, leaves background `maintain()` to process only non-prompt-mutating work while Anthropic cache is still hot, and then consumes that debt pre-assembly once the cache is cold or the prompt is approaching overflow.

### Expansion model override requirements

If you want `lcm_expand_query` to run on a dedicated model via `expansionModel` or `LCM_EXPANSION_MODEL`, OpenClaw must explicitly trust the plugin to request sub-agent model overrides.

For most setups, `openai/gpt-5.4-mini` is a better starting point than Anthropic Haiku because it is cheap, fast, and does not depend on Anthropic quota remaining.

Add a `subagent` policy under `plugins.entries.lossless-claw` and allowlist the canonical `provider/model` target you want the plugin to use:

```json
{
  "models": {
    "openai/gpt-4.1-mini": {}
  },
  "plugins": {
    "entries": {
      "lossless-claw": {
        "enabled": true,
        "subagent": {
          "allowModelOverride": true,
          "allowedModels": ["openai/gpt-4.1-mini"]
        },
        "config": {
          "expansionModel": "openai/gpt-4.1-mini"
        }
      }
    }
  }
}
```

- `subagent.allowModelOverride` is required for OpenClaw to honor plugin-requested per-run `provider`/`model` overrides.
- `subagent.allowedModels` is optional but recommended. Use `"*"` only if you intentionally want to trust any target model.
- The chosen expansion target must also be available in OpenClaw's normal model catalog. If it is not already configured elsewhere, add it under the top-level `models` map as shown above.
- If you prefer splitting provider and model, set `config.expansionProvider` and use a bare `config.expansionModel`.
- `openclaw doctor --fix` can add the required `subagent` policy for a configured `expansionModel`. If a host still rejects a stale or unavailable override, `lcm_expand_query` retries once without the override so recall does not fail hard.

Plugin config equivalents:

- `ignoreSessionPatterns`
- `statelessSessionPatterns`
- `skipStatelessSessions`
- `transcriptGcEnabled`
- `newSessionRetainDepth`
- `summaryModel`
- `summaryProvider`
- `delegationTimeoutMs`
- `summaryTimeoutMs`

Environment variables still win over plugin config when both are set.

### Summary model priority

For compaction summarization, lossless-claw resolves the model in this order:

1. `LCM_SUMMARY_MODEL` / `LCM_SUMMARY_PROVIDER`
2. Plugin config `summaryModel` / `summaryProvider`
3. OpenClaw's default compaction model/provider
4. Runtime/session model/provider hints from OpenClaw

If `summaryModel` already includes a provider prefix such as `anthropic/claude-sonnet-4-20250514`, `summaryProvider` is ignored for that choice. Otherwise, the provider falls back to the matching override, then `OPENCLAW_PROVIDER`, then the provider inferred by the caller.

Summary calls are dispatched through OpenClaw's runtime LLM layer, so auth profiles, OAuth refresh, API keys, base URLs, and provider-specific request preparation remain host-owned. Run `openclaw doctor --fix` after adding explicit summary model overrides if you want OpenClaw to add the matching `plugins.entries.lossless-claw.llm` policy.

### Recommended starting configuration

```
LCM_FRESH_TAIL_COUNT=64
LCM_LEAF_CHUNK_TOKENS=20000
LCM_INCREMENTAL_MAX_DEPTH=1
LCM_CONTEXT_THRESHOLD=0.75
LCM_SUMMARY_MODEL=openai/gpt-5.4-mini
LCM_EXPANSION_MODEL=openai/gpt-5.4-mini
```

- **freshTailCount=64** protects the last 64 messages from compaction, giving the model more recent context for continuity.
- **leafChunkTokens=20000** limits how large each leaf compaction chunk can grow before LCM summarizes it. Increase this when your summary provider is quota-limited and frequent leaf compactions are exhausting that quota.
- **incrementalMaxDepth=1** runs one condensed pass after each leaf compaction by default. Set to `0` for leaf-only behavior, a larger positive integer for a deeper cap, or `-1` for unlimited cascading.
- **contextThreshold=0.75** triggers compaction when context reaches 75% of the model's window, leaving headroom for the model's response.
- **contextThresholdOverrides** optionally picks a different threshold for matching model ids, model context-window ranges, or session patterns. If no rule matches, LCM falls back to `contextThreshold`.

### Session exclusion patterns

### Session reset semantics

Lossless-claw distinguishes OpenClaw's two session-reset commands:

- `/new` keeps the active conversation row and all stored summaries, but prunes `context_items` so the next turn rebuilds context from retained summaries instead of the fresh tail.
- `/reset` archives the active conversation row and creates a new active row for the same stable `sessionKey`, giving the next turn a clean LCM conversation while preserving prior history.

For large sessions, neither command is a perfect “keep my live agent context, but stop writing into this giant active LCM row” tool:

- `/new` keeps writing into the same active LCM conversation row.
- `/reset` changes OpenClaw session flow, which is heavier than users often want when their real problem is just LCM row size.

`/lossless rotate` fills that gap. Before trimming the transcript, it forces leaf-only compaction for raw context outside the preserved live tail so older transcript messages are represented by LCM summaries. It then replaces one rolling `rotate-latest` SQLite backup, rewrites the current session transcript down to the preserved live tail plus current session settings, and refreshes the bootstrap frontier on the same active LCM conversation so dropped transcript history is not replayed. Existing durable messages, summaries, context items, and conversation identity stay in place; only the transcript backing is compacted. If you want additional timestamped snapshots instead, run `/lossless backup`.

`newSessionRetainDepth` (or `LCM_NEW_SESSION_RETAIN_DEPTH`) controls how much summary structure survives `/new`:

- `-1`: keep all existing context items
- `0`: keep all summaries, drop only fresh-tail messages
- `1`: keep d1+ summaries
- `2`: keep d2+ summaries; recommended default
- `3+`: keep only deeper, more abstract summaries

Lossless-claw applies `/new` pruning through `before_reset` and uses `session_end` to catch transcript rollovers such as `/reset`, idle or daily session rotation, compaction session replacement, and deletions. User-facing confirmation text after `/new` or `/reset` must still be emitted by OpenClaw's command handlers.

Use `ignoreSessionPatterns` or `LCM_IGNORE_SESSION_PATTERNS` to keep low-value sessions completely out of LCM. Matching sessions do not create conversations, do not store messages, and do not participate in compaction or delegated expansion grants.

Cron scheduler keys (`agent:<agent>:cron:<job>...`) are isolated automatically when OpenClaw reuses the same `sessionKey` for a new runtime `sessionId`: lossless-claw archives the prior active run and creates a fresh LCM conversation for the new run. Leave cron sessions out of `ignoreSessionPatterns` when they need in-run LCM compaction.

Pattern rules:

- `*` matches any characters except `:`
- `**` matches anything, including `:`
- Patterns match the full session key

Examples:

- `agent:*:cron:**` excludes cron sessions for any agent when you want to bypass LCM entirely
- `agent:*:**:active-memory:**` excludes active-memory sessions under nested session-key prefixes; the `**` segment is intentionally broad because it spans colon-separated session-key segments
- `agent:*:dreaming-narrative-**` excludes OpenClaw memory-core dreaming narrative sessions; OpenClaw builds those keys with the `dreaming-narrative-` prefix ([source](https://github.com/openclaw/openclaw/blob/b81666ca6af25c86cc099983a4358cdc5ea9ced8/extensions/memory-core/src/dreaming-narrative.ts))
- `agent:main:subagent:**` excludes all main-agent subagent sessions
- `agent:ops:**` excludes every session under the `ops` agent id

Treat these examples as storage exclusions. Matching sessions do not create LCM conversation rows or store messages in LCM, so use them only for lanes whose history can stay outside LCM.

Environment variable example:

```bash
LCM_IGNORE_SESSION_PATTERNS=agent:*:cron:**,agent:main:subagent:**
```

Plugin config example:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "config": {
          "ignoreSessionPatterns": [
            "agent:*:cron:**",
            "agent:main:subagent:**"
          ]
        }
      }
    }
  }
}
```

### Stateless session patterns

Use `statelessSessionPatterns` or `LCM_STATELESS_SESSION_PATTERNS` for sessions that should still be able to read from existing LCM context, but should never create or mutate LCM state themselves. This is useful for delegated or temporary sub-agent sessions that should benefit from retained context without polluting the database.

When `skipStatelessSessions` or `LCM_SKIP_STATELESS_SESSIONS` is enabled, matching sessions:

- skip bootstrap imports
- skip message persistence during ingest and after-turn hooks
- skip compaction writes and delegated expansion grant writes
- can still assemble context from already-persisted conversations when a matching conversation exists

Pattern rules are the same as `ignoreSessionPatterns`, and matching is done against the full session key.

Environment variable example:

```bash
LCM_STATELESS_SESSION_PATTERNS=agent:*:subagent:**,agent:ops:subagent:**
LCM_SKIP_STATELESS_SESSIONS=true
```

Plugin config example:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "config": {
          "statelessSessionPatterns": [
            "agent:*:subagent:**",
            "agent:ops:subagent:**"
          ],
          "skipStatelessSessions": true
        }
      }
    }
  }
}
```

### OpenClaw session reset settings

LCM preserves history through compaction, but it does **not** change OpenClaw's core session reset policy. If sessions are resetting sooner than you want, increase OpenClaw's `session.reset.idleMinutes` or use a channel/type-specific override.

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

- `session.reset.mode: "idle"` keeps a session alive until the idle window expires.
- `session.reset.idleMinutes` is the actual reset interval in minutes.
- OpenClaw does **not** currently enforce a maximum `idleMinutes`; in source it is validated only as a positive integer.
- If you also use daily reset mode, `idleMinutes` acts as a secondary guard and the session resets when **either** the daily boundary or the idle window is reached first.
- Legacy `session.idleMinutes` still works, but OpenClaw prefers `session.reset.idleMinutes`.

Useful values:

- `1440` = 1 day
- `10080` = 7 days
- `43200` = 30 days
- `525600` = 365 days

For most long-lived LCM setups, a good starting point is:

```json
{
  "session": {
    "reset": {
      "mode": "idle",
      "idleMinutes": 10080
    }
  }
}
```

## Documentation

- [Configuration guide](docs/configuration.md)
- [Architecture](docs/architecture.md)
- [Agent tools](docs/agent-tools.md)
- [TUI Reference](docs/tui.md)
- [lcm-tui](tui/README.md)
- [Optional: enable FTS5 for fast full-text search](docs/fts5.md)

## Development

```bash
# Build (bundles TypeScript to dist/index.js)
pnpm build

# Run tests
npx vitest

# Type check
npx tsc --noEmit

# Run a specific test file
npx vitest test/engine.test.ts
```

### Project structure

```
index.ts                    # Plugin entry point and registration
src/
  engine.ts                 # LcmContextEngine — implements ContextEngine interface
  assembler.ts              # Context assembly (summaries + messages → model context)
  compaction.ts             # CompactionEngine — leaf passes, condensation, sweeps
  summarize.ts              # Depth-aware prompt generation and LLM summarization
  retrieval.ts              # RetrievalEngine — grep, describe, expand operations
  expansion.ts              # DAG expansion logic for lcm_expand_query
  expansion-auth.ts         # Delegation grants for sub-agent expansion
  expansion-policy.ts       # Depth/token policy for expansion
  large-files.ts            # File interception, storage, and exploration summaries
  transcript-repair.ts      # Tool-use/result pairing sanitization
  types.ts                  # Core type definitions (dependency injection contracts)
  openclaw-bridge.ts        # Bridge utilities
  db/
    config.ts               # LcmConfig resolution from env vars
    connection.ts           # SQLite connection management
    migration.ts            # Schema migrations
  store/
    conversation-store.ts   # Message persistence and retrieval
    summary-store.ts        # Summary DAG persistence and context item management
    fts5-sanitize.ts        # FTS5 query sanitization
  tools/
    lcm-grep-tool.ts        # lcm_grep tool implementation
    lcm-describe-tool.ts    # lcm_describe tool implementation
    lcm-expand-tool.ts      # lcm_expand tool (sub-agent only)
    lcm-expand-query-tool.ts # lcm_expand_query tool (main agent wrapper)
    lcm-conversation-scope.ts # Conversation scoping utilities
    common.ts               # Shared tool utilities
test/                       # Vitest test suite
specs/                      # Design specifications
openclaw.plugin.json        # Plugin manifest with config schema and UI hints
tui/                        # Interactive terminal UI (Go)
  main.go                   # Entry point and bubbletea app
  data.go                   # Data loading and SQLite queries
  dissolve.go               # Summary dissolution
  repair.go                 # Corrupted summary repair
  rewrite.go                # Summary re-summarization
  transplant.go             # Cross-conversation DAG copy
  prompts/                  # Depth-aware prompt templates
.goreleaser.yml             # GoReleaser config for TUI binary releases
```

### Line endings

This repository codifies LF line endings through `.gitattributes` so diffs stay
stable across macOS, Linux, and Windows development environments.

- Git should store text files with LF endings in the repository.
- The root `* text=auto eol=lf` rule normalizes newly added text files.
- Common source, documentation, lockfile, template, and config extensions are
  listed explicitly so contributors and tooling see the expected policy.
- Binary assets and SQLite/database files are marked `binary` to avoid unsafe
  newline conversion.
- If your editor or operating system prefers CRLF locally, keep the repository
  rules authoritative and avoid committing CRLF-only rewrites.
- After changing line-ending rules, prefer a focused normalization commit so
  future functional changes remain easy to review.

## Security

Please report suspected vulnerabilities privately. See [SECURITY.md](SECURITY.md)
for the supported disclosure process and response expectations.

## License

MIT
