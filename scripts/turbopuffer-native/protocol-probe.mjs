// Synthetic, isolated provider contract probe. Credential input must stay in RAM.
import { strict as assert } from "node:assert";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import {
  NativeDatabase,
  NativeHttpIo,
  NativeStaleWriter,
  NativeUnknownCommit,
} from "../../dist/experimental/turbopuffer-native.js";

export async function probe({ apiKey, output, count = 10020 }) {
  const prefix = `lcm-n-${randomUUID()}`,
    region = "aws-us-east-1";
  const options = {
    organizationId: "synthetic-org-1",
    agentId: "synthetic-agent-1",
    namespacePrefix: prefix,
    region,
    apiKey,
  };
  const namespaces = [],
    clients = [],
    steps = [];
  const open = async (extra = {}) => {
    const db = await NativeDatabase.open({ ...options, ...extra });
    namespaces.push(db.namespace);
    clients.push(db.io.client);
    return db;
  };
  const step = async (name, run) => {
    const start = performance.now(),
      requests = clients.reduce((n, c) => n + c.metrics.length, 0);
    const result = await run();
    steps.push({
      name,
      ms: performance.now() - start,
      roundTrips: clients.reduce((n, c) => n + c.metrics.length, 0) - requests,
    });
    return result;
  };
  const evidence = {
    format: 1,
    seed: 20261104,
    region,
    count,
    steps,
    cleanup: [],
    runtime: process.version,
    fixture: "synthetic native protocol rows; not a full LCM engine benchmark",
  };
  try {
    const db = await step("initialize", () => open()),
      old = await db.snapshot();
    await step("bulk immutable messages and commit root", () =>
      db.transaction(
        async (tx) => {
          for (let i = 0; i < count; i++)
            await tx.put(`messages/${String(i).padStart(16, "0")}`, {
              messageId: i,
              conversationId: (i % 6) + 1,
              content:
                `quartz native-${i} CANARY_agent1 ` + "synthetic ".repeat(40),
              createdAt: new Date(1730000000000 + i * 1000),
            });
          return count;
        },
        { token: "bulk", input: { count, seed: 20261104 } }
      )
    );
    assert.equal(await old.get("messages/0000000000000000"), null);
    await step(
      "ordered keyset traversal past provider 10000 result limit",
      () =>
        db.read(async (view) => {
          let seen = 0,
            last = "";
          for await (const row of view.scan({ prefix: "messages/" })) {
            assert.ok(row.key > last);
            last = row.key;
            seen++;
          }
          assert.equal(seen, count);
        })
    );
    await step("native BM25 scoped to conversation", async () => {
      const result = await db.search({
        table: "messages",
        query: "quartz",
        mode: "full_text",
        conversationIds: [1],
        limit: 80,
      });
      assert.equal(result.length, 80);
      assert.ok(result.every((row) => row.conversation_id === 1));
    });
    await step("native RE2 regex", async () =>
      assert.equal(
        (
          await db.search({
            table: "messages",
            query: `native-${count - 1}\\b`,
            mode: "regex",
            limit: 20,
          })
        ).length,
        1
      )
    );
    const realWrite = db.io.write.bind(db.io);
    let lose = true;
    db.io.write = async (body) => {
      const result = await realWrite(body);
      if (lose && body.patch_rows?.some((r) => r.revision !== undefined)) {
        lose = false;
        throw new Error("injected lost publication reply");
      }
      return result;
    };
    await step("lost CAS response reconciliation", async () => {
      await db.transaction(
        async (tx) =>
          tx.put("messages/lost", {
            messageId: count,
            conversationId: 1,
            content: "lostreply quartz",
            createdAt: new Date(),
          }),
        { token: "lost", input: null }
      );
      assert.equal((await db.reconcile("lost", null)).status, "committed");
    });
    db.io.write = realWrite;
    let crashed = false;
    db.io.write = async (body) => {
      if (body.patch_rows?.some((r) => r.revision !== undefined)) {
        crashed = true;
        throw new Error("injected crash before CAS");
      }
      return realWrite(body);
    };
    await step("crash after immutable writes before CAS", async () => {
      await assert.rejects(
        db.transaction(
          async (tx) => {
            for (let i = 0; i < 3; i++)
              await tx.put(`messages/crash${i}`, {
                messageId: count + i + 1,
                conversationId: 1,
                content: "CRASH_UNREACHABLE " + "x".repeat(3 * 1024 * 1024),
                createdAt: new Date(),
              });
          },
          { token: "crash" }
        ),
        NativeUnknownCommit
      );
      assert.ok(crashed);
      assert.equal(await db.read((v) => v.get("messages/crash0")), null);
      assert.equal(
        (
          await db.search({
            table: "messages",
            query: "CRASH_UNREACHABLE",
            mode: "full_text",
          })
        ).length,
        0
      );
    });
    db.io.write = realWrite;
    let entered, release;
    const started = new Promise((r) => {
        entered = r;
      }),
      gate = new Promise((r) => {
        release = r;
      });
    const competing = db.transaction(async (tx) => {
      await tx.put("messages/stale", {
        conversationId: 1,
        content: "STALE_UNREACHABLE",
        createdAt: new Date(),
      });
      entered();
      await gate;
    });
    await started;
    const current = await open();
    await step(
      "new writer wins; stale writer compaction rejected",
      async () => {
        await current.transaction(async (tx) => {
          await tx.put("summaries/winner", {
            summaryId: "winner",
            conversationId: 1,
            content: "winner quartz",
            createdAt: new Date(),
          });
          await tx.put("edges/winner/0", 0);
          await tx.put("context/1/0", { summaryId: "winner" });
        });
        release();
        await assert.rejects(competing, NativeStaleWriter);
        assert.equal(await current.read((v) => v.get("messages/stale")), null);
        assert.equal(
          (
            await current.search({
              table: "messages",
              query: "STALE_UNREACHABLE",
              mode: "full_text",
            })
          ).length,
          0
        );
      }
    );
    const indexWrite = current.io.write.bind(current.io);
    current.io.write = async (body) => {
      if (body.upsert_rows?.some((r) => r.kind === "search"))
        throw new Error("injected index crash");
      return indexWrite(body);
    };
    await assert.rejects(
      current.transaction(
        (tx) =>
          tx.put("messages/restart", {
            messageId: count + 10,
            conversationId: 1,
            content: "RESTART_REPAIR quartz",
            createdAt: new Date(),
          }),
        { token: "repair" }
      )
    );
    current.io.write = indexWrite;
    await step("fresh observer repairs committed index prefix", async () => {
      const fresh = await open({ claimWriter: false });
      assert.equal(
        (
          await fresh.search({
            table: "messages",
            query: "RESTART_REPAIR",
            mode: "full_text",
          })
        ).length,
        1
      );
      const head = await fresh.head();
      assert.equal(head.revision, head.indexedRevision);
      const view = await fresh.snapshot();
      assert.deepEqual(await view.get("context/1/0"), { summaryId: "winner" });
      assert.equal(await view.get("edges/winner/0"), 0);
    });
    await step("separate agent namespace isolation", async () => {
      const other = await open({ agentId: "synthetic-agent-2" });
      assert.equal(
        (
          await other.search({
            table: "messages",
            query: "CANARY_agent1",
            mode: "full_text",
          })
        ).length,
        0
      );
      await other.transaction((tx) =>
        tx.put("messages/1", {
          messageId: 1,
          conversationId: 1,
          content: "CANARY_agent2 quartz",
          createdAt: new Date(),
        })
      );
      assert.equal(
        (
          await current.search({
            table: "messages",
            query: "CANARY_agent2",
            mode: "full_text",
          })
        ).length,
        0
      );
    });
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.error = error instanceof Error ? error.message : "probe failed";
    throw error;
  } finally {
    for (const namespace of new Set(namespaces)) {
      try {
        assert.ok(namespace.startsWith(prefix + "-"));
        const io = new NativeHttpIo({ apiKey, region, namespace });
        await io.client.request("DELETE", "");
        evidence.cleanup.push({ namespace, deleted: true });
        clients.push(io.client);
      } catch {
        evidence.cleanup.push({ namespace, deleted: false });
      }
    }
    evidence.requests = clients.flatMap((c) =>
      c.metrics.map((m) => ({ namespace: c.namespace, ...m }))
    );
    evidence.totals = {
      requests: evidence.requests.length,
      requestBytes: evidence.requests.reduce((n, r) => n + r.requestBytes, 0),
      responseBytes: evidence.requests.reduce(
        (n, r) => n + (r.responseBytes ?? 0),
        0
      ),
    };
    evidence.completedAt = new Date().toISOString();
    if (output)
      await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
  return evidence;
}
