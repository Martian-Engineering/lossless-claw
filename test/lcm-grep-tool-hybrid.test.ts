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
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
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
  if (!trimmed.startsWith("agent:")) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
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
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    ...overrides,
  } as LcmDependencies;
}

function setupDb(opts: { vec0?: boolean; fts5?: boolean } = {}): DatabaseSync {
  const allowVec0 = opts.vec0 !== false;
  const db = new DatabaseSync(":memory:", { allowExtension: allowVec0 });
  if (allowVec0) tryLoadSqliteVec(db, { path: VEC0_PATH });
  runLcmMigrations(db, { fts5Available: opts.fts5 ?? false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  if (allowVec0) {
    registerEmbeddingProfile(db, "voyage-4-large", 3);
    ensureEmbeddingsTable(db, "voyage-4-large", 3);
  }
  return db;
}

function insertLeafWithEmbedding(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  vector: [number, number, number],
  content: string,
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

function insertLeafNoEmbedding(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  content: string,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', ?, 1, (SELECT session_key FROM conversations WHERE conversation_id = ?))`,
  ).run(summaryId, conversationId, content, conversationId);
}

/**
 * Build a minimal LCM engine stub backed by a real DB. Bypasses retrieval
 * (hybrid mode runs against db + summaryStore directly).
 */
function buildEngine(params: {
  db: DatabaseSync;
  conversationId?: number;
  conversationFamilyIds?: number[];
  timezone?: string;
}) {
  const summaryStoreSearch = vi.fn(async (input: {
    query: string;
    mode: "regex" | "full_text";
    conversationId?: number;
    conversationIds?: number[];
    since?: Date;
    before?: Date;
    limit: number;
  }) => {
    // Naive FTS over the in-memory db's summaries table. Matches when
    // content includes any whitespace-delimited token from the query.
    const q = input.query.toLowerCase().trim();
    const rows = params.db
      .prepare(`SELECT summary_id, conversation_id, kind, content, created_at FROM summaries`)
      .all() as Array<{
      summary_id: string;
      conversation_id: number;
      kind: "leaf" | "condensed";
      content: string;
      created_at: string;
    }>;
    const matches = rows
      .filter((r) => r.content.toLowerCase().includes(q))
      .filter((r) =>
        input.conversationId == null ? true : r.conversation_id === input.conversationId,
      )
      .map((r, idx) => ({
        summaryId: r.summary_id,
        conversationId: r.conversation_id,
        kind: r.kind,
        snippet: r.content.slice(0, 80),
        createdAt: new Date(r.created_at + "Z"),
        rank: idx,
      }));
    return matches.slice(0, input.limit ?? 50);
  });

  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    timezone: params.timezone ?? "UTC",
    getDb: () => params.db,
    getRetrieval: () => ({ grep: vi.fn(), expand: vi.fn(), describe: vi.fn() }),
    getSummaryStore: () => ({ searchSummaries: summaryStoreSearch }),
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
      getConversationBySessionKey: vi.fn(async () => null),
      getConversationFamilyIds: vi.fn(async () => {
        if (params.conversationFamilyIds && params.conversationFamilyIds.length > 0) {
          return params.conversationFamilyIds;
        }
        if (typeof params.conversationId === "number") return [params.conversationId];
        return [];
      }),
    }),
  };
}

describe("createLcmGrepTool — hybrid mode metadata", () => {
  it("schema enum exposes hybrid alongside regex/full_text", () => {
    const tool = createLcmGrepTool({ deps: makeDeps() });
    const params = tool.parameters as {
      properties: { mode?: { enum?: string[] } };
    };
    expect(params.properties.mode?.enum).toContain("hybrid");
    expect(params.properties.mode?.enum).toContain("regex");
    expect(params.properties.mode?.enum).toContain("full_text");
  });

  it("description mentions all 5 modes and the consolidated mode='semantic' path", () => {
    // Wave-12 consolidation SA: lcm_semantic_recall removed; folded
    // into `lcm_grep mode='semantic'`. Test now asserts the description
    // reflects the new arrangement (all 5 modes documented, semantic
    // surfaced as the pure-vector entry point).
    const tool = createLcmGrepTool({ deps: makeDeps() });
    const desc = tool.description.toLowerCase();
    expect(desc).toContain("hybrid");
    expect(desc).toContain("semantic");
    expect(desc).toContain("verbatim");
    expect(desc).toContain("regex");
    expect(desc).toContain("full_text");
    // No more cross-defer to a separate lcm_semantic_recall tool.
    expect(tool.description).not.toContain("lcm_semantic_recall");
  });
});

describe("createLcmGrepTool — hybrid mode degraded path", () => {
  let envBackup: string | undefined;
  let fetchBackup: typeof fetch | undefined;

  beforeEach(() => {
    envBackup = process.env.VOYAGE_API_KEY;
    fetchBackup = globalThis.fetch;
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = envBackup;
    globalThis.fetch = fetchBackup as typeof fetch;
  });

  it("emits 'semantic search unavailable; degraded to FTS-only' warning when vec0 missing", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const db = setupDb({ vec0: false });
    insertLeafNoEmbedding(db, "leaf_a", 1, "alpha doc about embeddings");

    // Rerank still gets called because FTS produced a candidate. Mock fetch
    // so rerank returns a sane score; embed should never be hit because
    // vec0 is missing and runSemanticSearch short-circuits.
    let embedHit = false;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (typeof url === "string" && url.includes("/rerank")) {
        const body = JSON.parse(init.body as string) as { documents: string[] };
        return new Response(
          JSON.stringify({
            data: body.documents.map((_d, idx) => ({
              index: idx,
              relevance_score: 0.5,
            })),
            model: "rerank-2.5",
            usage: { total_tokens: 5 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      embedHit = true;
      return new Response("embed should not be called when vec0 missing", { status: 500 });
    }) as typeof fetch;

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-degraded", {
      pattern: "alpha",
      mode: "hybrid",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("**Mode:** hybrid");
    expect(text).toContain("semantic search unavailable; degraded to FTS-only");
    expect(text).toContain("[from FTS only]");
    expect(embedHit).toBe(false);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("createLcmGrepTool — hybrid mode happy paths", () => {
  let envBackup: string | undefined;
  let fetchBackup: typeof fetch | undefined;

  beforeEach(() => {
    envBackup = process.env.VOYAGE_API_KEY;
    fetchBackup = globalThis.fetch;
  });

  afterEach(() => {
    if (envBackup === undefined) delete process.env.VOYAGE_API_KEY;
    else process.env.VOYAGE_API_KEY = envBackup;
    globalThis.fetch = fetchBackup as typeof fetch;
  });

  it("returns hybrid-format result with provenance flags + Mode line", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3], "the alpha doc");
    insertLeafWithEmbedding(db, "leaf_b", 1, [0.9, 0.9, 0.9], "the beta doc");

    // Mock fetch: 1) Voyage embed for query → vec [0.1,0.2,0.3]
    //            2) Voyage rerank → score by content lookup
    const rerankScores: Record<string, number> = {
      "the alpha doc": 0.95,
      "the beta doc": 0.30,
    };
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      if (typeof url === "string" && url.includes("/rerank")) {
        const body = JSON.parse(init.body as string) as { documents: string[] };
        return new Response(
          JSON.stringify({
            data: body.documents.map((doc, idx) => ({
              index: idx,
              relevance_score: rerankScores[doc] ?? 0.1,
            })),
            model: "rerank-2.5",
            usage: { total_tokens: 30 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      // embed
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-hybrid-happy", {
      pattern: "alpha",
      mode: "hybrid",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("## LCM Grep Results");
    expect(text).toContain("**Pattern:** `alpha`");
    expect(text).toContain("**Mode:** hybrid");
    expect(text).toContain("[leaf_a]");
    // leaf_a appears via both FTS (content matches) and semantic
    expect(text).toContain("[from FTS+semantic]");
    // leaf_b appears only via semantic (FTS won't match "alpha" in beta doc)
    expect(text).toContain("[from semantic only]");
    expect(text).not.toContain("semantic search unavailable");
    expect(text).not.toContain("rerank failed");

    const details = result.details as {
      mode: string;
      degradedToFtsOnly: boolean;
      degradedSkippedRerank: boolean;
      hits: Array<{ summaryId: string; fromFts: boolean; fromSemantic: boolean }>;
    };
    expect(details.mode).toBe("hybrid");
    expect(details.degradedToFtsOnly).toBe(false);
    expect(details.degradedSkippedRerank).toBe(false);
    expect(details.hits[0].summaryId).toBe("leaf_a");
    db.close();
  });

  it("emits 'rerank failed; using RRF fusion fallback' when rerank network errors", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const db = setupDb();
    insertLeafWithEmbedding(db, "leaf_a", 1, [0.1, 0.2, 0.3], "the alpha doc");

    let callIdx = 0;
    globalThis.fetch = (async (url: string) => {
      callIdx++;
      if (typeof url === "string" && url.includes("/rerank")) {
        return new Response("oops", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 7 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const tool = createLcmGrepTool({
      deps: makeDeps(),
      lcm: buildEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const result = await tool.execute("call-rrf", {
      pattern: "alpha",
      mode: "hybrid",
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("rerank failed; using RRF fusion fallback");
    expect(callIdx).toBeGreaterThan(0);
    db.close();
  });
});
