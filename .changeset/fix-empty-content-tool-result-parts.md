---
"@martian-engineering/lossless-claw": patch
---

Fix tool-result pairing loss when a tool returns empty content. Tools like
OpenClaw's `update_plan` (and any third-party tool) that return
`{content: [], details: {...}}` produced zero `message_parts` rows on ingest,
losing the top-level `toolCallId`/`toolName`/`isError` pairing identity. On
assembly, the zero-part `role=tool` row was demoted to `role="assistant"` with
empty content and dropped by the empty-content filter, causing
`sanitizeToolUseResultPairing` to insert a synthetic "missing tool result"
error on every assemble while the call sat in the context window — the model
read its own plan calls as "failed" and retried in a loop. The fix emits one
identity-carrying fallback part in `buildMessageParts()` when a tool-result
message's content is an empty array, so assembly can reconstruct the
`toolResult` with the correct `toolCallId`. A canonical empty-tool-result
coverage signature is added to `message-signatures.ts` so live-coverage dedup
recognizes the live, DB-round-trip, and assembled representations of the same
logical result as identical.

Additionally fixes stable-event-key dedup dropping legitimate tool results
when tool-call ids are model-authored and recurrent (Kimi K3 `name:N`
counters like `exec:101`, reused across turns and even minutes). The
`ingestSingle` stable-event short-circuit treated `tool-result:<toolCallId>`
as conversation-globally unique, so every later reuse of a recurrent id was
silently skipped — calls persisted while their results vanished, and
assembly inserted synthetic "missing tool result" errors. `stable_event_key`
is now derived only from provably provider-unique tool-call id formats
(Anthropic `toolu_…`, OpenAI `call_…`); all other id shapes fall back to the
content/adjacency-bound dedup paths (preferring possible duplicates over data
loss). A colliding stable-key INSERT is degraded to a NULL-key persist with
a warning instead of being rejected by the partial unique index.
