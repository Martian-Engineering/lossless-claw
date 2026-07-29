// Coverage for the `lcm-control` session action registered in src/plugin/index.ts.
// The handler is the only bridge between the host's session-action surface and
// ContextEngine.control(); before this file it had no automated tests, and the
// structured-reasonCode passthrough had only been verified by hand against a
// live gateway.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../src/openclaw-bridge.js";
import lcmPlugin from "../index.js";
import { closeLcmConnection } from "../src/db/connection.js";
import {
  LcmProgrammaticControlFailedError,
  LcmProgrammaticControlUnavailableError,
} from "../src/plugin/lcm-command.js";
import { removeSharedInit, setSharedInit } from "../src/plugin/shared-init.js";

type SessionActionRegistration = {
  id: string;
  description?: string;
  schema?: { properties?: { operation?: { enum?: string[] } }; required?: string[] };
  handler: (ctx: {
    sessionKey?: string;
    payload?: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
};

function buildHarness(control: (input: unknown) => Promise<unknown>) {
  const dbPath = join(tmpdir(), `lossless-claw-action-${Date.now()}-${Math.random().toString(16)}.db`);
  let registration: SessionActionRegistration | undefined;

  // Inject the engine ahead of register() so the handler's waitForEngine()
  // resolves to a controllable double instead of a real initialized engine.
  const engine = { control: vi.fn(control) };
  setSharedInit(dbPath, {
    stopped: false,
    startupMaintenanceStarted: true,
    getCachedEngine: () => engine as never,
    waitForEngine: async () => engine as never,
    waitForDatabase: async () => ({}) as never,
    runStartupMaintenanceOnce: () => {},
  });

  const api = {
    id: "lossless-claw",
    name: "Lossless Context Management",
    source: "/tmp/lossless-claw",
    config: {},
    pluginConfig: { enabled: true, dbPath },
    runtime: { config: { loadConfig: vi.fn(() => ({})) } },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    session: {
      controls: {
        registerSessionAction: vi.fn((next: SessionActionRegistration) => {
          registration = next;
        }),
      },
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
    on: vi.fn(),
  } as unknown as OpenClawPluginApi;

  lcmPlugin.register(api);
  if (!registration) {
    throw new Error("Expected the lcm-control session action to be registered.");
  }
  return { registration, engine, dbPath };
}

const created: string[] = [];

afterEach(() => {
  for (const dbPath of created.splice(0)) {
    removeSharedInit(dbPath);
  }
  closeLcmConnection();
  vi.clearAllMocks();
});

function harness(control: (input: unknown) => Promise<unknown>) {
  const built = buildHarness(control);
  created.push(built.dbPath);
  return built;
}

describe("lcm-control session action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers under a stable id and constrains the operation set", () => {
    const { registration } = harness(async () => ({}));

    expect(registration.id).toBe("lcm-control");
    expect(registration.schema?.properties?.operation?.enum).toEqual([
      "status",
      "doctor",
      "rotate",
    ]);
    expect(registration.schema?.required).toContain("operation");
  });

  it("passes the engine result through on success", async () => {
    const { registration, engine } = harness(async () => ({ rotated: true, bytes: 1259 }));

    const response = await registration.handler({
      sessionKey: "agent:main:feishu:direct:u1",
      payload: { operation: "rotate" },
    });

    expect(response).toEqual({ ok: true, result: { rotated: true, bytes: 1259 } });
    expect(engine.control).toHaveBeenCalledWith({
      operation: "rotate",
      sessionKey: "agent:main:feishu:direct:u1",
    });
  });

  it("preserves the structured reasonCode when control is unavailable", async () => {
    const { registration } = harness(async () => {
      throw new LcmProgrammaticControlUnavailableError("rotate", "conversation_unavailable");
    });

    const response = await registration.handler({ payload: { operation: "rotate" } });

    // Regression guard: the handler once read `.reason`, collapsing every
    // structured skip reason to the generic "unavailable".
    expect(response.ok).toBe(false);
    expect(response.code).toBe("conversation_unavailable");
  });

  it("preserves the structured reasonCode when control fails after starting", async () => {
    const { registration } = harness(async () => {
      throw new LcmProgrammaticControlFailedError("rotate", "rotate_write_failed");
    });

    const response = await registration.handler({ payload: { operation: "rotate" } });

    expect(response.ok).toBe(false);
    expect(response.code).toBe("rotate_write_failed");
  });

  it("keeps distinct skip reasons distinct", async () => {
    const codes: unknown[] = [];
    for (const reasonCode of ["runtime_unavailable", "session_id_unavailable", "transcript_unavailable"]) {
      const { registration } = harness(async () => {
        throw new LcmProgrammaticControlUnavailableError("rotate", reasonCode);
      });
      const response = await registration.handler({ payload: { operation: "rotate" } });
      codes.push(response.code);
    }

    expect(codes).toEqual([
      "runtime_unavailable",
      "session_id_unavailable",
      "transcript_unavailable",
    ]);
    expect(new Set(codes).size).toBe(3);
  });

  it("falls back to a generic code when the failure carries no reasonCode", async () => {
    const { registration } = harness(async () => {
      throw new Error("socket hang up");
    });

    const response = await registration.handler({ payload: { operation: "status" } });

    expect(response).toEqual({
      ok: false,
      error: "socket hang up",
      code: "unavailable",
    });
  });
});
