import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/core", () => ({
  buildMemorySystemPromptAddition: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactSensitiveText: (text: string) => text,
}));

type HookHandler = (event: unknown, context: unknown) => unknown;
type ToolFactory = (ctx: { sessionId?: string; sessionKey?: string }) => {
  execute: (toolCallId: string, params: unknown) => Promise<unknown>;
};

/** One loaded plugin generation: its own module graph plus captured registrations. */
type PluginGeneration = {
  hooks: Map<string, HookHandler[]>;
  tools: Map<string, ToolFactory>;
  disposers: Array<() => void | Promise<void>>;
  auth: typeof import("../src/expansion-auth.js");
};

const CHILD_SESSION_KEY = "agent:main:subagent:reload-child";

/** Build the smallest runtime-mode plugin API that register() accepts. */
function buildApi(dbPath: string, generation: Omit<PluginGeneration, "auth">) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig: { enabled: true, dbPath },
    runtime: {
      subagent: { run: vi.fn(), waitForRun: vi.fn(), getSessionMessages: vi.fn(), deleteSession: vi.fn() },
      llm: { complete: vi.fn() },
      modelAuth: { getApiKeyForModel: vi.fn(), resolveApiKeyForProvider: vi.fn() },
      config: { current: vi.fn(() => ({})), loadConfig: vi.fn(() => ({})) },
      logging: { shouldLogVerbose: vi.fn(() => false), getChildLogger: vi.fn(() => log) },
      channel: { session: { resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json") } },
    },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (cleanup: () => void | Promise<void>) => {
        generation.disposers.push(cleanup);
        return () => undefined;
      },
    },
    logger: log,
    registerContextEngine: vi.fn(),
    registerTool: vi.fn((factory: ToolFactory, options: { name: string }) => {
      generation.tools.set(options.name, factory);
    }),
    registerCommand: vi.fn(),
    resolvePath: vi.fn(() => "/tmp/fake-agent"),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      generation.hooks.set(hookName, [...(generation.hooks.get(hookName) ?? []), handler]);
    }),
  };
}

/** Load a fresh module graph, as OpenClaw does for each plugin generation, and register it. */
async function loadGeneration(dbPath: string): Promise<PluginGeneration> {
  vi.resetModules();
  const plugin = (await import("../index.js")).default;
  const auth = await import("../src/expansion-auth.js");
  const generation = { hooks: new Map(), tools: new Map(), disposers: [] };
  plugin.register(buildApi(dbPath, generation) as never);
  return { ...generation, auth };
}

/** Run the instance disposal callbacks the host awaits when it retires a generation. */
async function disposeGeneration(generation: PluginGeneration): Promise<void> {
  for (const dispose of generation.disposers) {
    await dispose();
  }
}

/** Retire a generation the way plugin reload does: gateway_stop, then instance disposal. */
async function retireGeneration(generation: PluginGeneration): Promise<void> {
  for (const stop of generation.hooks.get("gateway_stop") ?? []) {
    await stop({ reason: "plugin replacement" }, {});
  }
  await disposeGeneration(generation);
}

/** Build a unique temporary database path and remember it for cleanup. */
function tempDbPath(dbPaths: string[]): string {
  const dbPath = join(tmpdir(), `lossless-claw-reload-${Date.now()}-${Math.random().toString(16)}.db`);
  dbPaths.push(dbPath);
  return dbPath;
}

describe("plugin reload across generations", () => {
  const dbPaths: string[] = [];

  afterEach(async () => {
    const { clearAllSharedInit } = await import("../src/plugin/shared-init.js");
    clearAllSharedInit();
    for (const dbPath of dbPaths.splice(0)) {
      rmSync(dbPath, { force: true });
      rmSync(`${dbPath}-wal`, { force: true });
      rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  // Each test loads two full plugin module graphs, which is slow under a loaded runner.
  it("keeps a delegated expansion grant valid for a child that continues on the next generation", async () => {
    const dbPath = tempDbPath(dbPaths);

    const first = await loadGeneration(dbPath);
    const grant = first.auth.createDelegatedExpansionGrant({
      delegatedSessionKey: CHILD_SESSION_KEY,
      issuerSessionId: "agent:main:main",
      allowedConversationIds: [42],
      tokenCap: 900,
    });
    first.auth.getRuntimeExpansionAuthManager().consumeTokenBudget(grant.grantId, 100);
    await retireGeneration(first);

    const second = await loadGeneration(dbPath);
    expect(second.auth).not.toBe(first.auth);
    const grantId = second.auth.resolveDelegatedExpansionGrantId(CHILD_SESSION_KEY);
    expect(grantId).toBe(grant.grantId);
    const manager = second.auth.getRuntimeExpansionAuthManager();
    expect(manager.getGrant(grant.grantId)?.allowedConversationIds).toEqual([42]);
    expect(manager.getRemainingTokenBudget(grant.grantId)).toBe(800);

    const expand = second.tools.get("lcm_expand")?.({ sessionKey: CHILD_SESSION_KEY });
    const result = JSON.stringify(await expand?.execute("call-1", { summaryIds: ["sum_missing"] }));
    expect(result).not.toContain("requires a valid grant");
    await retireGeneration(second);
  }, 30_000);

  it("releases its engine on disposal so the next generation does not reuse it", async () => {
    const dbPath = tempDbPath(dbPaths);
    const { getSharedInit } = await import("../src/plugin/shared-init.js");
    const { normalizePath } = await import("../src/db/connection.js");

    const first = await loadGeneration(dbPath);
    expect(getSharedInit(normalizePath(dbPath))).toBeDefined();
    await disposeGeneration(first);
    expect(getSharedInit(normalizePath(dbPath))).toBeUndefined();

    const second = await loadGeneration(dbPath);
    expect(second.hooks.get("gateway_stop")).toHaveLength(1);
    await retireGeneration(second);
  }, 30_000);
});
