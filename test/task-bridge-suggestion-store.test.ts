import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { TaskBridgeSuggestionStore } from "../src/store/task-bridge-suggestion-store.js";

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

function createObservedWorkItem(db: DatabaseSync, workItemId: string): void {
  createConversation(db, 1);
  const observedWork = new ObservedWorkStore(db);
  observedWork.upsertItem({
    workItemId,
    conversationId: 1,
    firstSeenAt: "2026-04-28T00:00:00.000Z",
    lastSeenAt: "2026-04-28T01:00:00.000Z",
    title: `Observed work ${workItemId}`,
    observedStatus: "observed_unfinished",
    kind: "follow_up",
    confidence: 0.86,
    fingerprint: `observed:${workItemId}`,
  });
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
    createObservedWorkItem(db, "work_1");
    const store = new TaskBridgeSuggestionStore(db);
    store.upsertSuggestion({
      suggestionId: "sug_1",
      workItemId: "work_1",
      suggestionKind: "create_task",
      confidence: 0.91,
      rationale: "Observed repeated unfinished blocker evidence.",
      sourceIds: ["sum_a", "sum_b", "sum_a", ""],
    });

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
    createObservedWorkItem(db, "work_2");
    const store = new TaskBridgeSuggestionStore(db);
    store.upsertSuggestion({
      suggestionId: "sug_2",
      workItemId: "work_2",
      taskId: "task_123",
      suggestionKind: "mark_task_done",
      confidence: 0.97,
      rationale: "Observed explicit completion evidence.",
      sourceIds: ["sum_done"],
    });
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
    createObservedWorkItem(db, "work_4");
    const store = new TaskBridgeSuggestionStore(db);
    store.upsertSuggestion({
      suggestionId: "sug_reviewed",
      workItemId: "work_4",
      suggestionKind: "create_task",
      confidence: 0.9,
      rationale: "Initial observed task suggestion.",
      sourceIds: ["sum_initial"],
      createdBy: "first-agent",
    });
    store.reviewSuggestion({
      suggestionId: "sug_reviewed",
      status: "dismissed",
      reviewedBy: "reviewer",
    });

    store.upsertSuggestion({
      suggestionId: "sug_reviewed",
      workItemId: "work_4",
      suggestionKind: "create_task",
      confidence: 0.95,
      rationale: "Repeated record-mode run should refresh evidence only.",
      sourceIds: ["sum_later"],
      createdBy: "second-agent",
    });

    const dismissed = store.listSuggestions({ status: "dismissed" });
    expect(dismissed).toHaveLength(1);
    expect(dismissed[0]).toMatchObject({
      suggestionId: "sug_reviewed",
      status: "dismissed",
      reviewedBy: "reviewer",
      createdBy: "first-agent",
      sourceIds: ["sum_later"],
    });
    expect(store.listSuggestions({ status: "pending" })).toHaveLength(0);
  });

  it("rejects invalid suggestion records and reports missing review targets", () => {
    const db = makeDb();
    createObservedWorkItem(db, "work_3");
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
    expect(
      store.reviewSuggestion({
        suggestionId: "missing",
        status: "dismissed",
        reviewedBy: "tester",
      })
    ).toBe(false);
  });
});
