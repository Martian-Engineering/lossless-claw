import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
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
        created_at TEXT NOT NULL
      );

      INSERT INTO conversations (conversation_id, session_key, agent_scope, provider, source_label) VALUES
        (10, 'agent:main:10', 'main', 'slack', 'slack:#ops'),
        (20, 'agent:cpto:20', 'cpto', 'cron', 'cron:daily');

      INSERT INTO messages (conversation_id, seq, created_at) VALUES
        (10, 1, '2026-01-02T10:00:00.000Z'),
        (10, 2, '2026-01-03T11:30:00.000Z'),
        (20, 1, '2026-01-01T09:00:00.000Z');
    `);
  } finally {
    db.close();
  }
}

describe("lcm-read list integration", () => {
  let tempDir: string;
  let dbPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-lcm-read-"));
    dbPath = join(tempDir, "lcm.db");
    seedDbFile(dbPath);
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns expected conversation objects for --json", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = runLcmReadCli(["list", "--db", dbPath, "--json"], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);

    const parsed = JSON.parse(stdout.join("\n")) as Array<Record<string, unknown>>;
    expect(parsed).toEqual([
      {
        conversationId: 10,
        agentScope: "main",
        sessionKey: "agent:main:10",
        provider: "slack",
        sourceLabel: "slack:#ops",
        messageCount: 2,
        earliestAt: "2026-01-02T10:00:00.000Z",
        latestAt: "2026-01-03T11:30:00.000Z",
      },
      {
        conversationId: 20,
        agentScope: "cpto",
        sessionKey: "agent:cpto:20",
        provider: "cron",
        sourceLabel: "cron:daily",
        messageCount: 1,
        earliestAt: "2026-01-01T09:00:00.000Z",
        latestAt: "2026-01-01T09:00:00.000Z",
      },
    ]);
  });

  it("renders stable non-JSON table output", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const code = runLcmReadCli(["list", "--db", dbPath], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(code).toBe(0);
    expect(stderr).toEqual([]);
    expect(stdout.join("\n")).toBe(
      [
        "Conversations (showing 2 of 2)",
        "",
        "  ID  Agent  Source      Messages  First              Last             ",
        "  10  main   slack:#ops  2         2026-01-02 10:00Z  2026-01-03 11:30Z",
        "  20  cpto   cron:daily  1         2026-01-01 09:00Z  2026-01-01 09:00Z",
      ].join("\n"),
    );
  });
});
