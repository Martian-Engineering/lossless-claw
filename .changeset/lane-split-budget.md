---
"@martian-engineering/lossless-claw": minor
---

Add opt-in lane-split context budgeting (`laneSplitEnabled`). When enabled, the assembly budget is split into a conversation lane and a machine-load lane: conversation content is kept whole up to `conversationLaneTokenCap` (default **85% of the assembly budget**, i.e. `0.85 × tokenBudget`), while tool results and other bulky payloads absorb eviction first, so tool output can no longer crowd conversation content out of the window. The cap defaults to a budget-derived ratio rather than a fixed token count because it is the only lever that may trim the conversation lane — the lane that carries human text. A fixed cap slips below the conversation pool at large budgets and trims human text, while the remaining 15% keeps a floor for tool output. Reasoning blocks can yield before any conversation message (`laneReasoningMode: "lowest"`) and are shed only when shedding actually frees room for retained content (`laneReasoningShedPolicy: "purpose-bound"`, the default). Disabled by default: with `laneSplitEnabled` unset, assembly output is byte-identical to today.

Also removes two configuration keys that were registered in the plugin manifest and resolver but never read by any code path (`laneSplitTokenThreshold`, `laneSplitUserMessage`).
