---
"@martian-engineering/lossless-claw": patch
---

Convert bootstrap's file I/O off the Node.js event loop. `readFileSegment` and `readLastJsonlEntryBeforeOffset` previously used sync `openSync`/`readSync`/`statSync`, which could block the gateway for minutes while scanning multi-MB JSONL transcripts during the bootstrap append-only path. The bootstrap entry `statSync` and `refreshBootstrapState` helper are now async as well. The backward-scan loop now only reads new chunks when the current carry has no more newlines, and the fast path short-circuits before the backward scan when the DB's latest hash no longer matches the checkpoint (the common case during active sessions, where the scan can never succeed).
