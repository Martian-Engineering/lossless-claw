# Agent tools

LCM provides four tools for agents to search, inspect, and recall information from compacted conversation history.

## Usage patterns

### Escalation pattern: grep → describe → expand_query

Most recall tasks follow this escalation:

1. **`lcm_grep`** — Find relevant summaries or messages by keyword/regex
2. **`lcm_describe`** — Inspect a specific summary's full content (cheap, no sub-agent)
3. **`lcm_expand_query`** — Deep recall: spawn a sub-agent to expand the DAG and answer a focused question

Start with grep. If the snippet is enough, stop. If you need full summary content, use describe. If you need details that were compressed away, use expand_query.

### When to expand

Summaries are lossy by design. The "Expand for details about:" footer at the end of each summary lists what was dropped. Use `lcm_expand_query` when you need:

- Exact commands, error messages, or config values
- File paths and specific code changes
- Decision rationale beyond what the summary captured
- Tool call sequences and their outputs
- Verbatim quotes or specific data points

`lcm_expand_query` is bounded (~120s, scoped sub-agent) and relatively cheap. Don't ration it.

## Tool reference

### lcm_grep

Search across messages and/or summaries using regex or full-text search.

Use `mode: "full_text"` for keyword or topical recall. Wrap exact multi-word phrases in quotes to preserve phrase matching. Keep the default `sort: "recency"` for recent events, switch to `sort: "relevance"` when looking for the best older match on a topic, and use `sort: "hybrid"` when you want relevance without giving up recency entirely.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pattern` | string | ✅ | — | Search pattern |
| `mode` | string | | `"regex"` | `"regex"` or `"full_text"` |
| `scope` | string | | `"both"` | `"messages"`, `"summaries"`, or `"both"` |
| `conversationId` | number | | current | Specific conversation to search |
| `allConversations` | boolean | | `false` | Search all conversations |
| `since` | string | | — | ISO timestamp lower bound |
| `before` | string | | — | ISO timestamp upper bound |
| `limit` | number | | 50 | Max results (1–200) |
| `sort` | string | | `"recency"` | `"recency"`, `"relevance"`, or `"hybrid"` for full-text ranking |

**Returns:** Array of matches with:
- `id` — Message or summary ID
- `type` — `"message"` or `"summary"`
- `snippet` — Truncated content around the match
- `conversationId` — Which conversation
- `createdAt` — Timestamp
- For summaries: `depth`, `kind`, `summaryId`

**Examples:**

```
# Full-text search across all conversations
lcm_grep(pattern: "database migration", mode: "full_text", allConversations: true)

# Older-topic recall ranked by FTS relevance
lcm_grep(pattern: "\"error handling\" retries", mode: "full_text", sort: "relevance")

# Regex search in summaries only
lcm_grep(pattern: "config\\.threshold.*0\\.[0-9]+", scope: "summaries")

# Recent messages containing a specific term
lcm_grep(pattern: "deployment", since: "2026-02-19T00:00:00Z", scope: "messages")
```

### lcm_describe

Look up metadata and content for a specific summary or stored file.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | ✅ | — | `sum_xxx` for summaries, `file_xxx` for files |
| `conversationId` | number | | current | Scope to a specific conversation |
| `allConversations` | boolean | | `false` | Allow cross-conversation lookups |

**Returns for summaries:**
- Full summary content
- Metadata: depth, kind, token count, created timestamp
- Time range (earliestAt, latestAt)
- Descendant count
- Parent summary IDs (for condensed summaries)
- Child summary IDs
- Source message IDs (for leaf summaries)
- File IDs referenced in the summary

**Returns for files:**
- File content (full text)
- Metadata: fileName, mimeType, byteSize
- Exploration summary
- Storage path

**Examples:**

```
# Inspect a summary from context
lcm_describe(id: "sum_abc123def456")

# Retrieve a stored large file
lcm_describe(id: "file_789abc012345")
```

### lcm_expand_query

Answer a focused question by expanding summaries through the DAG. Spawns a bounded sub-agent that walks parent links down to source material and returns a compact answer.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | ✅ | — | The question to answer |
| `query` | string | ✅* | — | Text query to find summaries (if no `summaryIds`) |
| `summaryIds` | string[] | ✅* | — | Specific summary IDs to expand (if no `query`) |
| `maxTokens` | number | | 2000 | Answer length cap |
| `conversationId` | number | | current | Scope to a specific conversation |
| `allConversations` | boolean | | `false` | Search across all conversations |

*One of `query` or `summaryIds` is required.

**Returns:**
- `answer` — The focused answer text
- `citedIds` — Summary IDs that contributed to the answer
- `expandedSummaryCount` — How many summaries were expanded
- `totalSourceTokens` — Total tokens read from the DAG
- `truncated` — Whether the answer was truncated to fit maxTokens

**Examples:**

```
# Find and expand summaries about a topic
lcm_expand_query(
  query: "OAuth authentication fix",
  prompt: "What was the root cause and what commits fixed it?"
)

# Expand specific summaries you already have
lcm_expand_query(
  summaryIds: ["sum_abc123", "sum_def456"],
  prompt: "What were the exact file changes?"
)

# Cross-conversation search
lcm_expand_query(
  query: "deployment procedure",
  prompt: "What's the current deployment process?",
  allConversations: true
)
```

### lcm_expand

Low-level DAG expansion tool. **Only available to sub-agents** spawned by `lcm_expand_query`. Main agents should always use `lcm_expand_query` instead.

This tool is what the expansion sub-agent uses internally to walk the summary DAG, read source messages, and build its answer.

## Tips for agent developers

### Configuring agent prompts

Add instructions to your agent's system prompt so it knows when to use LCM tools:

```markdown
## Memory & Context

Use LCM tools for recall:
1. `lcm_grep` — Search all conversations by keyword/regex. Prefer `mode: "full_text"` for topic recall, quote exact phrases, use `sort: "relevance"` for older-topic lookups, and `sort: "hybrid"` when recency should still matter.
2. `lcm_describe` — Inspect a specific summary (cheap, no sub-agent)
3. `lcm_expand_query` — Deep recall with sub-agent expansion

When summaries in context have an "Expand for details about:" footer
listing something you need, use `lcm_expand_query` to get the full detail.
```

### Conversation scoping

By default, tools operate on the current conversation. Use `allConversations: true` to search across all of them (all agents, all sessions). Use `conversationId` to target a specific conversation you already know about (from previous grep results).

### Performance considerations

- `lcm_grep` and `lcm_describe` are fast (direct database queries)
- `lcm_expand_query` spawns a sub-agent and takes ~30–120 seconds
- The sub-agent has a 120-second timeout with cleanup guarantees
- Token caps (`LCM_MAX_EXPAND_TOKENS`) prevent runaway expansion
