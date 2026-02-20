import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
} from "../src/expansion-auth.js";
import { createLcmDescribeTool } from "../src/tools/lcm-describe-tool.js";
import { createLcmExpandTool } from "../src/tools/lcm-expand-tool.js";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import type { LcmDependencies } from "../src/types.js";

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
      autocompactDisabled: false,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
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

function buildLcmEngine(params: {
  retrieval: {
    grep: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
    describe: ReturnType<typeof vi.fn>;
  };
  conversationId?: number;
}) {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    getRetrieval: () => params.retrieval,
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn(async () =>
        params.conversationId == null
          ? null
          : {
              conversationId: params.conversationId,
              sessionId: "session-1",
              title: null,
              bootstrappedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
      ),
    }),
  };
}

describe("LCM tools session scoping", () => {
  beforeEach(() => {
    resetDelegatedExpansionGrantsForTests();
  });

  it("lcm_expand query mode infers conversationId from delegated grant", async () => {
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [],
        summaries: [
          {
            summaryId: "sum_recent",
            conversationId: 42,
            kind: "leaf",
            snippet: "recent snippet",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
          },
        ],
        totalMatches: 1,
      })),
      expand: vi.fn(async () => ({
        children: [],
        messages: [],
        estimatedTokens: 5,
        truncated: false,
      })),
      describe: vi.fn(),
    };

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:session-1",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      tokenCap: 120,
    });

    const tool = createLcmExpandTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ retrieval }) as never,
      sessionId: "agent:main:subagent:session-1",
    });
    const result = await tool.execute("call-1", { query: "recent snippet" });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 42, query: "recent snippet" }),
    );
    expect((result.details as { expansionCount?: number }).expansionCount).toBe(1);
  });

  it("lcm_grep forwards since/before and includes ISO timestamps in text output", async () => {
    const createdAt = new Date("2026-01-03T00:00:00.000Z");
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [
          {
            messageId: 101,
            conversationId: 42,
            role: "assistant",
            snippet: "deployment timeline",
            createdAt,
            rank: 0,
          },
        ],
        summaries: [],
        totalMatches: 1,
      })),
      expand: vi.fn(),
      describe: vi.fn(),
    };

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ retrieval, conversationId: 42 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-2", {
      pattern: "deployment",
      since: "2026-01-01T00:00:00.000Z",
      before: "2026-01-04T00:00:00.000Z",
    });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 42,
        since: expect.any(Date),
        before: expect.any(Date),
      }),
    );
    expect((result.content[0] as { text: string }).text).toContain(createdAt.toISOString());
  });

  it("lcm_describe blocks cross-conversation lookup unless allConversations=true", async () => {
    const retrieval = {
      grep: vi.fn(),
      expand: vi.fn(),
      describe: vi.fn(async () => ({
        id: "sum_foreign",
        type: "summary",
        summary: {
          conversationId: 99,
          kind: "leaf",
          content: "foreign summary",
          tokenCount: 12,
          fileIds: [],
          parentIds: [],
          childIds: [],
          messageIds: [],
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      })),
    };

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ retrieval, conversationId: 42 }) as never,
      sessionId: "session-1",
    });
    const scoped = await tool.execute("call-3", { id: "sum_foreign" });
    expect((scoped.details as { error?: string }).error).toContain("Not found in conversation 42");

    const cross = await tool.execute("call-4", {
      id: "sum_foreign",
      allConversations: true,
    });
    expect((cross.content[0] as { text: string }).text).toContain("**Conversation:** 99");
  });
});
