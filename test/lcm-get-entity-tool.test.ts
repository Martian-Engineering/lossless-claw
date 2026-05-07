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
    /**
     * Wave-10 reviewer P2 fix: lcm_get_entity now requires at least one
     * unsuppressed mention to return the entity (suppression contract).
     * For tests that don't care about mentions, this helper now also
     * inserts a default unsuppressed summary + mention so the entity is
     * findable. Tests that EXPLICITLY want the all-suppressed case
     * pass `noDefaultMention: true` and insert their own state.
     */
    noDefaultMention?: boolean;
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
  if (!args.noDefaultMention) {
    // Auto-create one unsuppressed summary + mention so the EXISTS guard
    // in lcm_get_entity_tool sees a visible mention.
    const defaultSumId = `sum_default_${args.entityId}`;
    db.prepare(
      `INSERT OR IGNORE INTO summaries
         (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
       VALUES (?, 1, 'leaf', 'default fixture content', 1, ?, NULL)`,
    ).run(defaultSumId, args.sessionKey ?? "sk1");
    db.prepare(
      `INSERT INTO lcm_entity_mentions
         (mention_id, entity_id, summary_id, surface_form, span_start, span_end, mentioned_at)
       VALUES (?, ?, ?, ?, 0, 5, datetime('now'))`,
    ).run(
      `m_default_${args.entityId}`,
      args.entityId,
      defaultSumId,
      args.canonicalText,
    );
  }
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
    insertSummary(db, "sum_3");
    // Wave-10 reviewer P2 fix follow-up: this test inserts its own
    // mentions explicitly, so opt out of the default-mention auto-insert.
    // Wave-12 reviewer P1 fix: aggregates are recomputed from
    // unsuppressed mentions so insertEntity's stored
    // occurrence_count/alternate_surfaces are no longer authoritative;
    // the test pulls them from the actual mention rows. Add a "VoyageAI"
    // surface mention so the alternate-surfaces list contains a non-
    // canonical surface form.
    insertEntity(db, {
      entityId: "ent_voyage",
      canonicalText: "Voyage",
      entityType: "tool",
      occurrenceCount: 99, // ignored — recomputed from visible mentions
      alternateSurfaces: ["stale-pre-recompute"], // ignored
      noDefaultMention: true,
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
    insertMention(db, {
      mentionId: "m3",
      entityId: "ent_voyage",
      summaryId: "sum_3",
      surfaceForm: "VoyageAI",
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
      totalOccurrences: number;
      alternateSurfaces: string[];
      mentions: Array<{ mentionId: string; summaryId: string }>;
    };
    expect(details.found).toBe(true);
    expect(details.entityId).toBe("ent_voyage");
    expect(details.name).toBe("Voyage");
    expect(details.entityType).toBe("tool");
    expect(details.mentions).toHaveLength(3);
    expect(details.mentions.map((m) => m.mentionId).sort()).toEqual(["m1", "m2", "m3"]);
    // Aggregates recomputed from mentions, not from stored entity row.
    expect(details.totalOccurrences).toBe(3);
    // Alternate surfaces strips canonical "Voyage" (case-insensitive),
    // leaving distinct non-canonical forms.
    expect(details.alternateSurfaces.sort()).toEqual(["VoyageAI"]);

    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("## Entity: Voyage");
    expect(text).toContain("**Total occurrences**: 3");
    expect(text).toContain("**Alternate surfaces**: VoyageAI");

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
    // Wave-10 reviewer P2 fix follow-up: explicit mention setup; opt out
    // of default mention.
    insertEntity(db, {
      entityId: "e1",
      canonicalText: "TestEntity",
      occurrenceCount: 2,
      noDefaultMention: true,
    });
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
    // Wave-12 reviewer P1 fix: total occurrences is now recomputed from
    // unsuppressed mentions only. Previously this read the stored
    // entity-row column (which includes suppressed counts) — which leaks
    // an oracle handle revealing that hidden mentions exist. Now suppression
    // means invisible-to-agent, period: agent-visible = 1 (one
    // unsuppressed mention), totalOccurrences = 1 (recomputed).
    expect(details.totalOccurrences).toBe(1);
    db.close();
  });

  it("INVARIANT: aggregates (first_seen, last_seen, alternate_surfaces, first_seen_in) are recomputed from unsuppressed mentions (Wave-12 reviewer P1)", async () => {
    // Pre-fix: entity row aggregates included suppressed-mention data,
    // leaking surface forms first introduced in suppressed leaves and
    // exposing summary IDs of suppressed leaves via first_seen_in_summary_id.
    // Post-fix: every aggregate is computed live from the JOIN with
    // unsuppressed summaries.
    const db = setupDb();
    // Suppressed leaf 7 days ago, surface form only used here.
    insertSummary(db, "sum_suppressed_old", "sk1", 1, new Date().toISOString());
    db.prepare(`UPDATE summaries SET created_at = datetime('now', '-7 days') WHERE summary_id = 'sum_suppressed_old'`).run();
    // Visible leaf 1 day ago.
    insertSummary(db, "sum_visible_recent");
    db.prepare(`UPDATE summaries SET created_at = datetime('now', '-1 day') WHERE summary_id = 'sum_visible_recent'`).run();
    insertEntity(db, {
      entityId: "ent_x",
      canonicalText: "ProjectAlpha",
      occurrenceCount: 99, // stale stored count; ignored after fix
      noDefaultMention: true,
    });
    // Hidden mention with a unique surface form — must NOT appear post-fix.
    insertMention(db, {
      mentionId: "m_hidden_old",
      entityId: "ent_x",
      summaryId: "sum_suppressed_old",
      surfaceForm: "alpha-secret-codename",
    });
    db.prepare(`UPDATE lcm_entity_mentions SET mentioned_at = datetime('now', '-7 days') WHERE mention_id = 'm_hidden_old'`).run();
    // Visible mention with canonical surface form.
    insertMention(db, {
      mentionId: "m_visible_recent",
      entityId: "ent_x",
      summaryId: "sum_visible_recent",
      surfaceForm: "ProjectAlpha",
    });
    db.prepare(`UPDATE lcm_entity_mentions SET mentioned_at = datetime('now', '-1 day') WHERE mention_id = 'm_visible_recent'`).run();

    const tool = createLcmGetEntityTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { name: "ProjectAlpha" });
    const details = r.details as {
      totalOccurrences: number;
      alternateSurfaces: string[];
      firstSeenInSummaryId: string | null;
      firstSeenAt: string;
      lastSeenAt: string;
    };
    // Aggregates should reflect ONLY the visible mention.
    expect(details.totalOccurrences).toBe(1);
    expect(details.firstSeenInSummaryId).toBe("sum_visible_recent");
    // 'alpha-secret-codename' was only in the suppressed leaf — must not appear.
    expect(details.alternateSurfaces).not.toContain("alpha-secret-codename");
    // first_seen_at = last_seen_at = visible mention's mentioned_at (1d ago).
    // Both should match each other; 7d-ago suppressed mention must not pull
    // first_seen_at backward.
    expect(details.firstSeenAt).toBe(details.lastSeenAt);
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
