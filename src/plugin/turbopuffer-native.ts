import type {
  ContextEngine,
  ContextEngineInfo,
  OpenClawPluginApi,
  PluginLifecycleContext,
} from "../openclaw-bridge.js";
import type { LcmDependencies } from "../types.js";
import { LcmContextEngine } from "../engine.js";
import { NativeDatabase } from "../storage/turbopuffer-native/database.js";
import { digest } from "../storage/turbopuffer-native/codec.js";
import {
  getSharedInit,
  setSharedInit,
  removeSharedInit,
  type SharedLcmInit,
} from "./shared-init.js";
import { listConfiguredAgentIds } from "./openclaw-agent-ids.js";
import { createLcmGrepTool } from "../tools/lcm-grep-tool.js";
import { createLcmDescribeTool } from "../tools/lcm-describe-tool.js";
import { createLcmExpandTool } from "../tools/lcm-expand-tool.js";
import { createLcmExpandQueryTool } from "../tools/lcm-expand-query-tool.js";

type Target = {
  agentId?: string;
  sessionKey?: string;
  sessionTarget?: { agentId?: string; sessionKey?: string };
  runtimeContext?: {
    sessionTarget?: { agentId?: string; sessionKey?: string };
  };
};
/** Host-owned session identity selects the agent; tool arguments never select namespaces. */
export function nativeAgentFromHost(
  target: Target,
  allowed: readonly string[]
): string {
  const keys = [
    target.sessionKey,
    target.sessionTarget?.sessionKey,
    target.runtimeContext?.sessionTarget?.sessionKey,
  ].filter(
    (key): key is string => typeof key === "string" && key.trim() !== ""
  );
  const agents = [
    target.agentId,
    target.sessionTarget?.agentId,
    target.runtimeContext?.sessionTarget?.agentId,
    ...keys.map((key) => key.match(/^agent:([^:]+):/)?.[1]),
  ]
    .filter((id): id is string => typeof id === "string" && id.trim() !== "")
    .map((id) => id.trim());
  if (new Set(agents).size > 1)
    throw new Error("Host agent and session authority disagree");
  const agent = agents[0] ?? (allowed.length === 1 ? allowed[0] : undefined);
  if (!agent || !allowed.includes(agent))
    throw new Error("A configured native agent authority is required");
  return agent;
}
class NativeAgentRouter implements ContextEngine {
  constructor(
    readonly info: ContextEngineInfo,
    private resolve: (target: Target) => Promise<LcmContextEngine>
  ) {}
  async bootstrap(p: Parameters<ContextEngine["bootstrap"]>[0]) {
    return (await this.resolve(p)).bootstrap(p);
  }
  async ingest(p: Parameters<ContextEngine["ingest"]>[0]) {
    return (await this.resolve(p)).ingest(p);
  }
  async ingestBatch(
    p: Parameters<NonNullable<ContextEngine["ingestBatch"]>>[0]
  ) {
    return (await this.resolve(p)).ingestBatch(p);
  }
  async afterTurn(p: Parameters<NonNullable<ContextEngine["afterTurn"]>>[0]) {
    return (await this.resolve(p)).afterTurn(p);
  }
  async commitTurn(p: Parameters<NonNullable<ContextEngine["commitTurn"]>>[0]) {
    if (p.admission.agentId !== p.terminal.agentId)
      throw new Error("Turn anchors cross native agents");
    return (
      await this.resolve({ ...p, agentId: p.admission.agentId })
    ).commitTurn(p);
  }
  async assemble(p: Parameters<ContextEngine["assemble"]>[0]) {
    return (await this.resolve(p)).assemble(p);
  }
  async compact(p: Parameters<ContextEngine["compact"]>[0]) {
    return (await this.resolve(p)).compact({
      ...p,
      sessionFile: p.sessionFile ?? "",
    });
  }
  async maintain(p: Parameters<NonNullable<ContextEngine["maintain"]>>[0]) {
    return (await this.resolve({ sessionKey: p.sessionKey })).maintain(p);
  }
  async control(p: Parameters<NonNullable<ContextEngine["control"]>>[0]) {
    return (await this.resolve(p)).control(p);
  }
  getControlCapabilities() {
    return { status: true, doctor: true, rotate: false };
  }
  async prepareSubagentSpawn(
    p: Parameters<NonNullable<ContextEngine["prepareSubagentSpawn"]>>[0]
  ) {
    if (!p.parentSessionKey)
      throw new Error("Parent native session authority is required");
    if (
      p.parentSessionKey.match(/^agent:([^:]+):/)?.[1] !==
      p.childSessionKey.match(/^agent:([^:]+):/)?.[1]
    )
      throw new Error(
        "Native lossless memory cannot be delegated between agents"
      );
    const parent = await this.resolve({ sessionKey: p.parentSessionKey });
    return parent.prepareSubagentSpawn({
      ...p,
      parentSessionKey: p.parentSessionKey,
    });
  }
  async onSubagentEnded(
    p: Parameters<NonNullable<ContextEngine["onSubagentEnded"]>>[0]
  ) {
    return (
      await this.resolve({ sessionKey: p.childSessionKey })
    ).onSubagentEnded({
      childSessionKey: p.childSessionKey,
      reason: p.reason ?? "completed",
    });
  }
  async dispose() {} // The gateway registration owns shared native writers.
}

export function registerNativeTurbopufferPlugin(input: {
  api: OpenClawPluginApi;
  deps: LcmDependencies;
  openClawConfig?: unknown;
  canInitialize: boolean;
  wrap: (engine: ContextEngine) => ContextEngine;
  onDispose: (dispose: () => Promise<void>) => void;
  recallPrompt: string;
}): void {
  const { api, deps } = input,
    config = deps.config.turbopuffer;
  if (!config) throw new Error("Turbopuffer native configuration is required");
  const agents = listConfiguredAgentIds(input.openClawConfig, api.config),
    releases = new Map<
      string,
      { shared: SharedLcmInit; release: () => Promise<void> }
    >();
  let stopped = false;
  const getAgent = async (agentId: string): Promise<LcmContextEngine> => {
    if (!input.canInitialize)
      throw new Error(
        "Native storage initialization is disabled during read-only registration"
      );
    if (stopped) throw new Error("Native storage registration has stopped");
    const sharedKey = `turbopuffer:${digest([
      config.organizationId,
      agentId,
      config.namespacePrefix,
      config.region,
      config.numShards,
    ])}`;
    let shared = getSharedInit(sharedKey);
    if (!shared || shared.stopped) {
      let cached: LcmContextEngine | null = null,
        refs = 0;
      const apiKey = process.env[config.apiKeyEnv];
      if (!apiKey)
        throw new Error(
          `Turbopuffer credential environment variable ${config.apiKeyEnv} is not set`
        );
      const ready = NativeDatabase.open({ ...config, agentId, apiKey }).then(
        (database) => (cached = new LcmContextEngine(deps, database))
      );
      ready.catch(() => {});
      const own: SharedLcmInit = {
        stopped: false,
        getCachedEngine: () => cached,
        waitForEngine: () => ready,
        waitForDatabase: async () => {
          throw new Error("Native Turbopuffer has no SQLite database handle");
        },
        retain: () => {
          refs++;
          let released = false;
          return async () => {
            if (released) return;
            released = true;
            refs--;
            if (refs === 0) {
              own.stopped = true;
              if (getSharedInit(sharedKey) === own) removeSharedInit(sharedKey);
              cached = null;
            }
          };
        },
      };
      shared = own;
      setSharedInit(sharedKey, own);
      ready.catch(() => {
        own.stopped = true;
        if (getSharedInit(sharedKey) === own) removeSharedInit(sharedKey);
      });
    }
    const retained = releases.get(sharedKey);
    if (retained?.shared !== shared) {
      await retained?.release();
      releases.set(sharedKey, { shared, release: shared.retain() });
    }
    return shared.waitForEngine();
  };
  const resolve = (target: Target) =>
    getAgent(nativeAgentFromHost(target, agents));
  api.registerContextEngine!("lossless-claw", async () => {
    const first = await getAgent(agents[0]);
    return input.wrap(new NativeAgentRouter(first.info, resolve));
  });
  for (const [name, create] of [
    ["lcm_grep", createLcmGrepTool],
    ["lcm_describe", createLcmDescribeTool],
    ["lcm_expand", createLcmExpandTool],
    ["lcm_expand_query", createLcmExpandQueryTool],
  ] as const) {
    api.registerTool!(
      (ctx) =>
        create({
          deps,
          getLcm: () => resolve(ctx),
          sessionId: ctx.sessionId,
          sessionKey: ctx.sessionKey,
          requesterSessionKey: ctx.sessionKey,
        }),
      { name }
    );
  }
  api.on("before_prompt_build", () => ({
    prependSystemContext: input.recallPrompt,
  }));
  api.on("before_reset", async (event, ctx) => {
    await (
      await resolve(ctx)
    ).handleBeforeReset({
      reason: event.reason,
      sessionId: ctx.sessionId,
      sessionKey: ctx.sessionKey,
    });
  });
  api.on("session_end", async (event) => {
    if (
      [
        "restart",
        "shutdown",
        "gateway_stop",
        "gateway-restart",
        "gateway-shutdown",
      ].includes(String(event.reason))
    )
      return;
    const target = event as Target;
    await (await resolve(target)).handleSessionEnd(event);
  });
  api.session?.controls?.registerSessionAction?.({
    id: "lcm-control",
    description: "Run native LCM status or doctor for this agent session.",
    schema: {
      type: "object",
      properties: { operation: { enum: ["status", "doctor"] } },
      required: ["operation"],
    },
    handler: async (ctx) => {
      try {
        const engine = await resolve({ sessionKey: ctx.sessionKey });
        return {
          ok: true,
          result: await engine.control({
            operation: ctx.payload?.operation as "status" | "doctor",
            sessionKey: ctx.sessionKey,
          }),
        };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error ? error.message : "Native control failed",
          code: "unavailable",
        };
      }
    },
  });
  api.registerCommand({
    name: "lcm",
    description: "Native LCM status and doctor (current agent only).",
    acceptsArgs: true,
    handler: async (ctx: PluginLifecycleContext & { args?: string }) => {
      const operation = ctx.args?.trim() || "status";
      if (operation !== "status" && operation !== "doctor")
        return {
          text: "Native Turbopuffer supports /lcm status and /lcm doctor. SQLite file administration is not applicable.",
        };
      const result = await (
        await resolve(ctx)
      ).control({
        operation,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
      });
      return { text: JSON.stringify(result, null, 2) };
    },
  });
  const dispose = async () => {
    if (stopped) return;
    stopped = true;
    for (const { release } of releases.values()) await release();
    releases.clear();
  };
  api.on("gateway_stop", dispose);
  input.onDispose(dispose);
}
