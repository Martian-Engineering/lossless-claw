import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmSearchThemesTool } from "../src/tools/lcm-search-themes-tool.js";
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

function insertTheme(
  db: DatabaseSync,
  themeId: string,
  sessionKey: string,
  name: string,
  desc: string,
  sourceCount: number,
  status: "active" | "stale" | "archived" = "active",
): void {
  db.prepare(
    `INSERT INTO lcm_themes
       (theme_id, session_key, name, description, source_leaf_count,
        consolidation_model, consolidation_pass_id, status)
     VALUES (?, ?, ?, ?, ?, 'test-model', 'pass-test', ?)`,
  ).run(themeId, sessionKey, name, desc, sourceCount, status);
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

describe("createLcmSearchThemesTool — text mode", () => {
  it("matches against name and description, case-insensitive", async () => {
    const db = setupDb();
    insertTheme(db, "theme_sk1_aaa", "sk1", "Plan-mode REBASE work", "Cluster around the rebase work", 45);
    insertTheme(db, "theme_sk1_bbb", "sk1", "Other unrelated", "talks about Rebase too", 10);
    insertTheme(db, "theme_sk1_ccc", "sk1", "Totally unrelated", "nothing to see here", 7);

    const tool = createLcmSearchThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    const result = await tool.execute("call-1", { query: "rebase" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('## LCM Theme Search (query="rebase", mode=text, n=2');
    expect(text).toContain("Plan-mode REBASE work");
    expect(text).toContain("Other unrelated");
    expect(text).not.toContain("Totally unrelated");

    const details = result.details as {
      themeCount: number;
      themes: Array<{ themeId: string; sourceLeafCount: number }>;
    };
    expect(details.themeCount).toBe(2);
    db.close();
  });

  it("returns helpful 'no matches' message and zero themes when nothing matches", async () => {
    const db = setupDb();
    insertTheme(db, "theme_sk1_aaa", "sk1", "Frontend rendering", "react and css", 5);

    const tool = createLcmSearchThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    const result = await tool.execute("call-2", { query: "rebase" });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('No themes match query "rebase" in mode=text');
    // Final.review.3 fix (Slice 5 §3): hint no longer points at non-existent
    // `/lcm worker tick consolidate-themes` subcommand. New hint explains the
    // cycle-3 status of themes consolidation auto-tick.
    expect(text).toContain("auto-tick is cycle-3");

    const details = result.details as { themeCount: number };
    expect(details.themeCount).toBe(0);
    db.close();
  });

  it("filters by status: defaults to active only, but can show stale/all", async () => {
    const db = setupDb();
    insertTheme(db, "theme_active", "sk1", "rebase active", "x", 5, "active");
    insertTheme(db, "theme_stale", "sk1", "rebase stale", "y", 6, "stale");
    insertTheme(db, "theme_archived", "sk1", "rebase archived", "z", 7, "archived");

    const tool = createLcmSearchThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    // default = active only
    const r1 = await tool.execute("call-3a", { query: "rebase" });
    const d1 = r1.details as { themes: Array<{ status: string; name: string }> };
    expect(d1.themes).toHaveLength(1);
    expect(d1.themes[0].status).toBe("active");

    // status=stale
    const r2 = await tool.execute("call-3b", { query: "rebase", status: "stale" });
    const d2 = r2.details as { themes: Array<{ status: string }> };
    expect(d2.themes).toHaveLength(1);
    expect(d2.themes[0].status).toBe("stale");
    const t2 = (r2.content[0] as { text: string }).text;
    // status badge appears in output for non-active
    expect(t2).toContain("[stale]");

    // status=all returns all 3
    const r3 = await tool.execute("call-3c", { query: "rebase", status: "all" });
    const d3 = r3.details as { themeCount: number };
    expect(d3.themeCount).toBe(3);
    db.close();
  });

  it("sessionKey scope filter restricts results to one session", async () => {
    const db = setupDb();
    insertTheme(db, "theme_sk1_a", "sk1", "rebase on sk1", "x", 5);
    insertTheme(db, "theme_sk2_a", "sk2", "rebase on sk2", "y", 8);

    const tool = createLcmSearchThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    // No sessionKey param => searches across all sessions
    const rAll = await tool.execute("call-4a", { query: "rebase" });
    const dAll = rAll.details as { themeCount: number };
    expect(dAll.themeCount).toBe(2);

    // sessionKey=sk2 => only sk2 themes
    const rOne = await tool.execute("call-4b", { query: "rebase", sessionKey: "sk2" });
    const dOne = rOne.details as { themes: Array<{ sessionKey: string }> };
    expect(dOne.themes).toHaveLength(1);
    expect(dOne.themes[0].sessionKey).toBe("sk2");
    db.close();
  });

  it("rejects mode='semantic' with helpful error", async () => {
    const db = setupDb();
    insertTheme(db, "theme_sk1_a", "sk1", "rebase work", "x", 5);

    const tool = createLcmSearchThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    const r = await tool.execute("call-5", { query: "rebase", mode: "semantic" });
    const error = (r.details as { error?: string }).error ?? "";
    expect(error).toMatch(/semantic theme search requires theme embeddings/);
    expect(error).toMatch(/use mode='text'/);
    db.close();
  });

  it("orders results by source_leaf_count DESC", async () => {
    const db = setupDb();
    insertTheme(db, "theme_small", "sk1", "rebase tiny", "x", 3);
    insertTheme(db, "theme_huge", "sk1", "rebase enormous", "y", 100);
    insertTheme(db, "theme_med", "sk1", "rebase medium", "z", 25);

    const tool = createLcmSearchThemesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });

    const r = await tool.execute("call-6", { query: "rebase" });
    const d = r.details as { themes: Array<{ themeId: string; sourceLeafCount: number }> };
    expect(d.themes.map((t) => t.themeId)).toEqual(["theme_huge", "theme_med", "theme_small"]);
    expect(d.themes.map((t) => t.sourceLeafCount)).toEqual([100, 25, 3]);
    db.close();
  });
});
