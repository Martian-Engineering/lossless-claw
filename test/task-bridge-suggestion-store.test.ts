import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { ObservedWorkStore } from "../src/store/observed-work-store.js";
import { TaskBridgeSuggestionStore } from "../src/store/task-bridge-suggestion-store.js";

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

    store.upsertSuggestion({
      suggestionId: "sug_2",
      workItemId: "work_2",
      taskId: "task_123",
      suggestionKind: "mark_task_done",
      confidence: 0.99,
      rationale: "A later deterministic scan saw the same suggestion again.",
      sourceIds: ["sum_done", "sum_done_later"],
      createdBy: "second-writer",
    });
    const stillAccepted = store.listSuggestions({ status: "accepted" });
    expect(stillAccepted).toHaveLength(1);
    expect(stillAccepted[0]).toMatchObject({
      suggestionId: "sug_2",
      status: "accepted",
      taskId: "task_123",
      createdBy: "lcm_observed",
      reviewedBy: "tester",
      sourceIds: ["sum_done", "sum_done_later"],
    });
    expect(store.listSuggestions({ status: "pending" })).toHaveLength(0);

    expect(
      store.reviewSuggestion({
        suggestionId: "sug_2",
        status: "dismissed",
      })
    ).toBe(true);
    const dismissed = store.listSuggestions({ status: "dismissed" });
    expect(dismissed[0]).toMatchObject({
      suggestionId: "sug_2",
      reviewedBy: "tester",
    });
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
    expect(
      store.reviewSuggestion({
        suggestionId: "missing",
        status: "dismissed",
        reviewedBy: "tester",
      })
    ).toBe(false);
  });
});
