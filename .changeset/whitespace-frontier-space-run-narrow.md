---
"@martian-engineering/lossless-claw": patch
---

Recognize the specific OpenClaw runtime/transcript whitespace divergence, where core collapses runs of spaces in the runtime message to a single space while the transcript persists them verbatim, as one user turn during afterTurn frontier-coverage. This prevents a store double-write of the same turn without collapsing newlines, tabs, or leading and trailing whitespace, so two turns that differ in meaningful whitespace (line breaks or tab indentation) are never merged. Storage stays byte-verbatim; the persisted row is the survivor.
