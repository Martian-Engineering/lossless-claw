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
       │    ├─ spawns claude-server on port 3456
       │    ├─ waits for /health to respond OK (10s timeout)
       │    └─ monitors: restarts on failure (3 consecutive misses → give up)
       └─ configures LlmSummarizer
            └─ createOpenAISummarizer({ baseURL: "http://localhost:3456/v1" })
                 (existing, unchanged)
```

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
1. Check if port 3456 is already in use (skip spawn if so — proxy already running)
2. Spawn `claude-server` as child process (`stdio: 'pipe'`)
3. Poll `GET /health` every 500ms up to 10s
4. If timeout: mark unavailable, log actionable error, proceed without summarization
5. Register `process.on('exit')` cleanup to kill child process

**Health monitoring (after startup):**
- Ping `/health` every 30s
- 3 consecutive failures → attempt one restart
- One restart attempt; if restart fails → log and disable proxy (no further retries)

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

`"claude-cli"` maps to `baseURL: http://localhost:{claudeCliProxy.port}/v1` automatically — no `apiKey` required.

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

Add to `package.json`:
```json
"dependencies": {
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
