---
"@martian-engineering/lossless-claw": patch
---

Dedup delivery-mirror messages by content identity in `ingestSingle`. OpenClaw writes two JSONL entries per assistant turn — the model response (with thinking + text) and a delivery-mirror (text only, `model="delivery-mirror"`). Both share the same `identity_hash` because `toStoredMessage` strips thinking, but they have different transcript entry ids, so the entry-id idempotency check does not catch the mirror. This adds a `hasRecentMessageByIdentity` check that skips delivery-mirror ingestion when a recent assistant message with the same identity hash already exists.
