---
"@martian-engineering/lossless-claw": patch
---

Add `preserveNativeImages` config flag: when enabled, native and inline image blocks are left in place at ingest instead of being externalized to a `file_xxx` reference, so vision-capable models receive real image content.
