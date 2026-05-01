import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkExtractor } from "../src/observed-work-extractor.js";
import { EventObservationStore } from "../src/store/event-observation-store.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmEventSearchTool } from "../src/tools/lcm-event-search-tool.js";
import { createLcmWorkDensityTool } from "../src/tools/lcm-work-density-tool.js";
import type { LcmDependencies } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  db.exec("PRAGMA foreign_keys = ON");
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

async function insertLeafSummary(input: {
  db: DatabaseSync;
  summaryStore: SummaryStore;
  summaryId: string;
  conversationId: number;
  content: string;
  createdAt: string;
}): Promise<void> {
  await input.summaryStore.insertSummary({
    summaryId: input.summaryId,
    conversationId: input.conversationId,
    kind: "leaf",
    depth: 0,
    content: input.content,
    tokenCount: 50,
    sourceMessageTokenCount: 80,
    latestAt: new Date(input.createdAt),
  });
  input.db.prepare(`UPDATE summaries SET created_at = ? WHERE summary_id = ?`)
    .run(input.createdAt, input.summaryId);
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
      "lcm_observed_work_transitions",
    ]);
  });

  it("extracts leaf-summary work with a rowid cursor so same-second summaries are not skipped", async () => {
    const db = makeDb();
    createConversation(db, 7);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);
    const pointLookupSpy = vi.spyOn(observedWork, "getItem");

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 7,
      summaryId: "sum_z_first",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #540 still has unresolved review comments",
    });
    expect(extractor.processConversation(7)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 7,
      summaryId: "sum_a_later",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #541 still has failing CI",
    });
    expect(extractor.processConversation(7)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 7,
      statuses: ["observed_unfinished"],
      limit: 10,
    });
    expect(density.density.unfinished).toBe(2);
    expect(density.topUnfinished.map((item) => item.topicKey).sort()).toEqual([
      "pr-540",
      "pr-541",
    ]);
    const state = observedWork.getState(7);
    expect(state?.lastProcessedSummaryId).toBe("sum_a_later");
    expect(state?.lastProcessedSummaryRowid).toBeGreaterThan(0);
    expect(pointLookupSpy).not.toHaveBeenCalled();
  });

  it("does not inflate evidence when a retry reprocesses the same summary source", async () => {
    const db = makeDb();
    createConversation(db, 12);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 12,
      summaryId: "sum_retry_same_source",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #552 still has a failing extractor retry test",
    });
    expect(extractor.processConversation(12)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    db.prepare(`DELETE FROM lcm_observed_work_state WHERE conversation_id = ?`).run(12);
    expect(extractor.processConversation(12)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 12,
      statuses: ["observed_unfinished"],
      includeSources: true,
      limit: 10,
    });
    expect(density.topUnfinished).toHaveLength(1);
    expect(density.topUnfinished[0]?.evidenceCount).toBe(1);
    expect(density.topUnfinished[0]?.sources).toEqual([
      expect.objectContaining({
        sourceType: "summary",
        sourceId: "sum_retry_same_source",
        evidenceKind: "created",
      }),
    ]);
  });

  it("rolls back partial summary extraction writes before retry", async () => {
    const db = makeDb();
    createConversation(db, 13);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 13,
      summaryId: "sum_partial_retry",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #553 still has partial write retry risk",
    });

    const addSourceSpy = vi.spyOn(observedWork, "addSource");
    addSourceSpy.mockImplementationOnce(() => {
      throw new Error("simulated source write failure");
    });
    expect(() => extractor.processConversation(13)).toThrow(/simulated source/);
    addSourceSpy.mockRestore();

    expect(
      observedWork.getDensity({
        conversationId: 13,
        statuses: ["observed_unfinished"],
      }).density.totalObserved
    ).toBe(0);
    expect(observedWork.getState(13)).toBeNull();

    expect(extractor.processConversation(13)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    const density = observedWork.getDensity({
      conversationId: 13,
      statuses: ["observed_unfinished"],
      includeSources: true,
    });
    expect(density.topUnfinished).toHaveLength(1);
    expect(density.topUnfinished[0]?.evidenceCount).toBe(1);
    expect(density.topUnfinished[0]?.sources).toHaveLength(1);
  });

  it("derives the rowid cursor from the processed summary id after rowid drift", async () => {
    const db = makeDb();
    createConversation(db, 11);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 11,
      summaryId: "sum_cursor_anchor",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #550 needs review",
    });
    expect(extractor.processConversation(11)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    observedWork.upsertState({
      conversationId: 11,
      lastProcessedSummaryId: "sum_cursor_anchor",
      lastProcessedSummaryRowid: 9999,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 11,
      summaryId: "sum_cursor_later",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #551 needs review",
    });
    expect(extractor.processConversation(11)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    const density = observedWork.getDensity({
      conversationId: 11,
      statuses: ["observed_unfinished"],
      limit: 10,
    });
    expect(density.topUnfinished.map((item) => item.topicKey).sort()).toEqual([
      "pr-550",
      "pr-551",
    ]);
  });

  it("falls back to the persisted rowid cursor when the processed summary id is missing", async () => {
    const db = makeDb();
    createConversation(db, 16);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 16,
      summaryId: "sum_cursor_deleted_anchor",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #560 needs review",
    });
    expect(extractor.processConversation(16)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    const state = observedWork.getState(16);
    expect(state?.lastProcessedSummaryRowid).toBeGreaterThan(0);
    observedWork.upsertState({
      conversationId: 16,
      lastProcessedSummaryId: "zz_missing_anchor",
      lastProcessedSummaryCreatedAt: state?.lastProcessedSummaryCreatedAt,
      lastProcessedSummaryRowid: state?.lastProcessedSummaryRowid,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 16,
      summaryId: "aaa_cursor_later",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #561 needs review",
    });
    expect(extractor.processConversation(16)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 16,
      statuses: ["observed_unfinished"],
      limit: 10,
    });
    expect(density.topUnfinished.map((item) => item.topicKey).sort()).toEqual([
      "pr-560",
      "pr-561",
    ]);
  });

  it("chunks dense summary lookups so extraction stays under SQLite bind limits", async () => {
    const db = makeDb();
    createConversation(db, 18);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);
    const content = Array.from(
      { length: 1100 },
      (_, index) => `- Blocker: PR #${7000 + index} needs review`
    ).join("\n");

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 18,
      summaryId: "sum_dense_bind_limit",
      createdAt: "2026-04-28T05:00:00.000Z",
      content,
    });

    expect(extractor.processConversation(18, { limit: 1 })).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1100,
    });
    expect(
      observedWork.getDensity({
        conversationId: 18,
        statuses: ["observed_unfinished"],
      }).density.unfinished
    ).toBe(1100);
  });

  it("does not resolve unrelated active work that only shares the same topic key", async () => {
    const db = makeDb();
    createConversation(db, 12);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 12,
      summaryId: "sum_pr601_review",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #601 unresolved review comments",
    });
    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 12,
      summaryId: "sum_pr601_ci",
      createdAt: "2026-04-28T05:05:00.000Z",
      content: "- Blocker: PR #601 failing CI",
    });
    expect(extractor.processConversation(12)).toMatchObject({
      summariesScanned: 2,
      workItemsUpserted: 2,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 12,
      summaryId: "sum_pr601_review_resolved",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: "- Completed: PR #601 review comments resolved",
    });
    expect(extractor.processConversation(12)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 12,
      includeSources: true,
      limit: 10,
    });
    expect(density.completedHighlights.map((item) => item.title)).toContain(
      "Blocker: PR #601 unresolved review comments"
    );
    expect(density.completedHighlights.map((item) => item.title)).not.toContain(
      "Blocker: PR #601 failing CI"
    );
    expect(density.topUnfinished.map((item) => item.title)).toContain(
      "Blocker: PR #601 failing CI"
    );
  });

  it("does not resolve active work on generic word overlap alone", async () => {
    const db = makeDb();
    createConversation(db, 15);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 15,
      summaryId: "sum_generic_open",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: review thread needs follow-up",
    });
    expect(extractor.processConversation(15)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 15,
      summaryId: "sum_generic_done",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: "- Completed: review passed",
    });
    expect(extractor.processConversation(15)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 15,
      limit: 10,
    });
    expect(density.topUnfinished.map((item) => item.title)).toContain(
      "Blocker: review thread needs follow-up"
    );
    expect(density.completedHighlights.map((item) => item.title)).toContain(
      "Completed: review passed"
    );
    expect(density.completedHighlights.map((item) => item.title)).not.toContain(
      "Blocker: review thread needs follow-up"
    );
  });

  it("rolls back active-item resolution writes before retry", async () => {
    const db = makeDb();
    createConversation(db, 16);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 16,
      summaryId: "sum_active_open",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #603 review comments unresolved",
    });
    expect(extractor.processConversation(16)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 16,
      summaryId: "sum_active_resolved",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: "- Completed: PR #603 review comments resolved",
    });
    const transitionSpy = vi.spyOn(observedWork, "addTransition");
    transitionSpy.mockImplementationOnce(() => {
      throw new Error("simulated transition write failure");
    });
    expect(() => extractor.processConversation(16)).toThrow(/transition/);
    transitionSpy.mockRestore();

    expect(observedWork.getState(16)?.lastProcessedSummaryId).toBe(
      "sum_active_open"
    );
    let density = observedWork.getDensity({
      conversationId: 16,
      limit: 10,
    });
    expect(density.completedHighlights).toHaveLength(0);
    expect(density.topUnfinished[0]?.evidenceCount).toBe(1);

    expect(extractor.processConversation(16)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });
    density = observedWork.getDensity({
      conversationId: 16,
      includeTransitions: true,
      limit: 10,
    });
    expect(density.completedHighlights.map((item) => item.title)).toContain(
      "Blocker: PR #603 review comments unresolved"
    );
    expect(density.transitions?.map((transition) => transition.transitionType)).toContain(
      "resolved"
    );
  });

  it("allows stronger resolution evidence after a weaker same-summary transition", async () => {
    const db = makeDb();
    createConversation(db, 14);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 14,
      summaryId: "sum_pr602_open",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #602 review comments unresolved",
    });
    expect(extractor.processConversation(14)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 14,
      summaryId: "sum_pr602_mixed_resolution",
      createdAt: "2026-04-28T06:00:00.000Z",
      content:
        "- Ambiguous: PR #602 review comments possibly resolved\n- Completed: PR #602 review comments resolved",
    });
    expect(extractor.processConversation(14)).toMatchObject({
      summariesScanned: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 14,
      includeSources: true,
      includeTransitions: true,
      limit: 10,
    });
    expect(density.completedHighlights.map((item) => item.title)).toContain(
      "Blocker: PR #602 review comments unresolved"
    );
    const completed = density.completedHighlights.find(
      (item) => item.topicKey === "pr-602"
    );
    expect(completed?.sources?.map((source) => source.evidenceKind)).toEqual(
      expect.arrayContaining(["possible_completion", "completed"])
    );
    expect(density.transitions?.map((transition) => transition.transitionType)).toEqual(
      expect.arrayContaining(["possibly_resolved", "resolved"])
    );
  });

  it("does not downgrade completed work after later ambiguous same-summary evidence", async () => {
    const db = makeDb();
    createConversation(db, 19);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 19,
      summaryId: "sum_pr604_open",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #604 review comments unresolved",
    });
    expect(extractor.processConversation(19)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 19,
      summaryId: "sum_pr604_mixed_resolution",
      createdAt: "2026-04-28T06:00:00.000Z",
      content:
        "- Completed: PR #604 review comments resolved\n- Ambiguous: PR #604 review comments possibly resolved",
    });
    expect(extractor.processConversation(19)).toMatchObject({
      summariesScanned: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 19,
      includeTransitions: true,
      limit: 10,
    });
    expect(density.completedHighlights.map((item) => item.title)).toContain(
      "Blocker: PR #604 review comments unresolved"
    );
    expect(density.topUnfinished.map((item) => item.title)).not.toContain(
      "Blocker: PR #604 review comments unresolved"
    );
    expect(density.transitions?.map((transition) => transition.transitionType)).toEqual(
      expect.arrayContaining(["resolved", "possibly_resolved"])
    );
  });

  it("does not move last-seen time backward during observation updates", () => {
    const db = makeDb();
    createConversation(db, 20);
    const observedWork = new ObservedWorkStore(db);
    observedWork.upsertItem({
      workItemId: "work_last_seen_guard",
      conversationId: 20,
      firstSeenAt: "2026-04-28T05:00:00.000Z",
      lastSeenAt: "2026-04-28T09:00:00.000Z",
      title: "Guard last seen timestamp",
      observedStatus: "observed_unfinished",
      kind: "review",
      confidence: 0.8,
      fingerprint: "review:last-seen-guard",
    });
    observedWork.addSource({
      workItemId: "work_last_seen_guard",
      sourceType: "summary",
      sourceId: "sum_last_seen_guard",
      ordinal: 0,
      evidenceKind: "created",
    });

    observedWork.updateItemObservation({
      workItemId: "work_last_seen_guard",
      observedStatus: "observed_ambiguous",
      confidence: 0.7,
      confidenceBand: "medium",
      lastSeenAt: "2026-04-28T06:00:00.000Z",
      rationale: "Older possible resolution evidence should not move time backward.",
    });

    expect(
      observedWork.getDensity({ conversationId: 20 }).ambiguous[0]
        ?.lastSeenAt,
    ).toBe("2026-04-28T09:00:00.000Z");
  });

  it("preserves semantic evidence kinds when reinforcing extracted work", async () => {
    const db = makeDb();
    createConversation(db, 9);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 9,
      summaryId: "sum_completed_first",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Completed: PR #542 tests passed",
    });
    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 9,
      summaryId: "sum_completed_later",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: "- Completed: PR #542 tests passed",
    });

    expect(extractor.processConversation(9)).toMatchObject({
      summariesScanned: 2,
      workItemsUpserted: 2,
    });

    const density = observedWork.getDensity({
      conversationId: 9,
      includeSources: true,
    });
    expect(density.completedHighlights[0]?.sources).toEqual([
      expect.objectContaining({
        sourceId: "sum_completed_first",
        evidenceKind: "completed",
      }),
      expect.objectContaining({
        sourceId: "sum_completed_later",
        evidenceKind: "completed",
      }),
    ]);
  });

  it("records deterministic event observations and hides sources unless requested", async () => {
    const db = makeDb();
    createConversation(db, 8);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const events = new EventObservationStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork, events);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 8,
      summaryId: "sum_incident",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: [
        "- Incident: ENOTEMPTY failed during package cleanup",
        "- Retell: recalled the older Tarzan onboarding incident",
        "- Cortex config drift caused plugin validation failure",
      ].join("\n"),
    });
    expect(extractor.processConversation(8)).toMatchObject({
      summariesScanned: 1,
      eventsUpserted: 3,
    });
    expect(
      events.listObservations({
        conversationId: 8,
        eventKinds: ["operational_incident"],
        query: "cortex config drift",
      })[0]?.eventKind
    ).toBe("operational_incident");
    events.upsertObservation({
      eventId: "evt_pr_normalized",
      conversationId: 8,
      eventKind: "primary",
      title: "Normalized event key",
      queryKey: "PR #123",
      ingestTime: "2026-04-28T07:00:00.000Z",
      confidence: 0.8,
      rationale: "Direct store caller uses human PR spelling.",
      sourceType: "summary",
      sourceId: "sum_incident",
    });
    expect(
      events.listObservations({ conversationId: 8, query: "pr-123" })[0]
        ?.eventId
    ).toBe("evt_pr_normalized");
    expect(
      events.listObservations({ conversationId: 8, query: "PR 123" })[0]
        ?.eventId
    ).toBe("evt_pr_normalized");
    expect(() =>
      events.upsertObservation({
        eventId: "evt_missing_source",
        conversationId: 8,
        eventKind: "primary",
        title: "Missing source event",
        ingestTime: "2026-04-28T07:00:00.000Z",
        confidence: 0.8,
        rationale: "Direct store caller omitted the primary source.",
        sourceType: "summary",
        sourceId: " ",
      }),
    ).toThrow(/source ID/);

    const lcm = {
      getEventObservationStore: () => events,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
    } as unknown as LcmDependencies;
    const tool = createLcmEventSearchTool({
      deps,
      lcm: lcm as never,
      sessionId: "event-session",
    });

    const hidden = await tool.execute("event-hidden", {
      conversationId: 8,
      query: "enotempty",
    });
    expect((hidden.details as { accounting: { eventsIncluded: number } }).accounting.eventsIncluded).toBe(1);
    expect(JSON.stringify(hidden.details)).not.toContain("sum_incident");

    const shown = await tool.execute("event-shown", {
      conversationId: 8,
      query: "tarzan",
      includeSources: true,
    });
    expect(JSON.stringify(shown.details)).toContain("sum_incident");
    expect(JSON.stringify(shown.details)).toContain("retelling");

    const global = await tool.execute("event-global", {
      allConversations: true,
      query: "enotempty",
    });
    expect((global.details as { error?: string }).error).toMatch(
      /does not support allConversations/
    );
  });

  it("rolls back event observations with failed summary extraction", async () => {
    const db = makeDb();
    createConversation(db, 18);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const events = new EventObservationStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork, events);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 18,
      summaryId: "sum_event_retry",
      createdAt: "2026-04-28T06:00:00.000Z",
      content: "- Incident: PR #650 failed deploy blocker still needs follow-up",
    });

    const addSourceSpy = vi.spyOn(observedWork, "addSource");
    addSourceSpy.mockImplementationOnce(() => {
      throw new Error("simulated source write failure");
    });
    expect(() => extractor.processConversation(18)).toThrow(/simulated source/);
    addSourceSpy.mockRestore();

    expect(
      db.prepare(`SELECT COUNT(*) AS count FROM lcm_event_observations`).get()
    ).toMatchObject({ count: 0 });
    expect(observedWork.getState(18)).toBeNull();

    expect(extractor.processConversation(18)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
      eventsUpserted: 1,
    });
  });

  it("uses neutral evidence for ambiguous work without a completion cue", async () => {
    const db = makeDb();
    createConversation(db, 17);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 17,
      summaryId: "sum_ambiguous_investigate",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Investigate PR #562 review behavior before calling it complete",
    });
    expect(extractor.processConversation(17)).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 1,
    });

    const density = observedWork.getDensity({
      conversationId: 17,
      statuses: ["observed_ambiguous"],
      includeSources: true,
      limit: 10,
    });
    expect(density.ambiguous[0]?.sources).toEqual([
      expect.objectContaining({
        sourceId: "sum_ambiguous_investigate",
        evidenceKind: "created",
      }),
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
    store.upsertItem({
      ...base,
      workItemId: "work_decision",
      title: "Decision recorded for advisory labels",
      observedStatus: "decision_recorded",
      kind: "decision",
      fingerprint: "decision:advisory-labels",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_dismissed",
      title: "Dismiss noisy follow-up",
      observedStatus: "dismissed",
      kind: "follow_up",
      fingerprint: "follow_up:dismissed-noise",
    });
    for (const [index, workItemId] of [
      "work_done",
      "work_open",
      "work_maybe",
      "work_decision",
      "work_dismissed",
    ].entries()) {
      store.addSource({
        workItemId,
        sourceType: "summary",
        sourceId: `sum_density_${index}`,
        ordinal: index,
        evidenceKind: "created",
      });
    }

    const density = store.getDensity({ conversationId: 1, limit: 5 });
    expect(density.density).toMatchObject({
      totalObserved: 5,
      completed: 1,
      unfinished: 1,
      ambiguous: 1,
      dismissed: 1,
      decisionRecorded: 1,
    });
    expect(density.topUnfinished[0]?.title).toBe("Fix PR #14 review comments");
    expect(density.completedHighlights[0]?.title).toBe("Daily rollup tests passed");
    expect(density.ambiguous[0]?.title).toBe("Decide task bridge policy");
    expect(density.decisions[0]?.title).toBe("Decision recorded for advisory labels");
    expect(density.dismissedItems[0]?.title).toBe("Dismiss noisy follow-up");

    const decisionOnly = store.getDensity({
      conversationId: 1,
      statuses: ["decision_recorded"],
      limit: 5,
    });
    expect(decisionOnly.density.totalObserved).toBe(1);
    expect(decisionOnly.decisions[0]?.workItemId).toBe("work_decision");
    expect(decisionOnly.itemsIncluded).toBe(1);
  });

  it("does not surface source-free observed work in density results", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    const base = {
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      observedStatus: "observed_unfinished" as const,
      kind: "review" as const,
    };

    store.upsertItem({
      ...base,
      workItemId: "work_sourced",
      title: "Sourced observed item",
      fingerprint: "review:sourced",
    });
    store.addSource({
      workItemId: "work_sourced",
      sourceType: "summary",
      sourceId: "sum_sourced",
      ordinal: 0,
      evidenceKind: "created",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_unsourced",
      title: "Unsourced observed item",
      fingerprint: "review:unsourced",
    });

    const density = store.getDensity({ conversationId: 1, includeSources: true });
    expect(density.density.totalObserved).toBe(1);
    expect(density.topUnfinished.map((item) => item.workItemId)).toEqual([
      "work_sourced",
    ]);
    expect(JSON.stringify(density)).not.toContain("work_unsourced");
  });

  it("preserves temporal invariants while updating mutable metadata", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    store.upsertItem({
      workItemId: "work_temporal",
      conversationId: 1,
      ownerId: "agent:main",
      description: "Initial description",
      firstSeenAt: "2026-04-28T05:00:00.000Z",
      lastSeenAt: "2026-04-28T06:00:00.000Z",
      completedAt: "2026-04-28T06:00:00.000Z",
      completionConfidence: 0.72,
      title: "Temporal invariant test",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:temporal-invariant",
    });
    store.upsertItem({
      workItemId: "work_temporal",
      conversationId: 1,
      ownerId: "agent:reviewer",
      description: "Updated description",
      firstSeenAt: "2026-04-28T04:00:00.000Z",
      lastSeenAt: "2026-04-28T05:30:00.000Z",
      completedAt: "2026-04-28T05:30:00.000Z",
      completionConfidence: 0.91,
      title: "Temporal invariant test updated",
      observedStatus: "observed_completed",
      kind: "test",
      fingerprint: "test:temporal-invariant",
    });

    const row = db
      .prepare(
        `SELECT owner_id, description, title, first_seen_at, last_seen_at, completed_at, completion_confidence
         FROM lcm_observed_work_items
         WHERE work_item_id = ?`,
      )
      .get("work_temporal") as {
      owner_id: string;
      description: string;
      title: string;
      first_seen_at: string;
      last_seen_at: string;
      completed_at: string;
      completion_confidence: number;
    };
    expect(row).toMatchObject({
      owner_id: "agent:reviewer",
      description: "Updated description",
      title: "Temporal invariant test updated",
      first_seen_at: "2026-04-28T04:00:00.000Z",
      last_seen_at: "2026-04-28T06:00:00.000Z",
      completed_at: "2026-04-28T05:30:00.000Z",
      completion_confidence: 0.91,
    });
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

    store.addSource({
      workItemId: "work_with_sources",
      sourceType: "summary",
      sourceId: "sum_hidden",
      ordinal: 5,
      evidenceKind: "created",
    });
    const reordered = store.getDensity({ conversationId: 1, includeSources: true });
    expect(reordered.topUnfinished[0]?.sources?.[0]?.ordinal).toBe(5);
  });

  it("matches density topics against keys, titles, and rationales with escaped literals", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    const base = {
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      observedStatus: "observed_unfinished" as const,
      kind: "review" as const,
    };
    store.upsertItem({
      ...base,
      workItemId: "work_pr_topic",
      title: "Review topic-key normalization",
      topicKey: "pr-777",
      rationale: "Observed review evidence.",
      fingerprint: "review:pr-777",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_title_topic",
      title: "Lexar drive recovery remains open",
      topicKey: "storage",
      rationale: "Observed recovery evidence.",
      fingerprint: "review:lexar-title",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_rationale_topic",
      title: "Package cleanup review",
      topicKey: "cleanup",
      rationale: "ENOTEMPTY follow-up still needs verification.",
      fingerprint: "review:enotempty-rationale",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_literal_percent",
      title: "Investigate 100% CPU regression",
      topicKey: "perf",
      rationale: "Literal percent sign should be escaped.",
      fingerprint: "review:literal-percent",
    });
    store.upsertItem({
      ...base,
      workItemId: "work_not_percent",
      title: "Investigate 100x CPU regression",
      topicKey: "perf-alt",
      rationale: "Should not match a percent wildcard.",
      fingerprint: "review:not-percent",
    });

    expect(
      store.getDensity({ conversationId: 1, topic: "PR 777" }).topUnfinished
        .map((item) => item.workItemId)
    ).toEqual(["work_pr_topic"]);
    expect(
      store.getDensity({ conversationId: 1, topic: "lexar drive" }).topUnfinished
        .map((item) => item.workItemId)
    ).toEqual(["work_title_topic"]);
    expect(
      store.getDensity({ conversationId: 1, topic: "ENOTEMPTY" }).topUnfinished
        .map((item) => item.workItemId)
    ).toEqual(["work_rationale_topic"]);
    expect(
      store.getDensity({ conversationId: 1, topic: "100%" }).topUnfinished
        .map((item) => item.workItemId)
    ).toEqual(["work_literal_percent"]);
  });

  it("bounds density detail rows and only loads sources for included items", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    for (const index of [1, 2, 3]) {
      store.upsertItem({
        workItemId: `work_limited_${index}`,
        conversationId: 1,
        firstSeenAt: `2026-04-28T0${index}:00:00.000Z`,
        lastSeenAt: `2026-04-28T0${index}:30:00.000Z`,
        title: `Limited unfinished ${index}`,
        observedStatus: "observed_unfinished",
        kind: "review",
        fingerprint: `review:limited:${index}`,
      });
      store.addSource({
        workItemId: `work_limited_${index}`,
        sourceType: "summary",
        sourceId: `sum_limited_${index}`,
        ordinal: index,
        evidenceKind: "created",
      });
    }
    for (let index = 4; index <= 30; index += 1) {
      store.addSource({
        workItemId: "work_limited_3",
        sourceType: "summary",
        sourceId: `sum_limited_extra_${index}`,
        ordinal: index,
        evidenceKind: "reinforced",
      });
      store.addTransition({
        transitionId: `transition_limited_${index}`,
        workItemId: "work_limited_3",
        transitionType: "reinforced",
        fromStatus: "observed_unfinished",
        toStatus: "observed_unfinished",
        observedAt: `2026-04-28T03:${String(index).padStart(2, "0")}:00.000Z`,
        confidence: 0.7,
        rationale: "Synthetic transition used to prove detail caps.",
        sourceType: "summary",
        sourceId: `sum_limited_extra_${index}`,
      });
    }

    const density = store.getDensity({
      conversationId: 1,
      includeSources: true,
      includeTransitions: true,
      limit: 1,
    });
    expect(density.density.unfinished).toBe(3);
    expect(density.topUnfinished).toHaveLength(1);
    expect(density.itemsOmitted).toBe(2);
    expect(JSON.stringify(density)).toContain("sum_limited_3");
    expect(density.topUnfinished[0]?.sources).toHaveLength(20);
    expect(density.transitions).toHaveLength(20);
    expect(density.topUnfinished[0]?.sources?.map((source) => source.sourceId)).not.toContain(
      "sum_limited_extra_30",
    );
    expect(density.transitions?.map((transition) => transition.sourceId)).toContain(
      "sum_limited_extra_30",
    );
    expect(density.transitions?.map((transition) => transition.sourceId)).not.toContain(
      "sum_limited_extra_10",
    );
    expect(JSON.stringify(density)).not.toContain("sum_limited_1");
    expect(JSON.stringify(density)).not.toContain("sum_limited_2");
  });

  it("keeps confidence band aligned with the retained maximum confidence", () => {
    const db = makeDb();
    createConversation(db, 1);
    const store = new ObservedWorkStore(db);
    store.upsertItem({
      workItemId: "work_confidence",
      conversationId: 1,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      title: "Review confidence consistency",
      observedStatus: "observed_unfinished",
      kind: "review",
      confidence: 0.9,
      confidenceBand: "high",
      fingerprint: "review:confidence",
    });
    store.addSource({
      workItemId: "work_confidence",
      sourceType: "summary",
      sourceId: "sum_confidence",
      ordinal: 0,
      evidenceKind: "created",
    });

    store.updateItemObservation({
      workItemId: "work_confidence",
      observedStatus: "observed_unfinished",
      confidence: 0.58,
      confidenceBand: "medium",
      lastSeenAt: "2026-04-28T02:00:00.000Z",
    });

    const density = store.getDensity({ conversationId: 1 });
    expect(density.topUnfinished[0]).toMatchObject({
      confidence: 0.9,
      confidenceBand: "high",
      lastSeenAt: "2026-04-28T02:00:00.000Z",
      evidenceCount: 1,
    });
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
    store.addSource({
      workItemId: "work_yesterday",
      sourceType: "summary",
      sourceId: "sum_yesterday",
      ordinal: 0,
      evidenceKind: "created",
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

      const dateWithWhitespace = await tool.execute("density-date-trimmed", {
        conversationId: 1,
        period: "date: 2026-04-28 ",
        detailLevel: 0,
      });
      expect(
        (dateWithWhitespace.details as { density: { totalObserved: number } })
          .density.totalObserved,
      ).toBe(1);

      const week = await tool.execute("density-week", {
        conversationId: 1,
        period: "week",
        detailLevel: 0,
      });
      expect((week.details as { density: { totalObserved: number }; window?: { since?: string; before?: string } }).density.totalObserved).toBe(2);
      expect((week.details as { window?: { since?: string; before?: string } }).window).toMatchObject({
        since: "2026-04-27T00:00:00.000Z",
        before: "2026-05-04T00:00:00.000Z",
      });

      const sinceOverride = await tool.execute("density-since-override", {
        conversationId: 1,
        period: "week",
        since: "2026-04-28T00:00:00.000Z",
        detailLevel: 0,
      });
      expect((sinceOverride.details as { density: { totalObserved: number } }).density.totalObserved).toBe(1);

      const invalid = await tool.execute("density-invalid-period", {
        conversationId: 1,
        period: "quarter",
      });
      expect((invalid.details as { error?: string }).error).toContain("period must be one of");

      const global = await tool.execute("density-global", {
        allConversations: true,
      });
      expect((global.details as { error?: string }).error).toContain(
        "does not support allConversations=true",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
