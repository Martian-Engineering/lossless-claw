---
"@martian-engineering/lossless-claw": patch
---

Fix `lcm-tui doctor` to detect third truncation marker format (`[LCM fallback summary; truncated for context management]`) and harden Claude CLI summarization with `--system-prompt` flag and neutral working directory to prevent workspace contamination.
