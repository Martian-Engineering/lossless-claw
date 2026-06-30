---
"@martian-engineering/lossless-claw": patch
---

Preserve the active conversation on a soft reset (/new). When the session file is renamed to a .reset. or .deleted. sibling and a fresh session starts under the same session key, the bootstrap rollover guard now probes for the archived sibling, recognizes the rename as a deliberate reset, and rebinds the existing conversation to the new session instead of archiving it and minting an empty one. Genuine rollover and crash-recovery paths (no archived sibling) are unchanged.
