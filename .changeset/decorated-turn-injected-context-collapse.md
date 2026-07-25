---
"@martian-engineering/lossless-claw": patch
---

See through plugin-injected context blocks on decorated channel turns.

Memory/context plugins prepend blocks like `<relevant-memories>` to the
model-facing body via `before_prompt_build`, at prompt-build time — strictly
after the bare transcript row is persisted, so persisted rows never carry
them. On decorated channels those blocks sit between the inbound metadata
prelude and the user body, which defeated both the same-turn body collapse and
the current-turn live-face recognition: the
memory-bearing live copy was neither collapsed onto its bare persisted row nor
re-appended after assembly, so the injected context silently vanished from the
outbound prompt. The inbound-body reduction now strips validated, complete
leading injected-context tag blocks (known tag names only, fail-closed), and
the structural current-turn recognizer accepts a metadata-decorated assembled
face whose extracted body equals the live copy's extracted body (the last
assembled user row and recognized-marker gates are unchanged).

The line-form history recap matcher is now a linear line walker instead of a
composite backtracking regex. The old pattern went catastrophic (minutes of
event-loop blocking per call) on entry runs that fail the trailing terminator
check while containing per-line ambiguity, a shape real group-chat recaps
produce and which the reduction above newly exposes to routine traffic.
Semantics are unchanged and pinned by tests, including the all-or-nothing
fail-closed rejection of an unterminated run.
