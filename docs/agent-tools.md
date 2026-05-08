# Agent tools

LCM provides 8 tools for agents to search, inspect, recall, and synthesize information from compacted conversation history. Pick by **question type**, not by tool name — routing this way makes the right one obvious.

## The 5 question types

A real person with continuity of memory can answer 5 types of questions about their past. These are LCM's job (full text in `docs/v4.1/THE_FIVE_QUESTIONS.md`):

| Type | Question | Primary tool(s) |
|---|---|---|
| **A. Time-anchored** | "What did we work on yesterday?" / "Last week?" | `lcm_synthesize_around` (with `window_kind="period"` + period shortcut OR explicit since/before) |
| **B. Topic-anchored** | "Have we ever discussed X?" | `lcm_grep` (modes: `hybrid` / `semantic` / `full_text` / `regex`) — `mode='hybrid'` for best recall, `mode='semantic'` for cost-cheap pure-vector |
| **C. Verbatim** | "Quote what Eva exactly said" | `lcm_grep` mode=`verbatim` |
| **D. Pattern-anchored / entity** | "Who is this person?" / "history of project X" | `lcm_get_entity`, `lcm_search_entities` |
| **E. Drilldown** | "Where did this come from?" | `lcm_describe` (with `expandChildren` / `expandMessages`), `lcm_expand_query` |

## Routing decision tree

```
Question references a specific time / period?       → A: lcm_synthesize_around (window_kind=period or time)
Question references a topic / paraphrastic concept? → B: lcm_grep mode=hybrid (best recall)
                                                          OR lcm_grep mode=semantic (cheaper, embedding-only)
Need exact wording / quote?                         → C: lcm_grep mode=verbatim (full message rows, role filter)
Question references a recurring entity / person?    → D: lcm_get_entity (exact) / lcm_search_entities (fuzzy)
Need to drill from a summary back to its source?    → E: lcm_describe (one-hop) / lcm_expand_query (deep, sub-agent)
```

## Tool reference

### lcm_grep — hybrid search (5 modes)

Search messages and summaries via FTS5, regex, embeddings, rerank, or full verbatim.

**Modes:**
- `regex` — RE2-style pattern over message+summary content. No NLU. Best for literal patterns (filenames, commit hashes, error codes).
- `full_text` — FTS5 keyword search. Defaults to AND matching; quote phrases.
- `hybrid` — FTS + Voyage semantic + Voyage rerank. **Best paraphrastic recall** ("merge mess" finds "rebase blew up"). Voyage retries capped at 1×15s.
- `semantic` — Pure embedding KNN, no rerank. Cheaper than hybrid; emits `confidenceBand` (high/medium/low/noise/no-match).
- `verbatim` — Returns FULL untruncated message rows (not snippets), with optional `role` filter (`user`/`assistant`/`tool`/`system`/`all`). For citation use cases.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `pattern` | string | ✅ | — | Search pattern. Empty rejected. FTS5 syntax sanitized for verbatim mode. |
| `mode` | string | | `"regex"` | `regex` / `full_text` / `hybrid` / `semantic` / `verbatim` |
| `scope` | string | | `"both"` | `messages`, `summaries`, or `both` (regex/full_text only) |
| `role` | string | | — | `user` / `assistant` / `tool` / `system` / `all` (verbatim only) |
| `conversationId` | number | | current session family | Scope |
| `allConversations` | boolean | | `false` | Search every conversation |
| `since` / `before` | string | | — | ISO timestamp bounds |
| `limit` | number | | 50 | 1–200 (capped at 20 for verbatim) |
| `sort` | string | | `recency` | `recency` / `relevance` / `hybrid` (full_text/regex modes) |

**Routing tips:**

- **For paraphrastic queries** ("did we discuss X?"), prefer `mode: hybrid`. The Voyage rerank reliably beats FTS-only on stratified eval (+52.5pp on paraphrastic queries per the spike report).
- **For citation / "exactly what was said"**, use `mode: verbatim`. Combine with `role` to get just user prompts or just tool outputs.
- **FTS5 syntax**: defaults to AND. Quote multi-word phrases. Bare boolean operators (`AND`/`OR`/`NOT`) without operands will error.
- **`v4.1`-style patterns** with dots/brackets/leading-hyphen are auto-sanitized for verbatim mode (they error in raw FTS5 otherwise).

### Note: pure-vector recall lives in `lcm_grep mode='semantic'` (Wave-12 consolidation)

The standalone `lcm_semantic_recall` tool was removed and folded into `lcm_grep` as `mode='semantic'`. Same Voyage embed call, same confidence-band calibration, same output shape (`details.hits[]` with `cosineSimilarity` + top-level `confidenceBand`). Use `lcm_grep { pattern, mode: 'semantic', summaryKinds?: ['leaf'|'condensed'] }` for cost-cheap paraphrastic exploration without rerank.

### lcm_synthesize_around — fresh windowed synthesis

Builds a freshly-synthesized summary of leaves "around" a window. Three modes:

- **`window_kind="period"`** (the `lcm_recent` replacement) — direct date-range or period-shortcut selection. **No anchor required.** Pass `period` (string shortcut) or explicit `since`/`before`.
  - Period shortcuts: `today`, `yesterday`, `this-week`, `last-week`, `this-month`, `last-month`, `last-Nh` (e.g. `last-12h`), `last-Nd` (e.g. `last-3d`), `last-7-days`, `last-30-days`.
- **`window_kind="time"`** — `target` summary_id required. Selects leaves within `±windowHours` of the target's `created_at`.
- **`window_kind="semantic"`** — `target` summary_id OR free-text query required. Selects top-`windowK` most-similar leaves.

The selected leaves are concatenated and sent through `dispatchSynthesis` (per-tier model). Result is persisted to `lcm_synthesis_cache` so identical follow-up calls hit cache (single-flight via `INSERT OR IGNORE` on the unique lookup index).

**Examples:**

```
# "What did we work on yesterday?" — direct period recall, no anchor required
lcm_synthesize_around(window_kind: "period", period: "yesterday")

# "What was happening around the rebase fix?" — anchored time window
lcm_synthesize_around(window_kind: "time", target: "sum_abc123", windowHours: 24)

# "What did we work on this month?"
lcm_synthesize_around(window_kind: "period", period: "this-month")

# Custom range
lcm_synthesize_around(window_kind: "period", since: "2026-05-01T00:00:00Z", before: "2026-05-07T00:00:00Z")

# Semantic window — top-K leaves most similar to a query
lcm_synthesize_around(window_kind: "semantic", target: "voyage rate limiting", windowK: 30)
```

### lcm_describe — summary lineage + one-hop expansion

Look up metadata, content, lineage, and (optionally) one-hop expansion for a specific summary or stored file.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `id` | string | ✅ | — | `sum_xxx` for summaries, `file_xxx` for files |
| `expandChildren` | boolean | | `false` | Inline-expand child summaries (capped at 20, suppression-filtered). Sets `childrenStatus` field. |
| `expandMessages` | boolean | | `false` | Inline-expand source messages (capped at 20 by default). Pair with `expandMessagesOffset` + `expandMessagesLimit` for paging. |
| `expandMessagesOffset` | number | | 0 | Offset for message expansion paging |
| `expandMessagesLimit` | number | | 20 | Per-page limit (max 50) |

**Returns** lineage (parents, children, descendant manifest), token costs, `budgetCap` (when delegated through sub-agent), and — when expansion flags set — an inline `expansion` block with the children/messages.

### lcm_expand_query — deep recall via sub-agent

Answer a focused question by expanding summaries through the DAG. Spawns a bounded sub-agent (~120s) that walks parent links down to source material and returns a compact answer.

**Parameters:**

| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `prompt` | string | ✅ | — | The question to answer |
| `query` | string | ✅* | — | Text query to find seed summaries |
| `summaryIds` | string[] | ✅* | — | Explicit seed summary IDs |
| `maxTokens` | number | | 2000 | Answer length cap |
| `conversationId` | number | | current session family | Scope |
| `allConversations` | boolean | | `false` | Cross-conversation synthesis (bounded; ranks buckets, expands top few) |

*One of `query` or `summaryIds` required.

### lcm_expand — sub-agent only

Low-level DAG expansion tool. **Only callable from sub-agents spawned by `lcm_expand_query`.** Main agents must always use `lcm_expand_query`. The grant ledger gate at registration time enforces this — calling from a main agent surfaces a permission error.

### lcm_get_entity — exact entity lookup

Retrieve a specific entity by canonical name. Populated by the async entity-coreference worker (default-on; opt out via `LCM_EXTRACTION_LLM_ENABLED=false`).

**Parameters:** `name`, `entityType?`, `mentionLimit?`, `conversationId?`, `allConversations?`.

**Returns** entity record + recent mentions, OR `{found: false, message: "..."}` when not in catalog. The entity-type list (e.g. `person_name`, `pr_number`, `agent_id`, `command`, `file_path`, `date`) is what the LLM extractor produces — discover via `lcm_search_entities` without a type filter.

### lcm_search_entities — fuzzy entity discovery

List/fuzzy-search entities. Returns `details.catalogStatus` (`active` / `empty-for-session` / `empty-globally`) so empty results can be distinguished from "no extraction has run yet."

## Common patterns

### "What did we work on yesterday?" (Type A)

```
lcm_synthesize_around(window_kind: "period", period: "yesterday")
```

### "Have we ever debugged a similar race condition?" (Type B)

```
lcm_grep(pattern: "race condition empty plan body", mode: "hybrid", limit: 10, allConversations: true)
```

### "Quote Eva's exact words rejecting lcm_recent" (Type C)

```
lcm_grep(pattern: "lcm_recent", mode: "verbatim", role: "user", limit: 5, allConversations: true)
```

### "Who is the operator-VM customer? show all mentions" (Type D)

```
lcm_get_entity(name: "operator-VM customer", mentionLimit: 20)
# or fuzzy:
lcm_search_entities(query: "operator", limit: 10)
```

### "Where did this synthesis claim come from?" (Type E)

```
# Cheap one-hop drilldown:
lcm_describe(id: "sum_abc123", expandChildren: true)

# Or for deep traversal:
lcm_expand_query(summaryIds: ["sum_abc123"], prompt: "Show me the source leaves that grounded the +52.5pp claim")
```

## Performance + cost

| Tool | Cost | Latency | Notes |
|---|---|---|---|
| `lcm_describe` | Free (DB only) | <50ms | One-hop expansion is also free |
| `lcm_grep` modes `regex`/`full_text`/`verbatim` | Free | <100ms | FTS5 sanitized + indexed |
| `lcm_grep` mode `semantic` | ~$0.0002/query | ~400ms | Voyage embed only; capped 1×15s retry |
| `lcm_grep` mode `hybrid` | ~$0.0005/query | ~800ms | Voyage embed + rerank; capped 1×15s × 2 calls |
| `lcm_get_entity` / `lcm_search_entities` | Free | <50ms | Pre-built catalog |
| `lcm_synthesize_around` | LLM-backed | 5–30s | Cached by (session, range, leaves); 2nd identical call returns cached |
| `lcm_expand_query` | LLM-backed | 30–120s | Sub-agent with bounded budget |

## Conversation scoping

By default, tools operate on the **current session family**: the active conversation plus archived segments that share the same stable session identity. This keeps recall continuous across session rotation and `/reset` without leaking unrelated sessions.

- Use `allConversations: true` when you need broad global discovery
- Use `conversationId: <id>` when you already know the exact physical conversation
- Entity tools (`lcm_get_entity`, `lcm_search_entities`) are session-scoped by default; pass explicit `sessionKey` to widen

## Suppression / hard-purge

LCM v4.1 ships **soft suppression only**: `/lcm purge` (or programmatic suppression) sets `suppressed_at` on summaries + messages, cascades to vec0 metadata, and invalidates dependent synthesis cache rows. The DB rows themselves remain — they are NOT byte-deleted. Read-paths filter on `suppressed_at IS NULL` so the agent can never see suppressed content.

For GDPR/erasure requiring physical removal: until the hard-delete drainer ships (preserved in PR #616), an operator must run raw `DELETE FROM messages/summaries WHERE summary_id IN (...)` followed by `VACUUM` out-of-band. SQL VACUUM alone after soft-purge does NOT remove the underlying data because the rows remain (just with `suppressed_at` set).
