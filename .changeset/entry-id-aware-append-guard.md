---
"@martian-engineering/lossless-claw": patch
---

Judge append-only transcript imports by entry id, not content identity.

A tool loop that re-issues a byte-identical tool call every iteration made
the append-only import guard declare each appended pair "already persisted"
(content identity matched the previous iteration), forcing a full transcript
re-read per tool call while the covered-frontier alignment refused every
runtime batch — reconcile churned on every iteration of the loop while the
model's context stopped advancing (live incident lossless-claw-3071).

The guard now reasons in transcript entry ids: a fresh entry id is a new
entry regardless of content. Full reconciliation is still required for the
three cases that genuinely need it — an already-persisted entry id (replay),
a fresh id whose content matches an unstamped persisted row (flush-lag
catch-up that must adopt, not duplicate), and an entry reparenting onto a
non-tip persisted entry (host suffix rewrite needing stale-id re-stamping).
Parents unknown to the DB (pruned rows, replay-filtered entries) are treated
as genuine continuation since the append-only checkpoint already verified
the file prefix.
