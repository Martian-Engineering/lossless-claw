// Paired synthetic comparison. The other fork is consumed read-only.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { DatabaseSync } from "node:sqlite"; // SQLite baseline only, never native storage.
import {
  NativeDatabase,
  NativeConversationStore,
  NativeSummaryStore,
  NativeHttpIo,
  ContextAssembler,
  CompactionEngine,
  importCanonicalTables,
} from "../../dist/experimental/turbopuffer-native.js";
const hash = (x) => createHash("sha256").update(x).digest("hex");
export async function compare({
  apiKey,
  manifestPath,
  postgresPath,
  output,
  clientLocation,
  focused = false,
}) {
  const manifest = JSON.parse(await readFile(manifestPath)),
    raw = await readFile(manifest.fixturePath);
  assert.equal(hash(raw), manifest.sha256);
  const fixture = JSON.parse(raw);
  assert.equal(fixture.seed, 20261104);
  const load = (file) =>
      import(pathToFileURL(path.join(postgresPath, file)).href),
    modules = await load(".generated/upstream.mjs"),
    dbm = await load("database.mjs"),
    transfer = await load("transfer.mjs"),
    adapter = await load("upstream-adapter.mjs"),
    { PostgresStore } = await load("store.mjs");
  const provenance = JSON.parse(
    await readFile(path.join(postgresPath, ".generated/provenance.json"))
  );
  assert.equal(provenance.commit, "51c3c90bfe82fa649e4895dd1a2c4874b5e28f76");
  const prefix = `lcm-n-${randomUUID()}`,
    region = "aws-us-east-1",
    pool = dbm.createPool(),
    pgdb = new dbm.Database(pool),
    clients = [],
    namespaces = [],
    sqlites = [];
  const evidence = {
    recordedAt: new Date().toISOString(),
    fixtureSha256: manifest.sha256,
    fixtureBytes: raw.length,
    seed: fixture.seed,
    fixtureCounts: manifest.counts,
    source: provenance,
    postgresSource: "1eebd7e273716799c6ffbbdf78bb1dd5b913f1b0",
    clientLocation,
    region,
    concurrency: 1,
    focused,
    results: [],
    assertions: {},
    cleanup: [],
    notes: [
      "SQLite and PostgreSQL run on the client machine; Turbopuffer is remote HTTPS. This is not a distributed PostgreSQL service comparison.",
      "Native storage contains the selected agent six conversations; the PostgreSQL fixture contains both organizations and all six agents, accessed through its tenant/agent indexes.",
      "No inference in retrieval. Compaction uses one deterministic fake summary callback at the inference boundary; recorded inferenceMs is excluded from dbAndAlgorithmMs.",
      "Small sample counts are experimental evidence, not capacity or production readiness.",
    ],
  };
  const count = () => clients.reduce((n, c) => n + c.totalRequests, 0);
  const measure = async (name, run, n = 5, expected) => {
    if (
      focused &&
      ![
        "native-fixture-import-1200-messages-plus-graph",
        "postgres-batched-full-assembly",
        "native-first-full-assembly",
        "native-warm-full-assembly",
        "native-fresh-client-full-assembly",
        "postgres-real-leaf-compaction",
        "native-real-leaf-compaction",
      ].includes(name)
    )
      return;
    if (focused) n = Math.min(n, 3);
    const samples = [];
    for (let i = 0; i < n; i++) {
      const start = performance.now(),
        rounds = count(),
        pgRounds = pgdb.roundTrips;
      const result = await run(i);
      if (expected !== undefined) assert.deepEqual(result, expected);
      samples.push({
        ms: performance.now() - start,
        httpRoundTrips: count() - rounds,
        pgRoundTrips: pgdb.roundTrips - pgRounds,
        resultBytes: Buffer.byteLength(JSON.stringify(result) ?? "null"),
        ...(result && typeof result.inferenceMs === "number"
          ? {
              inferenceMs: result.inferenceMs,
              inferenceCalls: result.inferenceCalls,
              dbAndAlgorithmMs: result.dbAndAlgorithmMs,
            }
          : {}),
      });
    }
    const sorted = samples.map((r) => r.ms).sort((a, b) => a - b);
    evidence.results.push({
      operation: name,
      count: n,
      p50Ms: sorted[Math.ceil(n * 0.5) - 1],
      p95Ms: sorted[Math.ceil(n * 0.95) - 1],
      maxMs: sorted.at(-1),
      samples,
    });
    console.log(name, sorted[Math.ceil(n * 0.5) - 1].toFixed(2) + " ms p50");
  };
  const selected = (org, agent) => {
    const cids = new Set(
        Object.entries(org.authority)
          .filter(([, value]) => value === agent)
          .map(([id]) => Number(id))
      ),
      mids = new Set(
        org.tables.messages
          .filter((r) => cids.has(r.conversation_id))
          .map((r) => r.message_id)
      ),
      sids = new Set(
        org.tables.summaries
          .filter((r) => cids.has(r.conversation_id))
          .map((r) => r.summary_id)
      );
    return Object.fromEntries(
      Object.entries(org.tables)
        .filter(([name]) => name !== "lcm_migration_state")
        .map(([name, rows]) => [
          name,
          rows.filter((r) =>
            r.conversation_id !== undefined
              ? cids.has(r.conversation_id)
              : r.message_id !== undefined
              ? mids.has(r.message_id)
              : r.summary_id !== undefined
              ? sids.has(r.summary_id)
              : false
          ),
        ])
    );
  };
  const open = async (extra = {}) => {
    const db = await NativeDatabase.open({
      organizationId: "org1",
      agentId: "agent1",
      namespacePrefix: prefix,
      region,
      apiKey,
      ...extra,
    });
    clients.push(db.io.client);
    namespaces.push(db.namespace);
    return db;
  };
  try {
    await dbm.migrate(pgdb);
    await transfer.importFixture(pgdb, fixture, manifest.sha256);
    for (const name of [
      "conversations",
      "messages",
      "summaries",
      "context_items",
      "summary_messages",
      "summary_parents",
      "auxiliary_rows",
      "large_files",
    ])
      await pgdb.query(`ANALYZE lcm_experiment.${name}`);
    const pg = new PostgresStore(pgdb, {
        organizationId: "org1",
        agentId: "agent1",
      }),
      data = selected(fixture.organizations[0], "agent1"),
      sqlite = new DatabaseSync(":memory:");
    sqlites.push(sqlite);
    modules.runLcmMigrations(sqlite, { fts5Available: true });
    sqlite.exec("PRAGMA foreign_keys=OFF; BEGIN");
    for (const [name, rows] of Object.entries(data))
      for (const row of rows) {
        const columns = Object.keys(row);
        sqlite
          .prepare(
            `INSERT INTO "${name}"(${columns
              .map((c) => `"${c}"`)
              .join(",")}) VALUES(${columns.map(() => "?").join(",")})`
          )
          .run(...columns.map((c) => row[c]));
      }
    sqlite.exec(
      "INSERT INTO messages_fts(rowid,content) SELECT message_id,content FROM messages; INSERT INTO summaries_fts(summary_id,content) SELECT summary_id,content FROM summaries; COMMIT; PRAGMA foreign_keys=ON"
    );
    const baselineC = new modules.ConversationStore(sqlite),
      baselineS = new modules.SummaryStore(sqlite),
      baselineA = new modules.ContextAssembler(baselineC, baselineS, "UTC");
    const db = await open();
    await measure(
      "native-fixture-import-1200-messages-plus-graph",
      async () => {
        await importCanonicalTables(db, data);
        return {
          counts: Object.fromEntries(
            Object.entries(data).map(([name, rows]) => [name, rows.length])
          ),
        };
      },
      1
    );
    const c = new NativeConversationStore(db),
      s = new NativeSummaryStore(db),
      a = new ContextAssembler(c, s, "UTC"),
      input = {
        conversationId: 1,
        tokenBudget: 16000,
        freshTailCount: 80,
        freshTailMaxTokens: 65536,
      };
    const expected = await baselineA.assemble(input);
    evidence.assemblyOutputSha256 = hash(JSON.stringify(expected));
    await measure("sqlite-context-metadata", () =>
      baselineS.getContextItems(1)
    );
    await measure("postgres-context-metadata", () => pg.getContextItems(1));
    await measure("native-context-metadata", () => s.getContextItems(1));
    const tail = await baselineC.getLastMessages(1, 80);
    await measure(
      "sqlite-tail-80",
      () => baselineC.getLastMessages(1, 80),
      5,
      tail
    );
    await measure(
      "postgres-tail-80-256KiB",
      () => pg.recentTail(1, 80, 256 * 1024),
      5,
      tail
    );
    await measure(
      "native-tail-80-256KiB",
      () => c.recentTail(1, 80, 256 * 1024),
      5,
      tail
    );
    await measure(
      "sqlite-full-assembly",
      () => baselineA.assemble(input),
      5,
      expected
    );
    await measure(
      "postgres-batched-full-assembly",
      () => adapter.batchedUpstreamAssembler(pg).assemble(input),
      5,
      expected
    );
    await measure(
      "native-first-full-assembly",
      () => a.assemble(input),
      1,
      expected
    );
    await measure(
      "native-warm-full-assembly",
      () => a.assemble(input),
      5,
      expected
    );
    await measure(
      "native-fresh-client-full-assembly",
      async () => {
        const observer = await open({ claimWriter: false });
        return new ContextAssembler(
          new NativeConversationStore(observer),
          new NativeSummaryStore(observer),
          "UTC"
        ).assemble(input);
      },
      3,
      expected
    );
    if (!focused) {
      const fts = {
        conversationId: 1,
        query: "quartz",
        mode: "full_text",
        limit: 20,
      };
      await measure("sqlite-message-fts", () => baselineC.searchMessages(fts));
      await measure("postgres-message-fts", () => pg.searchMessages(fts));
      await measure("native-message-fts", () => c.searchMessages(fts));
      const expectedIds = (await baselineC.searchMessages(fts)).map(
        (r) => r.messageId
      );
      assert.deepEqual(
        (await c.searchMessages(fts)).map((r) => r.messageId),
        expectedIds
      );
      evidence.assertions.recencySearchIdsMatchSQLite = true;
      await measure(
        "native-hybrid-fts",
        () => c.searchMessages({ ...fts, sort: "hybrid" }),
        3
      );
      const summary = "sum_org1-agent1-thread1_depth2_0";
      const expand = async (store) => {
        const seen = new Set(),
          messages = new Set(),
          stack = [summary];
        while (stack.length) {
          const id = stack.pop();
          if (seen.has(id)) continue;
          seen.add(id);
          for (const mid of await store.getSummaryMessages(id))
            messages.add(mid);
          for (const source of await store.getSummaryParents(id))
            stack.push(source.summaryId);
        }
        return {
          summaries: seen.size,
          messageIds: [...messages].sort((a, b) => a - b),
        };
      };
      const graph = await expand(baselineS);
      assert.ok(graph.messageIds.length > 0);
      await measure(
        "sqlite-source-dag-expansion",
        () => expand(baselineS),
        5,
        graph
      );
      await measure(
        "postgres-source-dag-expansion",
        () => expand(pg),
        5,
        graph
      );
      await measure(
        "native-source-dag-expansion",
        () => db.read(() => expand(s)),
        5,
        graph
      );
      // Equivalent atomic append + active-context mutation + idempotent receipt.
      const turns = new Map();
      for (const backend of ["postgres", "native"]) {
        await measure(
          `${backend}-ingest-two-messages-and-context`,
          async (i) => {
            const cid = i + 4,
              messages = [
                {
                  role: "user",
                  content: `paired user ${cid}`,
                  tokenCount: 10,
                  transcriptEntryId: `paired-${cid}-u`,
                },
                {
                  role: "assistant",
                  content: `paired assistant ${cid}`,
                  tokenCount: 10,
                  transcriptEntryId: `paired-${cid}-a`,
                },
              ];
            const revision =
              backend === "postgres" ? await pg.revision(cid) : undefined;
            const run = () =>
              backend === "postgres"
                ? pg.commitTurn({
                    conversationId: cid,
                    expectedRevision: revision,
                    receiptKey: `paired-${cid}`,
                    messages,
                  })
                : db.transaction(
                    async () => {
                      const seq = await c.getMaxSeq(cid),
                        created = await c.createMessagesBulk(
                          messages.map((message, i) => ({
                            ...message,
                            conversationId: cid,
                            seq: seq + i + 1,
                          }))
                        );
                      await s.appendContextMessages(
                        cid,
                        created.map((row) => row.messageId)
                      );
                      return created.map((row) => row.messageId);
                    },
                    { token: `paired-${cid}`, input: { cid, messages } }
                  );
            turns.set(`${backend}/${cid}`, run);
            return run();
          },
          3
        );
        await measure(
          `${backend}-deduplicated-turn-receipt`,
          (i) => turns.get(`${backend}/${i + 4}`)(),
          3
        );
      }
      for (const cid of [4, 5, 6]) {
        assert.equal(await c.getMessageCount(cid), 202);
        assert.equal(await pg.getMessageCount(cid), 202);
      }
      evidence.assertions.idempotentAppendRetains202Messages = true;
      const concurrent = async (backend) => {
        const samples = await Promise.all(
          [4, 5, 6].map(async (cid) => {
            const started = performance.now(),
              message = {
                role: "assistant",
                content: `concurrent ${cid}`,
                tokenCount: 10,
                transcriptEntryId: `concurrent-${cid}`,
              };
            if (backend === "postgres")
              await pg.commitTurn({
                conversationId: cid,
                expectedRevision: await pg.revision(cid),
                receiptKey: `concurrent-${cid}`,
                messages: [message],
              });
            else
              await db.transaction(
                async () => {
                  const row = await c.createMessage({
                    ...message,
                    conversationId: cid,
                    seq: (await c.getMaxSeq(cid)) + 1,
                  });
                  await s.appendContextMessage(cid, row.messageId);
                },
                { token: `concurrent-${cid}`, input: cid }
              );
            return { cid, ms: performance.now() - started };
          })
        );
        return { concurrency: 3, samples };
      };
      for (const backend of ["postgres", "native"])
        await measure(
          `${backend}-three-concurrent-conversations`,
          async () => {
            const result = await concurrent(backend);
            evidence[`${backend}Concurrent`] = result;
            return result;
          },
          1
        );
      for (const cid of [4, 5, 6]) {
        assert.equal(await c.getMessageCount(cid), 203);
        assert.equal(await pg.getMessageCount(cid), 203);
      }
    }
    // Only engine-compaction calls use fake inference; the graph/context commit is real I/O.
    for (const backend of ["postgres", "native"])
      await measure(
        `${backend}-real-leaf-compaction`,
        async (i) => {
          const cid = i + 1;
          let inferenceMs = 0,
            calls = 0;
          const summarize = async () => {
            const start = performance.now();
            calls++;
            const result = "Deterministic native comparison summary.";
            inferenceMs += performance.now() - start;
            return result;
          };
          const compactor =
            backend === "postgres"
              ? adapter.batchedUpstreamCompactor(
                  pg,
                  cid,
                  adapter.compactionConfig
                )
              : new CompactionEngine(c, s, adapter.compactionConfig);
          const start = performance.now(),
            result = await compactor.compactLeaf({
              conversationId: cid,
              tokenBudget: 2000,
              force: true,
              summarize,
            });
          assert.ok(result.actionTaken);
          return {
            result,
            inferenceMs,
            inferenceCalls: calls,
            dbAndAlgorithmMs: performance.now() - start - inferenceMs,
          };
        },
        3
      );
    assert.equal(await c.getMessageCount(1), 200);
    evidence.assertions.compactionRetainsAllMessages = true;
    const other = await open({ agentId: "agent2" });
    assert.equal(
      (
        await new NativeConversationStore(other).searchMessages({
          query: "canaryORG1AGENT1",
          mode: "full_text",
        })
      ).length,
      0
    );
    evidence.assertions.otherAgentCannotRecall = true;
    const otherOrg = await open({ organizationId: "org2" });
    assert.equal(
      (
        await new NativeConversationStore(otherOrg).searchMessages({
          query: "canaryORG1AGENT1",
          mode: "full_text",
        })
      ).length,
      0
    );
    evidence.assertions.otherOrganizationCannotRecall = true;
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false;
    evidence.error =
      error instanceof Error ? error.message : "comparison failed";
    throw error;
  } finally {
    for (const namespace of new Set(namespaces)) {
      try {
        assert.ok(namespace.startsWith(prefix + "-"));
        const io = new NativeHttpIo({ apiKey, namespace, region });
        await io.client.request("DELETE", "");
        evidence.cleanup.push({ namespace, deleted: true });
        clients.push(io.client);
      } catch {
        evidence.cleanup.push({ namespace, deleted: false });
      }
    }
    for (const db of sqlites) db.close();
    await pool.end();
    evidence.requests = clients.flatMap((c) =>
      c.metrics.map((m) => ({ namespace: c.namespace, ...m }))
    );
    evidence.droppedMetrics = clients.reduce((n, c) => n + c.droppedMetrics, 0);
    evidence.completedAt = new Date().toISOString();
    if (output)
      await writeFile(output, JSON.stringify(evidence, null, 2) + "\n");
  }
  return evidence;
}
