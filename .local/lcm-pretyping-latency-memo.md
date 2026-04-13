# LCM Pre-Typing Latency Deep Dive

## Scope

This memo focuses on work that can happen before the assistant visibly starts processing a user turn:

- plugin registration and engine/bootstrap startup
- `bootstrap()` and `reconcileSessionTail()`
- transcript maintenance paths that may run before or around prompt build
- `assemble()` work done before the model call
- DB/query patterns that scale with total DB size or total conversation size

## Executive Summary

Most likely causes of the reported 10-15 second pre-typing delay:

1. **Process-global startup work reruns DB-wide migration/backfill logic before the engine is usable.**
   File/function: `src/plugin/index.ts:1806`, `src/engine.ts:1231`, `src/db/migration.ts:447`
   Why: `register()` eagerly constructs `LcmContextEngine`, and the constructor immediately runs `runLcmMigrations()`. Those migrations unconditionally execute full-table backfills over `summaries` and `message_parts`, plus possible FTS setup/rebuild work. This scales with total LCM DB size, not the current conversation.

2. **`assemble()` resolves the entire conversation context before trimming to budget.**
   File/function: `src/engine.ts:3371`, `src/assembler.ts:903`
   Why: every turn, `assemble()` fetches all `context_items`, then sequentially resolves each one. Raw message items cost `getMessageById()` + `getMessageParts()`. Summary items cost `getSummary()`, and condensed summaries also cost `getSummaryParents()`. This scales with the size of the active conversation's context graph, not total DB size.

3. **`bootstrap()` slow path can scan the whole session transcript, then run repeated unindexed identity lookups during reconciliation.**
   File/function: `src/engine.ts:2565`, `src/engine.ts:2412`, `src/store/conversation-store.ts:533`
   Why: when the bootstrap checkpoint fast path misses, LCM reads the leaf path from the session file and may walk backward through every historical message. For each candidate anchor it does `hasMessage()` and sometimes `countMessagesByIdentity()`, but there is no supporting `(conversation_id, role, content)` index. This scales badly with long conversations and large session files.

4. **Slow bootstrap work is amplified by a database-wide transaction mutex, so one session can stall others.**
   File/function: `src/engine.ts:2589`, `src/store/conversation-store.ts:276`, `src/transaction-mutex.ts:89`
   Why: `bootstrap()` runs inside `conversationStore.withTransaction(async () => ...)`, and the transaction mutex is per `DatabaseSync` handle, not per session. A long-running bootstrap or lifecycle mutation can block other sessions' transactional work and make local slowness look global.

5. **Session lookup by `sessionId` can scan the entire `conversations` table.**
   File/function: `src/store/conversation-store.ts:316`, `src/db/migration.ts:595`
   Why: there is no index on `conversations.session_id`. If a call path falls back from `sessionKey` to `sessionId`, SQLite scans `conversations` and sorts for `ORDER BY active DESC, created_at DESC LIMIT 1`.

6. **Transcript maintenance can require a full session-file branch walk, but this is probably secondary for the reported symptom.**
   File/function: `src/engine.ts:2950`, `src/engine.ts:171`, `src/store/summary-store.ts:618`
   Why: `maintain()` calls `listTranscriptToolResultEntryIdsByCallId()`, which opens the session transcript with `SessionManager` and iterates the whole branch to map tool call ids. That scales with session transcript size, not total DB size, and only matters if maintenance is on the pre-prompt path.

## Ranked Findings

### 1. Eager engine construction runs DB-wide migration/backfill work

Relevant code:

- `src/plugin/index.ts:1891-1893` eagerly calls `initializeEngine()`
- `src/plugin/index.ts:1806-1813` opens SQLite and constructs `LcmContextEngine`
- `src/engine.ts:1240-1265` immediately runs `runLcmMigrations()`

Inside `runLcmMigrations()`:

- `backfillSummaryDepths()` at `src/db/migration.ts:110`
- `backfillSummaryMetadata()` at `src/db/migration.ts:213`
- `backfillToolCallColumns()` at `src/db/migration.ts:391`
- FTS table existence/rebuild logic at `src/db/migration.ts:659+`

Why this is a strong match:

- The work happens before the engine is ready for any lifecycle hook.
- The backfills are unconditional. They do not check schema version or whether a backfill is already complete.
- `backfillSummaryDepths()` touches all conversations with condensed summaries.
- `backfillSummaryMetadata()` iterates every conversation in `summaries`, joins `summary_messages` to `messages`, and updates every summary row.
- `backfillToolCallColumns()` runs three `UPDATE ... WHERE ... json_extract(...)` passes over `message_parts`.
- If FTS tables are missing/stale, SQLite bulk-loads all `messages` or all `summaries`.

Scaling behavior:

- **Large total DB:** yes, strongly.
- **Large single conversation:** only indirectly.
- **Global slowness across sessions:** yes.

This is the highest-probability explanation if the delay correlates with "large LCM DB" even when the active conversation is not especially large.

### 2. `assemble()` does full context materialization before budget trimming

Relevant code:

- `src/engine.ts:3371-3428`
- `src/assembler.ts:903-1059`
- `src/assembler.ts:1070-1185`
- `src/assembler.ts:779-807`

What happens:

- `getContextItems(conversationId)` loads all context items for the conversation.
- `resolveItems()` then walks every item sequentially.
- For message items:
  - `getMessageById()` at `src/assembler.ts:1102`
  - `getMessageParts()` at `src/assembler.ts:1108`
- For summary items:
  - `getSummary()` at `src/assembler.ts:1165`
  - `getSummaryParents()` for condensed summaries inside `formatSummaryContent()` at `src/assembler.ts:802`

Why it matters:

- Budgeting happens after resolution, not before.
- Even if only the fresh tail and a few summaries will be kept, LCM still resolves the entire context graph first.
- The code is sequential, so latency grows roughly linearly with the number of context items and the number of per-item round trips.

Scaling behavior:

- **Large total DB:** no, not directly.
- **Large single conversation / deep summary DAG:** yes.
- **Global slowness across sessions:** no, unless combined with DB contention elsewhere.

This is the strongest session-local explanation for slow pre-typing on long or heavily summarized conversations.

### 3. `bootstrap()` slow path does whole-file scan plus repeated unindexed identity checks

Relevant code:

- `src/engine.ts:2565-2840`
- `src/engine.ts:927-1003` `readLeafPathMessages()`
- `src/engine.ts:1152-1179` `readAppendedLeafPathMessages()`
- `src/engine.ts:2412-2528` `reconcileSessionTail()`
- `src/store/conversation-store.ts:533-560` `hasMessage()` / `countMessagesByIdentity()`

Fast path:

- If the bootstrap checkpoint matches current file size/mtime, bootstrap is cheap.
- If append-only checkpoint validation succeeds, only the appended tail is read.

Slow path:

- Read the whole session file via `readLeafPathMessages()`.
- Materialize `historicalMessages.map(toStoredMessage)`.
- Walk backward through historical messages to find an anchor.
- For each candidate anchor:
  - `hasMessage(conversationId, role, content)`
  - sometimes `countMessagesByIdentity(conversationId, role, content)`

Important index gap:

- The schema only guarantees `messages_conv_seq_idx` on `(conversation_id, seq)`.
- There is no index on `(conversation_id, role, content)` or any content hash.
- `EXPLAIN QUERY PLAN` confirms `hasMessage()` and `countMessagesByIdentity()` search `messages` using only `conversation_id` via `messages_conv_seq_idx`, then filter by `role` and `content`.

Why it matters:

- On a long session transcript, `reconcileSessionTail()` can perform many repeated scans over the same conversation's `messages`.
- Complexity is effectively proportional to session history length times stored message count in that conversation.

Scaling behavior:

- **Large total DB:** not much, unless conversations are also large.
- **Large single conversation / long session file:** yes, strongly.
- **Global slowness across sessions:** yes, when combined with the transaction mutex described below.

### 4. Slow bootstrap holds a DB-wide transaction lock

Relevant code:

- `src/engine.ts:2589-2808` wraps bootstrap work in `conversationStore.withTransaction(...)`
- `src/store/conversation-store.ts:276` uses `BEGIN IMMEDIATE`
- `src/transaction-mutex.ts:89-124` serializes transactions per `DatabaseSync`

Why this matters:

- The transaction wrapper encloses async work, including transcript-file reads and reconciliation logic.
- The mutex is per database handle, not per session or conversation.
- If one session enters the expensive bootstrap slow path, other sessions that need transactional LCM work can queue behind it.

Scaling behavior:

- **Large total DB:** indirect.
- **Large single conversation:** indirect.
- **Global slowness across sessions:** yes, strongly.

This is the main "local problem becomes global symptom" mechanism in the current code.

### 5. `sessionId` fallback lookup scans `conversations`

Relevant code:

- `src/store/conversation-store.ts:316-327` `getConversationBySessionId()`
- `src/store/conversation-store.ts:345-363` `getConversationForSession()`
- `src/db/migration.ts:639-645` only creates `session_key` indexes

Observed query-plan behavior:

- `EXPLAIN QUERY PLAN` shows `SCAN conversations` and `USE TEMP B-TREE FOR ORDER BY` for the `session_id` lookup query.

Why it matters:

- Any path lacking a stable `sessionKey` falls back to `sessionId`.
- Bootstrap, assemble, ingest, and lifecycle operations all call `getConversationForSession()`.
- If an agent class or lane regularly lacks `sessionKey`, lookup cost grows with total conversation count in the DB.

Scaling behavior:

- **Large total DB / many conversations:** yes.
- **Large single conversation:** no.
- **Global slowness across sessions:** yes, but probably smaller than migration cost unless the `conversations` table is very large.

### 6. Transcript maintenance does full transcript branch walks

Relevant code:

- `src/engine.ts:2950-3064` `maintain()`
- `src/engine.ts:171-194` `listTranscriptToolResultEntryIdsByCallId()`
- `src/store/summary-store.ts:618-672` `listTranscriptGcCandidates()`

What happens:

- `listTranscriptGcCandidates()` queries candidate tool-result rows from the DB.
- `listTranscriptToolResultEntryIdsByCallId(sessionFile)` opens the transcript with `SessionManager`, gets the branch, and scans the entire branch to build a `toolCallId -> entryId` map.
- Then `maintain()` builds replacement messages and may rewrite transcript entries.

Why it is probably secondary:

- This is session-file-size dependent, not DB-size dependent.
- It only affects pre-typing if OpenClaw invokes `maintain()` before the model call in the current lifecycle.

Still worth instrumenting because it can be expensive on long transcripts and can invalidate bootstrap checkpoints, causing later bootstrap slow paths.

## Global vs Local Slowness

### Most likely global slowness sources

- `runLcmMigrations()` in `LcmContextEngine` constructor
- unconditional summary/message-part backfills inside migrations
- `getConversationBySessionId()` when `sessionKey` is unavailable
- DB-wide transaction serialization making one slow bootstrap block unrelated sessions

### Most likely session-local slowness sources

- `assemble()` resolving all `context_items`
- `bootstrap()` reading the whole session transcript
- `reconcileSessionTail()` repeated identity checks inside one conversation
- transcript maintenance branch scans

### Best explanation for the reported symptom

If the delay correlates primarily with **large databases**, even for otherwise ordinary conversations, the leading suspect is:

- **eager engine initialization + unconditional DB-wide migration/backfill work**

If the delay correlates primarily with **specific long-lived chats**, the leading suspects are:

- **full-context assembly**
- **bootstrap slow-path reconciliation**

If one slow session seems to degrade unrelated sessions, the likely amplifier is:

- **the per-database transaction mutex around bootstrap/lifecycle mutations**

## Instrumentation Points

Minimal, high-signal instrumentation to add before fixing anything:

1. `src/plugin/index.ts` around `initializeEngine()`
   - time `createLcmDatabaseConnection()`
   - time `new LcmContextEngine(...)`
   - log whether the shared singleton path was hit or a cold init occurred

2. `src/engine.ts` constructor
   - time `getLcmDbFeatures()`
   - time `runLcmMigrations()`
   - inside migrations, log sub-timings for:
     - `backfillSummaryDepths()`
     - `backfillSummaryMetadata()`
     - `backfillToolCallColumns()`
     - FTS setup/rebuild checks

3. `src/transaction-mutex.ts`
   - measure wait time before a transaction acquires the lock
   - tag logs with operation name if possible (`bootstrap`, `before_reset`, `session_end`, compaction)

4. `src/engine.ts` `bootstrap()`
   - log which path fired:
     - checkpoint fast path
     - append-only path
     - full `readLeafPathMessages()` path
   - log:
     - session file size
     - historical message count
     - reconcile imported count
     - time spent in file read vs reconcile vs DB writes

5. `src/engine.ts` `reconcileSessionTail()`
   - count calls to `hasMessage()`
   - count calls to `countMessagesByIdentity()`
   - log anchor index, missing-tail length, and total elapsed time

6. `src/engine.ts` / `src/assembler.ts` `assemble()`
   - log `contextItems.length`
   - split time into:
     - `getContextItems()`
     - `resolveItems()`
     - post-resolution budgeting/filtering
   - also log counts:
     - raw message items
     - summary items
     - condensed summaries

7. `src/store/conversation-store.ts` `getConversationForSession()`
   - log whether resolution used `sessionKey` or fell back to `sessionId`

## Obvious Surgical Follow-Ups To Consider Later

Not implemented here, but the most obvious low-risk fixes to evaluate are:

1. Stop rerunning DB-wide backfills on every cold engine construction.
2. Add an index for `conversations(session_id, active, created_at)` or equivalent lookup path.
3. Add a message identity index or stored hash so `reconcileSessionTail()` does not scan by raw `content`.
4. Make `assemble()` avoid fully resolving items that are guaranteed to be dropped.
5. Move transcript/file reads out of the long-lived `BEGIN IMMEDIATE` bootstrap transaction.

## Bottom Line

The current codebase has both:

- **global DB-size-sensitive work** before the engine is ready, and
- **session-local conversation-size-sensitive work** before prompt assembly completes.

For the symptom as described, the highest-probability culprit is the cold-init path that eagerly opens the DB and reruns unconditional migration/backfill logic. The highest-probability session-local culprit is `assemble()` resolving the full context graph before trimming, followed by `bootstrap()` slow-path reconciliation when checkpoint fast paths miss.
