# lossless-claude: Memory Platform — Design Spec

**Date:** 2026-03-17
**Status:** Draft
**Author:** Pedro (ipedro)

---

## Overview

lossless-claude is a memory platform for Claude Code and the broader development toolchain. It replaces Claude Code's native context compaction with a lossless DAG-based memory system, and provides a unified memory API for programmatic use by tools like xgh.

The core thesis: Claude Code (and every tool built around it) should never lose context. Raw conversation messages are preserved in a per-project SQLite DAG. High-signal summaries are promoted to a shared Qdrant semantic store. Every session starts with full memory restoration. Memory is queryable at any time via MCP tools or a Node.js API.

---

## Goals

1. **Replace Claude Code's native compaction** with lossless DAG-based summarization — nothing is discarded
2. **Restore memory at session start** — inject relevant summaries and semantic context from past sessions
3. **Expose active retrieval** to Claude via MCP tools — Claude can pull from memory on demand
4. **Centralise memory handling** for the entire toolchain — xgh and future tools use lossless-claude instead of calling Qdrant directly
5. **Single memory surface for Claude** — no competing MCP tools, no confusion about what to use when

---

## Non-Goals

- Replacing Cipher as an MCP server for other use cases (xgh analysis, team workspace context) — Cipher's MCP server is orthogonal and unaffected
- Cross-machine or cloud memory sync — local only for now
- Supporting Claude Code versions without hook support

---

## Architecture

```
Claude Code session
       │
       ├── PreCompact hook ──────────→ daemon:3737/compact
       │                                   ├── run DAG compaction on transcript
       │                                   ├── promote high-signal summaries → Qdrant
       │                                   ├── return hookSpecificOutput (summary injection)
       │                                   └── exit 2 (block native) | exit 0 (daemon down → fallback)
       │
       ├── SessionStart hook ────────→ daemon:3737/restore
       │                                   ├── query SQLite DAG (recent summaries for this project)
       │                                   ├── query Qdrant (semantic context for this project)
       │                                   └── return combined context + memory orientation prompt
       │
       └── MCP server (stdio, per-session, thin client → daemon:3737)
               ├── lcm_grep       — keyword/regex search across conversation history
               ├── lcm_expand     — decompress a summary node into full content
               ├── lcm_describe   — inspect node metadata, lineage, token counts
               └── lcm_search     — semantic search across SQLite + Qdrant

xgh retriever/analyzer
       └── import { memory } from 'lossless-claude'
               ├── memory.store(text, tags, metadata)
               └── memory.search(query, options)

Shared backend
       ├── SQLite DAG     per-project, ~/.lossless-claude/projects/<sha256(cwd)>/db.sqlite
       └── Qdrant         shared, collection: lossless_memory, config from ~/.cipher/cipher.yml
```

---

## Memory Layers

### Layer 1: SQLite DAG (Episodic)

Per-project. Stores raw conversation messages and the summary tree built from them.

- **Leaf nodes** (depth 0): raw message windows, ~1000 tokens each
- **Summary nodes** (depth 1+): LLM-generated summaries of child nodes
- **DAG structure**: each summary node has parent/child links, depth, token count, creation timestamp
- **Lossless**: raw messages are never deleted — only summarised
- **FTS5**: full-text search index over all message content

Schema (actual DDL from `src/db/migration.ts`, carried over unchanged):

```sql
conversations (conversation_id PK AUTOINCREMENT, session_id, title,
               bootstrapped_at, created_at, updated_at)

messages      (message_id PK AUTOINCREMENT, conversation_id FK, seq,
               role CHECK('system'|'user'|'assistant'|'tool'),
               content, token_count, created_at)

message_parts (part_id PK, message_id FK, session_id,
               part_type CHECK('text'|'reasoning'|'tool'|'patch'|'file'|
                 'subtask'|'compaction'|'step_start'|'step_finish'|
                 'snapshot'|'agent'|'retry'),
               ordinal, text_content, tool_*, patch_*, file_*, ...)

summaries     (summary_id PK TEXT, conversation_id FK,
               kind CHECK('leaf'|'condensed'), depth,
               content, token_count, earliest_at, latest_at,
               descendant_count, descendant_token_count,
               source_message_token_count, created_at, file_ids JSON)

summary_parents  (summary_id FK, parent_summary_id FK, ordinal)  -- DAG edges
summary_messages (summary_id FK, message_id FK, ordinal)          -- leaf→message links

context_items (conversation_id FK, ordinal, item_type CHECK('message'|'summary'),
               message_id FK nullable, summary_id FK nullable, created_at)
               -- tracks last-compacted cursor via bootstrapped_at on conversations

-- FTS5 virtual table
messages_fts (content, tokenize='porter unicode61')
```

`bootstrapped_at` on `conversations` is the compaction cursor — the daemon reads it before parsing the transcript to extract only new messages since the last compaction pass. `meta.json` additionally caches `lastCompact` for quick health checks without opening SQLite.

### Layer 2: Qdrant (Semantic)

Shared across projects. Collection: `lossless_memory`.

Stores promoted summaries as vector embeddings alongside structured metadata:

```typescript
{
  text: string,           // summary content
  tags: string[],         // ['decision', 'architecture', 'bug-fix', ...]
  projectId: string,      // sha256(cwd)
  projectPath: string,    // human-readable path
  depth: number,          // DAG depth of source summary
  sessionId: string,
  timestamp: string,
  source: 'compaction' | 'manual',
  confidence: number
}
```

Config inherits from `~/.cipher/cipher.yml`: Qdrant URL, embedding model, API key.

### Promotion Logic

A summary node is promoted to Qdrant during compaction when it matches one or more signals:

| Signal | Detection |
|--------|-----------|
| Decision | keywords: `decided`, `agreed`, `will use`, `going with`, `chosen` |
| Architecture fact | regexes: file path patterns (`src/`, `.ts`, `/`), interface/class names (PascalCase), known patterns |
| Bug or fix | keywords: `fixed`, `root cause`, `workaround`, `regression`, `resolved` |
| High DAG depth | depth ≥ 2 (survived multiple compaction passes — signal-dense by definition) |
| Token density | summary tokens / source tokens < 0.3 (high compression = high signal) |

Low-signal summaries (status updates, clarifications, routine back-and-forth) remain in SQLite only.

Promotion is idempotent — `storeWithDedup` from `qdrant-store.js` prevents duplicate entries.

---

## Claude Code Integration

### Hook Configuration

Installed into `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreCompact": [{
      "type": "command",
      "command": "lossless-claude compact"
    }],
    "SessionStart": [{
      "type": "command",
      "command": "lossless-claude restore"
    }]
  },
  "mcpServers": {
    "lossless-claude": {
      "command": "lossless-claude",
      "args": ["mcp"]
    }
  }
}
```

### PreCompact Hook

**Input** (from Claude Code via stdin):
```json
{
  "session_id": "...",
  "transcript_path": "/path/to/session.jsonl",
  "hook_event_name": "PreCompact",
  "cwd": "/path/to/project"
}
```

**Behaviour:**
1. POST to `daemon:3737/compact` with input
2. Daemon reads transcript from `transcript_path`, extracts messages since last compaction (cursor: `bootstrapped_at` on `conversations`)
3. Runs DAG compaction: group messages into leaf nodes → summarise → build tree
4. Promotes qualifying summaries to Qdrant
5. Returns plain-text summary of what was compacted

**⚠ Verification required (C1):** The exact JSON schema Claude Code sends to PreCompact hooks is not publicly documented. Before implementation, write a minimal probe hook that dumps stdin to `~/.lossless-claude/precompact-probe.json` and trigger compaction in Claude Code to verify that `transcript_path` is present and the transcript format matches what `transcript-repair.ts` expects. If `transcript_path` is absent, the daemon will fall back to processing messages already recorded in SQLite for the current `session_id`.

**Exit codes:**
- `2` — daemon healthy, compaction ran, block native compaction
- `0` — daemon unreachable or compaction failed, native compaction proceeds as fallback

**stdout to Claude Code:**

Plain text injected as context when exiting `2`. Exact format (bare text vs JSON envelope `{"hookSpecificOutput":"..."}`) must be confirmed against Claude Code hook protocol during C1 probe above:

```
Compacted 847 tokens into 3 summary nodes. 2 decisions promoted to long-term memory.
```

### SessionStart Hook

**Input:**
```json
{
  "session_id": "...",
  "hook_event_name": "SessionStart",
  "cwd": "/path/to/project",
  "source": "startup" | "resume" | "compact"
}
```

**Behaviour:**
1. POST to `daemon:3737/restore` with input
2. **Post-compaction detection:** if `source` is `"compact"` (⚠ verify this value exists in Claude Code's protocol — if not, use fallback: daemon checks in-memory map for `session_id` with a `justCompacted` flag set by `/compact` within the last 30 seconds): skip context injection entirely — output orientation prompt only and exit `0`
3. Otherwise: query SQLite for the 3 most recent summary roots for this project
4. Query Qdrant for top-5 semantic matches for this project (broad query: project context)
5. If both layers return empty (first-ever session for this project): output orientation prompt only — omit `<recent-session-context>` and `<project-knowledge>` blocks
6. Otherwise: assemble combined context and prepend orientation prompt

**stdout to Claude Code:**
```
<memory-orientation>
Memory system active. Guidelines:
- lcm_grep / lcm_expand / lcm_describe / lcm_search → conversation history and project memory
- Do not store directly to any memory system — lossless-claude manages persistence automatically
- When uncertain what was discussed or decided, use lcm_search before asking the user
</memory-orientation>

<recent-session-context>
[last 3 summary roots from SQLite — omitted if empty]
</recent-session-context>

<project-knowledge>
[top semantic matches from Qdrant — omitted if empty]
</project-knowledge>
```

Always exits `0` — restoration failure is non-fatal.

---

## MCP Tool Surface

The daemon exposes exactly four tools. Cipher's MCP server is **not registered** in Claude Code — Qdrant is an internal backend, invisible to Claude.

### `lcm_grep`
Search conversation history by keyword or regex across raw messages and summaries.

```typescript
input:  { query: string, scope?: 'messages' | 'summaries' | 'all', sessionId?: string, since?: string }
output: { matches: Array<{ id, content, depth, timestamp, score }> }
```

*Use when: recalling what was said, decided, or done in a past session.*

### `lcm_expand`
Decompress a summary node into its full source content by traversing the DAG.

```typescript
input:  { nodeId: string, depth?: number }
output: { content: string, children: Node[], tokens: number }
```

*Use when: a summary references something that needs more detail.*

### `lcm_describe`
Inspect the metadata and lineage of a node without expanding its content.

```typescript
input:  { nodeId: string }
output: { id, depth, tokens, childCount, promoted, timestamp, parentId }
```

*Use when: understanding the structure or provenance of a memory node.*

### `lcm_search`
Hybrid search across both SQLite (FTS5) and Qdrant. Returns two separate ranked lists — the caller (Claude) sees which source each result comes from and can reason about provenance.

```typescript
input:  { query: string, limit?: number, layers?: ('episodic' | 'semantic')[] }
output: {
  episodic: Array<{ id, content, source: 'sqlite', score, depth, timestamp }>,
  semantic: Array<{ id, content, source: 'qdrant', score, tags, projectPath }>
}
```

Scores are not merged across layers (BM25 and cosine similarity are not comparable). Claude receives both lists and can apply its own judgement. `limit` applies per layer.

*Use when: looking for project knowledge or context that may span multiple sessions.*

---

## Summarisation

The daemon calls the Anthropic API directly for LLM summarisation, replacing OpenClaw's injected `deps.complete()`.

**SDK:** `@anthropic-ai/sdk`

**API key resolution order:**
1. `ANTHROPIC_API_KEY` environment variable
2. `config.json` `llm.apiKey` (supports `${ANTHROPIC_API_KEY}` interpolation at config load time)
3. Fatal error with clear message if neither is set

**Per-call parameters:**
```typescript
{
  model: config.llm.model,   // default: "claude-haiku-4-5-20251001"
  max_tokens: 1024,          // per summary node — sufficient for depth-aware prompts
  system: <existing system prompt from summarize.ts>,
  messages: [{ role: 'user', content: <depth-aware prompt> }]
}
```

The existing system prompt and depth-aware prompt templates in `summarize.ts` are reused unchanged.

**Error handling:**
- Rate limit (429): exponential backoff, 3 retries, then fail compaction for this pass (exit 0, native fallback)
- Auth failure (401): surface as fatal error in daemon log, exit 0 on hook
- Model unavailable: same as rate limit
- Partial compaction: entire transaction rolls back on any LLM error — no partial DAG state

---

## Node.js API

For programmatic use by xgh and other tools. Replaces direct `qdrant-store.js` calls.

```typescript
import { memory } from 'lossless-claude'

// Store a memory (goes to Qdrant via lossless-claude's pipeline)
await memory.store(text: string, tags: string[], metadata?: Record<string, unknown>)

// Search (queries both SQLite FTS5 and Qdrant, returns merged results)
await memory.search(query: string, options?: {
  limit?: number,
  threshold?: number,
  projectId?: string,
  layers?: ('episodic' | 'semantic')[]
})

// Manually trigger compaction for a session
// Always routes through the daemon (never in-process) — daemon serialises per (projectId, sessionId)
await memory.compact(sessionId: string, transcriptPath: string)

// Get recent summaries for a project
await memory.recent(projectId: string, limit?: number)
```

The API communicates with the daemon over HTTP. If the daemon is not running, it starts it automatically on first call.

---

## Daemon

### Process

Two processes:

```
lossless-claude daemon              (persistent, one per machine)
├── Unix domain socket: ~/.lossless-claude/daemon.sock  (preferred)
│   (falls back to TCP port 3737 if socket unavailable)
│   ├── POST /compact    ← PreCompact hook + memory.compact()
│   ├── POST /restore    ← SessionStart hook
│   ├── POST /store      ← memory.store()
│   ├── POST /grep       ← lcm_grep (FTS5 + optional regex fallback)
│   ├── POST /search     ← lcm_search + memory.search() (FTS5 + Qdrant hybrid)
│   ├── POST /expand     ← lcm_expand
│   ├── POST /describe   ← lcm_describe
│   ├── POST /recent     ← memory.recent()
│   └── GET  /health
└── owns SQLite connections + Qdrant client

lossless-claude mcp                 (stdio, launched per Claude Code session)
└── thin client → daemon.sock for all data operations
    ├── lcm_grep    → POST /grep
    ├── lcm_expand  → POST /expand
    ├── lcm_describe → POST /describe
    └── lcm_search  → POST /search
```

The MCP server holds **no database connections** — it is purely a socket client to the daemon. All four tools share the daemon's single SQLite connection pool and Qdrant client.

**SQLite concurrency:**
- WAL mode is mandatory (`PRAGMA journal_mode=WAL`)
- Compaction uses a dedicated connection with `BEGIN IMMEDIATE` transaction
- LLM summarisation calls happen **outside** the transaction: collect all summaries first, then batch-write in a single transaction
- Partial compaction failure rolls back the entire transaction — no partial state
- Read operations (grep, search, describe, expand, restore) use a separate read-only connection

**Daemon startup and socket discovery:**
- Lock protocol: `flock(~/.lossless-claude/daemon.lock, LOCK_EX | LOCK_NB)` → bind socket → write PID → release lock
- Second concurrent startup attempt: lock fails → check if socket responds to `/health` → if yes, exit cleanly; if no, remove stale socket and retry
- Hook CLI commands and Node.js API both follow this pattern

### File Layout

```
~/.lossless-claude/
├── config.json
├── daemon.pid
├── daemon.log
└── projects/
    └── <sha256(absolutePath)>/
        ├── db.sqlite
        └── meta.json     ← { version, path, name, lastCompact, lastRestore, sessionCount }
```

### Config

`~/.lossless-claude/config.json`:

```json
{
  "version": 1,
  "daemon": {
    "port": 3737,
    "socketPath": "~/.lossless-claude/daemon.sock",
    "logLevel": "info",
    "logMaxSizeMB": 10,
    "logRetentionDays": 7
  },
  "compaction": {
    "leafTokens": 1000,
    "maxDepth": 5,
    "promotionThresholds": {
      "minDepth": 2,
      "compressionRatio": 0.3,
      "keywords": {
        "decision": ["decided", "agreed", "will use", "going with", "chosen"],
        "fix": ["fixed", "root cause", "workaround", "resolved"]
      },
      "architecturePatterns": [
        "src/[\\w/]+\\.ts",
        "[A-Z][a-zA-Z]+(Engine|Store|Service|Manager|Handler|Client)",
        "interface [A-Z]",
        "class [A-Z]"
      ]
    }
  },
  "restoration": {
    "recentSummaries": 3,
    "semanticTopK": 5,
    "semanticThreshold": 0.35
  },
  "llm": {
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "${ANTHROPIC_API_KEY}"
  },
  "cipher": {
    "configPath": "~/.cipher/cipher.yml",
    "collection": "lossless_memory"
  }
}
```

Qdrant URL and embedding model are read exclusively from `~/.cipher/cipher.yml` — no duplication.

### Daemon Lifecycle

- **Start**: `lossless-claude daemon start` — writes PID, starts HTTP server
- **Auto-start**: hook commands start the daemon automatically if not running
- **launchd**: installer registers a LaunchAgent for auto-start on login
- **Stop**: `lossless-claude daemon stop`
- **Health**: `GET :3737/health` returns `{ status: 'ok', projects: N, uptime: N }`

---

## xgh Migration

xgh currently calls `qdrant-store.js` directly for memory store/search. After lossless-claude is available:

1. Remove `qdrant-store.js` imports from xgh's analyzer and retriever
2. Replace with `import { memory } from 'lossless-claude'`
3. `memory.store(...)` replaces `storeWithDedup(...)`
4. `memory.search(...)` replaces `search(...)`
5. xgh's Cipher MCP registration remains unchanged — that's for Claude-facing workspace context, which is a different use case from xgh's own memory

Memory written by xgh flows into the same `lossless_memory` Qdrant collection and is therefore visible in Claude Code sessions via `lcm_search`. Memory compacted by Claude Code sessions is visible to xgh via `memory.search`. The memory is genuinely unified.

---

## What We Keep From the Existing Codebase

The existing OpenClaw implementation contains proven, framework-agnostic logic that maps directly into the new design:

| Existing module | Maps to |
|----------------|---------|
| `src/compaction.ts` | Daemon `/compact` handler internals |
| `src/summarize.ts` | Summarisation — replace `deps.complete()` with Anthropic SDK |
| `src/assembler.ts` | Adapt for `/restore` handler (token budgeting, context_items ordering) |
| `src/store/conversation-store.ts` | SQLite DAG layer — keep as-is |
| `src/store/summary-store.ts` | SQLite DAG layer — keep as-is |
| `src/store/fts5-sanitize.ts` | SQLite search layer — keep as-is |
| `src/store/full-text-fallback.ts` | FTS5 fallback — keep as-is |
| `src/retrieval.ts` | `/grep` and `/search` daemon endpoints |
| `src/expansion.ts` | `/expand` daemon endpoint |
| `src/integrity.ts` | DAG repair — keep as-is |
| `src/transcript-repair.ts` | PreCompact hook — transcript parsing |
| `src/large-files.ts` | Keep — `lcm_describe` handles file nodes |
| `src/tools/lcm-grep-tool.ts` | Adapt for MCP stdio surface (remove OpenClaw registration) |
| `src/tools/lcm-describe-tool.ts` | Adapt for MCP stdio surface |
| `src/tools/lcm-expand-tool.ts` | Adapt for MCP stdio surface |
| `src/tools/lcm-conversation-scope.ts` | Keep — scoping logic still relevant |
| `src/db/` | Keep as-is |
| `tui/` | Keep as-is |

**Remove:**
- `src/engine.ts` — OpenClaw ContextEngine
- `index.ts` — OpenClaw plugin registration
- `openclaw.plugin.json` — OpenClaw manifest
- `src/tools/lcm-expand-query-tool.ts` — OpenClaw subagent specific
- `src/expansion-auth.ts` — OpenClaw delegated expansion grants
- `src/expansion-policy.ts` — OpenClaw subagent policy
- `src/openclaw-bridge.ts` — OpenClaw adapter layer (if present)

**Add**: daemon HTTP server, hook CLI commands, Node.js API surface, Claude Code plugin manifest, installer/launchd setup.

---

## Install Story

```bash
npm install -g lossless-claude
lossless-claude install
```

`install` command:
1. Verifies `~/.cipher/cipher.yml` exists and Qdrant is reachable
2. Verifies `ANTHROPIC_API_KEY` is set (or prompts to add to config)
3. Creates `~/.lossless-claude/config.json` with defaults (if not present; does not overwrite)
4. **Merges** hooks + MCP server into `~/.claude/settings.json` — reads existing file, deep-merges `hooks` and `mcpServers` keys, warns if a conflicting `PreCompact` hook already exists
5. Registers LaunchAgent (`~/Library/LaunchAgents/com.lossless-claude.daemon.plist`) for auto-start on login
6. Starts the daemon
7. Runs a self-test: trigger a probe compaction, verify `/health`, verify Qdrant write roundtrip

`uninstall` command reverses steps 4-6 cleanly.

---

## Success Criteria

- `PreCompact` hook fires, DAG compaction runs, native compaction is blocked
- Session start injects summaries from the previous session into the new session context
- `lcm_search` returns results from both SQLite and Qdrant
- xgh can call `memory.store` / `memory.search` and results are visible in Claude Code sessions
- If the daemon is down, Claude Code falls back to native compaction without error
- No Cipher MCP tools are visible to Claude Code
