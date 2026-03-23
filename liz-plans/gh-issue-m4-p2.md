## Context

Post-merge review of **M4** (PG read path tools + shared knowledge). This issue bundles all **P2** product / defaults / documentation follow-ups.

## 1. Shared knowledge defaults “on” when mirror is on

When `LCM_SHARED_KNOWLEDGE_ENABLED` is unset, config effectively ties shared knowledge to mirror enablement. Deployments that want **mirror-only** (no RLS tables, no assemble injection) must explicitly disable shared knowledge.

**Checklist**

- [ ] Call out in README / changelog
- [ ] Optional: default `sharedKnowledgeEnabled` to `false` unless explicitly set (breaking change — semver note)

## 2. Assemble shared-knowledge default timeout is aggressive

Default `LCM_ASSEMBLE_SK_TIMEOUT_MS` is **500ms**; remote PG often misses injection silently (warn-only).

**Checklist**

- [ ] Recommend higher default (e.g. 2–5s) or document tuning in ops guide
- [ ] Optional: metric for “SK assemble skipped: timeout”

## 3. Admin semantics for `lcm_mirror_search` when shared knowledge is disabled

With shared knowledge off, admin for mirror search relies on **`bootstrapAdminAgentIds`** only; PG `knowledge_roles` admin is not used for that path.

**Checklist**

- [ ] Document clearly in tool description + README

## Labels suggestion

`m4`, `docs`, `product`, `ops`
