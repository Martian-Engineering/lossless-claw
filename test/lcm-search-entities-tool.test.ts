import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmSearchEntitiesTool } from "../src/tools/lcm-search-entities-tool.js";
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
  // Wave-10 reviewer P2 fix follow-up: ensure default conversation exists
  // so the auto-default mention inserts work.
  db.prepare(
    `INSERT OR IGNORE INTO conversations (conversation_id, session_id, session_key) VALUES (1, 's1', 'sk1')`,
  ).run();
  return db;
}

function insertEntity(
  db: DatabaseSync,
  args: {
    entityId: string;
    sessionKey?: string;
    canonicalText: string;
    entityType?: string;
    occurrenceCount?: number;
    lastSeenAt?: string;
    /**
     * Wave-10 reviewer P2 fix: lcm_search_entities now requires at least
     * one unsuppressed mention (suppression contract). For tests that
     * don't care about mentions, this helper auto-creates a default
     * unsuppressed summary + mention. Tests that explicitly want the
     * all-suppressed case pass `noDefaultMention: true`.
     */
    noDefaultMention?: boolean;
  },
): void {
  db.prepare(
    `INSERT INTO lcm_entities
       (entity_id, session_key, canonical_text, entity_type,
        first_seen_at, last_seen_at, occurrence_count, alternate_surfaces)
     VALUES (?, ?, ?, ?, datetime('now', '-7 days'), ?, ?, '[]')`,
  ).run(
    args.entityId,
    args.sessionKey ?? "sk1",
    args.canonicalText,
    args.entityType ?? "concept",
    args.lastSeenAt ?? new Date().toISOString(),
    args.occurrenceCount ?? 1,
  );
  if (!args.noDefaultMention) {
    const defaultSumId = `sum_default_${args.entityId}`;
    // Ensure conversation matching the sessionKey exists.
    const sessionKey = args.sessionKey ?? "sk1";
    const convRow = db
      .prepare(
        `SELECT conversation_id FROM conversations WHERE session_key = ? LIMIT 1`,
      )
      .get(sessionKey) as { conversation_id: number } | undefined;
    let convId = convRow?.conversation_id;
    if (convId == null) {
      const result = db
        .prepare(
          `INSERT INTO conversations (session_id, session_key) VALUES (?, ?)`,
        )
        .run(`s_${sessionKey}`, sessionKey);
      convId = Number(result.lastInsertRowid);
    }
    db.prepare(
      `INSERT OR IGNORE INTO summaries
         (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
       VALUES (?, ?, 'leaf', 'default fixture content', 1, ?, NULL)`,
    ).run(defaultSumId, convId, sessionKey);
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

describe("createLcmSearchEntitiesTool — match modes", () => {
  it("default 'like' mode does substring match (case-insensitive)", async () => {
    const db = setupDb();
    insertEntity(db, { entityId: "e_voyage", canonicalText: "Voyage" });
    insertEntity(db, { entityId: "e_voyageai", canonicalText: "VoyageAI" });
    insertEntity(db, { entityId: "e_other", canonicalText: "OpenAI" });

    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "voyage" });
    const details = r.details as { entities: Array<{ canonicalText: string }> };
    const names = details.entities.map((e) => e.canonicalText).sort();
    expect(names).toEqual(["Voyage", "VoyageAI"]);
    db.close();
  });

  it("'prefix' mode only matches strings that start with the query", async () => {
    const db = setupDb();
    insertEntity(db, { entityId: "e_voyage", canonicalText: "Voyage" });
    insertEntity(db, { entityId: "e_voyageai", canonicalText: "VoyageAI" });
    insertEntity(db, { entityId: "e_envoy", canonicalText: "envoy" });

    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "voy", mode: "prefix" });
    const details = r.details as { entities: Array<{ canonicalText: string }> };
    const names = details.entities.map((e) => e.canonicalText).sort();
    expect(names).toEqual(["Voyage", "VoyageAI"]); // "envoy" excluded
    db.close();
  });

  it("'exact' mode matches only the whole string (case-insensitive)", async () => {
    const db = setupDb();
    insertEntity(db, { entityId: "e_voyage", canonicalText: "Voyage" });
    insertEntity(db, { entityId: "e_voyageai", canonicalText: "VoyageAI" });

    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "voyage", mode: "exact" });
    const details = r.details as { entities: Array<{ canonicalText: string }> };
    expect(details.entities).toHaveLength(1);
    expect(details.entities[0]!.canonicalText).toBe("Voyage");
    db.close();
  });
});

describe("createLcmSearchEntitiesTool — ranking and limits", () => {
  it("ranks by occurrence_count DESC, then last_seen_at DESC", async () => {
    // Wave-12 reviewer P1 fix: occurrence_count + last_seen_at are now
    // recomputed from unsuppressed mentions, so the test must seed real
    // mentions instead of relying on the stored entity-row column.
    const db = setupDb();
    const seedEntityWithMentions = (
      entityId: string,
      canonicalText: string,
      mentionCount: number,
      lastMentionAt: string,
    ): void => {
      insertEntity(db, {
        entityId,
        canonicalText,
        occurrenceCount: mentionCount,
        lastSeenAt: lastMentionAt,
        noDefaultMention: true,
      });
      // Ensure conversation exists.
      const convRow = db
        .prepare(`SELECT conversation_id FROM conversations WHERE session_key = ? LIMIT 1`)
        .get("sk1") as { conversation_id: number } | undefined;
      let convId = convRow?.conversation_id;
      if (convId == null) {
        const result = db
          .prepare(`INSERT INTO conversations (session_id, session_key) VALUES (?, ?)`)
          .run("s_sk1", "sk1");
        convId = Number(result.lastInsertRowid);
      }
      // First N-1 mentions back-dated; final mention at lastMentionAt to
      // pin MAX(mentioned_at) deterministically.
      for (let i = 0; i < mentionCount; i++) {
        const sumId = `sum_${entityId}_${i}`;
        const mentionedAt = i === mentionCount - 1
          ? lastMentionAt
          : new Date(Date.parse(lastMentionAt) - (mentionCount - i) * 1000).toISOString();
        db.prepare(
          `INSERT OR IGNORE INTO summaries
             (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
           VALUES (?, ?, 'leaf', 'fixture', 1, 'sk1', NULL)`,
        ).run(sumId, convId);
        db.prepare(
          `INSERT INTO lcm_entity_mentions
             (mention_id, entity_id, summary_id, surface_form, span_start, span_end, mentioned_at)
           VALUES (?, ?, ?, ?, 0, 5, ?)`,
        ).run(`m_${entityId}_${i}`, entityId, sumId, canonicalText, mentionedAt);
      }
    };
    seedEntityWithMentions("e_low", "TopicA", 1, new Date().toISOString());
    seedEntityWithMentions(
      "e_high",
      "TopicB",
      50,
      new Date(Date.now() - 86400_000).toISOString(),
    );
    seedEntityWithMentions("e_med", "TopicC", 50, new Date().toISOString());

    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "Topic" });
    const details = r.details as { entities: Array<{ entityId: string }> };
    expect(details.entities[0]!.entityId).toBe("e_med"); // 50 occ, recent
    expect(details.entities[1]!.entityId).toBe("e_high"); // 50 occ, older
    expect(details.entities[2]!.entityId).toBe("e_low"); // 1 occ
    db.close();
  });

  it("respects limit and reports limitReached", async () => {
    const db = setupDb();
    for (let i = 0; i < 5; i++) {
      insertEntity(db, { entityId: `e_${i}`, canonicalText: `Item${i}` });
    }
    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "Item", limit: 3 });
    const details = r.details as { entities: unknown[]; limitReached: boolean };
    expect(details.entities).toHaveLength(3);
    expect(details.limitReached).toBe(true);
    db.close();
  });
});

describe("createLcmSearchEntitiesTool — filters and edge cases", () => {
  it("filters by entityType when provided", async () => {
    const db = setupDb();
    // schema has UNIQUE on (session_key, canonical_text), so two entities with
    // the same name in the same session is not representable. Use distinct
    // names so the entityType filter is the only thing distinguishing them.
    insertEntity(db, { entityId: "e_proj_alpha", canonicalText: "alpha", entityType: "project" });
    insertEntity(db, { entityId: "e_branch_alpha", canonicalText: "alpha-feature", entityType: "git-branch" });
    insertEntity(db, { entityId: "e_proj_beta", canonicalText: "beta", entityType: "project" });

    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    // Search for substring "alpha" with entityType=project → only the project one
    const r = await tool.execute("c", { query: "alpha", entityType: "project" });
    const details = r.details as { entities: Array<{ entityId: string }> };
    expect(details.entities).toHaveLength(1);
    expect(details.entities[0]!.entityId).toBe("e_proj_alpha");
    db.close();
  });

  it("scopes to the current session key by default", async () => {
    const db = setupDb();
    insertEntity(db, { entityId: "e_in", canonicalText: "Voyage", sessionKey: "sk1" });
    insertEntity(db, { entityId: "e_out", canonicalText: "Voyage", sessionKey: "sk2" });

    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "Voyage" });
    const details = r.details as { entities: Array<{ entityId: string }> };
    expect(details.entities).toHaveLength(1);
    expect(details.entities[0]!.entityId).toBe("e_in");
    db.close();
  });

  it("escapes LIKE wildcards in query (so user-supplied % doesn't widen search)", async () => {
    const db = setupDb();
    insertEntity(db, { entityId: "e1", canonicalText: "100%pure" });
    insertEntity(db, { entityId: "e2", canonicalText: "100abc" });

    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    // Query "100%pure" — the % is in the user-supplied query. Without escape
    // it would be a wildcard matching 100abc too. With escape, only e1 matches.
    const r = await tool.execute("c", { query: "100%pure" });
    const details = r.details as { entities: Array<{ entityId: string }> };
    expect(details.entities).toHaveLength(1);
    expect(details.entities[0]!.entityId).toBe("e1");
    db.close();
  });

  it("returns error when query is empty", async () => {
    const db = setupDb();
    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "" });
    expect((r.details as { error: string }).error).toContain("`query` is required");
    db.close();
  });

  it("returns empty result with helpful text when no matches (catalog empty)", async () => {
    // P8 harness fix (2026-05-06): empty result now distinguishes
    // "0 entities indexed" (coverage gap) from "0 matches for query"
    // (negative answer). On a fresh DB with no entities, status is
    // 'empty-globally' and the text says so explicitly.
    const db = setupDb();
    const tool = createLcmSearchEntitiesTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "sk1",
    });
    const r = await tool.execute("c", { query: "Nonexistent" });
    expect((r.details as { totalMatches: number }).totalMatches).toBe(0);
    expect((r.details as { catalogStatus: string }).catalogStatus).toBe(
      "empty-globally",
    );
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("No entities indexed in this DB at all");
    expect(text).toContain("coverage gap");
    db.close();
  });
});
