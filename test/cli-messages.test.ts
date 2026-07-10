import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadOnlyDatabase } from "../src/cli/database.js";
import { getFreshTail, listMessages } from "../src/cli/queries.js";
import { runLcmMigrations } from "../src/db/migration.js";

let directory: string;
let databasePath: string;

function seedFixture(): void {
  const db = new DatabaseSync(databasePath);
  runLcmMigrations(db, { fts5Available: false });
  db.exec(`
    INSERT INTO conversations (
      conversation_id, session_id, session_key, active, created_at, updated_at
    ) VALUES (1, 'session-1', 'agent:main:messages', 1,
      '2026-07-01T00:00:00.000Z', '2026-07-04T00:00:00.000Z');

    INSERT INTO messages (
      message_id, conversation_id, seq, role, content, token_count, created_at, large_content
    ) VALUES
      (101, 1, 1, 'user', 'old user message', 100, '2026-07-01T00:00:00.000Z', NULL),
      (102, 1, 2, 'assistant', 'assistant at shared time', 60, '2026-07-02T00:00:00.000Z', NULL),
      (103, 1, 3, 'tool', 'tool at shared time', 30, '2026-07-02T00:00:00.000Z', 'file-103'),
      (104, 1, 4, 'assistant', 'newest assistant message', 50, '2026-07-03T00:00:00.000Z', NULL);

    INSERT INTO context_items (conversation_id, ordinal, item_type, message_id) VALUES
      (1, 0, 'message', 101),
      (1, 1, 'message', 102),
      (1, 2, 'message', 103),
      (1, 3, 'message', 104);
  `);
  db.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lcm-cli-messages-"));
  databasePath = join(directory, "lcm.db");
  seedFixture();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("listMessages", () => {
  it("applies exact role and inclusive-start/exclusive-end time filters", () => {
    const db = openReadOnlyDatabase(databasePath);
    const page = listMessages(db, {
      selector: { kind: "sessionKey", value: "agent:main:messages" },
      roles: ["assistant", "tool"],
      time: {
        after: new Date("2026-07-02T00:00:00.000Z"),
        before: new Date("2026-07-03T00:00:00.000Z"),
      },
      limit: 10,
      includeContent: false,
    });
    db.close();

    expect(page.items.map((message) => message.messageId)).toEqual([103, 102]);
    expect(page.items[0]).toEqual({
      messageId: 103,
      conversationId: 1,
      seq: 3,
      role: "tool",
      tokenCount: 30,
      createdAt: "2026-07-02T00:00:00.000Z",
      largeContent: "file-103",
      preview: "tool at shared time",
    });
  });

  it("keyset-paginates messages with identical timestamps", () => {
    const db = openReadOnlyDatabase(databasePath);
    const first = listMessages(db, {
      selector: { kind: "conversationId", value: 1 },
      roles: ["assistant", "tool"],
      time: {
        after: new Date("2026-07-02T00:00:00.000Z"),
        before: new Date("2026-07-03T00:00:00.000Z"),
      },
      limit: 1,
      includeContent: true,
    });
    const second = listMessages(db, {
      selector: { kind: "conversationId", value: 1 },
      roles: ["assistant", "tool"],
      time: {
        after: new Date("2026-07-02T00:00:00.000Z"),
        before: new Date("2026-07-03T00:00:00.000Z"),
      },
      limit: 1,
      cursor: first.pagination.nextCursor ?? undefined,
      includeContent: true,
    });
    db.close();

    expect(first.items).toMatchObject([{ messageId: 103, content: "tool at shared time" }]);
    expect(second.items).toMatchObject([{ messageId: 102, content: "assistant at shared time" }]);
    expect(second.pagination).toMatchObject({ hasMore: false, nextCursor: null });
  });
});

describe("getFreshTail", () => {
  it("matches runtime count and token-cap semantics with newest-message protection", () => {
    const db = openReadOnlyDatabase(databasePath);
    const tail = getFreshTail(db, {
      selector: { kind: "conversationId", value: 1 },
      freshTailCount: 3,
      freshTailMaxTokens: 70,
    });
    db.close();

    expect(tail.limits).toEqual({ count: 3, maxTokens: 70 });
    expect(tail.selected).toEqual({
      messages: 1,
      tokens: 50,
      firstSeq: 4,
      lastSeq: 4,
    });
    expect(tail.conversation).toEqual({ messages: 4, tokens: 240 });
    expect(tail.messages).toMatchObject([
      { messageId: 104, seq: 4, content: "newest assistant message" },
    ]);
  });

  it("returns the current context tail in ascending prompt order", () => {
    const db = openReadOnlyDatabase(databasePath);
    const tail = getFreshTail(db, {
      selector: { kind: "conversationId", value: 1 },
      freshTailCount: 4,
      count: 2,
    });
    db.close();

    expect(tail.limits).toEqual({ count: 2, maxTokens: null });
    expect(tail.messages.map((message) => message.messageId)).toEqual([103, 104]);
    expect(tail.selected).toEqual({
      messages: 2,
      tokens: 80,
      firstSeq: 3,
      lastSeq: 4,
    });
  });
});
