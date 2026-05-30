# Recall Tools

Use recall tools when the question depends on exact historical evidence from compacted context.

## Tool selection

### `lcm_grep`

Use for:

- finding whether a term, file name, error string, or identifier appears in compacted history
- narrowing the search space before deeper inspection

Do not use it for:

- answering detail-heavy questions by itself

### `lcm_recall_keys`

Use for:

- recovering exact all-caps identifier facts from raw message evidence
- post-rotation cases where a prompt asks for a key but active summaries/tail omit the value

Do not use it for:

- secrets or secret-shaped identifiers such as `API_KEY`, `TOKEN`, or `PRIVATE_KEY`
- broad topical discovery; use `lcm_grep` for that

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

This is the best recall tool when the user asks for:

- exact commands
- exact file paths
- precise timestamps
- root-cause chains

### `lcm_expand`

Treat as a specialized sub-agent flow, not the default first step.

## Recommended workflow

1. Use `lcm_recall_keys` first when the prompt asks for an exact all-caps identifier key.
2. Start with `lcm_grep` to find likely evidence for broader topics.
3. Use `lcm_describe` when you have a summary or file ID.
4. Use `lcm_expand_query` when the answer requires precise recovery rather than a high-level summary.

## Conversation scope

When `conversationId` is omitted, recall tools use the current session family: the active conversation plus archived segments that share the same stable session identity. This preserves recall across session rotation and `/reset` replacement rows.

Use `conversationId` only when you need one specific physical conversation. Use `allConversations: true` for broad discovery across unrelated sessions.

## Important guardrail

Do not infer exact details from summaries alone when the user needs evidence. Expand first or state that the answer still needs expansion.
