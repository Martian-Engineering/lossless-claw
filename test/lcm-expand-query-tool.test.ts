import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import { createLcmExpandQueryTool } from "./lcm-expand-query-tool.js";

const callGatewayMock = vi.fn();
const createGrantMock = vi.fn();
const revokeGrantMock = vi.fn();

vi.mock("../../gateway/call.js", () => ({
  callGateway: (opts: unknown) => callGatewayMock(opts),
}));

vi.mock("../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: vi.fn(),
}));

const resolveContextEngineMock = vi.fn();
vi.mock("../../context-engine/registry.js", () => ({
  resolveContextEngine: (...args: unknown[]) => resolveContextEngineMock(...args),
}));

vi.mock("../../plugins/lcm/expansion-auth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../plugins/lcm/expansion-auth.js")>();
  return {
    ...actual,
    createDelegatedExpansionGrant: (...args: unknown[]) => createGrantMock(...args),
    revokeDelegatedExpansionGrantForSession: (...args: unknown[]) => revokeGrantMock(...args),
  };
});

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
    resolveContextEngineMock.mockReset();
    createGrantMock.mockReset();
    revokeGrantMock.mockReset();

    createGrantMock.mockReturnValue({ grantId: "grant-1" });
    revokeGrantMock.mockReturnValue(true);
  });

  it("returns a focused delegated answer for explicit summaryIds", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });
    resolveContextEngineMock.mockResolvedValue(makeEngine({ retrieval }));

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
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

    expect(createGrantMock).toHaveBeenCalledWith(
      expect.objectContaining({
        issuerSessionId: "agent:main:main",
        allowedConversationIds: [42],
      }),
    );

    const agentCall = callGatewayMock.mock.calls
      .map(([opts]) => opts as { method?: string; params?: Record<string, unknown> })
      .find((entry) => entry.method === "agent");
    expect(agentCall?.params?.message).toContain("lcm_expand");

    const delegatedSessionKey = (
      createGrantMock.mock.calls[0][0] as { delegatedSessionKey: string }
    ).delegatedSessionKey;
    expect(revokeGrantMock).toHaveBeenCalledWith(delegatedSessionKey, {
      removeBinding: true,
    });
  });

  it("returns a validation error when prompt is missing", async () => {
    const retrieval = makeRetrieval();
    resolveContextEngineMock.mockResolvedValue(makeEngine({ retrieval }));

    const tool = createLcmExpandQueryTool({
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
    expect(createGrantMock).not.toHaveBeenCalled();
  });

  it("returns timeout when delegated run exceeds 120 seconds", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });
    resolveContextEngineMock.mockResolvedValue(makeEngine({ retrieval }));

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
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

    const delegatedSessionKey = (
      createGrantMock.mock.calls[0][0] as { delegatedSessionKey: string }
    ).delegatedSessionKey;
    expect(revokeGrantMock).toHaveBeenCalledWith(delegatedSessionKey, {
      removeBinding: true,
    });
  });

  it("cleans up delegated session and grant when agent call fails", async () => {
    const retrieval = makeRetrieval();
    retrieval.describe.mockResolvedValue({
      type: "summary",
      summary: { conversationId: 42 },
    });
    resolveContextEngineMock.mockResolvedValue(makeEngine({ retrieval }));

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        throw new Error("agent spawn failed");
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const tool = createLcmExpandQueryTool({
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

    const delegatedSessionKey = (
      createGrantMock.mock.calls[0][0] as { delegatedSessionKey: string }
    ).delegatedSessionKey;
    expect(revokeGrantMock).toHaveBeenCalledWith(delegatedSessionKey, {
      removeBinding: true,
    });
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
    resolveContextEngineMock.mockResolvedValue(makeEngine({ retrieval, conversationId: 7 }));

    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string };
      if (request.method === "agent") {
        return { runId: "run-query" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "chat.history") {
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
      sessionId: "agent:main:main",
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
});
