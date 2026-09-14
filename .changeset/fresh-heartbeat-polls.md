---
"@martian-engineering/lossless-claw": minor
---

Add the opt-in `preserveHeartbeatPoll` configuration option to retain heartbeat poll events in stored and assembled context. When `pruneHeartbeatOk` is enabled, preserve poll and intermediate messages while removing pure `HEARTBEAT_OK` acknowledgements across transcript projection and durable turn commits.
