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
