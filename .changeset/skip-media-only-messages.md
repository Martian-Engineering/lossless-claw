---
"@martian-engineering/lossless-claw": patch
---

Skip media-only messages from the summarization pipeline. Messages whose text content (after stripping `MEDIA:/` file path references) is below 50 characters are excluded from summarizer input, avoiding wasted API calls on content that cannot be meaningfully compressed.
