import type { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { resolveBundledWorkerUrl } from "../bundled-worker.js";
import { getFileBackedDatabasePath } from "../db/connection.js";
import {
  applyDoctorCleaners,
  scanDoctorCleaners,
  type DoctorCleanerApplyResult,
  type DoctorCleanerId,
  type DoctorCleanerScan,
} from "./lcm-doctor-cleaners.js";

export type DoctorCleanerTask =
  | {
      kind: "scan";
      databasePath: string;
      filterIds?: DoctorCleanerId[];
      agentIds?: string[];
    }
  | {
      kind: "apply";
      databasePath: string;
      filterIds?: DoctorCleanerId[];
      agentIds?: string[];
      vacuum: boolean;
    };

export type DoctorCleanerTaskResult =
  | { kind: "scan"; scan: DoctorCleanerScan }
  | {
      kind: "apply";
      result: DoctorCleanerApplyResult;
      /** PRAGMA quick_check verdict after committed deletes, or null when none ran. */
      quickCheck: string | null;
    };

export type DoctorCleanerWorkerResponse =
  | { ok: true; result: DoctorCleanerTaskResult }
  | { ok: false; error: string };

export const DOCTOR_CLEANER_WORKER_FILE = "doctor-cleaner-worker.js";

/** Summarize PRAGMA quick_check as "ok" or the joined problem list. */
export function runQuickCheck(db: DatabaseSync): string {
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

/** Run one cleaner scan or apply synchronously on `db`. */
export function runDoctorCleanerTaskInProcess(
  db: DatabaseSync,
  task: DoctorCleanerTask,
): DoctorCleanerTaskResult {
  if (task.kind === "scan") {
    return { kind: "scan", scan: scanDoctorCleaners(db, task.filterIds, task.agentIds) };
  }
  const result = applyDoctorCleaners(db, {
    databasePath: task.databasePath,
    filterIds: task.filterIds,
    agentIds: task.agentIds,
    vacuum: task.vacuum,
  });
  return {
    kind: "apply",
    result,
    quickCheck: result.kind === "applied" ? runQuickCheck(db) : null,
  };
}

/**
 * Run a cleaner scan or apply on a worker thread with its own connection, so
 * the backup, deletes and integrity check never block the Gateway event loop.
 * In-memory databases and unbundled source runs use `db` in-process.
 */
export function runDoctorCleanerTask(
  db: DatabaseSync,
  task: DoctorCleanerTask,
  options?: { workerUrl?: URL | null },
): Promise<DoctorCleanerTaskResult> {
  const workerUrl = options?.workerUrl === undefined
    ? resolveBundledWorkerUrl(DOCTOR_CLEANER_WORKER_FILE)
    : options.workerUrl;
  const databasePath = getFileBackedDatabasePath(task.databasePath);
  if (!workerUrl || !databasePath) {
    try {
      return Promise.resolve(runDoctorCleanerTaskInProcess(db, task));
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return new Promise<DoctorCleanerTaskResult>((resolve, reject) => {
    let settled = false;
    const worker = new Worker(workerUrl, { workerData: { ...task, databasePath } });
    worker.once("message", (response: DoctorCleanerWorkerResponse) => {
      settled = true;
      if (response.ok) {
        resolve(response.result);
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
        reject(new Error(`doctor cleaner worker exited with code ${code} before reporting a result`));
      }
    });
  });
}
