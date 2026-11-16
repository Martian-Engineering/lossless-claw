---
"@martian-engineering/lossless-claw": patch
---

Keep leading summaries when the serialized budget clamp has to evict. The clamp kept the newest suffix that fit and dropped the head of the assembled context, which is where LCM summaries and the focus brief sit, so an over-budget turn discarded the compressed history before any raw message. It now pins the leading run of summary and focus-brief wrappers in the format the assembler writes them and evicts the oldest raw messages after them. A pinned result is used only when it fits the clamp target with a valid raw tail that keeps the newest non-prefill message; otherwise the oldest pins are dropped first, and with no pins left the clamp behaves as before.
