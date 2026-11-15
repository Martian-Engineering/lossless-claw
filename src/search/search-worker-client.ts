import { Worker } from "node:worker_threads";
import { resolveBundledWorkerUrl } from "../bundled-worker.js";
import type {
  MessageSearchExecutor,
  MessageSearchInput,
  MessageSearchResult,
} from "../store/conversation-store.js";
import type { SearchOutcome, SearchScanLimits } from "../store/search-scan.js";
import type {
  SummarySearchExecutor,
  SummarySearchInput,
  SummarySearchResult,
} from "../store/summary-store.js";
import type {
  SearchWorkerData,
  SearchWorkerRequest,
  SearchWorkerResponse,
} from "./search-worker-protocol.js";

/** Upper bound for one search round trip before the worker is replaced. */
export const DEFAULT_SEARCH_WORKER_TIMEOUT_MS = 60_000;

type PendingSearch = {
  worker: Worker;
  resolve: (outcome: SearchOutcome<never>) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Locate dist/search-worker.js next to the plugin bundle, if present. */
export function resolveBundledSearchWorkerUrl(): URL | null {
  return resolveBundledWorkerUrl("search-worker.js");
}

/**
 * Runs message and summary searches on a dedicated worker thread with its own
 * read-only connection. The worker starts lazily, is unref'd while idle, and
 * is replaced after a crash or a timed-out search.
 */
export class SearchWorkerClient implements MessageSearchExecutor, SummarySearchExecutor {
  private worker: Worker | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingSearch>();
  private closed = false;
  private readonly timeoutMs: number;

  constructor(
    private readonly options: {
      workerUrl: URL;
      databasePath: string;
      fts5Available: boolean;
      searchScanLimits?: Partial<SearchScanLimits>;
      timeoutMs?: number;
    },
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SEARCH_WORKER_TIMEOUT_MS;
  }

  searchMessages(input: MessageSearchInput): Promise<SearchOutcome<MessageSearchResult>> {
    return this.request({ kind: "messages", input });
  }

  searchSummaries(input: SummarySearchInput): Promise<SearchOutcome<SummarySearchResult>> {
    return this.request({ kind: "summaries", input });
  }

  /** Reject pending searches and stop the worker. */
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    this.worker = null;
    if (worker) {
      this.failPending(worker, new Error("lcm search worker closed"));
      await worker.terminate();
    }
  }

  private request<T>(
    request: DistributiveOmit<SearchWorkerRequest, "id">,
  ): Promise<SearchOutcome<T>> {
    if (this.closed) {
      return Promise.reject(new Error("lcm search worker closed"));
    }
    const worker = this.ensureWorker();
    const id = this.nextRequestId++;
    return new Promise<SearchOutcome<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) {
          return;
        }
        reject(new Error(`lcm search timed out after ${this.timeoutMs} ms`));
        this.replaceWorker(worker, new Error("lcm search worker restarted after a timed-out search"));
      }, this.timeoutMs);
      this.pending.set(id, {
        worker,
        resolve: resolve as (outcome: SearchOutcome<never>) => void,
        reject,
        timer,
      });
      worker.ref();
      worker.postMessage({ ...request, id } as SearchWorkerRequest);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }
    const workerData: SearchWorkerData = {
      databasePath: this.options.databasePath,
      fts5Available: this.options.fts5Available,
      searchScanLimits: this.options.searchScanLimits,
    };
    const worker = new Worker(this.options.workerUrl, { workerData });
    worker.unref();
    worker.on("message", (response: SearchWorkerResponse) => this.settle(worker, response));
    worker.on("error", (error: unknown) => {
      this.replaceWorker(worker, error instanceof Error ? error : new Error(String(error)));
    });
    worker.on("exit", (code) => {
      this.replaceWorker(worker, new Error(`lcm search worker exited with code ${code}`));
    });
    this.worker = worker;
    return worker;
  }

  private settle(worker: Worker, response: SearchWorkerResponse): void {
    const entry = this.pending.get(response.id);
    if (!entry) {
      return;
    }
    this.pending.delete(response.id);
    clearTimeout(entry.timer);
    this.unrefIfIdle(worker);
    if (response.ok) {
      entry.resolve(response.outcome as SearchOutcome<never>);
    } else {
      entry.reject(new Error(response.error));
    }
  }

  private replaceWorker(worker: Worker, error: Error): void {
    if (this.worker === worker) {
      this.worker = null;
      void worker.terminate();
    }
    this.failPending(worker, error);
  }

  private failPending(worker: Worker, error: Error): void {
    for (const [id, entry] of this.pending) {
      if (entry.worker !== worker) {
        continue;
      }
      this.pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  private unrefIfIdle(worker: Worker): void {
    for (const entry of this.pending.values()) {
      if (entry.worker === worker) {
        return;
      }
    }
    worker.unref();
  }
}
