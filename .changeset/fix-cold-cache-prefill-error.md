---
"@martian-engineering/lossless-claw": patch
---

Fix prefill errors on cold-cache new sessions that start with only an assistant greeting.

When a session begins with an agent greeting before any user message and the Anthropic
prompt cache goes cold (>5 min), `assemble()` could return a context containing only
the assistant greeting with no user turns. Providers that require conversations to end
with a user message would then reject the LLM call, silently dropping the user's first
real message.

`assemble()` now detects when the assembled context contains no user-role messages at
all (raw-message-only DB state where every stored message is `assistant` or `toolResult`)
and falls back to the live context, which correctly ends with the user's current message.
Sessions with compaction summaries are unaffected because summaries are always stored
with `role: "user"`.
