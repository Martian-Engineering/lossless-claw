---
"@martian-engineering/lossless-claw": patch
---

lcm_grep and lcm_expand now mirror their rendered text into `details.text`, and lcm_grep adds typed `messages` / `summaries` / `files` hit arrays (ids, timestamps, 200-char snippets) to `details`. OpenClaw code mode and tool search hand the model a tool's `details` value, not its `content`, so until now a code-mode caller received only the match counts and could not see which messages matched.
