import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { registerContextExplorerRepair, type ExplorerRepairPlan } from "../src/context-explorer-repair.js";
import { readContextExplorer, type ExplorerHealth } from "../src/context-explorer.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { resolveLcmConfig } from "../src/db/config.js";
import { CompactionMaintenanceStore } from "../src/store/compaction-maintenance-store.js";
import type { OpenClawPluginApi, PluginSessionActionRegistration } from "../src/openclaw-bridge.js";

const fixtures: { db: DatabaseSync; dir: string }[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const { db, dir } of fixtures.splice(0)) { db.close(); rmSync(dir, { recursive: true }); } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "explorer-repair-test-"));
  const databasePath = join(dir, "test.db"), db = new DatabaseSync(databasePath);
  fixtures.push({ db, dir });
  runLcmMigrations(db, { fts5Available: getLcmDbFeatures(db).fts5Available });
  db.exec(`INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES
    (1, 'a', 'agent:main:a', 1), (2, 'b', 'agent:main:b', 1);
    INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, model) VALUES
    ('bad', 1, 'leaf', 0, 'Emergency content', 5, 'emergency-fallback'),
    ('good', 1, 'condensed', 1, 'A healthy overview', 10, 'test'),
    ('other', 2, 'leaf', 0, 'Other emergency content', 5, 'emergency-fallback');
    INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES
    (1, 1, 1, 'user', 'Source discussion to preserve', 100);
    INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('bad', 1, 0);
    INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES ('good', 'bad', 0);
    INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (1, 0, 'summary', 'good');`);
  let action!: PluginSessionActionRegistration;
  const api = { session: { controls: { registerSessionAction: (a: PluginSessionActionRegistration) => { action = a; } } } } as OpenClawPluginApi;
  const summarize = vi.fn(async () => "A complete repaired summary.");
  registerContextExplorerRepair(api, async () => db, { config: resolveLcmConfig({}, { databasePath }), summarize });
  const ctx = { pluginId: "lossless-claw", actionId: "context-explorer-repair", sessionKey: "agent:main:a",
    client: { connId: "client-a", scopes: ["operator.write"] } };
  const call = (payload: Record<string, unknown>) => action.handler({ ...ctx, payload });
  const preview = async () => {
    const response = await call({ mode: "preview" }); expect(response.ok).toBe(true);
    return (response as { result: ExplorerRepairPlan }).result;
  };
  return { db, dir, action, summarize, ctx, call, preview };
}
it("reveals flagged descendants and reports database/version stats without exposing full content", () => {
  const { db } = fixture();
  const check = readContextExplorer(db, "agent:main:a", { check: true }) as ExplorerHealth;
  expect(check.total).toBe(1); expect(check.revealIds.sort()).toEqual(["bad", "good"]);
  expect(check.summaries).toMatchObject([{ summaryId: "bad", quality: "emergency" }]);
  expect(check.summaries[0]).not.toHaveProperty("content");
  expect(readContextExplorer(db, "agent:main:a")).toMatchObject({ version: expect.any(String), databaseBytes: expect.any(Number) });
});
it("requires write access and explicit confirmation, with no model calls during preview", async () => {
  const f = fixture(); expect(f.action.requiredScopes).toEqual(["operator.write"]);
  expect(await f.action.handler({ ...f.ctx, client: { scopes: ["operator.read"] }, payload: { mode: "preview" } })).toMatchObject({ ok: false });
  const plan = await f.preview(); expect(plan).toMatchObject({ count: 1, requiresOffline: false });
  expect(await f.call({ mode: "apply", token: plan.token })).toMatchObject({ ok: false });
  expect(f.summarize).not.toHaveBeenCalled();
});
it("backs up originals, repairs only confirmed conversation targets, clears emergency status, and deduplicates retries", async () => {
  const f = fixture(), plan = await f.preview();
  const input = { mode: "apply", token: plan.token, confirm: true };
  expect(await f.call(input)).toMatchObject({ ok: true, result: { repaired: 1, skipped: 0 } });
  expect(await f.call(input)).toMatchObject({ ok: true, result: { repaired: 1 } });
  expect(f.summarize).toHaveBeenCalledTimes(1);
  expect((readContextExplorer(f.db, "agent:main:a", { check: true }) as ExplorerHealth).total).toBe(0);
  expect(f.db.prepare("SELECT content FROM summaries WHERE summary_id = 'other'").get()).toMatchObject({ content: 'Other emergency content' });
  const backup = readdirSync(f.dir).find(name => name.endsWith('.bak'))!;
  const old = new DatabaseSync(join(f.dir, backup));
  try { expect(old.prepare("SELECT content FROM summaries WHERE summary_id = 'bad'").get()).toMatchObject({ content: 'Emergency content' }); }
  finally { old.close(); }
});
it("requires confirm-offline when maintenance becomes pending after preview", async () => {
  const f = fixture(), plan = await f.preview();
  await new CompactionMaintenanceStore(f.db).requestProactiveCompactionDebt({ conversationId: 1, reason: 'threshold' });
  expect(await f.call({ mode: 'apply', token: plan.token, confirm: true })).toMatchObject({ ok: false, error: expect.stringContaining('Offline confirmation') });
  expect(f.summarize).not.toHaveBeenCalled();
  const updated = await f.preview(); expect(updated.requiresOffline).toBe(true);
  expect(await f.call({ mode: 'apply', token: updated.token, confirm: true, confirmOffline: true })).toMatchObject({ ok: true, result: { repaired: 1 } });
});
it("rejects stale counts, foreign-session tokens, and expired confirmations", async () => {
  const f = fixture(), plan = await f.preview();
  expect(await f.action.handler({ ...f.ctx, sessionKey: 'agent:main:b', payload: { mode: 'apply', token: plan.token, confirm: true } })).toMatchObject({ ok: false });
  f.db.exec("UPDATE summaries SET content = 'Changed' WHERE summary_id = 'bad'");
  expect(await f.call({ mode: 'apply', token: plan.token, confirm: true })).toMatchObject({ ok: false, error: expect.stringContaining('Summaries changed') });
  const next = await f.preview(), now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 300_001);
  expect(await f.call({ mode: 'apply', token: next.token, confirm: true })).toMatchObject({ ok: false });
  expect(f.summarize).not.toHaveBeenCalled();
});
it("rejects duplicate running repairs and rolls back if sources change while generating", async () => {
  const f = fixture(), plan = await f.preview();
  let release!: () => void;
  f.summarize.mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return 'New content'; });
  const input = { mode: 'apply', token: plan.token, confirm: true }, pending = f.call(input);
  await vi.waitFor(() => expect(f.summarize).toHaveBeenCalledTimes(1));
  expect(await f.call(input)).toMatchObject({ ok: false, error: expect.stringContaining('already running') });
  f.db.exec("UPDATE messages SET content = 'Changed source' WHERE message_id = 1"); release();
  expect(await pending).toMatchObject({ ok: false, error: expect.stringContaining('Summaries changed') });
  expect(f.db.prepare("SELECT content FROM summaries WHERE summary_id = 'bad'").get()).toMatchObject({ content: 'Emergency content' });
});
it("reports skipped repairs without changing originals", async () => {
  const f = fixture(), plan = await f.preview(); f.summarize.mockResolvedValue('');
  expect(await f.call({ mode: 'apply', token: plan.token, confirm: true })).toMatchObject({ ok: true, result: { repaired: 0, skipped: 1 } });
  expect((readContextExplorer(f.db, 'agent:main:a', { check: true }) as ExplorerHealth).total).toBe(1);
});
