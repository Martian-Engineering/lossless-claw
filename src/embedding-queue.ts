/**
 * Async embedding queue with batching, retry, and backpressure.
 *
 * Instead of fire-and-forget embedOnInsert calls, messages/summaries are
 * enqueued and processed in micro-batches on a timer. Failed items are
 * retried with exponential backoff up to a max retry count, then logged
 * and skipped.
 *
 * This avoids:
 *  - Silent failures from swallowed .catch(() => {})
 *  - Thundering herd of concurrent API calls during bulk inserts
 *  - Permanent data loss from transient API errors (rate limits, timeouts)
 *
 * Usage:
 *   const queue = new EmbeddingQueue(embeddingClient, db);
 *   queue.start();
 *   queue.enqueue("messages", messageId, content);
 *   // ... later
 *   await queue.stop(); // drains remaining items
 */

import type { EmbeddingClient } from "./embeddings.js";
import { toVectorLiteral } from "./embeddings.js";

export interface QueueableDb {
  run(sql: string, params: unknown[]): Promise<{ lastInsertId?: number | bigint }>;
  query<T = Record<string, unknown>>(sql: string, params: unknown[]): Promise<{ rows: T[] }>;
}

interface MessagePartRow {
  part_type: string;
  tool_name: string | null;
  tool_input: string | null;
  text_content: string | null;
}

interface QueueItem {
  table: "messages" | "summaries";
  id: number | string;    // message_id (number) or summary_id (string)
  content: string;
  retries: number;
  nextRetryAt: number;    // Date.now() timestamp
}

export interface EmbeddingQueueOptions {
  /** Max items per API call (default: 100, OpenAI limit 2048) */
  batchSize?: number;
  /** How often to flush the queue in ms (default: 2000) */
  flushIntervalMs?: number;
  /** Max retries before giving up on an item (default: 5) */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms (default: 1000) */
  baseRetryDelayMs?: number;
  /** Log function (default: console.error) */
  log?: (msg: string) => void;
}

export class EmbeddingQueue {
  private queue: QueueItem[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private processing = false;
  private readonly client: EmbeddingClient;
  private readonly db: QueueableDb;
  private readonly batchSize: number;
  private readonly flushIntervalMs: number;
  private readonly maxRetries: number;
  private readonly baseRetryDelayMs: number;
  private readonly log: (msg: string) => void;

  constructor(client: EmbeddingClient, db: QueueableDb, options?: EmbeddingQueueOptions) {
    this.client = client;
    this.db = db;
    this.batchSize = options?.batchSize ?? 100;
    this.flushIntervalMs = options?.flushIntervalMs ?? 2000;
    this.maxRetries = options?.maxRetries ?? 5;
    this.baseRetryDelayMs = options?.baseRetryDelayMs ?? 1000;
    this.log = options?.log ?? ((msg) => console.error(`[embedding-queue] ${msg}`));
  }

  /**
   * Add an item to the embedding queue. Non-blocking.
   * For messages with empty content (pure tool-call turns), pass empty string —
   * the queue will synthesize embedding text from message_parts at flush time.
   */
  enqueue(table: "messages" | "summaries", id: number | string, content: string): void {
    // Summaries should always have content; skip if empty
    if (table === "summaries" && (!content || content.trim().length === 0)) return;
    // Messages: allow empty content — will be resolved from parts at flush time
    const isEmpty = !content || content.trim().length === 0;
    if (isEmpty && table === "messages") {
      this.log(`enqueued empty-content message ${id} (will synthesize from parts)`);
    }
    this.queue.push({ table, id, content, retries: 0, nextRetryAt: 0 });
  }

  /** Start the periodic flush timer. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush().catch(err => {
      this.log(`flush error: ${err.message}`);
    }), this.flushIntervalMs);
    // Don't keep the process alive just for embeddings
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  /** Stop the timer and drain remaining items (best effort). */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    // Final flush attempt
    if (this.queue.length > 0) {
      await this.flush();
    }
  }

  /** Current queue depth (for monitoring/metrics). */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Synthesize embedding text for a message from its parts.
   * Called when message.content is empty (pure tool-call turns).
   * Returns a compact text summary like:
   *   "tool:exec command=ls -la /tmp\ntool:read path=~/foo.ts"
   */
  private async synthesizeFromParts(messageId: number | string): Promise<string> {
    try {
      const { rows } = await this.db.query<MessagePartRow>(
        `SELECT part_type, tool_name, tool_input, text_content
         FROM message_parts WHERE message_id = $1 ORDER BY ordinal`,
        [messageId],
      );
      if (rows.length === 0) return "";

      const lines: string[] = [];
      for (const row of rows) {
        if (row.part_type === "tool" && row.tool_name) {
          // Compact tool representation: "tool:exec command=ls -la"
          let line = `tool:${row.tool_name}`;
          if (row.tool_input) {
            // Parse tool_input JSON, extract key params (truncate long values)
            try {
              const params = typeof row.tool_input === "string"
                ? JSON.parse(row.tool_input)
                : row.tool_input;
              const pairs: string[] = [];
              for (const [k, v] of Object.entries(params)) {
                const val = typeof v === "string" ? v : JSON.stringify(v);
                // Truncate long values (file contents, etc.) to keep embedding focused
                pairs.push(`${k}=${val.length > 200 ? val.slice(0, 200) + "…" : val}`);
              }
              if (pairs.length > 0) line += " " + pairs.join(" ");
            } catch {
              // If tool_input isn't JSON, use raw (truncated)
              const raw = String(row.tool_input);
              line += " " + (raw.length > 200 ? raw.slice(0, 200) + "…" : raw);
            }
          }
          lines.push(line);
        } else if (row.part_type === "reasoning" && row.text_content) {
          // Include a snippet of reasoning for searchability
          const snippet = row.text_content.slice(0, 300);
          lines.push(`reasoning: ${snippet}`);
        } else if (row.text_content) {
          lines.push(row.text_content.slice(0, 300));
        }
      }
      return lines.join("\n");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.log(`synthesizeFromParts failed for message ${messageId}: ${msg}`);
      return "";
    }
  }

  /** Process a batch from the queue. */
  private async flush(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    try {
      const now = Date.now();
      // Pick items that are ready (not waiting for retry backoff)
      const ready: QueueItem[] = [];
      const notReady: QueueItem[] = [];

      for (const item of this.queue) {
        if (item.nextRetryAt <= now && ready.length < this.batchSize) {
          ready.push(item);
        } else {
          notReady.push(item);
        }
      }

      if (ready.length === 0) {
        this.queue = notReady;
        return;
      }

      // Remove ready items from queue, keep the rest
      this.queue = notReady;

      // Resolve empty-content messages from their parts
      for (const item of ready) {
        if ((!item.content || item.content.trim().length === 0) && item.table === "messages") {
          item.content = await this.synthesizeFromParts(item.id);
          if (item.content) {
            this.log(`synthesized ${item.content.length} chars for message ${item.id}`);
          }
        }
      }

      // Filter out items that are still empty after synthesis (no parts at all)
      const embeddable = ready.filter(r => r.content && r.content.trim().length > 0);
      const empty = ready.filter(r => !r.content || r.content.trim().length === 0);
      if (empty.length > 0) {
        this.log(`Skipped ${empty.length} items with no embeddable content`);
      }
      if (embeddable.length === 0) return;

      try {
        const embeddings = await this.client.embed(embeddable.map(r => r.content));

        // Write embeddings to DB
        for (let i = 0; i < embeddable.length; i++) {
          const item = embeddable[i];
          const idCol = item.table === "messages" ? "message_id" : "summary_id";
          try {
            await this.db.run(
              `UPDATE ${item.table} SET embedding = $1::vector WHERE ${idCol} = $2`,
              [toVectorLiteral(embeddings[i]), item.id],
            );
          } catch (dbErr: unknown) {
            const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
            this.log(`DB update failed for ${item.table}/${item.id}: ${msg}`);
            // Don't retry DB errors — they're likely permanent (row deleted, etc.)
          }
        }
        this.log(`embedded ${embeddable.length} items`);
      } catch (apiErr: unknown) {
        const msg = apiErr instanceof Error ? apiErr.message : String(apiErr);
        this.log(`API batch failed (${embeddable.length} items): ${msg}`);

        // Re-enqueue with backoff
        for (const item of embeddable) {
          if (item.retries < this.maxRetries) {
            item.retries++;
            const delay = this.baseRetryDelayMs * Math.pow(2, item.retries - 1);
            item.nextRetryAt = Date.now() + delay;
            this.queue.push(item);
          } else {
            this.log(`Giving up on ${item.table}/${item.id} after ${item.retries} retries`);
          }
        }
      }
    } finally {
      this.processing = false;
    }
  }
}
