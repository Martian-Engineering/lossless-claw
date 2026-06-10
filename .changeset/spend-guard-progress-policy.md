---
"@martian-engineering/lossless-claw": patch
---

Stop punishing progressing compaction with the summary spend backoff.

A threshold sweep that hit its per-sweep wall-clock deadline while still
reducing tokens recorded "compacted but still over target" and opened a
30-minute spend backoff, which then blocked emergency drains and silently
no-opped user-initiated /compact. Recovery that was working was treated the
same as recovery that could never work.

Threshold sweeps now chain within the operation-wide deadline
(`compactUntilUnderDeadlineMs`, capped by `maxSweepIterations`) instead of
failing after one bounded sweep; the spend backoff only opens when a round
makes no further progress; and manual compaction clears an open backoff
(an explicit repair request is informed consent to spend). Telemetry: the
compact done line gains `chainedSweeps=`/`spendBackoffOpened=`, plus
"spend backoff skipped" and "manual request cleared summary spend backoff"
lines for live monitoring.
