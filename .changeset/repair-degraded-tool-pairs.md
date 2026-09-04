---
"@martian-engineering/lossless-claw": patch
---

Keep assistant tool calls and their results as one atomic unit when degraded or serialized-budget fallback trims live context. This prevents oversized multimodal tool results from reaching providers as orphaned outputs and failing the next model request.
