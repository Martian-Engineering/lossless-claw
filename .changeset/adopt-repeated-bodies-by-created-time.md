---
"@martian-engineering/lossless-claw": patch
---

Adopt a projected transcript entry id onto a live-ingested user row by the row's created time when the message body repeats in the projection. Repeated bodies such as restart-recovery prompts were imported as a second row, and assembly then alternated between the two rows across runs, breaking the provider prompt-cache prefix.
