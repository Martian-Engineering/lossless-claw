---
"@martian-engineering/lossless-claw": patch
---

Preserve assistant top-level `reasoning_content` during LCM ingest and replay,
including tool-call-only assistant messages from Kimi/DeepSeek-style thinking
providers. The field is restored as top-level assistant metadata, kept out of
visible `content` blocks and compaction summarizer input, and still included in
token accounting.
