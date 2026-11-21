---
"@martian-engineering/lossless-claw": minor
---

Add an optional host-bound disclosure capability. When a host supplies one on a
recall tool or `assemble()` call, `lcm_grep`, `lcm_describe`, `lcm_expand`,
`lcm_expand_query` and automatic context assembly authorize conversation, summary
and file targets live before disclosing content or metadata, intersect delegated
grants with host authority, filter derived lineage, and re-check authority before
releasing a result. Behavior is unchanged when no capability is supplied.
