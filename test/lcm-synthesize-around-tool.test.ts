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
import { registerPrompt } from "../src/synthesis/prompt-registry.js";
import { createLcmSynthesizeAroundTool } from "../src/tools/lcm-synthesize-around-tool.js";
import type { LcmDependencies } from "../src/types.js";

// Mock the summarize module so the tool gets a deterministic LLM call without
// needing real provider credentials. Each prompt becomes a deterministic mock
// summary so we can assert the dispatch pipeline ran end-to-end.
vi.mock("../src/summarize.js", async () => {
  const actual = await vi.importActual<typeof import("../src/summarize.js")>("../src/summarize.js");
  return {
    ...actual,
    createLcmSummarizeFromLegacyParams: vi.fn(async () => ({
      fn: async (text: string, _aggressive?: boolean) => {
        // Pretend we summarized — the dispatch pipeline only cares that
        // some text comes back. Surface the source-text head so tests can
        // assert leaf concat reached the LLM.
        const head = text.split("\n").slice(0, 6).join(" | ");
        return `synthesized: ${head.slice(0, 200)}`;
      },
      model: "test-mock-model",
      breakerKey: "mock",
    })),
  };
});

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
      summaryProvider: "anthropic",
      summaryModel: "claude-haiku-4-5",
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
    resolveModel: () => ({ provider: "anthropic", model: "claude-haiku-4-5" }),
    getApiKey: async () => "fake-key",
    requireApiKey: async () => "fake-key",
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

function setupDb(opts: { withVec0?: boolean } = {}): DatabaseSync {
  const db = opts.withVec0
    ? new DatabaseSync(":memory:", { allowExtension: true })
    : new DatabaseSync(":memory:");
  if (opts.withVec0) {
    tryLoadSqliteVec(db, { path: VEC0_PATH });
  }
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', 'sk2')`).run();
  if (opts.withVec0) {
    registerEmbeddingProfile(db, "voyage-4-large", 3);
    ensureEmbeddingsTable(db, "voyage-4-large", 3);
  }
  return db;
}

function insertLeaf(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  content: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count,
                            session_key, created_at)
     VALUES (?, ?, 'leaf', ?, ?, (SELECT session_key FROM conversations WHERE conversation_id = ?), ?)`,
  ).run(summaryId, conversationId, content, Math.max(1, Math.ceil(content.length / 4)), conversationId, createdAt);
}

function insertCondensed(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  content: string,
  createdAt: string,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count,
                            session_key, created_at)
     VALUES (?, ?, 'condensed', ?, ?, (SELECT session_key FROM conversations WHERE conversation_id = ?), ?)`,
  ).run(summaryId, conversationId, content, Math.max(1, Math.ceil(content.length / 4)), conversationId, createdAt);
}

function insertLeafWithEmbedding(
  db: DatabaseSync,
  summaryId: string,
  conversationId: number,
  vector: [number, number, number],
  content: string,
  createdAt = "2026-05-01 00:00:00",
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count,
                            session_key, created_at)
     VALUES (?, ?, 'leaf', ?, ?, (SELECT session_key FROM conversations WHERE conversation_id = ?), ?)`,
  ).run(summaryId, conversationId, content, Math.max(1, Math.ceil(content.length / 4)), conversationId, createdAt);
  recordEmbedding(db, {
    modelName: "voyage-4-large",
    embeddedId: summaryId,
    embeddedKind: "summary",
    vector,
    sourceTokenCount: 1,
  });
}

function buildLcmEngine(params: {
  db: DatabaseSync;
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
          : { conversationId: params.conversationId, sessionId: "session-1" },
      ),
      getConversationBySessionKey: vi.fn(async () =>
        params.conversationIdBySessionKey == null
          ? null
          : {
              conversationId: params.conversationIdBySessionKey,
              sessionId: "session-1",
              sessionKey: "sk1",
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

describe("createLcmSynthesizeAroundTool — input validation", () => {
  it("rejects empty target", async () => {
    const db = setupDb();
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c1", { target: "  ", window_kind: "time" });
    expect((r.details as { error?: string }).error).toContain("`target` is required");
    db.close();
  });

  it("rejects bad window_kind", async () => {
    const db = setupDb();
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c2", { target: "anything", window_kind: "bogus" });
    expect((r.details as { error?: string }).error).toContain("window_kind");
    db.close();
  });

  it("rejects since >= before", async () => {
    const db = setupDb();
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c3", {
      target: "sum_x",
      window_kind: "time",
      since: "2026-05-01T00:00:00.000Z",
      before: "2026-04-01T00:00:00.000Z",
    });
    expect((r.details as { error?: string }).error).toContain("`since` must be earlier");
    db.close();
  });

  it("requires conversation scope (no scope + no allConversations)", async () => {
    const db = setupDb();
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db }) as never,
    });
    const r = await tool.execute("c4", { target: "anything", window_kind: "semantic" });
    expect((r.details as { error?: string }).error).toContain(
      "No LCM conversation found for this session",
    );
    db.close();
  });

  it("rejects free-text target in time mode", async () => {
    const db = setupDb();
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c5", { target: "free text", window_kind: "time" });
    expect((r.details as { error?: string }).error).toMatch(/time window requires a summary_id/);
    db.close();
  });

  it("returns target-not-found when summary id missing", async () => {
    const db = setupDb();
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c6", { target: "sum_does_not_exist", window_kind: "time" });
    expect((r.details as { error?: string }).error).toMatch(/Target summary not found/);
    db.close();
  });
});

describe("createLcmSynthesizeAroundTool — missing prompt error", () => {
  it("surfaces missing_prompt up-front (before any LLM call)", async () => {
    const db = setupDb();
    insertCondensed(db, "sum_anchor", 1, "anchor body", "2026-05-01 12:00:00");
    insertLeaf(db, "sum_a", 1, "leaf one body", "2026-05-01 11:30:00");
    insertLeaf(db, "sum_b", 1, "leaf two body", "2026-05-01 12:30:00");
    // NO prompt registered — tool should fail fast.

    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c7", {
      target: "sum_anchor",
      window_kind: "time",
      windowHours: 6,
    });
    const error = (r.details as { error?: string }).error ?? "";
    expect(error).toMatch(/missing_prompt/);
    expect(error).toMatch(/episodic-condensed/);
    expect(error).toMatch(/custom/);
    db.close();
  });
});

describe("createLcmSynthesizeAroundTool — time window happy path", () => {
  it("selects leaves within ±windowHours, calls dispatch, persists cache row", async () => {
    const db = setupDb();
    // Anchor at noon — leaves at 09:00, 11:30, 12:30, 18:00, and far away 4 days later.
    insertCondensed(db, "sum_anchor", 1, "anchor summary", "2026-05-01 12:00:00");
    insertLeaf(db, "sum_in_a", 1, "AAA-content", "2026-05-01 09:00:00");
    insertLeaf(db, "sum_in_b", 1, "BBB-content", "2026-05-01 11:30:00");
    insertLeaf(db, "sum_in_c", 1, "CCC-content", "2026-05-01 12:30:00");
    insertLeaf(db, "sum_in_d", 1, "DDD-content", "2026-05-01 18:00:00");
    insertLeaf(db, "sum_far", 1, "FAR-content", "2026-05-05 12:00:00");

    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "custom",
      passKind: "single",
      template: "Compact: {{source_text}}",
    });

    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c-time-happy", {
      target: "sum_anchor",
      window_kind: "time",
      windowHours: 12, // ±12h covers all in-day leaves but not the far one
    });
    const details = r.details as { error?: string; cache_id?: string; leaf_count?: number };
    expect(details.error).toBeUndefined();
    expect(details.leaf_count).toBe(4);
    expect(details.cache_id).toMatch(/^cache_around_/);

    // Cache row exists and is ready
    const cache = db
      .prepare(`SELECT cache_id, status, content, source_leaf_ids, tier_label FROM lcm_synthesis_cache WHERE cache_id = ?`)
      .get(details.cache_id) as {
      status: string;
      content: string | null;
      source_leaf_ids: string;
      tier_label: string;
    };
    expect(cache.status).toBe("ready");
    expect(cache.tier_label).toBe("custom");
    expect(cache.content ?? "").toContain("synthesized:");
    const ids = JSON.parse(cache.source_leaf_ids) as string[];
    expect(ids).toEqual(["sum_in_a", "sum_in_b", "sum_in_c", "sum_in_d"]);

    // Audit row written by dispatch
    const audit = db
      .prepare(`SELECT pass_kind, status, target_cache_id FROM lcm_synthesis_audit`)
      .all() as Array<{ pass_kind: string; status: string; target_cache_id: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]!.pass_kind).toBe("single");
    expect(audit[0]!.status).toBe("completed");
    expect(audit[0]!.target_cache_id).toBe(details.cache_id);

    // The markdown surface contains the synthesized output and structural headers
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("## LCM Synthesize-Around");
    expect(text).toContain("**Mode:** time");
    expect(text).toContain(`**Cache id:** \`${details.cache_id}\``);
    expect(text).toContain("synthesized:");

    db.close();
  });

  it("excludes the target summary itself from the source set", async () => {
    const db = setupDb();
    insertLeaf(db, "sum_target", 1, "TARGET-CONTENT", "2026-05-01 12:00:00");
    insertLeaf(db, "sum_other", 1, "OTHER-CONTENT", "2026-05-01 12:30:00");
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "custom",
      passKind: "single",
      template: "x",
    });

    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c-exclude-target", {
      target: "sum_target",
      window_kind: "time",
      windowHours: 6,
    });
    const details = r.details as { leaf_count: number; cache_id: string };
    expect(details.leaf_count).toBe(1);
    const cache = db.prepare(`SELECT source_leaf_ids FROM lcm_synthesis_cache WHERE cache_id = ?`).get(details.cache_id) as { source_leaf_ids: string };
    expect(JSON.parse(cache.source_leaf_ids)).toEqual(["sum_other"]);
    db.close();
  });

  it("returns helpful error when window picks no leaves", async () => {
    const db = setupDb();
    insertCondensed(db, "sum_anchor", 1, "anchor", "2026-05-01 12:00:00");
    // No surrounding leaves
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "custom",
      passKind: "single",
      template: "x",
    });
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c-empty", {
      target: "sum_anchor",
      window_kind: "time",
      windowHours: 1,
    });
    const error = (r.details as { error?: string }).error ?? "";
    expect(error).toMatch(/Window selected zero leaves/);
    db.close();
  });

  it("respects since/before bounds when narrower than the window", async () => {
    const db = setupDb();
    insertCondensed(db, "sum_anchor", 1, "anchor", "2026-05-01 12:00:00");
    insertLeaf(db, "sum_early", 1, "early", "2026-05-01 09:00:00");
    insertLeaf(db, "sum_late", 1, "late", "2026-05-01 18:00:00");
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "custom",
      passKind: "single",
      template: "x",
    });
    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    // ±12h would cover both, but `since` clamps to noon, dropping the early one
    const r = await tool.execute("c-since", {
      target: "sum_anchor",
      window_kind: "time",
      windowHours: 12,
      since: "2026-05-01T12:00:00.000Z",
    });
    const details = r.details as { leaf_count: number; cache_id: string };
    expect(details.leaf_count).toBe(1);
    const cache = db
      .prepare(`SELECT source_leaf_ids FROM lcm_synthesis_cache WHERE cache_id = ?`)
      .get(details.cache_id) as { source_leaf_ids: string };
    expect(JSON.parse(cache.source_leaf_ids)).toEqual(["sum_late"]);
    db.close();
  });
});

describe("createLcmSynthesizeAroundTool — vec0 graceful degradation", () => {
  it("semantic mode returns vec0-unavailable error when sqlite-vec absent", async () => {
    const db = setupDb(); // no allowExtension → vec0 unloadable
    insertLeaf(db, "sum_x", 1, "any leaf", "2026-05-01 12:00:00");
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "custom",
      passKind: "single",
      template: "x",
    });

    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c-no-vec0", {
      target: "anything",
      window_kind: "semantic",
    });
    const error = (r.details as { error?: string }).error ?? "";
    expect(error).toMatch(/Semantic search is unavailable/);
    db.close();
  });
});

describe.skipIf(!VEC0_AVAILABLE)("createLcmSynthesizeAroundTool — semantic happy path (vec0)", () => {
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

  it("semantic mode (free-text query): top-K leaves are selected, dispatched, cached", async () => {
    process.env.VOYAGE_API_KEY = "test-key";
    const db = setupDb({ withVec0: true });
    insertLeafWithEmbedding(db, "leaf_close", 1, [0.1, 0.2, 0.3], "alpha-close-content", "2026-05-01 09:00:00");
    insertLeafWithEmbedding(db, "leaf_mid", 1, [0.5, 0.5, 0.5], "mid-content", "2026-05-01 10:00:00");
    insertLeafWithEmbedding(db, "leaf_far", 1, [0.9, 0.9, 0.9], "far-content", "2026-05-01 11:00:00");
    registerPrompt(db, {
      memoryType: "episodic-condensed",
      tierLabel: "custom",
      passKind: "single",
      template: "Synthesize: {{source_text}}",
    });

    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          usage: { total_tokens: 3 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;

    const tool = createLcmSynthesizeAroundTool({
      deps: makeDeps(),
      lcm: buildLcmEngine({ db, conversationId: 1 }) as never,
      sessionId: "session-1",
    });
    const r = await tool.execute("c-sem", {
      target: "alpha",
      window_kind: "semantic",
      windowK: 2,
    });
    const details = r.details as {
      error?: string;
      leaf_count: number;
      cache_id: string;
      mode: string;
      embedding_model: string | null;
    };
    expect(details.error).toBeUndefined();
    expect(details.mode).toBe("semantic");
    expect(details.leaf_count).toBe(2);
    expect(details.embedding_model).toBe("voyage-4-large");

    // Cache row holds the synthesized output
    const cache = db
      .prepare(`SELECT content, status, source_leaf_ids FROM lcm_synthesis_cache WHERE cache_id = ?`)
      .get(details.cache_id) as { content: string | null; status: string; source_leaf_ids: string };
    expect(cache.status).toBe("ready");
    expect(cache.content ?? "").toContain("synthesized:");
    const ids = JSON.parse(cache.source_leaf_ids) as string[];
    // The closest two should be selected (leaf_close + leaf_mid).
    expect(ids).toContain("leaf_close");
    expect(ids).toContain("leaf_mid");
    expect(ids).not.toContain("leaf_far");

    db.close();
  });
});
