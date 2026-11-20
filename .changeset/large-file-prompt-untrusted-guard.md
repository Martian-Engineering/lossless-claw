---
"@martian-engineering/lossless-claw": patch
---

Mark the large-file exploration prompt's document sample as untrusted data, matching the leaf and condensed summary prompts. Fetched pages, documents and tool payloads summarized through `buildTextPrompt` can no longer carry instructions into the summary model unguarded, and the "action items or constraints" bullet now asks the model to report them, never act on them.
