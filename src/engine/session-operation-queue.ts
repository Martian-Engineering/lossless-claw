type SessionOperationQueueEntry = {
  promise: Promise<void>;
  refCount: number;
};

export type SessionOperationQueues = Map<string, SessionOperationQueueEntry>;

type SessionOperationQueueLogger = {
  debug: (message: string) => void;
};

function formatDurationMs(durationMs: number): string {
  if (durationMs < 1000) {
    return `${durationMs}ms`;
  }
  return `${(durationMs / 1000).toFixed(2)}s`;
}

/**
 * Prefer stable session keys for queue serialization when available.
 */
export function resolveSessionQueueKey(sessionId?: string, sessionKey?: string): string {
  const normalizedSessionKey = sessionKey?.trim();
  const normalizedSessionId = sessionId?.trim();
  return normalizedSessionKey || normalizedSessionId || "__lcm__";
}

/**
 * Serializes mutating operations per stable session identity.
 */
export class SessionOperationQueue {
  readonly queues: SessionOperationQueues = new Map();

  constructor(private readonly log: SessionOperationQueueLogger) {}

  /**
   * Run an operation after earlier operations for the same queue key finish.
   */
  async run<T>(
    queueKey: string,
    operation: () => Promise<T>,
    options?: { operationName?: string; context?: string },
  ): Promise<T> {
    const entry = this.queues.get(queueKey);
    const previous = entry?.promise ?? Promise.resolve();
    const queuedAhead = entry?.refCount ?? 0;
    let releaseQueue: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      releaseQueue = resolve;
    });
    const next = previous.catch(() => {}).then(() => current);

    if (entry) {
      entry.promise = next;
      entry.refCount++;
    } else {
      this.queues.set(queueKey, { promise: next, refCount: 1 });
    }

    const waitStartedAt = Date.now();
    await previous.catch(() => {});
    const waitMs = Date.now() - waitStartedAt;
    if (options?.operationName) {
      const detail = options.context ? ` ${options.context}` : "";
      this.log.debug(
        `[lcm] ${options.operationName}: session queue acquired queueKey=${queueKey} queuedAhead=${queuedAhead} wait=${formatDurationMs(waitMs)}${detail}`,
      );
    }
    try {
      return await operation();
    } finally {
      releaseQueue();
      const cur = this.queues.get(queueKey);
      if (cur && --cur.refCount === 0) {
        this.queues.delete(queueKey);
      }
    }
  }
}
