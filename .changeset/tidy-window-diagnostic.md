---
"@martian-engineering/lossless-claw": patch
---

Report `no_override_matched_window_metadata_absent` when no context threshold override matches, a window-range rule is configured, and the host supplies no model context-window metadata. This distinguishes missing metadata from an out-of-range window without changing threshold selection.
