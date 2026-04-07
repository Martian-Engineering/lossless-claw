# Configuration guide

## Quick start

Install the plugin with OpenClaw's plugin installer:

```bash
openclaw plugins install @martian-engineering/lossless-claw
```

If you're running from a local OpenClaw checkout:

```bash
pnpm openclaw plugins install @martian-engineering/lossless-claw
```

For local development of this plugin, link your working copy:

```bash
openclaw plugins install --link /path/to/lossless-claw
```

`openclaw plugins install` handles plugin registration/enabling and slot selection automatically.

Set recommended environment variables:

```bash
export LCM_FRESH_TAIL_COUNT=32
export LCM_NEW_SESSION_RETAIN_DEPTH=2
export LCM_INCREMENTAL_MAX_DEPTH=-1
```

Restart OpenClaw.

## Tuning guide

### Context threshold

`LCM_CONTEXT_THRESHOLD` (default `0.75`) controls when compaction triggers as a fraction of the model's context window.

- **Lower values** (e.g., 0.5) trigger compaction earlier, keeping context smaller but doing more LLM calls for summarization.
- **Higher values** (e.g., 0.85) let conversations grow longer before compacting, reducing summarization cost but risking overflow with large model responses.

For most use cases, 0.75 is a good balance.

### Fresh tail count

`LCM_FRESH_TAIL_COUNT` (default `64`) is the number of most recent messages that are never compacted. These raw messages give the model immediate conversational continuity.

- **Smaller values** (e.g., 8–16) save context space for summaries but may lose recent nuance.
- **Larger values** (e.g., 32–64) give better continuity at the cost of a larger mandatory context floor.

For coding conversations with tool calls (which generate many messages per logical turn), 32 is recommended.

### /new retain depth

`LCM_NEW_SESSION_RETAIN_DEPTH` (default `2`) controls what survives OpenClaw's `/new` command.

- `-1` keeps all existing context items, making `/new` a transcript-only reset from lossless-claw's perspective.
- `0` drops only fresh-tail message items and keeps all summaries.
- `1` drops d0 summaries and keeps d1+.
- `2` drops d0 and d1 summaries, keeping d2+ project-arc context. This is the recommended default.
- `3+` keeps only deeper, more abstract summaries.

`/new` never deletes the summaries themselves. It only prunes `context_items`, so the summary DAG remains available for later retrieval and expansion.

### Leaf fanout

`LCM_LEAF_MIN_FANOUT` (default `8`) is the minimum number of raw messages that must be available outside the fresh tail before a leaf pass runs.

- Lower values create summaries more frequently (more, smaller summaries).
- Higher values create larger, more comprehensive summaries less often.

### Condensed fanout

`LCM_CONDENSED_MIN_FANOUT` (default `4`) controls how many same-depth summaries accumulate before they're condensed into a higher-level summary.

- Lower values create deeper DAGs with more levels of abstraction.
- Higher values keep the DAG shallower but with more nodes at each level.

### Incremental max depth

`LCM_INCREMENTAL_MAX_DEPTH` (default `1`) controls whether condensation happens automatically after leaf passes.

- **0** — Only leaf summaries are created incrementally. Condensation only happens during manual `/compact` or overflow.
- **1** — After each leaf pass, attempt to condense d0 summaries into d1.
- **2+** — Deeper automatic condensation up to the specified depth.
- **-1** — Unlimited depth. Condensation cascades as deep as needed after each leaf pass. Recommended for long-running sessions.

### Summary target tokens

`LCM_LEAF_TARGET_TOKENS` (default `2400`) and `LCM_CONDENSED_TARGET_TOKENS` (default `2000`) control the target size of generated summaries.

- Larger targets preserve more detail but consume more context space.
- Smaller targets are more aggressive, losing detail faster.

The actual summary size depends on the LLM's output; these values are guidelines passed in the prompt's token target instruction.

### Leaf chunk tokens

`LCM_LEAF_CHUNK_TOKENS` (default `20000`) caps the amount of source material per leaf compaction pass.

- Larger chunks create more comprehensive summaries from more material.
- Smaller chunks create summaries more frequently from less material.
- This also affects the condensed minimum input threshold (10% of this value).

### Maximum assembly token budget

`LCM_MAX_ASSEMBLY_TOKEN_BUDGET` (default: none) caps the token budget used for context assembly and compaction threshold evaluation. When set, this takes precedence over both the 128k fallback and runtime-provided budgets.

Set this if you're using a model with a smaller context window:

- **8k models:** `LCM_MAX_ASSEMBLY_TOKEN_BUDGET=7000`
- **32k models:** `LCM_MAX_ASSEMBLY_TOKEN_BUDGET=30000`
- **128k+ models:** No need to set (128k fallback is appropriate)

### Summary size cap

`LCM_SUMMARY_MAX_OVERAGE_FACTOR` (default: `3`) controls the hard ceiling on summary sizes relative to the target tokens (`leafTargetTokens` for leaf summaries, `condensedTargetTokens` for condensed summaries).

If a summary exceeds `overage_factor * target_tokens`, it is deterministically truncated. A warning is logged when any summary exceeds `1.5 * target_tokens`.

- **Lower values** (e.g., 2) enforce tighter summaries but may truncate more often with weaker summarizer models.
- **Higher values** (e.g., 5) allow more LLM flexibility but risk storing oversized summaries.

## Model selection

LCM uses the same model as the parent OpenClaw session for summarization by default. You can override this:

```bash
# Use a specific model for summarization
export LCM_SUMMARY_MODEL=anthropic/claude-sonnet-4-20250514
export LCM_SUMMARY_PROVIDER=anthropic
export LCM_SUMMARY_BASE_URL=https://api.anthropic.com
```

Using a cheaper/faster model for summarization can reduce costs, but quality matters — poor summaries compound as they're condensed into higher-level nodes.

When more than one source is present, compaction summarization resolves in this order:

1. `LCM_SUMMARY_MODEL` / `LCM_SUMMARY_PROVIDER`
2. Plugin config `summaryModel` / `summaryProvider`
3. OpenClaw's default compaction model/provider
4. Legacy per-call model/provider hints

If `summaryModel` already includes a provider prefix such as `anthropic/claude-sonnet-4-20250514`, `summaryProvider` is ignored for that choice.

For delegated `lcm_expand_query` runs, you can extend the sub-agent wait window with `delegationTimeoutMs` (plugin config) or `LCM_DELEGATION_TIMEOUT_MS` (environment variable). The default is `120000` milliseconds.

## Session controls

### Excluding sessions entirely

### `/new` vs `/reset`

Lossless-claw treats the two OpenClaw reset commands differently:

- `/new` keeps the active LCM conversation and prunes active context according to `newSessionRetainDepth`.
- `/reset` archives the active conversation row and creates a fresh active row for the same stable `sessionKey`.

This preserves lossless history while still giving users a real clean-slate command.
Lossless-claw applies `/new` through `before_reset`, then uses `session_end` to catch the broader rollover cases OpenClaw can emit: `/reset`, idle or daily session rotation, compaction-driven session replacement, and deletions. OpenClaw's command handlers still own the user-facing post-command disclosure text.

Use `ignoreSessionPatterns` or `LCM_IGNORE_SESSION_PATTERNS` to keep low-value sessions completely out of LCM. Matching sessions do not create conversations, do not store messages, and do not participate in compaction or delegated expansion grants.

- Matching uses the full session key.
- `*` matches any characters except `:`.
- `**` matches anything, including `:`.

Example:

```bash
export LCM_IGNORE_SESSION_PATTERNS=agent:*:cron:**,agent:main:subagent:**
```

### Stateless sessions

Use `statelessSessionPatterns` or `LCM_STATELESS_SESSION_PATTERNS` for sessions that should be able to read from LCM without writing to it. This is especially useful for sub-agent sessions, which use real OpenClaw keys like `agent:<agentId>:subagent:<uuid>`.

Enable enforcement with `skipStatelessSessions` or `LCM_SKIP_STATELESS_SESSIONS=true`.

When a session key matches a stateless pattern and enforcement is enabled, LCM will:

- skip bootstrap imports
- skip ingest and after-turn persistence
- skip compaction writes
- skip delegated expansion grant writes
- still allow read-side assembly from existing persisted context

Example:

```bash
export LCM_STATELESS_SESSION_PATTERNS=agent:*:subagent:**,agent:ops:subagent:**
export LCM_SKIP_STATELESS_SESSIONS=true
```

Plugin config example:

```json
{
  "plugins": {
    "entries": {
      "lossless-claw": {
        "config": {
          "ignoreSessionPatterns": [
            "agent:*:cron:**"
          ],
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

## TUI conversation window size

`LCM_TUI_CONVERSATION_WINDOW_SIZE` (default `200`) controls how many messages `lcm-tui` loads per keyset-paged conversation window when a session has an LCM `conversation_id`.

- Smaller values reduce render/query cost for very large conversations.
- Larger values show more context per page but increase render time.

## Database management

The SQLite database lives at `LCM_DATABASE_PATH` (default `~/.openclaw/lcm.db`). 

### Inspecting the database

```bash
sqlite3 ~/.openclaw/lcm.db

# Count conversations
SELECT COUNT(*) FROM conversations;

# See context items for a conversation
SELECT * FROM context_items WHERE conversation_id = 1 ORDER BY ordinal;

# Check summary depth distribution
SELECT depth, COUNT(*) FROM summaries GROUP BY depth;

# Find large summaries
SELECT summary_id, depth, token_count FROM summaries ORDER BY token_count DESC LIMIT 10;
```

### Backup

The database is a single file. Back it up with:

```bash
cp ~/.openclaw/lcm.db ~/.openclaw/lcm.db.backup
```

Or use SQLite's online backup:

```bash
sqlite3 ~/.openclaw/lcm.db ".backup ~/.openclaw/lcm.db.backup"
```

## Per-agent configuration

In multi-agent OpenClaw setups, each agent uses the same LCM database but has its own conversations (keyed by session ID). The plugin config applies globally; per-agent overrides use environment variables set in the agent's config.

## Disabling LCM

To fall back to OpenClaw's built-in compaction:

```json
{
  "plugins": {
    "slots": {
      "contextEngine": "legacy"
    }
  }
}
```

Or set `LCM_ENABLED=false` to disable the plugin while keeping it registered.

## Cache-aware compaction tuning

Two settings control when leaf compaction skips to preserve prompt cache stability:

### Skip reduction threshold

`LCM_LEAF_SKIP_REDUCTION_THRESHOLD` (default `0.05`, plugin config: `leafSkipReductionThreshold`)

Minimum estimated per-pass token reduction as a fraction of total assembled context. When the reduction is too small relative to total context, compaction is skipped because the prompt cache invalidation cost exceeds the token savings.

- **Lower values** (e.g., 0.02) allow more compaction events — good for expensive models (Opus) where carrying extra tokens is costly.
- **Higher values** (e.g., 0.10) are more conservative — good for short sessions or cheap models where cache stability matters more.
- **Set to 0** to disable the cache-aware skip entirely.

### Budget headroom factor

`LCM_LEAF_BUDGET_HEADROOM_FACTOR` (default `0.8`, plugin config: `leafBudgetHeadroomFactor`)

Skip leaf compaction when assembled tokens are below `factor x contextThreshold x tokenBudget`. When there is ample budget headroom, compaction provides no urgency and only risks cache instability.

- **Lower values** (e.g., 0.45) start compacting earlier — important for expensive models where every token costs more.
- **Higher values** (e.g., 0.90) delay compaction longer — good for cheap models where carrying extra context is acceptable.
- **Set to 0** to disable headroom check entirely. Note: this also disables budget pressure detection, so the cache-aware skip becomes the only guard.

When assembled tokens reach or exceed the headroom ceiling, **budget pressure** is detected and compaction fires unconditionally, overriding the cache-aware skip.

### Compaction model selection

`LCM_SUMMARY_MODEL` / `LCM_SUMMARY_PROVIDER` — The model used for summarization during compaction.

**Use fast, non-thinking models.** Compaction runs synchronously during full sweeps and can stall the gateway. Recommended:

| Model | Cost/call | Context | Notes |
|-------|-----------|---------|-------|
| `gpt-4o-mini` | ~$0.004 | 128K | Cheapest, auto caching |
| `mistral-small-4` | ~$0.004 | 256K | Same price, bigger context |
| `deepseek-v3` | ~$0.007 | 164K | 90% auto cache |
| `gemini-2.5-flash` | ~$0.012 | 1M | Fastest, 90% cache |
| `claude-haiku-4-5` | ~$0.032 | 200K | Best Anthropic option |

> The compaction model only processes the chunk (~20-35K tokens), not the full conversation. A 128K model works fine at default settings.

**Never use** Opus, o3, or thinking models for compaction — they add 3-30s per call with no summary quality benefit, and can cause 2-minute typing timeouts.

### Per-model-tier presets

See the [Compaction Tuning Guide](compaction-tuning.md) for detailed per-tier configurations with economics analysis.
