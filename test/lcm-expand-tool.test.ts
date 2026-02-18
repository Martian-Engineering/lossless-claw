import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
  revokeDelegatedExpansionGrantForSession,
} from "../../plugins/lcm/expansion-auth.js";
import { createLcmExpandTool } from "./lcm-expand-tool.js";

const callGatewayMock = vi.fn();
vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
}));

vi.mock("../../context-engine/registry.js", () => ({
  resolveContextEngine: vi.fn(),
}));

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

function makeEngine(mockRetrieval: ReturnType<typeof makeMockRetrieval>): LcmContextEngine {
  return {
    info: { id: "lcm" },
    getRetrieval: () => mockRetrieval,
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn().mockResolvedValue(null),
    }),
  } as unknown as LcmContextEngine;
}

const ORIGINAL_MAX_EXPAND = process.env.LCM_MAX_EXPAND_TOKENS;
const MAIN_SESSION_RESTRICTION_ERROR =
  "lcm_expand is only available in sub-agent sessions. Use lcm_describe or lcm_grep to inspect summaries, or delegate expansion to a sub-agent.";

describe("createLcmExpandTool expansion limits", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockReset();
    process.env.LCM_MAX_EXPAND_TOKENS = "120";
    resetDelegatedExpansionGrantsForTests();
  });

  afterEach(() => {
    resetDelegatedExpansionGrantsForTests();
    if (ORIGINAL_MAX_EXPAND === undefined) {
      delete process.env.LCM_MAX_EXPAND_TOKENS;
      return;
    }
    process.env.LCM_MAX_EXPAND_TOKENS = ORIGINAL_MAX_EXPAND;
  });

  it("rejects lcm_expand from main sessions", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    const tool = createLcmExpandTool({ sessionId: "agent:main:main" });
    const result = await tool.execute("call-main-rejected", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: MAIN_SESSION_RESTRICTION_ERROR,
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
    expect(mockRetrieval.grep).not.toHaveBeenCalled();
  });

  it("uses unbounded tokenCap when tokenCap is omitted for summary expansion", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 40,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:unbounded",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:unbounded" });
    await tool.execute("call-1", { summaryIds: ["sum_a"] });

    expect(ensureContextEnginesInitialized).toHaveBeenCalledTimes(1);
    expect(mockRetrieval.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryId: "sum_a",
        tokenCap: Infinity,
      }),
    );
  });

  it("passes through oversized tokenCap for query expansion", async () => {
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
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:query",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:query" });
    await tool.execute("call-2", {
      query: "auth",
      conversationId: 7,
      tokenCap: 9_999,
    });

    expect(mockRetrieval.expand).toHaveBeenCalledWith(
      expect.objectContaining({
        summaryId: "sum_match",
        tokenCap: 9_999,
      }),
    );
  });

  it("rejects delegated sub-agent expansion when no grant is propagated", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:no-grant" });
    const result = await tool.execute("call-missing-grant", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: expect.stringContaining("requires a valid grant"),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("allows delegated sub-agent expansion with a valid grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 40,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:granted",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:granted" });
    const result = await tool.execute("call-valid-grant", { summaryIds: ["sum_a"] });

    expect(mockRetrieval.expand).toHaveBeenCalledOnce();
    expect(result.details).toMatchObject({
      expansionCount: 1,
      totalTokens: 40,
      truncated: false,
    });
  });

  it("rejects delegated expansion with an expired grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:expired",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      ttlMs: 0,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:expired" });
    const result = await tool.execute("call-expired-grant", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/authorization failed.*expired/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("rejects delegated expansion with a revoked grant", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:revoked",
      issuerSessionId: "main",
      allowedConversationIds: [42],
    });
    revokeDelegatedExpansionGrantForSession("agent:main:subagent:revoked");

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:revoked" });
    const result = await tool.execute("call-revoked-grant", { summaryIds: ["sum_a"] });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/authorization failed.*revoked/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("rejects delegated expansion outside conversation scope", async () => {
    const mockRetrieval = makeMockRetrieval();
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:conversation-scope",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:conversation-scope" });
    const result = await tool.execute("call-conv-scope", {
      summaryIds: ["sum_a"],
      conversationId: 8,
    });

    expect(result.details).toMatchObject({
      error: expect.stringMatching(/conversation 8/i),
    });
    expect(mockRetrieval.expand).not.toHaveBeenCalled();
  });

  it("allows delegated expansion over grant token cap", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.expand.mockResolvedValue({
      children: [],
      messages: [],
      estimatedTokens: 5,
      truncated: false,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:token-cap",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 50,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:token-cap" });
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
    expect(mockRetrieval.expand).toHaveBeenCalled();
  });

  it("keeps route-only query probes local when there are no matches", async () => {
    const mockRetrieval = makeMockRetrieval();
    mockRetrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [],
      totalMatches: 0,
    });
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:route-only",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:route-only" });
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
    vi.mocked(resolveContextEngine).mockResolvedValue(makeEngine(mockRetrieval));

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:direct-only",
      issuerSessionId: "main",
      allowedConversationIds: [7],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:direct-only" });
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
