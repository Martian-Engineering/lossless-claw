# LCM + PostgreSQL 多租户提案（LCM-PG-PLUG）

本文档汇总在 LCM-PG（原 lossless-claw / LCM）与 OpenClaw 生态背景下，将 **context engine 后端迁至 PostgreSQL**、支撑 **toB 多用户 / 多实例协作** 的架构共识与实施方向。

---

## 1. 目标

1. **OpenClaw `contextEngine`**：完整生命周期（`bootstrap` / `ingest` / `assemble` / `afterTurn` / `compact`、子智能体钩子等），而非仅 `memory` 槽的 CRUD。
2. **引擎后端以 PostgreSQL 为权威存储**：支持 **多用户**、多 OpenClaw 实例、按 **团队/项目（workspace）** 售卖时的隔离与协作。
3. **演示/产品愿景**：多个 OpenClaw 实例连 **同一 PG 服务**，在 **隔离** 的前提下 **共享部分知识**（规范、结论、文档等）。

---

## 2. 与相关项目的关系

| 项目 / 概念 | 角色 |
|-------------|------|
| **lossless-claw（LCM）** | 已是 RDBMS 形态的 **context engine**（当前默认 SQLite）。语义：无损会话、摘要 DAG、`assemble` 预算、工具链等。 |
| **mem9** | OpenClaw 上为 `kind: "memory"`，远端记忆 + 混合检索；**不替代** context engine 的 transcript / DAG 职责。可作 **共享知识层** 参考或后端，而非把 mem9 整仓改成 context engine。 |
| **DB9 等「Agent 数据库」** | 强调 PG 上向量、扩展、运维；LCM 迁 PG 后可部署在其上，属 **部署目标**，不必在插件内重复实现 HTTP/SQL 全家桶。 |

**结论**：以 **扩展 LCM（PostgreSQL 驱动 + 租户维度）** 为主线；mem9/DB9 为 **可选周边**。

---

## 3. toB 概念：Tenant、Workspace、Agent

- **按团队/项目卖**时，**数据与协作的主边界 = Workspace（工作区）**，对应「团队 / 项目」。
- **Tenant / Org**：常与 **签约、计费、法务** 对齐；可挂在 workspace 之上，不必与「数据桶」一一等同。
- **Agent ≠ Tenant**：一个 workspace 内可有多个 **Agent**（不同 bot、子智能体、自动化）；**Agent 是执行身份**，不是计费或组织根边界。
- **推荐**：`org_id`（可选）+ **`workspace_id`（主隔离键）** + `user_id` + `agent_id` 写入上下文与权限模型。

---

## 4. 部署形态对比（摘要）

### 4.1 每个 OpenClaw 实例独占一套 PG

- **优点**：隔离与合规叙事强、故障域小、按客户升配清晰。  
- **缺点**：成本与运维乘 N；跨实例 **共享知识** 需额外同步或联邦。

### 4.2 多个实例共用 **一套 PostgreSQL 服务**（推荐主线）

- **优点**：成本与协作友好、连接池与备份集中、适合 **多实例 + 共享检索**。  
- **缺点**：依赖 **逻辑隔离 + RLS/权限**；需防 **邻居干扰**（慢查询、配额）。

**本提案采用：共用一套 PG 集群。**

---

## 5. 核心架构（已定稿方向）

1. **多个 OpenClaw 实例** → 连接 **同一 PG 服务（集群）**。  
2. **每个 workspace 一个 PostgreSQL `DATABASE`**（库级隔离，强于单库多租户仅靠列）。  
3. **同一 workspace 库内**：  
   - **固定表结构**（版本化迁移），**禁止**常规路径下「每个 agent 动态建一套表」（避免 DDL 爆炸、迁移与监控不可控）。  
   - 用 **`agent_id`、`conversation_id`、`user_id`（如需）** 列区分数据。  
   - **共享表**与 **会话/上下文表**共存；通过 **RLS** 和/或 **不同 PG ROLE + GRANT** 表达「全员可读 / 仅部分 agent 可写」等。  
4. **跨 workspace** 默认不直接 SQL 穿透；若需组织级知识，用 **单独 org 库** 或 **中心检索/API**（进阶）。

### 5.1 架构示意

```
OpenClaw 实例 1 ──┐
OpenClaw 实例 2 ──┼── 接入层（鉴权 + workspace → 连接串/dbname 路由）
OpenClaw 实例 N ──┘
                    │
                    ▼
        ┌───────────────────────────┐
        │   单一 PostgreSQL 集群      │
        │  ┌─────────────────────┐   │
        │  │ DATABASE workspace_A │  │  固定 schema：conversations, messages,
        │  │  + RLS / ROLE       │  │  summaries, context_items, shared_knowledge…
        │  └─────────────────────┘   │
        │  ┌─────────────────────┐   │
        │  │ DATABASE workspace_B │   │
        │  └─────────────────────┘   │
        └───────────────────────────┘
```

### 5.2 权限与建模原则（共识）

- **统一 schema + 列区分 + RLS**，优于 per-agent 物理分表。  
- 共享内容可用列表达：`visibility`、`owner_agent_id`、`editable_by` 或关联表，与 RLS 一致。  
- 连接建立后设置 session 变量（例如 `app.agent_id`）再执行查询，便于策略复用。

---

## 6. 与当前 LCM 代码的关系

- 当前 LCM 使用 **Node `node:sqlite` / `DatabaseSync`**，schema 见 `src/db/migration.ts`，引擎见 `src/engine.ts`。  
- 迁 PG 需要：**连接层抽象、PG 版 DDL/迁移、`RETURNING` 替代 `lastInsertRowid`、事务语义、全文检索**（FTS5 → `tsvector`/GIN）等。  
- 工作量量级（经验估计）：**MVP PG** 约数周；**双后端（SQLite + PG）+ FTS 对齐 + 测试** 约一到数月；**Go TUI** 若也要 PG 需另算。

---

## 7. 过渡方案（可选）：方案 B

若需 **最快上线** 且暂时 **单机网关**：

- **LCM 仍用本地 SQLite** 管完整 transcript / DAG。  
- **共享知识** 单独 **PG + 小 HTTP API**，在 `assemble` 中 **top-K 注入**（超时降级）。  
- **缺点**：transcript 不在 PG，**多机/多网关** 会话不跟随；适合验证共享层后再演进到 **全文库在 PG 的 context engine（本提案主路径）**。

**展开说明（架构示意、同步级别 A/B/C、`assemble` 顺序）**：[LCM-PG-fast-workround.md](./LCM-PG-fast-workround.md)。

---

## 8. `assemble` 与共享知识

- **主路径**：从 PG 读取本会话 **DAG + 尾消息**（LCM 语义）。  
- **共享层**：检索 **同 workspace 库内 `shared_knowledge`（或等价表）**，合并进 **有上限** 的 system 附加块，避免挤占预算。  
- 二期可加 **pgvector** 与关键词混合检索。

---

## 9. 开放决策（后续细化）

- 是否 **组织级跨 workspace 知识** 及其实现（第二库 vs 服务）。  
- **RLS 策略** 与 **Agent 角色枚举** 的精确矩阵（只读/可写共享表、会话可见范围）。  
- **现有 SQLite 用户** 迁移工具与回滚策略。

### 9.1 OpenClaw ContextEngine 协议（已核实结论摘要）

对 **`openclaw/openclaw`** 主线通读后的要点（细节与阶段调整见 [LCM-PG-IMPLEMENTATION-PLAN.md](./LCM-PG-IMPLEMENTATION-PLAN.md) 开篇与阶段 0）：

- **`ContextEngine` 方法参数不包含** 独立的 `workspaceId`、`userId`、`agentId`；主要依赖 **`sessionId` + `sessionKey`**。  
- **`agentId` 可从 `sessionKey`**（形如 `agent:<agentId>:…`）用上游 **`parseAgentSessionKey`** 解析；**不可**与 OpenClaw 配置项 **`AgentConfig.workspace`（本机目录）** 混同为 toB `workspace_id`。  
- **`afterTurn` / `compact` 的 `runtimeContext`** 为 `Record<string, unknown>`，**无稳定身份契约**（已知用途含 `workspaceDir` 等）。  
- **一期集成**：插件侧 **`agentId → PG 连接串/库`** 映射 + **RLS 以 `agent_id` 为主**；**按用户行级 RLS** 需 **OpenClaw 上游扩展**（例如为各方法增加统一 `ContextEngineCallContext`）或 **自建 API 网关** 注入身份。

---

## 10. 参考链接（外部）

- [mem9（OpenClaw memory 插件）](https://github.com/mem9-ai/mem9)  
- [DB9 — Why DB9 for AI Agents](https://db9.ai/docs/why-db9-for-ai-agents)  
- 仓库内历史讨论草案：`deep-dive-rdbms-proposal.md`（OpenViking/RDBMS 语境，与 LCM 方向互补）

---

## 11. 实施计划

分阶段任务拆解、验收标准与里程碑见 **[LCM-PG-IMPLEMENTATION-PLAN.md](./LCM-PG-IMPLEMENTATION-PLAN.md)**。

---

*文档由架构讨论整理，随实现迭代可更新版本与章节。*
