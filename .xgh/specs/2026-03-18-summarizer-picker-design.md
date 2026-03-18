# Summarizer Picker — Design Spec

**Date**: 2026-03-18
**Scope**: Let users choose how lossless-claude summarizes conversations: Anthropic API, local model, or custom OpenAI-compatible server.

---

## Problem

The compaction summarizer is hardcoded to the Anthropic API (`createAnthropicSummarizer`). Users running a local model stack (vllm-mlx / ollama) must still provide an Anthropic key just for summarization — an unnecessary dependency.

---

## Approach

Add `provider: "anthropic" | "openai"` and `baseURL: string` to `DaemonConfig.llm`. Extract `LcmSummarizeFn` to a shared `src/llm/types.ts`. Add a `createOpenAISummarizer` in `src/llm/openai.ts` using the `openai` npm package. Branch in `compact.ts` based on provider. Add an interactive picker to `install.ts` (after setup.sh, before writing `config.json`) using Node.js `readline/promises`.

---

## New Dependency

Add `openai` to `dependencies` in `package.json`:

```bash
npm install openai
```

---

## Config Shape

### Current `~/.lossless-claude/config.json` (llm section)

```json
{
  "llm": {
    "model": "claude-haiku-4-5-20251001",
    "apiKey": ""
  }
}
```

### New

```json
{
  "llm": {
    "provider": "anthropic",
    "model": "claude-haiku-4-5-20251001",
    "apiKey": "",
    "baseURL": ""
  }
}
```

- `provider` defaults to `"anthropic"` — existing installs without `provider` field keep working via `deepMerge` with `DEFAULTS`
- `baseURL` used when `provider = "openai"`; ignored when `provider = "anthropic"`
- `apiKey` used when `provider = "anthropic"`; may be empty string for local servers

---

## Components

### 1. `src/llm/types.ts` (new)

Extract `LcmSummarizeFn` out of `anthropic.ts` to avoid awkward cross-imports:

```typescript
export type SummarizeContext = { isCondensed?: boolean; targetTokens?: number; depth?: number };
export type LcmSummarizeFn = (text: string, aggressive?: boolean, ctx?: SummarizeContext) => Promise<string>;
```

Update `src/llm/anthropic.ts` to import from `./types.js` instead of declaring them inline.

### 2. `src/daemon/config.ts`

Extend `DaemonConfig.llm`:

```typescript
llm: {
  provider: "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseURL: string;
};
```

Update `DEFAULTS`:

```typescript
llm: { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: "", baseURL: "" }
```

Update `loadDaemonConfig` — gate the `ANTHROPIC_API_KEY` env fallback on `provider === "anthropic"` to avoid leaking the key to third-party OpenAI-compatible endpoints:

```typescript
// Before (current):
if (!merged.llm.apiKey && e.ANTHROPIC_API_KEY) merged.llm.apiKey = e.ANTHROPIC_API_KEY;

// After:
if (!merged.llm.apiKey && merged.llm.provider === "anthropic" && e.ANTHROPIC_API_KEY) {
  merged.llm.apiKey = e.ANTHROPIC_API_KEY;
}
```

### 3. `src/llm/openai.ts` (new)

Uses the `openai` npm package. Imports `LcmSummarizeFn` from `./types.js`.

```typescript
import OpenAI from "openai";
import type { LcmSummarizeFn } from "./types.js";
import { buildLeafSummaryPrompt, buildCondensedSummaryPrompt, resolveTargetTokens, LCM_SUMMARIZER_SYSTEM_PROMPT } from "../summarize.js";

type OpenAISummarizerOptions = {
  model: string;
  baseURL: string;
  apiKey?: string;
  _clientOverride?: any;
  _retryDelayMs?: number;
};

export function createOpenAISummarizer(opts: OpenAISummarizerOptions): LcmSummarizeFn {
  const client = opts._clientOverride ?? new OpenAI({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey || "local",  // many local servers require non-empty key
  });
  const retryDelayMs = opts._retryDelayMs ?? 1000;
  const MAX_RETRIES = 3;

  return async function summarize(text, aggressive, ctx = {}) {
    // ... same retry loop as anthropic.ts
    // uses client.chat.completions.create with system prompt + user message
  };
}
```

Same retry logic as `anthropic.ts`: 3 attempts, exponential backoff, no retry on 401.

### 4. `src/daemon/routes/compact.ts`

Replace:
```typescript
import { createAnthropicSummarizer } from "../../llm/anthropic.js";
// ...
const summarize = createAnthropicSummarizer(config.llm);
```

With:
```typescript
import { createAnthropicSummarizer } from "../../llm/anthropic.js";
import { createOpenAISummarizer } from "../../llm/openai.js";
// ...
const summarize = config.llm.provider === "openai"
  ? createOpenAISummarizer({ model: config.llm.model, baseURL: config.llm.baseURL, apiKey: config.llm.apiKey })
  : createAnthropicSummarizer(config.llm);
```

### 5. `installer/install.ts` — summarizer picker

Added as a new step between setup.sh and writing `config.json`. Uses Node.js `readline/promises` (built-in, no extra deps).

**Interface extension** — add `promptUser` to `ServiceDeps` for testability:

```typescript
export interface ServiceDeps {
  // ... existing fields
  promptUser: (question: string) => Promise<string>;
}
```

`defaultDeps` implements this with readline. `DryRunServiceDeps` implements it by logging `[dry-run] would prompt: <question>` and returning `""` (defaults to option 1 / Anthropic).

**Picker UI:**

```
  ─── Summarizer (for conversation compaction)

  1) Anthropic API     (best quality — requires API key)
  2) Local model       (reuse your vllm-mlx / ollama endpoint)
  3) Custom server     (any OpenAI-compatible URL)

  Pick [1]:
```

**Option 1 — Anthropic:**
- If `ANTHROPIC_API_KEY` is set in env: use it silently (no prompt)
- If not set: prompt "Enter Anthropic API key:"
- Model hardcoded to `claude-haiku-4-5-20251001`
- Config written: `{ provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: "${ANTHROPIC_API_KEY}", baseURL: "" }`
- API key stored as `"${ANTHROPIC_API_KEY}"` literal — resolved from env at runtime, never persisted in plaintext

**Option 2 — Local model:**
- Reads from `~/.cipher/cipher.yml` (written by setup.sh)

cipher.yml structure (controlled by setup.sh, always this exact format):
```yaml
llm:
  provider: openai
  model: <model-id>
  baseURL: http://localhost:<port>/v1
```

Parsing: line-by-line scan using these regexes (sufficient given the controlled format):
- Find `llm:` section start
- Extract `model:` value: `/^\s+model:\s*(\S+)/`
- Extract `baseURL:` value: `/^\s+baseURL:\s*(\S+)/`
- Stop at next top-level key (line not starting with whitespace)

For ollama (no `/v1` suffix in cipher.yml): append `/v1` if baseURL doesn't already end with `/v1`.

**Fallback if cipher.yml is missing or parsing fails:** warn `"Could not read local model config from ~/.cipher/cipher.yml — falling back to manual entry"` and re-prompt as Option 3.

**Option 3 — Custom server:**
- Prompt: `"Server URL (e.g. http://192.168.1.x:8080/v1): "`
- Prompt: `"Model name: "`
- Config written: `{ provider: "openai", model: "<entered>", apiKey: "", baseURL: "<entered>" }`

**Non-interactive fallback:**
- If stdin is not a TTY (`!process.stdin.isTTY`), skip picker and default to Option 1 with `ANTHROPIC_API_KEY` from env (preserves headless install behavior)

**Invalid input:** if user enters something other than 1/2/3 or blank, re-prompt once, then default to 1.

**Remove the old `ANTHROPIC_API_KEY` warning** in `install.ts` — no longer always required.

---

## Backwards Compatibility

- Existing `config.json` files without `provider` field: `deepMerge` with `DEFAULTS` fills in `provider: "anthropic"` — no migration needed, existing behavior unchanged
- `loadDaemonConfig` change is safe: only gates an existing fallback, no behavior change when `provider === "anthropic"` and key is already set

---

## Testing

- **Unit: `createOpenAISummarizer`** — mock `openai` client, assert correct prompt sent (system prompt + user message), retry on 5xx, no retry on 401, correct model/baseURL passed
- **Unit: `compact.ts` branching** — mock both summarizers, assert `createOpenAISummarizer` called when `provider === "openai"`, `createAnthropicSummarizer` called otherwise
- **Unit: `loadDaemonConfig`** — assert `provider` and `baseURL` merge from file; assert `ANTHROPIC_API_KEY` env NOT injected when `provider === "openai"`; assert it IS injected when `provider === "anthropic"`
- **Unit: picker — Option 1** — mock `promptUser`, assert config written with `provider: "anthropic"` and `apiKey: "${ANTHROPIC_API_KEY}"`
- **Unit: picker — Option 2** — write temp cipher.yml, assert correct baseURL/model extracted; test `/v1` appended for ollama-style URL; test graceful fallback when cipher.yml missing
- **Unit: picker — Option 3** — mock `promptUser` returning URL + model, assert config written correctly
- **Unit: picker — invalid input** — mock `promptUser` returning "5", assert re-prompt, then default to option 1
- **Unit: picker — non-TTY** — assert picker skipped, option 1 used

---

## Out of Scope

- Per-project summarizer config
- Streaming summarization
- Changing summarizer model separately from the cipher LLM picker
