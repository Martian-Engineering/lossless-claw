# LCM Plugin Extraction Plan

## Overview

Extract LCM from OpenClaw's in-tree `src/plugins/lcm/` into this standalone plugin package `@martian-engineering/lossless-claw`. The source code has already been copied into `src/` and `test/` directories but all imports still reference OpenClaw core internals. The main task is to refactor imports using dependency injection.

## Architecture

### Dependency Injection

Instead of importing from OpenClaw core directly, the LCM engine receives its dependencies via `LcmDependencies` (defined in `src/types.ts`). The plugin entry point (`index.ts`) constructs these from the `OpenClawPluginApi`.

### Source Layout

```
src/
├── types.ts                    # LcmDependencies interface + helper types
├── engine.ts                   # LcmContextEngine (implements ContextEngine)
├── compaction.ts               # CompactionEngine
├── assembler.ts                # ContextAssembler
├── retrieval.ts                # RetrievalEngine
├── expansion.ts                # Expansion logic
├── expansion-auth.ts           # Auth grant lifecycle
├── expansion-policy.ts         # Expansion policy
├── summarize.ts                # Summarization with escalation
├── large-files.ts              # Large file interception
├── integrity.ts                # DAG integrity checks
├── db/
│   ├── config.ts               # LcmConfig (already clean — no core imports)
│   ├── connection.ts           # better-sqlite3 connection
│   └── migration.ts            # Schema migrations
├── store/
│   ├── conversation-store.ts   # Message/conversation CRUD
│   ├── summary-store.ts        # Summary/context_items CRUD
│   ├── fts5-sanitize.ts        # FTS5 query sanitization (already clean)
│   └── index.ts                # Re-exports
└── tools/
    ├── lcm-conversation-scope.ts
    ├── lcm-describe-tool.ts
    ├── lcm-expand-tool.ts
    ├── lcm-expand-tool.delegation.ts
    ├── lcm-expand-query-tool.ts
    └── lcm-grep-tool.ts
```

## Import Rewrite Map

Every import from OpenClaw core must be replaced. Here's the mapping:

### Context Engine Types
**From:** `../../context-engine/types.js`
**To:** `openclaw/plugin-sdk` (these are already exported)
```typescript
// Old:
import type { ContextEngine, AssembleResult, ... } from "../../context-engine/types.js";
// New:
import type { ContextEngine, AssembleResult, ... } from "openclaw/plugin-sdk";
```

### Context Engine Registry
**From:** `../../context-engine/registry.js` and `../../context-engine/init.js`
**To:** `openclaw/plugin-sdk` (registerContextEngine is exported)
```typescript
// Old:
import { registerContextEngine } from "../../context-engine/registry.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
// New:
import { registerContextEngine } from "openclaw/plugin-sdk";
// ensureContextEnginesInitialized and resolveContextEngine are used in tools —
// tools should receive the engine instance via closure from the register function
```

### Config
**From:** `../../config/config.js`
**To:** `openclaw/plugin-sdk` (OpenClawConfig is exported)
```typescript
// Old:
import { loadConfig, type OpenClawConfig } from "../../config/config.js";
// New:
import type { OpenClawConfig } from "openclaw/plugin-sdk";
// loadConfig: receive config via LcmDependencies or api.config
```

### LLM Completion (summarize.ts)
**From:** `@mariozechner/pi-ai` (completeSimple)
**To:** Inject via `LcmDependencies.complete`
```typescript
// Old:
import { completeSimple } from "@mariozechner/pi-ai";
// New: receive as deps.complete
```

### Model Auth (summarize.ts)
**From:** `../../agents/model-auth.js`
**To:** Inject via `LcmDependencies.getApiKey` / `LcmDependencies.requireApiKey`

### Model Resolution (summarize.ts)
**From:** `../../agents/pi-embedded-runner/model.js`
**To:** Inject via `LcmDependencies.resolveModel`

### Agent Paths (summarize.ts)
**From:** `../../agents/agent-paths.js`
**To:** Inject via `LcmDependencies.resolveAgentDir`

### SQLite (connection.ts)
**From:** `../../../memory/sqlite.js` (requireNodeSqlite)
**To:** Import `better-sqlite3` directly (it's a direct dependency)

### Session Key Utilities (tools)
**From:** `../../routing/session-key.js`
**To:** Inject via `LcmDependencies.parseAgentSessionKey`, `.isSubagentSessionKey`, `.normalizeAgentId`
Or: import `{ DEFAULT_ACCOUNT_ID, normalizeAccountId }` from `openclaw/plugin-sdk`

### Gateway Calls (tools)
**From:** `../../gateway/call.js`
**To:** Inject via `LcmDependencies.callGateway`

### Tool Helpers (tools)
**From:** `./common.js` (jsonResult, readStringParam, AnyAgentTool)
**To:** Define locally in `src/tools/common.ts` (these are simple utility functions)

### Subagent Utilities (expand tools)
**From:** `../lanes.js`, `../subagent-announce.js`, `./agent-step.js`
**To:** Inject via LcmDependencies

### Transcript Repair (assembler.ts)
**From:** `../../agents/session-transcript-repair.js`
**To:** Inject via `LcmDependencies.sanitizeToolUseResultPairing`

### Pi Agent Core Types
**From:** `@mariozechner/pi-agent-core`
**To:** Keep as direct peer dependency, or re-export from openclaw/plugin-sdk

## Refactoring Strategy

### Phase 1: Self-Contained Files (No Core Imports)
These files need no changes:
- `src/db/config.ts` ✅
- `src/store/fts5-sanitize.ts` ✅
- `src/store/index.ts` ✅

### Phase 2: Simple Import Rewrites
Files that only import types from core:
- `src/db/connection.ts` — replace `requireNodeSqlite` with direct `better-sqlite3` import
- `src/db/migration.ts` — check imports

### Phase 3: Dependency Injection Threading
Files that need `LcmDependencies` threaded through:
- `src/summarize.ts` — needs complete, resolveModel, getApiKey, requireApiKey, resolveAgentDir
- `src/assembler.ts` — needs sanitizeToolUseResultPairing
- `src/engine.ts` — orchestrates everything, needs full deps
- `src/compaction.ts` — needs summarize (which needs deps)
- `src/expansion.ts` — needs deps for expansion
- `src/expansion-auth.ts` — needs callGateway, parseAgentSessionKey
- `src/expansion-policy.ts` — needs config

### Phase 4: Tool Refactoring
Tools need the most work — they currently import from both LCM internals and core:
- Create `src/tools/common.ts` with local jsonResult/readStringParam
- Each tool becomes a factory function receiving LcmDependencies
- Tools use the engine instance from the plugin's register scope

### Phase 5: Test Adaptation
Tests need to mock LcmDependencies instead of core modules.

## Key Constraints

1. **Message types**: LCM heavily uses `@mariozechner/pi-agent-core` message types. These must remain available — either as a direct dependency or re-exported from openclaw.
2. **better-sqlite3**: Native dependency. Plugin install with `--ignore-scripts` may fail. Need to verify prebuild availability.
3. **Backward compat**: Env vars (LCM_CONTEXT_THRESHOLD etc.) must continue working.
4. **Database path**: Keep `~/.openclaw/lcm.db` as default.
