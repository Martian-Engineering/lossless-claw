---
"@martian-engineering/lossless-claw": patch
---

Fix a race in the bootstrap existing-conversation path where a conversation
with a non-anchoring DB frontier (no overlapping content between the stored
messages and the JSONL transcript) would have `bootstrapped_at` set but no
`conversation_bootstrap_state` row persisted.

Without a checkpoint, every subsequent `afterTurn` reconcile classified the
conversation as `reason="checkpoint-missing"` with `allowNoAnchorImport=false`,
imported 0 messages, and skipped all persistence permanently. The conversation
froze at its pre-bootstrap message count while the JSONL transcript grew
unbounded.

The fix persists a bootstrap_state checkpoint whenever `markConversationBootstrapped`
succeeds, including the no-overlap/no-import case. This gives `afterTurn` a
checkpoint to work from and restores normal ingest/compaction operation.
