import { rmSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { resolveBundledWorkerUrl } from "../bundled-worker.js";
import { getFileBackedDatabasePath } from "../db/connection.js";

export const DB_BACKUP_WORKER_FILE = "db-backup-worker.js";

/** Startup data for the backup worker's own read-only connection. */
export type DbBackupWorkerData = {
  databasePath: string;
  backupPath: string;
};

export type DbBackupWorkerResponse = { ok: true } | { ok: false; error: string };

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function normalizeBackupLabel(label: string): string {
  const normalized = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "backup";
}

export function buildLcmDatabaseBackupPath(databasePath: string, label: string): string | null {
  const fileBackedDatabasePath = getFileBackedDatabasePath(databasePath);
  if (!fileBackedDatabasePath) {
    return null;
  }

  const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
  const suffix = Math.random().toString(36).slice(2, 8);
  return join(
    dirname(fileBackedDatabasePath),
    `${basename(fileBackedDatabasePath)}.${normalizeBackupLabel(label)}-${timestamp}-${suffix}.bak`,
  );
}

export function buildLcmDatabaseLatestBackupPath(databasePath: string, label: string): string | null {
  const fileBackedDatabasePath = getFileBackedDatabasePath(databasePath);
  if (!fileBackedDatabasePath) {
    return null;
  }

  return join(
    dirname(fileBackedDatabasePath),
    `${basename(fileBackedDatabasePath)}.${normalizeBackupLabel(label)}-latest.bak`,
  );
}

export function writeLcmDatabaseBackup(db: DatabaseSync, backupPath: string): void {
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
}

/**
 * Write a `VACUUM INTO` backup on a worker thread with its own read-only
 * connection, so the Gateway event loop keeps running while it is copied. The
 * backup captures the latest committed state when the worker starts. Unbundled
 * source runs and in-memory databases back up on `db` in-process.
 */
export async function writeLcmDatabaseBackupOffThread(
  db: DatabaseSync,
  backupPath: string,
  options: { databasePath: string; workerUrl?: URL | null },
): Promise<void> {
  const workerUrl = options.workerUrl === undefined
    ? resolveBundledWorkerUrl(DB_BACKUP_WORKER_FILE)
    : options.workerUrl;
  const databasePath = getFileBackedDatabasePath(options.databasePath);
  if (!workerUrl || !databasePath) {
    writeLcmDatabaseBackup(db, backupPath);
    return;
  }
  const workerData: DbBackupWorkerData = { databasePath, backupPath };
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerUrl, { workerData });
    worker.once("message", (response: DbBackupWorkerResponse) => {
      settled = true;
      if (response.ok) {
        resolve();
      } else {
        reject(new Error(response.error));
      }
    });
    worker.once("error", (error: unknown) => {
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    });
    worker.once("exit", (code) => {
      if (!settled) {
        reject(new Error(`database backup worker exited with code ${code} before reporting a result`));
      }
    });
  });
}

/** Create a labelled backup next to the database, off the main thread when bundled. */
export async function createLcmDatabaseBackup(
  db: DatabaseSync,
  options: {
    databasePath: string;
    label: string;
    replaceLatest?: boolean;
    workerUrl?: URL | null;
  },
): Promise<string | null> {
  const writeBackup = (backupPath: string) =>
    writeLcmDatabaseBackupOffThread(db, backupPath, {
      databasePath: options.databasePath,
      workerUrl: options.workerUrl,
    });
  if (options.replaceLatest) {
    const latestBackupPath = buildLcmDatabaseLatestBackupPath(options.databasePath, options.label);
    const tempBackupPath = buildLcmDatabaseBackupPath(options.databasePath, `${options.label}-tmp`);
    if (!latestBackupPath || !tempBackupPath) {
      return null;
    }

    try {
      await writeBackup(tempBackupPath);
      rmSync(latestBackupPath, { force: true });
      renameSync(tempBackupPath, latestBackupPath);
      return latestBackupPath;
    } catch (error) {
      rmSync(tempBackupPath, { force: true });
      throw error;
    }
  }

  const backupPath = buildLcmDatabaseBackupPath(options.databasePath, options.label);
  if (!backupPath) {
    return null;
  }

  await writeBackup(backupPath);
  return backupPath;
}
