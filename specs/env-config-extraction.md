# Spec: Extract Environment Variable Reads into Config Module

## Problem

OpenClaw's security scanner flags `engine.ts` with a critical "env-harvesting" warning:

```
Environment variable access combined with network send — possible credential harvesting
```

This is a false positive. The scanner rule triggers when a file contains both `process.env` and the word pattern `/\bfetch\b|\bpost\b|http\.request/i`. In `engine.ts`, the match is:

- `process.env.LCM_LARGE_FILE_SUMMARY_PROVIDER` (line 684)
- The word "post" in a comment: `// ...best-effort in the post-turn lifecycle.` (line 1209)

This blocks first-time plugin installation with a scary warning that looks like the plugin is stealing credentials.

## Solution

Move all `process.env` reads out of `engine.ts` and `index.ts` into centralized config resolution, passed through `LcmDependencies` or `LcmConfig` at initialization time. No runtime env access in files that do I/O.

## Current State

### `src/engine.ts` (2 reads)
```ts
// line 684-685 — resolveLargeFileTextSummarizer()
const provider = process.env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? "";
const model = process.env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? "";
```

### `index.ts` (8 reads)
```ts
// line 62 — resolveApiKey(): process.env[key] (dynamic API key lookup)
// line 265 — resolveAuthStorePaths(): OPENCLAW_AGENT_DIR, PI_CODING_AGENT_DIR
// line 270 — resolveAuthStorePaths(): HOME
// line 529 — createLcmDependencies(): resolveLcmConfig(process.env)
// line 676 — resolveModel lambda: LCM_SUMMARY_MODEL
// line 691-692 — resolveModel lambda: LCM_SUMMARY_PROVIDER, OPENCLAW_PROVIDER
// line 759 — configSchema.parse(): resolveLcmConfig(process.env)
```

### `src/db/config.ts` (already centralized — 17 reads)
All `LCM_*` config vars already resolved here via `resolveLcmConfig()`. This is the model to follow.

## Changes

### 1. Extend `LcmConfig` with large-file summarizer config

Add to `src/db/config.ts`:

```ts
export type LcmConfig = {
  // ... existing fields ...

  /** Provider for large file text summarization (optional override). */
  largeFileSummaryProvider: string;
  /** Model for large file text summarization (optional override). */
  largeFileSummaryModel: string;
};
```

Populate in `resolveLcmConfig()`:
```ts
largeFileSummaryProvider: env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? "",
largeFileSummaryModel: env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? "",
```

### 2. Update `engine.ts` — read from config instead of env

In `resolveLargeFileTextSummarizer()`, replace:
```ts
const provider = process.env.LCM_LARGE_FILE_SUMMARY_PROVIDER?.trim() ?? "";
const model = process.env.LCM_LARGE_FILE_SUMMARY_MODEL?.trim() ?? "";
```
With:
```ts
const provider = this.deps.config.largeFileSummaryProvider;
const model = this.deps.config.largeFileSummaryModel;
```

This eliminates all `process.env` from `engine.ts`.

### 3. Consolidate `index.ts` env reads into an init-time snapshot

Create a helper that captures all env-derived values at plugin load time:

```ts
type PluginEnvSnapshot = {
  lcmSummaryModel: string;
  lcmSummaryProvider: string;
  openclawProvider: string;
  agentDir: string;
  home: string;
};

function snapshotPluginEnv(env: NodeJS.ProcessEnv = process.env): PluginEnvSnapshot {
  return {
    lcmSummaryModel: env.LCM_SUMMARY_MODEL?.trim() ?? "",
    lcmSummaryProvider: env.LCM_SUMMARY_PROVIDER?.trim() ?? "",
    openclawProvider: env.OPENCLAW_PROVIDER?.trim() ?? "",
    agentDir: env.OPENCLAW_AGENT_DIR?.trim() || env.PI_CODING_AGENT_DIR?.trim() || "",
    home: env.HOME?.trim() ?? "",
  };
}
```

Then use the snapshot in `createLcmDependencies()`, `resolveModel`, `resolveAuthStorePaths`, and `resolveApiKey` instead of live `process.env` reads.

**Note:** `resolveApiKey` does dynamic `process.env[key]` lookups for provider-specific API keys (e.g., `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). These can't be statically snapshotted since the key names depend on the provider being resolved. Two options:

- **Option A (pragmatic):** Pass `getEnv: (key: string) => string | undefined` as a closure captured at init time. The closure still reads `process.env`, but it lives in `index.ts` (which is the plugin entry point and doesn't trigger the scanner because it has no network I/O patterns).
- **Option B (pure):** Pre-resolve all known provider keys at init time into a `Map<string, string>`. Less flexible but avoids any runtime env access.

**Recommendation:** Option A. `index.ts` is the plugin shell — it's expected to do env/config wiring. The scanner only flags files with both env access AND network patterns, and `index.ts` has neither `fetch` nor `http.request` (nor false-positive "post" in comments). The goal is keeping `engine.ts` and other I/O-heavy files clean.

### 4. Verify scanner clear

After changes, no file in `src/` should contain `process.env`. Only `index.ts` (plugin entry) and `src/db/config.ts` (config module) should access env vars. Neither triggers the scanner because they don't contain network I/O patterns.

Verify:
```bash
grep -rn 'process\.env' src/engine.ts src/assembler.ts src/compaction.ts src/expansion.ts src/summarize.ts
# Expected: no matches
```

## Files Changed

| File | Change |
|------|--------|
| `src/db/config.ts` | Add `largeFileSummaryProvider`, `largeFileSummaryModel` to `LcmConfig` |
| `src/engine.ts` | Replace 2 `process.env` reads with `this.deps.config.*` |
| `index.ts` | Extract env reads into `snapshotPluginEnv()`, thread through deps |

## Testing

- Existing 378 tests should pass unchanged (they mock `LcmConfig` and `LcmDependencies`)
- Manually verify: `npm pack` + install on a clean OpenClaw instance → no scanner warning
- Verify large-file summarizer still works when env vars are set

## Non-Goals

- Changing the scanner heuristic (that's upstream OpenClaw's concern, and the heuristic is reasonable in general — "post" matching is a minor flaw but the principle is sound)
- Moving `resolveLcmConfig` out of `src/db/config.ts` (it's already the right place)
- Eliminating `process.env` from `index.ts` entirely (it's the plugin entry point, env wiring belongs there)
