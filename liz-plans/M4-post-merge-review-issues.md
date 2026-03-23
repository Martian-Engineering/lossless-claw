# M4 Post-Merge Review — Three Priority Issues

Source: code review of `feat(m4): add PG read path tools and shared knowledge integration` (e.g. commit `ef32c58` on `main`).

Items are **grouped by priority** into **three** GitHub-scale issues (P0 / P1 / P2).

---

## P0 — Correctness / Ops (single issue)

**Scope:** URL resolution + managed Postgres DDL.

1. **Shared-knowledge database URL can be unresolved** — `resolveSharedKnowledgeDatabaseUrl()` only resolves when `mirrorAgentDatabaseUrls.main`, `databaseUrl`, or exactly one URL exists. Multi-URL-only setups fail or no-op without a clear startup error.  
   **Actions:** Document config in README / `docs/configuration.md`; optional startup validation when `sharedKnowledgeEnabled && !resolveSharedKnowledgeDatabaseUrl(...)`.

2. **`CREATE EXTENSION IF NOT EXISTS pgcrypto` may fail on managed Postgres** — schema init can fail on first connect where extensions are restricted.  
   **Actions:** Document required privileges / allowlist; optional path without `pgcrypto` where `gen_random_uuid()` suffices.

---

## P1 — Security / Observability (single issue)

**Scope:** RLS, mirror search errors, search UX.

3. **`knowledge_roles` has no RLS** — any session user with `SELECT` can read the table; assumes a dedicated app DB user.  
   **Actions:** Document threat model; optional RLS / stricter role for multi-tenant DBA concerns.

4. **`searchMirror` swallows per-database errors** — `Promise.all(..., .catch(() => []))` hides failures per URL.  
   **Actions:** Return partial results + `errors[]` or `warn` per URL; integration test for invalid URL visibility.

5. **ILIKE wildcard semantics in user `query`** — `%` / `_` in user input act as SQL wildcards.  
   **Actions:** Document, escape with `ESCAPE`, or strip for operator tools.

---

## P2 — Product / Defaults / Docs (single issue)

**Scope:** Defaults, timeouts, admin semantics documentation.

6. **Shared knowledge defaults “on” when mirror is on** — unset `LCM_SHARED_KNOWLEDGE_ENABLED` ties SK to mirror; mirror-only deploys must explicitly disable.  
   **Actions:** README / changelog; optional default-off (breaking — semver).

7. **Assemble shared-knowledge default timeout (~500ms)** — often too low for remote PG; injection skipped with warn-only.  
   **Actions:** Document tuning / higher default; optional metric for timeout skips.

8. **`lcm_mirror_search` admin when SK disabled** — admin uses `bootstrapAdminAgentIds` only, not PG `knowledge_roles`.  
   **Actions:** Document in tool description + README.

---

## Already in good shape (no issue required)

- Shared `Pool` via `pg-common` + `closeAllMirrorPools` / `closeAllPgPools`.
- Transaction-scoped `set_config` for `app.agent_id` / `app.admin_role`.
- `systemPromptAddition` append (assembler + shared knowledge).
- `resolveAssembleAgentId` / `resolveCallerIdentity` alignment.
- Role-group validation for `visibleTo` / `editableBy`.

---

## 中文摘要

| 优先级 | 合并后主题 |
|--------|------------|
| **P0** | 共享知识库 URL 解析盲区 + 托管 PG 上 `pgcrypto` 扩展风险 |
| **P1** | `knowledge_roles` 无 RLS、多库镜像搜索错误被吞、ILIKE 通配符 |
| **P2** | SK 随镜像默认开启、assemble 超时偏紧、关 SK 时镜像搜索管理员规则文档 |

---

*Last updated: consolidated into three priority issues for GitHub.*
