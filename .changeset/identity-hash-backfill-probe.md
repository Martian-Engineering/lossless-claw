---
"@martian-engineering/lossless-claw": patch
---

Find messages that still need an identity hash through a small partial index instead of scanning the whole messages table on every startup. On large databases this removes a full-table scan (tens of seconds on multi-gigabyte databases) that ran under the startup migration's exclusive lock and blocked other writers. The index is built once, on the first startup after upgrading.
