import { TurbopufferTransport } from "../turbopuffer-transport.js";
import type { Page, PageReader } from "./tree.js";
export type NativeDocument = {
  id: string;
  kind: string;
  payload: string;
  revision?: number;
  commit?: string;
  writer?: string;
  public_bytes?: number;
  created_at?: string;
  visible?: boolean;
  dead_revision?: number | null;
  table_name?: string;
  conversation_id?: number;
  entity_key?: string;
  content?: string;
  indexed_revision?: number;
  record_id?: string;
  part_count?: number;
  record_key?: string;
  sort_key?: string;
};
export type NativeWrite = {
  upsert_rows?: NativeDocument[];
  upsert_condition?: unknown;
  patch_rows?: Partial<NativeDocument>[];
  patch_condition?: unknown;
};
export type NativeWriteResult = { upserted: number; patched: number };
export type NativeQuery = Record<string, unknown>;
export interface NativeIo extends PageReader {
  read(ids: string[]): Promise<NativeDocument[]>;
  readMetadata?(
    ids: string[]
  ): Promise<Pick<NativeDocument, "id" | "public_bytes">[]>;
  query(query: NativeQuery): Promise<NativeDocument[]>;
  write(write: NativeWrite): Promise<NativeWriteResult>;
}
const schema = {
  payload: { type: "string", filterable: false },
  kind: "string",
  revision: "int",
  commit: "string",
  writer: "string",
  indexed_revision: "int",
  record_id: "string",
  part_count: "int",
  record_key: { type: "string", filterable: false },
  sort_key: "string",
  public_bytes: "int",
  created_at: "datetime",
  visible: "bool",
  dead_revision: "int",
  table_name: "string",
  conversation_id: "int",
  entity_key: "string",
  content: {
    type: "string",
    filterable: false,
    regex: true,
    full_text_search: {
      tokenizer: "word_v2",
      stemming: false,
      remove_stopwords: false,
    },
  },
};
/** Native records and native search; no SQL driver, projection or on-disk cache. */
export class NativeHttpIo implements NativeIo {
  readonly client: TurbopufferTransport;
  private immutable = new Map<string, NativeDocument>();
  private immutableSizes = new Map<string, number>();
  private immutableBytes = 0;
  #numShards?: number;
  constructor(options: {
    apiKey: string;
    namespace: string;
    region?: string;
    numShards?: number;
  }) {
    if (
      options.numShards !== undefined &&
      (!Number.isInteger(options.numShards) ||
        options.numShards < 1 ||
        options.numShards > 256)
    )
      throw new Error("Native shard count must be 1..256");
    this.#numShards = options.numShards;
    this.client = new TurbopufferTransport({ ...options, metricsLimit: 2048 });
  }
  async query(query: NativeQuery): Promise<NativeDocument[]> {
    const response = await this.client.request("POST", "/query", {
      ...query,
      consistency: { level: "strong" },
    });
    if (!Array.isArray(response.rows))
      throw new Error("Malformed Turbopuffer query response");
    return response.rows;
  }
  async read(ids: string[]): Promise<NativeDocument[]> {
    const missing = [...new Set(ids.filter((id) => !this.immutable.has(id)))],
      fetched = new Map<string, NativeDocument>();
    for (let at = 0; at < missing.length; at += 1000) {
      const rows = await this.query({
        rank_by: ["id", "asc"],
        filters: ["id", "In", missing.slice(at, at + 1000)],
        top_k: 1000,
        include_attributes: true,
      });
      for (const row of rows) {
        fetched.set(row.id, row);
        // Content-addressed immutable records can be cached without weakening
        // read-after-write. Mutable roots/search documents always hit the API.
        this.remember(row);
      }
    }
    return ids.flatMap((id) => {
      const row = fetched.get(id) ?? this.immutable.get(id);
      return row ? [row] : [];
    });
  }

  private remember(row: NativeDocument): void {
    if (!/^[prz]:/.test(row.id)) return;
    const size = Buffer.byteLength(JSON.stringify(row));
    if (size > 32 * 1024 * 1024) return;
    if (this.immutable.has(row.id)) {
      this.immutableBytes -= this.immutableSizes.get(row.id)!;
      this.immutable.delete(row.id);
      this.immutableSizes.delete(row.id);
    }
    while (
      this.immutable.size &&
      (this.immutable.size >= 4096 ||
        this.immutableBytes + size > 32 * 1024 * 1024)
    ) {
      const id = this.immutable.keys().next().value!;
      this.immutable.delete(id);
      this.immutableBytes -= this.immutableSizes.get(id)!;
      this.immutableSizes.delete(id);
    }
    this.immutable.set(row.id, row);
    this.immutableSizes.set(row.id, size);
    this.immutableBytes += size;
  }
  async readMetadata(
    ids: string[]
  ): Promise<Pick<NativeDocument, "id" | "public_bytes">[]> {
    const result: Pick<NativeDocument, "id" | "public_bytes">[] = [],
      missing: string[] = [];
    for (const id of ids) {
      const cached = this.immutable.get(id);
      if (cached) result.push({ id, public_bytes: cached.public_bytes });
      else missing.push(id);
    }
    for (let at = 0; at < missing.length; at += 1000)
      result.push(
        ...(await this.query({
          rank_by: ["id", "asc"],
          filters: ["id", "In", missing.slice(at, at + 1000)],
          top_k: 1000,
          include_attributes: ["public_bytes"],
        }))
      );
    return result;
  }
  async readPages(ids: string[]): Promise<Page[]> {
    const rows = await this.read(ids);
    if (rows.some((row) => row.kind !== "page"))
      throw new Error("Native page authority mismatch");
    return rows;
  }
  async write(write: NativeWrite): Promise<NativeWriteResult> {
    const response = await this.client.request("POST", "", {
      ...write,
      schema,
      ...(this.#numShards !== undefined
        ? { sharding: { num_shards: this.#numShards } }
        : {}),
    });
    const upserted = response.rows_upserted ?? 0,
      patched = response.rows_patched ?? 0;
    if (
      ![response.rows_affected, upserted, patched].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      ) ||
      response.rows_affected !== upserted + patched
    )
      throw new Error("Ambiguous native write counts; reconcile root");
    // Only cache batches whose immutable upserts were all acknowledged. Head
    // and search documents are mutable and never enter this cache. Even a
    // rejected root publication may safely cache its unreachable immutable IDs.
    if (upserted === (write.upsert_rows?.length ?? 0))
      for (const row of write.upsert_rows ?? []) this.remember(row);
    return { upserted, patched };
  }
}
