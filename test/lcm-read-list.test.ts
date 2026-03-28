import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  formatListTable,
  listConversations,
  parseListOptions,
  resolveDbPath,
  type ListOptions,
} from "../src/cli/lcm-read-list.js";

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
      created_at TEXT NOT NULL
    );
  `);

  db.exec(`
    INSERT INTO conversations (conversation_id, session_key, agent_scope, provider, source_label) VALUES
      (1, 'agent:main:1', 'main', 'slack', 'slack:#alpha'),
      (2, 'agent:cpto:2', 'cpto', 'cron', 'cron:daily'),
      (3, 'agent:main:3', 'main', 'slack', 'slack:#beta'),
      (4, 'agent:main:4', 'main', 'email', 'email:ops'),
      (5, 'agent:main:5', 'main', 'cron', 'cron:hourly');

    INSERT INTO messages (conversation_id, seq, created_at) VALUES
      (1, 1, '2026-01-01T00:00:00.000Z'),
      (1, 2, '2026-01-02T00:00:00.000Z'),
      (1, 3, '2026-01-03T00:00:00.000Z'),
      (2, 1, '2026-01-05T00:00:00.000Z'),
      (3, 1, '2025-12-31T00:00:00.000Z'),
      (3, 2, '2026-01-10T00:00:00.000Z'),
      (4, 1, '2026-02-01T00:00:00.000Z'),
      (4, 2, '2026-02-01T01:00:00.000Z'),
      (4, 3, '2026-02-02T00:00:00.000Z'),
      (4, 4, '2026-02-03T00:00:00.000Z'),
      (4, 5, '2026-02-04T00:00:00.000Z'),
      (5, 1, '2026-01-05T00:00:00.000Z');
  `);

  return db;
}

function baseOptions(overrides: Partial<ListOptions> = {}): ListOptions {
  return {
    dbPath: ":memory:",
    minMessages: 1,
    sort: "latest",
    limit: 50,
    offset: 0,
    json: false,
    ...overrides,
  };
}

describe("lcm-read list query and formatting", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = createSeededInMemoryDb();
  });

  afterEach(() => {
    db.close();
  });

  it("returns JSON-shape conversation fields", () => {
    const result = listConversations(db, baseOptions());
    expect(result.conversations[0]).toEqual({
      conversationId: 4,
      agentScope: "main",
      sessionKey: "agent:main:4",
      provider: "email",
      sourceLabel: "email:ops",
      messageCount: 5,
      earliestAt: "2026-02-01T00:00:00.000Z",
      latestAt: "2026-02-04T00:00:00.000Z",
    });
  });

  it("applies agent/provider/since/before/min-messages filters", () => {
    const agentFiltered = listConversations(db, baseOptions({ agent: "main" }));
    expect(agentFiltered.conversations.map((row) => row.conversationId)).toEqual([4, 3, 5, 1]);

    const providerFiltered = listConversations(db, baseOptions({ provider: "slack" }));
    expect(providerFiltered.conversations.map((row) => row.conversationId)).toEqual([3, 1]);

    const sinceFiltered = listConversations(
      db,
      baseOptions({ since: "2026-01-04T00:00:00.000Z", sort: "earliest" }),
    );
    expect(sinceFiltered.conversations.map((row) => row.conversationId)).toEqual([3, 2, 5, 4]);

    const beforeFiltered = listConversations(
      db,
      baseOptions({ before: "2026-01-02T00:00:00.000Z", sort: "earliest" }),
    );
    expect(beforeFiltered.conversations.map((row) => row.conversationId)).toEqual([3, 1]);

    const minMessagesFiltered = listConversations(db, baseOptions({ minMessages: 3 }));
    expect(minMessagesFiltered.conversations.map((row) => row.conversationId)).toEqual([4, 1]);
  });

  it("supports deterministic sort modes and pagination", () => {
    const latest = listConversations(db, baseOptions({ sort: "latest" }));
    expect(latest.conversations.map((row) => row.conversationId)).toEqual([4, 3, 2, 5, 1]);

    const earliest = listConversations(db, baseOptions({ sort: "earliest" }));
    expect(earliest.conversations.map((row) => row.conversationId)).toEqual([3, 1, 2, 5, 4]);

    const messages = listConversations(db, baseOptions({ sort: "messages" }));
    expect(messages.conversations.map((row) => row.conversationId)).toEqual([4, 1, 3, 2, 5]);

    const paged = listConversations(db, baseOptions({ sort: "latest", limit: 2, offset: 1 }));
    expect(paged.totalCount).toBe(5);
    expect(paged.conversations.map((row) => row.conversationId)).toEqual([3, 2]);
  });

  it("formats stable table output", () => {
    const result = listConversations(db, baseOptions({ sort: "latest", limit: 2 }));
    expect(formatListTable(result)).toBe(
      [
        "Conversations (showing 2 of 5)",
        "",
        "  ID  Agent  Source       Messages  First              Last             ",
        "  4   main   email:ops    5         2026-02-01 00:00Z  2026-02-04 00:00Z",
        "  3   main   slack:#beta  2         2025-12-31 00:00Z  2026-01-10 00:00Z",
      ].join("\n"),
    );
  });

  it("parses list options and validates values", () => {
    const parsed = parseListOptions([
      "--db",
      "~/custom.db",
      "--agent",
      "main",
      "--provider",
      "slack",
      "--since",
      "2026-01-01T00:00:00.000Z",
      "--before",
      "2026-02-01T00:00:00.000Z",
      "--min-messages",
      "2",
      "--sort",
      "messages",
      "--limit",
      "20",
      "--offset",
      "3",
      "--json",
    ]);

    expect(parsed.dbPath).toBe(resolveDbPath("~/custom.db"));
    expect(parsed.agent).toBe("main");
    expect(parsed.provider).toBe("slack");
    expect(parsed.since).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.before).toBe("2026-02-01T00:00:00.000Z");
    expect(parsed.minMessages).toBe(2);
    expect(parsed.sort).toBe("messages");
    expect(parsed.limit).toBe(20);
    expect(parsed.offset).toBe(3);
    expect(parsed.json).toBe(true);

    expect(() => parseListOptions(["--sort", "invalid"])).toThrow(/--sort/);
    expect(() => parseListOptions(["--since", "not-a-date"])).toThrow(/--since/);
    expect(() => parseListOptions(["--min-messages", "0"])).toThrow(/--min-messages/);
    expect(() => parseListOptions(["--limit", "10abc"])).toThrow(/--limit/);
    expect(() => parseListOptions(["--offset", "2xyz"])).toThrow(/--offset/);
    expect(() => parseListOptions(["--since", "2026-03-01T00:00:00.000Z", "--before", "2026-01-01T00:00:00.000Z"])).toThrow(
      /--since must be earlier than --before/,
    );
  });
});
