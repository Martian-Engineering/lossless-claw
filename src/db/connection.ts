import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "fs";
import { dirname } from "path";
import type { DbClient } from "./db-interface.js";
import { SqliteClient } from "./sqlite-client.js";
import { PostgresClient } from "./postgres-client.js";
import type { LcmConfig } from "./config.js";

type SqliteConnectionEntry = {
  db: DatabaseSync;
  client: SqliteClient;
  refs: number;
};

type PostgresConnectionEntry = {
  client: PostgresClient;
  refs: number;
};

type ConnectionEntry = SqliteConnectionEntry | PostgresConnectionEntry;

const _connections = new Map<string, ConnectionEntry>();

function isConnectionHealthy(entry: ConnectionEntry): boolean {
  try {
    if ("db" in entry) {
      // SQLite connection health check
      entry.db.prepare("SELECT 1").get();
      return true;
    } else {
      // PostgreSQL connection health is checked by the pool internally
      return true;
    }
  } catch {
    return false;
  }
}

function configureConnection(db: DatabaseSync): DatabaseSync {
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

async function forceCloseConnection(entry: ConnectionEntry): Promise<void> {
  try {
    if ("db" in entry) {
      entry.db.close();
    } else {
      await entry.client.close();
    }
  } catch {
    // Ignore close failures; caller is already replacing/removing this handle.
  }
}

export function createLcmConnection(config: LcmConfig): DbClient {
  if (config.backend === 'postgres') {
    if (!config.connectionString) {
      throw new Error("LCM backend is 'postgres' but connectionString is missing.");
    }
    return createPostgresConnection(config.connectionString);
  }
  // backend === 'sqlite'
  return createSqliteConnection(config.databasePath);
}

function createSqliteConnection(dbPath: string): DbClient {
  const existing = _connections.get(dbPath);
  if (existing && "db" in existing) {
    if (isConnectionHealthy(existing)) {
      existing.refs += 1;
      return existing.client;
    }
    forceCloseConnection(existing);
    _connections.delete(dbPath);
  }

  // Ensure parent directory exists
  mkdirSync(dirname(dbPath), { recursive: true });

  const db = new DatabaseSync(dbPath);

  // Enable WAL mode for better concurrent read performance
  db.exec("PRAGMA journal_mode = WAL");
  // Enable foreign key enforcement
  db.exec("PRAGMA foreign_keys = ON");

  const client = new SqliteClient(db);
  _connections.set(dbPath, { db, client, refs: 1 });
  return client;
}

function createPostgresConnection(connectionString: string): DbClient {
  const existing = _connections.get(connectionString);
  if (existing && !("db" in existing)) {
    if (isConnectionHealthy(existing)) {
      existing.refs += 1;
      return existing.client;
    }
    forceCloseConnection(existing);
    _connections.delete(connectionString);
  }

  const client = new PostgresClient(connectionString);
  _connections.set(connectionString, { client, refs: 1 });
  return client;
}

export async function closeLcmConnection(key?: string | DatabaseSync): Promise<void> {
  // Handle raw DatabaseSync instance (used by tests to close standalone handles)
  if (key && typeof key === "object" && typeof (key as DatabaseSync).close === "function") {
    try {
      (key as DatabaseSync).close();
    } catch {
      // Already closed or invalid — ignore
    }
    return;
  }
  if (typeof key === "string" && key.trim()) {
    const entry = _connections.get(key);
    if (!entry) {
      return;
    }
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs === 0) {
      await forceCloseConnection(entry);
      _connections.delete(key);
    }
    return;
  }

  for (const entry of _connections.values()) {
    await forceCloseConnection(entry);
  }
  _connections.clear();
}

/**
 * Returns a raw SQLite DatabaseSync handle for migration code and tests.
 * Creates a FRESH connection not tracked in the pool, so closing it
 * won't affect the engine's pooled connection.
 * Only works when backend is sqlite. Throws for postgres.
 */
export { getLcmConnection as createLcmDatabaseConnection };
export function getLcmConnection(dbPath: string): DatabaseSync {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}