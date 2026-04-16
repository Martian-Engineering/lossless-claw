---
"@martian-engineering/lossless-claw": patch
---

Fix manual and threshold-triggered compaction results so a full sweep that ends under the target budget reports `already under target` instead of a misleading no-op failure.
