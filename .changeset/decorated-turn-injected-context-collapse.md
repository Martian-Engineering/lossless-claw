---
"@martian-engineering/lossless-claw": patch
---

See through plugin-injected context blocks on decorated channel turns.

Memory/context plugins prepend blocks like `<relevant-memories>` to the
model-facing body via `before_prompt_build`. On decorated channels those blocks
sit between the inbound metadata prelude and the user body, which defeated both
the same-turn body collapse and the current-turn live-face recognition: the
memory-bearing live copy was neither collapsed onto its bare persisted row nor
re-appended after assembly, so the injected context silently vanished from the
outbound prompt. The inbound-body reduction now strips validated, complete
leading injected-context tag blocks (known tag names only, fail-closed), and
the structural current-turn recognizer accepts a metadata-decorated assembled
face whose extracted body equals the live copy's extracted body (the last
assembled user row and recognized-marker gates are unchanged).
