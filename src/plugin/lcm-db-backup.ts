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

export function writeLcmDatabaseBackup(db: DatabaseSync, backupPath: string): void {
  db.exec(`VACUUM INTO ${quoteSqlString(backupPath)}`);
}

export function createLcmDatabaseBackup(
  db: DatabaseSync,
  options: {
    databasePath: string;
    label: string;
  },
): string | null {
  const backupPath = buildLcmDatabaseBackupPath(options.databasePath, options.label);
  if (!backupPath) {
    return null;
  }

  writeLcmDatabaseBackup(db, backupPath);
  return backupPath;
}
