import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import * as features from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";

const tempDirs: string[] = [];

afterEach(() => {
  closeLcmConnection();
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("runLcmMigrations summary depth backfill", () => {
  it("adds depth and metadata from summary lineage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy.db");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE summaries (
        summary_id TEXT PRIMARY KEY,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('leaf', 'condensed')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        file_ids TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE messages (
        message_id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL REFERENCES conversations(conversation_id) ON DELETE CASCADE,
        seq INTEGER NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
        content TEXT NOT NULL,
        token_count INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (conversation_id, seq)
      );

      CREATE TABLE summary_messages (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        message_id INTEGER NOT NULL REFERENCES messages(message_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, message_id)
      );

      CREATE TABLE summary_parents (
        summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE CASCADE,
        parent_summary_id TEXT NOT NULL REFERENCES summaries(summary_id) ON DELETE RESTRICT,
        ordinal INTEGER NOT NULL,
        PRIMARY KEY (summary_id, parent_summary_id)
      );
    `);

    db.prepare(`INSERT INTO conversations (conversation_id, session_id) VALUES (?, ?)`).run(
      1,
      "legacy-session",
    );

    const insertSummaryStmt = db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    );
    insertSummaryStmt.run("sum_leaf_a", 1, "leaf", "leaf-a", 10);
    insertSummaryStmt.run("sum_leaf_b", 1, "leaf", "leaf-b", 10);
    insertSummaryStmt.run("sum_condensed_1", 1, "condensed", "condensed-1", 10);
    insertSummaryStmt.run("sum_condensed_2", 1, "condensed", "condensed-2", 10);
    insertSummaryStmt.run("sum_condensed_orphan", 1, "condensed", "condensed-orphan", 10);

    const insertMessageStmt = db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertMessageStmt.run(1, 1, 1, "user", "m1", 5, "2026-01-01 10:00:00");
    insertMessageStmt.run(2, 1, 2, "assistant", "m2", 5, "2026-01-01 11:30:00");
    insertMessageStmt.run(3, 1, 3, "user", "m3", 5, "2026-01-01 12:45:00");

    const linkMessageStmt = db.prepare(
      `INSERT INTO summary_messages (summary_id, message_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    linkMessageStmt.run("sum_leaf_a", 1, 0);
    linkMessageStmt.run("sum_leaf_a", 2, 1);
    linkMessageStmt.run("sum_leaf_b", 3, 0);

    const linkStmt = db.prepare(
      `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
       VALUES (?, ?, ?)`,
    );
    linkStmt.run("sum_condensed_1", "sum_leaf_a", 0);
    linkStmt.run("sum_condensed_1", "sum_leaf_b", 1);
    linkStmt.run("sum_condensed_2", "sum_condensed_1", 0);

    runLcmMigrations(db);

    const summaryColumns = db.prepare(`PRAGMA table_info(summaries)`).all() as Array<{
      name?: string;
    }>;
    const conversationColumns = db.prepare(`PRAGMA table_info(conversations)`).all() as Array<{
      name?: string;
    }>;
    expect(conversationColumns.some((column) => column.name === "session_key")).toBe(true);
    expect(conversationColumns.some((column) => column.name === "active")).toBe(true);
    expect(conversationColumns.some((column) => column.name === "archived_at")).toBe(true);
    expect(conversationColumns.some((column) => column.name === "bootstrapped_at")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "depth")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "earliest_at")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "latest_at")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "descendant_count")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "descendant_token_count")).toBe(true);
    expect(summaryColumns.some((column) => column.name === "source_message_token_count")).toBe(true);

    const depthRows = db
      .prepare(
        `SELECT summary_id, depth, earliest_at, latest_at, descendant_count,
                descendant_token_count, source_message_token_count
         FROM summaries
         ORDER BY summary_id`,
      )
      .all() as Array<{
      summary_id: string;
      depth: number;
      earliest_at: string | null;
      latest_at: string | null;
      descendant_count: number;
      descendant_token_count: number;
      source_message_token_count: number;
    }>;
    const depthBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.depth]));
    const earliestBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.earliest_at]));
    const latestBySummaryId = new Map(depthRows.map((row) => [row.summary_id, row.latest_at]));
    const descendantCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.descendant_count]),
    );
    const descendantTokenCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.descendant_token_count]),
    );
    const sourceMessageTokenCountBySummaryId = new Map(
      depthRows.map((row) => [row.summary_id, row.source_message_token_count]),
    );

    expect(depthBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(depthBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(depthBySummaryId.get("sum_condensed_1")).toBe(1);
    expect(depthBySummaryId.get("sum_condensed_2")).toBe(2);
    expect(depthBySummaryId.get("sum_condensed_orphan")).toBe(1);

    const leafAEarliest = earliestBySummaryId.get("sum_leaf_a");
    const leafALatest = latestBySummaryId.get("sum_leaf_a");
    const leafBEarliest = earliestBySummaryId.get("sum_leaf_b");
    const leafBLatest = latestBySummaryId.get("sum_leaf_b");
    const condensed1Earliest = earliestBySummaryId.get("sum_condensed_1");
    const condensed1Latest = latestBySummaryId.get("sum_condensed_1");
    const condensed2Earliest = earliestBySummaryId.get("sum_condensed_2");
    const condensed2Latest = latestBySummaryId.get("sum_condensed_2");

    expect(leafAEarliest).toContain("2026-01-01");
    expect(leafALatest).toContain("2026-01-01");
    expect(leafBEarliest).toContain("2026-01-01");
    expect(leafBLatest).toContain("2026-01-01");
    expect(condensed1Earliest).toContain("2026-01-01");
    expect(condensed1Latest).toContain("2026-01-01");
    expect(condensed2Earliest).toContain("2026-01-01");
    expect(condensed2Latest).toContain("2026-01-01");

    expect(new Date(leafAEarliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafALatest as string).getTime(),
    );
    expect(new Date(leafBEarliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafBLatest as string).getTime(),
    );
    expect(new Date(condensed1Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(condensed1Latest as string).getTime(),
    );
    expect(new Date(condensed2Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(condensed2Latest as string).getTime(),
    );
    expect(new Date(condensed1Earliest as string).getTime()).toBeLessThanOrEqual(
      new Date(leafAEarliest as string).getTime(),
    );
    expect(new Date(condensed1Latest as string).getTime()).toBeGreaterThanOrEqual(
      new Date(leafBLatest as string).getTime(),
    );
    expect(earliestBySummaryId.get("sum_condensed_orphan")).toBeTypeOf("string");
    expect(latestBySummaryId.get("sum_condensed_orphan")).toBeTypeOf("string");

    expect(descendantCountBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(descendantCountBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(descendantCountBySummaryId.get("sum_condensed_1")).toBe(2);
    expect(descendantCountBySummaryId.get("sum_condensed_2")).toBe(3);
    expect(descendantCountBySummaryId.get("sum_condensed_orphan")).toBe(0);

    expect(descendantTokenCountBySummaryId.get("sum_leaf_a")).toBe(0);
    expect(descendantTokenCountBySummaryId.get("sum_leaf_b")).toBe(0);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_1")).toBe(20);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_2")).toBe(30);
    expect(descendantTokenCountBySummaryId.get("sum_condensed_orphan")).toBe(0);

    expect(sourceMessageTokenCountBySummaryId.get("sum_leaf_a")).toBe(10);
    expect(sourceMessageTokenCountBySummaryId.get("sum_leaf_b")).toBe(5);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_1")).toBe(15);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_2")).toBe(15);
    expect(sourceMessageTokenCountBySummaryId.get("sum_condensed_orphan")).toBe(0);
  });

  it("replaces global session_key uniqueness with active-row uniqueness", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "session-key-active.db");
    const db = getLcmConnection(dbPath);

    db.exec(`
      CREATE TABLE conversations (
        conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        session_key TEXT,
        title TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE UNIQUE INDEX conversations_session_key_idx ON conversations (session_key);
    `);

    db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES (?, ?)`).run(
      "legacy-session",
      "agent:main:main",
    );

    runLcmMigrations(db, { fts5Available: false });

    const activeRow = db
      .prepare(`SELECT active, archived_at FROM conversations WHERE session_key = ?`)
      .get("agent:main:main") as { active: number; archived_at: string | null };
    expect(activeRow.active).toBe(1);
    expect(activeRow.archived_at).toBeNull();

    const indexRows = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations'`)
      .all() as Array<{ name: string; sql: string | null }>;
    const indexSqlByName = new Map(indexRows.map((row) => [row.name, row.sql ?? ""]));

    expect(indexSqlByName.has("conversations_session_key_idx")).toBe(false);
    expect(indexSqlByName.get("conversations_active_session_key_idx")).toContain(
      "WHERE session_key IS NOT NULL AND active = 1",
    );

    // Verify perf indexes from #291
    const allIndexRows = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index'`)
      .all() as Array<{ name: string }>;
    const allIndexNames = new Set(allIndexRows.map((r) => r.name));
    expect(allIndexNames.has("summary_messages_message_idx")).toBe(true);
    expect(allIndexNames.has("summaries_conv_depth_kind_idx")).toBe(true);

    db.prepare(
      `INSERT INTO conversations (session_id, session_key, active, archived_at)
       VALUES (?, ?, 0, datetime('now'))`,
    ).run("archived-session", "agent:main:main");

    expect(() =>
      db
        .prepare(`INSERT INTO conversations (session_id, session_key, active) VALUES (?, ?, 1)`)
        .run("duplicate-active-session", "agent:main:main"),
    ).toThrow();
  });

  it("skips FTS tables when fts5 is unavailable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "no-fts.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const ftsTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%_fts%'")
      .all() as Array<{ name: string }>;

    expect(ftsTables).toEqual([]);
  });

  it("recreates summaries_fts when the schema probe throws", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "malformed-summaries-fts.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: true });

    db.prepare(`INSERT INTO conversations (conversation_id, session_id, title) VALUES (?, ?, ?)`).run(
      1,
      "legacy-session",
      "Legacy",
    );
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run("sum-1", 1, "leaf", "recover this summary", 5);

    const dbWithBrokenSummariesProbe = {
      prepare(sql: string) {
        if (sql.startsWith("PRAGMA table_info(") && sql.includes("summaries_fts")) {
          throw new Error("malformed database schema (1)");
        }
        return db.prepare(sql);
      },
      exec(sql: string) {
        return db.exec(sql);
      },
    } as unknown as Parameters<typeof runLcmMigrations>[0];

    expect(() =>
      runLcmMigrations(dbWithBrokenSummariesProbe, { fts5Available: true }),
    ).not.toThrow();

    const summariesFtsColumns = db.prepare(`PRAGMA table_info(summaries_fts)`).all() as Array<{
      name?: string;
    }>;
    expect(summariesFtsColumns.map((column) => column.name)).toEqual(["summary_id", "content"]);

    const summariesFtsRows = db
      .prepare(`SELECT summary_id, content FROM summaries_fts ORDER BY summary_id`)
      .all() as Array<{
      summary_id: string;
      content: string;
    }>;
    expect(summariesFtsRows).toEqual([
      {
        summary_id: "sum-1",
        content: "recover this summary",
      },
    ]);
  });

  it("recreates summaries_fts when a shadow table is missing", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "missing-summaries-fts-shadow.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: true });

    db.prepare(`INSERT INTO conversations (conversation_id, session_id, title) VALUES (?, ?, ?)`).run(
      1,
      "legacy-session",
      "Legacy",
    );
    db.prepare(
      `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, file_ids)
       VALUES (?, ?, ?, ?, ?, '[]')`,
    ).run("sum-1", 1, "leaf", "recover this summary", 5);

    db.exec(`DROP TABLE summaries_fts`);
    db.exec(`CREATE TABLE summaries_fts (summary_id TEXT PRIMARY KEY)`);

    expect(() => runLcmMigrations(db, { fts5Available: true })).not.toThrow();

    const summariesFtsColumns = db.prepare(`PRAGMA table_info(summaries_fts)`).all() as Array<{
      name?: string;
    }>;
    expect(summariesFtsColumns.map((column) => column.name)).toEqual(["summary_id", "content"]);

    const shadowTables = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'summaries_fts_data',
           'summaries_fts_idx',
           'summaries_fts_content',
           'summaries_fts_docsize',
           'summaries_fts_config'
         )
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(shadowTables.map((row) => row.name)).toEqual([
      "summaries_fts_config",
      "summaries_fts_content",
      "summaries_fts_data",
      "summaries_fts_docsize",
      "summaries_fts_idx",
    ]);

    const summariesFtsRows = db
      .prepare(`SELECT summary_id, content FROM summaries_fts ORDER BY summary_id`)
      .all() as Array<{
      summary_id: string;
      content: string;
    }>;
    expect(summariesFtsRows).toEqual([
      {
        summary_id: "sum-1",
        content: "recover this summary",
      },
    ]);
  });

  it("drops stale summaries_fts_cjk when trigram tokenizer support is unavailable", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "stale-summaries-fts-cjk.db");
    const db = getLcmConnection(dbPath);

    vi.spyOn(features, "getLcmDbFeatures").mockReturnValue({
      fts5Available: true,
      trigramTokenizerAvailable: false,
    });

    runLcmMigrations(db, { fts5Available: true });
    db.exec(`CREATE TABLE summaries_fts_cjk (summary_id TEXT, content TEXT)`);

    expect(() => runLcmMigrations(db, { fts5Available: true })).not.toThrow();

    const row = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = 'summaries_fts_cjk'
         LIMIT 1`,
      )
      .get() as { name?: string } | undefined;

    expect(row).toBeUndefined();
  });
  it("drops stale summaries_fts_cjk before probing other standalone FTS tables", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "stale-summaries-fts-cjk-ordering.db");
    const db = getLcmConnection(dbPath);

    vi.spyOn(features, "getLcmDbFeatures").mockReturnValue({
      fts5Available: true,
      trigramTokenizerAvailable: false,
    });

    runLcmMigrations(db, { fts5Available: true });
    db.exec(`CREATE TABLE summaries_fts_cjk (summary_id TEXT, content TEXT)`);

    const dbWithPoisonedFtsProbe = {
      prepare(sql: string) {
        const staleCjkTable = db
          .prepare(
            `SELECT name
             FROM sqlite_master
             WHERE type = 'table' AND name = 'summaries_fts_cjk'
             LIMIT 1`,
          )
          .get() as { name?: string } | undefined;
        if (
          staleCjkTable &&
          sql.startsWith("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (")
        ) {
          throw new Error("malformed database schema (1)");
        }
        return db.prepare(sql);
      },
      exec(sql: string) {
        return db.exec(sql);
      },
    } as unknown as Parameters<typeof runLcmMigrations>[0];

    expect(() => runLcmMigrations(dbWithPoisonedFtsProbe, { fts5Available: true })).not.toThrow();

    const row = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE type = 'table' AND name = 'summaries_fts_cjk'
         LIMIT 1`,
      )
      .get() as { name?: string } | undefined;

    expect(row).toBeUndefined();
  });

  it("drops orphaned standalone FTS shadow tables before recreating the virtual table", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "orphaned-fts-shadow-tables.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: true });
    db.exec(`DROP TABLE summaries_fts`);
    db.exec(`CREATE TABLE summaries_fts_data (id INTEGER PRIMARY KEY, block BLOB)`);
    db.exec(`CREATE TABLE summaries_fts_idx (segid, term, pgno)`);
    db.exec(`CREATE TABLE summaries_fts_content (id INTEGER PRIMARY KEY, c0, c1)`);
    db.exec(`CREATE TABLE summaries_fts_docsize (id INTEGER PRIMARY KEY, sz BLOB)`);
    db.exec(`CREATE TABLE summaries_fts_config (k PRIMARY KEY, v)`);
    db.exec(`DELETE FROM summaries`);
    db.exec(`INSERT INTO conversations (session_id) VALUES ('shadow-recovery')`);
    db.exec(`
      INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, file_ids)
      VALUES ('sum-shadow', 1, 'leaf', 0, 'shadow recovery summary', 12, '[]')
    `);

    expect(() => runLcmMigrations(db, { fts5Available: true })).not.toThrow();

    const shadowRows = db
      .prepare(
        `SELECT name
         FROM sqlite_master
         WHERE name LIKE 'summaries_fts%'
           AND name NOT LIKE 'summaries_fts_cjk%'
         ORDER BY name`,
      )
      .all() as Array<{ name: string }>;

    expect(shadowRows.map((row) => row.name)).toEqual([
      "summaries_fts",
      "summaries_fts_config",
      "summaries_fts_content",
      "summaries_fts_data",
      "summaries_fts_docsize",
      "summaries_fts_idx",
    ]);

    const summariesFtsRows = db
      .prepare(`SELECT summary_id, content FROM summaries_fts ORDER BY summary_id`)
      .all() as Array<{
      summary_id: string;
      content: string;
    }>;
    expect(summariesFtsRows).toEqual([
      {
        summary_id: "sum-shadow",
        content: "shadow recovery summary",
      },
    ]);
  });
  it("creates conversation bootstrap state storage", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "bootstrap-state.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    const columns = db.prepare(`PRAGMA table_info(conversation_bootstrap_state)`).all() as Array<{
      name?: string;
    }>;

    expect(columns.map((column) => column.name)).toEqual([
      "conversation_id",
      "session_file_path",
      "last_seen_size",
      "last_seen_mtime_ms",
      "last_processed_offset",
      "last_processed_entry_hash",
      "updated_at",
    ]);
  });

  it("backfills legacy tool_call_id values from metadata.raw.call_id", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-migration-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "legacy-tool-call-id.db");
    const db = getLcmConnection(dbPath);

    runLcmMigrations(db, { fts5Available: false });

    db.prepare(
      `INSERT INTO conversations (conversation_id, session_id, title)
       VALUES (?, ?, ?)`,
    ).run(1, "legacy-session", "Legacy");
    db.prepare(
      `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(1, 1, 1, "assistant", "", 0);
    db.prepare(
      `INSERT INTO message_parts (
         part_id, message_id, session_id, part_type, ordinal, text_content,
         tool_call_id, tool_name, tool_input, tool_output, metadata
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "part-1",
      1,
      "legacy-session",
      "text",
      0,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify({
        rawType: "function_call",
        originalRole: "assistant",
        raw: {
          type: "function_call",
          call_id: "fc_legacy_123",
          name: "bash",
          arguments: { cmd: "pwd" },
        },
      }),
    );

    runLcmMigrations(db, { fts5Available: false });

    const row = db.prepare(
      `SELECT tool_call_id, tool_name, tool_input
       FROM message_parts
       WHERE part_id = ?`,
    ).get("part-1") as {
      tool_call_id: string | null;
      tool_name: string | null;
      tool_input: string | null;
    };

    expect(row.tool_call_id).toBe("fc_legacy_123");
    expect(row.tool_name).toBe("bash");
    expect(row.tool_input).toBe('{"cmd":"pwd"}');
  });
});
