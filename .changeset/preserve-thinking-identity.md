---
"@martian-engineering/lossless-claw": patch
---

Preserve reasoning replay integrity for DB-assembled assistant messages.
Ingestion now records the assistant message's model identity
(`provider`/`api`/`model`/`responseModel`) in part metadata, and assembly
re-attaches it so the host's model-bound thinking replay policy can
recognize same-model history instead of downgrading replayed thinking
blocks to plain text. Assembly keeps the host's `reasoning_content`
sentinel thinking signature (it marks reasoning-native replay and is not
a provider-issued signature), keeps provider-issued signatures only when
a stored model identity is present so the host replay policy stays in
charge, and continues to strip signatures from legacy rows without
stored identity so cross-provider replay cannot send foreign signatures.
