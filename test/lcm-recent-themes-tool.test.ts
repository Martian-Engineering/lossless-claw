import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmRecentThemesTool } from "../src/tools/lcm-recent-themes-tool.js";
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
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s2', 'sk2')`).run();
  return db;
}

function insertSummary(db: DatabaseSync, summaryId: string, sessionKey = "sk1", convId = 1): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key)
     VALUES (?, ?, 'leaf', 'x', 1, ?)`,
  ).run(summaryId, convId, sessionKey);
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

describe("createLcmRecentThemesTool — happy path", () => {
  it("returns active themes for the current session by default", async () => {
    const db = setupDb();
    insertSummary(db, "leaf_a");
    insertSummary(db, "leaf_b");
    insertTheme(db, "theme_sk1_aaa", "sk1", "Pre-launch debugging", "Debug cluster", 12, "active", ["leaf_a"]);
    insertTheme(db, "theme_sk1_bbb", "sk1", "Plan-mode rollout", "Plan rollout", 8, "active", ["leaf_b"]);

    const tool = createLcmRecentThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    const result = await tool.execute("call-1", {});
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("## LCM Recent Themes (sk1, status=active)");
    expect(text).toContain("Pre-launch debugging");
    expect(text).toContain("Plan-mode rollout");
    expect(text).toContain("`theme_sk1_aaa`");

    const details = result.details as { themeCount: number; themes: Array<{ themeId: string }> };
    expect(details.themeCount).toBe(2);
    db.close();
  });

  it("explicit sessionKey param overrides current session", async () => {
    const db = setupDb();
    insertTheme(db, "theme_sk1_aaa", "sk1", "Theme on sk1", "x", 5);
    insertTheme(db, "theme_sk2_bbb", "sk2", "Theme on sk2", "y", 7);

    const tool = createLcmRecentThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-2", { sessionKey: "sk2" });
    const details = result.details as { themeCount: number; themes: Array<{ name: string }> };
    expect(details.themeCount).toBe(1);
    expect(details.themes[0].name).toBe("Theme on sk2");
    db.close();
  });

  it("status=stale filter only returns stale themes", async () => {
    const db = setupDb();
    insertTheme(db, "theme_active", "sk1", "Active theme", "x", 5, "active");
    insertTheme(db, "theme_stale", "sk1", "Stale theme", "y", 6, "stale");
    insertTheme(db, "theme_archived", "sk1", "Archived theme", "z", 4, "archived");

    const tool = createLcmRecentThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-3", { status: "stale" });
    const details = result.details as { themes: Array<{ name: string }> };
    expect(details.themes).toHaveLength(1);
    expect(details.themes[0].name).toBe("Stale theme");
    db.close();
  });

  it("status=all returns themes regardless of status", async () => {
    const db = setupDb();
    insertTheme(db, "theme_active", "sk1", "Active theme", "x", 5, "active");
    insertTheme(db, "theme_stale", "sk1", "Stale theme", "y", 6, "stale");
    insertTheme(db, "theme_archived", "sk1", "Archived theme", "z", 4, "archived");

    const tool = createLcmRecentThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-4", { status: "all" });
    const details = result.details as { themeCount: number };
    expect(details.themeCount).toBe(3);
    db.close();
  });

  it("limit caps the number of themes returned", async () => {
    const db = setupDb();
    for (let i = 0; i < 10; i++) {
      insertTheme(db, `theme_${i}`, "sk1", `Theme ${i}`, `desc ${i}`, 5);
    }
    const tool = createLcmRecentThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-5", { limit: 3 });
    const details = result.details as { themeCount: number };
    expect(details.themeCount).toBe(3);
    db.close();
  });

  it("returns an empty list with friendly text when no themes exist", async () => {
    const db = setupDb();
    const tool = createLcmRecentThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const result = await tool.execute("call-6", {});
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("No themes found");
    const details = result.details as { themeCount: number };
    expect(details.themeCount).toBe(0);
    db.close();
  });
});

describe("createLcmRecentThemesTool — error paths", () => {
  it("returns an error when no session key is available", async () => {
    const db = setupDb();
    const tool = createLcmRecentThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      // no sessionKey
    });
    const result = await tool.execute("call-no-sk", {});
    const error = (result.details as { error?: string }).error ?? "";
    expect(error).toMatch(/No session key/);
    db.close();
  });
});
