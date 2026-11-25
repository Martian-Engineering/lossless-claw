import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { runDoctorCleanerTask } from "../src/plugin/lcm-doctor-cleaner-task.js";
import { applyDoctorCleaners } from "../src/plugin/lcm-doctor-cleaners.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const tempDirs: string[] = [];
let cleanerWorkerUrl: URL;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  const outfile = join(makeTempDir("lossless-claw-cleaner-worker-build-"), "doctor-cleaner-worker.js");
  await build({
    entryPoints: [join(import.meta.dirname, "../src/plugin/doctor-cleaner-worker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  cleanerWorkerUrl = new URL(`file://${outfile}`);
});

afterEach(() => {
  closeLcmConnection();
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Seed cron conversations with summaries and context items plus one kept conversation. */
async function seedCleanerDatabase(cronConversations: number): Promise<{
  db: DatabaseSync;
  dbPath: string;
  keptConversationId: number;
}> {
  const dbPath = join(makeTempDir("lossless-claw-cleaner-"), "lcm.db");
  const db = getLcmConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversations = new ConversationStore(db, { fts5Available });
  const summaries = new SummaryStore(db, { fts5Available });

  const seedConversation = async (sessionKey: string, label: string) => {
    const conversation = await conversations.createConversation({ sessionId: label, sessionKey });
    const messages = await conversations.createMessagesBulk([
      { conversationId: conversation.conversationId, seq: 1, role: "user", content: `${label} run`, tokenCount: 3 },
      { conversationId: conversation.conversationId, seq: 2, role: "assistant", content: `${label} done`, tokenCount: 3 },
    ]);
    const summaryId = `sum_${label}`;
    await summaries.insertSummary({
      summaryId,
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `${label} summary`,
      tokenCount: 3,
    });
    await summaries.linkSummaryToMessages(summaryId, messages.map((message) => message.messageId));
    await summaries.appendContextSummary(conversation.conversationId, summaryId);
    await summaries.appendContextMessage(conversation.conversationId, messages[1]!.messageId);
    return conversation.conversationId;
  };

  for (let index = 0; index < cronConversations; index += 1) {
    await seedConversation(`agent:main:cron:job-${index}`, `cron-${index}`);
  }
  const keptConversationId = await seedConversation("agent:main:main", "kept");
  return { db, dbPath, keptConversationId };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("doctor cleaner apply", () => {
  it("deletes matched conversations in bounded write transactions", async () => {
    const { db, dbPath, keptConversationId } = await seedCleanerDatabase(5);
    const execSpy = vi.spyOn(db, "exec");

    const result = applyDoctorCleaners(db, {
      databasePath: dbPath,
      filterIds: ["cron_sessions"],
      agentIds: ["main"],
      batchLimits: { maxConversations: 2, maxMessages: 100 },
    });

    expect(result).toMatchObject({ kind: "applied", deletedConversations: 5, deletedMessages: 10 });
    const statements = execSpy.mock.calls.map(([sql]) => String(sql));
    expect(statements.filter((sql) => sql === "BEGIN IMMEDIATE")).toHaveLength(3);
    expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(3);
    expect(countRows(db, "conversations")).toBe(1);
    expect(countRows(db, "messages")).toBe(2);
    expect(countRows(db, "summaries")).toBe(1);
    expect(countRows(db, "context_items")).toBe(2);
    expect(
      (db.prepare(`SELECT conversation_id FROM conversations`).get() as { conversation_id: number })
        .conversation_id,
    ).toBe(keptConversationId);
  });

  it("keeps retained summaries searchable when the summary FTS tables are renumbered mid-apply", async () => {
    const { db, dbPath, keptConversationId } = await seedCleanerDatabase(3);
    if (!getLcmDbFeatures(db).fts5Available) {
      return;
    }
    const originalExec = db.exec.bind(db);
    let renumbered = false;
    vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      if (sql === "BEGIN IMMEDIATE" && !renumbered) {
        renumbered = true;
        for (const table of ["summaries_fts", "summaries_fts_cjk"]) {
          const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(table);
          if (!exists) {
            continue;
          }
          originalExec(`DELETE FROM ${table}`);
          originalExec(
            `INSERT INTO ${table} (summary_id, content)
             SELECT summary_id, content FROM summaries ORDER BY summary_id DESC`,
          );
        }
      }
      return originalExec(sql);
    });

    const result = applyDoctorCleaners(db, {
      databasePath: dbPath,
      filterIds: ["cron_sessions"],
      agentIds: ["main"],
      batchLimits: { maxConversations: 1, maxMessages: 100 },
    });

    expect(renumbered).toBe(true);
    expect(result).toMatchObject({ kind: "applied", deletedConversations: 3 });
    expect(
      db.prepare("SELECT summary_id FROM summaries_fts WHERE summaries_fts MATCH ?").all("kept"),
    ).toEqual([{ summary_id: "sum_kept" }]);
    expect(db.prepare("SELECT summary_id FROM summaries_fts").all()).toEqual([
      { summary_id: "sum_kept" },
    ]);
    expect(keptConversationId).toBeGreaterThan(0);
  });

  it("runs scan and apply on a worker thread without using the caller's connection", async () => {
    const { db, dbPath } = await seedCleanerDatabase(3);
    const untouchable = new Proxy({} as DatabaseSync, {
      get() {
        throw new Error("the caller's connection must not be used");
      },
    });

    const scan = await runDoctorCleanerTask(
      untouchable,
      { kind: "scan", databasePath: dbPath, filterIds: ["cron_sessions"], agentIds: ["main"] },
      { workerUrl: cleanerWorkerUrl },
    );
    expect(scan).toMatchObject({
      kind: "scan",
      scan: { totalDistinctConversations: 3, totalDistinctMessages: 6 },
    });

    const applied = await runDoctorCleanerTask(
      untouchable,
      {
        kind: "apply",
        databasePath: dbPath,
        filterIds: ["cron_sessions"],
        agentIds: ["main"],
        vacuum: false,
      },
      { workerUrl: cleanerWorkerUrl },
    );
    expect(applied).toMatchObject({
      kind: "apply",
      result: { kind: "applied", deletedConversations: 3, deletedMessages: 6 },
      quickCheck: "ok",
    });
    expect(countRows(db, "conversations")).toBe(1);
  });
});
