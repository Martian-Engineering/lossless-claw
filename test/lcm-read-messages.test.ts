import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  formatMessagesOutput,
  parseMessagesOptions,
  readConversationMessages,
  type MessageOptions,
} from "../src/cli/lcm-read-messages.js";

function createSeededInMemoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE conversations (
      conversation_id INTEGER PRIMARY KEY,
      session_key TEXT,
      agent_scope TEXT,
      provider TEXT,
      source_label TEXT
    );

    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      seq INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT,
      token_count INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE message_parts (
      part_id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      part_type TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      text_content TEXT,
      tool_input TEXT,
      tool_output TEXT,
      tool_error TEXT
    );
  `);

  db.exec(`
    INSERT INTO conversations (conversation_id, session_key, agent_scope, provider, source_label) VALUES
      (42, 'agent:main:42', 'main', 'slack', 'slack:#ops');

    INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES
      (42, 1, 'user', 'hello user', 4, '2026-03-01T10:00:00.000Z'),
      (42, 2, 'assistant', 'assistant reply', 8, '2026-03-01T10:01:00.000Z'),
      (42, 3, 'tool', 'tool output', 3, '2026-03-01T10:02:00.000Z'),
      (42, 4, 'assistant', 'later assistant', 6, '2026-03-01T10:03:00.000Z'),
      (42, 5, 'system', 'system note', 2, '2026-03-01T10:04:00.000Z'),
      (42, 6, 'assistant', '', 5, '2026-03-01T10:05:00.000Z');

    INSERT INTO message_parts (
      part_id, message_id, session_id, part_type, ordinal, text_content, tool_input, tool_output, tool_error
    ) VALUES
      ('part-1', 6, 'agent:main:42', 'tool', 0, NULL, '{"query":"status"}', NULL, NULL);
  `);

  return db;
}

function baseOptions(overrides: Partial<MessageOptions> = {}): MessageOptions {
  return {
    afterSeq: 0,
    limit: 50,
    noToolMessages: false,
    maxChars: 4000,
    json: false,
    ...overrides,
  };
}

describe("lcm-read messages pagination and formatting", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createSeededInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns ascending seq messages with expected JSON shape metadata", () => {
    const page = readConversationMessages(db, 42, baseOptions({ limit: 3 }));
    expect(page.conversation).toEqual({
      id: 42,
      agent: "main",
      source: "slack:#ops",
    });
    expect(page.messages.map((message) => message.seq)).toEqual([1, 2, 3]);
    expect(page.tokensReturned).toBe(15);
    expect(page.nextCursor).toBe(3);
    expect(page.totalMessages).toBe(6);
  });

  it("applies after-seq, limit, and token threshold with first boundary winning", () => {
    const afterSeq = readConversationMessages(db, 42, baseOptions({ afterSeq: 2, limit: 3 }));
    expect(afterSeq.messages.map((message) => message.seq)).toEqual([3, 4, 5]);
    expect(afterSeq.nextCursor).toBe(5);

    const limitFirst = readConversationMessages(db, 42, baseOptions({ limit: 2, maxTokens: 100 }));
    expect(limitFirst.messages.map((message) => message.seq)).toEqual([1, 2]);
    expect(limitFirst.tokensReturned).toBe(12);
    expect(limitFirst.nextCursor).toBe(2);

    const tokensFirst = readConversationMessages(db, 42, baseOptions({ limit: 10, maxTokens: 10 }));
    expect(tokensFirst.messages.map((message) => message.seq)).toEqual([1]);
    expect(tokensFirst.tokensReturned).toBe(4);
    expect(tokensFirst.nextCursor).toBe(1);
  });

  it("enforces role/no-tool/max-chars filtering", () => {
    const roleOnly = readConversationMessages(db, 42, baseOptions({ role: "assistant" }));
    expect(roleOnly.messages.map((message) => message.seq)).toEqual([2, 4, 6]);

    const noTool = readConversationMessages(db, 42, baseOptions({ noToolMessages: true }));
    expect(noTool.messages.some((message) => message.role === "tool")).toBe(false);
    expect(noTool.messages.map((message) => message.seq)).toEqual([1, 2, 4, 5]);

    const partBacked = readConversationMessages(db, 42, baseOptions({ afterSeq: 5, limit: 1 }));
    expect(partBacked.messages[0]?.content).toBe('{"query":"status"}');

    const truncated = readConversationMessages(db, 42, baseOptions({ maxChars: 5, limit: 1 }));
    expect(truncated.messages[0]?.content).toBe("hello");
  });

  it("formats non-JSON output with header, seq range, token total, and cursor hint", () => {
    const page = readConversationMessages(db, 42, baseOptions({ limit: 2 }));
    expect(formatMessagesOutput(page)).toBe(
      [
        "Conversation 42 | main | slack:#ops",
        "Messages 1-2 of 6 | Tokens: 12 | Next cursor: --after-seq 2",
        "",
        "[1] user (2026-03-01 10:00Z)",
        "hello user",
        "",
        "[2] assistant (2026-03-01 10:01Z)",
        "assistant reply",
        "",
        "--- next: lcm-read messages 42 --after-seq 2 ---",
      ].join("\n"),
    );
  });

  it("parses options with validation and hard limit cap", () => {
    const parsed = parseMessagesOptions([
      "--after-seq",
      "12",
      "--limit",
      "9999",
      "--max-tokens",
      "50",
      "--role",
      "assistant",
      "--no-tool-messages",
      "--max-chars",
      "32",
      "--json",
    ]);

    expect(parsed).toEqual({
      afterSeq: 12,
      limit: 500,
      maxTokens: 50,
      role: "assistant",
      noToolMessages: true,
      maxChars: 32,
      json: true,
    });

    expect(() => parseMessagesOptions(["--after-seq", "-1"])).toThrow(/--after-seq/);
    expect(() => parseMessagesOptions(["--limit", "0"])).toThrow(/--limit/);
    expect(() => parseMessagesOptions(["--limit", "10abc"])).toThrow(/--limit/);
    expect(() => parseMessagesOptions(["--max-tokens", "0"])).toThrow(/--max-tokens/);
    expect(() => parseMessagesOptions(["--after-seq", "1x"])).toThrow(/--after-seq/);
    expect(() => parseMessagesOptions(["--role", "bad"])).toThrow(/--role/);
    expect(() => parseMessagesOptions(["--max-chars", "0"])).toThrow(/--max-chars/);
  });
});
