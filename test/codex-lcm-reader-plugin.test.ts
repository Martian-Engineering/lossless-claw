import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
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
      content: "We recovered the Lexar drive and audited the LCM plugin idea.",
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
  await summaryStore.linkSummaryToParents("sum_codex_reader_child", [
    "sum_codex_reader_parent",
  ]);
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
    const results = result.structuredContent?.results as Array<{ type: string; id: string }>;
    expect(results.some((row) => row.type === "message")).toBe(true);
    expect(results.some((row) => row.type === "summary")).toBe(true);
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
      { id: "sum_codex_reader_child" },
      { dbPath: fixture.dbPath },
    );

    const item = result.structuredContent?.item as {
      parentIds: string[];
      messageIds: number[];
    };
    expect(item.parentIds).toEqual(["sum_codex_reader_parent"]);
    expect(item.messageIds).toHaveLength(2);
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
