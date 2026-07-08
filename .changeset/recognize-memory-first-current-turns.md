---
"@martian-engineering/lossless-claw": patch
---

Recognize memory-first current turns in live coverage. When a memory or context plugin decorates the current turn with injected-context markers (for example `relevant-memories` or `active_memory_plugin`) and the channel adds no timestamp, the decorated current turn was previously dropped from live assembly and the model saw only the tag-stripped stored row. It is now re-appended so the decorated current turn is preserved. Because injected-context markers are user-typeable text, marker-based recognition is constrained to the last assembled user row (the current turn's persisted face), so a distinct turn that merely ends with an earlier row's body cannot be matched through a typed marker.
