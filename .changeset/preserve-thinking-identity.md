---
"@martian-engineering/lossless-claw": patch
---

Preserve reasoning replay integrity for DB-assembled assistant messages.

Ingestion now records the assistant message's model identity
(`provider`/`api`/`model`/`responseModel`) in ordinal-0 part metadata, and
assembly re-attaches it so the host's model-bound thinking replay policy can
recognize same-model history instead of downgrading replayed thinking blocks
to plain text.

Assembly applies a three-way `thinkingSignature` gate:

1. **Sentinel `"reasoning_content"`** — the host's cross-provider reasoning-
   native replay marker, not a provider-issued signature. Preserved only when
   the assembled message carries stored model identity; dropped from legacy
   rows without identity so the host's `transformMessages` doesn't downgrade
   it to response-channel text (the contamination this patch fixes).

2. **Provider-issued signatures** — kept only when a stored model identity
   survives to the assembled message (the host's `transformMessages` then
   applies its own same-model replay policy). The identity gate is decided at
   message level (identity lives on ordinal-0 metadata, but signature-bearing
   blocks may sit at any ordinal).

3. **Legacy rows without identity** — keep the historical strip (#365) for
   provider-issued signatures; sentinel blocks are dropped entirely.

Comparison paths that treat part metadata as message identity
(`createLosslessMessageSignature`, `externalizedReplayMetadataMatches`) now
strip model-identity keys before comparing, so rows persisted before the
upgrade still match their post-upgrade live/assembled representations for
replay-prefix detection and live-coverage fork-anchor matching.
