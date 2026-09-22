---
"@martian-engineering/lossless-claw": patch
---

Adopt a projected transcript entry id onto a live-ingested user row by the row's created time when the message body repeats in the projection. Repeated bodies such as restart-recovery prompts were imported as a second row, and assembly then alternated between the two rows across runs, breaking the provider prompt-cache prefix.

Require unambiguous matches in both the stored history and the full projection before assigning entry IDs. Preserve ambiguity across timestamp adoption and anchor audit, including nearby repeats and missing timestamps.
