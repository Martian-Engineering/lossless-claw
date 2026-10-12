---
"@martian-engineering/lossless-claw": minor
---

Record transcript history gaps. When a conversation enters cursor mode or resyncs, each run of storable transcript entries that Lossless Claw never stored and that sits before the anchor is saved as a marker in the new `conversation_transcript_gaps` table, and one warning reports the counts. `/lcm status`, `/lcm doctor`, `lcm status`, and `lcm conversations show` report the gaps. Markers are diagnostics only; nothing is imported or deleted.

Log quality: each incremental transcript drain logs one debug line with imported/restamped counts and duration; `assemble` logs when it reads the full visible transcript to fill missing replay keys; a session with no host transcript logs "transcript missing" once per conversation per process instead of on every turn.
