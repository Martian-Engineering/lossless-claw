---
"@martian-engineering/lossless-claw": patch
---

Fix an `afterTurn` deadlock where a conversation with `bootstrapped_at` set but no `conversation_bootstrap_state` row (`reason="checkpoint-missing"`) and a non-anchoring DB frontier (e.g. a single injected `Conversation info (untrusted metadata)` preamble) imported 0 messages and never persisted a checkpoint. Such conversations emitted the `found no anchor and imported 0 messages` / `did not cover the transcript frontier` warning pair on every turn forever, with compaction permanently disabled until the row was archived by hand.

The recovery path (`allowNoAnchorImportOnCheckpointMissing`) previously ran only on the rotate lane. The `afterTurn` lane now also recovers a `checkpoint-missing` no-anchor frontier, but only for already-bootstrapped conversations (`bootstrapped_at` set) — a never-bootstrapped conversation with a divergent rewritten transcript still freezes per #649's no-proof-no-advance guard. The downstream no-anchor import remains guarded by replay-overlap detection, the import cap, and the delivery-only block.

Fixes #837.
