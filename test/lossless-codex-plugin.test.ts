import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";

const pluginModulePath = "../plugins/lossless-codex/scripts/mcp-server.mjs";

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
    allowWrite?: boolean;
  }) => Promise<Record<string, unknown>>;
};

async function loadPlugin(): Promise<PluginModule> {
  return (await import(pluginModulePath)) as PluginModule;
}

function encodeMcp(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function decodeMcp(buffer: string): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let rest = buffer;
  while (rest.length > 0) {
    const headerEnd = rest.indexOf("\r\n\r\n");
    if (headerEnd < 0) break;
    const header = rest.slice(0, headerEnd);
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) break;
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (rest.length < bodyEnd) break;
    messages.push(JSON.parse(rest.slice(bodyStart, bodyEnd)) as Record<string, unknown>);
    rest = rest.slice(bodyEnd);
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
    expect(plugin.createTools().map((tool) => tool.name)).toEqual([
      "lossless_codex_status",
      "lossless_codex_import",
      "lossless_codex_search",
      "lossless_codex_recent",
      "lossless_codex_describe",
      "lossless_codex_worklog",
    ]);
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

    const worklog = await plugin.callTool(
      "lossless_codex_worklog",
      { projectKey: "lossless-claw", period: "2026-05-03" },
      { dbPath: fixture.sidecarDbPath },
    );
    expect(worklog.structuredContent?.projectsWorked).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectKey: "lossless-claw",
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
      { projectKey: "lossless-claw", period: "2026-05-03", writeLcmEnrichment: true },
      { dbPath: fixture.sidecarDbPath, lcmDbPath: fixture.lcmDbPath, env: {} },
    );
    expect(disabled.structuredContent?.lcmEnrichment?.written).toBe(false);

    const enabled = await plugin.callTool(
      "lossless_codex_worklog",
      { projectKey: "lossless-claw", period: "2026-05-03", writeLcmEnrichment: true },
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
      expect(row.project_key).toBe("lossless-claw");
      expect(row.summary).toContain("Codex worked on lossless-claw");
      expect(row.payload_json).not.toContain("redacted patch");
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

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.stdin.write(encodeMcp({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
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
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`MCP server timed out. stderr=${stderr}`));
      }, 5_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`MCP server exited ${code}. stderr=${stderr}`));
      });
    });

    const messages = decodeMcp(stdout);
    expect(messages.map((message) => message.id)).toEqual([1, 2]);
    expect(JSON.stringify(messages[0])).toContain("lossless_codex_worklog");
    expect(JSON.stringify(messages[1])).toContain("src/lossless-codex/example.ts");
  });
});
