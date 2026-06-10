---
"@martian-engineering/lossless-claw": patch
---

Resolve ambiguous session-key runtime rollovers when the new transcript is provably fresh.

When a runtime session rolls to a new sessionId while the key's conversation
still tracks an existing transcript file, the ambiguity guard froze the lane
entirely: no adoption, no rotation, no persistence — indefinitely. On a live
instance two agent main lanes ran frozen for a week, silently recording
nothing while their transcripts grew.

bootstrap and afterTurn now attempt a tier-2 resolution using full-transcript
evidence: when the rolled transcript is provably fresh — every entry carries
a usable timestamp (message or envelope) postdating the conversation's last
persisted message, and no entry's identity overlaps the conversation's recent
persisted history — the rollover is a legitimate reset, so the old
conversation is archived (fully preserved and queryable) and the new session
binds and bootstraps normally. Freshness is judged on content+time evidence,
never transcript size, so lanes that ran frozen for days self-heal on their
first turn after upgrade. Anything short of proof (overlap, stale or missing
timestamps, no comparable persisted content) stays frozen exactly as before,
and a rotation that lands as a lifecycle no-op is reported honestly instead
of claiming the lane healed. assemble deliberately does NOT rotate: it only
sees the host's live window, which is not transcript evidence.

Telemetry: "ambiguous rollover resolved by fresh-transcript rotation",
"ambiguous rollover not provably fresh (freshness=...)", and "rotation had
no effect" warn lines.
