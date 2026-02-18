import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
} from "../../plugins/lcm/expansion-auth.js";
import { createLcmDescribeTool } from "./lcm-describe-tool.js";
import { createLcmExpandTool } from "./lcm-expand-tool.js";
import { createLcmGrepTool } from "./lcm-grep-tool.js";

const mocks = vi.hoisted(() => ({
  ensureContextEnginesInitialized: vi.fn(),
  resolveContextEngine: vi.fn(),
}));

vi.mock("../../context-engine/init.js", () => ({
  ensureContextEnginesInitialized: mocks.ensureContextEnginesInitialized,
}));

vi.mock("../../context-engine/registry.js", () => ({
  resolveContextEngine: mocks.resolveContextEngine,
}));

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
    mocks.ensureContextEnginesInitialized.mockClear();
    mocks.resolveContextEngine.mockReset();
    resetDelegatedExpansionGrantsForTests();
  });

  it("lcm_expand query mode infers conversationId from session", async () => {
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
    mocks.resolveContextEngine.mockResolvedValue(
      buildLcmEngine({ retrieval, conversationId: 42 }) as never,
    );

    createDelegatedExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:session-1",
      issuerSessionId: "main",
      allowedConversationIds: [42],
      tokenCap: 120,
    });
    const tool = createLcmExpandTool({ sessionId: "agent:main:subagent:session-1" });
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
    mocks.resolveContextEngine.mockResolvedValue(
      buildLcmEngine({ retrieval, conversationId: 42 }) as never,
    );

    const tool = createLcmGrepTool({ sessionId: "session-1" });
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
    mocks.resolveContextEngine.mockResolvedValue(
      buildLcmEngine({ retrieval, conversationId: 42 }) as never,
    );

    const tool = createLcmDescribeTool({ sessionId: "session-1" });
    const scoped = await tool.execute("call-3", { id: "sum_foreign" });
    expect((scoped.details as { error?: string }).error).toContain("Not found in conversation 42");

    const cross = await tool.execute("call-4", {
      id: "sum_foreign",
      allConversations: true,
    });
    expect((cross.content[0] as { text: string }).text).toContain("**Conversation:** 99");
  });
});
