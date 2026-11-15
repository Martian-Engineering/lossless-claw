import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";

describe("foreign-key child indexes", () => {
  it("indexes every child column that a parent delete has to look up", () => {
    const db = new DatabaseSync(":memory:");
    try {
      runLcmMigrations(db, { fts5Available: getLcmDbFeatures(db).fts5Available });
      const tables = (db.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%'`,
      ).all() as Array<{ name: string }>).map((row) => row.name);
      const unindexed: string[] = [];
      for (const table of tables) {
        const foreignKeys = db.prepare(`SELECT "from" AS column FROM pragma_foreign_key_list(?)`)
          .all(table) as Array<{ column: string }>;
        if (foreignKeys.length === 0) {
          continue;
        }
        const leadingColumns = new Set(
          (db.prepare(`SELECT name FROM pragma_index_list(?)`).all(table) as Array<{ name: string }>)
            .map((index) => (db.prepare(`SELECT name FROM pragma_index_info(?) WHERE seqno = 0`)
              .get(index.name) as { name?: string } | undefined)?.name),
        );
        const primaryKey = (db.prepare(`SELECT name FROM pragma_table_info(?) WHERE pk = 1`)
          .get(table) as { name?: string } | undefined)?.name;
        for (const { column } of foreignKeys) {
          if (!leadingColumns.has(column) && primaryKey !== column) {
            unindexed.push(`${table}.${column}`);
          }
        }
      }
      expect(unindexed).toEqual([]);
    } finally {
      db.close();
    }
  });
});
