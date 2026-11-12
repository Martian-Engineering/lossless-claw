import { describe, it, expect, vi, afterEach } from "vitest";
import {
  registerNativeTurbopufferPlugin,
  nativeAgentFromHost,
} from "../src/plugin/turbopuffer-native.js";
import { NativeDatabase } from "../src/storage/turbopuffer-native/database.js";
import { resolveLcmConfig } from "../src/db/config.js";
import { createTestConfig, createTestDeps } from "./helpers.js";
import { MemoryIo } from "./helpers/turbopuffer-native-io.js";
import { clearAllSharedInit } from "../src/plugin/shared-init.js";
import type {
  ContextEngineFactory,
  OpenClawPluginApi,
} from "../src/openclaw-bridge.js";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearAllSharedInit();
});
describe("native plugin admission", () => {
  it("leaves SQLite as default and requires explicit native authority, without storing credentials", () => {
    expect(resolveLcmConfig({}).storageBackend ?? "sqlite").toBe("sqlite");
    expect(() =>
      resolveLcmConfig({}, { storageBackend: "turbopuffer" })
    ).toThrow("Explicit valid");
    const config = resolveLcmConfig(
      {},
      {
        storageBackend: "turbopuffer",
        turbopuffer: { organizationId: "org", namespacePrefix: "test" },
      }
    );
    expect(config.turbopuffer).toEqual({
      organizationId: "org",
      namespacePrefix: "test",
      region: "aws-us-east-1",
      apiKeyEnv: "LCM_TURBOPUFFER_API_KEY",
    });
    expect(() =>
      nativeAgentFromHost({ agentId: "alice", sessionKey: "agent:bob:test" }, [
        "alice",
        "bob",
      ])
    ).toThrow("disagree");
    expect(() => nativeAgentFromHost({}, ["alice", "bob"])).toThrow(
      "authority"
    );
    expect(
      nativeAgentFromHost({ sessionKey: "agent:alice:thread-2" }, [
        "alice",
        "bob",
      ])
    ).toBe("alice");
  });
  it("routes host sessions and tool factories to separate native agent writers", async () => {
    vi.stubEnv("NATIVE_TEST_KEY", "synthetic-test-only");
    const open = NativeDatabase.open.bind(NativeDatabase),
      ios = new Map<string, MemoryIo>();
    const spy = vi
      .spyOn(NativeDatabase, "open")
      .mockImplementation(async (options) => {
        let io = ios.get(options.agentId);
        if (!io) {
          io = new MemoryIo();
          ios.set(options.agentId, io);
        }
        return open({ ...options, io });
      });
    const tools = new Map<string, Function>(),
      events = new Map<string, Function>();
    let factory: ContextEngineFactory | undefined,
      dispose: (() => Promise<void>) | undefined;
    const api = {
      config: { agents: { list: [{ id: "alice" }, { id: "bob" }] } },
      registerContextEngine: (_id: string, fn: ContextEngineFactory) => {
        factory = fn;
      },
      registerTool: (fn: Function, o: { name: string }) =>
        tools.set(o.name, fn),
      on: (name: string, fn: Function) => events.set(name, fn),
      registerCommand: vi.fn(),
    } as unknown as OpenClawPluginApi;
    const deps = createTestDeps(
      createTestConfig("/must-not-open/lcm.db", {
        storageBackend: "turbopuffer",
        turbopuffer: {
          organizationId: "org",
          namespacePrefix: "native-plugin-test",
          region: "aws-us-east-1",
          apiKeyEnv: "NATIVE_TEST_KEY",
        },
      })
    );
    registerNativeTurbopufferPlugin({
      api,
      deps,
      canInitialize: true,
      wrap: (e) => e,
      onDispose: (fn) => {
        dispose = fn;
      },
      recallPrompt: "recall",
    });
    expect(spy).not.toHaveBeenCalled();
    const router = await factory!();
    // An unknown host agent never causes a namespace to be initialized.
    await expect(
      router.ingest({
        sessionId: "x",
        sessionKey: "agent:foreign:x",
        message: { role: "user", content: "x" },
      })
    ).rejects.toThrow("configured");
    const tool = await tools.get("lcm_grep")!({
      sessionId: "one",
      sessionKey: "agent:alice:one",
      agentId: "alice",
    });
    expect(tool.name).toBe("lcm_grep");
    // Force distinct host-owned contexts through the public control surface.
    expect(
      await router.control!({
        operation: "status",
        sessionKey: "agent:alice:one",
      })
    ).toMatchObject({ active: false });
    expect(
      await router.control!({
        operation: "status",
        sessionKey: "agent:bob:one",
      })
    ).toMatchObject({ active: false });
    expect([...ios.keys()]).toEqual(["alice", "bob"]);
    expect(spy).toHaveBeenCalledTimes(2);
    await expect(
      router.prepareSubagentSpawn!({
        parentSessionKey: "agent:alice:one",
        childSessionKey: "agent:bob:subagent:child",
      })
    ).rejects.toThrow("between agents");
    await dispose!();
    await expect(
      router.control!({ operation: "status", sessionKey: "agent:alice:one" })
    ).rejects.toThrow("stopped");
  });
});
