---
"@martian-engineering/lossless-claw": patch
---

Make `assertNoReplayTimestampFlood` role-aware so legitimate fast bursts of identical `tool`/`assistant`/`system` messages from sub-agents are not misclassified as replay attacks. External user input keeps the aggregate role/timestamp replay budget, while internal runtime output is budgeted by exact message identity. The threshold is split into two configurable options:

- `replayFloodThresholdExternal` (default `3`, env `LCM_REPLAY_FLOOD_THRESHOLD_EXTERNAL`) — applies to replay-like `role=user` rows, preserving legacy replay defense for third-partyly-rebroadcastable input.
- `replayFloodThresholdInternal` (default `32`, env `LCM_REPLAY_FLOOD_THRESHOLD_INTERNAL`) — applies to `role=tool/assistant/system`, absorbing legitimate same-second idempotent runtime output while still bounding pathological loops.

Fixes a class of false-positives that cascaded into `skipping compaction` / reconcile failures on cron and sub-agent workloads. Related to #639.
