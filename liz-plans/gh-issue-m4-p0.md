## Context

Post-merge review of **M4** (PG read path tools + shared knowledge). This issue bundles all **P0** correctness / ops follow-ups.

## 1. Shared-knowledge database URL can be unresolved

`resolveSharedKnowledgeDatabaseUrl()` returns a URL only when:

- `mirrorAgentDatabaseUrls.main` is set, **or**
- `databaseUrl` is set, **or**
- exactly **one** URL exists across the map + default.

If operators use **only** per-agent URLs (e.g. `worker`, `research`) with **no** `main` key and **no** top-level `databaseUrl`, shared knowledge tools and assemble injection get `undefined` and fail or no-op **without a single clear startup error**.

**Checklist**

- [ ] Document required config shapes in README / `docs/configuration.md`
- [ ] Optional: plugins startup **validation** — log error or fail fast when `sharedKnowledgeEnabled && !resolveSharedKnowledgeDatabaseUrl(...)`

## 2. `CREATE EXTENSION IF NOT EXISTS pgcrypto` may fail on managed Postgres

Schema init in `pg-reader` runs `CREATE EXTENSION IF NOT EXISTS pgcrypto`. Many hosted providers restrict extension creation; DDL can fail on first connect.

**Checklist**

- [ ] Document: required PG privileges / extension allowlist
- [ ] Optional: detect PG version and skip extension when built-in `gen_random_uuid()` is sufficient, or use a migration path without `pgcrypto` where possible

## Labels suggestion

`m4`, `postgres`, `docs`, `config`
