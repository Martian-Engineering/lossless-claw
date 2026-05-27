---
"@martian-engineering/lossless-claw": patch
---

Make `assertNoReplayTimestampFlood` role-aware so legitimate fast bursts of identical `tool`/`assistant`/`system` messages from sub-agents are not misclassified as replay attacks. The grouping key now includes `role`, and the threshold is split into two configurable options:

- `replayFloodThresholdExternal` (default `3`, env `LCM_REPLAY_FLOOD_THRESHOLD_EXTERNAL`) — applies to `role=user`, preserving legacy replay defense for third-partyly-rebroadcastable input.
- `replayFloodThresholdInternal` (default `32`, env `LCM_REPLAY_FLOOD_THRESHOLD_INTERNAL`) — applies to `role=tool/assistant/system`, absorbing legitimate same-second idempotent runtime output while still bounding pathological loops.

Fixes a class of false-positives that cascaded into `skipping compaction` / reconcile failures on cron and sub-agent workloads. Related to #639.
