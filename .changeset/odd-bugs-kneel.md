---
"@martian-engineering/lossless-claw": patch
---

Annotate attachment-only messages during compaction without dropping short captions.

This release improves media-aware compaction summaries by replacing raw
`MEDIA:/...` placeholders for attachment-only messages while still preserving
real caption text, including short captions such as `Look at this!`, when a
message also includes a media attachment.
