/**
 * Worker-thread entry for /lcm doctor clean scans and applies. Uses its own
 * read-write connection so the backup, batched deletes and quick_check run off
 * the Gateway main thread. Bundled separately as dist/doctor-cleaner-worker.js.
 */
import { parentPort, workerData } from "node:worker_threads";
import { closeLcmConnection, createLcmDatabaseConnection } from "../db/connection.js";
import {
  runDoctorCleanerTaskInProcess,
  type DoctorCleanerTask,
  type DoctorCleanerWorkerResponse,
} from "./lcm-doctor-cleaner-task.js";

const port = parentPort;
if (!port) {
  throw new Error("doctor-cleaner-worker must run as a worker thread");
}

const task = workerData as DoctorCleanerTask;
let response: DoctorCleanerWorkerResponse;
const db = createLcmDatabaseConnection(task.databasePath);
try {
  response = { ok: true, result: runDoctorCleanerTaskInProcess(db, task) };
} catch (error) {
  response = { ok: false, error: error instanceof Error ? error.message : String(error) };
} finally {
  closeLcmConnection(db);
}
port.postMessage(response);
