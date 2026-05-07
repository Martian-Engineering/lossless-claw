import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmGetEntityTool } from "../src/tools/lcm-get-entity-tool.js";
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
    ...overrides,
  } as LcmDependencies;
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'sk1')`).run();
  return db;
}

function insertSummary(
  db: DatabaseSync,
  summaryId: string,
  sessionKey = "sk1",
  convId = 1,
  suppressedAt: string | null = null,
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
     VALUES (?, ?, 'leaf', 'x', 1, ?, ?)`,
  ).run(summaryId, convId, sessionKey, suppressedAt);
}

function insertEntity(
  db: DatabaseSync,
  args: {
    entityId: string;
    sessionKey?: string;
    canonicalText: string;
    entityType?: string;
    occurrenceCount?: number;
    alternateSurfaces?: string[];
  },
): void {
  db.prepare(
    `INSERT INTO lcm_entities
       (entity_id, session_key, canonical_text, entity_type,
        first_seen_at, last_seen_at, occurrence_count, alternate_surfaces)
     VALUES (?, ?, ?, ?, datetime('now', '-3 days'), datetime('now'), ?, ?)`,
  ).run(
    args.entityId,
    args.sessionKey ?? "sk1",
    args.canonicalText,
    args.entityType ?? "concept",
    args.occurrenceCount ?? 1,
    JSON.stringify(args.alternateSurfaces ?? []),
  );
}

function insertMention(
  db: DatabaseSync,
  args: {
    mentionId: string;
    entityId: string;
    summaryId: string;
    surfaceForm: string;
    mentionedAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO lcm_entity_mentions
       (mention_id, entity_id, summary_id, surface_form, span_start, span_end, mentioned_at)
     VALUES (?, ?, ?, ?, 0, 5, ?)`,
  ).run(
    args.mentionId,
    args.entityId,
    args.summaryId,
    args.surfaceForm,
    args.mentionedAt ?? new Date().toISOString(),
  );
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

describe("createLcmGetEntityTool — happy path", () => {
  it("returns the entity + its mentions when found", async () => {
    const db = setupDb();
    insertSummary(db, "sum_1");
    insertSummary(db, "sum_2");
    insertEntity(db, {
      entityId: "ent_voyage",
      canonicalText: "Voyage",
      entityType: "tool",
      occurrenceCount: 2,
      alternateSurfaces: ["voyage", "VoyageAI"],
    });
    insertMention(db, {
      mentionId: "m1",
      entityId: "ent_voyage",
      summaryId: "sum_1",
      surfaceForm: "Voyage",
    });
    insertMention(db, {
      mentionId: "m2",
      entityId: "ent_voyage",
      summaryId: "sum_2",
      surfaceForm: "voyage",
    });

    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c1", { name: "Voyage" });
    const details = r.details as {
      found: boolean;
      entityId: string;
      name: string;
      entityType: string;
      mentions: Array<{ mentionId: string; summaryId: string }>;
    };
    expect(details.found).toBe(true);
    expect(details.entityId).toBe("ent_voyage");
    expect(details.name).toBe("Voyage");
    expect(details.entityType).toBe("tool");
    expect(details.mentions).toHaveLength(2);
    expect(details.mentions.map((m) => m.mentionId).sort()).toEqual(["m1", "m2"]);

    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("## Entity: Voyage");
    expect(text).toContain("**Total occurrences**: 2");
    expect(text).toContain("**Alternate surfaces**: voyage, VoyageAI");

    db.close();
  });

  it("matches case-insensitively (COLLATE NOCASE)", async () => {
    const db = setupDb();
    insertEntity(db, { entityId: "e1", canonicalText: "Eva" });

    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "EVA" });
    expect((r.details as { found: boolean }).found).toBe(true);
    db.close();
  });

  it("filters by entity_type when provided (distinct names per type since UNIQUE forbids same-name)", async () => {
    const db = setupDb();
    // Schema has UNIQUE on (session_key, canonical_text) — same name cannot
    // co-exist as multiple types in one session. Entity_type filter is still
    // useful when name uniqueness is preserved by convention.
    insertEntity(db, { entityId: "e_main_proj", canonicalText: "main-project", entityType: "project" });
    insertEntity(db, { entityId: "e_main_branch", canonicalText: "main-branch", entityType: "git-branch" });

    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "main-branch", entityType: "git-branch" });
    expect((r.details as { entityId: string }).entityId).toBe("e_main_branch");
    db.close();
  });
});

describe("createLcmGetEntityTool — suppression", () => {
  it("filters mentions whose parent summary has suppressed_at IS NOT NULL", async () => {
    const db = setupDb();
    insertSummary(db, "sum_visible");
    insertSummary(db, "sum_suppressed", "sk1", 1, new Date().toISOString());
    insertEntity(db, { entityId: "e1", canonicalText: "TestEntity", occurrenceCount: 2 });
    insertMention(db, {
      mentionId: "m_visible",
      entityId: "e1",
      summaryId: "sum_visible",
      surfaceForm: "TestEntity",
    });
    insertMention(db, {
      mentionId: "m_hidden",
      entityId: "e1",
      summaryId: "sum_suppressed",
      surfaceForm: "TestEntity",
    });

    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "TestEntity" });
    const details = r.details as {
      mentions: Array<{ mentionId: string }>;
      totalOccurrences: number;
    };
    expect(details.mentions).toHaveLength(1);
    expect(details.mentions[0]!.mentionId).toBe("m_visible");
    // Total occurrences is the entity-row column, NOT the agent-visible count.
    // Both surfaced so the agent knows hidden mentions exist.
    expect(details.totalOccurrences).toBe(2);
    db.close();
  });
});

describe("createLcmGetEntityTool — error paths", () => {
  it("returns helpful 'not found' when name doesn't match", async () => {
    const db = setupDb();
    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "NoSuchEntity" });
    expect((r.details as { found: boolean; message: string }).found).toBe(false);
    expect((r.details as { message: string }).message).toContain("No entity matching");
    db.close();
  });

  it("returns error when name is empty", async () => {
    const db = setupDb();
    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "" });
    expect((r.details as { error: string }).error).toContain("`name` is required");
    db.close();
  });

  it("returns error when sessionKey can't be resolved", async () => {
    const db = setupDb();
    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      // No sessionKey passed
    });
    const r = await tool.execute("c", { name: "Voyage" });
    expect((r.details as { error: string }).error).toContain("No session_key resolved");
    db.close();
  });
});

describe("createLcmGetEntityTool — mention limit", () => {
  it("respects mentionLimit and reports mentionsTruncated correctly", async () => {
    const db = setupDb();
    insertSummary(db, "sum_x");
    insertEntity(db, { entityId: "e_many", canonicalText: "Lots", occurrenceCount: 10 });
    for (let i = 0; i < 10; i++) {
      insertMention(db, {
        mentionId: `m_${i}`,
        entityId: "e_many",
        summaryId: "sum_x",
        surfaceForm: "Lots",
      });
    }

    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "Lots", mentionLimit: 3 });
    const details = r.details as {
      mentions: unknown[];
      mentionsTruncated: boolean;
    };
    expect(details.mentions).toHaveLength(3);
    expect(details.mentionsTruncated).toBe(true);
    db.close();
  });

  it("does not flag truncated when mentions fit under the limit", async () => {
    const db = setupDb();
    insertSummary(db, "sum_x");
    insertEntity(db, { entityId: "e_few", canonicalText: "Few", occurrenceCount: 2 });
    insertMention(db, { mentionId: "m1", entityId: "e_few", summaryId: "sum_x", surfaceForm: "Few" });
    insertMention(db, { mentionId: "m2", entityId: "e_few", summaryId: "sum_x", surfaceForm: "Few" });

    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "Few", mentionLimit: 50 });
    expect((r.details as { mentionsTruncated: boolean }).mentionsTruncated).toBe(false);
    db.close();
  });
});
