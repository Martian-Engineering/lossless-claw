import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type ConnectionKey = string;
/**
 * SQLite busy timeout in milliseconds.  30 s accommodates high-concurrency
 * multi-agent setups where 10+ writers contend on the WAL.  The default 5 s
 * proved insufficient in production with ≥13 concurrent lanes.
 */
const SQLITE_BUSY_TIMEOUT_MS = 30_000;

const connectionsByPath = new Map<ConnectionKey, Set<DatabaseSync>>();
const connectionIndex = new Map<DatabaseSync, ConnectionKey>();

export function isInMemoryPath(dbPath: string): boolean {
  const normalized = dbPath.trim();
  return normalized === ":memory:" || normalized.startsWith("file::memory:");
}

export function getFileBackedDatabasePath(dbPath: string): string | null {
  const trimmed = dbPath.trim();
  if (!trimmed || isInMemoryPath(trimmed)) {
    return null;
  }
  return resolve(trimmed);
}

export function normalizePath(dbPath: string): ConnectionKey {
  const fileBackedDatabasePath = getFileBackedDatabasePath(dbPath);
  if (!fileBackedDatabasePath) {
    const trimmed = dbPath.trim();
    return trimmed.length > 0 ? trimmed : ":memory:";
  }
  return fileBackedDatabasePath;
}

function ensureDbDirectory(dbPath: string): void {
  const fileBackedDatabasePath = getFileBackedDatabasePath(dbPath);
  if (!fileBackedDatabasePath) {
    return;
  }
  mkdirSync(dirname(fileBackedDatabasePath), { recursive: true });
}

function configureConnection(db: DatabaseSync): DatabaseSync {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");
  // 64MB page cache (default 2MB is severely undersized for multi-GB databases
  // with concurrent agents). Memory is demand-allocated, released on close.
  db.exec("PRAGMA cache_size = -65536");
  // NORMAL is officially recommended for WAL mode — crash-safe for app crashes,
  // only risks data loss on power failure (OS/kernel crash). The bootstrap
  // process re-ingests any lost transactions from session files.
  db.exec("PRAGMA synchronous = NORMAL");
  // Keep temp tables/indexes in RAM (helps ordinal resequencing).
  db.exec("PRAGMA temp_store = MEMORY");
  return db;
}

function trackConnection(dbPath: string, db: DatabaseSync): void {
  const key = normalizePath(dbPath);
  let entries = connectionsByPath.get(key);
  if (!entries) {
    entries = new Set();
    connectionsByPath.set(key, entries);
  }
  entries.add(db);
  connectionIndex.set(db, key);
}

function untrackConnection(db: DatabaseSync): void {
  const key = connectionIndex.get(db);
  if (!key) {
    return;
  }
  const entries = connectionsByPath.get(key);
  if (entries) {
    entries.delete(db);
    if (entries.size === 0) {
      connectionsByPath.delete(key);
    }
  }
  connectionIndex.delete(db);
}

function closeDatabase(db: DatabaseSync | undefined): void {
  if (!db) {
    return;
  }
  try {
    // Update query planner statistics for tables that changed since last optimize.
    // Separate try so a SQLITE_BUSY/SQLITE_READONLY from optimize doesn't skip close.
    try { db.exec("PRAGMA optimize"); } catch { /* best-effort */ }
    db.close();
  } catch {
    // Ignore close failures; callers are shutting down anyway.
  } finally {
    untrackConnection(db);
  }
}

/**
 * Create a new SQLite connection for the given LCM database path.
 *
 * Connections are tracked so tests can close them by path via closeLcmConnection().
 */
export function createLcmDatabaseConnection(dbPath: string): DatabaseSync {
  ensureDbDirectory(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    configureConnection(db);
  } catch (err) {
    try { db.close(); } catch { /* ignore cleanup failure */ }
    throw err;
  }
  trackConnection(dbPath, db);
  return db;
}

/**
 * Close tracked LCM connections.
 *
 * When a DatabaseSync instance is supplied, only that handle is closed.
 * When a path is supplied, all handles associated with the normalized path
 * are closed. When called with no arguments, all tracked connections are
 * closed. Intended primarily for tests.
 */
export function closeLcmConnection(target?: string | DatabaseSync): void {
  if (target && typeof target !== "string") {
    closeDatabase(target);
    return;
  }

  if (typeof target === "string") {
    const key = normalizePath(target);
    const entries = connectionsByPath.get(key);
    if (!entries) {
      return;
    }
    for (const db of [...entries]) {
      closeDatabase(db);
    }
    connectionsByPath.delete(key);
    return;
  }

  for (const db of [...connectionIndex.keys()]) {
    closeDatabase(db);
  }
  connectionsByPath.clear();
  connectionIndex.clear();
}

export const getLcmConnection = createLcmDatabaseConnection;
