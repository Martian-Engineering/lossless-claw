---
"@martian-engineering/lossless-claw": minor
---

Add incremental bootstrap checkpoints and large tool-output externalization.

This release speeds up restart/bootstrap by checkpointing session transcript state,
skipping unchanged transcript replays, and using append-only tail imports when a
session file only grew. It also externalizes oversized tool outputs into
`large_files` with compact placeholders so long-running OpenClaw sessions keep
their full recall surface without carrying giant inline tool payloads in the
active transcript.
