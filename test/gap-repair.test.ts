import { mkdtempSync, rmSync, realpathSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, afterEach, expect, it } from "vitest";
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

// Online command tests use only disposable SQLite fixtures and fake host readers.
import { GapRepairController } from "../src/plugin/lcm-gap-repair.js";
import { publishGapRecovery } from "../src/plugin/lcm-gap-publish.js";
import { SessionMaintenanceGate } from "../src/session-maintenance.js";
import { createTestConfig, createTestDeps } from "./helpers.js";
import { createLcmCommand } from "../src/plugin/lcm-command.js";
import { withOnlineRepairOwnership } from "../src/db/connection.js";

let workerUrl: URL;
let workerDirectory: string;
beforeAll(async () => {
  const { build } = await import("esbuild");
  const { pathToFileURL } = await import("node:url");
  workerDirectory = mkdtempSync(join(tmpdir(), "gap-worker-test-"));
  const path = join(workerDirectory, "worker.mjs");
  await build({ entryPoints: ["src/plugin/lcm-gap-prepare.ts"], outfile: path, platform: "node", format: "esm", bundle: true });
  workerUrl = pathToFileURL(path);
});
afterAll(() => { if (workerDirectory) rmSync(workerDirectory, { recursive: true, force: true }); });
const invoking = { isAuthorizedSender: true, senderId: "owner", sessionKey: "control", sessionId: "controller" };
async function onlineFixture() {
  const f = await fixture();
  f.db.close();
  const db = createLcmDatabaseConnection(f.path);
  const config = createTestConfig(f.path, { freshTailCount: 1, freshTailMaxTokens: 100, leafMinFanout: 1 });
  const entries: any[] = [
    { entryId: "left", seq: 101, role: "user", message: { role: "user", content: "left" } },
    { entryId: "missing", seq: 102, role: "user", message: f.evidence.groups[0].messages[0] },
    { entryId: "right", seq: 103, role: "assistant", message: { role: "assistant", content: "right" } },
  ];
  const deps = createTestDeps(config, {
    readVisibleSessionTranscriptMessageEntries: async () => structuredClone(entries),
    readSessionTranscriptVisibleMessageDelta: async () => ({ kind: "page", entries: structuredClone(entries), cursor: "frozen", hasMore: false, serializedBytes: JSON.stringify(entries).length }),
  });
  const runtime = { getGapRepairBudget: () => 128000 };
  const controller = new GapRepairController({ workerUrl, db: async () => db, config, deps, runtime: async () => runtime });
  return { ...f, db, config, entries, deps, runtime, controller };
}
function previewToken(text: string) {
  const match = text.match(/doctor apply gaps \d+ ([a-f0-9]{12})/);
  expect(match, text).not.toBeNull(); return match![1];
}
it("repairs entirely through cross-session doctor commands, retains backup, raw evidence, markers and audit", async () => {
  const f = await onlineFixture();
  const command = createLcmCommand({ gapRepairWorkerUrl: workerUrl, db: f.db, config: f.config, deps: f.deps, getLcm: async () => f.runtime });
  const preview = await command.handler({ ...invoking, args: `doctor gaps ${f.cid}` });
  const token = previewToken(preview.text);
  const result = await command.handler({ ...invoking, args: `doctor apply gaps ${f.cid} ${token}` });
  expect(result.text).toContain("recovered 1 messages");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(3);
  expect(f.db.prepare("SELECT count(*) AS n FROM conversation_transcript_gaps").get()?.n).toBe(1);
  expect(f.db.prepare("SELECT disposition FROM conversation_gap_recovery_audit").get()?.disposition).toBe("exact-host-visible-span-recovered");
  const backupPath = (f.db.prepare("SELECT backup_path FROM conversation_gap_recovery_audit").get() as any).backup_path;
  expect(statSync(dirname(backupPath)).mode & 0o777).toBe(0o700);
  const savedPlan = JSON.parse(readFileSync(join(dirname(backupPath), "plan.json"), "utf8"));
  expect(digest(savedPlan.evidence)).toBe(f.db.prepare("SELECT source_hash FROM conversation_gap_recovery_audit").get()?.source_hash);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try { expect(backup.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2); } finally { backup.close(); }
  expect((await command.handler({ ...invoking, args: `doctor apply gaps ${f.cid} ${token}` })).text).toContain("Preview missing");
  expect((await command.handler({ ...invoking, args: `doctor gaps ${f.cid}` })).text).toContain("no exact recoverable spans");
});
it("refuses same-session (including shared keys), unauthorized and unidentifiable invocation", async () => {
  const f = await onlineFixture();
  expect(await f.controller.run({ ...invoking, sessionKey: "key" }, f.cid)).toContain("another session");
  expect(await f.controller.run({ ...invoking, sessionId: "epoch" }, f.cid)).toContain("another session");
  expect(await f.controller.run({ ...invoking, isAuthorizedSender: false }, f.cid)).toContain("authorized sender");
  expect(await f.controller.run({ ...invoking, senderId: undefined }, f.cid)).toContain("authorized sender");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2);
});
it("binds previews to target, sender and invoking session, and rejects stale target state", async () => {
  const f = await onlineFixture(); const token = previewToken(await f.controller.run(invoking, f.cid));
  expect(await f.controller.run({ ...invoking, senderId: "other" }, f.cid, token)).toContain("Preview missing");
  expect(await f.controller.run({ ...invoking, sessionKey: "elsewhere" }, f.cid, token)).toContain("Preview missing");
  f.db.prepare("UPDATE messages SET content='new' WHERE seq=1").run();
  expect(await f.controller.run(invoking, f.cid, token)).toContain("Visible source changed");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2);
});
it("refuses changed source payloads and missing boundary anchors without partial recovery", async () => {
  const f = await onlineFixture(); const token = previewToken(await f.controller.run(invoking, f.cid));
  f.entries[1].message.content = "changed";
  expect(await f.controller.run(invoking, f.cid, token)).toContain("Visible source changed");
  f.entries.shift();
  expect(await f.controller.run(invoking, f.cid)).toContain("1 unresolved");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2);
});
it("a session maintenance writer waits for the admitted turn, queues new work, and leaves other sessions usable", async () => {
  const gate = new SessionMaintenanceGate();
  await gate.operation("target", async () => {}, "begin");
  const events: string[] = [];
  let release!: () => void; const hold = new Promise<void>(r => { release = r; });
  const writer = gate.exclusive("target", async () => { events.push("repair"); await hold; });
  await gate.operation("other", async () => { events.push("other"); });
  expect(events).toEqual(["other"]);
  await gate.operation("target", async () => { events.push("turn-end"); }, "end");
  await new Promise(r => setImmediate(r));
  const queued = gate.operation("target", async () => { events.push("next"); }, "begin");
  await new Promise(r => setImmediate(r));
  expect(events).toEqual(["other", "turn-end", "repair"]);
  release(); await writer; await queued;
  expect(events.at(-1)).toBe("next");
});
it("a busy-target timeout and a repair failure always release admission", async () => {
  const gate = new SessionMaintenanceGate();
  await gate.operation("target", async () => {}, "begin");
  await expect(gate.exclusive("target", async () => {}, 5)).rejects.toThrow(/busy/);
  await gate.operation("target", async () => {}, "end");
  await expect(gate.exclusive("target", async () => { throw Error("failure"); })).rejects.toThrow("failure");
  expect(await gate.operation("target", async () => "resumed")).toBe("resumed");
});
it("online ownership excludes other connections only during recovery and refuses an extra local owner", async () => {
  const f = await onlineFixture();
  await withOnlineRepairOwnership(f.db, async () => { expect(() => createLcmDatabaseConnection(f.path)).toThrow(/fence/); });
  const another = createLcmDatabaseConnection(f.path);
  await expect(withOnlineRepairOwnership(f.db, async () => {})).rejects.toThrow(/one participating/);
  another.close();
  await withOnlineRepairOwnership(f.db, async () => {});
});
it("publication rebases inserted IDs around unrelated writes and preserves all unrelated rows", async () => {
  const f = await fixture();
  const stagePath = join(dirname(f.path), "stage.sqlite");
  f.db.exec(`VACUUM INTO '${stagePath}'`);
  const stage = createLcmDatabaseConnection(stagePath, { maintenance: true });
  const plan = planRepair(f.db, f.evidence);
  await applyRepair(stage, plan);
  const other = await f.store.createConversation({ sessionId: "other", sessionKey: "other" });
  await f.store.createMessage({ conversationId: other.conversationId, seq: 0, role: "user", content: "unrelated", tokenCount: 1 });
  const before = f.db.prepare("SELECT * FROM messages WHERE conversation_id=?").all(other.conversationId);
  expect(publishGapRecovery(f.db, stage, plan, "fixture-backup").inserted).toBe(1);
  expect(f.db.prepare("SELECT * FROM messages WHERE conversation_id=?").all(other.conversationId)).toEqual(before);
  expect(f.db.prepare("SELECT content FROM messages WHERE conversation_id=? ORDER BY seq").all(f.cid).map(r => r.content)).toEqual(["left", "missing exact public text", "right"]);
});
it("publication fails closed and rolls back if preparation alters original raw evidence", async () => {
  const f = await fixture(); const stagePath = join(dirname(f.path), "stage.sqlite");
  f.db.exec(`VACUUM INTO '${stagePath}'`); const stage = createLcmDatabaseConnection(stagePath, { maintenance: true });
  const plan = planRepair(f.db, f.evidence); await applyRepair(stage, plan);
  stage.prepare("UPDATE messages SET content='bad' WHERE transcript_entry_id='left'").run();
  expect(() => publishGapRecovery(f.db, stage, plan, "backup")).toThrow(/raw history/);
  expect(planRepair(f.db, f.evidence).before).toBe(plan.before);
});
it("does not publish if backup creation fails, and releases the target lock", async () => {
  const f = await onlineFixture(); const token = previewToken(await f.controller.run(invoking, f.cid));
  // A live transaction is not a safe VACUUM/backup boundary.
  f.db.exec("BEGIN IMMEDIATE");
  const failed = await f.controller.run(invoking, f.cid, token);
  f.db.exec("ROLLBACK");
  expect(failed).toContain("no recovery was published");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2);
  const retry = previewToken(await f.controller.run(invoking, f.cid));
  expect(await f.controller.run(invoking, f.cid, retry)).toContain("recovered 1 messages");
});
it("rebuilds an over-budget recovery on the isolated copy rather than requiring user compaction", async () => {
  const f = await onlineFixture();
  f.entries[1].message.content = "recovery evidence ".repeat(2500);
  const store = new ConversationStore(f.db, { fts5Available: true });
  const tail = await store.createMessage({ conversationId: f.cid, seq: 2, role: "user", content: "new current turn", tokenCount: 4, transcriptEntryId: "tail" });
  f.db.prepare("INSERT INTO context_items(conversation_id,ordinal,item_type,message_id) VALUES(?,2,'message',?)").run(f.cid, tail.messageId);
  f.entries.push({ entryId: "tail", seq: 104, role: "user", message: { role: "user", content: "new current turn" } });
  const originalCount = f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n;
  let calls = 0;
  const controller = new GapRepairController({ workerUrl, db: async () => f.db, config: f.config, deps: f.deps,
    runtime: async () => ({ getGapRepairBudget: () => 2000 }),
    summarize: async () => async () => {
      calls++;
      // No partial recovered messages or summaries are visible to live readers.
      expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(originalCount);
      expect(f.db.prepare("SELECT count(*) AS n FROM summaries").get()?.n).toBe(0);
      return "A short faithful synthetic summary.";
    },
  });
  const token = previewToken(await controller.run(invoking, f.cid));
  const result = await controller.run(invoking, f.cid, token);
  expect(result).toContain("recovered 1 messages");
  expect(calls).toBeGreaterThan(0);
  expect(f.db.prepare("SELECT count(*) AS n FROM summaries").get()?.n).toBeGreaterThan(0);
  expect(f.db.prepare("SELECT content FROM messages WHERE transcript_entry_id='missing'").get()?.content).toBe(f.entries[1].message.content);
});
it("unsupported native history, absent host budget, malformed arguments and confirmation aliases fail read-only", async () => {
  const f = await onlineFixture();
  const missingBudget = new GapRepairController({ workerUrl, db: async () => f.db, config: f.config, deps: f.deps, runtime: async () => undefined });
  expect(await missingBudget.run(invoking, f.cid)).toContain("No host-observed");
  const controller = new GapRepairController({ workerUrl, db: async () => f.db, config: f.config, deps: { ...f.deps, readVisibleSessionTranscriptMessageEntries: undefined, readSessionTranscriptVisibleMessageDelta: undefined }, runtime: async () => f.runtime });
  expect(await controller.run(invoking, f.cid)).toContain("reader unavailable");
  const command = createLcmCommand({ db: f.db, config: f.config });
  for (const args of ["doctor gaps", "doctor gaps -1", "doctor apply gaps 1 confirm-offline", "doctor gaps 1 extra", "doctor apply gaps 1"]) {
    expect((await command.handler({ ...invoking, args })).text).toContain("preview");
  }
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2);
});
it("expired preview cannot execute", async () => {
  const f = await onlineFixture(); const token = previewToken(await f.controller.run(invoking, f.cid));
  const original = Date.now;
  Date.now = () => original() + 600_001;
  try { expect(await f.controller.run(invoking, f.cid, token)).toContain("Preview missing"); }
  finally { Date.now = original; }
});
it("new assembly cannot jump ahead of a pending repair, even while an older turn drains", async () => {
  const gate = new SessionMaintenanceGate();
  await gate.operation("target", async () => {}, "begin");
  const events: string[] = [];
  const repair = gate.exclusive("target", async () => { events.push("repair"); });
  const next = gate.operation("target", async () => { events.push("next"); }, "begin");
  await new Promise(r => setImmediate(r)); expect(events).toEqual([]);
  await gate.operation("target", async () => {}, "end");
  await repair; await next; expect(events).toEqual(["repair", "next"]);
});
import { LcmContextEngine } from "../src/engine.js";
it("the real engine lifecycle drains before repair and assembles recovered history after unlocking", async () => {
  const f = await onlineFixture();
  const engine = new LcmContextEngine({ ...f.deps, readSessionTranscriptVisibleMessageDelta: undefined }, f.db);
  await engine.assemble({ sessionId: "epoch", sessionKey: "key", messages: [], tokenBudget: 128000 });
  const controller = new GapRepairController({ workerUrl, db: async () => f.db, config: f.config, deps: f.deps, runtime: async () => engine });
  const token = previewToken(await controller.run(invoking, f.cid));
  let complete = false;
  const apply = controller.run(invoking, f.cid, token).then(r => { complete = true; return r; });
  await new Promise(r => setImmediate(r));
  expect(complete).toBe(false);
  await engine.afterTurn({ sessionId: "epoch", sessionKey: "key", messages: [], sessionFile: "", prePromptMessageCount: 0 });
  expect(await apply).toContain("recovered 1 messages");
  const assembled = await engine.assemble({ sessionId: "epoch", sessionKey: "key", messages: [], tokenBudget: 128000 });
  expect(JSON.stringify(assembled.messages)).toContain("missing exact public text");
});
it("source changes during final preparation are refused without exposing provider error content", async () => {
  const f = await onlineFixture();
  let reads = 0;
  const deps = { ...f.deps, readSessionTranscriptVisibleMessageDelta: async () => {
    reads++;
    if (reads >= 3) { const e = structuredClone(f.entries); e[1].message.content = "source moved"; return { kind: "page" as const, entries: e, cursor: "frozen", hasMore: false, serializedBytes: 1000 }; }
    return { kind: "page" as const, entries: structuredClone(f.entries), cursor: "frozen", hasMore: false, serializedBytes: 1000 };
  } };
  const controller = new GapRepairController({ workerUrl, db: async () => f.db, config: f.config, deps, runtime: async () => f.runtime });
  const token = previewToken(await controller.run(invoking, f.cid));
  expect(await controller.run(invoking, f.cid, token)).toContain("Visible source changed");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2);
  const broken = new GapRepairController({ workerUrl, db: async () => f.db, config: f.config,
    deps: { ...f.deps, readSessionTranscriptVisibleMessageDelta: async () => { throw Error("Host visible private clinical text"); } }, runtime: async () => f.runtime });
  const text = await broken.run(invoking, f.cid);
  expect(text).not.toContain("private clinical text");
});
it("repair budgets use the smaller explicit runtime-settings allowance rather than the configured ceiling", async () => {
  const f = await onlineFixture();
  const engine = new LcmContextEngine({ ...f.deps, readSessionTranscriptVisibleMessageDelta: undefined }, f.db);
  await engine.assemble({ sessionId: "epoch", sessionKey: "key", messages: [], tokenBudget: 128000,
    runtimeSettings: { schemaVersion: 1, executionHost: { id: null, label: null }, limits: { promptTokenBudget: 64000 } } });
  expect(engine.getGapRepairBudget("epoch", "key")).toBe(64000);
});
it("generation reset during a paged source read refuses without mixing generations", async () => {
  const f = await onlineFixture(); let calls = 0;
  const controller = new GapRepairController({ workerUrl, db: async () => f.db, config: f.config,
    deps: { ...f.deps, readSessionTranscriptVisibleMessageDelta: async () => ++calls === 1
      ? { kind: "page", cursor: "first", entries: f.entries.slice(0,1), hasMore: true, serializedBytes: 100 }
      : { kind: "reset", cursor: "new", reason: "generation_mismatch" } }, runtime: async () => f.runtime });
  expect(await controller.run(invoking, f.cid)).toContain("history changed");
  expect(f.db.prepare("SELECT count(*) AS n FROM messages").get()?.n).toBe(2);
});
