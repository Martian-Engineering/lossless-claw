import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmThemeExplainTool } from "../src/tools/lcm-theme-explain-tool.js";
import type { LcmDependencies } from "../src/types.js";

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
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

function insertSummary(db: DatabaseSync, summaryId: string, content = "x", convId = 1, sessionKey = "sk1"): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', ?, 1, ?)`,
  ).run(summaryId, convId, content, sessionKey);
}

function insertTheme(
  db: DatabaseSync,
  themeId: string,
  sessionKey: string,
  name: string,
  desc: string,
  sourceCount: number,
  status: "active" | "stale" | "archived" = "active",
  sourceIds: string[] = [],
): void {
  db.prepare(
    `INSERT INTO lcm_themes
       (theme_id, session_key, name, description, source_leaf_count,
        consolidation_model, consolidation_pass_id, status)
     VALUES (?, ?, ?, ?, ?, 'test-model', 'pass-test', ?)`,
  ).run(themeId, sessionKey, name, desc, sourceCount, status);
  for (const sid of sourceIds) {
    db.prepare(
      `INSERT INTO lcm_theme_sources (theme_id, summary_id) VALUES (?, ?)`,
    ).run(themeId, sid);
  }
}

function buildLcmEngine(db: DatabaseSync, timezone = "UTC") {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    timezone,
    getDb: () => db,
    getRetrieval: () => ({ grep: vi.fn(), expand: vi.fn(), describe: vi.fn() }),
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn(),
      getConversationBySessionKey: vi.fn(),
      getConversationFamilyIds: vi.fn(),
    }),
  };
}

describe("createLcmThemeExplainTool — happy path", () => {
  it("returns theme metadata + sources with snippets by default", async () => {
    const db = setupDb();
    insertSummary(db, "leaf_a", "alpha content");
    insertSummary(db, "leaf_b", "beta content");
    insertTheme(db, "theme_xyz", "sk1", "Alpha-Beta theme", "Alpha and beta cluster", 2, "active", ["leaf_a", "leaf_b"]);

    const tool = createLcmThemeExplainTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    const result = await tool.execute("call-1", { themeId: "theme_xyz" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("## Theme: Alpha-Beta theme");
    expect(text).toContain("**ID**: theme_xyz");
    expect(text).toContain("**Status**: active");
    expect(text).toContain("alpha content");
    expect(text).toContain("beta content");
    expect(text).toContain("[leaf_a]");
    expect(text).toContain("[leaf_b]");

    const details = result.details as {
      themeId: string;
      shownSources: Array<{ summaryId: string; snippet: string }>;
    };
    expect(details.themeId).toBe("theme_xyz");
    expect(details.shownSources.map((s) => s.summaryId).sort()).toEqual(["leaf_a", "leaf_b"]);
    db.close();
  });

  it("returns error when themeId not found", async () => {
    const db = setupDb();
    const tool = createLcmThemeExplainTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-not-found", { themeId: "theme_does_not_exist" });
    const error = (result.details as { error?: string }).error ?? "";
    expect(error).toMatch(/not found/i);
    db.close();
  });

  it("rejects empty themeId with helpful error", async () => {
    const db = setupDb();
    const tool = createLcmThemeExplainTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-empty", { themeId: "  " });
    const error = (result.details as { error?: string }).error ?? "";
    expect(error).toMatch(/themeId/);
    db.close();
  });

  it("includeSourceContent=false omits content; only IDs shown", async () => {
    const db = setupDb();
    insertSummary(db, "leaf_a", "alpha content");
    insertSummary(db, "leaf_b", "beta content");
    insertTheme(db, "theme_xyz", "sk1", "Alpha-Beta theme", "desc", 2, "active", ["leaf_a", "leaf_b"]);

    const tool = createLcmThemeExplainTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-no-content", {
      themeId: "theme_xyz",
      includeSourceContent: false,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("### Source IDs");
    expect(text).not.toContain("alpha content");
    expect(text).not.toContain("beta content");
    expect(text).toContain("- leaf_a");
    expect(text).toContain("- leaf_b");
    const details = result.details as { shownSources: unknown[] };
    expect(details.shownSources).toHaveLength(0);
    db.close();
  });

  it("suppressed source leaves are omitted from content fetch", async () => {
    const db = setupDb();
    insertSummary(db, "leaf_a", "alpha content");
    insertSummary(db, "leaf_b", "beta content");
    // Suppress leaf_b
    db.prepare(
      `UPDATE summaries SET suppressed_at = '2026-05-01 12:00:00' WHERE summary_id = ?`,
    ).run("leaf_b");
    insertTheme(db, "theme_xyz", "sk1", "Alpha-Beta theme", "desc", 2, "active", ["leaf_a", "leaf_b"]);

    const tool = createLcmThemeExplainTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-suppressed", { themeId: "theme_xyz" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("alpha content");
    expect(text).not.toContain("beta content");
    expect(text).toContain("suppressed");
    const details = result.details as {
      shownSources: Array<{ summaryId: string }>;
      allSourceIds: string[];
    };
    expect(details.shownSources).toHaveLength(1);
    expect(details.shownSources[0].summaryId).toBe("leaf_a");
    expect(details.allSourceIds.sort()).toEqual(["leaf_a", "leaf_b"]);
    db.close();
  });

  it("maxSourcesShown caps the number of sources fetched", async () => {
    const db = setupDb();
    for (let i = 0; i < 15; i++) {
      insertSummary(db, `leaf_${i}`, `content ${i}`);
    }
    insertTheme(db, "theme_big", "sk1", "Big theme", "desc", 15, "active",
      Array.from({ length: 15 }, (_, i) => `leaf_${i}`));

    const tool = createLcmThemeExplainTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-cap", {
      themeId: "theme_big",
      maxSourcesShown: 5,
    });
    const details = result.details as {
      allSourceIds: string[];
      shownSources: unknown[];
    };
    expect(details.allSourceIds).toHaveLength(15);
    expect(details.shownSources).toHaveLength(5);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("showing top 5");
    db.close();
  });
});
