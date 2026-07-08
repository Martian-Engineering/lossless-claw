---
"@martian-engineering/lossless-claw": patch
---

Collapse metadata-wrapped OpenClaw runtime copies onto their bare persisted rows only when the covered transcript frontier proves same-turn alignment. Degraded after-turn dedup remains timestamp-gated, so repeated short user messages wrapped in forgeable metadata-shaped text are preserved instead of silently collapsed.
