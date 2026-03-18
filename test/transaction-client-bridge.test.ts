import { describe, expect, it } from "vitest";
import type { DbClient, RunResult } from "../src/db/db-interface.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

type QueryLogEntry = {
  client: string;
  kind: "queryOne" | "run";
  sql: string;
  params: unknown[];
};

class RecordingClient implements DbClient {
  constructor(
    readonly name: string,
    private readonly log: QueryLogEntry[],
    private readonly txClient?: DbClient,
  ) {}

  async query<T>(): Promise<{ rows: T[] }> {
    return { rows: [] };
  }

  async queryOne<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    this.log.push({ client: this.name, kind: "queryOne", sql, params });
    return { max_ordinal: -1 } as T;
  }

  async run(sql: string, params: unknown[] = []): Promise<RunResult> {
    this.log.push({ client: this.name, kind: "run", sql, params });
    return { rowCount: 1 };
  }

  async transaction<T>(fn: (client: DbClient) => Promise<T>): Promise<T> {
    if (!this.txClient) {
      throw new Error(`No transaction client configured for ${this.name}`);
    }
    return fn(this.txClient);
  }

  async close(): Promise<void> {}
}

describe("cross-store transaction client bridge", () => {
  it("lets SummaryStore join ConversationStore's transaction-scoped client", async () => {
    const log: QueryLogEntry[] = [];
    const txClient = new RecordingClient("tx", log);
    const rootClient = new RecordingClient("root", log, txClient);

    const conversationStore = new ConversationStore(rootClient, { backend: "postgres" });
    const summaryStore = new SummaryStore(rootClient, { backend: "postgres" });

    await conversationStore.withTransactionClient(async (client) => {
      expect(client).toBe(txClient);
      await summaryStore.withClient(client, async () => {
        await summaryStore.appendContextMessages(42, [1001, 1002]);
      });
    });

    expect(log).toEqual([
      expect.objectContaining({ client: "tx", kind: "queryOne" }),
      expect.objectContaining({ client: "tx", kind: "run" }),
      expect.objectContaining({ client: "tx", kind: "run" }),
    ]);
    expect(log.some((entry) => entry.client === "root")).toBe(false);
  });
});
