import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const pluginModulePath = "../plugins/codex-lcm-reader/scripts/mcp-server.mjs";

type PluginModule = {
  createTools: () => Array<{ name: string }>;
  callTool: (
    name: string,
    args?: Record<string, unknown>,
    options?: { dbPath?: string },
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    structuredContent?: Record<string, unknown>;
  }>;
  openReadOnlyDatabase: (dbPath: string) => {
    close: () => void;
    prepare: (sql: string) => { run: (...args: unknown[]) => unknown };
  };
};

async function loadPlugin(): Promise<PluginModule> {
  return (await import(pluginModulePath)) as PluginModule;
}

async function createLcmFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-lcm-reader-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });

  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  const conversation = await conversationStore.createConversation({
    sessionId: "codex-lcm-reader-session",
    title: "Codex LCM Reader fixture",
  });
  const [firstMessage, secondMessage] = await conversationStore.createMessagesBulk([
    {
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: `We recovered the Lexar drive and audited the LCM plugin idea. ${"x".repeat(1500)}`,
      tokenCount: 16,
    },
    {
      conversationId: conversation.conversationId,
      seq: 1,
      role: "assistant",
      content: "The safe plan is read-only SQLite access from Codex Desktop.",
      tokenCount: 14,
    },
  ]);

  await summaryStore.insertSummary({
    summaryId: "sum_codex_reader_parent",
    conversationId: conversation.conversationId,
    kind: "condensed",
    depth: 1,
    content: "Codex Desktop should inspect local LCM memory through a read-only plugin.",
    tokenCount: 22,
    sourceMessageTokenCount: 30,
    earliestAt: new Date("2026-04-29T10:00:00.000Z"),
    latestAt: new Date("2026-04-29T10:05:00.000Z"),
  });
  await summaryStore.insertSummary({
    summaryId: "sum_codex_reader_child",
    conversationId: conversation.conversationId,
    kind: "leaf",
    depth: 0,
    content: "The Lexar test fixture proves grep, describe, expand, and expand-query work.",
    tokenCount: 18,
    sourceMessageTokenCount: 30,
    earliestAt: new Date("2026-04-29T10:00:00.000Z"),
    latestAt: new Date("2026-04-29T10:05:00.000Z"),
  });
  await summaryStore.linkSummaryToMessages("sum_codex_reader_child", [
    firstMessage.messageId,
    secondMessage.messageId,
  ]);
  await summaryStore.linkSummaryToParents("sum_codex_reader_parent", ["sum_codex_reader_child"]);
  db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?").run(
    "2026-04-29T10:00:00.000Z",
    firstMessage.messageId,
  );
  db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?").run(
    "2026-04-29T10:05:00.000Z",
    secondMessage.messageId,
  );

  closeLcmConnection(dbPath);
  return {
    tempDir,
    dbPath,
    conversationId: conversation.conversationId,
    firstMessageId: firstMessage.messageId,
    secondMessageId: secondMessage.messageId,
  };
}

async function createLegacyLcmFixture() {
  const tempDir = mkdtempSync(join(tmpdir(), "codex-lcm-reader-legacy-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  db.exec(`
    CREATE TABLE conversations (conversation_id INTEGER PRIMARY KEY, session_id TEXT);
    CREATE TABLE messages (
      message_id INTEGER PRIMARY KEY,
      conversation_id INTEGER,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE summaries (
      summary_id TEXT PRIMARY KEY,
      conversation_id INTEGER,
      content TEXT,
      created_at TEXT
    );
    CREATE TABLE summary_parents (summary_id TEXT, parent_summary_id TEXT);
    CREATE TABLE summary_messages (summary_id TEXT, message_id INTEGER);
  `);
  closeLcmConnection(dbPath);
  return { tempDir, dbPath };
}

function encodeMcp(payload: unknown): string {
  const body = JSON.stringify(payload);
  return `Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`;
}

function decodeMcp(buffer: string | Buffer): Array<Record<string, unknown>> {
  const messages: Array<Record<string, unknown>> = [];
  let rest = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer, "utf8");
  const separator = Buffer.from("\r\n\r\n");
  while (rest.length > 0) {
    const headerEnd = rest.indexOf(separator);
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

describe("Codex LCM Reader plugin", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("exposes only the current read-only LCM tools", async () => {
    const plugin = await loadPlugin();
    expect(plugin.createTools().map((tool) => tool.name)).toEqual([
      "lcm_grep",
      "lcm_describe",
      "lcm_expand",
      "lcm_expand_query",
    ]);
  });

  it("opens the LCM database read-only", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const db = plugin.openReadOnlyDatabase(fixture.dbPath);
    try {
      expect(() =>
        db.prepare("INSERT INTO conversations (session_id) VALUES (?)").run("should-not-write"),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it("searches messages and summaries from a migrated LCM database", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      { pattern: "Lexar", mode: "full_text", scope: "both", limit: 10 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.tool).toBe("lcm_grep");
    expect(result.structuredContent?.databasePath).toBe(fixture.dbPath);
    const results = result.structuredContent?.results as Array<{ type: string; id: string }>;
    expect(results.some((row) => row.type === "message")).toBe(true);
    expect(results.some((row) => row.type === "summary")).toBe(true);
  });

  it("reports effective sort when merged message and summary relevance cannot be compared", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      { pattern: "Lexar", mode: "full_text", scope: "both", sort: "relevance", limit: 10 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.requestedSort).toBe("relevance");
    expect(result.structuredContent?.sort).toBe("recency");
  });

  it("can sort grep results oldest-first for first-occurrence discovery", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      {
        pattern: "Lexar|read-only",
        mode: "regex",
        scope: "messages",
        sort: "oldest",
        limit: 2,
      },
      { dbPath: fixture.dbPath },
    );

    const results = result.structuredContent?.results as Array<{ id: string }>;
    expect(results.map((row) => row.id)).toEqual([
      `message:${fixture.firstMessageId}`,
      `message:${fixture.secondMessageId}`,
    ]);
  });

  it("describes known summaries with lineage and source messages", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_describe",
      { id: "sum_codex_reader_parent" },
      { dbPath: fixture.dbPath },
    );

    const item = result.structuredContent?.item as {
      parentIds: string[];
      childIds: string[];
    };
    expect(item.parentIds).toEqual(["sum_codex_reader_child"]);
    expect(item.childIds).toEqual([]);
  });

  it("rejects invalid describe conversationId values clearly", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    await expect(
      plugin.callTool(
        "lcm_describe",
        { id: "sum_codex_reader_parent", conversationId: "not-a-number" },
        { dbPath: fixture.dbPath },
      ),
    ).rejects.toThrow("conversationId must be a positive integer");
  });

  it("describes source messages and linked summaries", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_describe",
      { id: `message:${fixture.firstMessageId}` },
      { dbPath: fixture.dbPath },
    );

    const item = result.structuredContent?.item as {
      type: string;
      message_id: number;
      content: string;
      summaryIds: string[];
    };
    expect(item.type).toBe("message");
    expect(item.message_id).toBe(fixture.firstMessageId);
    expect(item.content).toContain("Lexar drive");
    expect(item.summaryIds).toEqual(["sum_codex_reader_child"]);
  });

  it("bounds lcm_describe source content by maxChars", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_describe",
      { id: `message:${fixture.firstMessageId}`, maxChars: 1000 },
      { dbPath: fixture.dbPath },
    );

    const item = result.structuredContent?.item as {
      content: string;
      content_truncated: boolean;
      content_original_length: number;
    };
    expect(item.content.length).toBeLessThanOrEqual(1020);
    expect(item.content_truncated).toBe(true);
    expect(item.content_original_length).toBeGreaterThan(1000);
  });

  it("returns structured describe errors with tool and ID-format hints", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_describe",
      { id: "sum_missing" },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.tool).toBe("lcm_describe");
    expect(result.structuredContent?.error).toContain("sum_missing");
    expect(result.structuredContent?.hint).toContain("message:<id>");
  });

  it("expands a summary subtree without mutating state", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_expand",
      { summaryId: "sum_codex_reader_parent", maxDepth: 2 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.text).toContain("read-only plugin");
    expect(result.structuredContent?.text).toContain("expand-query work");
  });

  it("does not expand explicit summary IDs outside the requested conversation", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_expand_query",
      {
        summaryIds: ["sum_codex_reader_parent"],
        conversationId: fixture.conversationId + 1,
        prompt: "Should not cross conversations",
      },
      { dbPath: fixture.dbPath },
    );

    const expanded = result.structuredContent?.expanded as Array<{ error: string }>;
    expect(expanded[0].error).toContain(`conversation ${fixture.conversationId + 1}`);
    expect(result.structuredContent?.text).toBe("");
  });

  it("falls back from message hits to linked summaries for expand-query seeds", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_expand_query",
      {
        query: "read-only SQLite access",
        prompt: "What was the safe plan?",
        conversationId: fixture.conversationId,
        tokenCap: 4000,
      },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.summaryIds).toEqual(["sum_codex_reader_child"]);
    expect(result.structuredContent?.text).toContain("expand-query work");
  });

  it("rejects unsafe regex patterns without throwing", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      { pattern: "(a+)+$", mode: "regex", scope: "messages", limit: 10 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.count).toBe(0);
    expect(result.structuredContent?.results).toEqual([]);

    const alternationResult = await plugin.callTool(
      "lcm_grep",
      { pattern: "(a|aa)+$", mode: "regex", scope: "messages", limit: 10 },
      { dbPath: fixture.dbPath },
    );
    expect(alternationResult.structuredContent?.count).toBe(0);
    expect(alternationResult.structuredContent?.results).toEqual([]);
  });

  it("falls back to LIKE when copied FTS tables are malformed", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const db = createLcmDatabaseConnection(fixture.dbPath);
    db.exec("DROP TABLE IF EXISTS messages_fts");
    db.exec("CREATE TABLE messages_fts(content TEXT)");
    closeLcmConnection(fixture.dbPath);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      { pattern: "Lexar", mode: "full_text", scope: "messages", sort: "relevance", limit: 10 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.count).toBeGreaterThan(0);
    expect(result.structuredContent?.requestedSort).toBe("relevance");
    expect(result.structuredContent?.sort).toBe("recency");
  });

  it("downgrades relevance sort when summaries FTS lacks required join columns", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const db = createLcmDatabaseConnection(fixture.dbPath);
    db.exec("DROP TABLE IF EXISTS summaries_fts");
    db.exec("CREATE VIRTUAL TABLE summaries_fts USING fts5(content)");
    closeLcmConnection(fixture.dbPath);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      {
        pattern: "Lexar",
        mode: "full_text",
        scope: "summaries",
        sort: "relevance",
        limit: 10,
      },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.count).toBeGreaterThan(0);
    expect(result.structuredContent?.requestedSort).toBe("relevance");
    expect(result.structuredContent?.sort).toBe("recency");
  });

  it("reports recency as the effective sort when regex cannot rank relevance", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      { pattern: "Lexar", mode: "regex", scope: "messages", sort: "hybrid", limit: 10 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.requestedSort).toBe("hybrid");
    expect(result.structuredContent?.sort).toBe("recency");
  });

  it("does not turn punctuation-only full-text fallback into an unfiltered scan", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const db = createLcmDatabaseConnection(fixture.dbPath);
    db.exec("DROP TABLE IF EXISTS messages_fts");
    closeLcmConnection(fixture.dbPath);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_grep",
      { pattern: "!!!", mode: "full_text", scope: "messages", limit: 10 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.count).toBe(0);
    expect(result.structuredContent?.results).toEqual([]);
  });

  it("bounds full-text LIKE fallback term count for very large pasted queries", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const db = createLcmDatabaseConnection(fixture.dbPath);
    db.exec("DROP TABLE IF EXISTS messages_fts");
    db.exec("DROP TABLE IF EXISTS summaries_fts");
    closeLcmConnection(fixture.dbPath);
    const plugin = await loadPlugin();
    const query = Array.from({ length: 2_000 }, (_, index) => `term${index}`).join(" ");

    const result = await plugin.callTool(
      "lcm_grep",
      { pattern: query, mode: "full_text", scope: "both", limit: 10 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.count).toBe(0);
    expect(result.structuredContent?.results).toEqual([]);
  });

  it("rejects legacy databases with missing required columns before raw SQL failures", async () => {
    const fixture = await createLegacyLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    await expect(
      plugin.callTool("lcm_describe", { id: "sum_legacy" }, { dbPath: fixture.dbPath }),
    ).rejects.toThrow("missing required columns");
  });

  it("finds seed summaries for expand-query and returns evidence for Codex to synthesize", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();

    const result = await plugin.callTool(
      "lcm_expand_query",
      { query: "Lexar", prompt: "What did the plugin prove?", tokenCap: 4000 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.tool).toBe("lcm_expand_query");
    expect(result.structuredContent?.text).toContain("Lexar test fixture");
    expect(result.structuredContent?.note).toContain("does not spawn an OpenClaw sub-agent");
  });

  it("reports only summary IDs that were actually expanded by expand-query", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const summaryIds = Array.from({ length: 25 }, (_, index) => `sum_missing_${index}`);
    summaryIds[0] = "sum_codex_reader_child";
    summaryIds[1] = "sum_codex_reader_parent";

    const result = await plugin.callTool(
      "lcm_expand_query",
      { summaryIds, prompt: "Expand capped IDs", tokenCap: 4000 },
      { dbPath: fixture.dbPath },
    );

    expect(result.structuredContent?.summaryIds).toEqual(summaryIds.slice(0, 20));
    expect((result.structuredContent?.expanded as unknown[])).toHaveLength(20);
  });

  it("bounds lcm_expand_query echoed prompt/query inputs", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const plugin = await loadPlugin();
    const prompt = "p".repeat(10_000);
    const query = "Lexar " + "q".repeat(10_000);

    const result = await plugin.callTool(
      "lcm_expand_query",
      { query, prompt, tokenCap: 4000 },
      { dbPath: fixture.dbPath },
    );

    expect(String(result.structuredContent?.prompt).length).toBeLessThanOrEqual(1_020);
    expect(result.structuredContent?.prompt_truncated).toBe(true);
    expect(result.structuredContent?.prompt_original_length).toBe(prompt.length);
    expect(String(result.structuredContent?.query).length).toBeLessThanOrEqual(1_020);
    expect(result.structuredContent?.query_truncated).toBe(true);
    expect(result.structuredContent?.query_original_length).toBe(query.length);
  });

  it("decodes MCP frames by byte length for non-ASCII payloads", () => {
    const first = { jsonrpc: "2.0", id: 1, result: { text: "Eva 🖤" } };
    const second = { jsonrpc: "2.0", id: 2, result: { text: "ok" } };

    expect(decodeMcp(Buffer.from(`${encodeMcp(first)}${encodeMcp(second)}`, "utf8"))).toEqual([
      first,
      second,
    ]);
  });

  it("responds to initialize, tools/list, and tools/call over MCP stdio", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const scriptPath = join(process.cwd(), "plugins/codex-lcm-reader/scripts/mcp-server.mjs");
    expect(existsSync(scriptPath)).toBe(true);

    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: { ...process.env, LCM_CODEX_DB_PATH: fixture.dbPath },
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

    child.stdin.write(
      encodeMcp({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05" },
      }),
    );
    child.stdin.write(encodeMcp({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    child.stdin.write(
      encodeMcp({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "lcm_grep",
          arguments: { pattern: "Lexar", mode: "full_text", scope: "both", limit: 5 },
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
    expect(messages.map((message) => message.id)).toEqual([1, 2, 3]);
    expect(JSON.stringify(messages[1])).toContain("lcm_expand_query");
    expect(JSON.stringify(messages[2])).toContain("Lexar");
  });

  it("starts over MCP stdio using the checked-in .mcp.json command", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const pluginRoot = join(process.cwd(), "plugins/codex-lcm-reader");
    const mcpConfig = JSON.parse(
      readFileSync(join(pluginRoot, ".mcp.json"), "utf8"),
    ) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd: string }>;
    };
    const server = mcpConfig.mcpServers["codex-lcm-reader"];

    const child = spawn(server.command, server.args, {
      cwd: join(pluginRoot, server.cwd),
      env: { ...process.env, LCM_CODEX_DB_PATH: fixture.dbPath },
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
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`MCP config server timed out. stderr=${stderr}`));
      }, 5_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`MCP config server exited ${code}. stderr=${stderr}`));
      });
    });

    const messages = decodeMcp(stdout);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain("lcm_expand_query");
  });

  it("starts over MCP stdio when invoked through an installed symlink path", async () => {
    const fixture = await createLcmFixture();
    tempDirs.add(fixture.tempDir);
    const installDir = mkdtempSync(join(tmpdir(), "codex-lcm-reader-install-"));
    tempDirs.add(installDir);
    const symlinkedPlugin = join(installDir, "codex-lcm-reader");
    symlinkSync(join(process.cwd(), "plugins/codex-lcm-reader"), symlinkedPlugin, "dir");
    const scriptPath = join(symlinkedPlugin, "scripts/mcp-server.mjs");

    const child = spawn(process.execPath, [scriptPath], {
      cwd: symlinkedPlugin,
      env: { ...process.env, LCM_CODEX_DB_PATH: fixture.dbPath },
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
    child.stdin.end();

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`MCP symlink server timed out. stderr=${stderr}`));
      }, 5_000);
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("exit", (code) => {
        clearTimeout(timeout);
        if (code === 0) resolve();
        else reject(new Error(`MCP symlink server exited ${code}. stderr=${stderr}`));
      });
    });

    const messages = decodeMcp(stdout);
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages[0])).toContain("lcm_grep");
  });
});
