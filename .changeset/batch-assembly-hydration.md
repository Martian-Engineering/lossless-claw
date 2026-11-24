---
"@martian-engineering/lossless-claw": patch
---

Hydrate messages and their parts in batches during context assembly instead of issuing two SQLite queries per raw context item, reducing main-thread database work on large conversations.
