# lossless-claw

> ⚠️ **Current requirement:** This plugin currently requires a custom OpenClaw build with [PR #22201](https://github.com/openclaw/openclaw/pull/22201) applied until that PR is merged upstream.

Lossless Context Management plugin for [OpenClaw](https://github.com/openclaw/openclaw), based on the [LCM paper](https://voltropy.com/LCM). Replaces OpenClaw's built-in sliding-window compaction with a DAG-based summarization system that preserves every message while keeping active context within model token limits.

## What it does

When a conversation grows beyond the model's context window, OpenClaw (just like all of the other agents) normally truncates older messages. LCM instead:

1. **Persists every message** in a SQLite database, organized by conversation
2. **Summarizes chunks** of older messages into summaries using your configured LLM
3. **Condenses summaries** into higher-level nodes as they accumulate, forming a DAG (directed acyclic graph)
4. **Assembles context** each turn by combining summaries + recent raw messages
5. **Provides tools** (`lcm_grep`, `lcm_describe`, `lcm_expand`) so agents can search and recall details from compacted history

Nothing is lost. Raw messages stay in the database. Summaries link back to their source messages. Agents can drill into any summary to recover the original detail.

**It feels like talking to an agent that never forgets. Because it doesn't. In normal operation, you'll never need to think about compaction again.**

## Installation

### Prerequisites

- OpenClaw with context engine support (josh/context-engine branch or equivalent)
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

Add an `lossless-claw` block under `plugins.config` in your OpenClaw config:

```json
{
  "plugins": {
    "config": {
      "lossless-claw": {
        "enabled": true,
        "freshTailCount": 32,
        "contextThreshold": 0.75,
        "incrementalMaxDepth": 1
      }
    }
  }
}
```

### Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_ENABLED` | `true` | Enable/disable the plugin |
| `LCM_DATABASE_PATH` | `~/.openclaw/lcm.db` | Path to the SQLite database |
| `LCM_CONTEXT_THRESHOLD` | `0.75` | Fraction of context window that triggers compaction (0.0–1.0) |
| `LCM_FRESH_TAIL_COUNT` | `32` | Number of recent messages protected from compaction |
| `LCM_LEAF_MIN_FANOUT` | `8` | Minimum raw messages per leaf summary |
| `LCM_CONDENSED_MIN_FANOUT` | `4` | Minimum summaries per condensed node |
| `LCM_CONDENSED_MIN_FANOUT_HARD` | `2` | Relaxed fanout for forced compaction sweeps |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | How deep incremental compaction goes (0 = leaf only) |
| `LCM_LEAF_CHUNK_TOKENS` | `20000` | Max source tokens per leaf compaction chunk |
| `LCM_LEAF_TARGET_TOKENS` | `1200` | Target token count for leaf summaries |
| `LCM_CONDENSED_TARGET_TOKENS` | `2000` | Target token count for condensed summaries |
| `LCM_MAX_EXPAND_TOKENS` | `4000` | Token cap for sub-agent expansion queries |
| `LCM_LARGE_FILE_TOKEN_THRESHOLD` | `25000` | File blocks above this size are intercepted and stored separately |
| `LCM_SUMMARY_MODEL` | *(from OpenClaw)* | Model for summarization (e.g. `anthropic/claude-sonnet-4-20250514`) |
| `LCM_SUMMARY_PROVIDER` | *(from OpenClaw)* | Provider override for summarization |
| `LCM_INCREMENTAL_MAX_DEPTH` | `0` | Depth limit for incremental condensation after leaf passes |

### Recommended starting configuration

```
LCM_FRESH_TAIL_COUNT=32
LCM_INCREMENTAL_MAX_DEPTH=1
LCM_CONTEXT_THRESHOLD=0.75
```

- **freshTailCount=32** protects the last 32 messages from compaction, giving the model enough recent context for continuity.
- **incrementalMaxDepth=1** enables automatic condensation of leaf summaries after each compaction pass (without this, only leaf summaries are created and condensation only happens during manual `/compact` or overflow).
- **contextThreshold=0.75** triggers compaction when context reaches 75% of the model's window, leaving headroom for the model's response.

## How it works

See [docs/architecture.md](docs/architecture.md) for the full technical deep-dive. Here's the summary:

### The DAG

LCM builds a directed acyclic graph of summaries:

```
Raw messages → Leaf summaries (d0) → Condensed (d1) → Condensed (d2) → ...
```

- **Leaf summaries** (depth 0) are created from chunks of raw messages. They preserve timestamps, decisions, file operations, and key details.
- **Condensed summaries** (depth 1+) merge multiple summaries at the same depth into a higher-level node. Each depth tier uses a different prompt strategy optimized for its level of abstraction.
- **Parent links** connect each condensed summary to its source summaries, enabling drill-down via `lcm_expand_query`.

### Context assembly

Each turn, the assembler builds model context by:

1. Fetching the conversation's **context items** (an ordered list of summary and message references)
2. Resolving each item into an `AgentMessage`
3. Protecting the **fresh tail** (most recent N messages) from eviction
4. Filling remaining token budget from oldest to newest, dropping the oldest items first if over budget
5. Wrapping summaries in XML with metadata (id, depth, timestamps, descendant count)

The model sees something like:

```xml
<summary id="sum_abc123" kind="condensed" depth="1" descendant_count="8"
         earliest_at="2026-02-17T07:37:00" latest_at="2026-02-17T15:43:00">
  <parents>
    <summary_ref id="sum_def456" />
    <summary_ref id="sum_ghi789" />
  </parents>
  <content>
    ...summary text...
  </content>
</summary>
```

This gives the model enough information to know what was discussed, when, and how to drill deeper via the expansion tools.

### Compaction triggers

Compaction runs in two modes:

- **Proactive (after each turn):** If raw messages outside the fresh tail exceed `leafChunkTokens`, a leaf pass runs. If `incrementalMaxDepth > 0`, condensation follows.
- **Reactive (overflow/manual):** When total context exceeds `contextThreshold × tokenBudget`, a full sweep runs: all eligible leaf chunks are compacted, then condensation proceeds depth-by-depth until stable.

### Depth-aware prompts

Each summary depth gets a tailored prompt:

| Depth | Kind | Strategy |
|-------|------|----------|
| 0 | Leaf | Narrative with timestamps, file tracking, preserves operational detail |
| 1 | Condensed | Chronological session summary, deduplicates against `previous_context` |
| 2 | Condensed | Arc-focused: goals, outcomes, what carries forward. Self-contained. |
| 3+ | Condensed | Durable context only: key decisions, relationships, lessons learned |

All summaries end with an "Expand for details about:" footer listing what was compressed, guiding agents on when to use `lcm_expand_query`.

### Large file handling

Files over `largeFileTokenThreshold` (default 25k tokens) embedded in messages are intercepted during ingestion:

1. Content is stored to `~/.openclaw/lcm-files/<conversation_id>/<file_id>.<ext>`
2. A ~200 token exploration summary replaces the file in the message
3. The `lcm_describe` tool can retrieve the full file content on demand

This prevents large file pastes from consuming the entire context window.

## Agent tools

LCM registers four tools that agents can use to search and recall compacted history:

### `lcm_grep`

Full-text and regex search across messages and summaries.

```
lcm_grep(pattern: "database migration", mode: "full_text")
lcm_grep(pattern: "config\\.threshold", mode: "regex", scope: "summaries")
```

Parameters:
- `pattern` — Search string (regex or full-text)
- `mode` — `"regex"` (default) or `"full_text"`
- `scope` — `"messages"`, `"summaries"`, or `"both"` (default)
- `conversationId` — Scope to a specific conversation
- `allConversations` — Search across all conversations
- `since` / `before` — ISO timestamp filters
- `limit` — Max results (default 50, max 200)

### `lcm_describe`

Inspect a specific summary or stored file by ID.

```
lcm_describe(id: "sum_abc123")
lcm_describe(id: "file_def456")
```

Returns the full content, metadata, parent/child relationships, and token counts. For files, returns the stored content.

### `lcm_expand_query`

Deep recall via delegated sub-agent. Finds relevant summaries, expands them by walking the DAG down to source material, and answers a focused question.

```
lcm_expand_query(
  query: "database migration",
  prompt: "What migration strategy was decided on?"
)

lcm_expand_query(
  summaryIds: ["sum_abc123"],
  prompt: "What were the exact config changes?"
)
```

Parameters:
- `prompt` — The question to answer (required)
- `query` — Text query to find relevant summaries (when you don't have IDs)
- `summaryIds` — Specific summary IDs to expand (when you have them)
- `maxTokens` — Answer length cap (default 2000)
- `conversationId` / `allConversations` — Scope control

Returns a compact answer with cited summary IDs.

### `lcm_expand`

Low-level DAG expansion (sub-agent only). Main agents should use `lcm_expand_query` instead; this tool is available to delegated sub-agents spawned by `lcm_expand_query`.

## TUI

The repo includes an interactive terminal UI (`tui/`) for inspecting, repairing, and managing the LCM database. It's a separate Go binary — not part of the npm package.

### Install

**From GitHub releases** (recommended):

Download the latest binary for your platform from [Releases](https://github.com/Martian-Engineering/lossless-claw/releases).

**Build from source:**

```bash
cd tui
go build -o lcm-tui .
# or: make build
# or: go install github.com/Martian-Engineering/lossless-claw/tui@latest
```

Requires Go 1.24+.

### Usage

```bash
lcm-tui [--db path/to/lcm.db] [--sessions path/to/sessions/dir]
```

Defaults to `~/.openclaw/lcm.db` and auto-discovers session directories.

### Features

- **Conversation browser** — List all conversations with message/summary counts and token totals
- **Summary DAG view** — Navigate the full summary hierarchy with depth, kind, token counts, and parent/child relationships
- **Context view** — See exactly what the model sees: ordered context items with token breakdowns (summaries + fresh tail messages)
- **Dissolve** — Surgically restore a condensed summary back to its parent summaries (with ordinal shift preview)
- **Rewrite** — Re-summarize nodes using actual OpenClaw prompts with scrollable diffs and auto-accept mode
- **Repair** — Fix corrupted summaries (fallback truncations, empty content) using proper LLM summarization
- **Transplant** — Deep-copy summary DAGs between conversations (preserves all messages, message_parts, summary_messages)
- **Previous context viewer** — Inspect the `previous_context` text used during summarization

### Keybindings

| Key | Action |
|-----|--------|
| `c` | Context view (from conversation list) |
| `s` | Summary DAG view |
| `d` | Dissolve a condensed summary |
| `r` | Rewrite a summary |
| `R` | Repair corrupted summaries |
| `t` | Transplant summaries between conversations |
| `p` | View previous_context |
| `Enter` | Expand/select |
| `Esc`/`q` | Back/quit |

## Database

LCM uses SQLite via Node's built-in `node:sqlite` module. The default database path is `~/.openclaw/lcm.db`.

### Schema overview

- **conversations** — Maps session IDs to conversation IDs
- **messages** — Every ingested message with role, content, token count, timestamps
- **message_parts** — Structured content blocks (text, tool calls, reasoning, files) linked to messages
- **summaries** — The summary DAG nodes with content, depth, kind, token counts, timestamps
- **summary_messages** — Links leaf summaries to their source messages
- **summary_parents** — Links condensed summaries to their parent summaries
- **context_items** — The ordered context list for each conversation (what the model sees)
- **large_files** — Metadata for intercepted large files
- **expansion_grants** — Delegation grants for sub-agent expansion queries

Migrations run automatically on first use. The schema is forward-compatible; new columns are added with defaults.

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
