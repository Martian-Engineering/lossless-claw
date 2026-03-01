import { describe, expect, it, vi } from "vitest";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import { resolveLcmConversationScope } from "../src/tools/lcm-conversation-scope.js";
import type { LcmDependencies } from "../src/types.js";

function makeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      contextThreshold: 0.75,
      freshTailCount: 8,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      autocompactDisabled: false,
      timezone: "UTC",
      pruneHeartbeatOk: false,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: () => undefined,
    requireApiKey: () => "",
    parseAgentSessionKey: (sessionKey: string) => {
      const trimmed = sessionKey.trim();
      if (!trimmed.startsWith("agent:")) {
        return null;
      }
      const parts = trimmed.split(":");
      if (parts.length < 3) {
        return null;
      }
      return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
    },
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => (id?.trim() ? id.trim() : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/openclaw-agent",
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveAgentIdFromSessionKey: async () => undefined,
    listAgentSessionIds: async () => [],
    resolveSessionMeta: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  } as LcmDependencies;
}

describe("agent memory scope resolver", () => {
  it("resolves scope=agent across same-agent conversations", async () => {
    const conversationStore = {
      getConversationBySessionId: vi.fn(async (sessionId: string) => {
        if (sessionId === "sid-1") {
          return {
            conversationId: 11,
            sessionId,
            title: null,
            bootstrappedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-02T00:00:00.000Z"),
          };
        }
        if (sessionId === "sid-2") {
          return {
            conversationId: 22,
            sessionId,
            title: null,
            bootstrappedAt: null,
            createdAt: new Date("2026-01-03T00:00:00.000Z"),
            updatedAt: new Date("2026-01-04T00:00:00.000Z"),
          };
        }
        return null;
      }),
    };

    const deps = makeDeps({
      resolveAgentIdFromSessionKey: async () => "alpha",
      listAgentSessionIds: async () => ["sid-1", "sid-2"],
      resolveSessionMeta: async (sessionId: string) => ({
        sessionKey: `agent:alpha:${sessionId}`,
        channel: "matrix",
        chatType: "dm",
      }),
    });

    const result = await resolveLcmConversationScope({
      lcm: {
        getConversationStore: () => conversationStore,
      } as never,
      deps,
      params: {},
      sessionKey: "agent:alpha:main",
      requestedScope: "agent",
    });

    expect(result.mode).toBe("agent");
    expect(result.agentId).toBe("alpha");
    expect(result.conversationIds).toEqual([22, 11]);
    expect(result.provenance[0]).toMatchObject({
      conversationId: 22,
      sessionId: "sid-2",
      sessionKey: "agent:alpha:sid-2",
      channel: "matrix",
      chatType: "dm",
    });
  });

  it("falls back to current conversation when agent scope is empty", async () => {
    const deps = makeDeps({
      resolveSessionIdFromSessionKey: async () => "sid-current",
      resolveAgentIdFromSessionKey: async () => "alpha",
      listAgentSessionIds: async () => [],
    });

    const result = await resolveLcmConversationScope({
      lcm: {
        getConversationStore: () => ({
          getConversationBySessionId: vi.fn(async () => ({
            conversationId: 7,
            sessionId: "sid-current",
            title: null,
            bootstrappedAt: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          })),
        }),
      } as never,
      deps,
      params: {},
      sessionKey: "agent:alpha:main",
      requestedScope: "agent",
    });

    expect(result.mode).toBe("current");
    expect(result.conversationId).toBe(7);
    expect(result.warnings.join(" ")).toContain("falling back to current conversation");
  });
});

describe("lcm_grep agent memory scope", () => {
  it("passes conversationIds to retrieval and returns scope/provenance details", async () => {
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })),
    };

    const deps = makeDeps({
      resolveAgentIdFromSessionKey: async () => "alpha",
      listAgentSessionIds: async () => ["sid-1", "sid-2"],
      resolveSessionMeta: async (sessionId: string) => ({
        sessionKey: `agent:alpha:${sessionId}`,
        channel: "telegram",
      }),
    });

    const tool = createLcmGrepTool({
      deps,
      lcm: {
        getRetrieval: () => retrieval,
        getConversationStore: () => ({
          getConversationBySessionId: vi.fn(async (sessionId: string) => {
            if (sessionId === "sid-1") {
              return {
                conversationId: 101,
                sessionId,
                title: null,
                bootstrappedAt: null,
                createdAt: new Date("2026-01-01T00:00:00.000Z"),
                updatedAt: new Date("2026-01-01T00:00:00.000Z"),
              };
            }
            if (sessionId === "sid-2") {
              return {
                conversationId: 102,
                sessionId,
                title: null,
                bootstrappedAt: null,
                createdAt: new Date("2026-01-02T00:00:00.000Z"),
                updatedAt: new Date("2026-01-02T00:00:00.000Z"),
              };
            }
            return null;
          }),
        }),
      } as never,
      sessionKey: "agent:alpha:main",
    });

    const result = await tool.execute("call-agent-scope", {
      pattern: "deploy",
      scope: "agent",
      searchScope: "summaries",
    });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "summaries",
        conversationIds: [102, 101],
        conversationId: undefined,
      }),
    );

    expect(result.details).toMatchObject({
      scope: {
        mode: "agent",
        conversationIds: [102, 101],
        agentId: "alpha",
      },
      provenance: [
        expect.objectContaining({ conversationId: 102, sessionId: "sid-2", channel: "telegram" }),
        expect.objectContaining({ conversationId: 101, sessionId: "sid-1", channel: "telegram" }),
      ],
    });
  });
});
