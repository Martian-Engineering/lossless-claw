# Canonical History Replay

LCM uses `readSessionTranscriptReplayGroups` when OpenClaw exports it from
`openclaw/plugin-sdk/context-engine-transcript-runtime`. This is an optional host
capability, not a new minimum-version requirement. The supported minimum remains
OpenClaw `2026.9.2`.

On supported hosts without this public SDK subpath or export, LCM keeps its existing replay path:
stored transcript entry identities match retained raw users to metadata and
runtime carriers still available in the host's live history window. Summaries
remain in assembled context. This compatibility path does not fix carriers
that have already left that window.

LCM still chooses which raw messages and summaries belong in context. For each
retained raw user entry, OpenClaw supplies its canonical replay metadata and
attached runtime context from the active transcript branch. Moving the host's
bounded recent-history window no longer removes these historical facts.
The bounded reader receives only retained raw user entry IDs and returns
`{ entryId, message, carriers }[]`. Canonical metadata, including provenance and
recorded model-prompt projections, is restored without replacing LCM's content.
OpenClaw remains responsible for rendering that metadata at its model boundary.

An empty canonical response is authoritative and does not trigger the
compatibility path. Other SDK import failures and operational read failures are not
treated as missing capability: they reach LCM's existing logged assembly-error
handling, which can return bounded live history. This change does not promise
summary or cache preservation after such a failure, or change that failure policy.

This does not change compaction thresholds, model selection, channel delivery,
or stored conversations. Externalized content remains externalized. Summarized
users do not regain their old runtime context.
If budget eviction removes a restored parent user, its attached carriers are
removed too; the final serialized context remains subject to the existing budget.
