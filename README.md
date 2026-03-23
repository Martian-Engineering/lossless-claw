# LCM-PG

PostgreSQL mirror and multi-tenant groundwork for [lossless-claw](https://github.com/Martian-Engineering/lossless-claw), the DAG-based context engine for [OpenClaw](https://github.com/openclaw/openclaw).

> Fork of [Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw) · Upstream version **0.4.0**

---

## What is LCM-PG / LCM-PG 是什么

**LCM-PG** (formerly lossless-claw) is an OpenClaw context engine plugin. When a conversation exceeds the model's context window, LCM persists every message in SQLite, summarizes older messages into a DAG of summaries, and assembles context each turn from summaries + recent raw messages. Nothing is lost — agents can drill into any summary to recover the original detail via `lcm_grep`, `lcm_describe`, and `lcm_expand`.

This fork adds an **asynchronous PostgreSQL mirror** on top of LCM. After each turn's compaction, selected summary snapshots are written to a `lcm_mirror` table in PostgreSQL — enabling cross-instance search, dashboards, compliance archival, and eventually shared knowledge across multiple OpenClaw instances.

LCM-PG 在上游 LCM 基础上增加了 **PostgreSQL 异步镜像**：每次 compaction 后，将摘要快照写入 PG `lcm_mirror` 表，为跨实例检索、数据看板、合规归档以及多实例间共享知识打下基础。本地 agent 仍从 SQLite 读取上下文，PG 写入完全异步、不阻塞主流程。

---

## Architecture / 架构概览

```
  ┌──────────────────────────────────────────────────────────┐
  │                     OpenClaw Instance                     │
  │                                                          │
  │  ingest() ──▸ SQLite ◂── assemble()                     │
  │                 │            ▲                            │
  │                 │   lcm_grep / lcm_expand (read)         │
  │                 │                                        │
  │  afterTurn() ── compact ── enqueueMirrorAfterTurn        │
  │                                │                         │
  └────────────────────────────────│─────────────────────────┘
                                   │ async (fire-and-forget)
                                   ▼
                          ┌────────────────┐
                          │  PostgreSQL     │
                          │  lcm_mirror    │
                          │  table          │
                          └────────────────┘
                                   │
                          shared_knowledge
                          (RLS-controlled)
                                   │
                        cross-instance search,
                        assemble injection,
                        dashboards
```

- **SQLite** remains the primary store — all reads (`assemble`, `lcm_grep`, `lcm_expand`) come from here.
- **PostgreSQL** receives a write-only mirror of summary snapshots after compaction. The mirror is idempotent (`ON CONFLICT DO NOTHING` by content hash).
- **M4 tools** (`lcm_mirror_search`, `lcm_shared_knowledge_search/write`, `lcm_manage_roles`) query PG for cross-instance search and shared knowledge with role-based access control.

### Data flow / 数据流四层模型

```
  Agent X turn ──▸ SQLite (every message persisted locally)
                      │
                  compaction (when context threshold is hit)
                      │
                  lcm_mirror (PG, summary snapshots per agent)
                      │
                  main agent (admin) reads lcm_mirror
                      │
                  curates ──▸ shared_knowledge (PG, RLS-controlled)
                      │
                  other agents read shared_knowledge via assemble
```

The mirror syncs to PG **after compaction**, not after every turn. If compaction produces no new summaries, the content hash deduplication means no duplicate rows are written.

PG 中有两张独立的表，各自承担不同职责：

| | `lcm_mirror` | `shared_knowledge` |
|---|---|---|
| **写入内容** | 单个 agent 的 compaction 摘要快照 | 经过筛选的跨 agent 共享知识 |
| **谁来写** | 自动 — `afterTurn` compaction 后触发 | 人工/编排 — admin agent 从 mirror 精选后写入 |
| **数据范围** | 单 agent、单 conversation | 整个 workspace（跨 agent） |
| **可见性** | 隐式私有（按 `agent_id` 区分） | 显式控制 — `visibility`、`owner_agent_id`、`editable_by` + RLS |
| **数据生命周期** | 只追加，`content_hash` 幂等 | 可修改、版本化、删除 |
| **谁来读** | admin agent（全量）；未来：仪表盘、合规、跨实例检索 | 所有 agent 通过 `assemble` 注入上下文（按 RLS 权限过滤） |

完整架构提案见 [LCM-PG-PLUG.md](liz-plans/LCM-PG-PLUG.md)；快速落地方案见 [LCM-PG-fast-workround.md](liz-plans/LCM-PG-fast-workround.md)。

---

## Milestone Status / 里程碑进度

| Milestone | Deliverable | Status |
|-----------|-------------|--------|
| **FW-M0** | ADR: mirror mode (`latest_nodes` / `root_view`) and PG boundary | Done |
| **FW-M1** | `lcm_mirror` DDL + `pg-sink` + integration test | Done |
| **FW-M2** | `extract` + SQLite fixture tests | Done |
| **FW-M3** | In-process queue + `afterTurn` hook + config | Done |
| **FW-M4** | PG read tools, shared knowledge, role-based access, assemble injection | Done (validated 2026-03-23) |
| **FW-M5** | Compaction-complete hook (optional) | Not started |

详细实施计划见 [LCM-PG-fw-plan.md](liz-plans/LCM-PG-fw-plan.md)。

---

## Quick Start

### Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) with plugin context engine support
- Node.js 22+
- An LLM provider configured in OpenClaw (used for summarization)
- PostgreSQL (only if enabling the mirror)

### Install the plugin

Link this fork as a local plugin:

```bash
openclaw plugins install --link /path/to/LCM-PG
```

Verify it loads:

```bash
openclaw plugins list
# Should show "lcm-pg" as loaded
```

### Enable the PG mirror

Set these environment variables before starting OpenClaw:

```bash
export LCM_MIRROR_ENABLED=true
export LCM_MIRROR_DATABASE_URL=postgresql://user:pass@localhost:5432/mydb
export LCM_MIRROR_MODE=latest_nodes   # or root_view
```

The startup log will confirm the mirror is active. After enough turns trigger compaction, rows appear in the `lcm_mirror` table.

Without these variables (or with `LCM_MIRROR_ENABLED=false`), the plugin behaves identically to upstream LCM — no PG dependency, no extra latency.

---

## Mirror Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `LCM_MIRROR_ENABLED` | `false` | Enable async PG mirror |
| `LCM_MIRROR_DATABASE_URL` | — | PostgreSQL connection string (single URL fallback) |
| `LCM_MIRROR_MODE` | `latest_nodes` | Mirror content mode: `latest_nodes` (last N summaries by creation order) or `root_view` (current context items / root DAG view) |
| `LCM_MIRROR_MAX_NODES` | `5` | Max summary nodes per mirror snapshot |
| `LCM_MIRROR_QUEUE_CONCURRENCY` | `1` | Concurrent mirror write jobs (1–8) |
| `LCM_MIRROR_MAX_RETRIES` | `4` | Retry count per mirror job (exponential backoff) |
| `LCM_MIRROR_AGENT_PG_MAP` | `{}` | JSON map of `agentId` to PG connection string, for per-agent routing |
| `LCM_SHARED_KNOWLEDGE_ENABLED` | `true` when mirror enabled | Enable shared-knowledge tools and role-based PG read layer. Set `false` for mirror-only mode. |
| `LCM_ASSEMBLE_SHARED_KNOWLEDGE` | `true` | Enable assemble-time shared knowledge injection |
| `LCM_ASSEMBLE_SK_LIMIT` | `5` | Max shared-knowledge entries injected into assemble |
| `LCM_ASSEMBLE_SK_MAX_TOKENS` | `2000` | Token budget cap for assemble shared-knowledge block |
| `LCM_ASSEMBLE_SK_TIMEOUT_MS` | `2000` | Timeout for shared-knowledge lookup during assemble |
| `LCM_ADMIN_ROLE_NAME` | `admin` | Role-group name used as admin authority |
| `LCM_ADMIN_AGENT_IDS` | `main` | Bootstrap admin agent IDs used for first-run role seeding |
| `LCM_ROLE_BOOTSTRAP_MAP` | built-in map | JSON map of `agentId -> role[]` for idempotent startup seeding |

All mirror variables can also be set via plugin config (`mirrorEnabled`, `mirrorDatabaseUrl`, etc.). Environment variables take precedence.

### Plugin config file (`openclaw.json`)

Instead of setting environment variables on every gateway start, you can persist the config in `~/.openclaw/openclaw.json` under `plugins.entries.lcm-pg.config`:

```json
{
  "plugins": {
    "entries": {
      "lcm-pg": {
        "enabled": true,
        "config": {
          "mirrorEnabled": true,
          "mirrorDatabaseUrl": "postgresql://user@localhost:5432/mydb",
          "mirrorMode": "latest_nodes",
          "contextThreshold": 0.75,
          "sharedKnowledgeEnabled": true,
          "mirrorAdminAgents": ["main"]
        }
      }
    }
  }
}
```

With this in place, simply run:

```bash
openclaw gateway --force
```

**Config key mapping** (env var → plugin config):

| Environment variable | Plugin config key |
|---------------------|-------------------|
| `LCM_MIRROR_ENABLED` | `mirrorEnabled` |
| `LCM_MIRROR_DATABASE_URL` | `mirrorDatabaseUrl` |
| `LCM_MIRROR_MODE` | `mirrorMode` |
| `LCM_MIRROR_AGENT_PG_MAP` | `mirrorAgentDatabaseUrls` (object) |
| `LCM_SHARED_KNOWLEDGE_ENABLED` | `sharedKnowledgeEnabled` |
| `LCM_ASSEMBLE_SHARED_KNOWLEDGE` | `assembleSharedKnowledge` |
| `LCM_ASSEMBLE_SK_TIMEOUT_MS` | `assembleSkTimeoutMs` |
| `LCM_ASSEMBLE_SK_LIMIT` | `assembleSkLimit` |
| `LCM_ASSEMBLE_SK_MAX_TOKENS` | `assembleSkMaxTokens` |
| `LCM_ADMIN_ROLE_NAME` | `adminRoleName` |
| `LCM_ADMIN_AGENT_IDS` | `mirrorAdminAgents` |
| `LCM_ROLE_BOOTSTRAP_MAP` | `roleBootstrapMap` (object) |
| `LCM_CONTEXT_THRESHOLD` | `contextThreshold` |

Env vars always override the config file when both are set.

### Shared knowledge URL resolution (important)

When `LCM_SHARED_KNOWLEDGE_ENABLED=true`, the plugin must resolve **one shared PG URL**. Resolution order:

1. `mirrorAgentDatabaseUrls.main`
2. `LCM_MIRROR_DATABASE_URL` / `mirrorDatabaseUrl`
3. Exactly one unique mirror URL across map + default

If none of the above applies, shared knowledge is disabled at startup with an explicit error log.

### Mirror-only mode (disable shared knowledge)

By default, enabling mirror also enables shared knowledge for backward compatibility.  
If you want **mirror only** (`lcm_mirror` write/read path, without role tables/tools/assemble injection), set:

```bash
export LCM_MIRROR_ENABLED=true
export LCM_SHARED_KNOWLEDGE_ENABLED=false
```

With this setting:

- shared-knowledge tools are not registered
- assemble does not inject shared knowledge
- `lcm_mirror_search` admin authorization uses `LCM_ADMIN_AGENT_IDS` (`mirrorAdminAgents`), not `knowledge_roles`

### Assemble timeout tuning

`LCM_ASSEMBLE_SK_TIMEOUT_MS` defaults to `2000ms`.  
For remote/managed PG with higher latency, tune to `3000-5000ms` to reduce skipped injection due to timeout.

### PostgreSQL version requirement

**PostgreSQL 13 or later** is required.  
`lcm_mirror` uses `gen_random_uuid()` as a server-side default, which is built-in starting with PG 13 (earlier versions need the `pgcrypto` extension).


### Managed Postgres note

Shared knowledge schema initialization does **not** run `CREATE EXTENSION pgcrypto`.  
`shared_knowledge.knowledge_id` is generated in application code, so managed Postgres environments that block extension creation are supported.

### Security model for `knowledge_roles`

`knowledge_roles` currently does **not** enable RLS. The M4 design assumes:

- a dedicated application DB user for LCM-PG runtime access
- no broad ad-hoc `SELECT` grants (human users, BI tooling, shared read-only roles) on the app schema

If your environment requires broader database visibility, add stricter DB-role isolation (and optional table-level RLS hardening) before exposing production data.

### Search wildcard behavior

For both `lcm_mirror` search and `shared_knowledge` search, user query text is treated as a literal substring match.

- `%` and `_` are escaped and **do not** act as SQL wildcards
- search remains case-insensitive (`ILIKE`)

### LCM core configuration

LCM core settings (`LCM_FRESH_TAIL_COUNT`, `LCM_CONTEXT_THRESHOLD`, session patterns, expansion model overrides, etc.) are unchanged from upstream. See [README_orig.md](README_orig.md) for the full reference.

---

## Documentation / 文档

### Project plans / 项目规划

| Document | Description |
|----------|-------------|
| [LCM-PG-PLUG.md](liz-plans/LCM-PG-PLUG.md) | Overall multi-tenant architecture proposal / 总体多租户架构提案 |
| [LCM-PG-IMPLEMENTATION-PLAN.md](liz-plans/LCM-PG-IMPLEMENTATION-PLAN.md) | Full implementation plan with milestones / 完整实施计划 |
| [LCM-PG-fast-workround.md](liz-plans/LCM-PG-fast-workround.md) | Fast workaround: SQLite local + PG shared / 快速落地方案 |
| [LCM-PG-fw-plan.md](liz-plans/LCM-PG-fw-plan.md) | Async mirror implementation plan / 异步镜像实施拆解 |
| [LCM-PG-fw-validation.md](liz-plans/LCM-PG-fw-validation.md) | Validation and testing plan (Layers 1–9) / 验证测试计划 |
| [M4/FW-M4-implementation-plan.md](liz-plans/M4/FW-M4-implementation-plan.md) | M4 implementation plan: PG read path + shared knowledge / M4 实施计划 |
| [deep-dive-rdbms-proposal.md](liz-plans/deep-dive-rdbms-proposal.md) | Original RDBMS exploration notes / 早期 RDBMS 探索笔记 |

### Architecture decisions

| Document | Description |
|----------|-------------|
| [specs/lcm-pg-decisions.md](specs/lcm-pg-decisions.md) | ADR: identity routing, workspace config semantics |

### Upstream docs

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | LCM internal data model, compaction lifecycle, DAG structure |
| [Agent tools](docs/agent-tools.md) | `lcm_grep`, `lcm_describe`, `lcm_expand` reference |
| [Configuration guide](docs/configuration.md) | Detailed config reference |
| [FTS5 setup](docs/fts5.md) | Optional FTS5 for fast full-text search |
| [TUI reference](docs/tui.md) | Terminal UI documentation |
| [Animated visualization](https://losslesscontext.ai) | Interactive explanation of LCM |

---

## Development

```bash
# Run all tests
npx vitest run --dir test

# Type check
npx tsc --noEmit

# Run a specific test
npx vitest test/mirror-extract.test.ts

# Run PG integration test (requires local PostgreSQL + lcm_test database)
TEST_PG_URL=postgresql://$(whoami)@localhost:5432/lcm_test npx vitest run test/mirror-pg-sink.test.ts
```

### Project structure

```
index.ts                        # Plugin entry point
src/
  engine.ts                     # LcmContextEngine — ContextEngine interface + mirror hook
  assembler.ts                  # Context assembly (summaries + messages → model context)
  compaction.ts                 # CompactionEngine — leaf passes, condensation, sweeps
  summarize.ts                  # Depth-aware prompt generation and LLM summarization
  retrieval.ts                  # RetrievalEngine — grep, describe, expand (SQLite only)
  types.ts                      # Core types and dependency injection contracts
  plugin/
    index.ts                    # Plugin registration, config resolution, mirror init
  mirror/                       # ── PG mirror + shared knowledge (this fork) ──
    types.ts                    # LcmMirrorConfig, LcmMirrorRow, LcmMirrorMode
    config.ts                   # Resolve mirror config from env / plugin config
    extract.ts                  # Build mirror payload from SQLite summaries
    pg-common.ts                # Shared PG pool management
    pg-sink.ts                  # DDL, connection pooling, upsert to lcm_mirror
    pg-reader.ts                # Shared knowledge DDL, RLS, search, write, role CRUD
    queue.ts                    # Single-lane async job queue
  db/
    config.ts                   # LcmConfig resolution
    connection.ts               # SQLite connection management
    migration.ts                # Schema migrations
  store/
    conversation-store.ts       # Message persistence and retrieval
    summary-store.ts            # Summary DAG persistence
  tools/
    lcm-grep-tool.ts            # lcm_grep
    lcm-describe-tool.ts        # lcm_describe
    lcm-expand-tool.ts          # lcm_expand (sub-agent)
    lcm-expand-query-tool.ts    # lcm_expand_query (main agent)
    lcm-mirror-search-tool.ts   # lcm_mirror_search (admin: cross-agent mirror search)
    lcm-manage-roles-tool.ts    # lcm_manage_roles (admin: role CRUD)
    lcm-shared-knowledge-write-tool.ts   # lcm_shared_knowledge_write (admin: curate knowledge)
    lcm-shared-knowledge-search-tool.ts  # lcm_shared_knowledge_search (RLS-filtered read)
    lcm-shared-auth.ts          # Caller identity resolution + input validation
test/                           # Vitest test suite
  mirror-extract.test.ts        # Mirror payload extraction tests
  mirror-deps-default.ts        # Shared disabled-mirror config for tests
specs/                          # Architecture decision records
liz-plans/                      # Project plans and proposals
tui/                            # Interactive terminal UI (Go)
openclaw.plugin.json            # Plugin manifest with config schema
```

---

## Upstream / 上游

This fork tracks [Martian-Engineering/lossless-claw](https://github.com/Martian-Engineering/lossless-claw). Mirror and multi-tenant features are developed here first; upstream-compatible improvements will be contributed back.

```bash
git remote -v
# origin    https://github.com/lapal0ma/LCM-PG.git (fetch/push)
# upstream  https://github.com/Martian-Engineering/lossless-claw.git (fetch/push)
```

---

## License

MIT
