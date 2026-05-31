---
"@martian-engineering/lossless-claw": minor
---

Strip auto-injected memory/context plugin blocks before compaction summarization.

Memory and context plugins (`active-memory`, `memory-lancedb`, `hindsight-openclaw`, etc.) prepend XML-tagged blocks to user messages via the `prependContext` hook. Without stripping, the compaction summarizer treats these ephemeral retrieval blocks as real conversation content, permanently corrupting summaries.

New `stripInjectedContextTags` config option (string array, defaults to well-known plugin tags). Override via plugin config or `LCM_STRIP_INJECTED_CONTEXT_TAGS` env var. Set to `[]` to disable.
