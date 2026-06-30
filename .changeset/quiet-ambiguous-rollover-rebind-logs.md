---
"@martian-engineering/lossless-claw": patch
---

Demote the happy-path ambiguous session-key rollover recovery logs from warn to info or debug, context-aware. The successful fresh-transcript rebind and the not-provably-fresh decision now log at info; the assemble pass's per-phase preserve restatement logs at debug; the fresh-rebind new-epoch import logs at info, and the afterTurn "frontier not covered" line logs at debug only on the benign ambiguous-rollover path.

The bootstrap and afterTurn preserve log keys off the freshness disposition carried out of the rebind attempt: a transient or unjudgeable verdict (no usable timestamps, delivery-only traffic, nothing comparable) is a pending state the next turn re-evaluates and logs at debug, while a conflicting verdict (identity overlap, or candidate entries predating persistence) is a genuine freeze and stays at warn. The rebind-failed and freshness-check exception paths, the no-anchor import-cap aborts, and every non-rollover unsafe-to-advance frontier skip also stay at warn. The freeze and no-merge protection is unchanged throughout; only log levels move.
