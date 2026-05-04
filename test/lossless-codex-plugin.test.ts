import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";

const pluginModulePath = "../plugins/lossless-codex/scripts/mcp-server.mjs";
const rehearsalScriptPath = "plugins/lossless-codex/scripts/rehearsal.mjs";
const fixtureProjectKey = "github.com/martian-engineering/lossless-claw";

type PluginModule = {
  createTools: () => Array<{ name: string }>;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
    options?: {
      dbPath?: string;
      sourceDir?: string;
      stateDbPath?: string;
      lcmDbPath?: string;
      allowWrite?: boolean;
      logsDbPath?: string;
      env?: Record<string, string | undefined>;
    },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
  openSidecarDatabase: (dbPath: string, options?: { readOnly?: boolean }) => DatabaseSync;
  runSidecarMigrations: (db: DatabaseSync) => void;
  importCodexArtifacts: (options: {
    dbPath: string;
    sourceDir: string;
    stateDbPath: string;
    logsDbPath?: string;
    allowWrite?: boolean;
    env?: Record<string, string | undefined>;
  }) => Promise<Record<string, unknown>>;
};

async function loadPlugin(): Promise<PluginModule> {
  return (await import(pluginModulePath)) as PluginModule;
}

function encodeMcp(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function decodeMcp(buffer: string | Buffer): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let rest = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf8");
  while (rest.length > 0) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = rest.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    messages.push(JSON.parse(rest.subarray(bodyStart, bodyEnd).toString("utf8")) as Record<string, unknown>);
    rest = rest.subarray(bodyEnd);
  }
  return messages;
}

function createCodexFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-codex-"));
  const sourceDir = join(tempDir, "codex-home");
  const sessionsDir = join(sourceDir, "sessions", "2026", "05", "04");
  mkdirSync(sessionsDir, { recursive: true });
  const rolloutPath = join(
    sessionsDir,
    "rollout-2026-05-04T00-21-30-019lossless-codex-thread.jsonl",
  );
  const stateDbPath = join(sourceDir, "state_5.sqlite");
  const stateDb = new DatabaseSync(stateDbPath);
  stateDb.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      has_user_event INTEGER NOT NULL DEFAULT 0,
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at INTEGER,
      git_sha TEXT,
      git_branch TEXT,
      git_origin_url TEXT,
      cli_version TEXT NOT NULL DEFAULT '',
      first_user_message TEXT NOT NULL DEFAULT '',
      agent_nickname TEXT,
      agent_role TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'enabled',
      model TEXT,
      reasoning_effort TEXT,
      agent_path TEXT,
      created_at_ms INTEGER,
      updated_at_ms INTEGER
    );
    CREATE TABLE thread_spawn_edges (
      parent_thread_id TEXT NOT NULL,
      child_thread_id TEXT NOT NULL PRIMARY KEY,
      status TEXT NOT NULL
    );
  `);
  stateDb.prepare(
    `INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
      sandbox_policy, approval_mode, git_branch, git_origin_url, model, reasoning_effort,
      created_at_ms, updated_at_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "019lossless-codex-thread",
    rolloutPath,
    1777828899,
    1777829006,
    "vscode",
    "openai",
    "/Volumes/LEXAR/Codex/worktrees/lossless-codex-full-memory",
    "Lossless Codex implementation",
    "danger-full-access",
    "never",
    "feat/lossless-codex-full-memory",
    "https://github.com/Martian-Engineering/lossless-claw.git",
    "gpt-5.5",
    "high",
    1777828899000,
    1777829006000,
  );
  stateDb.prepare(
    `INSERT INTO thread_spawn_edges (parent_thread_id, child_thread_id, status)
     VALUES (?, ?, ?)`,
  ).run("parent-thread", "019lossless-codex-thread", "closed");
  stateDb.close();

  const lines = [
    {
      timestamp: "2026-05-03T17:30:00.000Z",
      type: "session_meta",
      payload: {
        id: "019lossless-codex-thread",
        cwd: "/Volumes/LEXAR/Codex/worktrees/lossless-codex-full-memory",
        model_provider: "openai",
        source: "vscode",
      },
    },
    {
      timestamp: "2026-05-03T17:30:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-1", started_at: "2026-05-03T17:30:01.000Z" },
    },
    {
      timestamp: "2026-05-03T17:31:00.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        call_id: "call_patch",
        name: "apply_patch",
        status: "completed",
        input: "redacted patch",
      },
    },
    {
      timestamp: "2026-05-03T17:31:01.000Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "call_patch",
        turn_id: "turn-1",
        status: "completed",
        success: true,
        stdout: "Success. Updated the following files:\nM src/lossless-codex/example.ts\n",
        changes: {
          "src/lossless-codex/example.ts": { type: "update", unified_diff: "@@ -1 +1" },
        },
      },
    },
    {
      timestamp: "2026-05-03T17:32:00.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-1", completed_at: "2026-05-03T17:32:00.000Z" },
    },
  ];
  writeFileSync(rolloutPath, lines.map((line) => JSON.stringify(line)).join("\n") + "\n");

  return {
    tempDir,
    sourceDir,
    stateDbPath,
    rolloutPath,
    sidecarDbPath: join(tempDir, "lossless-codex.sqlite"),
    lcmDbPath: join(tempDir, "lcm.db"),
  };
}

describe("Lossless Codex full memory plugin", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("exposes the full memory tool surface separately from the LCM reader", async () => {
    const plugin = await loadPlugin();
    const tools = plugin.createTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      "lossless_codex_status",
      "lossless_codex_import",
      "lossless_codex_search",
      "lossless_codex_recent",
      "lossless_codex_describe",
      "lossless_codex_worklog",
    ]);
    const searchTool = tools.find((tool) => tool.name === "lossless_codex_search");
    expect(searchTool?.inputSchema?.properties).toHaveProperty("query");
    const describeTool = tools.find((tool) => tool.name === "lossless_codex_describe");
    expect(describeTool?.inputSchema?.required).toEqual(["id"]);
    expect(describeTool?.inputSchema?.properties).toHaveProperty("maxChars");
    const worklogTool = tools.find((tool) => tool.name === "lossless_codex_worklog");
    expect(worklogTool?.inputSchema?.properties).toHaveProperty("writeLcmEnrichment");
  });

  it("creates the sidecar coding-work schema idempotently", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: false });
    try {
      plugin.runSidecarMigrations(db);
      plugin.runSidecarMigrations(db);
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String((row as { name: string }).name));
      expect(tables).toEqual(
        expect.arrayContaining([
          "codex_projects",
          "codex_threads",
          "codex_turns",
          "codex_events",
          "codex_tool_calls",
          "codex_touched_files",
          "codex_observations",
          "codex_summaries",
          "codex_project_day_rollups",
          "codex_import_watermarks",
          "codex_jobs",
        ]),
      );
    } finally {
      db.close();
    }
  });

  it("imports Codex thread metadata and extracts coding work without raw transcript storage", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const first = await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });
    const second = await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    expect(first.importedThreads).toBe(1);
    expect(first.importedEvents).toBe(5);
    expect(second.importedThreads).toBe(0);
    expect(second.importedEvents).toBe(0);

    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const thread = db
        .prepare("SELECT thread_id, title_display, project_id FROM codex_threads")
        .get() as { thread_id: string; title_display: string; project_id: string };
      expect(thread.thread_id).toBe("019lossless-codex-thread");
      expect(thread.title_display).toBe("Lossless Codex implementation");

      const touched = db
        .prepare("SELECT path_display, source_kind FROM codex_touched_files")
        .get() as { path_display: string; source_kind: string };
      expect(touched.path_display).toBe("src/lossless-codex/example.ts");
      expect(touched.source_kind).toBe("patch_apply");

      const observation = db
        .prepare("SELECT kind, status, summary, confidence FROM codex_observations")
        .get() as { kind: string; status: string; summary: string; confidence: number };
      expect(observation.kind).toBe("file_change");
      expect(observation.status).toBe("observed");
      expect(observation.summary).toContain("src/lossless-codex/example.ts");
      expect(observation.confidence).toBeGreaterThan(0.9);

      const rawInputCount = db
        .prepare("SELECT COUNT(*) AS count FROM codex_events WHERE raw_payload_json LIKE '%redacted patch%'")
        .get() as { count: number };
      expect(rawInputCount.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("keeps unrelated same-basename git origins in separate projects", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const secondRolloutPath = join(
      fixture.sourceDir,
      "sessions",
      "2026",
      "05",
      "04",
      "rollout-2026-05-04T02-00-00-019other-api-thread.jsonl",
    );
    writeFileSync(
      secondRolloutPath,
      [
        {
          timestamp: "2026-05-03T19:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019other-api-thread",
            cwd: "/tmp/api",
            git_origin_url: "https://github.com/other/api.git",
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    const thirdRolloutPath = join(
      fixture.sourceDir,
      "sessions",
      "2026",
      "05",
      "04",
      "rollout-2026-05-04T03-00-00-019ssh-api-thread.jsonl",
    );
    writeFileSync(
      thirdRolloutPath,
      [
        {
          timestamp: "2026-05-03T20:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019ssh-api-thread",
            cwd: "/tmp/api",
            git_origin_url: "ssh://git@gitlab.com/bar/api.git",
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n",
    );
    const stateDb = new DatabaseSync(fixture.stateDbPath);
    try {
      const insertThread = stateDb.prepare(
        `INSERT INTO threads (
            id, rollout_path, created_at, updated_at, source, model_provider, cwd, title,
            sandbox_policy, approval_mode, git_branch, git_origin_url, model, reasoning_effort,
            created_at_ms, updated_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertThread.run(
        "019other-api-thread",
        secondRolloutPath,
        1777834800,
        1777834800,
        "vscode",
        "openai",
        "/tmp/api",
        "Other API work",
        "danger-full-access",
        "never",
        "main",
        "https://github.com/other/api.git",
        "gpt-5.5",
        "high",
        1777834800000,
        1777834800000,
      );
      insertThread.run(
        "019ssh-api-thread",
        thirdRolloutPath,
        1777838400,
        1777838400,
        "vscode",
        "openai",
        "/tmp/api",
        "SSH API work",
        "danger-full-access",
        "never",
        "main",
        "ssh://git@gitlab.com/bar/api.git",
        "gpt-5.5",
        "high",
        1777838400000,
        1777838400000,
      );
    } finally {
      stateDb.close();
    }

    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const keys = db
        .prepare("SELECT project_key FROM codex_projects ORDER BY project_key")
        .all()
        .map((row) => String((row as { project_key: string }).project_key));
      expect(keys).toEqual([
        "github.com/martian-engineering/lossless-claw",
        "github.com/other/api",
        "gitlab.com/bar/api",
      ]);
    } finally {
      db.close();
    }
  });

  it("redacts credential-bearing git origins from project keys and display fields", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const stateDb = new DatabaseSync(fixture.stateDbPath);
    try {
      stateDb
        .prepare("UPDATE threads SET git_origin_url = ? WHERE id = ?")
        .run("https://ghp_SECRET@github.com/Martian-Engineering/lossless-claw.git", "019lossless-codex-thread");
    } finally {
      stateDb.close();
    }

    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const project = db
        .prepare("SELECT project_key, git_origin_display FROM codex_projects")
        .get() as { project_key: string; git_origin_display: string };
      expect(project.project_key).toBe(fixtureProjectKey);
      expect(project.git_origin_display).toBe("https://github.com/Martian-Engineering/lossless-claw.git");
      expect(JSON.stringify(project)).not.toContain("ghp_SECRET");
    } finally {
      db.close();
    }

    const recent = await plugin.callTool(
      "lossless_codex_recent",
      { projectKey: fixtureProjectKey, period: "2026-05-03" },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(JSON.stringify(recent.structuredContent)).not.toContain("ghp_SECRET");
  });

  it("redacts object status payloads from raw metadata snapshots", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    writeFileSync(
      fixture.rolloutPath,
      readFileSync(fixture.rolloutPath, "utf8") +
        `${JSON.stringify({
          timestamp: "2026-05-03T17:33:00.000Z",
          type: "event_msg",
          payload: {
            type: "collab_close_end",
            status: {
              completed: "SECRET SUBAGENT FINAL REPORT WITH stdout AND unified_diff",
              usage: { total_tokens: 1000 },
            },
          },
        })}\n`,
    );

    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const leaked = db
        .prepare("SELECT COUNT(*) AS count FROM codex_events WHERE raw_payload_json LIKE '%SECRET SUBAGENT%'")
        .get() as { count: number };
      expect(leaked.count).toBe(0);
      const redacted = db
        .prepare(
          `SELECT raw_payload_json
           FROM codex_events
           WHERE payload_type = 'collab_close_end'`,
        )
        .get() as { raw_payload_json: string };
      expect(JSON.parse(redacted.raw_payload_json)).toEqual({
        type: "collab_close_end",
        status: "[object_redacted]",
      });
    } finally {
      db.close();
    }
  });

  it("remaps copied state DB rollout paths through the rehearsal sourceDir", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const originalSourceDir = join(fixture.tempDir, "original-codex-home");
    const copiedRelativePath = relative(fixture.sourceDir, fixture.rolloutPath);
    const originalRolloutPath = join(originalSourceDir, copiedRelativePath);
    const stateDb = new DatabaseSync(fixture.stateDbPath);
    try {
      stateDb
        .prepare("UPDATE threads SET rollout_path = ? WHERE id = ?")
        .run(originalRolloutPath, "019lossless-codex-thread");
    } finally {
      stateDb.close();
    }

    mkdirSync(dirname(originalRolloutPath), { recursive: true });
    writeFileSync(
      originalRolloutPath,
      `${JSON.stringify({
        timestamp: "2026-05-03T17:00:00.000Z",
        type: "session_meta",
        payload: { id: "019lossless-codex-thread", source: "live-original" },
      })}\n`,
    );
    expect(existsSync(originalRolloutPath)).toBe(true);

    const result = await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    expect(result.importedThreads).toBe(1);
    expect(result.importedEvents).toBe(5);
    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const source = db
        .prepare("SELECT path FROM codex_source_files WHERE kind = 'session_jsonl'")
        .get() as { path: string };
      expect(source.path).toBe(fixture.rolloutPath);
    } finally {
      db.close();
    }
  });

  it("imports archived JSONL sessions that are not present in state_5 threads", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const archivedDir = join(fixture.sourceDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    const archivedPath = join(archivedDir, "rollout-2026-05-04T01-00-00-019archived-thread.jsonl");
    writeFileSync(
      archivedPath,
      [
        {
          timestamp: "2026-05-03T18:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019archived-thread",
            cwd: "/Volumes/LEXAR/Codex/worktrees/lossless-codex-full-memory",
            model_provider: "openai",
            source: "vscode",
          },
        },
        {
          timestamp: "2026-05-03T18:01:00.000Z",
          type: "event_msg",
          payload: { type: "task_started", turn_id: "archived-turn" },
        },
        {
          timestamp: "2026-05-03T18:02:00.000Z",
          type: "event_msg",
          payload: { type: "task_complete", turn_id: "archived-turn" },
        },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n",
    );

    const result = await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    expect(result.importedThreads).toBe(2);
    expect(result.importedEvents).toBe(8);
    const second = await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });
    expect(second.importedThreads).toBe(0);
    expect(second.importedEvents).toBe(0);
    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const archivedThread = db
        .prepare("SELECT thread_id, source FROM codex_threads WHERE thread_id = ?")
        .get("019archived-thread") as { thread_id: string; source: string };
      expect(archivedThread).toEqual({ thread_id: "019archived-thread", source: "archived_jsonl" });
    } finally {
      db.close();
    }
  });

  it("imports logs_2 sqlite metadata without log bodies", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const logsDbPath = join(fixture.sourceDir, "logs_2.sqlite");
    const logsDb = new DatabaseSync(logsDbPath);
    try {
      logsDb.exec(`
        CREATE TABLE logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ts INTEGER,
          ts_nanos INTEGER,
          level TEXT,
          target TEXT,
          feedback_log_body TEXT,
          module_path TEXT,
          file TEXT,
          line INTEGER,
          thread_id TEXT,
          process_uuid TEXT,
          estimated_bytes INTEGER
        )
      `);
      logsDb
        .prepare(
          `INSERT INTO logs (
            ts, ts_nanos, level, target, feedback_log_body, module_path, file,
            line, thread_id, process_uuid, estimated_bytes
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          1777829000,
          123,
          "INFO",
          "codex_core::worker",
          "SECRET LOG BODY SHOULD NOT BE STORED",
          "codex_core::worker",
          "worker.rs",
          42,
          "019lossless-codex-thread",
          "process-1",
          128,
        );
    } finally {
      logsDb.close();
    }

    await plugin.callTool(
      "lossless_codex_import",
      {
        allowWrite: true,
        dbPath: fixture.sidecarDbPath,
        sourceDir: fixture.sourceDir,
        stateDbPath: fixture.stateDbPath,
        logsDbPath,
      },
      { env: { LOSSLESS_CODEX_READ_ONLY: "true" } },
    );

    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const columns = db
        .prepare("PRAGMA table_info(codex_log_metadata)")
        .all()
        .map((row) => String((row as { name: string }).name));
      expect(columns).not.toContain("feedback_log_body");
      const row = db
        .prepare("SELECT level, target, file, line, thread_id, body_sha256 FROM codex_log_metadata")
        .get() as {
        level: string;
        target: string;
        file: string;
        line: number;
        thread_id: string;
        body_sha256: string;
      };
      expect(row).toEqual(
        expect.objectContaining({
          level: "INFO",
          target: "codex_core::worker",
          file: "worker.rs",
          line: 42,
          thread_id: "019lossless-codex-thread",
        }),
      );
      expect(row.body_sha256).toMatch(/^[a-f0-9]{64}$/);
      const leaked = db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM codex_events
           WHERE raw_payload_json LIKE '%SECRET LOG BODY SHOULD NOT BE STORED%'`,
        )
        .get() as { count: number };
      expect(leaked.count).toBe(0);
    } finally {
      db.close();
    }
  });

  it("creates a new source generation when rollout JSONL is truncated or rotated", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    writeFileSync(
      fixture.rolloutPath,
      `${JSON.stringify({
        timestamp: "2026-05-03T18:00:00.000Z",
        type: "session_meta",
        payload: { id: "019lossless-codex-thread", source: "vscode" },
      })}\n`,
    );

    const rotated = await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    expect(rotated.importedThreads).toBe(0);
    expect(rotated.importedEvents).toBe(1);

    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const generations = db
        .prepare(
          `SELECT generation, status
           FROM codex_source_files
           WHERE path = ?
           ORDER BY generation`,
        )
        .all(fixture.rolloutPath) as Array<{ generation: number; status: string }>;
      expect(generations).toEqual([
        { generation: 1, status: "active" },
        { generation: 2, status: "active" },
      ]);
    } finally {
      db.close();
    }
  });

  it("does not skip same-size same-mtime rollout replacements with changed evidence hash", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    const original = readFileSync(fixture.rolloutPath, "utf8");
    const originalStat = statSync(fixture.rolloutPath);
    const replacement = original.replace("custom_tool_call", "custom_tool_ping");
    expect(Buffer.byteLength(replacement)).toBe(Buffer.byteLength(original));
    writeFileSync(fixture.rolloutPath, replacement);
    utimesSync(fixture.rolloutPath, originalStat.atime, originalStat.mtime);

    const result = await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    expect(result.importedEvents).toBe(5);
    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const payloadTypes = db
        .prepare("SELECT payload_type FROM codex_events WHERE thread_id = ? ORDER BY source_line")
        .all("019lossless-codex-thread")
        .map((row) => String((row as { payload_type: string }).payload_type));
      expect(payloadTypes).toContain("custom_tool_ping");
      expect(payloadTypes).not.toContain("custom_tool_call");
    } finally {
      db.close();
    }
  });

  it("keeps repeated provider call IDs separate per thread", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const archivedDir = join(fixture.sourceDir, "archived_sessions");
    mkdirSync(archivedDir, { recursive: true });
    const archivedPath = join(archivedDir, "rollout-2026-05-04T04-00-00-019same-call-thread.jsonl");
    writeFileSync(
      archivedPath,
      [
        {
          timestamp: "2026-05-03T21:00:00.000Z",
          type: "session_meta",
          payload: {
            id: "019same-call-thread",
            cwd: "/Volumes/LEXAR/Codex/worktrees/lossless-codex-full-memory",
            git_origin_url: "https://github.com/Martian-Engineering/lossless-claw.git",
          },
        },
        {
          timestamp: "2026-05-03T21:01:00.000Z",
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            call_id: "call_patch",
            name: "apply_patch",
            status: "completed",
          },
        },
      ].map((line) => JSON.stringify(line)).join("\n") + "\n",
    );

    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    const db = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT call_id, thread_id FROM codex_tool_calls ORDER BY thread_id")
        .all() as Array<{ call_id: string; thread_id: string }>;
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.call_id)).size).toBe(2);
      expect(rows.map((row) => row.thread_id)).toEqual([
        "019lossless-codex-thread",
        "019same-call-thread",
      ]);
    } finally {
      db.close();
    }
  });

  it("searches, describes, and reports worklogs from imported coding memory", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    const search = await plugin.callTool(
      "lossless_codex_search",
      { query: "example", limit: 5 },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(search.structuredContent?.count).toBe(1);
    expect(JSON.stringify(search.structuredContent)).toContain("src/lossless-codex/example.ts");
    const fileRef = (
      search.structuredContent?.results as Array<{ ref: string }> | undefined
    )?.[0]?.ref;
    expect(fileRef).toMatch(/^lossless-codex:\/\/file\//);

    const phraseSearch = await plugin.callTool(
      "lossless_codex_search",
      { query: "Lossless Codex", limit: 5 },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(Number(phraseSearch.structuredContent?.count)).toBeGreaterThan(0);
    expect(JSON.stringify(phraseSearch.structuredContent)).toContain("src/lossless-codex/example.ts");

    const worklog = await plugin.callTool(
      "lossless_codex_worklog",
      { projectKey: fixtureProjectKey, period: "2026-05-03" },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(worklog.structuredContent?.projectsWorked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectKey: fixtureProjectKey,
          threadCount: 1,
        }),
      ]),
    );

    const describe = await plugin.callTool(
      "lossless_codex_describe",
      { id: "lossless-codex://thread/019lossless-codex-thread" },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(describe.structuredContent?.type).toBe("thread");
    expect(JSON.stringify(describe.structuredContent)).toContain("sidecarRefs");

    const describeFile = await plugin.callTool(
      "lossless_codex_describe",
      { id: fileRef },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(describeFile.structuredContent?.type).toBe("file");
    expect(JSON.stringify(describeFile.structuredContent)).toContain("src/lossless-codex/example.ts");

    const sidecarDb = plugin.openSidecarDatabase(fixture.sidecarDbPath, { readOnly: false });
    try {
      const base = sidecarDb
        .prepare("SELECT thread_id, turn_id, project_id, first_event_id AS event_id FROM codex_observations LIMIT 1")
        .get() as { thread_id: string; turn_id: string; project_id: string; event_id: string };
      for (let index = 0; index < 150; index += 1) {
        sidecarDb
          .prepare(
            `INSERT OR IGNORE INTO codex_touched_files (
              touched_file_id, thread_id, turn_id, call_id, path_hash, path_display,
              path_display_policy, source_kind, confidence, event_id
            ) VALUES (?, ?, ?, NULL, ?, ?, 'basename', 'test_fixture', 1, ?)`,
          )
          .run(
            `ctouch_extra_${index}`,
            base.thread_id,
            base.turn_id,
            `hash_${index}`,
            `src/generated/${index}.ts`,
            base.event_id,
          );
        sidecarDb
          .prepare(
            `INSERT OR IGNORE INTO codex_observations (
              observation_id, thread_id, turn_id, project_id, kind, status, summary,
              confidence, rationale, privacy_class, first_event_id, last_event_id, created_at
            ) VALUES (?, ?, ?, ?, 'follow_up', 'observed', ?, 0.5, 'fixture', 'metadata', ?, ?, datetime('now'))`,
          )
          .run(
            `cobs_extra_${index}`,
            base.thread_id,
            base.turn_id,
            base.project_id,
            `Generated observation ${index} ${"x".repeat(500)}`,
            base.event_id,
            base.event_id,
          );
      }
      sidecarDb
        .prepare(
          `INSERT INTO codex_summaries (
            summary_id, thread_id, project_id, kind, depth, content, token_count,
            source_hash, created_at
          )
          SELECT ?, thread_id, project_id, 'thread', 0, ?, ?, ?, datetime('now')
          FROM codex_threads
          WHERE thread_id = ?`,
        )
        .run(
          "csum_huge",
          `huge-summary ${"x".repeat(1_000_000)}`,
          250_000,
          "huge-hash",
          "019lossless-codex-thread",
        );
    } finally {
      sidecarDb.close();
    }

    const hugeSearch = await plugin.callTool(
      "lossless_codex_search",
      { query: "huge-summary", includeSummaries: true, limit: 5 },
      { dbPath: fixture.sidecarDbPath },
    );
    const hugeRow = (hugeSearch.structuredContent?.results as Array<{ text: string; text_truncated: boolean }>).find(
      (row) => row.text.includes("huge-summary"),
    );
    expect(hugeRow?.text.length).toBeLessThanOrEqual(2_020);
    expect(hugeRow?.text_truncated).toBe(true);

    const hugeDescribe = await plugin.callTool(
      "lossless_codex_describe",
      { id: "lossless-codex://summary/csum_huge", maxChars: 1500 },
      { dbPath: fixture.sidecarDbPath },
    );
    const hugeSummary = hugeDescribe.structuredContent?.summary as { content: string; content_truncated: boolean };
    expect(hugeSummary.content.length).toBeLessThanOrEqual(1_520);
    expect(hugeSummary.content_truncated).toBe(true);

    const boundedThread = await plugin.callTool(
      "lossless_codex_describe",
      { id: "lossless-codex://thread/019lossless-codex-thread", limit: 25, maxChars: 1000 },
      { dbPath: fixture.sidecarDbPath },
    );
    const threadPayload = boundedThread.structuredContent as {
      files: unknown[];
      observations: unknown[];
      limits: { filesOmitted: number; observationsOmitted: number };
    };
    expect(threadPayload.files).toHaveLength(25);
    expect(threadPayload.observations).toHaveLength(25);
    expect(threadPayload.limits.filesOmitted).toBeGreaterThan(0);
    expect(threadPayload.limits.observationsOmitted).toBeGreaterThan(0);

    const describeProjectDay = await plugin.callTool(
      "lossless_codex_describe",
      { id: `lossless-codex://project-day/${encodeURIComponent(fixtureProjectKey)}/2026-05-03/UTC` },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(describeProjectDay.structuredContent?.type).toBe("project-day");
    expect(JSON.stringify(describeProjectDay.structuredContent)).toContain(fixtureProjectKey);
  });

  it("builds project-day rollups in the configured local timezone", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
      env: { LOSSLESS_CODEX_TIMEZONE: "Asia/Bangkok" },
    });

    const recentUtcDate = await plugin.callTool(
      "lossless_codex_recent",
      { projectKey: fixtureProjectKey, period: "2026-05-03" },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(recentUtcDate.structuredContent?.count).toBe(0);

    const recentLocalDate = await plugin.callTool(
      "lossless_codex_recent",
      { projectKey: fixtureProjectKey, period: "2026-05-04" },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(recentLocalDate.structuredContent?.count).toBe(1);
    expect(JSON.stringify(recentLocalDate.structuredContent)).toContain('"timezone":"Asia/Bangkok"');

    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
      env: { LOSSLESS_CODEX_TIMEZONE: "UTC" },
    });
    const onlyBangkok = await plugin.callTool(
      "lossless_codex_recent",
      { projectKey: fixtureProjectKey, period: "2026-05-04" },
      { dbPath: fixture.sidecarDbPath, env: { LOSSLESS_CODEX_TIMEZONE: "Asia/Bangkok" } },
    );
    expect(onlyBangkok.structuredContent?.count).toBe(1);
    expect(JSON.stringify(onlyBangkok.structuredContent)).toContain('"timezone":"Asia/Bangkok"');
  });

  it("writes compact temporal enrichment rows to LCM only when explicitly enabled", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });

    const lcmDb = createLcmDatabaseConnection(fixture.lcmDbPath);
    runLcmMigrations(lcmDb, getLcmDbFeatures(lcmDb));
    closeLcmConnection(fixture.lcmDbPath);

    const disabled = await plugin.callTool(
      "lossless_codex_worklog",
      { projectKey: fixtureProjectKey, period: "2026-05-03", writeLcmEnrichment: true },
      { dbPath: fixture.sidecarDbPath, lcmDbPath: fixture.lcmDbPath, env: {} },
    );
    expect(disabled.structuredContent?.lcmEnrichment?.written).toBe(false);

    const enabled = await plugin.callTool(
      "lossless_codex_worklog",
      { projectKey: fixtureProjectKey, period: "2026-05-03", writeLcmEnrichment: true },
      {
        dbPath: fixture.sidecarDbPath,
        lcmDbPath: fixture.lcmDbPath,
        env: { LOSSLESS_CODEX_LCM_ENRICHMENT_ENABLED: "true" },
      },
    );
    expect(enabled.structuredContent?.lcmEnrichment?.written).toBe(true);

    const db = new DatabaseSync(fixture.lcmDbPath, { readOnly: true });
    try {
      const row = db
        .prepare("SELECT source_system, period_kind, period_key, project_key, summary, payload_json FROM lcm_temporal_enrichments")
        .get() as {
        source_system: string;
        period_kind: string;
        period_key: string;
        project_key: string;
        summary: string;
        payload_json: string;
      };
      expect(row.source_system).toBe("lossless_codex");
      expect(row.period_kind).toBe("day");
      expect(row.period_key).toBe("2026-05-03");
      expect(row.project_key).toBe(fixtureProjectKey);
      expect(row.summary).toContain(`Codex worked on ${fixtureProjectKey}`);
      expect(row.payload_json).not.toContain("redacted patch");
      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lcm_temporal_enrichments'")
        .all()
        .map((indexRow) => String((indexRow as { name: string }).name));
      expect(indexes).toContain("lcm_temporal_enrichments_project_period_idx");
    } finally {
      db.close();
    }
  });

  it("serves the full plugin tools over MCP stdio", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });
    const scriptPath = join(process.cwd(), "plugins/lossless-codex/scripts/mcp-server.mjs");
    expect(existsSync(scriptPath)).toBe(true);

    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, LOSSLESS_CODEX_DB_PATH: fixture.sidecarDbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdin.write(encodeMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    child.stdin.write(encodeMcp({ jsonrpc: "2.0", method: "notifications/initialized" }));
    child.stdin.write(
      encodeMcp({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "lossless_codex_search",
          arguments: { query: "example", limit: 5 },
        },
      }),
    );

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`MCP server timed out. stderr=${stderr}`));
      }, 5_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.stdout.on("data", () => {
        if (decodeMcp(stdout).length >= 2) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    child.stdin.end();
    child.kill("SIGTERM");

    const messages = decodeMcp(stdout);
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(messages.some((message) => message.id == null)).toBe(false);
    expect(JSON.stringify(messages[0])).toContain("lossless_codex_worklog");
    expect(JSON.stringify(messages[1])).toContain("src/lossless-codex/example.ts");
  });

  it("starts over MCP stdio when invoked through an installed symlink path", async () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    await plugin.importCodexArtifacts({
      dbPath: fixture.sidecarDbPath,
      sourceDir: fixture.sourceDir,
      stateDbPath: fixture.stateDbPath,
      allowWrite: true,
    });
    const installDir = mkdtempSync(join(tmpdir(), "lossless-codex-install with spaces-"));
    tempDirs.add(installDir);
    const symlinkedPlugin = join(installDir, "lossless-codex");
    symlinkSync(join(process.cwd(), "plugins/lossless-codex"), symlinkedPlugin, "dir");
    const scriptPath = join(symlinkedPlugin, "scripts/mcp-server.mjs");

    const child = spawn(process.execPath, [scriptPath], {
      cwd: symlinkedPlugin,
      env: { ...process.env, LOSSLESS_CODEX_DB_PATH: fixture.sidecarDbPath },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = Buffer.alloc(0);
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout = Buffer.concat([stdout, Buffer.from(chunk)]);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdin.write(encodeMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }));

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`MCP symlink server timed out. stderr=${stderr}`));
      }, 5_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.stdout.on("data", () => {
        if (decodeMcp(stdout).length >= 1) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    child.stdin.end();
    child.kill("SIGTERM");

    const messages = decodeMcp(stdout);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain("lossless_codex_worklog");
  });

  it("runs the production rehearsal CLI against copied fixtures", () => {
    const fixture = createCodexFixture();
    tempDirs.add(fixture.tempDir);
    const result = spawnSync(
      process.execPath,
      [
        rehearsalScriptPath,
        "--source-dir",
        fixture.sourceDir,
        "--state-db",
        fixture.stateDbPath,
        "--sidecar-db",
        fixture.sidecarDbPath,
        "--query",
        "example",
        "--json",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
      },
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      imports: Array<{ importedThreads: number; importedEvents: number }>;
      tools: Record<string, { ok: boolean; count?: number }>;
      integrity: { rawPatchInputRows: number };
    };
    expect(payload.imports[0]).toEqual(expect.objectContaining({ importedThreads: 1, importedEvents: 5 }));
    expect(payload.imports[1]).toEqual(expect.objectContaining({ importedThreads: 0, importedEvents: 0 }));
    expect(payload.tools.lossless_codex_status.ok).toBe(true);
    expect(payload.tools.lossless_codex_search.count).toBe(1);
    expect(payload.tools.lossless_codex_recent.ok).toBe(true);
    expect(payload.tools.lossless_codex_describe.ok).toBe(true);
    expect(payload.tools.lossless_codex_worklog.ok).toBe(true);
    expect(payload.integrity.rawPatchInputRows).toBe(0);
  });
});
