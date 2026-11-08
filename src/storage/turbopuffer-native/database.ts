import { normalizeMessageContentForFullTextIndex } from "../../store/message-full-text.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { digest, encode, decode, numericKey } from "./codec.js";
import { NativeTree, type Range } from "./tree.js";
import {
  NativeHttpIo,
  type NativeDocument,
  type NativeIo,
  type NativeWrite,
} from "./io.js";

export class NativeConflict extends Error {}
export class NativeStaleWriter extends NativeConflict {}
export class NativeUnknownCommit extends Error {
  constructor(readonly operationId: string) {
    super(
      "Turbopuffer publication is unknown; reconcile this operation before retrying"
    );
  }
}
export class NativeIndexPending extends Error {
  readonly committed = true;
  constructor(readonly operationId: string) {
    super(
      "Turbopuffer commit succeeded; search materialization is pending recovery"
    );
  }
}
export type NativeHead = {
  tree: string;
  revision: number;
  indexedRevision: number;
  writer: string;
  commit: string;
};
type Change = { key: string; previous: string | null; next: string | null };
type Journal = { operationId: string; revision: number; chunks: number };
type Receipt = { inputDigest: string; result: unknown };
type Scope = { view: NativeView };
export type NativeDatabaseOptions = {
  organizationId: string;
  agentId: string;
  namespacePrefix: string;
  apiKey?: string;
  region?: string;
  numShards?: number;
  io?: NativeIo;
  claimWriter?: boolean;
};
const CHUNK_BYTES = 2 * 1024 * 1024;
function textParts(value: string): string[] {
  const parts: string[] = [];
  let chars: string[] = [],
    bytes = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char);
    if (bytes + size > CHUNK_BYTES) {
      parts.push(chars.join(""));
      chars = [];
      bytes = 0;
    }
    chars.push(char);
    bytes += size;
  }
  if (chars.length) parts.push(chars.join(""));
  return parts;
}
function indexedContent(table: string, value: any): string {
  if (typeof value?.content !== "string") return "";
  return table === "messages"
    ? normalizeMessageContentForFullTextIndex(value.content) ?? ""
    : value.content;
}
const journalKey = (revision: number) => `!journal/${numericKey(revision)}`;
const receiptKey = (token: string) => `!receipt/${digest(token)}`;
const searchId = (record: string, part: number) =>
  `s:${digest([record, part])}`;

/** Pinned committed view; reading old roots never requires a whole-history export. */
export class NativeView {
  readonly tree: NativeTree;
  protected records = new Map<string, NativeDocument>();
  private recordSizes = new Map<string, number>();
  private recordBytes = 0;
  constructor(readonly io: NativeIo, readonly head: NativeHead) {
    this.tree = new NativeTree(io, head.tree);
  }
  async readRecord<T>(id: string): Promise<T> {
    const cached = this.records.get(id),
      row = cached ?? (await this.io.read([id]))[0];
    if (!row || row.kind !== "record")
      throw new Error("Committed native record missing");
    this.prime([row]);
    const envelope = JSON.parse(row.payload);
    let serialized: string;
    if (envelope.codec === "inline") serialized = envelope.value;
    else if (envelope.codec === "chunks") {
      const chunks = new NativeTree(this.io, envelope.root),
        buffers: Buffer[] = [];
      let bytes = 0;
      for await (const entry of chunks.scan()) {
        const [chunk] = await this.io.read([entry.value!]);
        if (
          !chunk ||
          chunk.kind !== "chunk" ||
          chunk.id !== `z:${digest(chunk.payload)}`
        )
          throw new Error("Native value chunk missing or corrupt");
        const buffer = Buffer.from(chunk.payload, "base64");
        bytes += buffer.length;
        buffers.push(buffer);
      }
      if (bytes !== envelope.bytes)
        throw new Error("Native value chunk length mismatch");
      serialized = Buffer.concat(buffers).toString("utf8");
    } else throw new Error("Invalid native value encoding");
    if (
      row.id !==
      `r:${digest([row.record_key, serialized, row.revision, row.commit])}`
    )
      throw new Error("Native record hash mismatch");
    return decode<T>(serialized);
  }
  async get<T>(key: string): Promise<T | null> {
    const id = await this.tree.get(key);
    return id ? this.readRecord<T>(id) : null;
  }
  async getMany<T>(keys: string[]): Promise<(T | null)[]> {
    const ids = await this.tree.getMany(keys);
    const missing = [
      ...new Set(
        ids.filter((id): id is string => id !== null && !this.records.has(id))
      ),
    ];
    this.prime(await this.io.read(missing));
    return Promise.all(ids.map((id) => (id ? this.readRecord<T>(id) : null)));
  }
  prime(rows: NativeDocument[]): void {
    for (const row of rows) {
      const size = Buffer.byteLength(row.payload);
      if (size > 32 * 1024 * 1024) continue;
      if (this.records.has(row.id)) {
        this.recordBytes -= this.recordSizes.get(row.id)!;
        this.records.delete(row.id);
        this.recordSizes.delete(row.id);
      }
      while (
        this.records.size &&
        (this.records.size >= 1024 ||
          this.recordBytes + size > 32 * 1024 * 1024)
      ) {
        const id = this.records.keys().next().value!;
        this.records.delete(id);
        this.recordBytes -= this.recordSizes.get(id)!;
        this.recordSizes.delete(id);
      }
      this.records.set(row.id, row);
      this.recordSizes.set(row.id, size);
      this.recordBytes += size;
    }
  }
  async *scan<T>(range: Range): AsyncGenerator<{ key: string; value: T }> {
    let batch: { key: string; value: string | null }[] = [];
    const read = async (batch: { key: string; value: string | null }[]) => {
      const missing = batch
        .filter((entry) => !this.records.has(entry.value!))
        .map((entry) => entry.value!);
      this.prime(await this.io.read(missing));
      return Promise.all(
        batch.map(async (entry) => ({
          key: entry.key,
          value: await this.readRecord<T>(entry.value!),
        }))
      );
    };
    for await (const entry of this.tree.scan(range)) {
      batch.push(entry);
      if (batch.length >= 64) {
        for (const item of await read(batch)) yield item;
        batch = [];
      }
    }
    if (batch.length) for (const item of await read(batch)) yield item;
  }
}

/** A write set and dirty index paths, never a hydrated SQL database. */
export class NativeTransaction extends NativeView {
  readonly documents: Map<string, NativeDocument>;
  readonly changes = new Map<string, Change>();
  constructor(io: NativeIo, head: NativeHead, readonly operationId: string) {
    const documents = new Map<string, NativeDocument>();
    const read = async (ids: string[]) => {
      const missing = ids.filter((id) => !documents.has(id));
      const fetched = await io.read(missing),
        found = new Map(fetched.map((row) => [row.id, row]));
      return ids.flatMap((id) => {
        const row = documents.get(id) ?? found.get(id);
        return row ? [row] : [];
      });
    };
    super(
      {
        read,
        readPages: read,
        query: (query) => io.query(query),
        write: (body) => io.write(body),
      },
      head
    );
    this.documents = documents;
  }
  async put(key: string, value: unknown): Promise<void> {
    const serialized = encode(value),
      revision = this.head.revision + 1;
    const id = `r:${digest([key, serialized, revision, this.operationId])}`;
    const change = this.changes.get(key) ?? {
      key,
      previous: await this.tree.get(key),
      next: null,
    };
    let payload: string;
    if (Buffer.byteLength(serialized) <= CHUNK_BYTES)
      payload = JSON.stringify({ codec: "inline", value: serialized });
    else {
      const bytes = Buffer.from(serialized),
        chunks = new NativeTree(this.io, null);
      for (
        let at = 0, index = 0;
        at < bytes.length;
        at += CHUNK_BYTES, index++
      ) {
        const data = bytes.subarray(at, at + CHUNK_BYTES).toString("base64"),
          chunkId = `z:${digest(data)}`;
        this.documents.set(chunkId, {
          id: chunkId,
          kind: "chunk",
          payload: data,
        });
        await chunks.set(numericKey(index), chunkId);
      }
      const sealed = await chunks.seal();
      for (const page of sealed.pages)
        this.documents.set(page.id, { ...page, kind: "page" });
      payload = JSON.stringify({
        codec: "chunks",
        root: sealed.root,
        bytes: bytes.length,
      });
    }
    const row = value as any;
    const table = key.split("/")[0];
    const content = ["messages", "summaries", "large-files"].includes(table)
      ? indexedContent(table, row)
      : "";
    const partCount = textParts(content).length;
    this.documents.set(id, {
      id,
      kind: "record",
      payload,
      revision,
      commit: this.operationId,
      record_key: key,
      entity_key: digest(key),
      table_name: table,
      conversation_id: row?.conversationId ?? 0,
      public_bytes:
        table === "messages"
          ? Buffer.byteLength(
              JSON.stringify(
                Object.fromEntries(
                  Object.entries(row ?? {}).filter(
                    ([key]) => !["identityHash", "stableEventKey"].includes(key)
                  )
                )
              )
            )
          : undefined,
      part_count: partCount,
    });
    change.next = id;
    this.changes.set(key, change);
    await this.tree.set(key, id);
    if (["messages", "summaries", "large-files"].includes(table)) {
      const overflow = `!overflow/${table}/${digest(key)}`;
      if (partCount > 1) await this.put(overflow, key);
      else if (await this.tree.get(overflow)) await this.remove(overflow);
    }
  }
  async remove(key: string): Promise<void> {
    const change = this.changes.get(key) ?? {
      key,
      previous: await this.tree.get(key),
      next: null,
    };
    change.next = null;
    this.changes.set(key, change);
    await this.tree.set(key, null);
    const table = key.split("/")[0];
    if (["messages", "summaries", "large-files"].includes(table)) {
      const overflow = `!overflow/${table}/${digest(key)}`;
      if (await this.tree.get(overflow)) await this.remove(overflow);
    }
  }
}

/** One fenced writer instance per native agent; reads use immutable, pinned roots. */
const NATIVE_DATABASE = Symbol.for(
  "@pandelis/lossless-claw/native-database-v1"
);
export class NativeDatabase {
  readonly [NATIVE_DATABASE] = true;
  static isNative(value: unknown): value is NativeDatabase {
    return (
      value !== null &&
      typeof value === "object" &&
      (value as Record<symbol, unknown>)[
        Symbol.for("@pandelis/lossless-claw/native-database-v1")
      ] === true
    );
  }
  readonly namespace: string;
  readonly io: NativeIo;
  readonly organizationId: string;
  readonly agentId: string;
  private authority: string;
  private owner: string | null = null;
  private scope = new AsyncLocalStorage<Scope>();
  private tail: Promise<void> = Promise.resolve();
  private constructor(options: NativeDatabaseOptions) {
    if (
      !options.organizationId ||
      !options.agentId ||
      !/^[A-Za-z0-9_.-]{1,50}$/.test(options.namespacePrefix)
    )
      throw new Error("Explicit native organization/agent authority required");
    this.organizationId = options.organizationId;
    this.agentId = options.agentId;
    this.authority = digest([options.organizationId, options.agentId]);
    this.namespace = `${options.namespacePrefix}-${this.authority.slice(
      0,
      24
    )}`;
    if (!options.io && !options.apiKey)
      throw new Error("Native Turbopuffer credential required");
    this.io =
      options.io ??
      new NativeHttpIo({
        apiKey: options.apiKey!,
        namespace: this.namespace,
        region: options.region,
        numShards: options.numShards,
      });
  }
  static async open(options: NativeDatabaseOptions): Promise<NativeDatabase> {
    const db = new NativeDatabase(options);
    let rootExists = false;
    try {
      rootExists = (await db.io.read(["head"])).length > 0;
      if (
        !rootExists &&
        (
          await db.io.query({
            rank_by: ["id", "asc"],
            limit: 1,
            include_attributes: false,
          })
        ).length
      )
        throw new Error(
          "Namespace contains another storage format; migrate explicitly"
        );
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "Turbopuffer HTTP 404")
        throw error;
    }
    if (!rootExists) {
      const empty = await new NativeTree(db.io, null).seal();
      try {
        await db.io.write({
          upsert_rows: [
            ...empty.pages.map((p) => ({ ...p, kind: "page" })),
            {
              id: "head",
              kind: "head",
              payload: JSON.stringify({
                format: 1,
                authority: db.authority,
                tree: empty.root,
              }),
              revision: 0,
              indexed_revision: 0,
              writer: "",
              commit: "",
            },
          ],
          upsert_condition: ["id", "Eq", null],
        });
      } catch {
        await db.head();
      }
    }
    const head = await db.head();
    if (options.claimWriter !== false) {
      const owner = randomUUID();
      const result = await db.io.write({
        patch_rows: [{ id: "head", writer: owner }],
        patch_condition: [
          "And",
          [
            ["revision", "Eq", head.revision],
            ["writer", "Eq", head.writer],
          ],
        ],
      });
      if (result.patched !== 1)
        throw new NativeConflict("Writer admission changed concurrently");
      db.owner = owner;
    }
    return db;
  }
  async head(): Promise<NativeHead> {
    const [row] = await this.io.read(["head"]);
    if (!row || row.kind !== "head")
      throw new Error("Native agent root missing");
    const payload = JSON.parse(row.payload);
    if (
      payload.format !== 1 ||
      payload.authority !== this.authority ||
      !payload.tree?.startsWith("p:") ||
      !Number.isSafeInteger(row.revision) ||
      !Number.isSafeInteger(row.indexed_revision) ||
      row.indexed_revision! > row.revision! ||
      row.indexed_revision! < 0
    )
      throw new Error("Invalid native root format or agent authority");
    return {
      tree: payload.tree,
      revision: row.revision!,
      indexedRevision: row.indexed_revision!,
      writer: row.writer!,
      commit: row.commit!,
    };
  }
  async snapshot(): Promise<NativeView> {
    return new NativeView(this.io, await this.head());
  }
  async read<T>(run: (view: NativeView) => Promise<T>): Promise<T> {
    const scope = this.scope.getStore();
    if (scope) return run(scope.view);
    return this.scope.run({ view: await this.snapshot() }, () =>
      run(this.scope.getStore()!.view)
    );
  }
  async transaction<T>(
    run: (tx: NativeTransaction) => Promise<T>,
    options: { token?: string; input?: unknown } = {}
  ): Promise<T> {
    const parent = this.scope.getStore();
    if (parent?.view instanceof NativeTransaction) return run(parent.view);
    // Same invariant as the upstream connection's transaction mutex: a single
    // admitted agent writer owns this instance. This is not a durable job queue.
    const operation = this.tail.then(async () => {
      const base = await this.head();
      if (!this.owner || base.writer !== this.owner)
        throw new NativeStaleWriter(
          "Native writer was fenced by another initialization"
        );
      const token = options.token ?? randomUUID(),
        inputDigest = digest(options.input ?? null);
      const completeIndex = async (head: NativeHead) => {
        if (head.indexedRevision >= head.revision) return;
        try {
          await this.ensureIndexed(head.revision);
        } catch {
          throw new NativeIndexPending(token);
        }
      };
      const recover = async () => {
        try {
          const current = await this.head();
          return {
            current,
            receipt: await new NativeView(this.io, current).get<Receipt>(
              receiptKey(token)
            ),
          };
        } catch {
          throw new NativeUnknownCommit(token);
        }
      };
      const tx = new NativeTransaction(this.io, base, token);
      const previous = await tx.get<Receipt>(receiptKey(token));
      if (previous) {
        if (previous.inputDigest !== inputDigest)
          throw new NativeConflict(
            "Operation token reused with different input"
          );
        await completeIndex(base);
        return previous.result as T;
      }
      const result = await this.scope.run({ view: tx }, () => run(tx));
      await tx.put(receiptKey(token), { inputDigest, result });
      const changes = [...tx.changes.values()];
      const indexedAtPublication =
        base.indexedRevision === base.revision &&
        !changes.some((change) =>
          ["messages", "summaries", "large-files"].includes(
            change.key.split("/")[0]
          )
        );
      const chunks = Math.ceil(changes.length / 200);
      for (let at = 0; at < chunks; at++)
        await tx.put(
          `${journalKey(base.revision + 1)}/${numericKey(at)}`,
          changes.slice(at * 200, (at + 1) * 200)
        );
      await tx.put(journalKey(base.revision + 1), {
        operationId: token,
        revision: base.revision + 1,
        chunks,
      } satisfies Journal);
      const sealed = await tx.tree.seal();
      for (const page of sealed.pages)
        tx.documents.set(page.id, { ...page, kind: "page" });
      const payload = JSON.stringify({
        format: 1,
        authority: this.authority,
        tree: sealed.root,
      });
      let patched: number;
      try {
        patched = (
          await this.writeBatches([...tx.documents.values()], {
            patch_rows: [
              {
                id: "head",
                payload,
                revision: base.revision + 1,
                commit: token,
                ...(indexedAtPublication
                  ? { indexed_revision: base.revision + 1 }
                  : {}),
              },
            ],
            patch_condition: [
              "And",
              [
                ["revision", "Eq", base.revision],
                ["writer", "Eq", this.owner],
              ],
            ],
          })
        ).patched;
      } catch {
        const { current, receipt } = await recover();
        if (receipt?.inputDigest === inputDigest) {
          if (parent) parent.view = new NativeView(this.io, current);
          await completeIndex(current);
          return receipt.result as T;
        }
        if (current.writer !== this.owner)
          throw new NativeStaleWriter(
            "Native writer was fenced during publication"
          );
        if (current.revision === base.revision)
          throw new NativeUnknownCommit(token);
        throw new NativeConflict("Native root changed during publication");
      }
      if (patched !== 1) {
        const { current, receipt } = await recover();
        if (receipt?.inputDigest === inputDigest) {
          if (parent) parent.view = new NativeView(this.io, current);
          await completeIndex(current);
          return receipt.result as T;
        }
        if (current.writer !== this.owner)
          throw new NativeStaleWriter(
            "Native root publication lost its writer fence"
          );
        throw new NativeConflict("Native root changed during publication");
      }
      const published: NativeHead = {
        tree: sealed.root,
        revision: base.revision + 1,
        indexedRevision: indexedAtPublication
          ? base.revision + 1
          : base.indexedRevision,
        writer: this.owner,
        commit: token,
      };
      if (parent) parent.view = new NativeView(this.io, published);
      await completeIndex(published);
      return result;
    });
    this.tail = operation.then(
      () => {},
      () => {}
    );
    return operation;
  }
  /** Split requests, not canonical history. Only the final batch publishes a root. */
  private async writeBatches(
    rows: NativeDocument[],
    last: NativeWrite = {}
  ): Promise<{ upserted: number; patched: number }> {
    let batch: NativeDocument[] = [],
      bytes = 0;
    for (const row of rows) {
      const length = Buffer.byteLength(JSON.stringify(row));
      if (batch.length && bytes + length > 8 * 1024 * 1024) {
        await this.io.write({
          upsert_rows: batch,
          upsert_condition: ["id", "Eq", null],
        });
        batch = [];
        bytes = 0;
      }
      batch.push(row);
      bytes += length;
    }
    return this.io.write({
      upsert_rows: batch,
      upsert_condition: ["id", "Eq", null],
      ...last,
    });
  }
  /** Complete committed search materialization before admitting native search. */
  async ensureIndexed(target: number): Promise<void> {
    for (;;) {
      const head = await this.head();
      if (head.indexedRevision >= target) return;
      if (head.revision < target)
        throw new Error("Native indexed target is beyond the committed root");
      const revision = head.indexedRevision + 1,
        view = new NativeView(this.io, head);
      const journal = await view.get<Journal>(journalKey(revision));
      if (!journal || journal.revision !== revision)
        throw new Error("Committed native journal missing");
      let newRows: NativeDocument[] = [],
        deadRows: Partial<NativeDocument>[] = [],
        bytes = 0;
      const flush = async (final: boolean) => {
        await this.io.write({
          upsert_rows: newRows,
          upsert_condition: ["id", "Eq", null],
          patch_rows: [
            ...deadRows,
            ...(final ? [{ id: "head", indexed_revision: revision }] : []),
          ],
          patch_condition: [
            "Or",
            [
              ["kind", "Eq", "search"],
              [
                "And",
                [
                  ["kind", "Eq", "head"],
                  ["indexed_revision", "Eq", revision - 1],
                ],
              ],
            ],
          ],
        });
        newRows = [];
        deadRows = [];
        bytes = 0;
      };
      for (let at = 0; at < journal.chunks; at++) {
        const journalChanges = await view.get<Change[]>(
          `${journalKey(revision)}/${numericKey(at)}`
        );
        if (!journalChanges) throw new Error("Committed journal chunk missing");
        const changes = journalChanges.filter((change) =>
          ["messages", "summaries", "large-files"].includes(
            change.key.split("/")[0]
          )
        );
        if (!changes.length) continue;
        const ids = [
          ...new Set(
            changes.flatMap((change) =>
              [change.previous, change.next].filter(
                (id): id is string => id !== null
              )
            )
          ),
        ];
        const records = await this.io.read(ids),
          byId = new Map(records.map((row) => [row.id, row]));
        view.prime(records);
        for (const change of changes) {
          if (change.previous) {
            const previous = byId.get(change.previous);
            if (!previous) throw new Error("Committed predecessor missing");
            for (let part = 0; part < (previous.part_count ?? 0); part++) {
              if (deadRows.length >= 1000) await flush(false);
              deadRows.push({
                id: searchId(previous.id, part),
                dead_revision: revision,
              });
            }
          }
          if (!change.next) continue;
          const record = byId.get(change.next);
          if (!record) throw new Error("Committed indexed record missing");
          if (!record.part_count) continue;
          const value = await view.readRecord<any>(record.id),
            parts = textParts(indexedContent(record.table_name!, value));
          const date = value.latestAt ?? value.createdAt;
          const timestamp =
            date instanceof Date
              ? date.toISOString()
              : typeof date === "string"
              ? date
              : "1970-01-01T00:00:00.000Z";
          for (let part = 0; part < parts.length; part++) {
            const searchRow: NativeDocument = {
              id: searchId(record.id, part),
              kind: "search",
              payload: "",
              record_id: record.id,
              entity_key: record.entity_key,
              table_name: record.table_name,
              conversation_id: record.conversation_id,
              revision,
              dead_revision: null,
              visible: true,
              content: parts[part],
              created_at: timestamp,
              sort_key: `${timestamp}/${
                typeof value.messageId === "number"
                  ? numericKey(value.messageId)
                  : String(value.summaryId ?? record.id)
              }`,
            };
            const length = Buffer.byteLength(JSON.stringify(searchRow));
            if (newRows.length && bytes + length > 8 * 1024 * 1024)
              await flush(false);
            newRows.push(searchRow);
            bytes += length;
          }
        }
      }
      await flush(true);
      // Replaying a finalization cannot resurrect an old version: insert-if-
      // absent preserves any later dead_revision already attached to that ID.
      // The root watermark is advanced only after every index write is durable.
      // Concurrent finalizers can safely repeat immutable inserts/death markers.
    }
  }
  async reconcile<T>(
    token: string,
    input: unknown
  ): Promise<{ status: "committed"; result: T } | { status: "unknown" }> {
    const view = await this.snapshot(),
      receipt = await view.get<Receipt>(receiptKey(token));
    if (!receipt) return { status: "unknown" };
    if (receipt.inputDigest !== digest(input ?? null))
      throw new NativeConflict("Operation token reused with different input");
    await this.ensureIndexed(view.head.revision);
    return { status: "committed", result: receipt.result as T };
  }
  async search(input: {
    table: string;
    query: string;
    mode: "full_text" | "regex";
    conversationIds?: number[];
    limit?: number;
    sort?: "timestamp" | "relevance" | "hybrid";
    matchAll?: boolean;
    head?: NativeHead;
    filters?: unknown[];
    exclude?: string[];
    since?: Date;
    before?: Date;
  }): Promise<NativeDocument[]> {
    const head = input.head ?? (await this.head());
    if (head.indexedRevision < head.revision)
      await this.ensureIndexed(head.revision);
    const filters: any[] = [
      ["kind", "Eq", "search"],
      ["visible", "Eq", true],
      ["table_name", "Eq", input.table],
      ["revision", "Lte", head.revision],
      [
        "Or",
        [
          ["dead_revision", "Eq", null],
          ["dead_revision", "Gt", head.revision],
        ],
      ],
    ];
    if (input.filters) filters.push(...input.filters);
    if (input.exclude?.length) filters.push(["id", "NotIn", input.exclude]);
    if (input.since)
      filters.push(["sort_key", "Gte", input.since.toISOString()]);
    if (input.before)
      filters.push(["sort_key", "Lt", input.before.toISOString()]);
    if (input.conversationIds)
      filters.push(["conversation_id", "In", input.conversationIds]);
    if (input.mode === "regex") filters.push(["content", "Regex", input.query]);
    else
      filters.push([
        "content",
        input.matchAll === false ? "ContainsAnyToken" : "ContainsAllTokens",
        input.query,
      ]);
    const lexical = ["content", "BM25", input.query];
    const rank =
      input.mode === "full_text" && input.sort !== "timestamp"
        ? input.sort === "hybrid"
          ? [
              "Sum",
              [
                lexical,
                [
                  "Decay",
                  [
                    "Dist",
                    ["Attribute", "created_at"],
                    new Date().toISOString(),
                  ],
                  { midpoint: "1000h", exponent: 1 },
                ],
              ],
            ]
          : lexical
        : ["sort_key", "desc"];
    return this.io.query({
      rank_by: rank,
      filters: ["And", filters],
      limit: {
        total: Math.min(10000, input.limit ?? 100),
        per: { attributes: ["entity_key"], limit: 1 },
      },
      include_attributes: [
        "record_id",
        "entity_key",
        "conversation_id",
        "table_name",
        "revision",
        "dead_revision",
        "sort_key",
      ],
    });
  }
}
