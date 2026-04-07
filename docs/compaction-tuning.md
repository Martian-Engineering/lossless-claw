# Compaction Tuning Guide

## TLDR — Quick Setup

Lossless Claw compresses your conversation history into summaries so long sessions don't blow the context window or your API bill. Research shows 20-39% average token reduction for mixed tool-use sessions, with up to 86% for tool-heavy sessions ([arXiv:2602.22402](https://arxiv.org/abs/2602.22402)).

> **Key insight:** The savings come from two places: (1) compaction reduces the tokens sent each turn, and (2) proper tuning avoids unnecessary compaction that would invalidate your prompt cache. On Opus, a single unnecessary cache miss on 150K of cached context costs ~$0.68 — often more than the tokens the compaction would have saved.

**Three things to configure:**

1. **Compaction model** — Use a fast, cheap model. Avoid using your main model when it's expensive or slow.
2. **Skip thresholds** — Prevent unnecessary compaction that wastes your prompt cache.
3. **Chunk size** — How much context to compress per pass.

### Where to put the config

Add these settings to your plugin config in `openclaw.json` under `plugins.entries.lossless-claw.config`, or set them as environment variables prefixed with `LCM_`:

### Copy-paste configs

**Opus 4.6 (1M context, heavy coding)**
```json
{
  "summaryModel": "claude-haiku-4-5",
  "summaryProvider": "anthropic",
  "expansionModel": "claude-haiku-4-5",
  "expansionProvider": "anthropic",
  "leafChunkTokens": 35000,
  "leafSkipReductionThreshold": 0.02,
  "leafBudgetHeadroomFactor": 0.55
}
```

**Sonnet 4.6 (1M context, general use)** — skip thresholds and chunk sizes work well at defaults; just set the compaction model:
```json
{
  "summaryModel": "claude-haiku-4-5",
  "summaryProvider": "anthropic"
}
```

**Haiku 4.5 (quick tasks, 3-10 turns)**
```json
{
  "summaryModel": "claude-haiku-4-5",
  "summaryProvider": "anthropic",
  "leafSkipReductionThreshold": 0.10,
  "leafBudgetHeadroomFactor": 0.90
}
```

**Agent orchestration (main + sub-agents)**
```json
{
  "summaryModel": "claude-sonnet-4-6",
  "summaryProvider": "anthropic",
  "expansionModel": "claude-haiku-4-5",
  "expansionProvider": "anthropic",
  "leafChunkTokens": 25000,
  "leafSkipReductionThreshold": 0.02,
  "leafBudgetHeadroomFactor": 0.60
}
```

### Compaction model: the single most important setting

| Do use | Don't use |
|--------|-----------|
| GPT-4o-mini, Gemini 2.5 Flash, Haiku 4.5, Sonnet 4.6 | Opus 4.6, o3, any "thinking" model |

**Why:** Compaction runs inline during your session. A slow model (Opus at 3-8s/call) stalls your conversation while it works. A fast model (Haiku at 0.3-0.8s/call) finishes before you notice. Compaction is a straightforward extraction task — expensive models don't produce meaningfully better summaries.

### Expansion model: the hidden token cost

When the agent calls `lcm_expand_query` (deep recall from history), LCM spawns a **full sub-agent session** that runs 3-8 turns of grep → describe → expand → synthesize. **By default, this sub-agent uses the same model as your main agent.**

If your main agent runs Opus at $5/MTok, each `lcm_expand_query` call costs **$0.15-0.50** in sub-agent tokens. Over a session with 3-5 expand calls, that's $0.50-2.50 in expansion costs alone — often more than the compaction costs.

**Fix:** Set `expansionModel` to a cheaper model:

```json
{
  "expansionModel": "claude-haiku-4-5",
  "expansionProvider": "anthropic"
}
```

The sub-agent does keyword search and DAG traversal — tasks that don't benefit from expensive models. Haiku handles them well at 5x lower cost.

> **The "80% token savings" claim**: This measures context window reduction from compaction. It does NOT include expansion sub-agent costs or compaction model costs. Total API savings depend on your model choices for all three paths: main agent, compaction model (`summaryModel`), and expansion model (`expansionModel`).

### Verify it's working

After applying the config and restarting, run a session with 10+ turns. Look for `[lcm] afterTurn: leaf compaction triggered` in your logs (stderr). If you see `skipped (budget-headroom: ...)`, the skip guards are active and waiting for budget pressure — this is normal and expected on large-context models.

### Key terms

| Term | Meaning |
|------|---------|
| **Leaf** | A summary created from raw messages (the first compression level) |
| **Condensed** | A summary created from other summaries (higher compression levels) |
| **Fresh tail** | The most recent N messages, always kept raw (never compressed) |
| **Ordinal** | A message's position number in the context sequence |
| **Budget ceiling** | The token threshold where compaction triggers |

---

## How It Works

### The compaction lifecycle

Every conversation turn follows this sequence:

```mermaid
flowchart LR
    A[Message arrives] --> B[Ingest to DB]
    B --> C[Evaluate leaf trigger]
    C -->|Skip| D[Evaluate full threshold]
    C -->|Compact| E[Leaf pass: summarize oldest chunk]
    E --> D
    D -->|Below threshold| F[Done]
    D -->|Over threshold| G[Full sweep: multi-round compaction]
    G --> F
```

1. **Ingest** — New messages are stored in the database and appended to the context item list.
2. **Leaf trigger** — Checks if raw (unsummarized) messages outside the fresh tail (the most recent protected messages) exceed `leafChunkTokens`. If so, evaluates skip guards before compacting.
3. **Full threshold** — Checks if total assembled context exceeds `contextThreshold x tokenBudget`. If so, runs a multi-round full sweep.
4. **Assembly** — When the model needs context, the assembler builds the prompt from summaries + fresh messages, respecting the token budget.

### The summary hierarchy

Messages are compressed into a layered hierarchy of summaries. Each layer compresses further:

```
Raw messages:
  [msg₁] [msg₂] ... [msg₁₀] [msg₁₁] ... [msg₂₀] [msg₂₁] ... [msg₅₀]

After leaf compaction (depth 0):
  [leaf₁: msgs 1-10] [leaf₂: msgs 11-20] [msg₂₁] ... [msg₅₀]
   ~2400 tokens         ~2400 tokens        ├── fresh tail ──┤

After condensation (depth 1):
  [condensed₁: leafs 1-3] [leaf₄] [leaf₅] [msg₄₁] ... [msg₅₀]
   ~2000 tokens             depth=0          ├── fresh tail ──┤
```

A conversation with 100K raw tokens might be represented as 5K of summaries + 20K of fresh messages — a 75% reduction. Research shows 20-86% token reduction depending on session profile, with 39% average for mixed tool-use sessions ([arXiv:2602.22402](https://arxiv.org/abs/2602.22402)).

### Why compaction invalidates the prompt cache

When a leaf pass runs, it:
1. Replaces raw messages (positions 0-9) with a single summary (position 0)
2. Resequences all remaining positions to stay contiguous (0, 1, 2, ...)
3. The assembled prompt changes structure — the API prompt cache prefix no longer matches

**Cache miss cost:** On Opus 4.6, a 150K cached prefix costs $0.50/MTok to read. A cache miss on that prefix costs $5/MTok — a **10x penalty**. One unnecessary compaction can cost $0.68 in a single cache miss.

### Timing: when compaction runs

```
Turn lifecycle:
  1. [instant]  Ingest message to DB
  2. [instant]  Evaluate leaf trigger (DB reads only)
  3. [0.3-8s]   Leaf compaction (if triggered) — ASYNC, best-effort
  4. [0.3-60s]  Full sweep (if over threshold) — SYNC, blocks session
  5. [instant]  Return to caller
```

**The critical distinction:**
- **Leaf compaction** runs asynchronously (fire-and-forget). It doesn't block the reply.
- **Full sweep** runs synchronously. It blocks the current session until all passes complete. On a large context with a slow compaction model, this can take 30-60 seconds.

This is why compaction model choice matters so much — a slow model turns full sweeps into visible hangs.

---

## Configuration Reference

### Cache-aware skip settings

| Setting | Default | Env Var | Range | Description |
|---------|---------|---------|-------|-------------|
| `leafSkipReductionThreshold` | `0.05` | `LCM_LEAF_SKIP_REDUCTION_THRESHOLD` | 0-1 | Min per-pass reduction as fraction of total assembled tokens. Set to `0` to disable. |
| `leafBudgetHeadroomFactor` | `0.8` | `LCM_LEAF_BUDGET_HEADROOM_FACTOR` | 0-1 | Skip leaf compaction when assembled tokens < factor x contextThreshold x tokenBudget. Set to `0` to disable headroom check (note: also disables budget pressure detection). |

### All compaction settings

| Setting | Default | Env Var | Description |
|---------|---------|---------|-------------|
| `contextThreshold` | `0.75` | `LCM_CONTEXT_THRESHOLD` | Fraction of budget that triggers full-sweep compaction |
| `leafChunkTokens` | `20000` | `LCM_LEAF_CHUNK_TOKENS` | Max raw tokens per leaf pass |
| `leafTargetTokens` | `2400` | `LCM_LEAF_TARGET_TOKENS` | Target output tokens for leaf summaries |
| `condensedTargetTokens` | `2000` | `LCM_CONDENSED_TARGET_TOKENS` | Target output tokens for condensed summaries |
| `freshTailCount` | `64` | `LCM_FRESH_TAIL_COUNT` | Messages protected from compaction |
| `incrementalMaxDepth` | `1` | `LCM_INCREMENTAL_MAX_DEPTH` | Max condensation depth per turn (-1 = unlimited) |
| `leafMinFanout` | `8` | `LCM_LEAF_MIN_FANOUT` | Min leaf summaries before condensation |
| `condensedMinFanout` | `4` | `LCM_CONDENSED_MIN_FANOUT` | Min same-depth summaries before condensation |
| `condensedMinFanoutHard` | `2` | `LCM_CONDENSED_MIN_FANOUT_HARD` | Relaxed fanout for forced compaction sweeps |
| `summaryModel` | `""` | `LCM_SUMMARY_MODEL` | Model for compaction (critical — use fast models) |
| `summaryProvider` | `""` | `LCM_SUMMARY_PROVIDER` | Provider for compaction model |
| `expansionModel` | `""` | `LCM_EXPANSION_MODEL` | Model for `lcm_expand_query` sub-agent (defaults to main model — set to cheap model!) |
| `expansionProvider` | `""` | `LCM_EXPANSION_PROVIDER` | Provider for expansion model |
| `delegationTimeoutMs` | `120000` | `LCM_DELEGATION_TIMEOUT_MS` | Timeout for expand_query sub-agent (ms) |
| `summaryTimeoutMs` | `60000` | `LCM_SUMMARY_TIMEOUT_MS` | Timeout per summarization call (ms) |
| `summaryMaxOverageFactor` | `3` | `LCM_SUMMARY_MAX_OVERAGE_FACTOR` | Max allowed summary size as multiple of target (forces truncation above) |
| `circuitBreakerThreshold` | `5` | `LCM_CIRCUIT_BREAKER_THRESHOLD` | Consecutive auth failures before compaction is disabled |
| `circuitBreakerCooldownMs` | `1800000` | `LCM_CIRCUIT_BREAKER_COOLDOWN_MS` | Cooldown before circuit breaker resets (30 min default) |

### Recommended configurations by tier

| Scenario | skipThreshold | headroomFactor | leafChunkTokens | summaryModel | Rationale |
|----------|---------------|----------------|-----------------|--------------|-----------|
| **Opus 1M coding** | 0.02 | 0.55 | 35000 | Haiku/GPT-4o-mini | At $5/MTok, moderate early compaction. Larger chunks = fewer cache busts. |
| **Sonnet 1M general** | 0.05 | 0.80 | 20000 | Haiku | Defaults work here. Break-even ~13.5 turns. |
| **Haiku quick** | 0.10 | 0.90 | 15000 | Haiku | Short sessions rarely recoup cache invalidation. |
| **Orchestration** | 0.02 | 0.60 | 25000 | Sonnet | Sub-agents accumulate fast. Compact early. |

### Cache economics

| Model | Input $/MTok | Cached $/MTok | Cache miss penalty | Miss on 150K cached |
|-------|-------------|---------------|-------------------|-------------------|
| Opus 4.6 | $5.00 | $0.50 | $4.50/MTok | **$0.68** |
| Sonnet 4.6 | $3.00 | $0.30 | $2.70/MTok | **$0.41** |
| Haiku 4.5 | $1.00 | $0.10 | $0.90/MTok | **$0.14** |

> **Note:** Cached input is always 1/10 of the base input price across all Anthropic models. Cache TTL is 5 minutes (refreshed on each hit).

**Break-even formula:** A compaction saving X tokens/turn that invalidates Y cached tokens takes `(Y × miss_penalty) / (X × input_price)` turns to pay back. For typical values (150K cached, 10K saved): **~13.5 turns** regardless of model tier (since cache reads are always 1/10 of base input across all Anthropic models, the input price cancels out).

> **Note:** This formula omits the cache write premium (1.25× base input for 5-minute TTL). Including it adds ~0.7 turns to the break-even for typical compaction sizes. Anthropic also offers a 1-hour TTL at 2× write cost. See [prompt caching docs](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) for details.

### Escape hatches

- `leafSkipReductionThreshold=0` — Disables the cache-aware skip. Compaction fires whenever raw tokens exceed the chunk threshold (original behavior).
- `leafBudgetHeadroomFactor=0` — Disables the headroom check AND budget pressure detection. Only the cache-aware skip remains active.
- Both set to `0` — Fully disables skip guards. Equivalent to pre-feature behavior.

---

## Advanced: Model Selection and Latency

### Why model choice causes session lockups

Compaction calls the LLM to summarize message chunks. Each call:
1. Sends ~20-35K input tokens (the chunk to summarize)
2. Receives ~600-2400 output tokens (the summary)
3. Blocks until complete (full sweep is synchronous)

**Compaction model comparison** (cost per call = 20K input + 2.4K output). Model names below are marketing names — use the provider-qualified config ID (e.g., `gpt-4o-mini`, `claude-haiku-4-5`) when setting `summaryModel`:

| Model | Input $/MTok | Output $/MTok | Cost/call | Context | Latency | Notes |
|-------|-------------|--------------|-----------|---------|---------|-------|
| GPT-4.1-nano (`gpt-4.1-nano`) | $0.10 | $0.40 | **$0.003** | 1M | 0.3-1s | Cheapest option available |
| GPT-4o-mini (`gpt-4o-mini`) | $0.15 | $0.60 | **$0.004** | 128K | 0.5-1.5s | Auto caching (50% off) |
| Mistral Small (`mistral-small-4`) | $0.20 | $0.60 | **$0.005** | 256K | 0.5-1.5s | Good context headroom |
| GPT-4.1-mini (`gpt-4.1-mini`) | $0.20 | $0.80 | **$0.006** | 1M | 0.5-1.5s | 1M context, 75% cache discount |
| DeepSeek V3 (`deepseek-v3`) | $0.28 | $0.42 | **$0.007** | 164K | 1-2s | 90% auto cache, cheapest cached |
| Gemini 2.5 Flash (`gemini-2.5-flash`) | $0.30 | $2.50 | **$0.012** | 1M | 0.3-1s | Fastest TTFT, 90% cache discount |
| Haiku 4.5 (`claude-haiku-4-5`) | $1.00 | $5.00 | **$0.032** | 200K | 0.3-0.8s | Best Anthropic option |
| GPT-5.4-mini (`gpt-5.4-mini`) | $0.75 | $4.50 | **$0.026** | 400K | 0.5-1s | 90% cache, 128K max output |
| Sonnet 4.6 (`claude-sonnet-4-6`) | $3.00 | $15.00 | **$0.096** | 1M | 1-3s | Higher quality, expensive |
| **Opus 4.6** (`claude-opus-4-6`) | **$5.00** | **$25.00** | **$0.160** | **1M** | **3-8s** | **Never use for compaction** |

> **Context window note:** The compaction model only receives the chunk being compressed (~20-35K tokens + ~5K overhead), NOT the full conversation. A 128K model works fine for default settings. Set `leafChunkTokens` below your compaction model's context window minus 7K (for overhead + output).

A full sweep may run 5-15 compaction calls. With Opus, that's 15-120 seconds of stall. With GPT-4o-mini or Gemini Flash, it's 3-15 seconds total.

### Recommended compaction models

**Always use non-thinking, low-latency models.** Summarization is a straightforward extraction task — expensive models don't produce meaningfully better summaries.

**Budget tier** (~$0.004-0.007/call):
1. `gpt-4o-mini` — Cheapest, automatic caching, 128K context
2. `mistral-small-4` — Same price tier, 256K context
3. `deepseek-v3` — Auto 90% cache, good value

**Mid tier** (~$0.01-0.03/call):
4. `gemini-2.5-flash` — Fastest TTFT, 1M context, 90% cache on Vertex
5. `gpt-4.1-mini` — 1M context, 75% cache discount
6. `claude-haiku-4-5` — Best Anthropic option, reliable output format

**Never use for compaction:**
- `claude-opus-4-6` — 40x more expensive than GPT-4o-mini, 3-8s latency, no quality benefit
- Any `o3` / `o1` / thinking model — Chain-of-thought adds 10-30s per call
- `5.4-codex` — Actively corrupts summaries by not following format instructions

### Cache-aware skip guard details

The skip guards evaluate in priority order to balance cache stability against budget pressure:

```mermaid
flowchart TD
    A["rawTokensOutsideTail >= leafChunkTokens?"] -->|No| Z["No compaction needed"]
    A -->|Yes| B["Assembled tokens < headroom ceiling?"]
    B -->|"Yes (has headroom)"| Y["Skip: budget headroom<br/>No pressure, preserve cache"]
    B -->|"No / disabled"| C["Budget pressure detected?"]
    C -->|Yes| E["COMPACT<br/>Budget pressure overrides cache"]
    C -->|"No (headroom disabled<br/>or no tokenBudget)"| D["Reduction < leafSkipReductionThreshold<br/>(default 5%) of total context?"]
    D -->|Yes| X["Skip: cache-aware<br/>Reduction too small for cache cost"]
    D -->|No| G["COMPACT<br/>Reduction is worthwhile"]

    style E fill:#d4edda
    style G fill:#d4edda
    style Y fill:#fff3cd
    style X fill:#fff3cd
    style Z fill:#f8f9fa
```

**Key design principles:**
1. **Budget pressure always wins.** When assembled tokens reach or exceed the headroom ceiling, compaction fires unconditionally — preventing compaction starvation in large contexts.
2. **Cache-aware skip is conservative.** It only fires when there is genuinely no budget pressure and the token savings are negligible relative to total context.
3. **Per-pass estimation.** The reduction estimate uses `min(rawTokensOutsideTail, leafChunkTokens)` — the actual single-pass chunk size, not all raw tokens.

### Sub-agent isolation

When compaction runs on the main agent session, it stalls all connected sessions sharing that thread. To prevent this:

1. **Isolate sub-agent sessions** — Configure `ignoreSessionPatterns` or `statelessSessionPatterns` to prevent sub-agents from triggering compaction
2. **Use shorter timeouts** — Set `summaryTimeoutMs` to 30000 (30s) so failed compaction releases quickly
3. **Choose fast models** — A 0.5s Haiku call is invisible even without isolation

```json
{
  "summaryModel": "claude-haiku-4-5",
  "summaryProvider": "anthropic",
  "summaryTimeoutMs": 30000,
  "ignoreSessionPatterns": ["agent:*:cron:**"],
  "statelessSessionPatterns": ["agent:*:subagent:**"]
}
```

### Debugging compaction issues

**"Compaction never fires"** — Check:
1. Is `leafChunkTokens` set too high? Default is 20K; if your turns are small, raw tokens may never accumulate enough.
2. Is `leafBudgetHeadroomFactor` too high? With a large budget (1M) and default 0.8, the headroom ceiling is 600K — compaction won't fire until then.
3. Enable debug logging to see skip reasons. Look for `[lcm] afterTurn:` lines in stderr — triggered compactions log `leaf compaction triggered`, skipped ones log `leaf compaction skipped` with the guard reason.

**"Compaction fires every turn"** — Check:
1. Is `leafChunkTokens` too low? If set to 2000, compaction triggers after just 2-3 messages.
2. Is `leafSkipReductionThreshold` too low or 0? The cache-aware skip might be disabled.
3. Is the context near the budget threshold? Budget pressure overrides all skip guards.

**"Session hangs during compaction"** — Check:
1. What model is used for compaction? Switch to Haiku or a mini model.
2. Is `summaryTimeoutMs` set? Default is 60s — lower it to 30s for faster release.
3. Is the compaction model returning errors? The circuit breaker trips after `circuitBreakerThreshold` (default 5) consecutive auth failures, then cools down for `circuitBreakerCooldownMs` (default 30 min).

---

## References

- [LCM: Lossless Context Management](https://papers.voltropy.com/LCM) — Ehrlich & Blackman, Voltropy (2026). The foundational paper describing the DAG-based compaction architecture. Benchmarks show Volt (LCM-augmented agent) scoring 74.8 vs Claude Code 70.3 on OOLONG, with the gap widening at longer contexts.
- [Contextual Memory Virtualisation (arXiv:2602.22402)](https://arxiv.org/abs/2602.22402) — DAG-based state management with structurally lossless trimming. Reports mean 20% token reduction, up to 86% for tool-heavy sessions, 39% average for mixed tool-use. Demonstrates economic viability under prompt caching across 76 real-world coding sessions.
- [The Missing Memory Hierarchy (arXiv:2603.09023)](https://arxiv.org/html/2603.09023v1) — Treats context management as OS-style demand paging. Reports 37.1% reduction in effective input tokens, 0.0254% fault rate, 45% cumulative compute savings over 88 turns.
- [Anthropic Prompt Caching](https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching) — Prefix-based caching at 1/10 input price, 5-minute TTL refreshed on hit.
- [OpenAI Prompt Caching](https://openai.com/index/api-prompt-caching/) — Automatic 50% discount on cached input tokens for GPT-4o family.
- [JetBrains Context Management Research](https://blog.jetbrains.com/research/2025/12/efficient-context-management/) — Empirical comparison finding LLM summarization causes 13-15% trajectory elongation; observation masking is 52% cheaper on average.
