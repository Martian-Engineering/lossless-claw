import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { TaskBridgeSuggestionStore } from "../src/store/task-bridge-suggestion-store.js";
import {
  createLcmTaskSuggestionReviewTool,
  createLcmTaskSuggestionsTool,
} from "../src/tools/lcm-task-suggestions-tool.js";
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
    `task-bridge-${conversationId}`,
    `agent:main:task-bridge-${conversationId}`,
    `Task bridge ${conversationId}`
  );
}

function addObservedSources(
  db: DatabaseSync,
  workItemId: string,
  sourceIds: string[]
): void {
  const observedWork = new ObservedWorkStore(db);
  sourceIds.forEach((sourceId, index) => {
    observedWork.addSource({
      workItemId,
      sourceType: "summary",
      sourceId,
      ordinal: index,
      evidenceKind: "created",
    });
  });
}

function createObservedWorkItem(
  db: DatabaseSync,
  workItemId: string,
  sourceIds?: string[],
  kind: "follow_up" | "blocker" = "follow_up"
): void {
  createConversation(db, 1);
  const observedWork = new ObservedWorkStore(db);
  observedWork.upsertItem({
    workItemId,
    conversationId: 1,
    firstSeenAt: "2026-04-28T00:00:00.000Z",
    lastSeenAt: "2026-04-28T01:00:00.000Z",
    title: `Observed work ${workItemId}`,
    observedStatus: "observed_unfinished",
    kind,
    confidence: 0.86,
    fingerprint: `observed:${workItemId}`,
  });
  addObservedSources(db, workItemId, sourceIds ?? [`sum_${workItemId}`]);
}

describe("TaskBridgeSuggestionStore", () => {
  it("creates task bridge suggestion table during migration", () => {
    const db = makeDb();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_task_bridge_suggestions'`)
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("lcm_task_bridge_suggestions");
  });

  it("stores suggestions as pending records without applying task writes", () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_1", ["sum_a", "sum_b"]);
    const store = new TaskBridgeSuggestionStore(db);
    expect(store.upsertSuggestion({
      suggestionId: "sug_1",
      workItemId: "work_1",
      suggestionKind: "create_task",
      confidence: 0.91,
      rationale: "Observed repeated unfinished blocker evidence.",
      sourceIds: ["sum_a", "sum_b", "sum_a", ""],
    })).toBe("inserted");
    expect(store.upsertSuggestion({
      suggestionId: "sug_1",
      workItemId: "work_1",
      suggestionKind: "create_task",
      confidence: 0.92,
      rationale: "Observed repeated unfinished blocker evidence again.",
      sourceIds: ["sum_a", "sum_b"],
    })).toBe("refreshed");

    const suggestions = store.listSuggestions({ status: "pending" });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      suggestionId: "sug_1",
      workItemId: "work_1",
      suggestionKind: "create_task",
      status: "pending",
      sourceIds: ["sum_a", "sum_b"],
    });
    expect(
      db
        .prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks'`)
        .get()
    ).toBeUndefined();
  });

  it("records review status without modifying external task state", () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_2", ["sum_done", "sum_done_later"]);
    const store = new TaskBridgeSuggestionStore(db);
    expect(store.upsertSuggestion({
      suggestionId: "sug_2",
      workItemId: "work_2",
      taskId: "task_123",
      suggestionKind: "mark_task_done",
      confidence: 0.97,
      rationale: "Observed explicit completion evidence.",
      sourceIds: ["sum_done"],
    })).toBe("inserted");
    expect(
      store.reviewSuggestion({
        suggestionId: "sug_2",
        status: "accepted",
        reviewedBy: "tester",
      })
    ).toBe(true);

    const accepted = store.listSuggestions({ status: "accepted" });
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({
      suggestionId: "sug_2",
      taskId: "task_123",
      status: "accepted",
      reviewedBy: "tester",
    });
  });

  it("preserves reviewed status and original creator on repeated suggestion upserts", () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_4", ["sum_initial", "sum_later"]);
    const store = new TaskBridgeSuggestionStore(db);
    expect(store.upsertSuggestion({
      suggestionId: "sug_reviewed",
      workItemId: "work_4",
      suggestionKind: "create_task",
      confidence: 0.9,
      rationale: "Initial observed task suggestion.",
      sourceIds: ["sum_initial"],
      createdBy: "first-agent",
    })).toBe("inserted");
    store.reviewSuggestion({
      suggestionId: "sug_reviewed",
      status: "dismissed",
      reviewedBy: "reviewer",
    });

    expect(store.upsertSuggestion({
      suggestionId: "sug_reviewed",
      workItemId: "work_4",
      suggestionKind: "create_task",
      confidence: 0.95,
      rationale: "Repeated record-mode run should refresh evidence only.",
      sourceIds: ["sum_later"],
      createdBy: "second-agent",
    })).toBe("preserved_reviewed");

    const dismissed = store.listSuggestions({ status: "dismissed" });
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toMatchObject({
      suggestionId: "sug_reviewed",
      status: "dismissed",
      reviewedBy: "reviewer",
      createdBy: "first-agent",
      sourceIds: ["sum_initial"],
    });
    expect(store.listSuggestions({ status: "pending" })).toHaveLength(0);
  });

  it("rejects invalid suggestion records and reports missing review targets", () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_3", ["sum_bad"]);
    const store = new TaskBridgeSuggestionStore(db);

    expect(() =>
      store.upsertSuggestion({
        suggestionId: "bad_confidence",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 1.5,
        rationale: "too confident",
        sourceIds: ["sum_bad"],
      })
    ).toThrow(/confidence/);
    expect(() =>
      store.upsertSuggestion({
        suggestionId: "bad_sources",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "missing sources",
        sourceIds: [],
      })
    ).toThrow(/source ID/);
    expect(() =>
      store.upsertSuggestion({
        suggestionId: " ",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "blank suggestion ID",
        sourceIds: ["sum_bad"],
      })
    ).toThrow(/suggestionId/);
    expect(() =>
      store.upsertSuggestion({
        suggestionId: "bad_work_item",
        workItemId: " ",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "blank work item ID",
        sourceIds: ["sum_bad"],
      })
    ).toThrow(/workItemId/);
    expect(() =>
      store.upsertSuggestion({
        suggestionId: "missing_work",
        workItemId: "missing_work_item",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "missing FK target",
        sourceIds: ["sum_bad"],
      })
    ).toThrow();
    expect(() =>
      store.upsertSuggestion({
        suggestionId: "missing_source",
        workItemId: "work_3",
        suggestionKind: "create_task",
        confidence: 0.8,
        rationale: "missing observed source",
        sourceIds: ["missing_source"],
      })
    ).toThrow(/source IDs/);
    expect(() =>
      store.upsertSuggestion({
        suggestionId: "reviewed_on_upsert",
        workItemId: "work_3",
        suggestionKind: "create_task",
        status: "accepted",
        confidence: 0.8,
        rationale: "review state attempted on upsert",
        sourceIds: ["sum_bad"],
      })
    ).toThrow(/reviewSuggestion/);
    expect(() =>
      store.upsertSuggestion({
        suggestionId: "missing_task_id",
        workItemId: "work_3",
        suggestionKind: "mark_task_done",
        confidence: 0.8,
        rationale: "targeted task action without task target",
        sourceIds: ["sum_bad"],
      })
    ).toThrow(/taskId/);
    expect(
      store.reviewSuggestion({
        suggestionId: "missing",
        status: "dismissed",
        reviewedBy: "tester",
      })
    ).toBe(false);
  });

  it("previews, records, and reviews suggestions without external task writes", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_tool");
    const observedWork = new ObservedWorkStore(db);
    const taskBridge = new TaskBridgeSuggestionStore(db);
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
    const suggestionsTool = createLcmTaskSuggestionsTool({
      deps,
      lcm: lcm as never,
      sessionId: "task-suggestion-session",
    });

    const preview = await suggestionsTool.execute("suggest-preview", {
      conversationId: 1,
    });
    expect(JSON.stringify(preview.details)).toContain("create_task");
    expect(JSON.stringify(preview.details)).not.toContain("sum_work_tool");
    expect(taskBridge.listSuggestions()).toHaveLength(0);

    const allConversations = await suggestionsTool.execute("suggest-all", {
      allConversations: true,
    });
    expect((allConversations.details as { error?: string }).error).toMatch(
      /does not support allConversations/,
    );

    const recorded = await suggestionsTool.execute("suggest-record", {
      conversationId: 1,
      mode: "record",
      includeSources: true,
    });
    expect(JSON.stringify(recorded.details)).toContain("sum_work_tool");
    const pending = taskBridge.listSuggestions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'tasks'`).get()).toBeUndefined();

    const reviewTool = createLcmTaskSuggestionReviewTool({ lcm: lcm as never });
    const reviewed = await reviewTool.execute("suggest-review", {
      suggestionId: pending[0]!.suggestionId,
      status: "dismissed",
      reviewedBy: "unit-test",
    });
    expect((reviewed.details as { changed: boolean }).changed).toBe(true);
    expect(taskBridge.listSuggestions({ status: "dismissed" })).toHaveLength(1);

    const rerecorded = await suggestionsTool.execute("suggest-record-again", {
      conversationId: 1,
      mode: "record",
    });
    expect(
      (rerecorded.details as { accounting: { recorded: number } }).accounting
        .recorded
    ).toBe(0);
    expect(
      (rerecorded.details as { accounting: { preservedReviewed: number } })
        .accounting.preservedReviewed
    ).toBe(1);
  });

  it("records unlinked blocker observations as task-creation suggestions", async () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_blocker", ["sum_blocker"], "blocker");
    const observedWork = new ObservedWorkStore(db);
    const taskBridge = new TaskBridgeSuggestionStore(db);
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
    const suggestionsTool = createLcmTaskSuggestionsTool({
      deps,
      lcm: lcm as never,
      sessionId: "task-suggestion-session",
    });

    const preview = await suggestionsTool.execute("suggest-preview", {
      conversationId: 1,
      kinds: ["blocker"],
    });
    expect(JSON.stringify(preview.details)).toContain("create_task");
    expect(JSON.stringify(preview.details)).not.toContain("mark_task_blocked");

    await suggestionsTool.execute("suggest-record", {
      conversationId: 1,
      kinds: ["blocker"],
      mode: "record",
    });
    const pending = taskBridge.listSuggestions({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.suggestionKind).toBe("create_task");
  });
});
