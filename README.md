# lossless-claw

Lossless Context Management plugin for [OpenClaw](https://github.com/openclaw/openclaw), based on the [LCM paper](https://papers.voltropy.com/LCM) from [Voltropy](https://x.com/Voltropy). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

## Table of contents

- [What it does](#what-it-does)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Documentation](#documentation)
- [Development](#development)
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

## Quick start

### Prerequisites

- OpenClaw with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)

### Install the plugin

Use OpenClaw's plugin installer (recommended):

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

If you're running from a local OpenClaw checkout, use:

```bash
pnpm openclaw plugins install @martian-engineering/lossless-claw
```

For local plugin development, link your working copy instead of copying files:

```bash
openclaw plugins install --link /path/to/lossless-claw
# or from a local OpenClaw checkout:
# pnpm openclaw plugins install --link /path/to/lossless-claw
```

The install command records the plugin, enables it, and applies compatible slot selection (including `contextEngine` when applicable).

> **Note:** If your OpenClaw config uses `plugins.allow`, make sure both `lossless-claw` and any active plugins you rely on remain allowlisted. In some setups, narrowing the allowlist can prevent plugin-backed integrations from loading, even if `lossless-claw` itself is installed correctly. Restart the gateway after plugin config changes.

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
        "config": {
          "freshTailCount": 32,
          "contextThreshold": 0.75,
          "incrementalMaxDepth": -1,
          "ignoreSessionPatterns": [
            "agent:*:cron:**"
          ],
          "summaryModel": "anthropic/claude-haiku-4-5",
          "expansionModel": "anthropic/claude-haiku-4-5"
        }
      }
    }
  }
}
```

`summaryModel` and `summaryProvider` let you pin compaction summarization to a cheaper or faster model than your main OpenClaw session model. `expansionModel` does the same for `lcm_expand_query` sub-agent calls (drilling into summaries to recover detail). When unset, both fall back to OpenClaw's configured default model/provider. See [Expansion model override requirements](#expansion-model-override-requirements) for the required `subagent` trust policy when using `expansionModel`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `LCM_IGNORE_SESSION_PATTERNS` | `""` | Comma-separated glob patterns for session keys to exclude from LCM storage |
| `LCM_STATELESS_SESSION_PATTERNS` | `""` | Comma-separated glob patterns for session keys that may read from LCM but never write to it |
| `LCM_SKIP_STATELESS_SESSIONS` | `true` | Enable stateless-session write skipping for matching session keys |
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0–1.0) |
| `LCM_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `LCM_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `LCM_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `LCM_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes (0 = leaf only, -1 = unlimited) |
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
| `LCM_EXPANSION_MODEL` | *(from OpenClaw)* | Model override for `lcm_expand_query` sub-agent (e.g. `anthropic/claude-haiku-4-5`) |
| `LCM_EXPANSION_PROVIDER` | *(from OpenClaw)* | Provider override for `lcm_expand_query` sub-agent |
| `LCM_AUTOCOMPACT_DISABLED` | `false` | Disable automatic compaction after turns |
| `LCM_PRUNE_HEARTBEAT_OK` | `false` | Retroactively delete `HEARTBEAT_OK` turn cycles from LCM storage |

### Expansion model override requirements

If you want `lcm_expand_query` to run on a dedicated model via `expansionModel` or `LCM_EXPANSION_MODEL`, OpenClaw must explicitly trust the plugin to request sub-agent model overrides.

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

Plugin config equivalents:

- `ignoreSessionPatterns`
- `statelessSessionPatterns`
- `skipStatelessSessions`
- `summaryModel`
- `summaryProvider`

Environment variables still win over plugin config when both are set.

### Summary model priority

For compaction summarization, lossless-claw resolves the model in this order:

1. `LCM_SUMMARY_MODEL` / `LCM_SUMMARY_PROVIDER`
2. Plugin config `summaryModel` / `summaryProvider`
3. OpenClaw's default compaction model/provider
4. Legacy per-call model/provider hints

If `summaryModel` already includes a provider prefix such as `anthropic/claude-sonnet-4-20250514`, `summaryProvider` is ignored for that choice. Otherwise, the provider falls back to the matching override, then `OPENCLAW_PROVIDER`, then the provider inferred by the caller.

### Recommended starting configuration

```
LCM_FRESH_TAIL_COUNT=32
LCM_INCREMENTAL_MAX_DEPTH=-1
LCM_CONTEXT_THRESHOLD=0.75
```

- **freshTailCount=32** protects the last 32 messages from compaction, giving the model enough recent context for continuity.
- **incrementalMaxDepth=-1** enables unlimited automatic condensation after each compaction pass — the DAG cascades as deep as needed. Set to `0` (default) for leaf-only, or a positive integer for a specific depth cap.
- **contextThreshold=0.75** triggers compaction when context reaches 75% of the model's window, leaving headroom for the model's response.

### Session exclusion patterns

Use `ignoreSessionPatterns` or `LCM_IGNORE_SESSION_PATTERNS` to keep low-value sessions completely out of LCM. Matching sessions do not create conversations, do not store messages, and do not participate in compaction or delegated expansion grants.

Pattern rules:

- `*` matches any characters except `:`
- `**` matches anything, including `:`
- Patterns match the full session key

Examples:

- `agent:*:cron:**` excludes cron sessions for any agent, including isolated run sessions like `agent:main:cron:daily-digest:run:run-123`
- `agent:main:subagent:**` excludes all main-agent subagent sessions
- `agent:ops:**` excludes every session under the `ops` agent id

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
  integrity.ts              # DAG integrity checks and repair utilities
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

## License

MIT
