import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../src/cli/main.js";
import { runLcmMigrations } from "../src/db/migration.js";

let directory: string;
let databasePath: string;
let configPath: string;

function seedFixture(): void {
  const db = new DatabaseSync(databasePath);
  runLcmMigrations(db, { fts5Available: false });
  db.exec(`
    INSERT INTO conversations (
      conversation_id, session_id, session_key, active, created_at, updated_at
    ) VALUES (1, 'session-cli', 'agent:main:cli', 1,
      '2026-07-01T00:00:00.000Z', '2026-07-03T00:00:00.000Z');
    INSERT INTO messages (
      message_id, conversation_id, seq, role, content, token_count, created_at
    ) VALUES
      (101, 1, 1, 'user', 'CLI source message', 40, '2026-07-01T00:00:00.000Z'),
      (102, 1, 2, 'assistant', 'CLI fresh message', 30, '2026-07-02T00:00:00.000Z');
    INSERT INTO summaries (
      summary_id, conversation_id, kind, depth, content, token_count,
      earliest_at, latest_at, descendant_count, descendant_token_count,
      source_message_token_count, created_at, file_ids, model
    ) VALUES ('sum-cli', 1, 'leaf', 0, 'CLI summary', 10,
      '2026-07-01T00:00:00.000Z', '2026-07-01T00:00:00.000Z', 1, 40, 40,
      '2026-07-01T01:00:00.000Z', '[]', 'model-cli');
    INSERT INTO summary_messages (summary_id, message_id, ordinal)
      VALUES ('sum-cli', 101, 0);
    INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
      VALUES (1, 0, 'summary', 'sum-cli');
    INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
      VALUES (1, 1, 'message', 102);
  `);
  db.close();

  writeFileSync(configPath, `${JSON.stringify({
    plugins: {
      entries: {
        "lossless-claw": {
          config: { databasePath, freshTailCount: 1 },
        },
      },
    },
  }, null, 2)}\n`, { mode: 0o600 });
}

function invoke(args: string[]): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  let stdout = "";
  let stderr = "";
  const exitCode = runCli(args, {
    env: { HOME: directory, OPENCLAW_CONFIG_PATH: configPath },
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { exitCode, stdout, stderr };
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lcm-cli-main-"));
  databasePath = join(directory, "lcm.db");
  configPath = join(directory, "openclaw.json");
  seedFixture();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("runCli", () => {
  it("dispatches status with config, path, size, and database diagnostics", () => {
    const result = invoke(["status", "--pretty"]);
    const envelope = JSON.parse(result.stdout);

    expect(result).toMatchObject({ exitCode: 0, stderr: "" });
    expect(envelope).toMatchObject({
      ok: true,
      command: "status",
      data: {
        databaseSizeBytes: expect.any(Number),
        freshTail: { count: 1, maxTokens: null },
        status: {
          conversations: { total: 1, active: 1 },
          messages: { count: 2, tokens: 70 },
          summaries: { count: 1, tokens: 10 },
        },
      },
      meta: { databasePath, configPath },
    });
  });

  it.each([
    [
      ["conversations", "list", "--limit", "1"],
      "conversations.list",
      (data: unknown) => expect(data).toMatchObject({ items: [{ conversationId: 1 }] }),
    ],
    [
      ["conversations", "show", "--session-key", "agent:main:cli"],
      "conversations.show",
      (data: unknown) => expect(data).toMatchObject({ conversation: { conversationId: 1 } }),
    ],
    [
      ["messages", "list", "--conversation-id", "1", "--include-content"],
      "messages.list",
      (data: unknown) => expect(data).toMatchObject({
        items: expect.arrayContaining([expect.objectContaining({ messageId: 102 })]),
      }),
    ],
    [
      ["messages", "tail", "--conversation-id", "1"],
      "messages.tail",
      (data: unknown) => expect(data).toMatchObject({ selected: { messages: 1, tokens: 30 } }),
    ],
    [
      ["summaries", "list", "--depth", "0"],
      "summaries.list",
      (data: unknown) => expect(data).toMatchObject({ items: [{ summaryId: "sum-cli" }] }),
    ],
    [
      ["summaries", "show", "sum-cli"],
      "summaries.show",
      (data: unknown) => expect(data).toMatchObject({ summary: { content: "CLI summary" } }),
    ],
    [
      ["config", "get", "freshTailCount"],
      "config.get",
      (data: unknown) => expect(data).toMatchObject({ rawValue: 1, effectiveValue: 1 }),
    ],
  ])("dispatches %s", (args, command, assertData) => {
    const result = invoke(args as string[]);
    const envelope = JSON.parse(result.stdout);
    expect(result.exitCode).toBe(0);
    expect(envelope.command).toBe(command);
    assertData(envelope.data);
  });

  it("returns a read-only reserved doctor namespace", () => {
    const result = invoke(["doctor"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      command: "doctor",
      data: { available: false, databaseReadOnly: true },
    });
  });

  it("uses the invocation state directory for effective config defaults", () => {
    writeFileSync(configPath, `${JSON.stringify({
      plugins: { entries: { "lossless-claw": { config: {} } } },
    })}\n`, { mode: 0o600 });
    const stateDirectory = join(directory, "profile");

    const result = invoke([
      "config",
      "get",
      "databasePath",
      "--openclaw-dir",
      stateDirectory,
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: { isSet: false, effectiveValue: join(stateDirectory, "lcm.db") },
    });
  });

  it("includes resource-specific options in agent-readable help", () => {
    const result = invoke(["--help"]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      data: {
        selectorOptions: expect.arrayContaining(["--conversation-id <id>", "--session-key <key>"]),
        messageOptions: expect.arrayContaining(["--role <role>", "--include-content"]),
        summaryOptions: expect.arrayContaining(["--depth <integer>", "--kind <leaf|condensed>"]),
        tailOptions: ["--count <1..500>"],
      },
    });
  });

  it("renders compact table output from the same response data", () => {
    const result = invoke(["conversations", "list", "--format", "table"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("conversationId");
    expect(result.stdout).toContain("pagination.hasMore");
  });

  it("writes structured errors to stderr with stable exit codes", () => {
    const result = invoke(["messages", "list"]);
    expect(result).toMatchObject({ exitCode: 2, stdout: "" });
    expect(JSON.parse(result.stderr)).toEqual({
      ok: false,
      error: {
        code: "MISSING_SELECTOR",
        message: "messages.list requires conversation-id or session-key.",
      },
    });
  });

  it("reports SQLite query failures with database exit code 5", () => {
    const emptyDatabasePath = join(directory, "empty.db");
    new DatabaseSync(emptyDatabasePath).close();

    const result = invoke(["status", "--db", emptyDatabasePath]);

    expect(result).toMatchObject({ exitCode: 5, stdout: "" });
    expect(JSON.parse(result.stderr)).toMatchObject({
      ok: false,
      error: { code: "DATABASE_QUERY_FAILED" },
    });
  });
});
