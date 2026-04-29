import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkExtractor } from "../src/observed-work-extractor.js";
import { EventObservationStore } from "../src/store/event-observation-store.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { TaskBridgeSuggestionStore } from "../src/store/task-bridge-suggestion-store.js";
import { createLcmEventSearchTool } from "../src/tools/lcm-event-search-tool.js";
import {
  createLcmTaskSuggestionReviewTool,
  createLcmTaskSuggestionsTool,
} from "../src/tools/lcm-task-suggestions-tool.js";
import type { LcmDependencies } from "../src/types.js";

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

function createConversation(db: DatabaseSync, conversationId: number): void {
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key, title)
     VALUES (?, ?, ?, ?)`,
  ).run(
    conversationId,
    `ultimate-${conversationId}`,
    `agent:main:ultimate-${conversationId}`,
    `Ultimate ${conversationId}`,
  );
}

async function insertLeafSummary(input: {
  db: DatabaseSync;
  summaryStore: SummaryStore;
  summaryId: string;
  conversationId: number;
  content: string;
  createdAt: string;
  latestAt?: string;
}): Promise<void> {
  await input.summaryStore.insertSummary({
    summaryId: input.summaryId,
    conversationId: input.conversationId,
    kind: "leaf",
    depth: 0,
    content: input.content,
    tokenCount: 50,
    sourceMessageTokenCount: 80,
    latestAt: new Date(input.latestAt ?? input.createdAt),
  });
  input.db.prepare(`UPDATE summaries SET created_at = ? WHERE summary_id = ?`)
    .run(input.createdAt, input.summaryId);
}

describe("LCM ultimate architecture implementation", () => {
  it("extracts observed work incrementally from leaf summaries without task authority", async () => {
    const db = makeDb();
    createConversation(db, 1);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const events = new EventObservationStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork, events);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 1,
      summaryId: "sum_001",
      createdAt: "2026-04-28T01:00:00.000Z",
      content: [
        "- Completed: implemented PR #516 daily rollup read-only tests passed",
        "- Blocker: PR #517 still has unresolved review comments",
        "- Decision: keep task bridge suggestion-only and inert",
        "- Incident: restart failed during deploy and root cause was under investigation",
      ].join("\n"),
    });

    const first = extractor.processConversation(1);
    expect(first).toMatchObject({
      summariesScanned: 1,
      workItemsUpserted: 4,
      eventsUpserted: 2,
    });

    const density = observedWork.getDensity({ conversationId: 1, topic: "PR #517", includeSources: false });
    expect(density.density.unfinished).toBe(1);
    expect(density.topUnfinished[0]?.title).toContain("PR #517");
    expect(density.topUnfinished[0]?.sources).toBeUndefined();

    const state = observedWork.getState(1);
    expect(state?.lastProcessedSummaryId).toBe("sum_001");
    expect(state?.pendingRebuild).toBe(false);

    const second = extractor.processConversation(1);
    expect(second).toMatchObject({
      summariesScanned: 0,
      workItemsUpserted: 0,
      eventsUpserted: 0,
    });

    const unfinishedBefore = observedWork.getDensity({ conversationId: 1, topic: "pr-517" }).topUnfinished[0];
    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 1,
      summaryId: "sum_002",
      createdAt: "2026-04-28T02:00:00.000Z",
      content: "- Blocker: PR #517 still has unresolved review comments",
    });
    const third = extractor.processConversation(1);
    expect(third.summariesScanned).toBe(1);
    const unfinishedAfter = observedWork.getDensity({ conversationId: 1, topic: "pr-517" }).topUnfinished[0];
    expect(unfinishedAfter?.evidenceCount).toBeGreaterThan(unfinishedBefore?.evidenceCount ?? 0);
    expect(unfinishedAfter?.confidence).toBeGreaterThan(unfinishedBefore?.confidence ?? 0);

    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks'`).get()).toBeUndefined();
  });

  it("uses a rowid cursor so same-second summary IDs are not skipped", async () => {
    const db = makeDb();
    createConversation(db, 7);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const events = new EventObservationStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork, events);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 7,
      summaryId: "sum_z_first",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #540 still has unresolved review comments",
    });
    expect(extractor.processConversation(7).summariesScanned).toBe(1);

    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 7,
      summaryId: "sum_a_later",
      createdAt: "2026-04-28T05:00:00.000Z",
      content: "- Blocker: PR #541 still has failing CI",
    });
    expect(extractor.processConversation(7).summariesScanned).toBe(1);

    const density = observedWork.getDensity({
      conversationId: 7,
      statuses: ["observed_unfinished"],
    });
    expect(density.density.unfinished).toBe(2);
  });

  it("searches event observations with source IDs hidden unless requested", async () => {
    const db = makeDb();
    createConversation(db, 2);
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const observedWork = new ObservedWorkStore(db);
    const events = new EventObservationStore(db);
    const extractor = new ObservedWorkExtractor(db, observedWork, events);
    await insertLeafSummary({
      db,
      summaryStore,
      conversationId: 2,
      summaryId: "sum_event",
      createdAt: "2026-04-28T03:00:00.000Z",
      content: "- First occurrence: Eric ENOTEMPTY incident was reported after restart",
    });
    extractor.processConversation(2);

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
    const tool = createLcmEventSearchTool({ deps, lcm: lcm as never });

    const hidden = await tool.execute("events-hidden", {
      conversationId: 2,
      query: "ENOTEMPTY",
      first: true,
    });
    expect(JSON.stringify(hidden.details)).toContain("ENOTEMPTY");
    expect(JSON.stringify(hidden.details)).not.toContain("sum_event");

    const shown = await tool.execute("events-shown", {
      conversationId: 2,
      query: "ENOTEMPTY",
      first: true,
      includeSources: true,
    });
    expect(JSON.stringify(shown.details)).toContain("sum_event");
  });

  it("previews, records, and reviews inert task suggestions without external task writes", async () => {
    const db = makeDb();
    createConversation(db, 3);
    const observedWork = new ObservedWorkStore(db);
    const taskBridge = new TaskBridgeSuggestionStore(db);
    observedWork.upsertItem({
      workItemId: "work_blocked",
      conversationId: 3,
      firstSeenAt: "2026-04-28T00:00:00.000Z",
      lastSeenAt: "2026-04-28T01:00:00.000Z",
      title: "PR #518 task bridge review remains blocked",
      observedStatus: "observed_unfinished",
      kind: "blocker",
      confidence: 0.88,
      confidenceBand: "high",
      rationale: "Observed blocker evidence.",
      topicKey: "pr-518",
      fingerprint: "blocked:pr-518",
      evidenceCount: 1,
    });
    observedWork.addSource({
      workItemId: "work_blocked",
      sourceType: "summary",
      sourceId: "sum_blocked",
      ordinal: 0,
      evidenceKind: "created",
    });

    const lcm = {
      getObservedWorkStore: () => observedWork,
      getTaskBridgeSuggestionStore: () => taskBridge,
      getConversationStore: () => ({
        getConversationBySessionKey: async () => null,
        getConversationBySessionId: async () => null,
      }),
    };
    const deps = {
      resolveSessionIdFromSessionKey: async () => undefined,
    } as unknown as LcmDependencies;
    const suggestionsTool = createLcmTaskSuggestionsTool({ deps, lcm: lcm as never });
    const preview = await suggestionsTool.execute("suggest-preview", {
      conversationId: 3,
      topic: "PR #518",
    });
    expect(JSON.stringify(preview.details)).toContain("mark_task_blocked");
    expect(JSON.stringify(preview.details)).not.toContain("sum_blocked");
    expect(taskBridge.listSuggestions()).toHaveLength(0);

    const recorded = await suggestionsTool.execute("suggest-record", {
      conversationId: 3,
      topic: "PR #518",
      mode: "record",
      includeSources: true,
    });
    expect(JSON.stringify(recorded.details)).toContain("sum_blocked");
    const pending = taskBridge.listSuggestions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.suggestionKind).toBe("mark_task_blocked");
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks'`).get()).toBeUndefined();

    const reviewTool = createLcmTaskSuggestionReviewTool({ lcm: lcm as never });
    const reviewed = await reviewTool.execute("suggest-review", {
      suggestionId: pending[0]!.suggestionId,
      status: "dismissed",
      reviewedBy: "unit-test",
    });
    expect((reviewed.details as { changed: boolean }).changed).toBe(true);
    expect(taskBridge.listSuggestions({ status: "dismissed" })).toHaveLength(1);
  });
});
