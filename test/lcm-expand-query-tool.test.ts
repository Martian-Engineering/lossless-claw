import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../src/engine.js";
import {
  createDelegatedExpansionGrant,
  resolveDelegatedExpansionGrantId,
  resetDelegatedExpansionGrantsForTests,
} from "../src/expansion-auth.js";
import {
  getDelegatedExpansionContextForTests,
  getExpansionDelegationTelemetrySnapshotForTests,
  resetExpansionDelegationGuardForTests,
  stampDelegatedExpansionContext,
} from "../src/tools/lcm-expansion-recursion-guard.js";
import { createLcmExpandQueryTool } from "../src/tools/lcm-expand-query-tool.js";
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

function readLatestAssistantReply(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (Array.isArray(message.content)) {
      const text = message.content
        .map((part) => {
          const block = part as { type?: unknown; text?: unknown };
          return block.type === "text" && typeof block.text === "string" ? block.text : "";
        })
        .join("\n")
        .trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function makeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      expansionProvider: "",
      expansionModel: "",
      delegationTimeoutMs: 120000,
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      proactiveThresholdCompactionMode: "deferred",
      autoRotateSessionFiles: {
        enabled: true,
        sizeBytes: 2 * 1024 * 1024,
        startup: "rotate",
        runtime: "rotate",
      },
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(),
    callGateway: (params: { method: string; params?: Record<string, unknown> }) =>
      callGatewayMock(params),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply,
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

function makeRetrieval() {
  return {
    grep: vi.fn(),
    describe: vi.fn(),
  };
}

function makeSummaryStore() {
  return {
    getConversationMaxSummaryDepth: vi.fn(),
    getLeafSummaryLinksForMessageIds: vi.fn(),
  };
}

function makeEngine(params: {
  retrieval: ReturnType<typeof makeRetrieval>;
  summaryStore?: ReturnType<typeof makeSummaryStore>;
  conversationId?: number;
  conversationFamilyIds?: number[];
}): LcmContextEngine {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    getRetrieval: () => params.retrieval,
    getSummaryStore: () => params.summaryStore ?? makeSummaryStore(),
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn(async () =>
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
      getConversationFamilyIds: vi.fn(async () =>
        params.conversationFamilyIds && params.conversationFamilyIds.length > 0
          ? params.conversationFamilyIds
          : typeof params.conversationId === "number"
            ? [params.conversationId]
            : [],
      ),
    }),
  } as unknown as LcmContextEngine;
}

describe("createLcmExpandQueryTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockReset();
    resetDelegatedExpansionGrantsForTests();
    resetExpansionDelegationGuardForTests();
  });

  it("describes query and prompt roles for focused FTS expansion", () => {
    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
    });

    expect(tool.description).toContain("focused natural-language question");
    expect(tool.description).toContain("same full-text rules as lcm_grep");
    const properties = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties;
    expect(properties.query?.description).toContain("same full-text search path as lcm_grep");
    expect(properties.query?.description).toContain("FTS5 defaults to AND matching");
    expect(properties.query?.description).toContain("Use 1-3 distinctive terms or a quoted phrase");
    expect(properties.prompt?.description).toContain("Put the answer request here, not in query");
  });

  it("returns a focused delegated answer for explicit summaryIds", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    let delegatedSessionKey = "";
    let delegatedContext:
      | ReturnType<typeof getDelegatedExpansionContextForTests>
      | undefined;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        delegatedSessionKey = String(request.params?.sessionKey ?? "");
        delegatedContext = getDelegatedExpansionContextForTests(delegatedSessionKey);
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Issue traced to stale token handling.",
                    citedIds: ["sum_a"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 45000,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-1", {
      summaryIds: ["sum_a"],
      prompt: "What caused the outage?",
      conversationId: 42,
      maxTokens: 700,
    });

    expect(result.details).toMatchObject({
      answer: "Issue traced to stale token handling.",
      citedIds: ["sum_a"],
      sourceConversationId: 42,
      expandedSummaryCount: 1,
      totalSourceTokens: 45000,
      truncated: false,
    });

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");
    const rawMessage = agentCall?.params?.message;
    expect(typeof rawMessage).toBe("string");
    const message = typeof rawMessage === "string" ? rawMessage : "";
    expect(message).toContain("lcm_expand");
    expect(message).toContain("lcm_describe");
    expect(message).toContain("DO NOT call `lcm_expand_query` from this delegated session.");
    expect(message).toContain("Synthesize the final answer from retrieved evidence, not assumptions.");
    expect(message).toContain("for any explicit leaf summary used as evidence");
    expect(message).toContain("even if you did not call `lcm_expand` for that leaf");
    expect(message).toContain("Expansion token budget");

    expect(delegatedSessionKey).not.toBe("");
    expect(delegatedContext).toMatchObject({
      requestId: expect.any(String),
      expansionDepth: 1,
      originSessionKey: "agent:main:main",
      stampedBy: "lcm_expand_query",
    });
    expect(resolveDelegatedExpansionGrantId(delegatedSessionKey)).toBeNull();
    expect(getExpansionDelegationTelemetrySnapshotForTests()).toMatchObject({
      start: 1,
      block: 0,
      timeout: 0,
      success: 1,
    });
  });

  it("resolves a single source conversation from a session family query", async () => {
    const retrieval = makeRetrieval();
    retrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_recent",
          conversationId: 42,
          kind: "leaf",
          snippet: "recent snippet",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          summaryId: "sum_older",
          conversationId: 21,
          kind: "leaf",
          snippet: "older snippet",
          createdAt: new Date("2025-12-31T00:00:00.000Z"),
        },
      ],
      totalMatches: 2,
    });

    let delegatedMessage = "";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        delegatedMessage = String(request.params?.message ?? "");
        return { runId: "run-family" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Recent segment wins.",
                    citedIds: ["sum_recent"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 1200,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({
        retrieval,
        conversationId: 42,
        conversationFamilyIds: [42, 21],
      }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-family-query", {
      query: "deployment",
      prompt: "What changed recently?",
    });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "summaries",
        conversationIds: [42, 21],
      }),
    );
    expect(delegatedMessage).toContain("Conversation scope: 42");
    expect(result.details).toMatchObject({
      answer: "Recent segment wins.",
      citedIds: ["sum_recent"],
      sourceConversationId: 42,
    });
  });

  it("rejects explicit summaryIds that fall outside the allowed session family scope", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe
      .mockResolvedValueOnce({
        type: "summary",
        summary: { conversationId: 42 },
      })
      .mockResolvedValueOnce({
        type: "summary",
        summary: { conversationId: 999 },
      });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({
        retrieval,
        conversationId: 42,
        conversationFamilyIds: [42, 21],
      }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-family-out-of-scope", {
      summaryIds: ["sum_recent", "sum_wrong"],
      prompt: "What changed?",
    });

    expect(result.details).toMatchObject({
      error: expect.stringContaining("outside the allowed conversation scope"),
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("fails closed when the delegated child returns malformed JSON status instead of an answer", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-invalid-json" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    status: "need_context",
                    message: "I do not have enough context.",
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-invalid-json", {
      summaryIds: ["sum_a"],
      prompt: "What caused the outage?",
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      error: expect.stringContaining('JSON without a non-empty "answer"'),
    });
  });

  it("returns a validation error when prompt is missing", async () => {
    const retrieval = makeRetrieval();

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-2", {
      summaryIds: ["sum_a"],
      prompt: "   ",
    });

    expect(result.details).toMatchObject({
      error: "prompt is required.",
    });
    expect(callGatewayMock).not.toHaveBeenCalled();
  });

  it("passes split expansion provider and model overrides to delegated agent runs", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-overrides" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Handled by override test.",
                    citedIds: ["sum_a"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 1234,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const deps = makeDeps();
    const tool = createLcmExpandQueryTool({
      deps: {
        ...deps,
        config: {
          ...deps.config,
          expansionProvider: "openrouter",
          expansionModel: "anthropic/claude-haiku-4-5",
        },
      },
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    await tool.execute("call-overrides", {
      summaryIds: ["sum_a"],
      prompt: "Answer this",
      conversationId: 42,
    });

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");

    expect(agentCall?.params).toMatchObject({
      model: "anthropic/claude-haiku-4-5",
    });
  });

  it("normalizes canonical expansion model refs before delegated agent runs", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-canonical-override" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Handled by canonical override test.",
                    citedIds: ["sum_a"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 1234,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const deps = makeDeps();
    const tool = createLcmExpandQueryTool({
      deps: {
        ...deps,
        config: {
          ...deps.config,
          expansionProvider: "openai-codex",
          expansionModel: "openai/gpt-5-mini",
        },
      },
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    await tool.execute("call-canonical-overrides", {
      summaryIds: ["sum_a"],
      prompt: "Answer this",
      conversationId: 42,
    });

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");

    expect(agentCall?.params).not.toHaveProperty("provider");
    expect(agentCall?.params).toMatchObject({
      model: "openai/gpt-5-mini",
    });
  });

  it("passes split openai-codex expansion overrides through on the happy path", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        return { runId: "run-openai-codex-split" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Handled by split codex override.",
                    citedIds: ["sum_a"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 222,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const deps = makeDeps();
    const tool = createLcmExpandQueryTool({
      deps: {
        ...deps,
        config: {
          ...deps.config,
          expansionProvider: "openai-codex",
          expansionModel: "gpt-5.4",
        },
      },
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-openai-codex-split-happy", {
      summaryIds: ["sum_a"],
      prompt: "Answer this",
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      answer: "Handled by split codex override.",
      citedIds: ["sum_a"],
      expandedSummaryCount: 1,
    });

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");

    expect(agentCall?.params).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
  });

  it("retries without override when delegated spawn fails with auth scope error", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    let agentCalls = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        agentCalls += 1;
        if (agentCalls === 1) {
          throw new Error("401 Missing scopes: model.request");
        }
        return { runId: "run-default-model" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Recovered with default expansion model.",
                    citedIds: ["sum_a"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 321,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const deps = makeDeps();
    const tool = createLcmExpandQueryTool({
      deps: {
        ...deps,
        config: {
          ...deps.config,
          expansionProvider: "openai-codex",
          expansionModel: "gpt-5.4",
        },
      },
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-auth-fallback", {
      summaryIds: ["sum_a"],
      prompt: "Answer this",
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      answer: "Recovered with default expansion model.",
      citedIds: ["sum_a"],
      expandedSummaryCount: 1,
    });

    const agentCallsWithParams = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .filter((entry) => entry.method === "agent");
    expect(agentCallsWithParams).toHaveLength(2);
    expect(agentCallsWithParams[0]?.params).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(agentCallsWithParams[1]?.params).not.toHaveProperty("provider");
    expect(agentCallsWithParams[1]?.params).not.toHaveProperty("model");
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("Missing scopes: model.request"),
    );
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("retrying delegated expansion without provider/model override"),
    );
  });

  it("retries without override when delegated wait returns model override auth error", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    let agentCalls = 0;
    let waitCalls = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        agentCalls += 1;
        return { runId: `run-${agentCalls}` };
      }
      if (request.method === "agent.wait") {
        waitCalls += 1;
        if (waitCalls === 1) {
          return { status: "error", error: "provider/model overrides are not authorized for this caller." };
        }
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Recovered after wait error fallback.",
                    citedIds: ["sum_a"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 654,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const deps = makeDeps();
    const tool = createLcmExpandQueryTool({
      deps: {
        ...deps,
        config: {
          ...deps.config,
          expansionProvider: "openai-codex",
          expansionModel: "gpt-5.4",
        },
      },
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-wait-fallback", {
      summaryIds: ["sum_a"],
      prompt: "Answer this",
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      answer: "Recovered after wait error fallback.",
      citedIds: ["sum_a"],
      expandedSummaryCount: 1,
    });

    const agentCallsWithParams = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .filter((entry) => entry.method === "agent");
    expect(agentCallsWithParams).toHaveLength(2);
    expect(agentCallsWithParams[0]?.params).toMatchObject({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
    expect(agentCallsWithParams[1]?.params).not.toHaveProperty("provider");
    expect(agentCallsWithParams[1]?.params).not.toHaveProperty("model");
    expect(deps.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("provider/model overrides are not authorized"),
    );
  });

  it("returns timeout when delegated run exceeds 120 seconds", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    let delegatedSessionKey = "";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        delegatedSessionKey = String(request.params?.sessionKey ?? "");
        return { runId: "run-timeout" };
      }
      if (request.method === "agent.wait") {
        return { status: "timeout" };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-3", {
      summaryIds: ["sum_a"],
      prompt: "Summarize root cause",
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      error: "lcm_expand_query timed out waiting for delegated expansion (120s).",
    });

    const methods = callGatewayMock.mock.calls.map(
      ([opts]) => (opts as { method?: string }).method,
    );
    expect(methods).toContain("sessions.delete");
    expect(delegatedSessionKey).not.toBe("");
    expect(resolveDelegatedExpansionGrantId(delegatedSessionKey)).toBeNull();
    expect(getExpansionDelegationTelemetrySnapshotForTests()).toMatchObject({
      start: 1,
      block: 0,
      timeout: 1,
      success: 0,
    });
  });

  it("uses configured delegationTimeoutMs for delegated wait timeout", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    const waitCalls: Array<{ paramsTimeoutMs?: unknown; timeoutMs?: unknown }> = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as {
        method?: string;
        params?: Record<string, unknown>;
        timeoutMs?: unknown;
      };
      if (request.method === "agent") {
        return { runId: "run-timeout-configured" };
      }
      if (request.method === "agent.wait") {
        waitCalls.push({
          paramsTimeoutMs: request.params?.timeoutMs,
          timeoutMs: request.timeoutMs,
        });
        return { status: "timeout" };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const deps = makeDeps();
    const tool = createLcmExpandQueryTool({
      deps: {
        ...deps,
        config: {
          ...deps.config,
          delegationTimeoutMs: 300000,
        },
      },
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-timeout-config", {
      summaryIds: ["sum_a"],
      prompt: "Summarize root cause",
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      error: "lcm_expand_query timed out waiting for delegated expansion (300s).",
    });
    expect(waitCalls).toEqual([
      {
        paramsTimeoutMs: 300000,
        timeoutMs: 300000,
      },
    ]);
  });

  it("cleans up delegated session and grant when agent call fails", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    let delegatedSessionKey = "";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        delegatedSessionKey = String(request.params?.sessionKey ?? "");
        throw new Error("agent spawn failed");
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-4", {
      summaryIds: ["sum_a"],
      prompt: "Answer this",
      conversationId: 42,
    });

    expect(result.details).toMatchObject({
      error: "agent spawn failed",
    });

    const methods = callGatewayMock.mock.calls.map(
      ([opts]) => (opts as { method?: string }).method,
    );
    expect(methods).toContain("sessions.delete");
    expect(delegatedSessionKey).not.toBe("");
    expect(resolveDelegatedExpansionGrantId(delegatedSessionKey)).toBeNull();
  });

  it("greps summaries first when query is provided", async () => {
    const retrieval = makeRetrieval();
    retrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_x",
          conversationId: 7,
          kind: "leaf",
          snippet: "x",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          summaryId: "sum_y",
          conversationId: 7,
          kind: "leaf",
          snippet: "y",
          createdAt: new Date("2026-01-01T00:01:00.000Z"),
        },
      ],
      totalMatches: 2,
    });

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        return { runId: "run-query" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Top regression happened after deploy B.",
                    citedIds: ["sum_x", "sum_y"],
                    expandedSummaryCount: 2,
                    totalSourceTokens: 2500,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval, conversationId: 7 }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-5", {
      query: "deploy regression",
      prompt: "What regressed?",
    });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "deploy regression",
        mode: "full_text",
        scope: "summaries",
        conversationId: 7,
      }),
    );

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");
    const rawMessage = agentCall?.params?.message;
    expect(typeof rawMessage).toBe("string");
    const message = typeof rawMessage === "string" ? rawMessage : "";
    expect(message).toContain("sum_x");
    expect(message).toContain("sum_y");
    expect(message).toContain('Prefer `mode: "full_text"`');
    expect(message).toContain('sort: "relevance"');
    expect(message).toContain('sort: "hybrid"');

    expect(result.details).toMatchObject({
      sourceConversationId: 7,
      expandedSummaryCount: 2,
      citedIds: ["sum_x", "sum_y"],
    });
  });

  it("merges delegated answers across multiple conversations when allConversations=true", async () => {
    const retrieval = makeRetrieval();
    retrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_beta",
          conversationId: 9,
          kind: "leaf",
          snippet: "beta",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          summaryId: "sum_alpha",
          conversationId: 7,
          kind: "leaf",
          snippet: "alpha",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
        {
          summaryId: "sum_gamma",
          conversationId: 9,
          kind: "leaf",
          snippet: "gamma",
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
      ],
      totalMatches: 3,
    });

    const agentMessages: string[] = [];
    let sessionGetCalls = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        agentMessages.push(String(request.params?.message ?? ""));
        return { runId: `run-${agentMessages.length}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        sessionGetCalls += 1;
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    sessionGetCalls === 1
                      ? {
                          answer: "Conversation 9 concluded the rollback should proceed first.",
                          citedIds: ["sum_beta", "sum_gamma"],
                          expandedSummaryCount: 2,
                          totalSourceTokens: 700,
                          truncated: false,
                        }
                      : {
                          answer: "Conversation 7 captured the earlier mitigation context.",
                          citedIds: ["sum_alpha"],
                          expandedSummaryCount: 1,
                          totalSourceTokens: 300,
                          truncated: false,
                        },
                  ),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-multi-query", {
      query: "rollback plan",
      prompt: "What did we decide across sessions?",
      allConversations: true,
      tokenCap: 2000,
    });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "rollback plan",
        mode: "full_text",
        scope: "summaries",
        conversationId: undefined,
      }),
    );
    expect(agentMessages).toHaveLength(2);
    expect(agentMessages[0]).toContain("Conversation scope: 9");
    expect(agentMessages[0]).toContain("Seed summary IDs: sum_beta, sum_gamma");
    expect(agentMessages[1]).toContain("Conversation scope: 7");
    expect(agentMessages[1]).toContain("Seed summary IDs: sum_alpha");

    expect(result.details).toMatchObject({
      sourceConversationIds: [7, 9],
      citedIds: ["sum_beta", "sum_gamma", "sum_alpha"],
      expandedSummaryCount: 3,
      totalSourceTokens: 1000,
      truncated: false,
      conversationBreakdown: [
        {
          conversationId: 9,
          expandedSummaryCount: 2,
          status: "success",
        },
        {
          conversationId: 7,
          expandedSummaryCount: 1,
          status: "success",
        },
      ],
    });
    expect(result.details).not.toHaveProperty("sourceConversationId");
    expect((result.details as { answer?: string }).answer).toContain(
      "Merged findings across 2 conversations:",
    );
    expect((result.details as { answer?: string }).answer).toContain(
      "Conversation 9 concluded the rollback should proceed first.",
    );
    expect((result.details as { answer?: string }).answer).toContain(
      "Conversation 7 captured the earlier mitigation context.",
    );
  });

  it("expands explicit summaryIds across conversations when allConversations=true", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockImplementation(async (summaryId: string) => {
      if (summaryId === "sum_a") {
        return {
          type: "summary",
          summary: {
            conversationId: 7,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        };
      }
      if (summaryId === "sum_b") {
        return {
          type: "summary",
          summary: {
            conversationId: 11,
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        };
      }
      return null;
    });

    const agentMessages: string[] = [];
    let sessionGetCalls = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        agentMessages.push(String(request.params?.message ?? ""));
        return { runId: `run-explicit-${agentMessages.length}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        sessionGetCalls += 1;
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    sessionGetCalls === 1
                      ? {
                          answer: "Conversation 11 contains the final deployment checklist.",
                          citedIds: ["sum_b"],
                          expandedSummaryCount: 1,
                          totalSourceTokens: 400,
                          truncated: false,
                        }
                      : {
                          answer: "Conversation 7 documents the earlier rollback rationale.",
                          citedIds: ["sum_a"],
                          expandedSummaryCount: 1,
                          totalSourceTokens: 250,
                          truncated: false,
                        },
                  ),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-explicit-multi", {
      summaryIds: ["sum_a", "sum_b"],
      prompt: "What rollout steps were captured?",
      allConversations: true,
      tokenCap: 2000,
    });

    expect(agentMessages).toHaveLength(2);
    expect(agentMessages[0]).toContain("Conversation scope: 11");
    expect(agentMessages[0]).toContain("Seed summary IDs: sum_b");
    expect(agentMessages[1]).toContain("Conversation scope: 7");
    expect(agentMessages[1]).toContain("Seed summary IDs: sum_a");

    expect(result.details).toMatchObject({
      sourceConversationIds: [7, 11],
      citedIds: ["sum_b", "sum_a"],
      expandedSummaryCount: 2,
      totalSourceTokens: 650,
      truncated: false,
    });
    expect(result.details).not.toHaveProperty("sourceConversationId");
    expect((result.details as { answer?: string }).answer).toContain(
      "Conversation 11 contains the final deployment checklist.",
    );
    expect((result.details as { answer?: string }).answer).toContain(
      "Conversation 7 documents the earlier rollback rationale.",
    );
  });

  it("marks lower-ranked buckets as skipped when the conversation bucket cap is reached", async () => {
    const retrieval = makeRetrieval();
    retrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_d",
          conversationId: 40,
          kind: "leaf",
          snippet: "d",
          createdAt: new Date("2026-01-04T00:00:00.000Z"),
        },
        {
          summaryId: "sum_c",
          conversationId: 30,
          kind: "leaf",
          snippet: "c",
          createdAt: new Date("2026-01-03T00:00:00.000Z"),
        },
        {
          summaryId: "sum_b",
          conversationId: 20,
          kind: "leaf",
          snippet: "b",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          summaryId: "sum_a",
          conversationId: 10,
          kind: "leaf",
          snippet: "a",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      totalMatches: 4,
    });

    let sessionGetCalls = 0;
    const agentMessages: string[] = [];
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        agentMessages.push(String(request.params?.message ?? ""));
        return { runId: `run-cap-${agentMessages.length}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        sessionGetCalls += 1;
        const conversationId = [40, 30, 20][sessionGetCalls - 1];
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: `Conversation ${conversationId} contributed evidence.`,
                    citedIds: [`sum_${String.fromCharCode(100 - (sessionGetCalls - 1))}`],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 100,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-bucket-cap", {
      query: "deploy notes",
      prompt: "What happened across sessions?",
      allConversations: true,
      tokenCap: 2000,
    });

    expect(agentMessages).toHaveLength(3);
    expect(result.details).toMatchObject({
      sourceConversationIds: [20, 30, 40],
      expandedSummaryCount: 3,
      totalSourceTokens: 300,
      truncated: true,
    });
    expect(result.details).toMatchObject({
      conversationBreakdown: expect.arrayContaining([
        expect.objectContaining({
          conversationId: 10,
          status: "skipped",
          error: "skipped after reaching max conversation bucket limit (3)",
        }),
      ]),
    });
    expect((result.details as { answer?: string }).answer).toContain("skipped conversations");
  });

  it("returns a partial answer when one cross-conversation bucket times out", async () => {
    const retrieval = makeRetrieval();
    retrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_timeout",
          conversationId: 9,
          kind: "leaf",
          snippet: "timeout",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          summaryId: "sum_ok",
          conversationId: 7,
          kind: "leaf",
          snippet: "ok",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      totalMatches: 2,
    });

    let agentCalls = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        agentCalls += 1;
        return { runId: `run-timeout-${agentCalls}` };
      }
      if (request.method === "agent.wait") {
        if (agentCalls === 1) {
          return { status: "timeout" };
        }
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Conversation 7 preserved the recovery steps.",
                    citedIds: ["sum_ok"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 250,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-partial-timeout", {
      query: "recovery steps",
      prompt: "What did we preserve?",
      allConversations: true,
      tokenCap: 2000,
    });

    expect(result.details).toMatchObject({
      sourceConversationIds: [7],
      citedIds: ["sum_ok"],
      expandedSummaryCount: 1,
      totalSourceTokens: 250,
      truncated: true,
    });
    expect(result.details).toMatchObject({
      conversationBreakdown: expect.arrayContaining([
        expect.objectContaining({
          conversationId: 9,
          status: "failed",
          error: "lcm_expand_query timed out waiting for delegated expansion (120s).",
        }),
        expect.objectContaining({
          conversationId: 7,
          status: "success",
        }),
      ]),
    });
    expect((result.details as { answer?: string }).answer).toContain(
      "Conversation 7 preserved the recovery steps.",
    );
    expect((result.details as { answer?: string }).answer).toContain("failed conversations");
  });

  it("returns partial coverage when the global token budget is exhausted mid-run", async () => {
    const retrieval = makeRetrieval();
    retrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [
        {
          summaryId: "sum_large",
          conversationId: 9,
          kind: "leaf",
          snippet: "large",
          createdAt: new Date("2026-01-02T00:00:00.000Z"),
        },
        {
          summaryId: "sum_small",
          conversationId: 7,
          kind: "leaf",
          snippet: "small",
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      ],
      totalMatches: 2,
    });

    let sessionGetCalls = 0;
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-budget" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        sessionGetCalls += 1;
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Conversation 9 used the whole retrieval budget.",
                    citedIds: ["sum_large"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 500,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-budget-exhausted", {
      query: "budgeted search",
      prompt: "What did we learn?",
      allConversations: true,
      tokenCap: 500,
    });

    expect(sessionGetCalls).toBe(1);
    expect(result.details).toMatchObject({
      sourceConversationIds: [9],
      citedIds: ["sum_large"],
      expandedSummaryCount: 1,
      totalSourceTokens: 500,
      truncated: true,
    });
    expect(result.details).toMatchObject({
      conversationBreakdown: expect.arrayContaining([
        expect.objectContaining({
          conversationId: 9,
          status: "success",
        }),
        expect.objectContaining({
          conversationId: 7,
          status: "skipped",
          error: "global token budget exhausted",
        }),
      ]),
    });
    expect((result.details as { answer?: string }).answer).toContain("skipped conversations");
  });

  it("falls back to messages for shallow trees when summary grep misses", async () => {
    const retrieval = makeRetrieval();
    const summaryStore = makeSummaryStore();
    retrieval.grep
      .mockResolvedValueOnce({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            messageId: 101,
            conversationId: 7,
            role: "user",
            snippet: "rollback the deploy",
            createdAt: new Date("2026-01-01T00:02:00.000Z"),
          },
        ],
        summaries: [],
        totalMatches: 1,
      });
    summaryStore.getConversationMaxSummaryDepth.mockResolvedValue(1);
    summaryStore.getLeafSummaryLinksForMessageIds.mockResolvedValue([
      {
        messageId: 101,
        summaryId: "sum_leaf",
      },
    ]);

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-shallow-fallback" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "The rollback note only appears in the raw leaf messages.",
                    citedIds: ["sum_leaf"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 800,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval, summaryStore, conversationId: 7 }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-shallow-fallback", {
      query: "rollback deploy",
      prompt: "What happened?",
    });

    expect(retrieval.grep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        query: "rollback deploy",
        mode: "full_text",
        scope: "summaries",
        conversationId: 7,
      }),
    );
    expect(retrieval.grep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        query: "rollback deploy",
        mode: "full_text",
        scope: "messages",
        conversationId: 7,
      }),
    );
    expect(summaryStore.getConversationMaxSummaryDepth).toHaveBeenCalledWith(7);
    expect(summaryStore.getLeafSummaryLinksForMessageIds).toHaveBeenCalledWith(7, [101]);

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");
    const rawMessage = agentCall?.params?.message;
    expect(typeof rawMessage).toBe("string");
    const message = typeof rawMessage === "string" ? rawMessage : "";
    expect(message).toContain("Seed summary IDs: sum_leaf");
    expect(message).toContain("Seed summaries requiring raw message expansion: sum_leaf");

    expect(result.details).toMatchObject({
      answer: "The rollback note only appears in the raw leaf messages.",
      citedIds: ["sum_leaf"],
      sourceConversationId: 7,
      expandedSummaryCount: 1,
    });
  });

  it("does not fall back to message grep for deep trees", async () => {
    const retrieval = makeRetrieval();
    const summaryStore = makeSummaryStore();
    retrieval.grep.mockResolvedValue({
      messages: [],
      summaries: [],
      totalMatches: 0,
    });
    summaryStore.getConversationMaxSummaryDepth.mockResolvedValue(2);

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval, summaryStore, conversationId: 7 }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-deep-no-fallback", {
      query: "rollback deploy",
      prompt: "What happened?",
    });

    expect(retrieval.grep).toHaveBeenCalledTimes(1);
    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "summaries",
        conversationId: 7,
      }),
    );
    expect(summaryStore.getConversationMaxSummaryDepth).toHaveBeenCalledWith(7);
    expect(summaryStore.getLeafSummaryLinksForMessageIds).not.toHaveBeenCalled();
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      answer: "No matching summaries found for this scope.",
      citedIds: [],
      sourceConversationId: 7,
      expandedSummaryCount: 0,
    });
  });

  it("maps message hits to parent leaf summary ids before delegating", async () => {
    const retrieval = makeRetrieval();
    const summaryStore = makeSummaryStore();
    retrieval.grep
      .mockResolvedValueOnce({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            messageId: 302,
            conversationId: 7,
            role: "assistant",
            snippet: "second raw fact",
            createdAt: new Date("2026-01-01T00:03:00.000Z"),
          },
          {
            messageId: 301,
            conversationId: 7,
            role: "user",
            snippet: "first raw fact",
            createdAt: new Date("2026-01-01T00:02:00.000Z"),
          },
        ],
        summaries: [],
        totalMatches: 2,
      });
    summaryStore.getConversationMaxSummaryDepth.mockResolvedValue(0);
    summaryStore.getLeafSummaryLinksForMessageIds.mockResolvedValue([
      {
        messageId: 302,
        summaryId: "sum_b",
      },
      {
        messageId: 301,
        summaryId: "sum_a",
      },
      {
        messageId: 301,
        summaryId: "sum_a",
      },
    ]);

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-message-map" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Mapped through leaf summaries.",
                    citedIds: ["sum_b", "sum_a"],
                    expandedSummaryCount: 2,
                    totalSourceTokens: 900,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval, summaryStore, conversationId: 7 }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    await tool.execute("call-message-map", {
      query: "raw fact",
      prompt: "What facts are present?",
    });

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");
    const rawMessage = agentCall?.params?.message;
    expect(typeof rawMessage).toBe("string");
    const message = typeof rawMessage === "string" ? rawMessage : "";
    expect(message).toContain("Seed summary IDs: sum_b, sum_a");
    expect(message).toContain("Seed summaries requiring raw message expansion: sum_b, sum_a");
  });

  it("falls back across session-family segments using per-conversation leaf links", async () => {
    const retrieval = makeRetrieval();
    const summaryStore = makeSummaryStore();
    retrieval.grep
      .mockResolvedValueOnce({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            messageId: 801,
            conversationId: 42,
            role: "assistant",
            snippet: "latest rollout note",
            createdAt: new Date("2026-01-02T00:03:00.000Z"),
          },
          {
            messageId: 701,
            conversationId: 21,
            role: "user",
            snippet: "older rollout note",
            createdAt: new Date("2025-12-31T00:03:00.000Z"),
          },
        ],
        summaries: [],
        totalMatches: 2,
      });
    summaryStore.getConversationMaxSummaryDepth
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(1);
    summaryStore.getLeafSummaryLinksForMessageIds
      .mockResolvedValueOnce([
        {
          messageId: 801,
          summaryId: "sum_recent",
        },
      ])
      .mockResolvedValueOnce([
        {
          messageId: 701,
          summaryId: "sum_older",
        },
      ]);

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-family-fallback" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Recent family segment captures the rollout note.",
                    citedIds: ["sum_recent"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 700,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({
        retrieval,
        summaryStore,
        conversationId: 42,
        conversationFamilyIds: [42, 21],
      }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-family-fallback", {
      query: "rollout note",
      prompt: "What changed recently?",
    });

    expect(retrieval.grep).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        scope: "summaries",
        conversationIds: [42, 21],
      }),
    );
    expect(retrieval.grep).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        scope: "messages",
        conversationIds: [42, 21],
      }),
    );
    expect(summaryStore.getConversationMaxSummaryDepth).toHaveBeenNthCalledWith(1, 42);
    expect(summaryStore.getConversationMaxSummaryDepth).toHaveBeenNthCalledWith(2, 21);
    expect(summaryStore.getLeafSummaryLinksForMessageIds).toHaveBeenNthCalledWith(1, 42, [801]);
    expect(summaryStore.getLeafSummaryLinksForMessageIds).toHaveBeenNthCalledWith(2, 21, [701]);
    expect(result.details).toMatchObject({
      answer: "Recent family segment captures the rollout note.",
      citedIds: ["sum_recent"],
      sourceConversationId: 42,
    });
  });

  it("excludes fresh-tail message hits that are not linked to any summary", async () => {
    const retrieval = makeRetrieval();
    const summaryStore = makeSummaryStore();
    retrieval.grep
      .mockResolvedValueOnce({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })
      .mockResolvedValueOnce({
        messages: [
          {
            messageId: 999,
            conversationId: 7,
            role: "user",
            snippet: "fresh tail fact",
            createdAt: new Date("2026-01-01T00:04:00.000Z"),
          },
        ],
        summaries: [],
        totalMatches: 1,
      });
    summaryStore.getConversationMaxSummaryDepth.mockResolvedValue(1);
    summaryStore.getLeafSummaryLinksForMessageIds.mockResolvedValue([]);

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval, summaryStore, conversationId: 7 }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-fresh-tail-skip", {
      query: "fresh tail fact",
      prompt: "What facts are present?",
    });

    expect(summaryStore.getLeafSummaryLinksForMessageIds).toHaveBeenCalledWith(7, [999]);
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      answer: "No matching summaries found for this scope.",
      citedIds: [],
      sourceConversationId: 7,
      expandedSummaryCount: 0,
    });
  });

  it("blocks delegated re-entry with deterministic recursion errors", async () => {
    const retrieval = makeRetrieval();
    const delegatedSessionKey = "agent:main:subagent:recursive";
    createDelegatedExpansionGrant({
      delegatedSessionKey,
      issuerSessionId: "agent:main:main",
      allowedConversationIds: [42],
      tokenCap: 120,
    });
    stampDelegatedExpansionContext({
      sessionKey: delegatedSessionKey,
      requestId: "req-recursive",
      expansionDepth: 1,
      originSessionKey: "agent:main:main",
      stampedBy: "test",
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: delegatedSessionKey,
      requesterSessionKey: delegatedSessionKey,
    });

    const first = await tool.execute("call-recursive-1", {
      summaryIds: ["sum_a"],
      prompt: "Should block recursion",
      conversationId: 42,
    });
    expect(first.details).toMatchObject({
      errorCode: "EXPANSION_RECURSION_BLOCKED",
      reason: "depth_cap",
      requestId: "req-recursive",
    });
    expect((first.details as { error?: string }).error).toContain(
      "Recovery: In delegated sub-agent sessions, call `lcm_expand` directly",
    );
    expect((first.details as { error?: string }).error).toContain(
      "Do NOT call `lcm_expand_query` from delegated context.",
    );

    const second = await tool.execute("call-recursive-2", {
      summaryIds: ["sum_a"],
      prompt: "Should block recursion again",
      conversationId: 42,
    });
    expect(second.details).toMatchObject({
      errorCode: "EXPANSION_RECURSION_BLOCKED",
      reason: "idempotent_reentry",
      requestId: "req-recursive",
    });

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getExpansionDelegationTelemetrySnapshotForTests()).toMatchObject({
      start: 2,
      block: 2,
      timeout: 0,
      success: 0,
    });
  });

  it("does not block concurrent requests that never delegate", async () => {
    const retrieval = makeRetrieval();

    let releaseFirstGrep!: () => void;
    const firstGrepGate = new Promise<void>((resolve) => {
      releaseFirstGrep = () => resolve();
    });
    let grepCalls = 0;
    retrieval.grep.mockImplementation(async () => {
      grepCalls += 1;
      if (grepCalls === 1) {
        await firstGrepGate;
      }
      return {
        messages: [],
        summaries: [],
        totalMatches: 0,
      };
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval, conversationId: 7 }),
      sessionId: "session-1",
      requesterSessionKey: "agent:main:main",
    });

    const firstPromise = tool.execute("call-no-match-1", {
      query: "missing query",
      prompt: "Look for anything relevant",
    });
    const secondPromise = tool.execute("call-no-match-2", {
      query: "missing query",
      prompt: "Look for anything relevant again",
    });

    releaseFirstGrep();
    const [first, second] = await Promise.all([firstPromise, secondPromise]);

    expect(first.details).toMatchObject({
      answer: "No matching summaries found for this scope.",
      citedIds: [],
      sourceConversationId: 7,
      expandedSummaryCount: 0,
      totalSourceTokens: 0,
      truncated: false,
    });
    expect(second.details).toMatchObject({
      answer: "No matching summaries found for this scope.",
      citedIds: [],
      sourceConversationId: 7,
      expandedSummaryCount: 0,
      totalSourceTokens: 0,
      truncated: false,
    });

    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getExpansionDelegationTelemetrySnapshotForTests()).toMatchObject({
      start: 2,
      block: 0,
      timeout: 0,
      success: 0,
    });
  });

  it("blocks concurrent delegated expansion from the same origin session", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });

    let releaseWait!: () => void;
    const waitGate = new Promise<void>((resolve) => {
      releaseWait = () => resolve();
    });
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        return { runId: `run-${callGatewayMock.mock.calls.length}` };
      }
      if (request.method === "agent.wait") {
        await waitGate;
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    answer: "Concurrent expansion resolved cleanly.",
                    citedIds: ["sum_a"],
                    expandedSummaryCount: 1,
                    totalSourceTokens: 1200,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
      deps: makeDeps(),
      lcm: makeEngine({ retrieval }),
      sessionId: "agent:main:main",
      requesterSessionKey: "agent:main:main",
    });

    const firstPromise = tool.execute("call-concurrent-1", {
      summaryIds: ["sum_a"],
      prompt: "Answer while another expansion is running",
      conversationId: 42,
    });
    const second = await tool.execute("call-concurrent-2", {
      summaryIds: ["sum_a"],
      prompt: "Should block until the first finishes",
      conversationId: 42,
    });

    expect(second.details).toMatchObject({
      errorCode: "EXPANSION_CONCURRENCY_BLOCKED",
      reason: "origin_session_in_flight",
      originSessionKey: "agent:main:main",
    });
    expect((second.details as { error?: string }).error).toContain(
      "Another lcm_expand_query delegation is already in flight",
    );
    expect((second.details as { error?: string }).error).toContain(
      "use `lcm_grep` or `lcm_describe` instead",
    );

    releaseWait();
    const first = await firstPromise;
    expect(first.details).toMatchObject({
      answer: "Concurrent expansion resolved cleanly.",
      citedIds: ["sum_a"],
      sourceConversationId: 42,
      expandedSummaryCount: 1,
      totalSourceTokens: 1200,
      truncated: false,
    });

    const third = await tool.execute("call-concurrent-3", {
      summaryIds: ["sum_a"],
      prompt: "Should succeed after the first request releases the slot",
      conversationId: 42,
    });
    expect(third.details).toMatchObject({
      answer: "Concurrent expansion resolved cleanly.",
      citedIds: ["sum_a"],
      sourceConversationId: 42,
      expandedSummaryCount: 1,
      totalSourceTokens: 1200,
      truncated: false,
    });

    const agentCalls = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string })
      .filter((entry) => entry.method === "agent");
    expect(agentCalls).toHaveLength(2);
    expect(getExpansionDelegationTelemetrySnapshotForTests()).toMatchObject({
      start: 3,
      block: 1,
      timeout: 0,
      success: 2,
    });
  });
});
