---
"@martian-engineering/lossless-claw": patch
---

Inherit OpenClaw's effective default model during context-free durable `commitTurn` summary preparation when no Lossless summary override is configured. Automatic pending-summary work now retains raw context instead of persisting emergency truncations when no model-backed summarizer can be resolved.
