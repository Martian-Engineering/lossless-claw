/**
 * Worker-thread entry that writes one `VACUUM INTO` backup on its own
 * read-only connection, so multi-gigabyte backups never block the Gateway
 * event loop. Bundled separately as dist/db-backup-worker.js.
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { writeLcmDatabaseBackup, type DbBackupWorkerData, type DbBackupWorkerResponse } from "./lcm-db-backup.js";

const DB_BACKUP_WORKER_BUSY_TIMEOUT_MS = 30_000;

const port = parentPort;
if (!port) {
  throw new Error("db-backup-worker must run as a worker thread");
}

const data = workerData as DbBackupWorkerData;
let response: DbBackupWorkerResponse;
let db: DatabaseSync | null = null;
try {
  db = new DatabaseSync(data.databasePath, { readOnly: true });
  db.exec(`PRAGMA busy_timeout = ${DB_BACKUP_WORKER_BUSY_TIMEOUT_MS}`);
  writeLcmDatabaseBackup(db, data.backupPath);
  response = { ok: true };
} catch (error) {
  response = { ok: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  try { db?.close(); } catch { /* the worker exits next */ }
}
port.postMessage(response);
