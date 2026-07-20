---
"@martian-engineering/lossless-claw": patch
---

Add an opt-in `hostFallbackMode: "capture-only"` setting so generic CLI backends can persist turns and use recall tools without Lossless prompt assembly or host-triggered Lossless compaction. Strict full-lifecycle validation remains the default, backend-native compaction remains host-owned, and subagent projection requirements remain unchanged.
