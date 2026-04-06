import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";
import { clearAllSharedInit } from "../src/plugin/shared-init.js";
import { resetStartupBannerLogsForTests } from "../src/startup-banner-log.js";

type HookHandler = (event: unknown, context: unknown) => unknown;

function buildApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  getHook: (hookName: string) => HookHandler | undefined;
} {
  const hooks = new Map<string, HookHandler[]>();

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig,
    runtime: {
      subagent: {
        run: vi.fn(),
        waitForRun: vi.fn(),
        getSession: vi.fn(),
        deleteSession: vi.fn(),
      },
      modelAuth: {
        getApiKeyForModel: vi.fn(async () => undefined),
        resolveApiKeyForProvider: vi.fn(async () => undefined),
      },
      config: {
        loadConfig: vi.fn(() => ({})),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn(),
    registerTool: vi.fn(),
    registerHook: vi.fn(),
    registerHttpHandler: vi.fn(),
    registerHttpRoute: vi.fn(),
    registerChannel: vi.fn(),
    registerGatewayMethod: vi.fn(),
    registerCli: vi.fn(),
    registerService: vi.fn(),
    registerProvider: vi.fn(),
    registerCommand: vi.fn(),
    resolvePath: vi.fn(() => "/tmp/fake-agent"),
    on: vi.fn((hookName: string, handler: HookHandler) => {
      const existing = hooks.get(hookName) ?? [];
      existing.push(handler);
      hooks.set(hookName, existing);
    }),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getHook: (hookName: string) => hooks.get(hookName)?.[0],
  };
}

describe("lcm plugin prompt hook", () => {
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    clearAllSharedInit();
    resetStartupBannerLogsForTests();
  });

  it("registers before_prompt_build static recall policy through system prompt context", async () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getHook } = buildApi({
      enabled: true,
      dbPath,
    });

    lcmPlugin.register(api);

    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));

    const handler = getHook("before_prompt_build");
    expect(handler).toBeTypeOf("function");

    const result = (await handler?.(
      {
        prompt: "What changed earlier in this conversation?",
        messages: [],
      },
      {},
    )) as {
      prependContext?: string;
      prependSystemContext?: string;
      systemPrompt?: string;
    };

    expect(result).toMatchObject({
      prependSystemContext: expect.any(String),
    });
    expect(result.prependContext).toBeUndefined();
    expect(result.systemPrompt).toBeUndefined();
    expect(result.prependSystemContext).toContain("The lossless-claw plugin is active");
    expect(result.prependSystemContext).toContain(
      "these instructions supersede generic memory-recall guidance",
    );
    expect(result.prependSystemContext).toContain(
      "If facts seem contradictory or uncertain, verify with lossless-claw recall tools before answering",
    );
    expect(result.prependSystemContext).toContain("Recall order for compacted conversation history:");
    expect(result.prependSystemContext).toContain("1. `lcm_grep` — search by regex or full-text");
    expect(result.prependSystemContext).toContain("2. `lcm_describe` — inspect a specific summary");
    expect(result.prependSystemContext).toContain(
      "3. `lcm_expand_query` — deep recall: spawns bounded sub-agent",
    );
    expect(result.prependSystemContext).toContain(
      "`lcm_expand_query` usage",
    );
    expect(result.prependSystemContext).toContain(
      "lcm_expand_query(summaryIds: [\"sum_xxx\"], prompt: \"What config changes were discussed?\")",
    );
    expect(result.prependSystemContext).toContain(
      "Lossless-claw does not supersede memory tools globally",
    );
    expect(result.prependSystemContext).not.toContain("memory_search");
    expect(result.prependSystemContext).not.toContain("memory_get");
  });
});
