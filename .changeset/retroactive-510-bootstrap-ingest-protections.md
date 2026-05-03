---
"@martian-engineering/lossless-claw": patch
---

Apply ingest protections during bootstrap import (retroactive entry for [#510](https://github.com/Martian-Engineering/lossless-claw/pull/510), inadvertently omitted from the v0.9.3 changelog). Bootstrap now routes each imported message through `ingestSingle` so oversized files, images, and tool-results are externalized on first import — peer of #511 and #521 which closed #492.
