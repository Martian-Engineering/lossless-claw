import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
} from "../src/expansion-auth.js";
import { formatTimestamp } from "../src/compaction.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { createLcmDescribeTool } from "../src/tools/lcm-describe-tool.js";
import { createLcmExpandTool } from "../src/tools/lcm-expand-tool.js";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import { createLcmRecallKeysTool } from "../src/tools/lcm-recall-keys-tool.js";
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
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      proactiveThresholdCompactionMode: "deferred",
      autoRotateSessionFiles: {
        enabled: true,
        createBackups: false,
        sizeBytes: 2 * 1024 * 1024,
        startup: "rotate",
        runtime: "rotate",
      },
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
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

function createTestDb(): { db: DatabaseSync; conversationStore: ConversationStore } {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
  };
}

function buildLcmEngine(params: {
  retrieval: {
    grep: ReturnType<typeof vi.fn>;
    expand: ReturnType<typeof vi.fn>;
    describe: ReturnType<typeof vi.fn>;
  };
  conversationId?: number;
  conversationIdBySessionKey?: number;
  conversationFamilyIds?: number[];
  timezone?: string;
}) {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    timezone: params.timezone ?? "UTC",
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
      getConversationBySessionKey: vi.fn(async () =>
        params.conversationIdBySessionKey == null
          ? null
          : {
              conversationId: params.conversationIdBySessionKey,
              sessionId: "legacy-session",
              sessionKey: "agent:main:main",
              title: null,
              bootstrappedAt: null,
              createdAt: new Date("2026-01-01T00:00:00.000Z"),
              updatedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
      ),
      getConversationFamilyIds: vi.fn(async () => {
        if (params.conversationFamilyIds && params.conversationFamilyIds.length > 0) {
          return params.conversationFamilyIds;
        }
        if (typeof params.conversationIdBySessionKey === "number") {
          return [params.conversationIdBySessionKey];
        }
        if (typeof params.conversationId === "number") {
          return [params.conversationId];
        }
        return [];
      }),
    }),
  };
}

describe("LCM tools session scoping", () => {
  beforeEach(() => {
    resetDelegatedExpansionGrantsForTests();
  });

  it("lcm_grep metadata explains focused FTS5 query construction", () => {
    const tool = createLcmGrepTool({
      deps: makeDeps(),
    });

    expect(tool.description).toContain("queries use FTS5 AND semantics by default");
    const patternDescription = (
      tool.parameters as {
        properties: Record<string, { description?: string }>;
      }
    ).properties.pattern?.description;
    expect(patternDescription).toContain("FTS5 defaults to AND matching");
    expect(patternDescription).toContain("prefer 1-3 distinctive terms or one quoted multi-word phrase");
    expect(patternDescription).toContain("Regex syntax such as alternation (`A|B`) requires regex mode");
  });

  it("lcm_grep rejects regex alternation in full-text mode before searching", async () => {
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })),
      expand: vi.fn(),
      describe: vi.fn(),
    };

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ retrieval, conversationId: 42 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-regex-syntax", {
      pattern: "apple|banana|cherry",
      mode: "full_text",
    });

    expect(retrieval.grep).not.toHaveBeenCalled();
    expect((result.details as { error?: string }).error).toContain(
      "full_text mode does not support regex syntax",
    );
    expect((result.details as { error?: string }).error).toContain('mode: "regex"');
  });

  it("lcm_grep still forwards regex alternation in regex mode", async () => {
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [
          {
            messageId: 101,
            conversationId: 42,
            role: "assistant",
            snippet: "apple",
            createdAt: new Date("2026-01-02T00:00:00.000Z"),
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
    const result = await tool.execute("call-regex-mode", {
      pattern: "apple|banana|cherry",
      mode: "regex",
    });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "apple|banana|cherry",
        mode: "regex",
      }),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("apple");
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

  it("lcm_grep forwards since/before and uses the configured timezone in text output", async () => {
    const createdAt = new Date("2026-01-03T00:00:00.000Z");
    const timezone = "America/Los_Angeles";
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
      lcm: buildLcmEngine({ retrieval, conversationId: 42, timezone }) as never,
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
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(formatTimestamp(createdAt, timezone));
    expect(text).toContain(formatTimestamp(new Date("2026-01-01T00:00:00.000Z"), timezone));
    expect(text).toContain(formatTimestamp(new Date("2026-01-04T00:00:00.000Z"), timezone));
    expect(text).toContain("deployment timeline");
  });

  it("lcm_grep forwards full-text sort mode and reports it in output", async () => {
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })),
      expand: vi.fn(),
      describe: vi.fn(),
    };

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ retrieval, conversationId: 42 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-sort", {
      pattern: '"error handling" retries',
      mode: "full_text",
      sort: "relevance",
    });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 42,
        mode: "full_text",
        sort: "relevance",
      }),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("**Mode:** full_text | **Scope:** both | **Sort:** relevance");
  });

  it("lcm_grep resolves conversation scope via sessionKey continuity before sessionId lookup", async () => {
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })),
      expand: vi.fn(),
      describe: vi.fn(),
    };

    const tool = createLcmGrepTool({
      deps: makeDeps({
        resolveSessionIdFromSessionKey: vi.fn(async () => "uuid-after-reset"),
      }),
      lcm: buildLcmEngine({ retrieval, conversationIdBySessionKey: 42 }) as never,
      sessionKey: "agent:main:main",
    });
    await tool.execute("call-2b", { pattern: "deployment" });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 42,
        conversationIds: [42],
      }),
    );
  });

  it("lcm_grep searches across a resolved session family", async () => {
    const retrieval = {
      grep: vi.fn(async () => ({
        messages: [],
        summaries: [],
        totalMatches: 0,
      })),
      expand: vi.fn(),
      describe: vi.fn(),
    };

    const tool = createLcmGrepTool({
      deps: makeDeps({
        resolveSessionIdFromSessionKey: vi.fn(async () => "uuid-after-reset"),
      }),
      lcm: buildLcmEngine({
        retrieval,
        conversationIdBySessionKey: 42,
        conversationFamilyIds: [42, 21, 7],
      }) as never,
      sessionKey: "agent:main:main",
    });
    const result = await tool.execute("call-family", { pattern: "deployment" });

    expect(retrieval.grep).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 42,
        conversationIds: [42, 21, 7],
      }),
    );
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("session family rooted at 42 (3 segments)");
  });

  it("lcm_recall_keys returns exact-key raw evidence with source message IDs", async () => {
    const createdAt = new Date("2026-01-04T00:00:00.000Z");
    const searchMessages = vi.fn(async () => [
      {
        messageId: 101,
        conversationId: 42,
        role: "user",
        snippet: "CRABPOT_LCM_FACT",
        createdAt,
        rank: 0,
      },
    ]);
    const getMessageById = vi.fn(async () => ({
      messageId: 101,
      conversationId: 42,
      seq: 7,
      role: "user",
      content: "Remember blue-lantern-42 as CRABPOT_LCM_FACT.",
      tokenCount: 8,
      createdAt,
      largeContent: null,
    }));
    const tool = createLcmRecallKeysTool({
      deps: makeDeps(),
      lcm: {
        getConversationStore: () => ({
          getConversationBySessionKey: vi.fn(async () => ({
            conversationId: 42,
            sessionId: "legacy-session",
            sessionKey: "agent:main:main",
            active: true,
            archivedAt: null,
            title: null,
            bootstrappedAt: null,
            createdAt,
            updatedAt: createdAt,
          })),
          getConversationFamilyIds: vi.fn(async () => [42, 21]),
          searchMessages,
          getMessageById,
        }),
      } as never,
      sessionKey: "agent:main:main",
    });

    const result = await tool.execute("call-recall-key", {
      keys: ["CRABPOT_LCM_FACT"],
    });

    expect(searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 42,
        conversationIds: [42, 21],
        mode: "regex",
        query: expect.stringContaining("CRABPOT_LCM_FACT"),
      }),
    );
    expect(result.details).toMatchObject({
      keys: ["CRABPOT_LCM_FACT"],
      matchCount: 1,
      matches: [
        {
          key: "CRABPOT_LCM_FACT",
          messageId: 101,
          conversationId: 42,
          role: "user",
          createdAt: createdAt.toISOString(),
          snippet: "Remember blue-lantern-42 as CRABPOT_LCM_FACT.",
        },
      ],
    });
  });

  it("lcm_recall_keys rejects secret-shaped keys and sensitive snippets", async () => {
    const createdAt = new Date("2026-01-05T00:00:00.000Z");
    const stripeLikeSecret = ["sk", "live", "1234567890abcdefghijklmnopqrstuvwxyz"].join("_");
    const searchMessages = vi.fn(async () => [
      {
        messageId: 201,
        conversationId: 42,
        role: "user",
        snippet: "PROJECT_ID",
        createdAt,
        rank: 0,
      },
    ]);
    const getMessageById = vi.fn(async () => ({
      messageId: 201,
      conversationId: 42,
      seq: 3,
      role: "user",
      content: `PROJECT_ID is launch-alpha; Stripe value ${stripeLikeSecret}.`,
      tokenCount: 8,
      createdAt,
      largeContent: null,
    }));
    const tool = createLcmRecallKeysTool({
      deps: makeDeps(),
      lcm: {
        getConversationStore: () => ({
          getConversationBySessionId: vi.fn(async () => ({
            conversationId: 42,
            sessionId: "session-1",
            sessionKey: null,
            active: true,
            archivedAt: null,
            title: null,
            bootstrappedAt: null,
            createdAt,
            updatedAt: createdAt,
          })),
          getConversationFamilyIds: vi.fn(async () => [42]),
          searchMessages,
          getMessageById,
        }),
      } as never,
      sessionId: "session-1",
    });

    const result = await tool.execute("call-sensitive-recall", {
      keys: ["API_KEY", "PROJECT_ID"],
    });

    expect(searchMessages).toHaveBeenCalledTimes(1);
    expect(searchMessages).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.stringContaining("PROJECT_ID") }),
    );
    expect(result.details).toMatchObject({
      keys: ["PROJECT_ID"],
      skippedKeys: [{ key: "API_KEY", reason: "sensitive_identifier" }],
      matches: [],
      matchCount: 0,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).not.toContain(stripeLikeSecret);
  });

  it("lcm_recall_keys allows ordinary key wording in safe snippets", async () => {
    const createdAt = new Date("2026-01-05T01:00:00.000Z");
    const tool = createLcmRecallKeysTool({
      deps: makeDeps(),
      lcm: {
        getConversationStore: () => ({
          getConversationBySessionId: vi.fn(async () => ({
            conversationId: 42,
            sessionId: "session-1",
            sessionKey: null,
            active: true,
            archivedAt: null,
            title: null,
            bootstrappedAt: null,
            createdAt,
            updatedAt: createdAt,
          })),
          getConversationFamilyIds: vi.fn(async () => [42]),
          searchMessages: vi.fn(async () => [
            {
              messageId: 251,
              conversationId: 42,
              role: "user",
              snippet: "CRABPOT_LCM_FACT",
              createdAt,
              rank: 0,
            },
          ]),
          getMessageById: vi.fn(async () => ({
            messageId: 251,
            conversationId: 42,
            seq: 4,
            role: "user",
            content: "The key CRABPOT_LCM_FACT is blue-lantern-42.",
            tokenCount: 8,
            createdAt,
            largeContent: null,
          })),
        }),
      } as never,
      sessionId: "session-1",
    });

    const result = await tool.execute("call-key-wording-recall", {
      keys: ["CRABPOT_LCM_FACT"],
    });

    expect(result.details).toMatchObject({
      keys: ["CRABPOT_LCM_FACT"],
      matchCount: 1,
      matches: [
        {
          key: "CRABPOT_LCM_FACT",
          snippet: "The key CRABPOT_LCM_FACT is blue-lantern-42.",
        },
      ],
    });
  });

  it("lcm_recall_keys scans past recent ineligible candidates with the real store", async () => {
    const { db, conversationStore } = createTestDb();
    try {
      const conversation = await conversationStore.createConversation({
        sessionId: "session-1",
        sessionKey: "agent:main:main",
      });
      const [validMessage] = await conversationStore.createMessagesBulk([
        {
          conversationId: conversation.conversationId,
          seq: 0,
          role: "user",
          content: "Remember blue-lantern-42 as CRABPOT_LCM_FACT.",
          tokenCount: 8,
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          conversationId: conversation.conversationId,
          seq: index + 1,
          role: "tool" as const,
          content: `Tool echo ${index}: CRABPOT_LCM_FACT should not be returned.`,
          tokenCount: 9,
        })),
      ]);
      db.prepare(
        `UPDATE messages
         SET created_at = datetime('2026-01-01 00:00:00', printf('+%d seconds', seq))
         WHERE conversation_id = ?`,
      ).run(conversation.conversationId);

      const tool = createLcmRecallKeysTool({
        deps: makeDeps(),
        lcm: {
          getConversationStore: () => conversationStore,
        } as never,
        sessionKey: "agent:main:main",
      });

      const result = await tool.execute("call-real-store-starvation", {
        keys: ["CRABPOT_LCM_FACT"],
      });

      expect(result.details).toMatchObject({
        keys: ["CRABPOT_LCM_FACT"],
        matchCount: 1,
        matches: [
          {
            key: "CRABPOT_LCM_FACT",
            messageId: validMessage?.messageId,
            role: "user",
            snippet: "Remember blue-lantern-42 as CRABPOT_LCM_FACT.",
          },
        ],
      });
    } finally {
      db.close();
    }
  });

  it("lcm_recall_keys does not accept substring matches as evidence", async () => {
    const createdAt = new Date("2026-01-06T00:00:00.000Z");
    const tool = createLcmRecallKeysTool({
      deps: makeDeps(),
      lcm: {
        getConversationStore: () => ({
          getConversationBySessionId: vi.fn(async () => ({
            conversationId: 42,
            sessionId: "session-1",
            sessionKey: null,
            active: true,
            archivedAt: null,
            title: null,
            bootstrappedAt: null,
            createdAt,
            updatedAt: createdAt,
          })),
          getConversationFamilyIds: vi.fn(async () => [42]),
          searchMessages: vi.fn(async () => [
            {
              messageId: 301,
              conversationId: 42,
              role: "user",
              snippet: "CRABPOT_LCM_FACT_BACKUP",
              createdAt,
              rank: 0,
            },
          ]),
          getMessageById: vi.fn(async () => ({
            messageId: 301,
            conversationId: 42,
            seq: 3,
            role: "user",
            content: "CRABPOT_LCM_FACT_BACKUP is red-lantern-99.",
            tokenCount: 7,
            createdAt,
            largeContent: null,
          })),
        }),
      } as never,
      sessionId: "session-1",
    });

    const result = await tool.execute("call-boundary-recall", {
      keys: ["CRABPOT_LCM_FACT"],
    });

    expect(result.details).toMatchObject({
      keys: ["CRABPOT_LCM_FACT"],
      matches: [],
      matchCount: 0,
    });
  });

  it("lcm_describe blocks cross-conversation lookup unless allConversations=true", async () => {
    const timezone = "America/Los_Angeles";
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
          depth: 0,
          tokenCount: 12,
          descendantCount: 0,
          descendantTokenCount: 0,
          sourceMessageTokenCount: 12,
          fileIds: [],
          parentIds: [],
          childIds: [],
          messageIds: [],
          earliestAt: new Date("2026-01-01T00:00:00.000Z"),
          latestAt: new Date("2026-01-01T00:00:00.000Z"),
          subtree: [
            {
              summaryId: "sum_foreign",
              parentSummaryId: null,
              depthFromRoot: 0,
              kind: "leaf",
              depth: 0,
              tokenCount: 12,
              descendantCount: 0,
              descendantTokenCount: 0,
              sourceMessageTokenCount: 12,
              earliestAt: new Date("2026-01-01T00:00:00.000Z"),
              latestAt: new Date("2026-01-01T00:00:00.000Z"),
              childCount: 0,
              path: "",
            },
          ],
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
        },
      })),
    };

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ retrieval, conversationId: 42, timezone }) as never,
      sessionId: "session-1",
    });
    const scoped = await tool.execute("call-3", { id: "sum_foreign" });
    expect((scoped.details as { error?: string }).error).toContain("Not found in this session scope");

    const cross = await tool.execute("call-4", {
      id: "sum_foreign",
      allConversations: true,
    });
    expect((cross.content[0] as { text: string }).text).toContain("meta conv=99");
    expect((cross.content[0] as { text: string }).text).toContain("manifest");
    expect((cross.content[0] as { text: string }).text).toContain(
      formatTimestamp(new Date("2026-01-01T00:00:00.000Z"), timezone),
    );
    expect(cross.details).toMatchObject({
      id: "sum_foreign",
      type: "summary",
      summary: {
        conversationId: 99,
        tokenCount: 12,
      },
      manifest: {
        tokenCap: 120,
      },
    });
    expect(JSON.stringify(cross.details)).not.toContain("foreign summary");
    expect(JSON.stringify(cross.details)).not.toContain("subtree");
  });
});
