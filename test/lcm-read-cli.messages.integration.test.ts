import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmReadCli } from "../src/cli/lcm-read.js";

function seedDbFile(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
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

      INSERT INTO conversations (conversation_id, session_key, agent_scope, provider, source_label) VALUES
        (77, 'agent:cpto:77', 'cpto', 'slack', 'slack:#channel');

      INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at) VALUES
        (77, 1, 'user', 'line one', 4, '2026-01-02T10:00:00.000Z'),
        (77, 2, 'assistant', 'line two', 7, '2026-01-02T10:01:00.000Z'),
        (77, 3, 'tool', 'line three', 2, '2026-01-02T10:02:00.000Z');
    `);
  } finally {
    db.close();
  }
}

describe("lcm-read messages integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-lcm-read-messages-"));
    dbPath = join(tempDir, "lcm.db");
    seedDbFile(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns expected JSON envelope for messages", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = runLcmReadCli(["messages", "77", "--db", dbPath, "--limit", "2", "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    const parsed = JSON.parse(stdout.join("\n")) as Record<string, unknown>;
    expect(parsed).toEqual({
      conversation: { id: 77, agent: "cpto", source: "slack:#channel" },
      messages: [
        {
          seq: 1,
          role: "user",
          content: "line one",
          tokenCount: 4,
          createdAt: "2026-01-02T10:00:00.000Z",
        },
        {
          seq: 2,
          role: "assistant",
          content: "line two",
          tokenCount: 7,
          createdAt: "2026-01-02T10:01:00.000Z",
        },
      ],
      tokensReturned: 11,
      nextCursor: 2,
      totalMessages: 3,
    });
  });

  it("renders human-readable output with next cursor hint", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = runLcmReadCli(["messages", "77", "--db", dbPath, "--limit", "2"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toBe(
      [
        "Conversation 77 | cpto | slack:#channel",
        "Messages 1-2 of 3 | Tokens: 11 | Next cursor: --after-seq 2",
        "",
        "[1] user (2026-01-02 10:00Z)",
        "line one",
        "",
        "[2] assistant (2026-01-02 10:01Z)",
        "line two",
        "",
        "--- next: lcm-read messages 77 --after-seq 2 ---",
      ].join("\n"),
    );
  });

  it("rejects partially numeric conversation ids", () => {
    expect(() => runLcmReadCli(["messages", "77abc", "--db", dbPath])).toThrow(
      /conversationId must be a positive integer/,
    );
  });
});
