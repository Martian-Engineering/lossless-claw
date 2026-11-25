/**
 * Worker-thread entry that runs lcm_grep / recall searches on its own
 * read-only SQLite connection, so slow scans never block the Gateway's main
 * event loop. Bundled separately as dist/search-worker.js.
 */
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { ConversationStore } from "../store/conversation-store.js";
import { SummaryStore } from "../store/summary-store.js";
import type {
  SearchWorkerData,
  SearchWorkerRequest,
  SearchWorkerResponse,
} from "./search-worker-protocol.js";

const SEARCH_WORKER_BUSY_TIMEOUT_MS = 30_000;

const port = parentPort;
if (!port) {
  throw new Error("search-worker must run as a worker thread");
}

const data = workerData as SearchWorkerData;
const db = new DatabaseSync(data.databasePath, { readOnly: true });
db.exec(`PRAGMA busy_timeout = ${SEARCH_WORKER_BUSY_TIMEOUT_MS}`);
const storeOptions = {
  fts5Available: data.fts5Available,
  searchScanLimits: data.searchScanLimits,
};
const conversationStore = new ConversationStore(db, storeOptions);
const summaryStore = new SummaryStore(db, storeOptions);

port.on("message", (request: SearchWorkerRequest) => {
  let response: SearchWorkerResponse;
  try {
    const outcome = request.kind === "messages"
      ? conversationStore.searchMessagesInProcess(request.input)
      : summaryStore.searchSummariesInProcess(request.input);
    response = { id: request.id, ok: true, outcome };
  } catch (error) {
    response = {
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  port.postMessage(response);
});
