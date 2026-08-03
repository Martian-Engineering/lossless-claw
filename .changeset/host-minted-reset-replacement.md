---
"@martian-engineering/lossless-claw": patch
---

Recover ingestion after `/new` when the replacement transcript repeats
persisted content by correlating the host-minted reset archive and session
header timestamps. Transcripts without matching reset evidence continue to
fail closed.
