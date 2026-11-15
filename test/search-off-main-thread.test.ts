import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { SearchWorkerClient } from "../src/search/search-worker-client.js";
import { ConversationStore, type MessageSearchInput } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const tempDirs: string[] = [];
let workerUrl: URL;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  const outfile = join(makeTempDir("lossless-claw-search-worker-build-"), "search-worker.js");
  await build({
    entryPoints: [join(import.meta.dirname, "../src/search/search-worker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  workerUrl = new URL(`file://${outfile}`);
});

afterEach(() => {
  closeLcmConnection();
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function seedDatabase(messageCount: number): Promise<{
  db: DatabaseSync;
  dbPath: string;
  fts5Available: boolean;
  conversationId: number;
}> {
  const dbPath = join(makeTempDir("lossless-claw-search-"), "lcm.db");
  const db = getLcmConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const store = new ConversationStore(db, { fts5Available });
  const conversation = await store.createConversation({ sessionId: "search-session" });
  const base = Date.parse("2026-11-01T00:00:00Z");
  await store.createMessagesBulk(
    Array.from({ length: messageCount }, (_, index) => ({
      conversationId: conversation.conversationId,
      seq: index + 1,
      role: "tool" as const,
      content: index === 0
        ? "needle-oldest gateway stall evidence"
        : `routine gateway output ${index} ${"x".repeat(64)}`,
      tokenCount: 20,
      createdAt: new Date(base + index * 60_000),
    })),
  );
  return { db, dbPath, fts5Available, conversationId: conversation.conversationId };
}

describe("bounded message scans", () => {
  it("stops a regex scan at the row budget and reports that older rows were skipped", async () => {
    const { db, fts5Available } = await seedDatabase(30);
    const store = new ConversationStore(db, {
      fts5Available,
      searchScanLimits: { regexMaxRows: 10, chunkRows: 4 },
    });

    const bounded = store.searchMessagesInProcess({ query: "needle-\\w+", mode: "regex" });
    expect(bounded).toEqual({ results: [], scanLimited: true });

    const recent = store.searchMessagesInProcess({ query: "routine gateway output 2\\d", mode: "regex", limit: 3 });
    expect(recent.scanLimited).toBe(false);
    expect(recent.results.map((result) => result.snippet)).toEqual([
      "routine gateway output 29",
      "routine gateway output 28",
      "routine gateway output 27",
    ]);
  });
});

describe("SearchWorkerClient", () => {
  it("answers searches from its own read-only connection while the main connection holds a write lock", async () => {
    const { db, dbPath, fts5Available, conversationId } = await seedDatabase(30);
    const inProcessConversations = new ConversationStore(db, { fts5Available });
    const inProcessSummaries = new SummaryStore(db, { fts5Available });
    const client = new SearchWorkerClient({ workerUrl, databasePath: dbPath, fts5Available });
    const workerConversations = new ConversationStore(db, { fts5Available });
    workerConversations.setSearchExecutor(client);
    const workerSummaries = new SummaryStore(db, { fts5Available });
    workerSummaries.setSearchExecutor(client);
    try {
      const inputs: MessageSearchInput[] = [
        { query: "needle-\\w+", mode: "regex", conversationId },
        { query: "gateway", mode: "full_text", limit: 5 },
        { query: "stall evidence", mode: "full_text", conversationIds: [conversationId] },
      ];
      const expected = await Promise.all(
        inputs.map((input) => inProcessConversations.searchMessagesWithScanInfo(input)),
      );

      db.exec("BEGIN IMMEDIATE");
      try {
        const actual = await Promise.all(
          inputs.map((input) => workerConversations.searchMessagesWithScanInfo(input)),
        );
        expect(actual).toEqual(expected);
        expect(await workerSummaries.searchSummaries({ query: "gateway", mode: "full_text" })).toEqual(
          await inProcessSummaries.searchSummaries({ query: "gateway", mode: "full_text" }),
        );
      } finally {
        db.exec("ROLLBACK");
      }
    } finally {
      await client.close();
    }
  });

  it("rejects a search that exceeds its timeout instead of waiting on the worker", async () => {
    const { dbPath, fts5Available } = await seedDatabase(5);
    const client = new SearchWorkerClient({
      workerUrl,
      databasePath: dbPath,
      fts5Available,
      timeoutMs: 0,
    });
    try {
      await expect(client.searchMessages({ query: "gateway", mode: "regex" })).rejects.toThrow(
        /timed out/,
      );
    } finally {
      await client.close();
    }
  });
});
