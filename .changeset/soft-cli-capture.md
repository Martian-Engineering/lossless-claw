---
"@martian-engineering/lossless-claw": patch
---

Add an opt-in `unsupportedHostMode: "capture-only"` compatibility mode so generic CLI backends and CLI-backed children can continue agent turns while Lossless bootstraps, ingests, and maintains their transcripts without claiming context assembly, projected child context, or compaction support.
