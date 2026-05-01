# Recall Tools

Use recall tools when the answer depends on historical evidence from compacted conversation history.

## Availability

`lcm_recent` and `lcm_rollup_debug` are temporal-memory stack tools. Before choosing either one, check the active tool list for the current runtime. If the tool is absent, do not treat this reference as permission to call it; approximate time-window recall with `lcm_grep` plus bounded expansion and say the coverage is approximate.

## Decision table

| Need                                                               | Start with                                      | Then verify with                                      |
| ------------------------------------------------------------------ | ----------------------------------------------- | ----------------------------------------------------- |
| Recap by known time window                                         | `lcm_recent` only if active; otherwise `lcm_grep` | `lcm_describe` / `lcm_expand_query` for proof       |
| Keyword, PR, file, customer, error, or identifier search           | `lcm_grep`                                      | `lcm_describe` / `lcm_expand_query`                   |
| Known summary or file ID                                           | `lcm_describe`                                  | `lcm_expand` / `lcm_expand_query` if needed           |
| Exact command, path, timestamp, root cause, or shipped-proof claim | `lcm_recent` or `lcm_grep` only to narrow       | `lcm_describe` / `lcm_expand_query` before asserting  |
| Rollup freshness/provenance/debugging                              | `lcm_rollup_debug` only if active               | Source drilldown if needed                            |

## Tool selection

Proof path:

- `lcm_recent`, when available, is the best entry point for recap by time window, but it is **not** the final evidence layer.
- When the user needs exact commands, file paths, timestamps, root causes, or proof of what shipped/was decided, verify the returned source IDs with `lcm_describe` or recover exact evidence with `lcm_expand_query`.
- If the temporal-memory PR stack is not merged yet, or `lcm_recent` is unavailable in the current runtime, fall back to `lcm_grep` plus bounded expansion and say the temporal coverage is approximate.

### `lcm_recent`

Use first for **clearly time-bounded episodic recall** only when the tool is available: when the user asks what happened **today**, **yesterday**, **this week**, **this month**, or inside a known local-time window.

Local-time windows use this precedence: explicit tool timezone if supported and provided, then the runtime's effective LCM timezone, then the configured/system fallback. Treat returned ranges as start-inclusive and end-exclusive.

Good prompts for `lcm_recent`:

- "What did we do yesterday?" → `period: "yesterday"`
- "What happened yesterday afternoon?" → `period: "yesterday afternoon"`
- "What were we doing between 4 and 8pm?" → resolve the date from context, then use `period: "today 4-8pm"` or `period: "yesterday 4-8pm"`
- "What happened while I was away this afternoon?" → use the known local window
- "What happened in the last 3 hours?" → `period: "last 3h"`
- "What did we work on this week?" → `period: "week"` or `period: "7d"`
- "What themes or follow-ups came up this month?" → `period: "month"`

Why use it:

- Answers timeline-shaped questions without keyword guessing.
- Uses prebuilt day/week/month rollups when available.
- Falls back to bounded source summaries for precise windows.
- Keeps provenance available so you can drill down when exact evidence is needed.
- Serves as the right entry tool for recap, not the last tool for proof.

Important limits:

- `lcm_recent` is a recap/narrowing tool, not final proof for exact commands, paths, timestamps, root causes, or shipped claims.
- For event-bounded questions like "after the restart" or "since the dependency broke," first anchor the event time/window if it is not already known. Use `lcm_grep`, diagnostics, logs, or other evidence to find the timestamp, then run `lcm_recent` over the post-event window.
- Weekly/monthly `lcm_recent` is good for recap and themes. Verify specific "shipped" or "decided" claims with expansion before asserting them as facts.
- If `lcm_recent` is not available in the current runtime, say so and approximate with `lcm_grep` plus bounded expansion; do not pretend a rollup was queried.

Do not use it for:

- keyword discovery when the time range is unknown
- exact source-level proof by itself; follow with `lcm_describe`, `lcm_expand`, or `lcm_expand_query` when precision matters

### `lcm_grep`

Use for:

- finding whether a term, file name, error string, PR number, customer name, or identifier appears in compacted history
- discovering the time window for event-bounded questions when the user did not provide one
- narrowing the search space when the question is keyword-shaped rather than time-shaped
- adding `since` and/or `before` ISO filters when you have an approximate timeframe

Call shape:

- `lcm_grep` accepts an optional `conversationId`. When the runtime has resolved the current session's conversation scope, omitting `conversationId` uses that conversation by default. If no conversation scope is resolved, provide `conversationId` or set `allConversations=true`.

Do not use it for:

- timeline questions like "what happened yesterday afternoon?" when the window is already known and `lcm_recent` is available; start with `lcm_recent` instead. If `lcm_recent` is unavailable, use `lcm_grep` plus bounded expansion and state the coverage limit.
- answering detail-heavy questions by itself

### `lcm_describe`

Use for:

- cheap inspection of a specific summary or stored-file record by ID
- checking lineage and content for a known summary node before doing expensive expansion
- verifying source IDs returned by `lcm_recent`

Do not use it for:

- broad discovery when you do not know the target ID yet

### `lcm_expand_query`

Use for:

- focused questions that need richer detail recovered from summaries
- evidence-oriented follow-up after `lcm_recent`, `lcm_grep`, or `lcm_describe`

This is the best recall tool when the user asks for:

- exact commands
- exact file paths
- precise timestamps
- root-cause chains
- proof or citations from the recovered history
- a verified list of shipped/merged/decided items

### `lcm_expand`

Treat as a specialized expansion flow for known summary IDs, not the default first step.

### `lcm_rollup_debug`

Use for operator/debugging work only, and only when this tool exists in the current runtime:

- checking whether day/week/month rollups exist for a conversation
- inspecting rollup freshness, source IDs, and provenance chains
- diagnosing why `lcm_recent` fell back to source summaries instead of a prebuilt rollup

Do not use it for normal user-facing recall unless you are debugging the LCM layer itself.

## Recommended workflow

### Time-shaped question

Examples: "what happened yesterday?", "what did we do after lunch?", "what did we work on this week?"

1. If `lcm_recent` is available, start with it for the smallest useful period/window; otherwise use `lcm_grep` with ISO `since`/`before` bounds when possible.
2. If the answer needs proof, inspect the returned source IDs with `lcm_describe` or expand them.
3. Use `lcm_expand_query` when synthesis across the returned sources is needed.

### Event-bounded question

Examples: "what happened after the restart?", "what changed since the dependency broke?"

1. Anchor the event time/window first. If it is unknown, locate it with `lcm_grep`, logs, diagnostics, or the relevant system source.
2. If `lcm_recent` is available, run it over the known post-event local window, such as `last 3h` or `date:YYYY-MM-DD HH:MM-HH:MM`; otherwise use bounded `lcm_grep`.
3. Verify exact claims with `lcm_describe` or `lcm_expand_query`.

### Keyword-shaped question

Examples: "find the ENOTEMPTY incident", "where did we mention PR #15?"

1. Start with `lcm_grep` using 1-3 distinctive terms.
2. Use `lcm_describe` when you have a promising summary/file ID.
3. Use `lcm_expand_query` when the answer requires precise recovery rather than a high-level summary.

### Mixed time + topic question

Examples: "what happened with the incident yesterday afternoon?", "what did we decide about LCM this week?"

1. If `lcm_recent` is available, start with it to bound the period; otherwise start with `lcm_grep` using the topic plus approximate time filters.
2. If the result is too broad, use topic terms with `lcm_grep` or expand the returned sources.
3. Finish with `lcm_expand_query` if the user needs a synthesized answer with exact details.

## Important guardrail

Do not infer exact details from summaries or rollups alone when evidence is required. Expand first or state that the answer still needs expansion.

## End-to-end example

Question: "What happened after the restart yesterday afternoon, and what exact command fixed it?"

1. Anchor the restart time first from logs/diagnostics or `lcm_grep` if the time is not already known.
2. If available, run `lcm_recent(period: "date:<known-day> 14:00-18:00")` or the equivalent post-event window to get a recap and source IDs.
3. Inspect the most relevant returned source IDs with `lcm_describe` to confirm which summary/file covers the fix.
4. Run `lcm_expand_query` over those source IDs with a prompt like "What exact command fixed the issue after the restart, and when was it run?"
5. Answer from the expanded evidence, not from the recap alone.

If `lcm_recent` is unavailable, say so and approximate the same flow with `lcm_grep` plus bounded expansion.
