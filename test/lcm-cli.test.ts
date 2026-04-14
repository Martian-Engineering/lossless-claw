import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import { createLcmDatabaseConnection, closeLcmConnection } from "../src/db/connection.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { runLcmRestoreCli } from "../src/plugin/lcm-cli.js";

const mocks = vi.hoisted(() => ({
  spawnSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  spawnSync: mocks.spawnSync,
}));

type RestoreFixture = {
  tempDir: string;
  dbPath: string;
};

function createRestoreFixture(): RestoreFixture {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-cli-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  try {
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });
  } finally {
    closeLcmConnection(db);
  }

  copyFileSync(dbPath, join(tempDir, "lcm.db.rotate-latest.bak"));
  writeFileSync(`${dbPath}-wal`, "wal");
  writeFileSync(`${dbPath}-shm`, "shm");

  return { tempDir, dbPath };
}

function addLiveDbMarker(dbPath: string): void {
  const db = createLcmDatabaseConnection(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS rollback_marker (
        value TEXT NOT NULL
      );
      DELETE FROM rollback_marker;
      INSERT INTO rollback_marker (value) VALUES ('live-db-state');
    `);
  } finally {
    closeLcmConnection(db);
  }
}

function hasLiveDbMarker(dbPath: string): boolean {
  const db = createLcmDatabaseConnection(dbPath);
  try {
    const row = db.prepare(`SELECT COUNT(*) AS total FROM rollback_marker`).get() as { total?: number };
    return (row.total ?? 0) > 0;
  } catch {
    return false;
  } finally {
    closeLcmConnection(db);
  }
}

describe("lossless restore cli", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    vi.restoreAllMocks();
    mocks.spawnSync.mockReset();
    vi.unstubAllEnvs();
    for (const tempDir of tempDirs) {
      closeLcmConnection(join(tempDir, "lcm.db"));
      rmSync(tempDir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("stops, restores, restarts, and verifies gateway health", () => {
    const fixture = createRestoreFixture();
    tempDirs.add(fixture.tempDir);
    vi.stubEnv("OPENCLAW_STATE_DIR", "/tmp/openclaw-restore-profile");

    mocks.spawnSync.mockReturnValue({
      status: 0,
      stdout: "{}",
      stderr: "",
    });

    let output = "";
    runLcmRestoreCli({
      config: resolveLcmConfig({}, { dbPath: fixture.dbPath }),
      target: "latest",
      writer: {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      },
    });

    const invokedArgs = mocks.spawnSync.mock.calls.map((call) => (call[1] as string[]).join(" "));
    expect(invokedArgs).toHaveLength(3);
    expect(invokedArgs[0]).toContain("gateway stop --json");
    expect(invokedArgs[1]).toContain("gateway start --json");
    expect(invokedArgs[2]).toContain("gateway status --require-rpc --json");
    expect(output).toContain("State dir: /tmp/openclaw-restore-profile");
    expect(output).toContain("Restore completed and gateway health checks passed.");
    expect(output).toContain("archived current db:");
    expect(output).toContain("archived wal:");
    expect(output).toContain("archived shm:");
    expect(existsSync(`${fixture.dbPath}-wal`)).toBe(false);
    expect(existsSync(`${fixture.dbPath}-shm`)).toBe(false);
    expect(
      readdirSync(fixture.tempDir).some(
        (entry) => entry.startsWith("lcm.db.pre-restore-latest-") && entry.endsWith(".bak"),
      ),
    ).toBe(true);
    expect(
      readdirSync(fixture.tempDir).some(
        (entry) => entry.startsWith("lcm.db-wal.pre-restore-latest-") && entry.endsWith(".bak"),
      ),
    ).toBe(true);
    expect(
      readdirSync(fixture.tempDir).some(
        (entry) => entry.startsWith("lcm.db-shm.pre-restore-latest-") && entry.endsWith(".bak"),
      ),
    ).toBe(true);
  });

  it("rolls back to the previous database when gateway restart fails after restore", () => {
    const fixture = createRestoreFixture();
    tempDirs.add(fixture.tempDir);
    addLiveDbMarker(fixture.dbPath);

    mocks.spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "gateway start failed",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      });

    let thrown: Error | null = null;
    let output = "";
    try {
      runLcmRestoreCli({
        config: resolveLcmConfig({}, { dbPath: fixture.dbPath }),
        target: "latest",
        writer: {
          write(chunk: string) {
            output += chunk;
            return true;
          },
        },
      });
    } catch (error) {
      thrown = error as Error;
    }

    const invokedArgs = mocks.spawnSync.mock.calls.map((call) => (call[1] as string[]).join(" "));

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/gateway start failed/);
    expect(thrown?.message).toMatch(/rolled the database back to its pre-restore snapshot/);
    expect(thrown?.message).toMatch(/Rollback quick_check: ok/);
    expect(thrown?.message).toMatch(/Archived failed restore DB: .*failed-restore-/);
    expect(invokedArgs).toEqual([
      expect.stringContaining("gateway stop --json"),
      expect.stringContaining("gateway start --json"),
      expect.stringContaining("gateway start --json"),
      expect.stringContaining("gateway status --require-rpc --json"),
    ]);
    expect(output).toContain("6. Rolling back to the previous database snapshot...");
    expect(output).toContain("7. Starting gateway after rollback...");
    expect(output).toContain("8. Verifying gateway health after rollback...");
    expect(hasLiveDbMarker(fixture.dbPath)).toBe(true);
  });

  it("stops the gateway again and rolls back when post-start health checks fail", () => {
    const fixture = createRestoreFixture();
    tempDirs.add(fixture.tempDir);
    addLiveDbMarker(fixture.dbPath);

    mocks.spawnSync
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: "",
        stderr: "gateway health check failed",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: "{}",
        stderr: "",
      });

    let thrown: Error | null = null;
    let output = "";
    try {
      runLcmRestoreCli({
        config: resolveLcmConfig({}, { dbPath: fixture.dbPath }),
        target: "latest",
        writer: {
          write(chunk: string) {
            output += chunk;
            return true;
          },
        },
      });
    } catch (error) {
      thrown = error as Error;
    }

    const invokedArgs = mocks.spawnSync.mock.calls.map((call) => (call[1] as string[]).join(" "));

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown?.message).toMatch(/gateway health check failed/);
    expect(thrown?.message).toMatch(/rolled the database back to its pre-restore snapshot/);
    expect(invokedArgs).toEqual([
      expect.stringContaining("gateway stop --json"),
      expect.stringContaining("gateway start --json"),
      expect.stringContaining("gateway status --require-rpc --json"),
      expect.stringContaining("gateway stop --json"),
      expect.stringContaining("gateway start --json"),
      expect.stringContaining("gateway status --require-rpc --json"),
    ]);
    expect(output).toContain("5. Stopping gateway for rollback...");
    expect(output).toContain("6. Rolling back to the previous database snapshot...");
    expect(hasLiveDbMarker(fixture.dbPath)).toBe(true);
  });
});
