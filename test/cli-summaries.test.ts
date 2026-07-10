import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadOnlyDatabase } from "../src/cli/database.js";
import { getSummaryDetails, listSummaries } from "../src/cli/queries.js";
import { runLcmMigrations } from "../src/db/migration.js";

let directory: string;
let databasePath: string;

function seedFixture(): void {
  const db = new DatabaseSync(databasePath);
  runLcmMigrations(db, { fts5Available: false });
  db.exec(`
    INSERT INTO conversations (
      conversation_id, session_id, session_key, active, created_at, updated_at
    ) VALUES
      (1, 'session-1', 'agent:main:summaries', 1,
       '2026-07-01T00:00:00.000Z', '2026-07-04T00:00:00.000Z'),
      (2, 'session-2', 'agent:main:foreign', 1,
       '2026-07-01T00:00:00.000Z', '2026-07-04T00:00:00.000Z');

    INSERT INTO messages (
      message_id, conversation_id, seq, role, content, token_count, created_at
    ) VALUES
      (101, 1, 1, 'user', 'local source message', 80, '2026-07-01T00:00:00.000Z'),
      (201, 2, 1, 'user', 'foreign source message', 90, '2026-07-01T00:00:00.000Z');

    INSERT INTO summaries (
      summary_id, conversation_id, kind, depth, content, token_count,
      earliest_at, latest_at, descendant_count, descendant_token_count,
      source_message_token_count, created_at, file_ids, model
    ) VALUES
      ('sum-leaf-a', 1, 'leaf', 0, 'leaf A full content', 20,
       '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', 1, 80, 80,
       '2026-07-02T01:00:00.000Z', '["file-a"]', 'model-a'),
      ('sum-leaf-b', 1, 'leaf', 0, 'leaf B full content', 25,
       '2026-07-01T12:00:00.000Z', '2026-07-02T00:00:00.000Z', 1, 70, 70,
       '2026-07-02T02:00:00.000Z', '[]', 'model-a'),
      ('sum-root', 1, 'condensed', 1, 'root full content', 15,
       '2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z', 3, 150, 0,
       '2026-07-03T01:00:00.000Z', '[]', 'model-b'),
      ('sum-foreign', 2, 'leaf', 0, 'foreign content', 30,
       '2026-07-01T00:00:00.000Z', '2026-07-02T00:00:00.000Z', 1, 90, 90,
       '2026-07-02T03:00:00.000Z', '[]', 'model-c');

    INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES
      ('sum-root', 'sum-leaf-a', 0),
      ('sum-root', 'sum-leaf-b', 1),
      ('sum-root', 'sum-foreign', 2);
    INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES
      ('sum-leaf-a', 101, 0),
      ('sum-leaf-a', 201, 1);
  `);
  db.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lcm-cli-summaries-"));
  databasePath = join(directory, "lcm.db");
  seedFixture();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("listSummaries", () => {
  it("filters depth zero, kind, conversation, and coverage timestamps", () => {
    const db = openReadOnlyDatabase(databasePath);
    const page = listSummaries(db, {
      selector: { kind: "sessionKey", value: "agent:main:summaries" },
      depth: 0,
      kind: "leaf",
      time: {
        after: new Date("2026-07-02T00:00:00.000Z"),
        before: new Date("2026-07-03T00:00:00.000Z"),
      },
      limit: 10,
      includeContent: false,
    });
    db.close();

    expect(page.items.map((summary) => summary.summaryId)).toEqual(["sum-leaf-b", "sum-leaf-a"]);
    expect(page.items[1]).toEqual({
      summaryId: "sum-leaf-a",
      conversationId: 1,
      kind: "leaf",
      depth: 0,
      tokenCount: 20,
      earliestAt: "2026-07-01T00:00:00.000Z",
      latestAt: "2026-07-02T00:00:00.000Z",
      coverageAt: "2026-07-02T00:00:00.000Z",
      descendantCount: 1,
      descendantTokenCount: 80,
      sourceMessageTokenCount: 80,
      createdAt: "2026-07-02T01:00:00.000Z",
      fileIds: ["file-a"],
      model: "model-a",
      parentCount: 1,
      childCount: 0,
      sourceMessageCount: 1,
      preview: "leaf A full content",
    });
  });

  it("keyset-paginates equal coverage timestamps globally", () => {
    const db = openReadOnlyDatabase(databasePath);
    const first = listSummaries(db, {
      depth: 0,
      kind: "leaf",
      time: {},
      limit: 2,
      includeContent: true,
    });
    const second = listSummaries(db, {
      depth: 0,
      kind: "leaf",
      time: {},
      limit: 2,
      cursor: first.pagination.nextCursor ?? undefined,
      includeContent: true,
    });
    db.close();

    expect(first.items.map((summary) => summary.summaryId)).toEqual(["sum-leaf-b", "sum-leaf-a"]);
    expect(second.items.map((summary) => summary.summaryId)).toEqual(["sum-foreign"]);
    expect(second.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });
});

describe("getSummaryDetails", () => {
  it("returns intuitive parents and children without cross-conversation edges", () => {
    const db = openReadOnlyDatabase(databasePath);
    const root = getSummaryDetails(db, "sum-root");
    const leaf = getSummaryDetails(db, "sum-leaf-a");
    db.close();

    expect(root.parents).toEqual([]);
    expect(root.children.map((summary) => summary.summaryId)).toEqual(["sum-leaf-a", "sum-leaf-b"]);
    expect(leaf.parents.map((summary) => summary.summaryId)).toEqual(["sum-root"]);
    expect(leaf.children).toEqual([]);
  });

  it("returns ordered local source messages with full summary content", () => {
    const db = openReadOnlyDatabase(databasePath);
    const details = getSummaryDetails(db, "sum-leaf-a");
    db.close();

    expect(details.summary).toMatchObject({
      summaryId: "sum-leaf-a",
      content: "leaf A full content",
      fileIds: ["file-a"],
    });
    expect(details.sourceMessages).toEqual([
      {
        messageId: 101,
        seq: 1,
        role: "user",
        tokenCount: 80,
        createdAt: "2026-07-01T00:00:00.000Z",
        content: "local source message",
      },
    ]);
  });
});
