import { rmSync, renameSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { getFileBackedDatabasePath } from "../db/connection.js";

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

export function createLcmDatabaseBackup(
  db: DatabaseSync,
  options: {
    databasePath: string;
    label: string;
    replaceLatest?: boolean;
  },
): string | null {
  if (options.replaceLatest) {
    const latestBackupPath = buildLcmDatabaseLatestBackupPath(options.databasePath, options.label);
    const tempBackupPath = buildLcmDatabaseBackupPath(options.databasePath, `${options.label}-tmp`);
    if (!latestBackupPath || !tempBackupPath) {
      return null;
    }

    try {
      writeLcmDatabaseBackup(db, tempBackupPath);
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

  writeLcmDatabaseBackup(db, backupPath);
  return backupPath;
}
