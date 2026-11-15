import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { closeLcmConnection, getLcmConnection } from "../src/db/connection.js";
import { createLcmDatabaseBackup } from "../src/plugin/lcm-db-backup.js";

const tempDirs: string[] = [];
let backupWorkerUrl: URL;

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

beforeAll(async () => {
  const outfile = join(makeTempDir("lossless-claw-backup-worker-build-"), "db-backup-worker.js");
  await build({
    entryPoints: [join(import.meta.dirname, "../src/plugin/db-backup-worker.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "silent",
  });
  backupWorkerUrl = new URL(`file://${outfile}`);
});

afterEach(() => {
  closeLcmConnection();
});

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("database backup worker", () => {
  it("writes the committed state from its own connection while the caller holds a write transaction", async () => {
    const dbPath = join(makeTempDir("lossless-claw-backup-"), "lcm.db");
    const db = getLcmConnection(dbPath);
    db.exec("CREATE TABLE notes (body TEXT NOT NULL)");
    db.prepare("INSERT INTO notes (body) VALUES (?)").run("committed");
    const untouchable = new Proxy({} as DatabaseSync, {
      get() {
        throw new Error("the caller's connection must not be used");
      },
    });

    db.exec("BEGIN IMMEDIATE");
    let backupPath: string | null;
    try {
      db.prepare("INSERT INTO notes (body) VALUES (?)").run("uncommitted");
      backupPath = await createLcmDatabaseBackup(untouchable, {
        databasePath: dbPath,
        label: "worker-test",
        workerUrl: backupWorkerUrl,
      });
    } finally {
      db.exec("ROLLBACK");
    }

    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
    const backup = new DatabaseSync(backupPath!, { readOnly: true });
    try {
      expect(backup.prepare("SELECT body FROM notes").all()).toEqual([{ body: "committed" }]);
    } finally {
      backup.close();
    }
  });

  it("reports a backup failure from the worker", async () => {
    const dbPath = join(makeTempDir("lossless-claw-backup-missing-"), "missing.db");
    await expect(
      createLcmDatabaseBackup(new DatabaseSync(":memory:"), {
        databasePath: dbPath,
        label: "worker-test",
        workerUrl: backupWorkerUrl,
      }),
    ).rejects.toThrow();
  });
});
