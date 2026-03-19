# Claude Server as Default Summarizer — Design Spec

**Date:** 2026-03-19

---

## Goal

Make `claude-server` (the Claude CLI proxy) the default summarizer for lossless-claude. Users with a Claude Max/Pro subscription get zero-config summarization out of the box, with no API key required. Other providers remain available as options.

---

## Key Assumption

lossless-claude is a Claude Code plugin — the `claude` CLI is always installed. No CLI availability check is needed. The only failure mode is the user not being authenticated to Claude Max/Pro.

---

## Architecture

The lossless-claude daemon manages `claude-server` as a child process:

```
Plugin initializes
  └─ LcmDaemon.start()
       ├─ ClaudeCliProxyManager.start()   ← new
       │    ├─ spawns claude-server on port {claudeCliProxy.port}
       │    ├─ waits for /health to respond OK (10s timeout)
       │    └─ monitors: restarts on failure (3 consecutive misses → give up)
       └─ configures LlmSummarizer
            └─ createOpenAISummarizer({ baseURL: "http://localhost:{port}/v1", apiKey: "local" })
                 (existing, unchanged — apiKey: "local" already defaulted in openai.ts)
```

### Provider dispatch in `compact.ts`

`"claude-cli"` is resolved to `"openai"` + localhost baseURL before the existing binary branch runs. The compact handler never sees `"claude-cli"` as a provider value:

```typescript
// loadDaemonConfig resolves "claude-cli" → effectively openai with localhost baseURL
// compact.ts existing dispatch remains unchanged:
if (provider === "openai") → createOpenAISummarizer(baseURL, apiKey)
else                       → createAnthropicSummarizer(apiKey)
```

Resolution happens in `loadDaemonConfig`: if `provider === "claude-cli"`, set `provider = "openai"` and `baseURL = http://localhost:{port}/v1` before returning config.

---

## New Module: `src/daemon/proxy-manager.ts`

Single responsibility: lifecycle management of the claude-server child process.

```typescript
interface ProxyManager {
  start(): Promise<void>        // spawn, wait for health
  stop(): Promise<void>         // graceful shutdown
  isHealthy(): Promise<boolean> // GET /health
  readonly port: number
}
```

**Startup sequence:**
1. Check if the PID file (`~/.lossless-claude/lcm-proxy.pid`) exists and the recorded process is alive:
   - If alive: skip spawn, reuse existing process
   - If stale PID: delete file, proceed to spawn
   - If port is occupied by a foreign process (health check returns wrong or no `{"service":"claude-server"}`): treat as startup failure — log port conflict warning, mark unavailable, proceed without summarization
2. Spawn `claude-server` as child process (`stdio: 'pipe'`), write PID to `~/.claude/lcm-proxy.pid`
3. Poll `GET /health` every 500ms up to `startupTimeoutMs` — validate response contains `{"service":"claude-server"}` to confirm identity (not just any HTTP server on the port)
4. If timeout or wrong service: kill child, mark unavailable, log actionable error, proceed without summarization
5. Write PID to `~/.lossless-claude/lcm-proxy.pid` (same directory as daemon socket for consistency)
6. Register `process.on('SIGTERM')`, `process.on('SIGINT')` to send SIGTERM to child and await graceful shutdown; register `process.on('exit')` as final synchronous kill fallback; delete PID file on stop

**Health monitoring (after startup):**
- Ping `/health` every 30s, validate `{"service":"claude-server"}` identity
- 3 consecutive failures → attempt one restart (re-run startup sequence)
- If restart fails → log, delete PID file, disable proxy (no further retries)

**Failure message:**
```
[lcm] claude-server unavailable. Run 'claude login' to authenticate,
      then restart Claude Code. Alternatively, set LCM_SUMMARY_PROVIDER=anthropic
      and LCM_SUMMARY_API_KEY=<key> to use the Anthropic API directly.
```

---

## Config Changes (`DaemonConfig`)

```typescript
claudeCliProxy: {
  enabled: boolean         // default: true
  port: number             // default: 3456
  startupTimeoutMs: number // default: 10000
  model: string            // default: "claude-haiku-4-5"
}

llm: {
  provider: "claude-cli" | "anthropic" | "openai"  // default: "claude-cli"
  model: string
  baseURL?: string   // used when provider = "openai"
  apiKey?: string    // used when provider = "anthropic" or "openai"
}
```

`"claude-cli"` is resolved to `provider: "openai"` + `baseURL: http://localhost:{port}/v1` in `loadDaemonConfig` before being returned — no `apiKey` required.

### Required changes to `src/daemon/config.ts`

1. Add `claudeCliProxy` to the `DaemonConfig` type
2. Add `claudeCliProxy` defaults to the `DEFAULTS` constant:
   ```typescript
   claudeCliProxy: {
     enabled: true,
     port: 3456,
     startupTimeoutMs: 10000,
     model: "claude-haiku-4-5",
   }
   ```
3. Add `"claude-cli"` to the `llm.provider` union type
4. In `loadDaemonConfig`, after merging config, resolve `"claude-cli"`:
   ```typescript
   if (config.llm.provider === "claude-cli") {
     config.llm.provider = "openai";
     config.llm.baseURL = `http://localhost:${config.claudeCliProxy.port}/v1`;
   }
   ```

### Env var override

`LCM_SUMMARY_PROVIDER` does **not** exist yet — this is new work. Add env-var resolution to `loadDaemonConfig`:

```typescript
if (process.env.LCM_SUMMARY_PROVIDER) {
  config.llm.provider = process.env.LCM_SUMMARY_PROVIDER as LlmProvider;
}
```

When `LCM_SUMMARY_PROVIDER=anthropic` (or any non-`claude-cli` value), also set `config.claudeCliProxy.enabled = false` so the proxy is never started.

### Contradictory config (`provider: "claude-cli"` + `claudeCliProxy.enabled: false`)

If a user explicitly sets `provider: "claude-cli"` but `claudeCliProxy.enabled: false`, `loadDaemonConfig` should treat this as summarization disabled: log a warning and set `provider` to `undefined` (or a sentinel that causes `compact.ts` to skip summarization). The proxy is never started, and no localhost baseURL is written.

### `llm.apiKey` optionality

The current `DaemonConfig` type has `apiKey: string` (required). Changing to `apiKey?: string` is a breaking type change — all callsites referencing `config.llm.apiKey` must be updated to use optional chaining (`config.llm.apiKey?.`) or a fallback. This is required work for the implementation.

---

## Installer Changes

The summarizer picker becomes:

```
? Which summarizer do you want to use?
❯ Claude Max / Pro (recommended)
    Uses your existing subscription. No API key needed.
  Anthropic API key
    Direct API access. Requires LCM_SUMMARY_API_KEY.
  Local / custom OpenAI-compatible server
    Point to any OpenAI-compatible endpoint.
```

"Claude Max / Pro" is pre-selected. No CLI check needed (guaranteed installed). On selection: writes `provider: "claude-cli"` to config.

---

## Dependency

Add to `package.json` as an **optional dependency** — users who choose Anthropic API or a custom endpoint do not need it, and it should not block installation if unavailable:

```json
"optionalDependencies": {
  "claude-server": "^<version>"
}
```

**Pre-requisite:** `claude-server` must be published to npm before implementation begins. This is a manual step outside this codebase.

---

## Fallback Behavior

| Scenario | Behavior |
|---|---|
| Proxy starts successfully | Summarization via Claude Max/Pro |
| Proxy fails to start | Summarization disabled, actionable log message |
| Proxy dies mid-session | One restart attempt; if fails, summarization disabled for session |
| User sets `LCM_SUMMARY_PROVIDER=anthropic` | Proxy not started, Anthropic API used directly |
| User sets `claudeCliProxy.enabled: false` | Proxy not started |

---

## Out of Scope

- Embedding provider selection (separate feature)
- claude-server publication to npm (pre-requisite, separate task)
