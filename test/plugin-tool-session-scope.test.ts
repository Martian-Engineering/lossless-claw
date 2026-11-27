import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
import { clearAllSharedInit } from "../src/plugin/shared-init.js";

const toolFactoryMocks = vi.hoisted(() => ({
  grep: vi.fn((input: unknown) => ({ name: "lcm_grep", input })),
  describe: vi.fn((input: unknown) => ({ name: "lcm_describe", input })),
  expand: vi.fn((input: unknown) => ({ name: "lcm_expand", input })),
  expandQuery: vi.fn((input: unknown) => ({ name: "lcm_expand_query", input })),
}));

vi.mock("openclaw/plugin-sdk/core", () => ({
  buildMemorySystemPromptAddition: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/logging-core", () => ({
  redactSensitiveText: (text: string) => text,
}));

vi.mock("../src/tools/lcm-grep-tool.js", () => ({
  createLcmGrepTool: toolFactoryMocks.grep,
}));

vi.mock("../src/tools/lcm-describe-tool.js", () => ({
  createLcmDescribeTool: toolFactoryMocks.describe,
}));

vi.mock("../src/tools/lcm-expand-tool.js", () => ({
  createLcmExpandTool: toolFactoryMocks.expand,
}));

vi.mock("../src/tools/lcm-expand-query-tool.js", () => ({
  createLcmExpandQueryTool: toolFactoryMocks.expandQuery,
}));

const lcmPluginPromise = import("../index.js");

function buildToolDiscoveryApi(dbPath: string): OpenClawPluginApi {
  const log = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    registrationMode: "tool-discovery",
    pluginConfig: { enabled: true, dbPath },
    config: {},
    runtime: {
      llm: {
        complete: vi.fn(),
      },
      modelAuth: {
        getApiKeyForModel: vi.fn(),
        resolveApiKeyForProvider: vi.fn(),
      },
      config: {
        current: vi.fn(() => ({})),
        loadConfig: vi.fn(() => ({})),
      },
      logging: {
        shouldLogVerbose: vi.fn(() => false),
        getChildLogger: vi.fn(() => log),
      },
      channel: {
        session: {
          resolveStorePath: vi.fn(() => "/tmp/nonexistent-session-store.json"),
        },
      },
    },
    logger: log,
    registerContextEngine: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    on: vi.fn(),
    resolvePath: vi.fn(() => "/tmp/fake-agent"),
  } as unknown as OpenClawPluginApi;
}

describe("plugin recall tool session scope", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    clearAllSharedInit();
    vi.clearAllMocks();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The plugin import resolves inside this test, so its time counts against the test timeout.
  it("passes both runtime session id and stable session key to recall tools", { timeout: 20000 }, async () => {
    const lcmPlugin = (await lcmPluginPromise).default;
    const dir = mkdtempSync(join(tmpdir(), "lossless-claw-tool-scope-"));
    tempDirs.push(dir);
    const api = buildToolDiscoveryApi(join(dir, "lcm.db"));

    lcmPlugin.register(api);

    const toolFactories = new Map(
      (api.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(([factory, options]) => [
        options.name,
        factory,
      ]),
    );
    const context = {
      sessionId: "runtime-session-104",
      sessionKey: "agent:main:main",
    };

    for (const name of ["lcm_grep", "lcm_describe", "lcm_expand", "lcm_expand_query"]) {
      const factory = toolFactories.get(name);
      expect(factory).toBeTypeOf("function");
      factory(context);
    }

    const expectedScope = expect.objectContaining({
      sessionId: context.sessionId,
      sessionKey: context.sessionKey,
    });
    expect(toolFactoryMocks.grep).toHaveBeenCalledWith(expectedScope);
    expect(toolFactoryMocks.describe).toHaveBeenCalledWith(expectedScope);
    expect(toolFactoryMocks.expand).toHaveBeenCalledWith(expectedScope);
    expect(toolFactoryMocks.expandQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: context.sessionId,
        sessionKey: context.sessionKey,
        requesterSessionKey: context.sessionKey,
      }),
    );
  });

  it("forwards the host disclosure capability from the tool context, and only that", async () => {
    const lcmPlugin = (await lcmPluginPromise).default;
    const api = buildToolDiscoveryApi();
    lcmPlugin.register(api);
    const factories = new Map(
      (api.registerTool as ReturnType<typeof vi.fn>).mock.calls.map(([factory, options]) => [
        options.name,
        factory,
      ]),
    );
    const hostDisclosure = { version: 1, requesterId: "p", audienceId: "a" };
    for (const name of ["lcm_grep", "lcm_describe", "lcm_expand", "lcm_expand_query"]) {
      factories.get(name)({ sessionId: "s", sessionKey: "agent:main:main", hostDisclosure });
    }
    for (const mock of [
      toolFactoryMocks.grep,
      toolFactoryMocks.describe,
      toolFactoryMocks.expand,
      toolFactoryMocks.expandQuery,
    ]) {
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({ disclosure: hostDisclosure }));
    }

    vi.clearAllMocks();
    factories.get("lcm_grep")({ sessionId: "s", sessionKey: "agent:main:main" });
    expect(toolFactoryMocks.grep).toHaveBeenCalledWith(
      expect.objectContaining({ disclosure: undefined }),
    );
  });
});
