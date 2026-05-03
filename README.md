# lossless-claw

Lossless Context Management plugin for [OpenClaw](https://github.com/openclaw/openclaw), based on the [LCM paper](https://papers.voltropy.com/LCM) from [Voltropy](https://x.com/Voltropy). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

## Table of contents

- [What it does](#what-it-does)
- [Compaction pressure architecture](#compaction-pressure-architecture)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [Commands And Skill](#commands-and-skill)
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

## Compaction pressure architecture

LCM operates as a **layered four-band system** keyed off prompt pressure
(current tokens / effective budget). Each band has its own dispatch policy,
and they compose so the prompt never approaches runtime overflow under
normal operation.

The plugin uses three composing capabilities:

1. **Reserve-aware budget alignment** — LCM reads `runtimeContext.reserveTokens`
   and subtracts it from the resolved budget so every percentage threshold
   computes against the EFFECTIVE prompt budget (the same number the runtime
   actually overflows at), not the raw context window.
2. **Decoupled sweep trigger + target** — `sweepTriggerThreshold` (default
   0.91) controls when sweep MODE fires; `sweepTargetThreshold` (default 0.50)
   controls where the sweep STOPS. Below the sweep trigger, dispatched
   compaction targets `contextThreshold` instead.
3. **Pressure-tiered pass cap** — `pressureTiers` (default
   `[{ratio:0.70,maxPasses:2},{ratio:0.80,maxPasses:3}]`) ladder lets each
   dispatch run more sequential passes as pressure rises, exploiting the
   fact that cache invalidation is a per-dispatch fixed cost (not per-pass).

The `criticalBudgetPressureRatio` knob (default 0.70) on `cacheAwareCompaction`
lines up with the tier-1 ratio so dispatched work fires reliably the moment
the system enters tier-1 instead of being cache-throttled up to 5 minutes per
dispatch.

```
        effective prompt budget = tokenBudget − reserveTokens
        ┌────────────────────────────────────────────────────────────┐
0%    60%/trigger  70%/tier-1  80%/tier-2  91%/sweep        100%/overflow
├─────┼────────────┼───────────┼───────────┼──────────────────────────┤
│ low │  normal    │  tier-1   │  tier-2   │   SWEEP                   │
│     │  1 pass /  │  2 passes │  3 passes │   (unlimited passes,      │
│     │  dispatch  │  / disp.  │  / disp.  │    target 50%)            │
│     │  exit @60% │  exit @60%│  exit @60%│   exit @ 50% of budget    │
└─────┴────────────┴───────────┴───────────┴──────────────────────────┘
                   ↑           ↑           ↑                           ↑
                   tier-1      tier-2      sweepTriggerThreshold       runtime
                   (cache-aware                                        emergency
                   bypass also                                         truncation
                   activates here                                      (last resort)
                   via PR #557's
                   0.70 default)
```

| Band | Range | Action | Config knob |
|---|---|---|---|
| **Low** | 0–60% | nothing fires | `contextThreshold` (default 0.60) |
| **Normal** | 60–70% | maintenance debt queued; 1 pass per dispatch (cache-aware throttled, defers up to 5 min if cache hot) | `contextThreshold` |
| **Tier 1** | 70–80% | 2 passes per dispatch, cache-aware delay bypassed | `pressureTiers[0]` + `cacheAwareCompaction.criticalBudgetPressureRatio` (0.70) |
| **Tier 2** | 80–91% | 3 passes per dispatch, cache-aware delay bypassed | `pressureTiers[1]` |
| **Sweep** | ≥91% | unlimited passes, target `sweepTargetThreshold` (50%) — heavy catch-up, creates ~5+ turns of runway | `sweepTriggerThreshold` + `sweepTargetThreshold` |
| **Overflow** | ≥100% | runtime emergency `truncate_tool_results_only` (openclaw side, last resort) | runtime config |

### Why this layering?

**Hidden insight: cache invalidation is a per-dispatch fixed cost, not per-pass.**
When LCM compacts the oldest chunk, the prefix cache breaks at the modification
point and everything from there to the end of the prompt must re-tokenize on
the next turn. Doing 1 pass vs 3 passes vs 6 passes invalidates the SAME prefix
— more passes just produce more reduction off that one cache break. This means
multi-pass dispatch is the right shape at higher pressure, not "fire more
often" (which would multiply cache invalidations).

| Tier | Passes | Cache cost | Reduction per dispatch | Efficiency |
|---|---|---|---|---|
| Normal (1 pass) | 1 | 1× | ~17K | 17K / cache-break |
| Tier 1 (2 passes) | 2 | 1× | ~34K | 34K / cache-break ← 2× |
| Tier 2 (3 passes) | 3 | 1× | ~51K | 51K / cache-break ← 3× |
| Sweep (unlimited) | 5–7 | 1× | ~80K–100K | huge / cache-break |

### Why decouple sweep trigger from sweep target?

Pre-2026, the sweep loop exited at `contextThreshold` (the same threshold that
TRIGGERED it). With both at 0.75, sweep ran one or two passes (just enough to
drop back below the trigger line) and then exited — no headroom created. The
next turn pushed the prompt back over the trigger, sweep ran again, exited
again. Worst of both worlds: sweep fires often and barely does any work.

Decoupling the target (now 0.50 by default) AND adding a separate
`sweepTriggerThreshold` (0.91) means:

- Below 91%: dispatched work targets `contextThreshold` (gentle, doesn't
  overshoot)
- At ≥91%: sweep mode targets 50% — creates real multi-turn runway (~5+ turns
  of buffer) before another trigger
- Sweep becomes RARE because the headroom it creates absorbs ongoing input
- Most turns are handled by the tier ladder without sweep ever needing to fire

### Reserve-aware budget alignment

LCM reads `runtimeContext.reserveTokens` (or the legacy `reserveTokensFloor`
key) and subtracts it from the resolved `tokenBudget` before computing
percentages. This way every threshold computes against the EFFECTIVE prompt
budget — the same number the runtime actually overflows at — instead of the
raw context window.

| Without reserve alignment | With reserve alignment (default behavior) |
|---|---|
| Runtime: gpt-5.5 with 258K context, 20K reserve → overflow at 238K | Runtime: same |
| LCM gets `tokenBudget = 258K`, all percentages computed against 258K | LCM gets `tokenBudget = 258K`, subtracts 20K reserve → percentages computed against 238K |
| 60% trigger fires at 155K (65% of effective 238K) | 60% trigger fires at 143K (60% of effective) ✓ |
| 91% sweep target lands at 235K (99% — almost overflowing) | 91% sweep target lands at 217K (91% of effective) ✓ |

If your runtime doesn't pass `reserveTokens` (or the legacy `reserveTokensFloor`
key), LCM falls back to the legacy behavior (raw budget, no subtraction) for
backward compatibility.

### Recommended openclaw operator config

```json
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard",
        "reserveTokensFloor": 20000
      }
    }
  },
  "plugins": {
    "slots": { "contextEngine": "lossless-claw" },
    "entries": {
      "lossless-claw": {
        "config": {
          "contextThreshold": 0.60,
          "sweepTargetThreshold": 0.50,
          "sweepTriggerThreshold": 0.91,
          "pressureTiers": [
            { "ratio": 0.70, "maxPasses": 2 },
            { "ratio": 0.80, "maxPasses": 3 }
          ],
          "cacheAwareCompaction": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

All values shown are the new defaults — operators only need to set them
explicitly to override.

**Why `reserveTokensFloor: 20000`:** the openclaw default. Operators sometimes
raise it when hitting overflow due to cache-aware throttling (addressed by PR
#557). With reserve-aware alignment in place, 20K leaves the LCM percentages
well-aligned with the runtime overflow point and remains enough headroom for
any normal model response.

### Scenario walkthrough — real session data

Real Eva session on gpt-5.5 (258K context, 20K reserve = 238K effective budget)
before any patches:

| Time | Prompt | LCM% (vs 258K raw) | Runtime% (vs 238K effective) | What fired |
|---|---|---|---|---|
| (steady state) | 180K | 70% | 76% | LCM saw "70%" — quiet; runtime was actually at 76% — under pressure |
| (after a tool burst) | 219K | 85% | **92%** | LCM still saw "below 85%" — never fired; **runtime emergency** truncated 132 tool results |
| (continued growth) | 227K | 88% | **95%** | LCM finally fired (cache went cold), 12 leaves, brought to 207K (still over runtime) |

With the architecture above (recommended defaults):

| Eva crosses... | Tier | Pass count | Action | Result |
|---|---|---|---|---|
| 143K (60% of 238K) | Normal | 1 | Maintenance debt queued, fires when cache cold | Cache-aware throttled — typically defers |
| 167K (70% of 238K) | Tier 1 | 2 | Cache delay BYPASSED (PR #557), 2 passes per dispatch | ~34K reduction → drops to ~133K |
| 190K (80% of 238K) | Tier 2 | 3 | 3 passes per dispatch | ~51K reduction → drops to ~139K |
| If tier 1+2 fail, crosses 217K (91% of 238K) | **Sweep** | unlimited | Deep catch-up to 50% target (119K) | ~98K reduction → ~5 turns of buffer |
| Effectively NEVER reaches 238K | Overflow | — | — | Runtime emergency essentially never fires |

**Result: 0 emergency truncations** instead of 6 in the same window. Sweep
becomes rare (typically 0–1 per heavy session) because tiers 1+2 absorb most
escalation.

## Commands And Skill

The plugin now ships a bundled `lossless-claw` skill plus a small plugin command surface for supported OpenClaw chat/native command providers:

- `/lcm` shows version, enablement/selection state, DB path and size, summary counts, and summary-health status
- `/lcm backup` creates a timestamped backup of the current LCM SQLite database
- `/lcm rotate` rewrites the active session transcript into a compact tail-preserving form without changing the live OpenClaw session identity or current LCM conversation
- `/lcm doctor` scans for broken or truncated summaries
- `/lcm doctor clean` shows read-only high-confidence junk diagnostics for archived subagents, cron sessions, and NULL-key orphaned subagent runs
- `/lcm status` shows plugin, conversation, and maintenance state including deferred compaction debt
- `/lossless` is an alias for `/lcm` on supported native command surfaces

These are plugin slash/native commands, not root shell CLI subcommands. Supported examples:

- `/lcm`
- `/lcm backup`
- `/lcm rotate`
- `/lcm doctor`
- `/lcm doctor clean`
- `/lossless`

Not currently supported as root CLI commands:

- `openclaw lcm`
- `openclaw lossless`
- `openclaw /lcm`

The bundled skill focuses on configuration, diagnostics, architecture, and recall-tool usage. Its reference set lives under `skills/lossless-claw/references/`.

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
        "config": {
          "freshTailCount": 64,
          "leafChunkTokens": 80000,
          "newSessionRetainDepth": 2,
          "contextThreshold": 0.75,
          "incrementalMaxDepth": 1,
          "cacheAwareCompaction": {
            "enabled": true,
            "cacheTTLSeconds": 300
          },
          "ignoreSessionPatterns": [
            "agent:*:cron:**"
          ],
          "transcriptGcEnabled": false,
          "proactiveThresholdCompactionMode": "deferred",
          "summaryModel": "openai/gpt-5.4-mini",
          "expansionModel": "openai/gpt-5.4-mini",
          "delegationTimeoutMs": 300000,
          "summaryTimeoutMs": 60000
        }
      }
    }
  }
}
```

`leafChunkTokens` controls how many source tokens can accumulate in a leaf compaction chunk before summarization is triggered. The default is `20000`, but quota-limited summary providers may benefit from a larger value to reduce compaction frequency. `summaryModel` and `summaryProvider` let you pin compaction summarization to a cheaper or faster model than your main OpenClaw session model. `expansionModel` does the same for `lcm_expand_query` sub-agent calls (drilling into summaries to recover detail). `delegationTimeoutMs` controls how long `lcm_expand_query` waits for that delegated sub-agent to finish before returning a timeout error; it defaults to `120000` (120s). `summaryTimeoutMs` controls the per-call timeout for model-backed LCM summarization; it defaults to `60000` (60s). When unset, the model settings still fall back to OpenClaw's configured default model/provider. See [Expansion model override requirements](#expansion-model-override-requirements) for the required `subagent` trust policy when using `expansionModel`.

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `LCM_IGNORE_SESSION_PATTERNS` | `""` | Comma-separated glob patterns for session keys to exclude from LCM storage |
| `LCM_STATELESS_SESSION_PATTERNS` | `""` | Comma-separated glob patterns for session keys that may read from LCM but never write to it |
| `LCM_SKIP_STATELESS_SESSIONS` | `true` | Enable stateless-session write skipping for matching session keys |
| `LCM_CONTEXT_THRESHOLD` | `0.60` | Fraction of effective token budget that TRIGGERS compaction (0.0–1.0). Trigger threshold only — sweep target/trigger and pressure tiers are configured separately. The 0.60 default leaves headroom for the cache-aware system to defer normally before tier-1 pressure kicks in. |
| `LCM_SWEEP_TARGET_THRESHOLD` | `0.50` | Fraction of effective token budget that a SWEEP targets when it fires. Sweep mode only fires above `LCM_SWEEP_TRIGGER_THRESHOLD`; below that, dispatched compaction targets `LCM_CONTEXT_THRESHOLD` instead. |
| `LCM_SWEEP_TRIGGER_THRESHOLD` | `0.91` | Fraction of effective token budget at which dispatched compaction switches into deep SWEEP mode. Below this, dispatches use the pressure-tier ladder (1/2/3 passes by tier). Above this, dispatches run unlimited passes targeting `LCM_SWEEP_TARGET_THRESHOLD`. |
| `LCM_PRESSURE_TIERS` | `[{"ratio":0.70,"maxPasses":2},{"ratio":0.80,"maxPasses":3}]` | JSON array of `{ratio, maxPasses}` entries — pressure-tier ladder for dispatched compaction below sweep mode. Each entry caps passes-per-dispatch when current pressure crosses `ratio`. |
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
4. Legacy per-call model/provider hints

If `summaryModel` already includes a provider prefix such as `anthropic/claude-sonnet-4-20250514`, `summaryProvider` is ignored for that choice. Otherwise, the provider falls back to the matching override, then `OPENCLAW_PROVIDER`, then the provider inferred by the caller.

Runtime-managed OAuth providers are supported here too. In particular, `openai-codex` and `github-copilot` auth profiles can be used for summary and expansion calls without a separate API key.

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

### Session exclusion patterns

### Session reset semantics

Lossless-claw distinguishes OpenClaw's two session-reset commands:

- `/new` keeps the active conversation row and all stored summaries, but prunes `context_items` so the next turn rebuilds context from retained summaries instead of the fresh tail.
- `/reset` archives the active conversation row and creates a new active row for the same stable `sessionKey`, giving the next turn a clean LCM conversation while preserving prior history.

For large sessions, neither command is a perfect “keep my live agent context, but stop writing into this giant active LCM row” tool:

- `/new` keeps writing into the same active LCM conversation row.
- `/reset` changes OpenClaw session flow, which is heavier than users often want when their real problem is just LCM row size.

`/lcm rotate` fills that gap. It replaces one rolling `rotate-latest` SQLite backup, rewrites the current session transcript down to the preserved live tail plus current session settings, and refreshes the bootstrap frontier on the same active LCM conversation so dropped transcript history is not replayed. Existing summaries, context items, and conversation identity stay in place; only the transcript backing is compacted. If you want additional timestamped snapshots instead, run `/lcm backup`.

`newSessionRetainDepth` (or `LCM_NEW_SESSION_RETAIN_DEPTH`) controls how much summary structure survives `/new`:

- `-1`: keep all existing context items
- `0`: keep all summaries, drop only fresh-tail messages
- `1`: keep d1+ summaries
- `2`: keep d2+ summaries; recommended default
- `3+`: keep only deeper, more abstract summaries

Lossless-claw applies `/new` pruning through `before_reset` and uses `session_end` to catch transcript rollovers such as `/reset`, idle or daily session rotation, compaction session replacement, and deletions. User-facing confirmation text after `/new` or `/reset` must still be emitted by OpenClaw's command handlers.

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
