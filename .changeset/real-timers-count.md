---
"@lapal0ma/lcm-pg": patch
---

Fix shared knowledge read-path hardening by:

- enforcing `FORCE ROW LEVEL SECURITY` on `shared_knowledge`
- applying the same visibility predicate in `searchSharedKnowledge` as defense in depth

This prevents silent restricted-row leakage when connections run as table owners or superusers.
