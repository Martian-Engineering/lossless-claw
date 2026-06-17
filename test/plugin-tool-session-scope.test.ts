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

function buildToolDiscoveryApi(): OpenClawPluginApi {
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
    pluginConfig: { enabled: true },
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
  afterEach(() => {
    clearAllSharedInit();
    vi.clearAllMocks();
  });

  it("passes both runtime session id and stable session key to recall tools", async () => {
    const lcmPlugin = (await lcmPluginPromise).default;
    const api = buildToolDiscoveryApi();

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
});
