import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../src/engine.js";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
  revokeDelegatedExpansionGrantForSession,
} from "../src/expansion-auth.js";
import { createLcmExpandTool } from "../src/tools/lcm-expand-tool.js";
import type { LcmDependencies } from "../src/types.js";

const callGatewayMock = vi.fn();

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return null;
  }
  return {
    agentId: parts[1] ?? "main",
    suffix: parts.slice(2).join(":"),
  };
}

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
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      autocompactDisabled: false,
      timezone: "UTC",
      pruneHeartbeatOk: false,
    },
    complete: vi.fn(),
    callGateway: (params: { method: string; params?: Record<string, unknown> }) =>
      callGatewayMock(params),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: () => undefined,
    requireApiKey: () => "",
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/openclaw-agent",
    resolveSessionIdFromSessionKey: async () => undefined,
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

function makeMockRetrieval() {
  return {
    expand: vi.fn(),
    grep: vi.fn(),
    describe: vi.fn().mockResolvedValue({
      type: "summary",
      summary: { conversationId: 7 },
    }),
  };
}

function makeEngine(params: {
  retrieval: ReturnType<typeof makeMockRetrieval>;
  conversationId?: number;
}): LcmContextEngine {
  return {
    info: { id: "lcm" },
    getRetrieval: () => params.retrieval,
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn().mockResolvedValue(
        typeof params.conversationId === "number"
          ? {
              conversationId: params.conversationId,
              sessionId: "session-1",
              title: null,
              bootstrappedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            }
          : null,
      ),
    }),
  } as unknown as LcmContextEngine;
}

const MAIN_SESSION_RESTRICTION_ERROR =
  "lcm_expand is only available in sub-agent sessions. Use lcm_expand_query to ask a focused question against expanded summaries, or lcm_describe/lcm_grep for lighter lookups.";

describe("createLcmExpandTool expansion limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockReset();
    resetDelegatedExpansionGrantsForTests();
  });

  afterEach(() => {
    resetDelegatedExpansionGrantsForTests();
  });

  it("rejects lcm_expand from main sessions", async () => {
    const mockRetrieval = makeMockRetrieval();
    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:main",
    });

    const result = await tool.execute("call-main-rejected", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: MAIN_SESSION_RESTRICTION_ERROR,
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
    expect(mockRetrieval.grep).not.toHaveBeenCalled();
  });

  it("uses remaining grant tokenCap when tokenCap is omitted for summary expansion", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 40,
      truncated: false,
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:unbounded",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:unbounded",
    });
    await tool.execute("call-1", { summaryIds: ["sum_a"], conversationId: 7 });

    expect(mockRetrieval.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryId: "sum_a",
        tokenCap: 120,
      }),
    );
  });

  it("clamps oversized tokenCap for query expansion to remaining grant budget", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [{ summaryId: "sum_match", conversationId: 7, kind: "leaf", snippet: "match" }],
      totalMatches: 1,
    });
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 25,
      truncated: false,
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:query",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:query",
    });

    await tool.execute("call-2", {
      query: "auth",
      conversationId: 7,
      tokenCap: 9_999,
    });

    expect(mockRetrieval.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryId: "sum_match",
        tokenCap: 120,
      }),
    );
  });

  it("rejects delegated sub-agent expansion when no grant is propagated", async () => {
    const mockRetrieval = makeMockRetrieval();

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:no-grant",
    });
    const result = await tool.execute("call-missing-grant", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: expect.stringContaining("requires a valid grant"),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("allows delegated sub-agent expansion with a valid grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 40,
      truncated: false,
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:granted",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:granted",
    });
    const result = await tool.execute("call-valid-grant", {
      summaryIds: ["sum_a"],
      conversationId: 42,
    });

    expect(mockRetrieval.expand).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      expansionCount: 1,
      totalTokens: 40,
      truncated: false,
    });
  });

  it("rejects delegated expansion with an expired grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:expired",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      ttlMs: 0,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:expired",
    });
    const result = await tool.execute("call-expired-grant", {
      summaryIds: ["sum_a"],
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/authorization failed.*expired/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("rejects delegated expansion with a revoked grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:revoked",
      issuerSessionId: "main",
      allowedConversationIds: [42],
    });
    revokeDelegatedExpansionGrantForSession("agent:main:subagent:revoked");

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:revoked",
    });
    const result = await tool.execute("call-revoked-grant", {
      summaryIds: ["sum_a"],
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/authorization failed.*revoked/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("rejects delegated expansion outside conversation scope", async () => {
    const mockRetrieval = makeMockRetrieval();

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:conversation-scope",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:conversation-scope",
    });
    const result = await tool.execute("call-conv-scope", {
      summaryIds: ["sum_a"],
      conversationId: 8,
    });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/conversation 8/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("clamps delegated expansion tokenCap to grant budget", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 5,
      truncated: false,
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:token-cap",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 50,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:token-cap",
    });
    const result = await tool.execute("call-token-cap", {
      summaryIds: ["sum_a"],
      conversationId: 7,
      tokenCap: 120,
    });

    expect(result.details).toMatchObject({
      expansionCount: 1,
      totalTokens: 5,
      truncated: false,
    });
    expect(mockRetrieval.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryId: "sum_a",
        tokenCap: 50,
      }),
    );
  });

  it("keeps route-only query probes local when there are no matches", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [],
      totalMatches: 0,
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:route-only",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:route-only",
    });
    const result = await tool.execute("call-route-only", {
      query: "nothing to see",
      conversationId: 7,
      tokenCap: 120,
    });

    expect(mockRetrieval.expand).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      expansionCount: 0,
      executionPath: "direct",
      policy: {
        action: "answer_directly",
      },
    });
  });

  it("expands directly from sub-agent sessions when policy suggests delegation", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        { summaryId: "sum_1", conversationId: 7, kind: "leaf", snippet: "1" },
        { summaryId: "sum_2", conversationId: 7, kind: "leaf", snippet: "2" },
        { summaryId: "sum_3", conversationId: 7, kind: "leaf", snippet: "3" },
        { summaryId: "sum_4", conversationId: 7, kind: "leaf", snippet: "4" },
        { summaryId: "sum_5", conversationId: 7, kind: "leaf", snippet: "5" },
        { summaryId: "sum_6", conversationId: 7, kind: "leaf", snippet: "6" },
      ],
      totalMatches: 6,
    });
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 10,
      truncated: false,
    });

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:direct-only",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval: mockRetrieval }),
      sessionId: "agent:main:subagent:direct-only",
    });
    const result = await tool.execute("call-delegated", {
      query: "deep chain",
      conversationId: 7,
      maxDepth: 6,
      tokenCap: 120,
    });

    expect(mockRetrieval.expand).toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      executionPath: "direct",
      observability: {
        decisionPath: {
          policyAction: "delegate_traversal",
          executionPath: "direct",
        },
      },
    });
  });
});
