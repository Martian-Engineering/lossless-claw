# Cluster 4: Execution Report

**Branch:** `nyx-lossless-v2`  
**Date:** 2026-03-17  
**Test result:** ✅ 248/248 passed  

---

## Fix A: Remove hardcoded qmd recall priority (#115)

**File:** `src/assembler.ts` (line 68)  
**Status:** ✅ Complete

Replaced the hardcoded recall priority string that referenced `qmd` (Granola/Limitless/pre-LCM data):
```
Before: "**Recall priority:** LCM tools first, then qmd (for Granola/Limitless/pre-LCM data), then memory_search as last resort."
After:  "**Recall priority:** Use LCM context tools (lcm_grep, lcm_expand_query) for conversation history, and memory_search for long-term memory and workspace files."
```

All references to `qmd` removed from `assembler.ts`. Verified with `grep -n "qmd" src/assembler.ts` — no results.

---

## Fix B: Timezone display — store UTC, display local (#82)

**Files:** `src/tools/lcm-grep-tool.ts`, `src/tools/lcm-describe-tool.ts`  
**Status:** ✅ Complete

Per briefing instructions, timestamps are formatted at the **tool output layer**, not in the store mappers. The DB records correctly use `Date` objects (timezone-agnostic).

Changes:
- Removed `import { formatTimestamp } from "../compaction.js"` from both tool files (was using `formatTimestamp(date, timezone)` which required passing timezone explicitly).
- Added a local `formatLocalTime()` helper in each tool file that uses `date.toLocaleString(undefined, { timeZoneName: "short" })` — automatically uses the system locale.
- Replaced all `formatTimestamp(…, timezone)` calls with `formatLocalTime(…)` in grep result lines (messages, summaries, time filters) and describe output (meta range, manifest range, file created).
- Removed `const timezone = input.lcm.timezone;` from tool execute bodies (no longer needed at tool output layer).

Internal fields (`createdAt`, `updatedAt`) in store mappers remain untouched as `Date` objects.

---

## Fix C: Sanitize voice transcription JSON leaking (#105)

**File:** `src/engine.ts` — `extractMessageContent()` and new `extractStructuredText()`  
**Status:** ✅ Complete

Added a recursive `extractStructuredText()` function that intelligently extracts text from structured tool responses (e.g., AssemblyAI voice transcription JSON). Key features:

- Checks for known text fields: `text`, `transcript`, `transcription`, `message`, `summary`
- Checks for array fields containing transcript segments: `segments`, `utterances`, `paragraphs`, `alternatives`, `words`, `items`, `results`
- Checks nested container fields: `content`, `output`, `result`, `payload`, `data`, `value`
- Handles JSON-encoded strings by detecting `{…}` / `[…]` patterns and recursively parsing
- Depth-limited to 6 levels to prevent runaway recursion
- Falls back to `JSON.stringify()` only when no structured text can be extracted

`extractMessageContent()` now calls `extractStructuredText()` first before falling back to serialization. This preserves backward compatibility: plain strings and `[{type:"text", text:"…"}]` arrays still extract correctly, but raw JSON tool outputs now yield just the transcript text.

---

## Fix D: ReDoS protection for regex grep (#76)

**Files:** `src/store/conversation-store.ts` (~line 737), `src/store/summary-store.ts` (~line 814)  
**Status:** ✅ Complete (applied in prior session, verified intact)

Both `searchRegex()` methods now include:

1. **Pattern safety check:** Rejects patterns with nested quantifiers via `/(\+|\*|\?)\)(\+|\*|\?|\{\d)/.test(pattern)` and patterns exceeding 500 characters.
2. **Row-scan cap:** `MAX_ROW_SCAN = 10_000` — aborts scanning after 10k rows and returns partial results.
3. **try/catch on RegExp construction:** Invalid regex returns empty results instead of crashing.

---

## Fix E: Semantic heartbeat pruning (#75)

**File:** `src/engine.ts` — `pruneHeartbeatOkTurns()` and `isHeartbeatOkContent()`  
**Status:** ✅ Complete

Two key changes:

### 1. Exact match only
`isHeartbeatOkContent()` now requires **exact** (case-insensitive, trimmed) match of `"heartbeat_ok"`. Previously it matched substring patterns like `"HEARTBEAT_OK — weekend, no market"` and trailing `"… HEARTBEAT_OK"`. Chatty heartbeats that contain real info are now preserved.

### 2. Tool-call-aware pruning
`pruneHeartbeatOkTurns()` now checks before deleting a turn:
- Skips if any message in the turn has `role === "tool"` (quick check on message records)
- Skips if any `message_parts` row indicates tool usage (via `messagePartIndicatesToolUsage()` helper that checks `partType`, `toolCallId`, `toolName`, `toolInput`, `toolOutput`, and `metadata.rawType`)

Added supporting infrastructure:
- `messagePartIndicatesToolUsage()` function with `TOOL_PART_TYPES` and `TOOL_RAW_TYPES` sets
- `turnHasToolInteractions()` private method on `LcmContextEngine`
- Imported `MessagePartRecord` type into engine

---

## Fix F: Grant scope inheritance for sub-agents (#72)

**Files:** `src/expansion-auth.ts`, `src/engine.ts`  
**Status:** ✅ Complete

### `prepareSubagentSpawn()` (engine.ts)
Child grants now inherit the **intersection** of parent scope:
- `tokenCap = Math.min(parentGrant.remainingBudget, config.maxExpandTokens)`
- `maxDepth = Math.max(0, parentGrant.maxDepth - 1)` (decrements per generation)
- `allowedSummaryIds` inherited from parent grant when non-empty

When no parent grant exists (top-level spawn), defaults apply unchanged.

### `validateExpansion()` (expansion-auth.ts)
Depth and tokenCap are no longer hard-rejected in validation. Instead, both are **clamped** at execution time in `wrapWithAuth()`:
- `effectiveDepth = Math.min(requestedDepth, grantMaxDepth)`
- `effectiveTokenCap = Math.min(requestedTokenCap, remainingBudget)`

This matches the existing tokenCap behavior and prevents authorization failures when subagents request more than their parent allows — they simply get clamped.

### Test update
`test/expansion-auth.test.ts`: Updated test `"rejects requests exceeding grant maxDepth"` → `"allows oversized depth (clamped at execution by wrapWithAuth)"` to match the new clamping semantics.

---

## Test Results

```
 Test Files  20 passed (20)
      Tests  248 passed (248)
   Duration  ~2.3s
```

All 248 tests pass with zero failures.
