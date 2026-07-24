---
"@martian-engineering/lossless-claw": patch
---

Carry each message's role into the leaf-summary source text.

`CompactionEngine` dropped `role` when assembling the summarizer input, so a tool
result quoting another conversation was byte-identical to an operator instruction.
A summarizer reading that input can promote quoted material to current intent — the
summary then enters context as user-role text and the model follows it as the active
task. The header line now reads `[<timestamp> | <role>]`; message bodies are
unchanged and no schema migration is required.
