# LCM-PG 快速折中方案（SQLite 真源 + PG 共享层）

本文档描述一种 **实现成本最低** 的路径：**继续以 LCM-PG（原 lossless-claw / LCM）+ 本地 SQLite 作为 context engine 与会话真源**，**PostgreSQL 集群** 仅承担 **跨 OpenClaw 实例可共享的知识**（以及可选的 **异步镜像**）。在 **`assemble` 阶段** 将 **LCM 输出** 与 **PG 检索结果** 合并进最终上下文。

与主方案的关系见 [LCM-PG-PLUG.md](./LCM-PG-PLUG.md) 第 7 节（过渡方案 B）；本文展开工程细节与可选增强。

---

## 1. 核心思路（一句话）

- **会话上下文（消息、摘要 DAG、compaction）**：仍由 **SQLite + LCM** 负责，行为与现状一致。  
- **PG**：存放 **多实例共享知识**；可选将 **摘要/索引** 异步写入 PG 供检索或合规，**不作为** 他机上的 lossless 主存储。  
- **`assemble`**：**先** 执行 LCM 原有逻辑（SQLite），**再** 从 PG **检索 top-K 共享知识** 并 **合并**（token 封顶、超时降级）。

---

## 2. 架构示意

```
OpenClaw 实例 A / B / C
        │
        ▼
┌───────────────────┐
│ LCM (SQLite)      │  ← 真源：ingest / compact / 默认 assemble
│ ~/.openclaw/lcm.db │
└─────────┬─────────┘
          │
          │ 可选：异步/批量 sync（不阻塞 assemble 主路径）
          ▼
┌───────────────────┐       ┌─────────────────────────┐
│ PG（集群）         │◀──────│ 共享知识 + 可选镜像表    │
│ · shared_knowledge │      │ 多实例读、租户/工作区隔离 │
│ ·（可选）lcm_mirror│      └─────────────────────────┘
└───────────────────┘
```

---

## 3. 「同步上下文进 PG」的几种做法

| 方式 | 做法 | 实现速度 | 说明 |
|------|------|----------|------|
| **A. 仅共享知识** | 不向 PG 写入 transcript；只维护 `shared_knowledge`（及检索索引） | **最快** | 与 [LCM-PG-PLUG.md](./LCM-PG-PLUG.md) 中「方案 B」一致。 |
| **B. 异步镜像** | 在 `afterTurn` 末尾 **投递队列/后台任务**：将本会话 **最新摘要节点或滚动摘要** 写入 PG 表 `lcm_mirror`（或等价） | **较快** | 供 **搜索、仪表盘、合规存档**；**最终一致**；**不**作为其他实例上的主上下文源。**实施拆解** → [LCM-PG-fw-plan.md](./LCM-PG-fw-plan.md)。 |
| **C. 双写** | 每次 `ingest` 同时写 SQLite + PG | **慢、复杂** | 跨两库事务与失败语义难处理；**不推荐**作为「快速折中」。 |

**推荐「超快」路径**：先做 **A**；确有跨实例「搜历史摘要」需求再加 **B**。

---

## 4. `assemble` 合并顺序（建议）

1. 调用 **现有 LCM `assemble`**（SQLite），得到主体消息列表与 token 估算。  
2. 若配置启用 **PG 共享层**：用当前轮 **用户问题** 或 **最近一条 user 文本** 作为查询，访问 PG（**同 workspace 库或统一检索 API**）。  
3. **合并**：追加 **`system` 附加片段**（或等价），例如：「以下为工作区共享知识（节选）…」，并设 **硬 token 上限**。  
4. **韧性**：PG **超时或失败** 时 **跳过** 共享块，**不**影响 LCM 返回；记录日志与指标。

---

## 5. 多 OpenClaw 实例如何共享

- 各实例 **本地 SQLite 相互独立**，无冲突。  
- **PG** 使用 **同一逻辑工作区**（同一 database 或同一 schema + `workspace_id`），存放 **shared_knowledge**；各网关配置 **PG 连接串** 或 **小 HTTP 检索服务**（服务背后仍连 PG）。  
- **身份与路由**：OpenClaw **ContextEngine** 不传递独立 `workspaceId`（见 [LCM-PG-IMPLEMENTATION-PLAN.md](./LCM-PG-IMPLEMENTATION-PLAN.md)）；需用 **`sessionKey` → `parseAgentSessionKey` → `agentId`** 与 **插件配置映射** 选择 **正确的 PG 库/租户**，避免串库。

---

## 6. 优点与局限

### 优点

- **改动面小**：不必先完成 PG 版 `LcmDb` 与全量迁移即可验证 **多实例 + 共享知识** 产品形态。  
- **上线快**：PG 侧可先 **单表 + 索引**（或 + pgvector 二期）。  
- **风险低**：LCM 核心路径保持 SQLite，回滚容易。

### 局限

- **Transcript 仍不在 PG**：换机器/换网关 **会话不自动跟随**；若仅有 **B 类镜像**，也 **不能** 等价完整 lossless 恢复。  
- **一致性**：共享知识与本地 DAG **无单事务**；接受 **最终一致** 即可。  
- **重复成本**（若启用 B）：存储与同步任务运维。

---

## 7. 与全量 LCM-on-PG 的演进关系

本折中是 **通向 [LCM-PG-IMPLEMENTATION-PLAN.md](./LCM-PG-IMPLEMENTATION-PLAN.md) 主线的跳板**：

1. 先跑通 **共享层 + assemble 合并** 与多实例演示。  
2. 再按需实施 **存储抽象、PG DDL、双后端、RLS** 等，将 **会话真源** 迁入 PG。

---

## 8. 相关文档

- [LCM-PG-PLUG.md](./LCM-PG-PLUG.md) — 总体提案与 toB 架构共识  
- [LCM-PG-IMPLEMENTATION-PLAN.md](./LCM-PG-IMPLEMENTATION-PLAN.md) — 完整实施阶段与 OpenClaw 协议约束  
- [specs/lcm-pg-decisions.md](../specs/lcm-pg-decisions.md) — ADR 草案  

---

*文件名保留 `workround` 为仓库内固定引用；语义上即 workaround（快速折中）。*
