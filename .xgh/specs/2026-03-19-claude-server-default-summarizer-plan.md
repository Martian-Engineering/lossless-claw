# Claude Server Default Summarizer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make claude-server the default summarizer for lossless-claude, with the daemon managing it as a child process.

**Architecture:** Add ClaudeCliProxyManager to manage the claude-server child process lifecycle. Extend DaemonConfig with `claudeCliProxy` and `"claude-cli"` provider. Resolve `"claude-cli"` to `"openai"` + localhost baseURL in loadDaemonConfig so the existing compact.ts dispatch is unchanged except for a new `"disabled"` branch.

**Tech Stack:** TypeScript, Node.js child_process, vitest

---

## Task 1: Extend DaemonConfig type + DEFAULTS

**Files:**
- Modify: `/Users/pedro/Developer/lossless-claude/src/daemon/config.ts`
- Test: `/Users/pedro/Developer/lossless-claude/test/daemon/config.test.ts`

### Steps

- [ ] **1.1** Add failing tests to `test/daemon/config.test.ts`:

```typescript
// Add these tests to the existing describe("loadDaemonConfig", ...) block:

it("resolves 'claude-cli' provider to 'openai' with localhost baseURL", () => {
  const c = loadDaemonConfig("/nonexistent", {
    llm: { provider: "claude-cli" },
  });
  expect(c.llm.provider).toBe("openai");
  expect(c.llm.baseURL).toBe("http://localhost:3456/v1");
});

it("resolves 'claude-cli' + claudeCliProxy.port override to correct baseURL", () => {
  const c = loadDaemonConfig("/nonexistent", {
    llm: { provider: "claude-cli" },
    claudeCliProxy: { port: 9999 },
  });
  expect(c.llm.provider).toBe("openai");
  expect(c.llm.baseURL).toBe("http://localhost:9999/v1");
});

it("resolves 'claude-cli' + claudeCliProxy.enabled=false to 'disabled'", () => {
  const c = loadDaemonConfig("/nonexistent", {
    llm: { provider: "claude-cli" },
    claudeCliProxy: { enabled: false },
  });
  expect(c.llm.provider).toBe("disabled");
});

it("throws when provider resolves to 'anthropic' and apiKey is missing", () => {
  expect(() =>
    loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", apiKey: "" } }, {})
  ).toThrow("LCM_SUMMARY_API_KEY is required");
});

it("does not throw for 'anthropic' when apiKey is provided", () => {
  expect(() =>
    loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic", apiKey: "sk-test" } }, {})
  ).not.toThrow();
});

it("does not throw for 'anthropic' when ANTHROPIC_API_KEY env var is set", () => {
  expect(() =>
    loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic" } }, { ANTHROPIC_API_KEY: "sk-env" })
  ).not.toThrow();
});

it("LCM_SUMMARY_PROVIDER env var overrides config provider", () => {
  const c = loadDaemonConfig(
    "/nonexistent",
    { llm: { provider: "claude-cli" } },
    { LCM_SUMMARY_PROVIDER: "openai" }
  );
  // "openai" from env — NOT resolved through claude-cli path
  expect(c.llm.provider).toBe("openai");
});

it("LCM_SUMMARY_PROVIDER=anthropic disables claudeCliProxy", () => {
  const c = loadDaemonConfig(
    "/nonexistent",
    { llm: { provider: "claude-cli", apiKey: "sk-test" } },
    { LCM_SUMMARY_PROVIDER: "anthropic" }
  );
  expect(c.llm.provider).toBe("anthropic");
  expect(c.claudeCliProxy.enabled).toBe(false);
});

it("defaults claudeCliProxy fields correctly", () => {
  const c = loadDaemonConfig("/nonexistent");
  expect(c.claudeCliProxy).toEqual({
    enabled: true,
    port: 3456,
    startupTimeoutMs: 10000,
    model: "claude-haiku-4-5",
  });
});

it("defaults llm.provider to 'claude-cli'", () => {
  // After this change, the default provider becomes claude-cli
  // but it resolves to openai, so we test the resolved value
  const c = loadDaemonConfig("/nonexistent");
  expect(c.llm.provider).toBe("openai");
  expect(c.llm.baseURL).toBe("http://localhost:3456/v1");
});
```

- [ ] **1.2** Run tests to confirm they fail:

```bash
npx vitest run test/daemon/config.test.ts
```

Expected: all new tests fail (type errors and missing logic).

- [ ] **1.3** Update the `DaemonConfig` type in `src/daemon/config.ts`:

Replace the existing type definition:

```typescript
export type DaemonConfig = {
  version: number;
  daemon: { port: number; socketPath: string; logLevel: string; logMaxSizeMB: number; logRetentionDays: number };
  compaction: {
    leafTokens: number; maxDepth: number;
    promotionThresholds: { minDepth: number; compressionRatio: number; keywords: Record<string, string[]>; architecturePatterns: string[] };
  };
  restoration: { recentSummaries: number; semanticTopK: number; semanticThreshold: number };
  llm: { provider: "claude-cli" | "anthropic" | "openai" | "disabled"; model: string; apiKey?: string; baseURL: string };
  claudeCliProxy: { enabled: boolean; port: number; startupTimeoutMs: number; model: string };
  cipher: { configPath: string; collection: string };
};
```

Key changes:
- `llm.provider` union: add `"claude-cli" | "disabled"`
- `llm.apiKey`: change from `string` to `string | undefined` (i.e., `apiKey?: string`)
- Add `claudeCliProxy` field

- [ ] **1.4** Update the `DEFAULTS` constant — change the `llm` defaults and add `claudeCliProxy`:

```typescript
const DEFAULTS: DaemonConfig = {
  version: 1,
  daemon: { port: 3737, socketPath: join(homedir(), ".lossless-claude", "daemon.sock"), logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7 },
  compaction: {
    leafTokens: 1000, maxDepth: 5,
    promotionThresholds: {
      minDepth: 2, compressionRatio: 0.3,
      keywords: { decision: ["decided", "agreed", "will use", "going with", "chosen"], fix: ["fixed", "root cause", "workaround", "resolved"] },
      architecturePatterns: ["src/[\\w/]+\\.ts", "[A-Z][a-zA-Z]+(Engine|Store|Service|Manager|Handler|Client)", "interface [A-Z]", "class [A-Z]"],
    },
  },
  restoration: { recentSummaries: 3, semanticTopK: 5, semanticThreshold: 0.35 },
  llm: { provider: "claude-cli", model: "claude-haiku-4-5", apiKey: "", baseURL: "" },
  claudeCliProxy: { enabled: true, port: 3456, startupTimeoutMs: 10000, model: "claude-haiku-4-5" },
  cipher: { configPath: join(homedir(), ".cipher", "cipher.yml"), collection: "lossless_memory" },
};
```

- [ ] **1.5** Add resolution logic at the end of `loadDaemonConfig`, replacing the current return statement. The full function becomes:

```typescript
export function loadDaemonConfig(configPath: string, overrides?: any, env?: Record<string, string | undefined>): DaemonConfig {
  const e = env ?? process.env;
  let fileConfig: any = {};
  try { fileConfig = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  const merged = deepMerge(structuredClone(DEFAULTS), deepMerge(fileConfig, overrides));
  if (merged.llm.apiKey) merged.llm.apiKey = merged.llm.apiKey.replace(/\$\{(\w+)\}/g, (_: string, k: string) => e[k] ?? "");

  // Env var override: LCM_SUMMARY_PROVIDER takes precedence over config
  if (e.LCM_SUMMARY_PROVIDER) {
    merged.llm.provider = e.LCM_SUMMARY_PROVIDER;
    // When overriding away from claude-cli, disable the proxy
    if (merged.llm.provider !== "claude-cli") {
      merged.claudeCliProxy.enabled = false;
    }
  }

  // Anthropic API key fallback from env
  if (!merged.llm.apiKey && merged.llm.provider === "anthropic" && e.ANTHROPIC_API_KEY) {
    merged.llm.apiKey = e.ANTHROPIC_API_KEY;
  }

  // Resolve "claude-cli" provider
  if (merged.llm.provider === "claude-cli") {
    if (merged.claudeCliProxy.enabled) {
      merged.llm.provider = "openai";
      merged.llm.baseURL = `http://localhost:${merged.claudeCliProxy.port}/v1`;
    } else {
      // Contradictory: claude-cli requested but proxy disabled → disable summarization
      merged.llm.provider = "disabled";
    }
  }

  // Validate: anthropic provider requires an API key
  if (merged.llm.provider === "anthropic" && !merged.llm.apiKey) {
    throw new Error(
      "[lcm] LCM_SUMMARY_API_KEY is required when using the Anthropic provider. " +
      "Set it in your environment or switch to 'claude-cli' provider."
    );
  }

  return merged;
}
```

- [ ] **1.6** Fix the existing test `"defaults provider to 'anthropic' and baseURL to empty string"` — it will now fail because the default provider is `"claude-cli"` which resolves to `"openai"`. Update it:

```typescript
it("defaults provider to 'openai' (resolved from claude-cli) with localhost baseURL", () => {
  const c = loadDaemonConfig("/nonexistent/config.json");
  expect(c.llm.provider).toBe("openai");
  expect(c.llm.baseURL).toBe("http://localhost:3456/v1");
});
```

Also fix `"does NOT inject ANTHROPIC_API_KEY when provider is openai"` — the provider override needs explicit env to bypass claude-cli resolution:

```typescript
it("does NOT inject ANTHROPIC_API_KEY when provider is openai", () => {
  const c = loadDaemonConfig("/nonexistent", { llm: { provider: "openai" } }, { ANTHROPIC_API_KEY: "sk-leaked" });
  expect(c.llm.apiKey).toBe("");
});
```

This test should still pass since `provider: "openai"` bypasses the claude-cli resolution and the ANTHROPIC_API_KEY injection only runs when `provider === "anthropic"`.

Also fix `"falls back to env var when apiKey not set"` — this previously tested the anthropic provider fallback, but now the default provider is `"claude-cli"` which resolves to `"openai"`. Update it to explicitly set provider:

```typescript
it("falls back to env var when apiKey not set and provider is anthropic", () => {
  const c = loadDaemonConfig("/nonexistent", { llm: { provider: "anthropic" } }, { ANTHROPIC_API_KEY: "sk-env" });
  expect(c.llm.apiKey).toBe("sk-env");
});
```

- [ ] **1.7** Run tests to confirm they pass:

```bash
npx vitest run test/daemon/config.test.ts
```

Expected: all tests pass.

- [ ] **1.8** Run the full test suite to check for breakage from the type change (`apiKey` now optional):

```bash
npx vitest run
```

If any tests fail due to `apiKey` being undefined where a string was expected, fix those callsites (see Task 2 for compact.ts fixes). The `makeConfig` helper in `test/daemon/routes/compact.test.ts` will need its provider union updated — see Task 2.

- [ ] **1.9** Commit:

```bash
git add src/daemon/config.ts test/daemon/config.test.ts
git commit -m "feat: extend DaemonConfig with claude-cli provider and claudeCliProxy settings"
```

---

## Task 2: Update compact.ts for "disabled" provider

**Files:**
- Modify: `/Users/pedro/Developer/lossless-claude/src/daemon/routes/compact.ts`
- Test: `/Users/pedro/Developer/lossless-claude/test/daemon/routes/compact.test.ts`

### Steps

- [ ] **2.1** Add failing tests to `test/daemon/routes/compact.test.ts`. First update the `makeConfig` helper to accept the new provider types, then add the `"disabled"` test:

Update the `makeConfig` function signature:

```typescript
function makeConfig(provider: "anthropic" | "openai" | "disabled"): DaemonConfig {
  return {
    version: 1,
    daemon: { port: 3737, socketPath: "/tmp/test.sock", logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7 },
    compaction: {
      leafTokens: 1000, maxDepth: 5,
      promotionThresholds: { minDepth: 2, compressionRatio: 0.3, keywords: {}, architecturePatterns: [] },
    },
    restoration: { recentSummaries: 3, semanticTopK: 5, semanticThreshold: 0.35 },
    llm: { provider, model: "test-model", apiKey: "sk-test", baseURL: "http://localhost:11435/v1" },
    claudeCliProxy: { enabled: true, port: 3456, startupTimeoutMs: 10000, model: "claude-haiku-4-5" },
    cipher: { configPath: "/tmp/cipher.yml", collection: "test" },
  };
}
```

Add new test:

```typescript
it("returns no-op when provider is 'disabled' — no summarizer created", () => {
  vi.clearAllMocks();
  createCompactHandler(makeConfig("disabled"));
  expect(createAnthropicSummarizer).not.toHaveBeenCalled();
  expect(createOpenAISummarizer).not.toHaveBeenCalled();
});
```

- [ ] **2.2** Run tests to confirm the new test fails:

```bash
npx vitest run test/daemon/routes/compact.test.ts
```

Expected: the `"disabled"` test fails because compact.ts doesn't handle the `"disabled"` provider.

- [ ] **2.3** Update `src/daemon/routes/compact.ts` to handle `"disabled"` provider. Replace the summarizer creation block at the top of `createCompactHandler`:

```typescript
export function createCompactHandler(config: DaemonConfig): RouteHandler {
  const summarize =
    config.llm.provider === "disabled"
      ? null
      : config.llm.provider === "openai"
        ? createOpenAISummarizer({
            model: config.llm.model,
            baseURL: config.llm.baseURL,
            apiKey: config.llm.apiKey,
          })
        : createAnthropicSummarizer({
            model: config.llm.model,
            apiKey: config.llm.apiKey ?? "",
          });

  return async (_req, res, body) => {
    // When summarization is disabled, return early with informative message
    if (!summarize) {
      sendJson(res, 200, { summary: "Summarization disabled — no summarizer configured." });
      return;
    }

    const input = JSON.parse(body || "{}");
    // ... rest unchanged
```

- [ ] **2.4** Add an integration-level test for the disabled handler response:

```typescript
describe("POST /compact with disabled provider", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("returns early with message when provider is disabled", async () => {
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    // loadDaemonConfig resolves claude-cli, but "disabled" stays as-is
    daemon = await createDaemon(config);
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/compact`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session_id: "test-sess", cwd: "/tmp/test-disabled-proj" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toContain("disabled");
  });
});
```

- [ ] **2.5** Run tests to confirm they pass:

```bash
npx vitest run test/daemon/routes/compact.test.ts
```

- [ ] **2.6** Commit:

```bash
git add src/daemon/routes/compact.ts test/daemon/routes/compact.test.ts
git commit -m "feat: handle 'disabled' provider in compact handler — skip summarization gracefully"
```

---

## Task 3: ClaudeCliProxyManager

**Files:**
- Create: `/Users/pedro/Developer/lossless-claude/src/daemon/proxy-manager.ts`
- Test: `/Users/pedro/Developer/lossless-claude/test/daemon/proxy-manager.test.ts`

### Steps

- [ ] **3.1** Create the test file `test/daemon/proxy-manager.test.ts` with failing tests:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ProxyManager } from "../../src/daemon/proxy-manager.js";

// We'll mock child_process, fs, and http to test without real processes
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    unlinkSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
  };
});

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { createClaudeCliProxyManager } from "../../src/daemon/proxy-manager.js";

function makeMockChild(exitCode: number | null = null) {
  const child: any = {
    pid: 12345,
    killed: false,
    on: vi.fn(),
    kill: vi.fn().mockImplementation(() => { child.killed = true; }),
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    unref: vi.fn(),
  };
  return child;
}

describe("ClaudeCliProxyManager", () => {
  let manager: ProxyManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = createClaudeCliProxyManager({
      port: 13456,
      startupTimeoutMs: 500,
      model: "claude-haiku-4-5",
      pidFilePath: "/tmp/test-lcm-proxy.pid",
      healthPollIntervalMs: 50,
      _fetchOverride: vi.fn(),
    });
  });

  it("has correct port", () => {
    expect(manager.port).toBe(13456);
  });

  it("available is false before start()", () => {
    expect(manager.available).toBe(false);
  });

  describe("start()", () => {
    it("spawns claude-server and writes PID file when no existing process", async () => {
      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      // Mock fetch for health check — respond OK after spawn
      const mockFetch = vi.fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ service: "claude-server" }),
        });
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      await manager.start();

      expect(spawn).toHaveBeenCalledWith(
        "claude-server",
        expect.arrayContaining(["--port", "13456"]),
        expect.objectContaining({ stdio: "pipe" }),
      );
      expect(writeFileSync).toHaveBeenCalledWith(
        "/tmp/test-lcm-proxy.pid",
        "12345",
      );
      expect(manager.available).toBe(true);
    });

    it("reuses existing process when PID file exists and health check passes", async () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("99999");

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "claude-server" }),
      });
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
        _killCheck: vi.fn().mockReturnValue(true), // process alive
      });

      await manager.start();

      expect(spawn).not.toHaveBeenCalled();
      expect(manager.available).toBe(true);
    });

    it("cleans up stale PID and spawns when recorded process is dead", async () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
      (readFileSync as ReturnType<typeof vi.fn>).mockReturnValue("99999");

      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);

      const mockFetch = vi.fn()
        // First call: stale PID health check fails
        .mockRejectedValueOnce(new Error("ECONNREFUSED"))
        // Second call: new process health check succeeds
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ service: "claude-server" }),
        });

      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
        _killCheck: vi.fn().mockReturnValue(false), // process dead
      });

      await manager.start();

      expect(unlinkSync).toHaveBeenCalledWith("/tmp/test-lcm-proxy.pid");
      expect(spawn).toHaveBeenCalled();
    });

    it("marks unavailable when port is occupied by a foreign process", async () => {
      (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);

      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);

      // Health check returns wrong service identity
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "some-other-server" }),
      });

      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 500,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      await manager.start();

      expect(manager.available).toBe(false);
      warnSpy.mockRestore();
    });
  });

  describe("stop()", () => {
    it("kills child process and deletes PID file", async () => {
      const child = makeMockChild();
      (spawn as ReturnType<typeof vi.fn>).mockReturnValue(child);
      (existsSync as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(false) // no PID file at start
        .mockReturnValueOnce(true); // PID file exists at stop

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ service: "claude-server" }),
      });
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 2000,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: mockFetch,
      });

      await manager.start();
      await manager.stop();

      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
      expect(unlinkSync).toHaveBeenCalledWith("/tmp/test-lcm-proxy.pid");
    });
  });

  describe("isHealthy()", () => {
    it("returns false when not started", async () => {
      manager = createClaudeCliProxyManager({
        port: 13456,
        startupTimeoutMs: 500,
        model: "claude-haiku-4-5",
        pidFilePath: "/tmp/test-lcm-proxy.pid",
        healthPollIntervalMs: 50,
        _fetchOverride: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      });
      expect(await manager.isHealthy()).toBe(false);
    });
  });
});
```

- [ ] **3.2** Run tests to confirm they fail (module does not exist yet):

```bash
npx vitest run test/daemon/proxy-manager.test.ts
```

- [ ] **3.3** Create `/Users/pedro/Developer/lossless-claude/src/daemon/proxy-manager.ts`:

```typescript
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ProxyManager {
  start(): Promise<void>;
  stop(): Promise<void>;
  isHealthy(): Promise<boolean>;
  readonly port: number;
  readonly available: boolean;
}

export type ProxyManagerOptions = {
  port: number;
  startupTimeoutMs: number;
  model: string;
  pidFilePath?: string;
  healthPollIntervalMs?: number;
  healthMonitorIntervalMs?: number;
  maxHealthMisses?: number;
  /** Override fetch for testing */
  _fetchOverride?: typeof globalThis.fetch;
  /** Override process.kill(pid, 0) check for testing */
  _killCheck?: (pid: number) => boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function isProcessAlive(pid: number, killCheck?: (pid: number) => boolean): boolean {
  if (killCheck) return killCheck(pid);
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createClaudeCliProxyManager(opts: ProxyManagerOptions): ProxyManager {
  const port = opts.port;
  const pidFilePath = opts.pidFilePath ?? join(homedir(), ".lossless-claude", "lcm-proxy.pid");
  const healthPollIntervalMs = opts.healthPollIntervalMs ?? 500;
  const healthMonitorIntervalMs = opts.healthMonitorIntervalMs ?? 30_000;
  const maxHealthMisses = opts.maxHealthMisses ?? 3;
  const fetchFn = opts._fetchOverride ?? globalThis.fetch;
  const healthURL = `http://localhost:${port}/health`;

  let child: ChildProcess | null = null;
  let _available = false;
  let monitorTimer: ReturnType<typeof setInterval> | null = null;
  let hasAttemptedRestart = false;

  async function checkHealth(): Promise<{ ok: boolean; isClaudeServer: boolean }> {
    try {
      const res = await fetchFn(healthURL);
      if (!res.ok) return { ok: false, isClaudeServer: false };
      const body = await res.json();
      const isClaudeServer = body?.service === "claude-server";
      return { ok: true, isClaudeServer };
    } catch {
      return { ok: false, isClaudeServer: false };
    }
  }

  async function waitForHealth(): Promise<boolean> {
    const deadline = Date.now() + opts.startupTimeoutMs;
    while (Date.now() < deadline) {
      const { ok, isClaudeServer } = await checkHealth();
      if (ok && isClaudeServer) return true;
      if (ok && !isClaudeServer) return false; // foreign process on port
      await sleep(healthPollIntervalMs);
    }
    return false;
  }

  function spawnChild(): ChildProcess {
    const cp = spawn("claude-server", ["--port", String(port)], {
      stdio: "pipe",
      detached: false,
    });
    cp.unref();
    return cp;
  }

  function writePid(pid: number): void {
    writeFileSync(pidFilePath, String(pid));
  }

  function deletePidFile(): void {
    try {
      if (existsSync(pidFilePath)) unlinkSync(pidFilePath);
    } catch { /* ignore */ }
  }

  function startHealthMonitor(): void {
    if (monitorTimer) return;
    let consecutiveMisses = 0;

    monitorTimer = setInterval(async () => {
      const { ok, isClaudeServer } = await checkHealth();
      if (ok && isClaudeServer) {
        consecutiveMisses = 0;
        return;
      }
      consecutiveMisses++;
      if (consecutiveMisses >= maxHealthMisses) {
        stopHealthMonitor();
        if (!hasAttemptedRestart) {
          hasAttemptedRestart = true;
          console.warn("[lcm] claude-server health check failed — attempting restart...");
          try {
            await doStart();
          } catch {
            console.warn(
              "[lcm] claude-server unavailable. Run 'claude login' to authenticate,\n" +
              "      then restart Claude Code. Alternatively, set LCM_SUMMARY_PROVIDER=anthropic\n" +
              "      and LCM_SUMMARY_API_KEY=<key> to use the Anthropic API directly."
            );
            _available = false;
            deletePidFile();
          }
        } else {
          console.warn(
            "[lcm] claude-server unavailable after restart attempt. Summarization disabled for this session."
          );
          _available = false;
          deletePidFile();
        }
      }
    }, healthMonitorIntervalMs);
  }

  function stopHealthMonitor(): void {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  }

  async function doStart(): Promise<void> {
    // Step 1: Check existing PID file
    if (existsSync(pidFilePath)) {
      try {
        const pid = parseInt(readFileSync(pidFilePath, "utf-8").trim(), 10);
        if (!isNaN(pid) && isProcessAlive(pid, opts._killCheck)) {
          // Process alive — check if it's actually claude-server
          const { ok, isClaudeServer } = await checkHealth();
          if (ok && isClaudeServer) {
            _available = true;
            startHealthMonitor();
            return; // reuse existing process
          }
        }
      } catch { /* ignore read errors */ }
      // Stale PID or wrong service — clean up
      deletePidFile();
    }

    // Step 2: Spawn new process
    child = spawnChild();
    if (child.pid) writePid(child.pid);

    // Handle child exit
    child.on("exit", () => {
      child = null;
    });

    // Step 3: Wait for health
    const healthy = await waitForHealth();
    if (healthy) {
      _available = true;
      startHealthMonitor();
    } else {
      // Check if it's a foreign process on the port
      const { ok, isClaudeServer } = await checkHealth();
      if (ok && !isClaudeServer) {
        console.warn(`[lcm] Port ${port} is occupied by another service. claude-server cannot start.`);
      } else {
        console.warn(
          "[lcm] claude-server unavailable. Run 'claude login' to authenticate,\n" +
          "      then restart Claude Code. Alternatively, set LCM_SUMMARY_PROVIDER=anthropic\n" +
          "      and LCM_SUMMARY_API_KEY=<key> to use the Anthropic API directly."
        );
      }
      // Kill the child we spawned since it's not healthy
      if (child) {
        child.kill("SIGTERM");
        child = null;
      }
      _available = false;
      deletePidFile();
    }
  }

  const manager: ProxyManager = {
    get port() { return port; },
    get available() { return _available; },

    async start(): Promise<void> {
      await doStart();
    },

    async stop(): Promise<void> {
      stopHealthMonitor();
      if (child) {
        child.kill("SIGTERM");
        child = null;
      }
      _available = false;
      deletePidFile();
    },

    async isHealthy(): Promise<boolean> {
      const { ok, isClaudeServer } = await checkHealth();
      return ok && isClaudeServer;
    },
  };

  return manager;
}
```

- [ ] **3.4** Run tests to confirm they pass:

```bash
npx vitest run test/daemon/proxy-manager.test.ts
```

- [ ] **3.5** Run the full test suite:

```bash
npx vitest run
```

- [ ] **3.6** Commit:

```bash
git add src/daemon/proxy-manager.ts test/daemon/proxy-manager.test.ts
git commit -m "feat: add ClaudeCliProxyManager for claude-server child process lifecycle"
```

---

## Task 4: Integrate ProxyManager into daemon

**Files:**
- Modify: `/Users/pedro/Developer/lossless-claude/src/daemon/server.ts`
- Test: `/Users/pedro/Developer/lossless-claude/test/daemon/server.test.ts`

### Steps

- [ ] **4.1** Add failing tests to `test/daemon/server.test.ts`:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";
import { createDaemon, type DaemonInstance } from "../../src/daemon/server.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

// ... (keep existing tests)

describe("daemon proxy integration", () => {
  let daemon: DaemonInstance | undefined;
  afterEach(async () => { if (daemon) { await daemon.stop(); daemon = undefined; } });

  it("accepts proxyManager option and calls start on daemon creation", async () => {
    const mockProxy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(true),
      port: 3456,
      available: true,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    expect(mockProxy.start).toHaveBeenCalled();
  });

  it("calls proxyManager.stop() on daemon shutdown", async () => {
    const mockProxy = {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(true),
      port: 3456,
      available: true,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    await daemon.stop();
    expect(mockProxy.stop).toHaveBeenCalled();
    daemon = undefined; // already stopped
  });

  it("continues without error when proxyManager.start() rejects", async () => {
    const mockProxy = {
      start: vi.fn().mockRejectedValue(new Error("spawn failed")),
      stop: vi.fn().mockResolvedValue(undefined),
      isHealthy: vi.fn().mockResolvedValue(false),
      port: 3456,
      available: false,
    };
    const config = loadDaemonConfig("/x", {
      daemon: { port: 0 },
      llm: { provider: "disabled" },
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    daemon = await createDaemon(config, { proxyManager: mockProxy });
    // Daemon should still be running
    const res = await fetch(`http://127.0.0.1:${daemon.address().port}/health`);
    expect(res.status).toBe(200);
    warnSpy.mockRestore();
  });
});
```

- [ ] **4.2** Run tests to confirm the new tests fail:

```bash
npx vitest run test/daemon/server.test.ts
```

Expected: fails because `createDaemon` does not accept a second argument.

- [ ] **4.3** Update `/Users/pedro/Developer/lossless-claude/src/daemon/server.ts` to accept and manage a ProxyManager:

Add the import and update the `createDaemon` function signature:

```typescript
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DaemonConfig } from "./config.js";
import type { ProxyManager } from "./proxy-manager.js";
import { createCompactHandler } from "./routes/compact.js";
import { createRestoreHandler } from "./routes/restore.js";
import { createGrepHandler } from "./routes/grep.js";
import { createSearchHandler } from "./routes/search.js";
import { createExpandHandler } from "./routes/expand.js";
import { createDescribeHandler } from "./routes/describe.js";
import { createStoreHandler } from "./routes/store.js";
import { createRecentHandler } from "./routes/recent.js";

export type RouteHandler = (req: IncomingMessage, res: ServerResponse, body: string) => Promise<void>;
export type DaemonOptions = { proxyManager?: ProxyManager };
export type DaemonInstance = { address: () => AddressInfo; stop: () => Promise<void>; registerRoute: (method: string, path: string, handler: RouteHandler) => void };
```

Then update the function:

```typescript
export async function createDaemon(config: DaemonConfig, options?: DaemonOptions): Promise<DaemonInstance> {
  const startTime = Date.now();
  const routes = new Map<string, RouteHandler>();
  const proxyManager = options?.proxyManager;

  // Start proxy manager if provided
  if (proxyManager) {
    try {
      await proxyManager.start();
    } catch (err) {
      console.warn(`[lcm] claude-server proxy failed to start: ${err instanceof Error ? err.message : err}`);
    }
  }

  routes.set("GET /health", async (_req, res) =>
    sendJson(res, 200, { status: "ok", uptime: Math.floor((Date.now() - startTime) / 1000) }));
  routes.set("POST /compact", createCompactHandler(config));
  routes.set("POST /restore", createRestoreHandler(config));
  routes.set("POST /grep", createGrepHandler(config));
  routes.set("POST /search", createSearchHandler(config));
  routes.set("POST /expand", createExpandHandler(config));
  routes.set("POST /describe", createDescribeHandler(config));
  routes.set("POST /store", createStoreHandler(config));
  routes.set("POST /recent", createRecentHandler(config));

  const server: Server = createServer(async (req, res) => {
    const key = `${req.method} ${req.url?.split("?")[0]}`;
    const handler = routes.get(key);
    if (!handler) { sendJson(res, 404, { error: "not found" }); return; }
    try {
      await handler(req, res, req.method !== "GET" ? await readBody(req) : "");
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "internal error" });
    }
  });

  return new Promise((resolve) => {
    server.listen(config.daemon.port, "127.0.0.1", () => {
      resolve({
        address: () => server.address() as AddressInfo,
        stop: async () => {
          if (proxyManager) {
            try { await proxyManager.stop(); } catch { /* non-fatal */ }
          }
          return new Promise<void>((r) => server.close(() => r()));
        },
        registerRoute: (method, path, handler) => routes.set(`${method} ${path}`, handler),
      });
    });
  });
}
```

- [ ] **4.4** Run tests to confirm they pass:

```bash
npx vitest run test/daemon/server.test.ts
```

- [ ] **4.5** Run the full test suite:

```bash
npx vitest run
```

- [ ] **4.6** Commit:

```bash
git add src/daemon/server.ts test/daemon/server.test.ts
git commit -m "feat: integrate ProxyManager into daemon startup/shutdown lifecycle"
```

---

## Task 5: Update installer picker

**Files:**
- Modify: `/Users/pedro/Developer/lossless-claude/installer/install.ts`
- Test: `/Users/pedro/Developer/lossless-claude/test/installer/install.test.ts`

### Steps

- [ ] **5.1** Add failing tests to `test/installer/install.test.ts`. Add these to the existing `"summarizer picker"` describe block:

```typescript
it("option 1 (Claude Max / Pro): writes provider=claude-cli to config.json", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
  const writeFileMock = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: writeFileMock,
    promptUser: vi.fn().mockResolvedValueOnce("1"), // picker: option 1 (Claude Max/Pro)
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await install(deps);
  warnSpy.mockRestore();
  const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
  expect(configCall).toBeDefined();
  const written = JSON.parse(configCall![1]);
  expect(written.llm.provider).toBe("claude-cli");
  expect(written.llm.apiKey).toBeFalsy();
});
```

- [ ] **5.2** Run tests to confirm the new test fails:

```bash
npx vitest run test/installer/install.test.ts
```

Expected: fails because option 1 currently returns `provider: "anthropic"`.

- [ ] **5.3** Update the `SummarizerConfig` type in `installer/install.ts`:

```typescript
type SummarizerConfig = {
  provider: "claude-cli" | "anthropic" | "openai";
  model: string;
  apiKey: string;
  baseURL: string;
};
```

- [ ] **5.4** Update the `pickSummarizer` function:

```typescript
async function pickSummarizer(deps: ServiceDeps, cipherConfigPath: string): Promise<SummarizerConfig> {
  // Non-TTY (CI, piped stdin): skip interactive picker, default to claude-cli
  if (!process.stdin.isTTY) {
    return { provider: "claude-cli", model: "claude-haiku-4-5", apiKey: "", baseURL: "" };
  }

  console.log("\n  ─── Summarizer (for conversation compaction)\n");
  console.log("  1) Claude Max / Pro  (recommended — uses your subscription, no API key needed)");
  console.log("  2) Anthropic API     (direct API access — requires API key)");
  console.log("  3) Local model       (reuse your vllm-mlx / ollama endpoint)");
  console.log("  4) Custom server     (any OpenAI-compatible URL)");
  console.log("");

  let choice = (await deps.promptUser("  Pick [1]: ")).trim();
  if (!["1", "2", "3", "4"].includes(choice)) {
    console.log("  Invalid choice — please enter 1, 2, 3, or 4.");
    choice = (await deps.promptUser("  Pick [1]: ")).trim();
  }
  if (!["1", "2", "3", "4"].includes(choice)) {
    choice = "1"; // default after two invalid attempts
  }

  if (choice === "1") {
    return { provider: "claude-cli", model: "claude-haiku-4-5", apiKey: "", baseURL: "" };
  }

  if (choice === "2") {
    const apiKey = process.env.ANTHROPIC_API_KEY ? "${ANTHROPIC_API_KEY}" : "";
    return { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey, baseURL: "" };
  }

  if (choice === "3") {
    // Read from cipher.yml
    try {
      const cipherContent = deps.readFileSync(cipherConfigPath, "utf-8");
      const parsed = parseCipherYml(cipherContent);
      if (parsed) {
        return { provider: "openai", model: parsed.model, apiKey: "", baseURL: parsed.baseURL };
      }
    } catch {}
    console.warn("  Warning: Could not read local model config from cipher.yml — falling back to manual entry.");
    choice = "4";
  }

  if (choice === "4") {
    const baseURL = (await deps.promptUser("  Server URL (e.g. http://192.168.1.x:8080/v1): ")).trim();
    const model = (await deps.promptUser("  Model name: ")).trim();
    return { provider: "openai", model, apiKey: "", baseURL };
  }

  // Fallback (should not reach here)
  return { provider: "claude-cli", model: "claude-haiku-4-5", apiKey: "", baseURL: "" };
}
```

- [ ] **5.5** Update existing tests that are now broken by the new picker numbering. The existing tests assume option 1 = Anthropic, option 2 = local, option 3 = custom. They must be updated:

**Existing test: `"option 1 (Anthropic)"` -- now becomes option 2:**

```typescript
it("option 2 (Anthropic API): writes provider=anthropic and apiKey literal to config.json", async () => {
  process.env.ANTHROPIC_API_KEY = "sk-test";
  Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
  const writeFileMock = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: writeFileMock,
    promptUser: vi.fn().mockResolvedValueOnce("2"), // picker: option 2
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await install(deps);
  warnSpy.mockRestore();
  const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
  expect(configCall).toBeDefined();
  const written = JSON.parse(configCall![1]);
  expect(written.llm.provider).toBe("anthropic");
  expect(written.llm.apiKey).toBe("${ANTHROPIC_API_KEY}");
  expect(written.llm.model).toBe("claude-haiku-4-5-20251001");
});
```

**Existing test: `"option 2 (local model)"` -- now becomes option 3:**

Update `promptUser` mock to return `"3"`.

**Existing test: `"option 3 (custom server)"` -- now becomes option 4:**

Update `promptUser` mock to return `"4"`.

**Existing test: `"invalid input re-prompts"` -- now defaults to claude-cli:**

```typescript
it("invalid input re-prompts once then defaults to option 1 (claude-cli)", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true });
  const writeFileMock = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: writeFileMock,
    promptUser: vi.fn()
      .mockResolvedValueOnce("9")   // invalid
      .mockResolvedValueOnce("9"),  // invalid again → default to 1
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await install(deps);
  warnSpy.mockRestore();
  const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
  const written = JSON.parse(configCall![1]);
  expect(written.llm.provider).toBe("claude-cli");
});
```

**Existing test: `"non-TTY"` -- now defaults to claude-cli:**

```typescript
it("non-TTY (process.stdin.isTTY is false): skips picker and defaults to claude-cli", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, writable: true });
  const writeFileMock = vi.fn();
  const promptUserMock = vi.fn();
  const deps = makeDeps({
    existsSync: vi.fn().mockReturnValue(false),
    writeFileSync: writeFileMock,
    promptUser: promptUserMock,
  });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await install(deps);
  warnSpy.mockRestore();
  expect(promptUserMock).not.toHaveBeenCalled(); // picker was skipped
  const configCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
  const written = JSON.parse(configCall![1]);
  expect(written.llm.provider).toBe("claude-cli");
});
```

**Existing test: `"writes config.json with llm.apiKey set to env placeholder"`** -- non-TTY now defaults to claude-cli which has no apiKey. Update:

```typescript
it("writes config.json with provider=claude-cli and empty apiKey in non-TTY mode", async () => {
  const writeFileMock = vi.fn();
  const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false), writeFileSync: writeFileMock });
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  await install(deps);
  warnSpy.mockRestore();
  const configWriteCall = writeFileMock.mock.calls.find((c: any[]) => c[0].endsWith("config.json"));
  expect(configWriteCall).toBeDefined();
  const written = JSON.parse(configWriteCall![1]);
  expect(written.llm.provider).toBe("claude-cli");
  expect(written.llm.apiKey).toBe("");
});
```

- [ ] **5.6** Run tests to confirm they pass:

```bash
npx vitest run test/installer/install.test.ts
```

- [ ] **5.7** Run the full test suite:

```bash
npx vitest run
```

- [ ] **5.8** Commit:

```bash
git add installer/install.ts test/installer/install.test.ts
git commit -m "feat: add 'Claude Max / Pro' as default summarizer option in installer picker"
```

---

## Task 6: Add claude-server optional dependency + smoke test

**Files:**
- Modify: `/Users/pedro/Developer/lossless-claude/package.json`

### Steps

- [ ] **6.1** Add `optionalDependencies` to `package.json`. Add this block after the `devDependencies` section:

```json
"optionalDependencies": {
  "claude-server": "*"
}
```

The version is `"*"` as a placeholder until `claude-server` is published to npm.

- [ ] **6.2** Confirm no TypeScript errors:

```bash
npx tsc --noEmit
```

Expected: exits 0 with no errors.

- [ ] **6.3** Run the full test suite:

```bash
npx vitest run
```

Expected: all tests pass.

- [ ] **6.4** Commit:

```bash
git add package.json
git commit -m "chore: add claude-server as optional dependency (placeholder)"
```

---

## Summary of key decisions

| Decision | Rationale |
|---|---|
| `"claude-cli"` resolves to `"openai"` in `loadDaemonConfig` | Keeps compact.ts binary dispatch unchanged — zero risk to existing summarization paths |
| `"disabled"` sentinel in provider union | Clean way to represent "no summarizer" without null checks throughout the codebase |
| ProxyManager as separate module | Single responsibility; testable in isolation with mocked child_process |
| ProxyManager passed as option to `createDaemon` | Backward compatible — existing callers unaffected; easily mockable in tests |
| Installer defaults to claude-cli in non-TTY mode | Zero-config for CI/automated installs where Claude CLI is always present |
| `apiKey` becomes optional on DaemonConfig | Required for claude-cli which needs no key; Anthropic validation moved to loadDaemonConfig |
| Health check validates `{"service":"claude-server"}` | Prevents treating any HTTP server on the port as a valid proxy |
| One restart attempt, then give up | Avoids restart loops; user gets an actionable error message |
