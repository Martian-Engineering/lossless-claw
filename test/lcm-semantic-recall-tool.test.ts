import { existsSync } from "node:fs";
import { arch, platform } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  ensureEmbeddingsTable,
  recordEmbedding,
  registerEmbeddingProfile,
  tryLoadSqliteVec,
} from "../src/embeddings/store.js";
import { createLcmSemanticRecallTool } from "../src/tools/lcm-semantic-recall-tool.js";
import type { LcmDependencies } from "../src/types.js";

const VEC0_PATH =
  process.env.LCM_TEST_VEC0_PATH?.trim() ||
  (() => {
    const realHome = process.env.REAL_HOME?.trim() || "/Users/lume";
    const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
    const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
    return `${realHome}/.openclaw/extensions/node_modules/${platformPkg}/vec0.${ext}`;
  })();
const VEC0_AVAILABLE = existsSync(VEC0_PATH);

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
        sizeBytes: 2 * 1024 * 1024,
        startup: "rotate",
        runtime: "rotate",
      },
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
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

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:", { allowExtension: true });
  tryLoadSqliteVec(db, { path: VEC0_PATH });
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', 'sk2')`).run();
  registerEmbeddingProfile(db, "voyage-4-large", 3);
  ensureEmbeddingsTable(db, "voyage-4-large", 3);
  return db;
}

function insertLeafWithEmbedding(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  vector: [number, number, number],
  content = "x",
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', ?, 1, (SELECT session_key FROM conversations WHERE conversation_id = ?))`,
  ).run(summaryId, conversationId, content, conversationId);
  recordEmbedding(db, {
    modelName: "voyage-4-large",
    embeddedId: summaryId,
    embeddedKind: "summary",
    vector,
    sourceTokenCount: 1,
  });
}

function buildLcmEngine(params: {
  db?: DatabaseSync;
  conversationId?: number;
  conversationIdBySessionKey?: number;
  conversationFamilyIds?: number[];
  timezone?: string;
}) {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    timezone: params.timezone ?? "UTC",
    getDb: () => params.db,
    getRetrieval: () => ({ grep: vi.fn(), expand: vi.fn(), describe: vi.fn() }),
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

describe("createLcmSemanticRecallTool — input validation", () => {
  it("rejects empty queries with a helpful error message", async () => {
    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-empty", { query: "  " });
    expect((result.details as { error?: string }).error).toContain("`query` is required");
  });

  it("rejects malformed since/before timestamps", async () => {
    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-bad-time", {
      query: "anything",
      since: "not-a-real-date",
    });
    expect((result.details as { error?: string }).error).toMatch(/since/i);
  });

  it("rejects since >= before", async () => {
    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-window", {
      query: "anything",
      since: "2026-05-01T00:00:00.000Z",
      before: "2026-04-01T00:00:00.000Z",
    });
    expect((result.details as { error?: string }).error).toContain("`since` must be earlier");
  });

  it("requires conversation scope (no scope + no allConversations)", async () => {
    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({}) as never,
    });
    const result = await tool.execute("call-no-scope", { query: "anything" });
    expect((result.details as { error?: string }).error).toContain(
      "No LCM conversation found for this session",
    );
  });

  it("describes purely-semantic vs hybrid trade-off in tool description", () => {
    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
    });
    expect(tool.description.toLowerCase()).toContain("semantic");
    expect(tool.description.toLowerCase()).toContain("hybrid");
  });
});

describe("createLcmSemanticRecallTool — vec0 / API graceful degradation", () => {
  it("returns a graceful error when vec0 / sqlite-vec is unavailable", async () => {
    const db = new DatabaseSync(":memory:"); // no allowExtension → vec0 unloadable
    runLcmMigrations(db, { fts5Available: false });
    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-no-vec0", { query: "anything" });
    const error = (result.details as { error?: string }).error ?? "";
    expect(error).toMatch(/lcm_grep instead/);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("createLcmSemanticRecallTool — vec0 paths", () => {
  let envBackup: string | undefined;
  let fetchBackup: typeof fetch | undefined;

  beforeEach(() => {
    envBackup = process.env.VOYAGE_API_KEY;
    fetchBackup = globalThis.fetch;
  });

  afterEach(() => {
    if (envBackup === undefined) {
      delete process.env.VOYAGE_API_KEY;
    } else {
      process.env.VOYAGE_API_KEY = envBackup;
    }
    globalThis.fetch = fetchBackup as typeof fetch;
  });

  it("returns a helpful error when VOYAGE_API_KEY is not set", async () => {
    delete process.env.VOYAGE_API_KEY;
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3], "alpha");
    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-no-key", { query: "alpha" });
    const error = (result.details as { error?: string }).error ?? "";
    expect(error).toMatch(/VOYAGE_API_KEY/);
    db.close();
  });

  it("happy path: returns ranked hits in markdown + structured details", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_close", 1, [0.1, 0.2, 0.3], "the alpha doc");
    insertLeafWithEmbedding(db, "leaf_far", 1, [0.9, 0.9, 0.9], "the omega doc");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 13 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-happy", { query: "alpha" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("## LCM Semantic Recall Results");
    expect(text).toContain("**Query:** `alpha`");
    expect(text).toContain("[leaf_close]");
    expect(text).toContain("the alpha doc");
    const details = result.details as { hitCount: number; hits: Array<{ summaryId: string }> };
    expect(details.hitCount).toBe(2);
    expect(details.hits[0].summaryId).toBe("leaf_close");
    db.close();
  });

  it("conversationId scope filter passes through to runSemanticSearch", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3], "alpha");
    insertLeafWithEmbedding(db, "leaf_b", 2, [0.1, 0.2, 0.3], "beta");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db }) as never,
    });
    const result = await tool.execute("call-scope", {
      query: "alpha",
      conversationId: 1,
    });
    const details = result.details as { hits: Array<{ summaryId: string; conversationId: number }> };
    expect(details.hits).toHaveLength(1);
    expect(details.hits[0].summaryId).toBe("leaf_a");
    expect(details.hits[0].conversationId).toBe(1);
    db.close();
  });

  it("since/before filters pass through and restrict results by created_at", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_old", 1, [0.1, 0.2, 0.3], "older");
    insertLeafWithEmbedding(db, "leaf_new", 1, [0.1, 0.2, 0.3], "newer");
    db.prepare(`UPDATE summaries SET created_at = '2026-01-01 00:00:00' WHERE summary_id = ?`).run("leaf_old");
    db.prepare(`UPDATE summaries SET created_at = '2026-05-01 00:00:00' WHERE summary_id = ?`).run("leaf_new");

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 5 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const tool = createLcmSemanticRecallTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-since", {
      query: "anything",
      since: "2026-04-01T00:00:00.000Z",
    });
    const details = result.details as { hits: Array<{ summaryId: string }> };
    expect(details.hits).toHaveLength(1);
    expect(details.hits[0].summaryId).toBe("leaf_new");
    db.close();
  });
});
