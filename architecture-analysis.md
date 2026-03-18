# Lossless Context Management (LCM) — Architecture Analysis

## Part 1: Bug Cluster Analysis

### Cluster 1: Session/Identity Fragmentation and Lifecycle Destructiveness
**Issues:** #107, #106, #101, #98, #86
**Architectural Flaw:** The system ties conversation state to ephemeral session UUIDs rather than stable agent/session identities, and handles database paths as a global singleton.
**Causal Chain:** OpenClaw recycles sessions (via daily resets, idle timeouts, or context overflows) by generating a new `runtimeSessionId`. Because `getOrCreateConversation` keys on this UUID instead of the stable `sessionKey` (e.g., `agent:main:main`), LCM silently drops the meticulously constructed summary DAG and starts a blank conversation. This defeats the core lossless promise. Furthermore, resolving the DB path once at plugin initialization prevents per-agent isolation, causing privacy bleed where sandboxed agents can grep the main agent's history.

### Cluster 2: Lazy DB Initialization & Connection Contention
**Issues:** #103, #89, #73
**Architectural Flaw:** Deferred schema migrations and lack of connection/transaction serialization.
**Causal Chain:** `runLcmMigrations()` is invoked lazily inside compaction/ingest logic but bypassed by read-only tools like `lcm_grep`. If a tool is called before the first compaction, it queries an empty DB and fails with "no such table". Under concurrent loads, a single `DatabaseSync` connection sharing `BEGIN IMMEDIATE` and local transactions produces busy failures. In Node.js 25, the experimental SQLite API warnings exacerbate unhandled initialization states into crash loops.

### Cluster 3: Brittle LLM Integration & Runaway Compaction
**Issues:** #113, #111, #109, #95, #74
**Architectural Flaw:** Single points of failure in the summarizer pipeline combined with unbounded, aggressive compaction behavior.
**Causal Chain:** The system ignores the configured `summaryModel` (#113), assumes proprietary fields like `model.input` exist (#111), and lacks a fallback chain (#109). When summarization fails, compaction is blocked. When it finally succeeds, the system aggressively over-compacts in a single pass (#95) without any per-session or per-hour cost bounds (#74), leading to unbounded LLM token spend and severe context truncation.

### Cluster 4: Unsafe Tooling, Scope Bleed, and Unhandled Exceptions
**Issues:** #115, #108, #105, #82, #76, #75, #72
**Architectural Flaw:** Lack of defensive programming at integration boundaries (tools, plugins, subagents, and network channels).
**Causal Chain:** Hardcoded tool assumptions (#115), raw JSON leaks from other plugins (#105), and timezone mismatches (#82) degrade UX. More critically, untrusted user regex causes ReDoS (#76), string-based heartbeat pruning destroys valuable tool history (#75), and subagent delegations amplify privileges instead of inheriting scope limits (#72). Synchronous compactions without isolation cause network errors (like Telegram polling) to crash the entire agent (#108).

---

## Part 2: Target Architecture

### Ideal Module Structure & Data Flow

```text
[ OpenClaw Hooks ] ---> [ Session Context Manager (Keys on sessionKey) ]
                                |
                                v
[ Tool Auth & Validation ] ---> [ Engine / Ingest ] ---> [ Async Task Queue ]
  (ReDoS guards, Limits)                                         |
                                                                 v
[ Per-Agent Config ] <-------------------------> [ Compaction Pipeline (Incremental) ]
  (dbPath: {agentId})                                  - LLM Fallback Chain
                                                       - Cost Circuit Breaker
                                                       |
[ Eager Migration ] ---> [ SQLite Connection Pool / Serializer ]
                                |
                   [ Conversations (sessionKey) ]
                   [ Summaries DAG              ]
```

### Key Guarantees
1. **Session/Conversation Lifecycle:** `getOrCreateConversation` must use `sessionKey` as the primary identifier. Ephemeral UUIDs simply append to the same logical conversation, preserving the DAG across resets.
2. **Database Initialization:** Migrations are eager. When a new per-agent DB is requested, its schema is fully initialized before returning the connection.
3. **Compaction Strategy:** Incremental, bounded, and async. A cost circuit breaker tracks token spend per hour. Fallback chains handle safety filters gracefully. The engine reduces context incrementally to 75% rather than a 100% -> 44% burst.
4. **Error Isolation:** Network and LLM failures during compaction are caught and logged. They never crash the gateway or pollers. Tool inputs (like regex) are sanitized.

---

## Part 3: Refactoring Plan

### Step 1: Eager Database Initialization & Per-Agent Paths
**What to change:** 
- Modify `getLcmConnection()` to eagerly call `ensureSummaryDepthColumn` and migrations immediately after DB creation. 
- Update config resolution to parse `{agentId}` in `databasePath` using the session key.
**Bugs Fixed:** #103, #101, #98, #89
**Risk Level:** Low
**Verification:** Run `lcm_grep` in a fresh session before any messages are sent; it should return 0 results instead of "no such table". Verify distinct DB files are created for different agent IDs.

### Step 2: Session Key Continuity
**What to change:** 
- Refactor `getOrCreateConversation()` to lookup by `sessionKey` instead of `runtimeSessionId`.
- Update `ingest()` to associate new UUIDs with the existing persistent conversation.
**Bugs Fixed:** #107, #106
**Risk Level:** High (touches core data model)
**Verification:** Force a daily session reset; verify the new session inherits the summary DAG and pointers from the previous session.

### Step 3: Compaction Resilience & LLM Fallbacks
**What to change:** 
- Fix `resolveModel()` to actually use `pluginSummaryModel`.
- Remove `.includes("image")` checks on undefined `model.input`.
- Implement a comma-separated fallback chain for `LCM_SUMMARY_MODELS`.
- Bound the compaction loop to prevent single-pass overshoots and implement a token-based cost circuit breaker.
**Bugs Fixed:** #113, #111, #109, #95, #74
**Risk Level:** Medium
**Verification:** Configure a failing model (e.g., vLLM returning 403) as primary and a working model as fallback; verify compaction succeeds via fallback and respects the 75% threshold incrementally.

### Step 4: Tool Safety, Auth, and Sanitization
**What to change:** 
- Add `safe-regex2` validation and timeouts to `lcm_grep`.
- Modify `prepareSubagentSpawn()` and `validateExpansion()` to enforce `maxDepth` and `tokenCap` inheritance.
- Replace string-based `LCM_PRUNE_HEARTBEAT_OK` with semantic role/provenance checks.
- Wrap compaction in robust `try/catch` to isolate channel polling.
- Remove hardcoded tool priorities in `buildSystemPromptAddition()`.
**Bugs Fixed:** #115, #108, #105, #82, #76, #75, #72
**Risk Level:** Medium
**Verification:** Spawn a subagent and verify it cannot exceed its parent's token cap. Run a catastrophic backtracking regex through `lcm_grep` and ensure it rejects gracefully. Run `npm test` to ensure all 247 cases remain green.
