## Context

Post-merge review of **M4** (PG read path tools + shared knowledge). This issue bundles all **P1** security / observability follow-ups.

## 1. `knowledge_roles` has no RLS

The table is readable by any DB session user with `SELECT`. Security assumes a **single application role** with no ad-hoc SQL access.

**Checklist**

- [ ] Document threat model: dedicated DB user; no broad human/analytics `SELECT` on app schema
- [ ] Optional: add RLS or stricter role if multi-tenant DBA access is a concern

## 2. `searchMirror` swallows per-database errors

`Promise.all(..., .catch(() => []))` hides connection/query failures for individual URLs; operators see empty results instead of an error.

**Checklist**

- [ ] Return partial results **plus** `errors[]` in tool JSON, or `warn` with URL + message per failure
- [ ] Integration test: failure visible when one configured URL is invalid

## 3. ILIKE wildcard semantics in user `query`

Mirror and shared-knowledge search use `ILIKE '%' || query || '%'`. User-supplied `%` and `_` act as SQL wildcards (surprising UX; parameters are still bound).

**Checklist**

- [ ] Document behavior, or escape `%` / `_` (with `ESCAPE`), or strip wildcards for operator-facing tools

## Labels suggestion

`m4`, `security`, `observability`, `docs`
