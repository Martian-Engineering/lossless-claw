---
"@martian-engineering/lossless-claw": patch
---

When OpenClaw's built-in `read` tool returns truncated output, recover the full file content before externalizing the oversized tool result — but only for the live `assemble()` current turn. The truncated text is preserved on ingest, bootstrap, and replay paths so transcript fidelity is not compromised by current disk state. Fallback to the truncated fragment when the original path is missing, relative, unreadable, non-regular, or too large for bounded live recovery.
