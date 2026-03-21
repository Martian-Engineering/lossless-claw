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
                        (future: cross-instance
                         search, shared knowledge,
                         dashboards)
```

- **SQLite** remains the primary store — all reads (`assemble`, `lcm_grep`, `lcm_expand`) come from here.
- **PostgreSQL** receives a write-only mirror of summary snapshots after compaction. The mirror is idempotent (`ON CONFLICT DO NOTHING` by content hash).
- Agent tools do **not** query PG today. Cross-instance retrieval from PG is planned for milestone FW-M4.

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

| | `lcm_mirror` | `shared_knowledge` (future) |
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
| **FW-M4** | Cross-instance retrieval: PG-side search for mirror + shared knowledge in `assemble` | Not started |
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

All mirror variables can also be set via plugin config (`mirrorEnabled`, `mirrorDatabaseUrl`, etc.). Environment variables take precedence.

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
| [LCM-PG-fw-validation.md](liz-plans/LCM-PG-fw-validation.md) | Validation and testing plan / 验证测试计划 |
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
  mirror/                       # ── PG mirror (this fork) ──
    types.ts                    # LcmMirrorConfig, LcmMirrorRow, LcmMirrorMode
    config.ts                   # Resolve mirror config from env / plugin config
    extract.ts                  # Build mirror payload from SQLite summaries
    pg-sink.ts                  # DDL, connection pooling, upsert to lcm_mirror
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
