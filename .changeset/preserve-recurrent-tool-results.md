---
"@martian-engineering/lossless-claw": patch
---

Preserve distinct tool results when a model reuses tool-call IDs across turns. Only provider-minted IDs now participate in conversation-global event deduplication, and unexpected stable-key collisions retain the row without the conflicting key.
