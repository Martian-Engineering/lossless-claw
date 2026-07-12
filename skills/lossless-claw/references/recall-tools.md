# Recall Tools

Use recall tools when the question depends on exact historical evidence from compacted context.

## Tool selection

### `lcm_grep`

Use for:

- finding whether a term, file name, error string, or identifier appears in compacted history
- narrowing the search space before deeper inspection

Do not use it for:

- answering detail-heavy questions by itself

### `lcm_describe`

Use for:

- inspecting a specific summary or stored-file record by ID
- reading lineage and content for a known summary node

Do not use it for:

- broad discovery when you do not know the target ID yet

### `lcm_expand_query`

Use for:

- focused questions that need richer detail recovered from summaries
- evidence-oriented follow-up after `lcm_grep` or `lcm_describe`

Cross-conversation expansion runs its selected conversation buckets under one shared deadline and one shared token budget. Completed buckets still return evidence when a sibling bucket times out. Failure results identify the affected conversation, summary IDs, phase, and error code; they never invent answer text for interrupted work.

This is the best recall tool when the user asks for:

- exact commands
- exact file paths
- precise timestamps
- root-cause chains

### `lcm_expand`

Treat as a specialized sub-agent flow, not the default first step.

## Recommended workflow

1. Start with `lcm_grep` to find likely evidence.
2. Use `lcm_describe` when you have a summary or file ID.
3. Use `lcm_expand_query` when the answer requires precise recovery rather than a high-level summary.

## Conversation scope

When `conversationId` is omitted, recall tools use the current session family: the active conversation plus archived segments that share the same stable session identity. This preserves recall across session rotation and `/reset` replacement rows.

Use `conversationId` only when you need one specific physical conversation. Use `allConversations: true` for broad discovery across unrelated sessions.

## Important guardrail

Do not infer exact details from summaries alone when the user needs evidence. Expand first or state that the answer still needs expansion.
