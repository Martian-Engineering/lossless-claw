# Architecture

This document describes how lossless-claw works internally — the data model, compaction lifecycle, context assembly, and expansion system.

## Data model

### Conversations and messages

Every OpenClaw session maps to a **conversation**. The first time a session ingests a message, LCM creates a conversation record keyed by the runtime session ID.

Messages are stored with:
- **seq** — Monotonically increasing sequence number within the conversation
- **role** — `user`, `assistant`, `system`, or `tool`
- **content** — Plain text extraction of the message
- **tokenCount** — Estimated token count (~4 chars/token)
- **createdAt** — Insertion timestamp

Each message also has **message_parts** — structured content blocks that preserve the original shape (text blocks, tool calls, tool results, reasoning, file content, etc.). This allows the assembler to reconstruct rich content when building model context, not just flat text.

### The summary DAG

Summaries form a directed acyclic graph with two node types:

**Leaf summaries** (depth 0, kind `"leaf"`):
- Created from a chunk of raw messages
- Linked to source messages via `summary_messages`
- Contain a narrative summary with timestamps
- Typically 800–1200 tokens

**Condensed summaries** (depth 1+, kind `"condensed"`):
- Created from a chunk of summaries at the same depth
- Linked to parent summaries via `summary_parents`
- Each depth tier uses a progressively more abstract prompt
- Typically 1500–2000 tokens

Every summary carries:
- **summaryId** — `sum_` + 16 hex chars (SHA-256 of content + timestamp)
- **conversationId** — Which conversation it belongs to
- **depth** — Position in the hierarchy (0 = leaf)
- **earliestAt / latestAt** — Time range of source material
- **descendantCount** — Total number of ancestor summaries (transitive)
- **fileIds** — References to large files mentioned in the source
- **tokenCount** — Estimated tokens

### Context items

The **context_items** table maintains the ordered list of what the model sees for each conversation. Each entry is either a message reference or a summary reference, identified by ordinal.

When compaction creates a summary from a range of messages (or summaries), the source items are replaced by a single summary item. This keeps the context list compact while preserving ordering.

## Compaction lifecycle

### Ingestion

When OpenClaw processes a turn, it calls the context engine's lifecycle hooks:

1. **bootstrap** — On session start, reconciles the JSONL session file with the LCM database. Imports any messages that exist in the file but not in LCM (crash recovery).
2. **ingest** / **ingestBatch** — Persists new messages to the database and appends them to context_items.
3. **afterTurn** — After the model responds, ingests new messages, then evaluates whether compaction should run.

### Leaf compaction

The **leaf pass** converts raw messages into leaf summaries:

1. Identify the oldest contiguous chunk of raw messages outside the **fresh tail** (protected recent messages).
2. Cap the chunk at `leafChunkTokens` (default 20k tokens).
3. Concatenate message content with timestamps.
4. Resolve the most recent prior summary for continuity (passed as `previous_context` so the LLM avoids repeating known information).
5. Send to the LLM with the leaf prompt.
6. If the summary is larger than the input (LLM failure), retry with the aggressive prompt. If still too large, fall back to deterministic truncation.
7. Persist the summary, link to source messages, and replace the message range in context_items.

### Condensation

The **condensed pass** merges summaries at the same depth into a higher-level summary:

1. Find the shallowest depth with enough contiguous same-depth summaries (≥ `leafMinFanout` for d0, ≥ `condensedMinFanout` for d1+).
2. Concatenate their content with time range headers.
3. Send to the LLM with the depth-appropriate prompt (d1, d2, or d3+).
4. Apply the same escalation strategy (normal → aggressive → truncation fallback).
5. Persist with depth = targetDepth + 1, link to parent summaries, replace the range in context_items.

### Compaction modes

**Incremental (after each turn):**
- Checks if raw tokens outside the fresh tail exceed `leafChunkTokens`
- If so, runs one leaf pass
- If `incrementalMaxDepth > 0`, follows with condensation passes up to that depth
- Best-effort: failures don't break the conversation

**Full sweep (manual `/compact` or overflow):**
- Phase 1: Repeatedly runs leaf passes until no more eligible chunks
- Phase 2: Repeatedly runs condensation passes starting from the shallowest eligible depth
- Each pass checks for progress; stops if no tokens were saved

**Budget-targeted (`compactUntilUnder`):**
- Runs up to `maxRounds` (default 10) of full sweeps
- Stops when context is under the target token count
- Used by the overflow recovery path

### Three-level escalation

Every summarization attempt follows this escalation:

1. **Normal** — Standard prompt, temperature 0.2
2. **Aggressive** — Tighter prompt requesting only durable facts, temperature 0.1, lower target tokens
3. **Fallback** — Deterministic truncation to ~512 tokens with `[Truncated for context management]` marker

This ensures compaction always makes progress, even if the LLM produces poor output.

## Context assembly

The assembler runs before each model turn and builds the message array:

```
[summary₁, summary₂, ..., summaryₙ, message₁, message₂, ..., messageₘ]
 ├── budget-constrained ──┤  ├──── fresh tail (always included) ────┤
```

### Steps

1. Fetch all context_items ordered by ordinal.
2. Resolve each item — summaries become user messages with XML wrappers; messages are reconstructed from parts.
3. Split into evictable prefix and protected fresh tail (last `freshTailCount` raw messages).
4. Compute fresh tail token cost (always included, even if over budget).
5. Fill remaining budget from the evictable set, keeping newest items and dropping oldest.
6. Normalize assistant content to array blocks (Anthropic API compatibility).
7. Sanitize tool-use/result pairing (ensures every tool_result has a matching tool_use).

### XML summary format

Summaries are presented to the model as user messages wrapped in XML:

```xml
<summary id="sum_abc123" kind="leaf" depth="0" descendant_count="0"
         earliest_at="2026-02-17T07:37:00" latest_at="2026-02-17T08:23:00">
  <content>
    ...summary text with timestamps...

    Expand for details about: exact error messages, full config diff, intermediate debugging steps
  </content>
</summary>
```

Condensed summaries also include parent references:

```xml
<summary id="sum_def456" kind="condensed" depth="1" descendant_count="8" ...>
  <parents>
    <summary_ref id="sum_aaa111" />
    <summary_ref id="sum_bbb222" />
  </parents>
  <content>...</content>
</summary>
```

The XML attributes give the model enough metadata to reason about summary age, scope, and how to drill deeper. The `<parents>` section enables targeted expansion of specific source summaries.

## Expansion system

When summaries are too compressed for a task, agents use `lcm_expand_query` to recover detail.

### How it works

1. Agent calls `lcm_expand_query` with a `prompt` and either `summaryIds` or a `query`.
2. If `query` is provided, `lcm_grep` finds matching summaries first.
3. A **delegation grant** is created, scoping the sub-agent to the relevant conversation(s) with a token cap.
4. A sub-agent session is spawned with the expansion task.
5. The sub-agent walks the DAG: it can read summary content, follow parent links, access source messages, and inspect stored files.
6. The sub-agent returns a focused answer (default ≤ 2000 tokens) with cited summary IDs.
7. The grant is revoked and the sub-agent session is cleaned up.

### Security model

Expansion uses a delegation grant system:

- **Grants** are created at spawn time, scoped to specific conversation IDs
- **Token caps** limit how much content the sub-agent can access
- **TTL** ensures grants expire even if cleanup fails
- **Revocation** happens on completion, cancellation, or sweep

The sub-agent only gets `lcm_expand` (the low-level tool), not `lcm_expand_query` — preventing recursive sub-agent spawning.

## Large file handling

Files embedded in user messages (typically via `<file>` blocks from tool output) are checked at ingestion:

1. Parse file blocks from message content.
2. For each block exceeding `largeFileTokenThreshold` (default 25k tokens):
   - Generate a unique file ID (`file_` prefix)
   - Store the content to `~/.openclaw/lcm-files/<conversation_id>/<file_id>.<ext>`
   - Generate a ~200 token exploration summary (structural analysis, key sections, etc.)
   - Insert a `large_files` record with metadata
   - Replace the file block in the message with a compact reference
3. The `lcm_describe` tool can retrieve full file content by ID.

This prevents a single large file paste from consuming the entire context window while keeping the content accessible.

## Session reconciliation

LCM handles crash recovery through **bootstrap reconciliation**:

1. On session start, read the JSONL session file (OpenClaw's ground truth).
2. Compare against the LCM database.
3. Find the most recent message that exists in both (the "anchor").
4. Import any messages after the anchor that are in JSONL but not in LCM.

This handles the case where OpenClaw wrote messages to the session file but crashed before LCM could persist them.

## Operation serialization

All mutating operations (ingest, compact) are serialized per-session using a promise queue. This prevents races between concurrent afterTurn/compact calls for the same conversation without blocking operations on different conversations.

## Authentication

LCM needs to call an LLM for summarization. It resolves credentials through a three-tier cascade:

1. **Auth profiles** — OpenClaw's OAuth/token/API-key profile system (`auth-profiles.json`), checked in priority order
2. **Environment variables** — Standard provider env vars (`ANTHROPIC_API_KEY`, etc.)
3. **Custom provider key** — From models config (e.g., `models.json`)

For OAuth providers (e.g., Anthropic via Claude Max), LCM handles token refresh and credential persistence automatically.
