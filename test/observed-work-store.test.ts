import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { createLcmWorkDensityTool } from "../src/tools/lcm-work-density-tool.js";
import type { LcmDependencies } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function createConversation(db: DatabaseSync, conversationId: number): void {
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key, title)
     VALUES (?, ?, ?, ?)`
  ).run(
    conversationId,
    `observed-work-${conversationId}`,
    `agent:main:observed-work-${conversationId}`,
    `Observed work ${conversationId}`
  );
}

describe("ObservedWorkStore", () => {
  it("creates observed work tables during migration", () => {
    const db = makeDb();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'lcm_observed_work_%' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "lcm_observed_work_items",
      "lcm_observed_work_sources",
      "lcm_observed_work_state",
    ]);
  });

  it("reports completed, unfinished, and ambiguous work density", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    const base = {
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      confidence: 0.9,
      confidenceBand: "high" as const,
    };

    store.upsertItem({
      ...base,
      workItemId: "work_done",
      title: "Daily rollup tests passed",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:daily-rollup",
      completedAt: "2026-04-28T01:00:00.000Z",
      rationale: "Observed passing test output.",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_open",
      title: "Fix PR #14 review comments",
      observedStatus: "observed_unfinished",
      kind: "review",
      fingerprint: "review:pr14",
      rationale: "Review still requested changes.",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_maybe",
      title: "Decide task bridge policy",
      observedStatus: "observed_ambiguous",
      kind: "decision",
      fingerprint: "decision:task-bridge-policy",
    });

    const density = store.getDensity({ conversationId: 1, limit: 5 });
    expect(density.density).toMatchObject({
      totalObserved: 3,
      completed: 1,
      unfinished: 1,
      ambiguous: 1,
      dismissed: 0,
      decisionRecorded: 0,
    });
    expect(density.topUnfinished[0]?.title).toBe("Fix PR #14 review comments");
    expect(density.completedHighlights[0]?.title).toBe("Daily rollup tests passed");
    expect(density.ambiguous[0]?.title).toBe("Decide task bridge policy");
  });

  it("hides sources by default and includes them only when requested", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    store.upsertItem({
      workItemId: "work_with_sources",
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      title: "Review source visibility",
      observedStatus: "observed_unfinished",
      kind: "review",
      fingerprint: "review:sources",
    });
    store.addSource({
      workItemId: "work_with_sources",
      sourceType: "summary",
      sourceId: "sum_hidden",
      ordinal: 0,
      evidenceKind: "created",
    });

    const hidden = store.getDensity({ conversationId: 1 });
    expect(hidden.topUnfinished[0]?.sources).toBeUndefined();

    const shown = store.getDensity({ conversationId: 1, includeSources: true });
    expect(shown.topUnfinished[0]?.sources).toEqual([
      {
        sourceType: "summary",
        sourceId: "sum_hidden",
        ordinal: 0,
        evidenceKind: "created",
      },
    ]);
  });

  it("tracks incremental processing state", () => {
    const db = makeDb();
    createConversation(db, 42);
    const store = new ObservedWorkStore(db);
    store.upsertState({
      conversationId: 42,
      lastProcessedSummaryCreatedAt: "2026-04-28T02:00:00.000Z",
      lastProcessedSummaryId: "sum_123",
      pendingRebuild: true,
    });
    const row = db
      .prepare(`SELECT * FROM lcm_observed_work_state WHERE conversation_id = ?`)
      .get(42) as { last_processed_summary_id: string; pending_rebuild: number };
    expect(row.last_processed_summary_id).toBe("sum_123");
    expect(row.pending_rebuild).toBe(1);

    store.upsertState({
      conversationId: 42,
      lastProcessedSummaryId: "sum_456",
    });
    const updated = db
      .prepare(`SELECT * FROM lcm_observed_work_state WHERE conversation_id = ?`)
      .get(42) as { last_processed_summary_id: string; pending_rebuild: number };
    expect(updated.last_processed_summary_id).toBe("sum_456");
    expect(updated.pending_rebuild).toBe(1);
  });

  it("serves lcm_work_density with deterministic period filtering and source redaction", async () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    store.upsertItem({
      workItemId: "work_today",
      conversationId: 1,
      firstSeenAt: "2026-04-28T01:00:00.000Z",
      lastSeenAt: "2026-04-28T02:00:00.000Z",
      title: "Finish work density tests",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:work-density",
    });
    store.upsertItem({
      workItemId: "work_yesterday",
      conversationId: 1,
      firstSeenAt: "2026-04-27T01:00:00.000Z",
      lastSeenAt: "2026-04-27T02:00:00.000Z",
      title: "Older unfinished item",
      observedStatus: "observed_unfinished",
      kind: "review",
      fingerprint: "review:old",
    });
    store.addSource({
      workItemId: "work_today",
      sourceType: "summary",
      sourceId: "sum_today",
      ordinal: 0,
      evidenceKind: "completed",
    });

    const lcm = {
      timezone: "UTC",
      getObservedWorkStore: () => store,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
    } as unknown as LcmDependencies;
    const tool = createLcmWorkDensityTool({
      deps,
      lcm: lcm as never,
      sessionId: "density-session",
    });

    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const hidden = await tool.execute("density-hidden", {
        conversationId: 1,
        period: "today",
      });
      expect((hidden.details as { density: { totalObserved: number } }).density.totalObserved).toBe(1);
      expect(JSON.stringify(hidden.details)).not.toContain("sum_today");

      const shown = await tool.execute("density-shown", {
        conversationId: 1,
        period: "today",
        includeSources: true,
      });
      expect(JSON.stringify(shown.details)).toContain("sum_today");
      expect((shown.details as { period?: string }).period).toBe("today");

      const global = await tool.execute("density-global", {
        allConversations: true,
      });
      expect((global.details as { error?: string }).error).toMatch(
        /does not support allConversations/,
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
