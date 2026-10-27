---
"@martian-engineering/lossless-claw": patch
---

Fix `lcm_grep` throwing `Cannot read properties of undefined (reading
'trim')` when a model omits or misnames the `pattern` argument. Hosts pass
model-supplied tool arguments through without schema validation, so the
call died with an uncatchable TypeError before any query ran. The tool now
returns a tool error naming the expected field, including the `query` vs
`pattern` difference against `lcm_expand` and `lcm_expand_query`, so the
agent can correct the call and retry.
