# LCM-PG 快速折中 — 异步镜像（方案 B）实施计划

本文档在 [LCM-PG-fast-workround.md](./LCM-PG-fast-workround.md) **方案 B** 基础上，给出 **可执行** 的实现拆解：`afterTurn` 末尾 **异步投递** 任务，将会话在 SQLite 中的 **最新摘要视图** 写入 PostgreSQL **`lcm_mirror`**（或等价表），供 **跨 OpenClaw 实例检索、仪表盘、合规存档**；**不**作为他机上的 lossless 主上下文源。

**前置阅读**：[LCM-PG-IMPLEMENTATION-PLAN.md](./LCM-PG-IMPLEMENTATION-PLAN.md)（OpenClaw `ContextEngine` 无 `userId`/`workspaceId` 时的 **agentId + 配置映射**）。

---

## 1. 目标与非目标

### 1.1 目标

- **`afterTurn` 主路径不显著变慢**：镜像 **仅投递** 到内存/轻量队列，**实际写 PG** 在后台执行。  
- **最终一致**：PG 可能比 SQLite **晚几秒**；可接受重复投递下的 **幂等**（同内容不重复插或 upsert）。  
- **可观测**：失败可重试、可日志/指标；可选死信计数。  
- **可选开关**：无 PG 配置时 **零行为变化**。

### 1.2 非目标

- **不**在 PG 中重建完整 `message_parts` / 全量 DAG 边表。  
- **不**保证与 **`compactLeafAsync`** 同一时刻一致（见 §4 时序）。  
- **不**替代 SQLite 真源；**不**在 `assemble` 中 **默认** 用镜像替代 LCM 本地输出（除非另做显式「远程只读」产品）。

---

## 2. 镜像内容定义（选一种 MVP，可配置）

| 模式 | 含义 | 从 SQLite 读取 | 适用 |
|------|------|----------------|------|
| **`root_view`（推荐 MVP）** | 当前会话 **context 序列表** 中 **所有 summary 类型节点** 的拼接或「根侧」摘要文本 | 读 `context_items` + `summaries.content`（按 ordinal） | 最接近「模型当前看到的摘要层」 |
| **`latest_nodes`** | 最近 **N** 条 `summaries`（按 `created_at` 或 `summary_id`） | `summaries` WHERE `conversation_id` | 实现简单，可能与 assemble 顺序不完全一致 |
| **`rolling_text`** | 固定 token 预算内拼一段纯文本 | 同上 + 截断 | 省 PG 空间 |

**建议**：MVP 采用 **`root_view` 或 `latest_nodes`（N=3～10）**；配置项 `LCM_MIRROR_MODE`。

**每条镜像行至少包含**：`session_key`、`conversation_id`（LCM 内部整数 id）、`agent_id`（从 `sessionKey` 解析）、**`content`/`payload`**、`source_summary_ids`（JSON 数组）、`content_hash`（SHA-256 of canonical payload）、`captured_at`（SQLite 侧读取时间）。

---

## 3. PostgreSQL：`lcm_mirror` 表（草案）

部署在 **与 `shared_knowledge` 同一 workspace 库**（每 toB workspace 一库）或 **共享库 + `workspace_id` 列**（二选一，与现有 PG 规划一致）。

```sql
CREATE TABLE lcm_mirror (
  mirror_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_key      TEXT NOT NULL,
  conversation_id  BIGINT NOT NULL,
  agent_id         TEXT NOT NULL,
  mode             TEXT NOT NULL DEFAULT 'latest_nodes',
  content          TEXT NOT NULL,
  summary_ids      JSONB NOT NULL DEFAULT '[]',
  content_hash     TEXT NOT NULL,
  session_id       TEXT,
  captured_at      TIMESTAMPTZ NOT NULL,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (conversation_id, content_hash)
);

CREATE INDEX lcm_mirror_session_key_idx ON lcm_mirror (session_key, ingested_at DESC);
CREATE INDEX lcm_mirror_agent_idx ON lcm_mirror (agent_id, ingested_at DESC);
-- 可选：全文
-- CREATE INDEX lcm_mirror_content_fts ON lcm_mirror USING gin (to_tsvector('simple', content));
```

**幂等**：`ON CONFLICT (conversation_id, content_hash) DO NOTHING` 或 `DO UPDATE SET ingested_at = now()`。

---

## 4. 时序与 `compactLeafAsync` 的边界

当前 [`src/engine.ts`](src/engine.ts) 中 `afterTurn` 在 **`await this.compact(...)`** 后结束；**`compactLeafAsync`** 为 **fire-and-forget**，可能在 **afterTurn 返回之后** 才写完新 leaf summary。

| 策略 | 做法 |
|------|------|
| **MVP-A** | 仅在 **`afterTurn` 末尾**（`await compact` 之后）投递镜像任务；任务内从 SQLite **读取当前 summaries**。可能 **略滞后一轮** 才看到异步 leaf 的镜像。 |
| **MVP-B（更准确）** | 在 **摘要成功写入 SQLite 之后** 额外投递（例如在 [`src/compaction.ts`](src/compaction.ts) 或 summary 持久化路径 **一处钩子**）。工作量大一些，但与 DAG 更一致。 |

**计划**：**第一期 MVP-A**；在文档与配置中说明 **最终一致延迟**；**第二期** 加 **MVP-B**（Compaction 完成回调）。

---

## 5. 队列与执行器

### 5.1 第一期（单机 OpenClaw 可接受）

- **进程内队列**：`p-queue`（控制 concurrency=1～2）或 **自研微队列**（数组 + `setImmediate`/`queueMicrotask`）。  
- **Worker**：同一 Node 进程内 **async 函数**：出队 → 读 SQLite（只读）→ `INSERT` PG → 失败则 **指数退避重试**（上限 3～5 次），再 **打日志**。

### 5.2 第二期（多 worker / 水平扩展）

- **Redis Stream / BullMQ** 或 **数据库队列表**（`lcm_mirror_jobs`）；独立 worker 进程消费。  
- 需 **SQLite 路径** 仅在有共享存储时可用；否则 **任务 payload 必须自带足够快照**（在投递时从 SQLite 读出 content 塞进 payload），避免 worker 无法读本地文件。

**本期文档默认**：**单机网关 + 进程内队列 + 投递时序列化 payload**（worker 只写 PG），为二期水平扩展留接口。

---

## 6. 配置与环境变量（草案）

| 键 | 说明 |
|----|------|
| `LCM_MIRROR_ENABLED` | `true` / `false` |
| `LCM_MIRROR_DATABASE_URL` | PostgreSQL 连接串（可与共享知识同库） |
| `LCM_MIRROR_MODE` | `latest_nodes` \| `root_view` \| `rolling_text` |
| `LCM_MIRROR_MAX_NODES` | 整数，默认如 `5` |
| `LCM_MIRROR_QUEUE_CONCURRENCY` | 默认 `1` |
| `LCM_MIRROR_AGENT_PG_MAP` | 可选 JSON：`agentId → connection string`（与主方案映射一致） |

插件 `openclaw.plugin.json` 可增加对应 `configSchema` 项（与 env 优先级在 [`src/db/config.ts`](src/db/config.ts) 风格一致）。

---

## 7. 代码落点（LCM-PG）

| 步骤 | 位置（建议） | 内容 |
|------|----------------|------|
| 7.1 | 新 `src/mirror/types.ts` | MirrorPayload、MirrorMode、配置类型 |
| 7.2 | 新 `src/mirror/extract.ts` | 从 `ConversationStore`/`SummaryStore` **只读** 拉取摘要片段（按 §2 模式） |
| 7.3 | 新 `src/mirror/pg-sink.ts` | `upsertMirrorRow(pool, row)`，`ON CONFLICT` 幂等 |
| 7.4 | 新 `src/mirror/queue.ts` | 入队、并发、重试 |
| 7.5 | [`src/engine.ts`](src/engine.ts) `afterTurn` | 在 **`await this.compact(...)` 成功路径末尾**（`try` 内或紧跟），若 `LCM_MIRROR_ENABLED` 则 **`mirrorQueue.add(() => runMirrorJob(...))`**，**不 await** 写 PG（或仅 await 入队完成） |
| 7.6 | [`src/plugin/index.ts`](src/plugin/index.ts) | 解析配置；可选在 shutdown 时 **drain 队列**（`dispose`） |
| 7.7 | `package.json` | 可选依赖 `pg` 或 `postgres`（**dynamic import**，未启用镜像不加载） |

**注意**：`afterTurn` 早退路径（ignore session、stateless、ingest 失败）**不**投递镜像。

---

## 8. 测试策略

- **单元**：`extract` 对固定 SQLite fixture 生成稳定 `content_hash`。  
- **集成**：Testcontainers 或本地 PG，`mirror` 写入后 `SELECT` 校验行数与幂等。  
- **回归**：`LCM_MIRROR_ENABLED=false` 时 **零额外查询**（可用 spy）。

---

## 9. 分阶段里程碑

| 阶段 | 交付 | 工期（量级） |
|------|------|----------------|
| **FW-M0** | ADR：确认镜像模式（`latest_nodes` vs `root_view`）与 PG 库边界 | 0.5 天 |
| **FW-M1** | `lcm_mirror` DDL + `pg-sink` 单测 | 1–2 天 |
| **FW-M2** | `extract` + SQLite fixture 测试 | 2–3 天 |
| **FW-M3** | 进程内队列 + `afterTurn` 钩子 + 配置 | 2–3 天 |
| **FW-M4** | 与 **共享知识 assemble**（[LCM-PG-fast-workround.md](./LCM-PG-fast-workround.md) §4）联调：PG 侧可 **搜 mirror + shared** | 2–4 天 |
| **FW-M5（可选）** | Compaction 完成钩子（MVP-B） | 3–5 天 |

**粗估**：**M1–M3** 约 **1 周**（熟练者）；含联调与文档 **约 1.5–2 周**。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 队列堆积 | `concurrency`、队列长度指标、超限丢弃最旧或采样 |
| PG 不可用 | 重试后丢弃并计数；**不**影响 `afterTurn` 返回 |
| SQLite 只读竞争 | 镜像仅 **读**；与 LCM 写锁冲突概率低；仍避免长事务 |
| 磁盘与隐私 | `content` 可能含敏感信息；**保留策略**（TTL `DELETE` job）与加密（磁盘/TDE）按合规定 |
| `sessionKey` 变更 | 以 `conversation_id` 为主键维度；`session_key` 作展示/过滤列 |

---

## 11. 相关文档

- [LCM-PG-fast-workround.md](./LCM-PG-fast-workround.md)  
- [LCM-PG-PLUG.md](./LCM-PG-PLUG.md)  
- [LCM-PG-IMPLEMENTATION-PLAN.md](./LCM-PG-IMPLEMENTATION-PLAN.md)  
- [specs/lcm-pg-decisions.md](../specs/lcm-pg-decisions.md)  

---

*文件名 `fw` = fast workaround；随实现可在 `CHANGELOG.md` 中登记用户可见行为。*
