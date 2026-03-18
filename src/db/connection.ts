import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

type ConnectionKey = string;

const connectionsByPath = new Map<ConnectionKey, Set<DatabaseSync>>();
const connectionIndex = new Map<DatabaseSync, ConnectionKey>();

function isInMemoryPath(dbPath: string): boolean {
  const normalized = dbPath.trim();
  return normalized === ":memory:" || normalized.startsWith("file::memory:");
}

function normalizePath(dbPath: string): ConnectionKey {
  if (isInMemoryPath(dbPath)) {
    const trimmed = dbPath.trim();
    return trimmed.length > 0 ? trimmed : ":memory:";
  }
  return resolve(dbPath);
}

function ensureDbDirectory(dbPath: string): void {
  if (isInMemoryPath(dbPath)) {
    return;
  }
  mkdirSync(dirname(dbPath), { recursive: true });
}

function configureConnection(db: DatabaseSync): DatabaseSync {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
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
  const db = configureConnection(new DatabaseSync(dbPath));
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
