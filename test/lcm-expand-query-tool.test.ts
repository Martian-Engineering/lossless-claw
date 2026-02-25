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

function makeEngine(params: {
  retrieval: ReturnType<typeof makeRetrieval>;
  conversationId?: number;
}): LcmContextEngine {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    getRetrieval: () => params.retrieval,
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
    expect(message).toContain("DO NOT call `lcm_expand_query` from this delegated session.");
    expect(message).toContain("Synthesize the final answer from the `lcm_expand` output.");

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
      error: expect.stringContaining("timed out"),
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

    expect(result.details).toMatchObject({
      sourceConversationId: 7,
      expandedSummaryCount: 2,
      citedIds: ["sum_x", "sum_y"],
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
});
