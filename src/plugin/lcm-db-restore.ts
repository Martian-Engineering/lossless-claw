import { readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { getFileBackedDatabasePath } from "../db/connection.js";

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
 * Build an exact shell recipe for restoring a chosen SQLite snapshot safely.
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
