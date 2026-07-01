---
"@martian-engineering/lossless-claw": patch
---

Extract summary content from typed reasoning blocks when a text-type block is also present in the response, so Ollama extended-thinking models that place the entire summary inside a `type:"reasoning"` block produce usable summaries instead of falling through to the truncation fallback. Reasoning-only responses without an accompanying text block remain treated as private diagnostics.
