import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const MAX_ROW_SCAN = 10_000;

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    summaryStore: new SummaryStore(db, { fts5Available }),
  };
}

/** Records how many rows each `.all()` call on `db` returned. */
function recordRowCounts(db: DatabaseSync): number[] {
  const counts: number[] = [];
  const prepare = db.prepare.bind(db);
  (db as { prepare: unknown }).prepare = (sql: string) => {
    const stmt = prepare(sql);
    return new Proxy(stmt, {
      get(target, prop) {
        const value = Reflect.get(target, prop) as unknown;
        if (prop === "all") {
          return (...args: unknown[]) => {
            const rows = (target.all as (...a: unknown[]) => unknown[])(...args);
            counts.push(rows.length);
            return rows;
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  };
  return counts;
}

describe("regex search row cap", () => {
  it("reads at most MAX_ROW_SCAN message rows and still returns the newest matches", async () => {
    const { db, conversationStore } = createStores();
    const conversation = await conversationStore.createConversation({ sessionId: "regex-cap" });
    await conversationStore.createMessagesBulk(
      Array.from({ length: MAX_ROW_SCAN + 50 }, (_, seq) => ({
        conversationId: conversation.conversationId,
        seq,
        role: "user" as const,
        content: `message ${seq}`,
        tokenCount: 2,
      })),
    );
    const counts = recordRowCounts(db);

    const results = await conversationStore.searchMessages({
      query: "message",
      mode: "regex",
      limit: 5,
    });

    expect(results).toHaveLength(5);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_ROW_SCAN);
    db.close();
  });

  it("reads at most MAX_ROW_SCAN summary rows and still returns the newest matches", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({ sessionId: "regex-cap-sum" });
    for (let i = 0; i < MAX_ROW_SCAN + 50; i++) {
      await summaryStore.insertSummary({
        summaryId: `sum_cap_${i}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: `summary ${i}`,
        tokenCount: 2,
      });
    }
    const counts = recordRowCounts(db);

    const results = await summaryStore.searchSummaries({
      query: "summary",
      mode: "regex",
      limit: 5,
    });

    expect(results).toHaveLength(5);
    expect(Math.max(...counts)).toBeLessThanOrEqual(MAX_ROW_SCAN);
    db.close();
  });
});
