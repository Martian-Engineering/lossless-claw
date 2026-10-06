---
"@martian-engineering/lossless-claw": patch
---

Allow forced overflow recovery when OpenClaw includes display-only nested-tool transcript rows or commits a long turn without per-message entry metadata. Reconcile unique structured identities across the current turn in complete recovery snapshots and require complete coverage of persistable messages, while retaining transcript identity checks, the initiating user, unresolved tool calls, and all stored history.
