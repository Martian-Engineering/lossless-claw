import { describe, it, expect } from "vitest";
import {
  NativeDatabase,
  NativeStaleWriter,
  NativeUnknownCommit,
  NativeConflict,
} from "../src/storage/turbopuffer-native/database.js";
import type {
  NativeDocument,
  NativeIo,
  NativeWrite,
  NativeQuery,
} from "../src/storage/turbopuffer-native/io.js";
import { numericKey } from "../src/storage/turbopuffer-native/codec.js";
import { MemoryIo } from "./helpers/turbopuffer-native-io.js";
const options = (io: MemoryIo) => ({
  organizationId: "org1",
  agentId: "agent1",
  namespacePrefix: "native-unit",
  io,
});
const record = (content: string) => ({
  conversationId: 1,
  content,
  createdAt: new Date(0),
});
describe("native Turbopuffer commit protocol", () => {
  it("stores more than 512 receipts without growing a root manifest and replays typed results", async () => {
    const io = new MemoryIo(),
      db = await NativeDatabase.open(options(io));
    for (let i = 0; i < 530; i++)
      await db.transaction(
        async (tx) => {
          await tx.put(`metadata/${numericKey(i)}`, { i });
          return { i, date: new Date(i) };
        },
        { token: `op-${i}`, input: i }
      );
    expect((await db.head()).revision).toBe(530);
    expect(Buffer.byteLength(io.rows.get("head")!.payload)).toBeLessThan(512);
    const result = await db.transaction(
      async () => {
        throw new Error("must not execute");
      },
      { token: "op-1", input: 1 }
    );
    expect(result).toEqual({ i: 1, date: new Date(1) });
    await expect(
      db.transaction(async () => {}, { token: "op-1", input: 2 })
    ).rejects.toBeInstanceOf(NativeConflict);
  });
  it("retains more than 16 MiB of value bytes using paged chunks rather than a snapshot cap", async () => {
    const io = new MemoryIo(),
      db = await NativeDatabase.open(options(io)),
      content = "😀quartz".repeat(2_000_000);
    await db.transaction(async (tx) => {
      await tx.put("blob/large", { content });
      expect(await tx.get("blob/large")).toEqual({ content });
    });
    expect(await db.read((view) => view.get("blob/large"))).toEqual({
      content,
    });
    expect(
      Math.max(
        ...[...io.rows.values()].map((row) => Buffer.byteLength(row.payload))
      )
    ).toBeLessThan(4 * 1024 * 1024);
  });
  it("serializes concurrent conversation transactions within the single admitted writer", async () => {
    const io = new MemoryIo(),
      db = await NativeDatabase.open(options(io));
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        db.transaction(async (tx) => {
          await tx.put(`messages/${numericKey(i)}`, {
            ...record(`quartz ${i}`),
            conversationId: i + 1,
          });
        })
      )
    );
    expect((await db.head()).revision).toBe(10);
    expect(
      (
        await db.search({
          table: "messages",
          mode: "full_text",
          query: "quartz",
        })
      ).length
    ).toBe(10);
  });
  it("fences a retired writer even if it reloads the newest root", async () => {
    const io = new MemoryIo(),
      old = await NativeDatabase.open(options(io));
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
        entered = r;
      }),
      gate = new Promise<void>((r) => {
        release = r;
      });
    const active = old.transaction(async (tx) => {
      await tx.put("messages/old", record("must stay unreachable"));
      entered();
      await gate;
    });
    await started;
    const current = await NativeDatabase.open(options(io));
    await current.transaction(async (tx) =>
      tx.put("messages/current", record("current committed"))
    );
    release();
    await expect(active).rejects.toBeInstanceOf(NativeStaleWriter);
    await expect(old.transaction(async () => {})).rejects.toBeInstanceOf(
      NativeStaleWriter
    );
    expect(await current.read((view) => view.get("messages/old"))).toBeNull();
    expect(
      await current.search({
        table: "messages",
        mode: "full_text",
        query: "unreachable",
      })
    ).toHaveLength(0);
  });
  it("reconciles a lost root reply, repairs indexing after a crash, and keeps old views pinned", async () => {
    const io = new MemoryIo(),
      db = await NativeDatabase.open(options(io)),
      before = await db.snapshot();
    io.failAfter = (body) => {
      if (body.patch_rows?.some((row) => row.revision !== undefined)) {
        io.failAfter = undefined;
        throw new Error("lost root response");
      }
    };
    await db.transaction(
      async (tx) => {
        await tx.put("messages/one", record("quartz committed"));
        return new Date(0);
      },
      { token: "lost", input: { same: true } }
    );
    expect(await before.get("messages/one")).toBeNull();
    expect(await db.reconcile("lost", { same: true })).toEqual({
      status: "committed",
      result: new Date(0),
    });
    io.failBefore = (body) => {
      if (body.upsert_rows?.some((row) => row.kind === "search"))
        throw new Error("crash before index materialization");
    };
    await expect(
      db.transaction(
        async (tx) => tx.put("messages/two", record("recovery quartz")),
        { token: "needs-index" }
      )
    ).rejects.toThrow("materialization");
    const head = await db.head();
    expect(head.indexedRevision).toBeLessThan(head.revision);
    io.failBefore = undefined;
    const fresh = await NativeDatabase.open({
      ...options(io),
      claimWriter: false,
    });
    expect(
      await fresh.search({
        table: "messages",
        query: "recovery",
        mode: "full_text",
      })
    ).toHaveLength(1);
    expect((await fresh.head()).indexedRevision).toBe(head.revision);
  });
  it("retains old version visibility and never resurrects it during repeated index repair", async () => {
    const io = new MemoryIo(),
      db = await NativeDatabase.open(options(io));
    await db.transaction(async (tx) =>
      tx.put("messages/one", record("old quartz"))
    );
    const old = await db.snapshot();
    await db.transaction(async (tx) =>
      tx.put("messages/one", record("new quartz"))
    );
    expect(await old.get("messages/one")).toEqual(record("old quartz"));
    expect(
      await db.search({ table: "messages", query: "old", mode: "full_text" })
    ).toHaveLength(0);
    expect(
      await db.search({ table: "messages", query: "new", mode: "full_text" })
    ).toHaveLength(1);
  });
  it("never resets an unrelated namespace or accepts another agent's root", async () => {
    const io = new MemoryIo();
    io.rows.set("legacy", {
      id: "legacy",
      kind: "head",
      payload: "legacy data",
    });
    await expect(NativeDatabase.open(options(io))).rejects.toThrow(
      "another storage format"
    );
    expect(io.rows.size).toBe(1);
    io.rows.clear();
    await NativeDatabase.open(options(io));
    await expect(
      NativeDatabase.open({ ...options(io), agentId: "agent2" })
    ).rejects.toThrow("authority");
  });
  it("does not infer absence from an ambiguous request that has not published", async () => {
    const io = new MemoryIo(),
      db = await NativeDatabase.open(options(io));
    io.failBefore = (body) => {
      if (body.patch_rows?.some((row) => row.revision !== undefined))
        throw new Error("pre-send failure");
    };
    await expect(
      db.transaction(async (tx) => tx.put("messages/no", record("absent")), {
        token: "unknown",
      })
    ).rejects.toBeInstanceOf(NativeUnknownCommit);
    expect(await db.reconcile("unknown", null)).toEqual({ status: "unknown" });
    expect((await db.head()).revision).toBe(0);
  });
});

it("preserves an operation token when both the write reply and reconciliation reads fail", async () => {
  const io = new MemoryIo(),
    db = await NativeDatabase.open(options(io)),
    originalRead = io.read.bind(io);
  io.failAfter = (body) => {
    if (body.patch_rows?.some((row) => row.revision !== undefined)) {
      io.read = async () => {
        throw new Error("provider unavailable");
      };
      throw new Error("lost reply");
    }
  };
  await expect(
    db.transaction(
      async (tx) => {
        await tx.put("messages/outage", record("outage committed"));
        return "saved";
      },
      { token: "outage-token" }
    )
  ).rejects.toMatchObject({ operationId: "outage-token" });
  io.failAfter = undefined;
  io.read = originalRead;
  expect(await db.reconcile("outage-token", null)).toEqual({
    status: "committed",
    result: "saved",
  });
});
