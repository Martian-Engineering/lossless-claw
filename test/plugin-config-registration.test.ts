import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";

type RegisteredEngineFactory = (() => unknown) | undefined;

function buildApi(pluginConfig: Record<string, unknown>): {
  api: OpenClawPluginApi;
  getFactory: () => RegisteredEngineFactory;
  infoLog: ReturnType<typeof vi.fn>;
} {
  let factory: RegisteredEngineFactory;
  const infoLog = vi.fn();

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
      info: infoLog,
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerContextEngine: vi.fn((_id: string, nextFactory: () => unknown) => {
      factory = nextFactory;
    }),
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
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;

  return {
    api,
    getFactory: () => factory,
    infoLog,
  };
}

describe("lcm plugin registration", () => {
  const dbPaths = new Set<string>();

  afterEach(() => {
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
  });

  it("uses api.pluginConfig values during register", () => {
    const dbPath = join(tmpdir(), `lossless-claw-${Date.now()}-${Math.random().toString(16)}.db`);
    dbPaths.add(dbPath);

    const { api, getFactory, infoLog } = buildApi({
      enabled: true,
      contextThreshold: 0.33,
      incrementalMaxDepth: -1,
      freshTailCount: 7,
      dbPath,
      largeFileThresholdTokens: 12345,
    });

    lcmPlugin.register(api);

    const factory = getFactory();
    expect(factory).toBeTypeOf("function");

    const engine = factory!() as { config: Record<string, unknown> };
    expect(engine.config).toMatchObject({
      enabled: true,
      contextThreshold: 0.33,
      incrementalMaxDepth: -1,
      freshTailCount: 7,
      databasePath: dbPath,
      largeFileTokenThreshold: 12345,
    });
    expect(infoLog).toHaveBeenCalledWith(
      `[lcm] Plugin loaded (enabled=true, db=${dbPath}, threshold=0.33)`,
    );
  });
});
