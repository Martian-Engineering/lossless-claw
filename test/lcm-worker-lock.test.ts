import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";

type ColumnInfo = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

describe("lcm_worker_lock table (v4.1.1 A9)", () => {
  it("is created by runLcmMigrations with the expected schema", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    const columns = db.prepare("PRAGMA table_info(lcm_worker_lock)").all() as ColumnInfo[];
    const byName = new Map(columns.map((c) => [c.name, c]));

    expect(byName.has("job_kind")).toBe(true);
    expect(byName.get("job_kind")?.pk).toBe(1);
    expect(byName.get("job_kind")?.type.toUpperCase()).toBe("TEXT");

    expect(byName.has("worker_id")).toBe(true);
    expect(byName.get("worker_id")?.notnull).toBe(1);

    expect(byName.has("acquired_at")).toBe(true);
    expect(byName.get("acquired_at")?.notnull).toBe(1);

    expect(byName.has("expires_at")).toBe(true);
    expect(byName.get("expires_at")?.notnull).toBe(1);

    // v4.1.1 A9 specifically: last_heartbeat_at column must exist for the
    // §0.5 gateway-fallback rule to work (BOTH expires_at < now AND
    // last_heartbeat_at < now - 300s).
    expect(byName.has("last_heartbeat_at")).toBe(true);
    expect(byName.get("last_heartbeat_at")?.notnull).toBe(1);

    expect(byName.has("job_session_key")).toBe(true);
    expect(byName.get("job_session_key")?.notnull).toBe(0); // nullable

    expect(byName.has("job_metadata")).toBe(true);
    expect(byName.get("job_metadata")?.notnull).toBe(0); // nullable for JSON sidecar

    db.close();
  });

  it("is idempotent (running migrations twice does not fail)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });
    expect(() => runLcmMigrations(db, { fts5Available: false })).not.toThrow();
    db.close();
  });

  it("supports basic acquire pattern (INSERT new lock + UPDATE heartbeat)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    // Acquire the condensation lock for worker-A with 90s TTL
    db.prepare(
      `INSERT INTO lcm_worker_lock (job_kind, worker_id, expires_at)
       VALUES (?, ?, datetime('now', '+90 seconds'))`,
    ).run("condensation", "worker-A");

    const acquired = db
      .prepare("SELECT * FROM lcm_worker_lock WHERE job_kind = ?")
      .get("condensation") as { worker_id: string } | undefined;
    expect(acquired?.worker_id).toBe("worker-A");

    // Second worker attempting same kind hits PK conflict (one lock per kind)
    expect(() =>
      db
        .prepare(
          `INSERT INTO lcm_worker_lock (job_kind, worker_id, expires_at)
           VALUES (?, ?, datetime('now', '+90 seconds'))`,
        )
        .run("condensation", "worker-B"),
    ).toThrow();

    // Heartbeat refreshes both expires_at and last_heartbeat_at
    db.prepare(
      `UPDATE lcm_worker_lock
       SET expires_at = datetime('now', '+90 seconds'),
           last_heartbeat_at = datetime('now')
       WHERE job_kind = ? AND worker_id = ?`,
    ).run("condensation", "worker-A");

    db.close();
  });

  it("supports stale-lock GC (expires_at < now → row can be deleted)", () => {
    const db = new DatabaseSync(":memory:");
    runLcmMigrations(db, { fts5Available: false });

    // Insert an expired lock (expires_at in the past)
    db.prepare(
      `INSERT INTO lcm_worker_lock (job_kind, worker_id, expires_at, last_heartbeat_at)
       VALUES (?, ?, datetime('now', '-10 seconds'), datetime('now', '-400 seconds'))`,
    ).run("extraction", "worker-stale");

    const beforeGc = db
      .prepare("SELECT COUNT(*) AS n FROM lcm_worker_lock WHERE job_kind = ?")
      .get("extraction") as { n: number };
    expect(beforeGc.n).toBe(1);

    // GC pattern: delete locks whose expires_at has passed
    const result = db
      .prepare(`DELETE FROM lcm_worker_lock WHERE expires_at < datetime('now')`)
      .run();
    expect(result.changes).toBeGreaterThanOrEqual(1);

    const afterGc = db
      .prepare("SELECT COUNT(*) AS n FROM lcm_worker_lock WHERE job_kind = ?")
      .get("extraction") as { n: number };
    expect(afterGc.n).toBe(0);

    db.close();
  });
});
