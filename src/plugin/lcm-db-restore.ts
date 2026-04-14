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

export type LcmRestoreRollbackResult = {
  databasePath: string;
  rollbackDbArchivePath: string | null;
  rollbackWalArchivePath: string | null;
  rollbackShmArchivePath: string | null;
  restoredPreviousDb: boolean;
  restoredWal: boolean;
  restoredShm: boolean;
  quickCheck: string;
};

function archiveActiveFile(path: string, suffix: string): string | null {
  if (!existsSync(path)) {
    return null;
  }
  const archivedPath = `${path}.${suffix}.bak`;
  renameSync(path, archivedPath);
  return archivedPath;
}

function quickCheckDatabaseAtPath(databasePath: string): string {
  const db = createLcmDatabaseConnection(databasePath);
  try {
    return readQuickCheckResult(db);
  } finally {
    closeLcmConnection(db);
  }
}

/**
 * Restore the preserved pre-restore database and SQLite sidecars when a restore-orchestration step fails.
 */
export function rollbackLcmDatabaseRestore(params: {
  restore: Pick<LcmRestoreExecutionResult, "databasePath" | "currentBackupPath" | "walArchivePath" | "shmArchivePath">;
}): LcmRestoreRollbackResult {
  const fileBackedDatabasePath = getFileBackedDatabasePath(params.restore.databasePath);
  if (!fileBackedDatabasePath) {
    throw new Error("Lossless Claw restore rollback requires a file-backed SQLite database path.");
  }

  const canRestorePreviousDb =
    typeof params.restore.currentBackupPath === "string" && existsSync(params.restore.currentBackupPath);
  const walPath = `${fileBackedDatabasePath}-wal`;
  const shmPath = `${fileBackedDatabasePath}-shm`;
  const rollbackTag = `failed-restore-${formatRestoreStamp()}`;

  const rollbackDbArchivePath = canRestorePreviousDb
    ? archiveActiveFile(fileBackedDatabasePath, rollbackTag)
    : null;
  const rollbackWalArchivePath = canRestorePreviousDb
    ? archiveActiveFile(walPath, rollbackTag)
    : null;
  const rollbackShmArchivePath = canRestorePreviousDb
    ? archiveActiveFile(shmPath, rollbackTag)
    : null;

  let restoredPreviousDb = false;
  if (canRestorePreviousDb) {
    copyFileSync(params.restore.currentBackupPath!, fileBackedDatabasePath);
    restoredPreviousDb = true;
  }

  let restoredWal = false;
  if (
    restoredPreviousDb &&
    typeof params.restore.walArchivePath === "string" &&
    existsSync(params.restore.walArchivePath)
  ) {
    renameSync(params.restore.walArchivePath, walPath);
    restoredWal = true;
  }

  let restoredShm = false;
  if (
    restoredPreviousDb &&
    typeof params.restore.shmArchivePath === "string" &&
    existsSync(params.restore.shmArchivePath)
  ) {
    renameSync(params.restore.shmArchivePath, shmPath);
    restoredShm = true;
  }

  return {
    databasePath: fileBackedDatabasePath,
    rollbackDbArchivePath,
    rollbackWalArchivePath,
    rollbackShmArchivePath,
    restoredPreviousDb,
    restoredWal,
    restoredShm,
    quickCheck: existsSync(fileBackedDatabasePath)
      ? quickCheckDatabaseAtPath(fileBackedDatabasePath)
      : "unknown",
  };
}

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
  try {
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
  } catch (error) {
    try {
      rollbackLcmDatabaseRestore({
        restore: {
          databasePath: fileBackedDatabasePath,
          currentBackupPath,
          walArchivePath,
          shmArchivePath,
        },
      });
    } catch {
      // Preserve the original restore error. The CLI layer reports preserved
      // archive paths and handles higher-level orchestration rollback details.
    }
    throw error;
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
