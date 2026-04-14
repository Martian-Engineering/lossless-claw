import { copyFileSync, existsSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getLcmDbFeatures } from "../db/features.js";
import { runLcmMigrations } from "../db/migration.js";
import {
  closeLcmConnection,
  createLcmDatabaseConnection,
  getFileBackedDatabasePath,
} from "../db/connection.js";
import type { DatabaseSync } from "node:sqlite";

export type LcmRestoreTarget = {
  name: string;
  backupPath: string;
  label: string;
  kind: "latest" | "snapshot";
  modifiedAtMs: number;
};

function quoteShellArg(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function formatRestoreStamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, "");
}

function readQuickCheckResult(db: DatabaseSync): string {
  const rows = db.prepare(`PRAGMA quick_check`).all() as Array<{ quick_check?: string }>;
  const results = rows
    .map((row) => row.quick_check)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (results.length === 0) {
    return "unknown";
  }
  if (results.length === 1 && results[0] === "ok") {
    return "ok";
  }
  return results.join("; ");
}

function sanitizeShellPathFragment(value: string): string {
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return normalized.replace(/^-+|-+$/g, "") || "restore";
}

/**
 * Discover restorable SQLite snapshots for the configured LCM database path.
 */
export function listLcmRestoreTargets(databasePath: string): LcmRestoreTarget[] {
  const fileBackedDatabasePath = getFileBackedDatabasePath(databasePath);
  if (!fileBackedDatabasePath) {
    return [];
  }

  const dbDir = dirname(fileBackedDatabasePath);
  const dbBase = basename(fileBackedDatabasePath);
  const prefix = `${dbBase}.`;

  const targets: LcmRestoreTarget[] = [];
  for (const entry of readdirSync(dbDir)) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".bak")) {
      continue;
    }

    const targetLabel = entry.slice(prefix.length, -".bak".length);
    if (!targetLabel || targetLabel.includes("-tmp-")) {
      continue;
    }

    const backupPath = join(dbDir, entry);
    let stats;
    try {
      stats = statSync(backupPath);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }

    targets.push({
      name: targetLabel === "rotate-latest" ? "latest" : targetLabel,
      backupPath,
      label: targetLabel,
      kind: targetLabel === "rotate-latest" ? "latest" : "snapshot",
      modifiedAtMs: stats.mtimeMs,
    });
  }

  return targets.sort((left, right) => {
    if (left.kind !== right.kind) {
      return left.kind === "latest" ? -1 : 1;
    }
    if (left.modifiedAtMs !== right.modifiedAtMs) {
      return right.modifiedAtMs - left.modifiedAtMs;
    }
    return left.name.localeCompare(right.name);
  });
}

/**
 * Return the exact CLI command operators should run for an offline restore.
 */
export function buildLcmRestoreCliCommand(params: {
  target: string;
  stateDir?: string;
}): string {
  const command = `openclaw lossless restore ${quoteShellArg(params.target)}`;
  if (!params.stateDir?.trim()) {
    return command;
  }
  return `OPENCLAW_STATE_DIR=${quoteShellArg(params.stateDir)} ${command}`;
}

export type LcmRestoreExecutionResult = {
  databasePath: string;
  snapshotPath: string;
  currentBackupPath: string | null;
  walArchivePath: string | null;
  shmArchivePath: string | null;
  quickCheck: string;
};

/**
 * Restore a chosen SQLite snapshot into place and mark bootstrap restore guard state.
 */
export function restoreLcmDatabaseFromBackup(params: {
  databasePath: string;
  target: LcmRestoreTarget;
}): LcmRestoreExecutionResult {
  const fileBackedDatabasePath = getFileBackedDatabasePath(params.databasePath);
  if (!fileBackedDatabasePath) {
    throw new Error("Lossless Claw restore requires a file-backed SQLite database path.");
  }
  if (!existsSync(params.target.backupPath)) {
    throw new Error(`Restore snapshot not found: ${params.target.backupPath}`);
  }

  const tag = sanitizeShellPathFragment(params.target.name);
  const stamp = formatRestoreStamp();
  const currentBackupPath = existsSync(fileBackedDatabasePath)
    ? `${fileBackedDatabasePath}.pre-restore-${tag}-${stamp}.bak`
    : null;
  const walPath = `${fileBackedDatabasePath}-wal`;
  const shmPath = `${fileBackedDatabasePath}-shm`;
  const walArchivePath = existsSync(walPath)
    ? `${walPath}.pre-restore-${tag}-${stamp}.bak`
    : null;
  const shmArchivePath = existsSync(shmPath)
    ? `${shmPath}.pre-restore-${tag}-${stamp}.bak`
    : null;

  if (currentBackupPath) {
    copyFileSync(fileBackedDatabasePath, currentBackupPath);
  }
  if (walArchivePath) {
    renameSync(walPath, walArchivePath);
  }
  if (shmArchivePath) {
    renameSync(shmPath, shmArchivePath);
  }
  copyFileSync(params.target.backupPath, fileBackedDatabasePath);

  const db = createLcmDatabaseConnection(fileBackedDatabasePath);
  try {
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });
    db.exec(`UPDATE conversation_bootstrap_state
             SET restore_guard_pending = 1,
                 updated_at = datetime('now')`);
    return {
      databasePath: fileBackedDatabasePath,
      snapshotPath: params.target.backupPath,
      currentBackupPath,
      walArchivePath,
      shmArchivePath,
      quickCheck: readQuickCheckResult(db),
    };
  } finally {
    closeLcmConnection(db);
  }
}

/**
 * Build an exact shell recipe for restoring a chosen SQLite snapshot safely.
 *
 * Deprecated in favor of the external OpenClaw CLI command path.
 */
export function buildLcmRestoreShellScript(params: {
  databasePath: string;
  target: LcmRestoreTarget;
}): string | null {
  const fileBackedDatabasePath = getFileBackedDatabasePath(params.databasePath);
  if (!fileBackedDatabasePath) {
    return null;
  }
  const tag = sanitizeShellPathFragment(params.target.name);
  const db = quoteShellArg(fileBackedDatabasePath);
  const backup = quoteShellArg(params.target.backupPath);

  return [
    "set -eu",
    "",
    `DB=${db}`,
    `BACKUP=${backup}`,
    "STAMP=\"$(date +%Y%m%d-%H%M%S)\"",
    `CURRENT_BACKUP=\"$DB.pre-restore-${tag}-$STAMP.bak\"`,
    `WAL_ARCHIVE=\"$DB-wal.pre-restore-${tag}-$STAMP.bak\"`,
    `SHM_ARCHIVE=\"$DB-shm.pre-restore-${tag}-$STAMP.bak\"`,
    "",
    "[ -f \"$BACKUP\" ]",
    "if [ -f \"$DB\" ]; then cp -p \"$DB\" \"$CURRENT_BACKUP\"; fi",
    "if [ -f \"$DB-wal\" ]; then mv \"$DB-wal\" \"$WAL_ARCHIVE\"; fi",
    "if [ -f \"$DB-shm\" ]; then mv \"$DB-shm\" \"$SHM_ARCHIVE\"; fi",
    "cp -p \"$BACKUP\" \"$DB\"",
    "sqlite3 \"$DB\" <<'SQL'",
    "UPDATE conversation_bootstrap_state",
    "SET restore_guard_pending = 1,",
    "    updated_at = datetime('now');",
    "SQL",
  ].join("\n");
}
