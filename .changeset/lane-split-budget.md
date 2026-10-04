---
"@martian-engineering/lossless-claw": minor
---

Add opt-in lane-split context budgeting (`laneSplitEnabled`). When enabled, the assembly budget is split into a conversation lane and a machine-load lane: conversation content is kept whole up to `conversationLaneTokenCap` (default 65536), while tool results and other bulky payloads absorb eviction first, so tool output can no longer crowd conversation content out of the window. Reasoning blocks can yield before any conversation message (`laneReasoningMode: "lowest"`) and are shed only when shedding actually frees room for retained content (`laneReasoningShedPolicy: "purpose-bound"`, the default). Disabled by default: with `laneSplitEnabled` unset, assembly output is byte-identical to today.
