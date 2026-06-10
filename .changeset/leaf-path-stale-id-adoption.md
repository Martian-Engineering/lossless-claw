---
"@martian-engineering/lossless-claw": patch
---

Follow the transcript's parentId leaf path during reconciliation and adopt re-issued entry ids onto rows stranded by host copy-on-write rewrites (rewriteTranscriptEntries, host tool-result truncation, gateway chat edits), so rewritten suffixes re-stamp in place instead of importing as content duplicates.
