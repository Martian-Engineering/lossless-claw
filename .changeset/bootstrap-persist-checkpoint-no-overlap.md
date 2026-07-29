---
"@martian-engineering/lossless-claw": patch
---

Fix an ingest-before-bootstrap race where a conversation with only
non-anchoring injected metadata rows could not establish a safe transcript
checkpoint when those rows did not overlap the JSONL transcript.

Without a checkpoint, every subsequent `afterTurn` reconcile classified the
conversation as `reason="checkpoint-missing"` with `allowNoAnchorImport=false`,
imported 0 messages, and skipped all persistence permanently. The conversation
froze at its pre-bootstrap message count while the JSONL transcript grew
unbounded.

The fix reuses the bounded non-anchoring-frontier proof from checkpoint-missing
recovery. Bootstrap imports the readable transcript before persisting its
checkpoint, then subsequent `afterTurn` calls resume normally. Conversations
with real divergent history or unreadable transcripts remain fail-closed so an
unrelated transcript cannot contaminate stored history.
