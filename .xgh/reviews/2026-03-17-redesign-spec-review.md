# Architectural Review: lossless-claude Memory Platform Redesign Spec

**Reviewer:** Claude (Opus 4.6)
**Date:** 2026-03-17
**Spec:** `.xgh/specs/2026-03-17-lossless-claude-redesign.md`
**Verdict:** Needs Revision (3 critical, 4 high, 5 medium issues)

---

## What Is Solid

The overall architecture is well-conceived. The daemon + thin MCP client split is the right call -- it avoids SQLite WAL contention from concurrent MCP stdio processes, centralises Qdrant client lifecycle, and gives xgh a clean HTTP surface. The DAG schema is proven (migration.ts is battle-tested with backfill logic). The promotion heuristics table is concrete and implementable. The "exit 2 blocks native, exit 0 falls back" contract is a smart degradation strategy. The migration table (what to keep vs remove) is accurate against the actual codebase.

---

## Prioritised Issues

### CRITICAL

**C1. PreCompact hook input contract is unverified and likely wrong.**

The spec assumes PreCompact receives `transcript_path` pointing to a JSONL file of the session transcript. Claude Code's hook system passes hook input as JSON on stdin, but the exact schema for PreCompact is not documented in Claude Code's public docs. The fields `session_id`, `transcript_path`, and `cwd` are assumed. If `transcript_path` is not provided (or the transcript format differs from what the existing `transcript-repair.ts` expects), the entire compaction pipeline is dead on arrival.

**Fix:** Before implementation, write a minimal PreCompact hook that dumps stdin to a file, trigger compaction in Claude Code, and verify the exact JSON schema. Document the verified schema in the spec. If `transcript_path` is not provided, the daemon will need to reconstruct the transcript from Claude Code's internal state or the conversation messages already in SQLite.

---

**C2. Summarisation LLM dependency is underspecified -- no Anthropic SDK integration path.**

The spec says LLM calls use `claude-haiku-4-5-20251001` via `ANTHROPIC_API_KEY`. The existing `summarize.ts` delegates to `deps.complete()` which is an OpenClaw plugin SDK abstraction. When OpenClaw is removed, there is no LLM call implementation. The spec names the model and says "Anthropic API" but does not specify:

- Which SDK (`@anthropic-ai/sdk`? Direct HTTP?)
- How the API key is loaded (env var? config.json `${ANTHROPIC_API_KEY}` interpolation?)
- Error handling for rate limits, auth failures, model unavailability
- Token budget for summarisation calls (max_tokens param)
- Whether the summarisation system prompt (already defined in `summarize.ts` line 27) carries over

The `config.json` shows `"apiKey": "${ANTHROPIC_API_KEY}"` which implies env var interpolation at config load time -- but this mechanism does not exist yet and must be built.

**Fix:** Add a "Summarisation" section specifying: SDK choice, API key resolution order (env > config > error), max_tokens per call, retry/backoff strategy, and confirm the existing system prompt is reused.

---

**C3. SessionStart `source` field: "compact" value may not exist in Claude Code's hook protocol.**

The spec says: `If source is "compact": skip context injection entirely`. This assumes Claude Code sends `source: "compact"` when SessionStart fires after a compaction event. Claude Code's documented SessionStart sources are `"startup"` and `"resume"`. The `"compact"` source is speculative. If it does not exist, the daemon has no way to distinguish a post-compaction SessionStart from a normal resume, and will double-inject context that was just compacted.

**Fix:** Verify against Claude Code's actual hook protocol. If `"compact"` is not a real source value, use an alternative detection mechanism: the daemon can check whether a compaction just completed for this session (e.g., compare `lastCompact` timestamp in meta.json against a short time window, or set a flag in an in-memory map keyed by session_id).

---

### HIGH

**H1. No `/expand` or `/describe` endpoint defined on the daemon, but MCP tools need them.**

The daemon HTTP surface lists: `/compact`, `/restore`, `/store`, `/search`, `/recent`, `/health`. But the MCP tool mapping shows `lcm_expand -> POST /expand` and `lcm_describe -> POST /describe`. These endpoints are missing from the daemon endpoint list (Section: Daemon > Process). Also, `lcm_grep` maps to `POST /search (scope: episodic)` which conflates grep (regex/keyword over raw text) with semantic search -- these are different operations. FTS5 MATCH syntax is not the same as regex grep.

**Fix:** Add `/expand`, `/describe`, and `/grep` to the daemon endpoint list. Separate grep (FTS5 + optional regex fallback) from search (semantic via Qdrant + FTS5 hybrid). The existing `RetrievalEngine` already distinguishes these.

---

**H2. SQLite connection lifecycle during compaction is not specified.**

Compaction involves multiple writes: inserting leaf nodes, generating summaries (LLM calls that can take seconds), inserting summary nodes, updating context_items. The spec says the daemon owns SQLite connections, but does not specify:

- Transaction boundaries (is the entire compaction one transaction? per-summary?)
- What happens if the LLM call fails mid-compaction (partial state)
- WAL mode (required for concurrent reads during writes)
- Connection pool size (the existing code uses `DatabaseSync` which is synchronous)

The existing `DatabaseSync` from `node:sqlite` is synchronous and single-threaded. If the daemon uses this, all HTTP endpoints block during a compaction write. With concurrent sessions hitting `/search` or `/restore`, this is a real problem.

**Fix:** Specify: (1) WAL mode is mandatory, (2) compaction uses a dedicated connection with BEGIN IMMEDIATE, (3) reads use a separate connection, (4) LLM calls happen outside the transaction (collect summaries first, then batch-write), (5) partial compaction failure rolls back cleanly.

---

**H3. Daemon port collision and discovery are fragile.**

Hard-coded port 3737 with no fallback. If another process binds 3737, the daemon fails to start and all hooks silently fall back to native compaction (exit 0). The user gets no error surfaced in Claude Code. The `daemon.lock` file and PID file are mentioned but the exact lock-check-start protocol is underspecified -- race windows exist between checking the lock and binding the port.

**Fix:** (1) Use a Unix domain socket (`~/.lossless-claude/daemon.sock`) instead of a TCP port -- eliminates port collision entirely and is faster for local IPC. (2) If TCP is kept, write the actual bound port to a discovery file (`daemon.port`) and have clients read it. (3) Specify the lock protocol precisely: `flock(daemon.lock, LOCK_EX | LOCK_NB)` -> check port -> bind -> write PID -> release lock.

---

**H4. The `lcm_search` tool conflates FTS5 and Qdrant but ranking/merging strategy is unspecified.**

`lcm_search` returns results from both SQLite FTS5 and Qdrant, but the spec does not describe how results are merged or ranked. FTS5 returns BM25 scores; Qdrant returns cosine similarity scores. These are on different scales. Without a defined merge strategy, results will be arbitrarily interleaved.

**Fix:** Specify the merge strategy. Options: (a) reciprocal rank fusion, (b) normalize scores to [0,1] then interleave, (c) return two separate ranked lists and let the caller (Claude) see the source. Option (c) is simplest and most transparent -- the `source` field is already in the output schema.

---

### MEDIUM

**M1. `large_files` table exists in migration.ts but is not mentioned in the spec.**

The actual schema has a `large_files` table (lines 465-474 of migration.ts) that the spec's schema summary omits entirely. The existing engine.ts references file handling logic (`large-files.ts`, `parseFileBlocks`, `formatFileReference`). The spec needs to decide: is file handling kept, removed, or deferred?

**Fix:** Add a line to the migration table: `src/large-files.ts` -> kept/removed/deferred. If kept, the `lcm_describe` tool already handles file nodes (see retrieval.ts DescribeResult which has a `file` variant).

---

**M2. The `assembler.ts` module is not in the migration table.**

`src/assembler.ts` (ContextAssembler) is imported by engine.ts and handles context window assembly. The spec removes engine.ts but does not mention assembler.ts. In the new architecture, context assembly for SessionStart restoration is a different problem than OpenClaw's assemble() -- but some of the logic (token budgeting, context_items ordering) may still be relevant.

**Fix:** Add `src/assembler.ts` to the migration table with a disposition (likely "adapt for /restore handler" or "remove -- restoration is simpler").

---

**M3. No versioning or migration story for `config.json`.**

The spec defines a config.json schema but does not specify what happens when the schema evolves. No version field, no migration logic. Future additions (new promotion signals, config keys) will break existing installs silently.

**Fix:** Add a `"version": 1` field to config.json and a config migration function in the installer.

---

**M4. The install command modifies `~/.claude/settings.json` but does not handle existing entries.**

If the user already has hooks or MCP servers configured, the installer must merge, not overwrite. The spec does not describe the merge strategy. A naive write would destroy existing user hooks.

**Fix:** Specify that the installer reads existing settings.json, merges the lossless-claude entries into the existing `hooks` and `mcpServers` objects, and writes back. Warn if conflicting PreCompact hooks already exist.

---

**M5. `expansion-auth.ts` and `expansion-policy.ts` are not in the migration table.**

These modules handle delegated expansion grants (for subagent sessions in OpenClaw). The spec does not mention them. They are likely removable since Claude Code does not have OpenClaw's subagent model, but this should be explicit.

**Fix:** Add both to the migration table as "Remove -- OpenClaw subagent specific."

---

## Minor Observations (LOW)

- **L1.** The `openclaw-bridge.ts` file is not in the removal list but is clearly OpenClaw-specific. Add to "Remove" list.
- **L2.** The spec references `meta.json` caching `lastCompact` but does not define the full meta.json schema. Define it.
- **L3.** The `tools/` directory has existing tool implementations (`lcm-grep-tool.ts`, `lcm-describe-tool.ts`, `lcm-expand-tool.ts`, `lcm-expand-query-tool.ts`) that are OpenClaw-registered. The spec should note these are adapted (not rewritten) for the MCP stdio surface.
- **L4.** No mention of logging strategy beyond `daemon.log`. Should specify log rotation or size caps to prevent disk fill.
- **L5.** The `store/full-text-fallback.ts` module is not in the migration table. Likely kept (FTS5 fallback for platforms without it).

---

## Overall Verdict: Needs Revision

The architecture is sound in concept. The daemon + MCP thin client split, the DAG reuse, the Qdrant promotion pipeline, and the graceful fallback on daemon failure are all well-designed. However, three critical issues block implementation:

1. The PreCompact hook input schema is unverified -- if `transcript_path` is not provided by Claude Code, the entire compaction path needs redesign.
2. The LLM summarisation path has no concrete implementation spec after OpenClaw's `deps.complete()` is removed.
3. The `source: "compact"` detection for SessionStart may not exist in Claude Code's protocol.

All three are resolvable with targeted investigation (a test hook dump, SDK integration spec, and Claude Code docs check). The high-priority items (missing daemon endpoints, SQLite concurrency, port collision, search merge) are design gaps that should be filled before implementation planning begins.

**Recommendation:** Resolve C1-C3 with empirical verification against Claude Code's actual hook protocol, then address H1-H4 in a spec revision. After that, this spec is ready for implementation planning.
