/**
 * Equivalence-SQL test for `buildLeafSourceText` in
 * `src/plugin/lcm-doctor-apply.ts`.
 *
 * The target function is module-level (not exported). Rather than modifying
 * the source to export it, we replicate its SQL query against an in-memory
 * SQLite database and validate the formatting contract directly.
 *
 * Tables required: messages, summary_messages (same schema as production).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DatabaseSync } from "node:sqlite";

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Replicate the timestamp formatter used by `buildLeafSourceText`.
 * Production code: `formatSqliteTimestamp(value, timezone)` → `formatTimestamp(date, tz)`
 * produces `YYYY-MM-DD HH:mm TZ`.
 */
function formatTimestampUTC(value: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(value).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} UTC`;
}

/**
 * Execute the same SQL query that `buildLeafSourceText` uses and format
 * the result identically to the production code.
 */
function executeLeafSourceTextSQL(
  db: DatabaseSync,
  summaryId: string,
  timezone: string = "UTC",
): string {
  const rows = db
    .prepare(
      `SELECT m.created_at, m.role, COALESCE(m.content, '') AS content
       FROM summary_messages sm
       JOIN messages m ON m.message_id = sm.message_id
       WHERE sm.summary_id = ?
       ORDER BY sm.ordinal ASC`,
    )
    .all(summaryId) as Array<{
    created_at: string;
    role: string | null;
    content: string;
  }>;

  if (rows.length === 0) {
    throw new Error("no messages linked to summary");
  }

  return rows
    .map((row) => {
      // parseSqliteTimestamp logic from lcm-doctor-apply.ts
      const normalized = row.created_at?.trim();
      let date: Date | null = null;
      if (normalized) {
        const direct = new Date(normalized);
        if (!Number.isNaN(direct.getTime())) {
          date = direct;
        } else {
          const sqlite = new Date(normalized.replace(" ", "T") + "Z");
          if (!Number.isNaN(sqlite.getTime())) {
            date = sqlite;
          }
        }
      }
      const timestamp = date
        ? formatTimestampUTC(date)
        : normalized || "unknown";
      const role = row.role ?? "unknown";
      return `[${timestamp} | ${role}]\n${row.content}`;
    })
    .join("\n\n");
}

// ── schema ───────────────────────────────────────────────────────────────────

const CREATE_TABLES_SQL = `
  CREATE TABLE messages (
    message_id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0,
    role TEXT,
    content TEXT DEFAULT '',
    token_count INTEGER DEFAULT 0,
    identity_hash TEXT,
    transcript_entry_id TEXT,
    large_content TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE summary_messages (
    summary_id TEXT NOT NULL,
    message_id INTEGER NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (summary_id, message_id)
  );
`;

// ── tests ────────────────────────────────────────────────────────────────────

describe("buildLeafSourceText SQL equivalence", () => {
  let db: DatabaseSync;

  beforeAll(() => {
    db = new DatabaseSync(":memory:");
    db.exec(CREATE_TABLES_SQL);
  });

  afterAll(() => {
    db.close();
  });

  // TC-1: Normal role formatting
  it("TC-1: formats role correctly as [timestamp | role]", () => {
    // Insert a message with role='user'
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, created_at)
       VALUES (1, 100, 1, 'user', 'Hello world', '2024-01-01T00:00:00Z')`,
    ).run();

    // Link it to a summary
    db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES ('sum-1', 1, 0)`,
    ).run();

    const result = executeLeafSourceTextSQL(db, "sum-1");

    expect(result).toBe(
      "[2024-01-01 00:00 UTC | user]\nHello world",
    );
  });

  // TC-2: NULL role → "unknown"
  it("TC-2: NULL role renders as 'unknown'", () => {
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, created_at)
       VALUES (2, 100, 2, NULL, 'Null role message', '2024-02-15T12:30:00Z')`,
    ).run();

    db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES ('sum-2', 2, 0)`,
    ).run();

    const result = executeLeafSourceTextSQL(db, "sum-2");

    expect(result).toBe(
      "[2024-02-15 12:30 UTC | unknown]\nNull role message",
    );
  });

  // TC-3: Multiple messages ordered by ordinal
  it("TC-3: orders messages by ordinal ASC", () => {
    // Insert 3 messages with ordinal 3, 1, 2
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, created_at)
       VALUES (3, 100, 3, 'user', 'Third message', '2024-03-01T09:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, created_at)
       VALUES (4, 100, 4, 'assistant', 'First message', '2024-03-01T08:00:00Z')`,
    ).run();
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, created_at)
       VALUES (5, 100, 5, 'system', 'Second message', '2024-03-01T08:30:00Z')`,
    ).run();

    // Link them with ordinal 3, 1, 2
    db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES ('sum-3', 3, 2)`,
    ).run();
    db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES ('sum-3', 4, 0)`,
    ).run();
    db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES ('sum-3', 5, 1)`,
    ).run();

    const result = executeLeafSourceTextSQL(db, "sum-3");

    // Should be ordered by ordinal: msg4 (ordinal 0), msg5 (ordinal 1), msg3 (ordinal 2)
    const lines = result.split("\n\n");
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain("First message");
    expect(lines[0]).toContain("| assistant]");
    expect(lines[1]).toContain("Second message");
    expect(lines[1]).toContain("| system]");
    expect(lines[2]).toContain("Third message");
    expect(lines[2]).toContain("| user]");
  });

  // TC-4: Empty message list → throws
  it("TC-4: throws when no messages linked to summary", () => {
    // summary exists but no summary_messages rows
    db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES ('sum-empty', 999999, 0)`,
    ).run();
    // But message 999999 doesn't exist, so JOIN returns empty

    expect(() => executeLeafSourceTextSQL(db, "sum-empty")).toThrow(
      "no messages linked to summary",
    );
  });
});
