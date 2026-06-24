---
"@martian-engineering/lossless-claw": patch
---

Dedup adjacent delivery-mirror messages by content identity in `ingestSingle`. OpenClaw writes two JSONL entries per assistant turn — the model response (with reasoning + text) and a delivery-mirror (text only, `model="delivery-mirror"`). Both share the same `identity_hash` because `toStoredMessage` strips reasoning, but they have different transcript entry ids, so the entry-id idempotency check does not catch the mirror. This skips delivery-mirror ingestion only when the immediately previous assistant message has the same identity and preserved reasoning content, including top-level `reasoning_content` metadata.
