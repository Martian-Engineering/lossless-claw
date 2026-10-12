---
"@martian-engineering/lossless-claw": patch
---

Remove the legacy full-transcript reconcile path, which no supported OpenClaw release reaches since transcript ingestion moved to the visible-delta cursor. Existing anchor-trust and transcript-epoch rows are left in place.
