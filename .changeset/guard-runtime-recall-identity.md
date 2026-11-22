---
"@martian-engineering/lossless-claw": patch
---

Keep default recall on the requested session key when a reused runtime session ID resolves to a conversation with a different explicit key. If the requested key has no active conversation, leave recall unresolved instead of falling back to a differently keyed conversation. Matching-key and unkeyed legacy runtime lookups, explicit conversation selection, and all-conversation recall remain available.
