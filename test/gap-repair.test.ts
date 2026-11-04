import { mkdtempSync, rmSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createLcmDatabaseConnection,
  closeLcmConnection,
} from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import {
  digest,
  planRepair,
  applyRepair,
  undoRepair,
  type RepairEvidence,
} from "../src/gap-repair.js";

const dirs: string[] = [];
afterEach(() => {
  closeLcmConnection();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "lcm-repair-"));
  dirs.push(dir);
  const path = join(dir, "db.sqlite"),
    db = createLcmDatabaseConnection(path, { maintenance: true });
  runLcmMigrations(db, { fts5Available: true });
  const store = new ConversationStore(db, { fts5Available: true });
  const conv = await store.createConversation({
    sessionId: "epoch",
    sessionKey: "key",
  });
  const cid = conv.conversationId;
  const left = await store.createMessage({
    conversationId: cid,
    seq: 0,
    role: "user",
    content: "left",
    tokenCount: 1,
    transcriptEntryId: "left",
  });
  const right = await store.createMessage({
    conversationId: cid,
    seq: 1,
    role: "assistant",
    content: "right",
    tokenCount: 1,
    transcriptEntryId: "right",
  });
  db.prepare(
    "INSERT INTO conversation_transcript_gaps(conversation_id,first_entry_id,last_entry_id,first_visible_seq,last_visible_seq,entry_count,prev_message_id,next_message_id,source) VALUES(?,?,?,?,?,?,?,?,?)"
  ).run(
    cid,
    "missing",
    "missing",
    2,
    2,
    1,
    left.messageId,
    right.messageId,
    "test"
  );
  db.prepare(
    "INSERT INTO context_items(conversation_id,ordinal,item_type,message_id) VALUES(?,0,'message',?)"
  ).run(cid, left.messageId);
  db.prepare(
    "INSERT INTO context_items(conversation_id,ordinal,item_type,message_id) VALUES(?,1,'message',?)"
  ).run(cid, right.messageId);
  const message: any = {
    role: "user",
    content: "missing exact public text",
    timestamp: "2026-01-01T00:00:00Z",
    idempotencyKey: "host-key",
    __openclaw: { id: "missing", idempotencyKey: "host-key" },
  };
  const evidence: RepairEvidence = {
    conversationId: cid,
    tokenBudget: 128000,
    groups: [
      {
        gapId: 1,
        messages: [message],
        sha256: [digest(message)],
        sourceOrder: {
          namespace: "gateway-public-seq",
          before: { id: "left", seq: 101 },
          after: { id: "right", seq: 103 },
          entries: [{ id: "missing", seq: 102 }],
        },
      },
    ],
  };
  return { db, path, cid, evidence, store };
}
it("excludes repair while any runtime connection lives, and runtime while repair lives", async () => {
  const f = await fixture();
  expect(() => createLcmDatabaseConnection(f.path)).toThrow(/fence/);
  closeLcmConnection(f.db);
  const a = createLcmDatabaseConnection(f.path),
    b = createLcmDatabaseConnection(f.path);
  expect(() =>
    createLcmDatabaseConnection(realpathSync(f.path), { maintenance: true })
  ).toThrow(/fence/);
  a.close();
  expect(() =>
    createLcmDatabaseConnection(f.path, { maintenance: true })
  ).toThrow(/fence/);
  b.close();
  const repair = createLcmDatabaseConnection(f.path, { maintenance: true });
  repair.close();
});
it("atomically inserts, indexes, records replay identity, preserves gap, replays, and undoes", async () => {
  const f = await fixture(),
    plan = planRepair(f.db, f.evidence);
  const original = f.db
    .prepare("SELECT * FROM conversation_transcript_gaps")
    .all();
  expect(await applyRepair(f.db, plan)).toMatchObject({
    inserted: 1,
    replay: false,
  });
  expect(await applyRepair(f.db, plan)).toMatchObject({
    inserted: 1,
    replay: true,
  });
  expect(
    f.db.prepare("SELECT * FROM conversation_transcript_gaps").all()
  ).toEqual(original);
  expect(
    f.db.prepare("SELECT * FROM transcript_user_replay_keys").get()!
      .idempotency_key
  ).toBe("host-key");
  expect(
    f.db
      .prepare("SELECT * FROM messages_fts WHERE messages_fts MATCH 'exact'")
      .all()
  ).toHaveLength(1);
  expect(undoRepair(f.db, plan.id)).toMatchObject({ undone: true });
  expect(planRepair(f.db, f.evidence).before).toBe(plan.before);
  expect(
    f.db
      .prepare(
        "SELECT action FROM transcript_gap_repair_audit ORDER BY event_id"
      )
      .all()
      .map((r) => r.action)
  ).toEqual(["apply", "undo"]);
  expect(f.db.prepare("PRAGMA integrity_check").get()!.integrity_check).toBe(
    "ok"
  );
  expect(f.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
});
it("rolls back injected insert failure including audit schema", async () => {
  const f = await fixture(),
    plan = planRepair(f.db, f.evidence);
  await expect(applyRepair(f.db, plan, 1)).rejects.toThrow(/Injected/);
  expect(planRepair(f.db, f.evidence).before).toEqual(plan.before);
  expect(
    f.db
      .prepare(
        "SELECT * FROM sqlite_master WHERE name='transcript_gap_repair_audit'"
      )
      .all()
  ).toEqual([]);
});
it("refuses stale generation before writes", async () => {
  const f = await fixture(),
    plan = planRepair(f.db, f.evidence);
  f.db.prepare("UPDATE conversations SET session_id='new-generation'").run();
  await expect(applyRepair(f.db, plan)).rejects.toThrow(/Stale/);
  expect(f.db.prepare("SELECT * FROM messages").all()).toHaveLength(2);
});
it("refuses bad hash, duplicate IDs and source endpoints", async () => {
  const f = await fixture();
  const e = structuredClone(f.evidence);
  e.groups[0].sha256[0] = "bad";
  expect(() => planRepair(f.db, e)).toThrow(/hash/);
  const m: any = e.groups[0].messages[0];
  m.__openclaw.id = "left";
  e.groups[0].sourceOrder.entries[0].id = "left";
  e.groups[0].sha256[0] = digest(m);
  expect(() => planRepair(f.db, e)).toThrow(/already stored/);
});
it("refuses undo after affected conversation advances, retains new writes", async () => {
  const f = await fixture(),
    plan = planRepair(f.db, f.evidence);
  await applyRepair(f.db, plan);
  await f.store.createMessage({
    conversationId: f.cid,
    seq: 3,
    role: "assistant",
    content: "later",
    tokenCount: 1,
  });
  expect(() => undoRepair(f.db, plan.id)).toThrow(/Poststate changed/);
  expect(f.db.prepare("SELECT * FROM messages").all()).toHaveLength(4);
});
it("undo preserves writes in other conversations", async () => {
  const f = await fixture(),
    plan = planRepair(f.db, f.evidence);
  await applyRepair(f.db, plan);
  const other = await f.store.createConversation({ sessionId: "other" });
  await f.store.createMessage({
    conversationId: other.conversationId,
    seq: 0,
    role: "user",
    content: "keep me",
    tokenCount: 2,
  });
  undoRepair(f.db, plan.id);
  expect(
    f.db
      .prepare("SELECT content FROM messages WHERE conversation_id=?")
      .get(other.conversationId)!.content
  ).toBe("keep me");
});
it("refuses unleased raw handles", async () => {
  const f = await fixture(),
    plan = planRepair(f.db, f.evidence);
  closeLcmConnection(f.db);
  const raw = new DatabaseSync(f.path);
  try {
    await expect(applyRepair(raw, plan)).rejects.toThrow(/Exclusive/);
  } finally {
    raw.close();
  }
});

it("expands crossing summaries without rewriting any summary evidence", async () => {
  const f = await fixture();
  const ids = f.db
    .prepare("SELECT message_id FROM messages ORDER BY seq")
    .all()
    .map((r) => r.message_id);
  f.db.exec(
    `INSERT INTO summaries(summary_id,conversation_id,kind,depth,content,token_count) VALUES('crossing',${f.cid},'leaf',0,'historical summary',4)`
  );
  ids.forEach((id, n) =>
    f.db
      .prepare(
        "INSERT INTO summary_messages(summary_id,message_id,ordinal) VALUES('crossing',?,?)"
      )
      .run(id, n)
  );
  f.db.exec(
    `DELETE FROM context_items; INSERT INTO context_items(conversation_id,ordinal,item_type,summary_id) VALUES(${f.cid},0,'summary','crossing')`
  );
  const sums = f.db.prepare("SELECT * FROM summaries").all(),
    links = f.db.prepare("SELECT * FROM summary_messages").all();
  const plan = planRepair(f.db, f.evidence);
  await applyRepair(f.db, plan);
  expect(
    f.db
      .prepare("SELECT item_type FROM context_items")
      .all()
      .map((r) => r.item_type)
  ).toEqual(["message", "message", "message"]);
  expect(f.db.prepare("SELECT * FROM summaries").all()).toEqual(sums);
  expect(f.db.prepare("SELECT * FROM summary_messages").all()).toEqual(links);
  undoRepair(f.db, plan.id);
  expect(
    f.db.prepare("SELECT summary_id FROM context_items").get()!.summary_id
  ).toBe("crossing");
});
it("rejects incomplete frontier rather than silently redefining active coverage", async () => {
  const f = await fixture();
  f.db.exec("DELETE FROM context_items WHERE ordinal=0");
  expect(() => planRepair(f.db, f.evidence)).toThrow(/Frontier/);
});
it("rejects source order corruption and stable-event aliases", async () => {
  const f = await fixture(),
    g = f.evidence.groups[0];
  g.sourceOrder.entries[0].seq = 104;
  expect(() => planRepair(f.db, f.evidence)).toThrow(/source order/);
  g.sourceOrder.entries[0].seq = 102;
  const m: any = g.messages[0];
  m.role = "assistant";
  m.responseId = "collision";
  g.sha256[0] = digest(m);
  f.db
    .prepare(
      "UPDATE messages SET stable_event_key='response:collision' WHERE seq=0"
    )
    .run();
  // The extractor's actual key is used rather than relying on a guessed prefix.
  const { extractStableEventKey } = await import("../src/stable-event-key.js");
  const key = extractStableEventKey(m);
  expect(key).toBeTruthy();
  f.db.prepare("UPDATE messages SET stable_event_key=? WHERE seq=0").run(key);
  expect(() => planRepair(f.db, f.evidence)).toThrow(/collision/);
});
it("detects cyclic summary evidence", async () => {
  const f = await fixture();
  f.db.exec(
    `INSERT INTO summaries(summary_id,conversation_id,kind,depth,content,token_count) VALUES('cycle',${f.cid},'condensed',1,'bad cycle',1); INSERT INTO summary_parents(summary_id,parent_summary_id,ordinal) VALUES('cycle','cycle',0)`
  );
  expect(() => planRepair(f.db, f.evidence)).toThrow(/cycle/);
});

it("enforces leases across processes and releases automatically on owner crash", async () => {
  const f = await fixture();
  closeLcmConnection(f.db);
  const { build } = await import("esbuild");
  const { spawn, spawnSync } = await import("node:child_process");
  const bundle = join(dirs.at(-1)!, "fence.mjs");
  await build({
    entryPoints: ["src/db/maintenance-fence.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: bundle,
  });
  const code = `import {acquireDatabaseLease} from ${JSON.stringify(
    "file://" + bundle
  )}; acquireDatabaseLease(process.argv[1]); console.log('held'); setInterval(()=>{},10000);`;
  const child = spawn(
    process.execPath,
    ["--input-type=module", "-e", code, f.path],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once("data", () => resolve());
      child.once("exit", () => reject(Error("Child failed to lease")));
    });
    expect(() =>
      createLcmDatabaseConnection(f.path, { maintenance: true })
    ).toThrow(/fence/);
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGKILL");
    await exited;
    const exclusive = createLcmDatabaseConnection(f.path, {
      maintenance: true,
    });
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `import {acquireDatabaseLease} from ${JSON.stringify(
        "file://" + bundle
      )}; acquireDatabaseLease(process.argv[1]);`,
      f.path,
    ]);
    expect(probe.status).not.toBe(0);
    exclusive.close();
    createLcmDatabaseConnection(f.path, { maintenance: true }).close();
  } finally {
    child.kill("SIGKILL");
  }
});

it("rolls back if the repaired frontier would require budget selection", async () => {
  const f = await fixture();
  f.evidence.tokenBudget = 1;
  const plan = planRepair(f.db, f.evidence);
  await expect(applyRepair(f.db, plan)).rejects.toThrow(/budget/);
  expect(planRepair(f.db, f.evidence).before).toBe(plan.before);
});

it("restores replay evidence recorded before the raw message existed, and sparse frontier ordinals", async () => {
  const f = await fixture();
  f.db
    .prepare(
      "INSERT INTO transcript_user_replay_keys(conversation_id,transcript_entry_id,idempotency_key,entry_signature,updated_at) VALUES(?,'missing','previous-key','previous-signature','2025-01-01')"
    )
    .run(f.cid);
  f.db.exec("UPDATE context_items SET ordinal=ordinal+17");
  const before = f.db
    .prepare("SELECT * FROM transcript_user_replay_keys")
    .all();
  const plan = planRepair(f.db, f.evidence);
  await applyRepair(f.db, plan);
  undoRepair(f.db, plan.id);
  expect(
    f.db.prepare("SELECT * FROM transcript_user_replay_keys").all()
  ).toEqual(before);
  expect(planRepair(f.db, f.evidence).before).toBe(plan.before);
});
it("fresh native engine replays repaired public fixtures and appends without duplicates", async () => {
  const f = await fixture(),
    plan = planRepair(f.db, f.evidence);
  await applyRepair(f.db, plan);
  closeLcmConnection(f.db);
  const { FakeTranscriptHost } = await import(
    "./transcript-delta-fake-host.js"
  );
  const { createTestConfig, createTestDeps, TestLcmContextEngine } =
    await import("./helpers.js");
  const host = new FakeTranscriptHost("epoch");
  host.append({ role: "user", content: "left" } as any, { entryId: "left" });
  host.append(f.evidence.groups[0].messages[0], { entryId: "missing" });
  host.append({ role: "assistant", content: "right" } as any, {
    entryId: "right",
  });
  const db = createLcmDatabaseConnection(f.path);
  const config = createTestConfig(f.path);
  const deps = createTestDeps(config, {
    readSessionTranscriptVisibleMessageDelta: host.readVisibleDelta,
    readSessionTranscriptRawDelta: host.readRawDelta,
    readVisibleSessionTranscriptMessageEntries: host.readVisibleEntries,
  });
  const engine = new TestLcmContextEngine(deps, db);
  const params = {
    sessionId: "epoch",
    sessionKey: "key",
    sessionTarget: { agentId: "main", sessionId: "epoch", sessionKey: "key" },
  };
  await engine.bootstrap(params);
  await engine.bootstrap(params);
  expect(
    db.prepare("SELECT * FROM messages WHERE conversation_id=?").all(f.cid)
  ).toHaveLength(3);
  host.append({ role: "user", content: "new post-repair append" } as any, {
    entryId: "later-native",
  });
  await engine.bootstrap(params);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM messages WHERE transcript_entry_id='missing'"
      )
      .get()!.n
  ).toBe(1);
  expect(
    db
      .prepare(
        "SELECT count(*) AS n FROM messages WHERE transcript_entry_id='later-native'"
      )
      .get()!.n
  ).toBe(1);
  expect(() =>
    createLcmDatabaseConnection(f.path, { maintenance: true })
  ).toThrow(/fence/);
});
