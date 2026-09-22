import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readContextExplorer, registerContextExplorer, type ExplorerSnapshot, type ExplorerDetail } from "../src/context-explorer.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import type { OpenClawPluginApi, PluginSessionActionRegistration } from "../src/openclaw-bridge.js";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  runLcmMigrations(db, { fts5Available: getLcmDbFeatures(db).fts5Available });
  db.exec(`INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES
    (1, 'session-a', 'agent:main:a', 1), (2, 'session-b', 'agent:main:b', 1),
    (3, 'old-session-a', 'agent:main:a', 0);
    INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count) VALUES
    ('leaf-a', 1, 'leaf', 0, 'Original discussion', 12),
    ('root-a', 1, 'condensed', 1, 'Decisions and design', 20),
    ('secret-b', 2, 'leaf', 0, 'Other session', 30),
    ('old-a', 3, 'leaf', 0, 'Archived session', 40);
    INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count) VALUES
    (1, 1, 1, 'user', 'Recent question', 10);
    INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES ('leaf-a', 1, 0);
    INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES ('root-a', 'leaf-a', 0);
    INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, message_id) VALUES
    (1, 0, 'summary', 'root-a', NULL), (1, 1, 'message', NULL, 1),
    (2, 0, 'summary', 'secret-b', NULL), (3, 0, 'summary', 'old-a', NULL);`);
  return db;
}

describe("Context explorer", () => {
  it("lists only active context roots, preserving order and separating recent-message tokens", () => {
    const db = fixture();
    const before = db.prepare("SELECT total_changes() AS count").get();
    const snapshot = readContextExplorer(db, "agent:main:a") as ExplorerSnapshot;
    expect(snapshot).toMatchObject({ basis: "stored-active-context", conversationId: 1,
      summaryCount: 1, messageCount: 1, summaryTokens: 20, messageTokens: 10, nextOffset: null });
    expect(snapshot.summaries.map(s => s.summaryId)).toEqual(["root-a"]);
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  });
  it("drills into a root's sources without allowing cross-session or archived summary access", () => {
    const db = fixture();
    const detail = readContextExplorer(db, "agent:main:a", { summaryId: "root-a" }) as ExplorerDetail;
    expect(detail.children).toMatchObject([{ summaryId: "leaf-a", kind: "leaf", depth: 0, preview: "Original discussion", tokenCount: 12 }]);
    expect(readContextExplorer(db, "agent:main:a", { summaryId: "leaf-a" })).toMatchObject({ sourceMessages: 1 });
    for (const summaryId of ["secret-b", "old-a", "' OR 1=1 --"]) {
      expect(() => readContextExplorer(db, "agent:main:a", { summaryId })).toThrow("not found");
    }
  });
  it("uses doctor's full-content and model detection on roots, descendants, and paged details", () => {
    const db = fixture();
    db.prepare("UPDATE summaries SET content = ? WHERE summary_id = 'root-a'")
      .run("a".repeat(25000) + " [Truncated from 40000 tokens]");
    db.exec("UPDATE summaries SET model = 'emergency-fallback' WHERE summary_id = 'leaf-a'");
    const before = db.prepare("SELECT total_changes() AS count").get();
    const snapshot = readContextExplorer(db, "agent:main:a") as ExplorerSnapshot;
    expect(snapshot.summaries[0].quality).toBe("new");
    expect(snapshot.summaries[0]).not.toHaveProperty("content");
    expect(snapshot.summaries[0]).not.toHaveProperty("model");
    const detail = readContextExplorer(db, "agent:main:a", { summaryId: "root-a", offset: 24000 }) as ExplorerDetail;
    expect(detail.quality).toBe("new");
    expect(detail.children[0].quality).toBe("emergency");
    expect(detail.children[0]).not.toHaveProperty("content");
    expect(readContextExplorer(db, "agent:main:a", { check: true })).toMatchObject({ total: 2, truncated: 1, emergency: 1, fallback: 0 });
    expect(db.prepare("SELECT total_changes() AS count").get()).toEqual(before);
  });
  it("checks only the selected active conversation and does not mistake ordinary mentions for markers", () => {
    const db = fixture();
    db.exec("UPDATE summaries SET model = 'emergency-fallback' WHERE conversation_id IN (2, 3)");
    db.exec("UPDATE summaries SET content = 'We discussed fallback summaries and truncation.' WHERE summary_id = 'root-a'");
    expect(readContextExplorer(db, "agent:main:a", { check: true })).toMatchObject({ total: 0 });
    db.prepare("UPDATE summaries SET content = ? WHERE summary_id = 'leaf-a'")
      .run("[LCM fallback summary; truncated for context management] Original discussion");
    expect(readContextExplorer(db, "agent:main:a", { check: true })).toMatchObject({ total: 1, fallback: 1 });
    expect(() => readContextExplorer(db, "unknown", { check: true })).toThrow("No active");
  });
  it("counts conversation messages once and matches doctor compression accounting", () => {
    const db = fixture();
    db.exec(`UPDATE summaries SET source_message_token_count = 600, descendant_token_count = 60 WHERE summary_id = 'root-a';
      INSERT INTO messages (conversation_id, seq, role, content, token_count) VALUES
      (1, 2, 'assistant', 'Older history outside active context', 600),
      (2, 1, 'user', 'Other conversation', 9000), (3, 1, 'user', 'Archived', 8000)`);
    const snapshot = readContextExplorer(db, "agent:main:a") as ExplorerSnapshot;
    expect(snapshot).toMatchObject({ conversationTokens: 610, compressedTokens: 660, compressionRatio: 22 });
    // Adding an inactive ancestor summary must not double-count the frontier.
    db.exec("UPDATE summaries SET source_message_token_count = 9999 WHERE summary_id = 'leaf-a'");
    expect(readContextExplorer(db, "agent:main:a")).toMatchObject({ compressedTokens: 660, compressionRatio: 22 });
    db.exec("DELETE FROM context_items WHERE conversation_id = 1");
    expect(readContextExplorer(db, "agent:main:a")).toMatchObject({ conversationTokens: 610, compressionRatio: null });
    expect(readContextExplorer(db, "unknown")).toMatchObject({ conversationTokens: 0, compressionRatio: null });
  });
  it("does not fall back to archived history or another session", () => {
    const db = fixture();
    db.exec("UPDATE conversations SET active = 0 WHERE conversation_id = 1");
    expect(readContextExplorer(db, "agent:main:a")).toMatchObject({ conversationId: null, summaries: [] });
    expect(readContextExplorer(db, "unknown")).toMatchObject({ conversationId: null, summaryTokens: 0 });
  });
  it("bounds summary pages and content, including Unicode text", () => {
    const db = fixture();
    for (let i = 0; i < 51; i++) {
      db.prepare("INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count) VALUES (?, 1, 'leaf', 'extra', 1)").run(`extra-${i}`);
      db.prepare("INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id) VALUES (1, ?, 'summary', ?)").run(i + 2, `extra-${i}`);
    }
    const first = readContextExplorer(db, "agent:main:a") as ExplorerSnapshot;
    const second = readContextExplorer(db, "agent:main:a", { offset: first.nextOffset }) as ExplorerSnapshot;
    expect(first.summaries).toHaveLength(50); expect(first.nextOffset).toBe(50);
    expect(second.summaries).toHaveLength(2); expect(second.nextOffset).toBeNull();
    expect(first.summaryCount).toBe(52); expect(first.summaryTokens).toBe(71);
    const content = "🌿".repeat(24001);
    db.prepare("UPDATE summaries SET content = ? WHERE summary_id = 'root-a'").run(content);
    const a = readContextExplorer(db, "agent:main:a", { summaryId: "root-a" }) as ExplorerDetail;
    const b = readContextExplorer(db, "agent:main:a", { summaryId: "root-a", offset: a.nextOffset }) as ExplorerDetail;
    expect(a.nextOffset).toBe(24000); expect(b.nextOffset).toBeNull(); expect(a.content + b.content).toBe(content);
    expect(() => readContextExplorer(db, "agent:main:a", { offset: -1 })).toThrow("Invalid offset");
  });
  it("registers an operator.read action requiring a session and exposes no SQL errors", async () => {
    const db = fixture(); let action!: PluginSessionActionRegistration;
    const api = { session: { controls: { registerSessionAction: (value: PluginSessionActionRegistration) => { action = value; } } } } as OpenClawPluginApi;
    registerContextExplorer(api, async () => db);
    expect(action.requiredScopes).toEqual(["operator.read"]);
    const base = { pluginId: "lossless-claw", actionId: "context-explorer" };
    expect(await action.handler(base)).toMatchObject({ ok: false });
    expect(await action.handler({ ...base, sessionKey: "agent:main:a" })).toMatchObject({ ok: true, result: { summaryCount: 1 } });
    expect(await action.handler({ ...base, sessionKey: "agent:main:a", payload: { offset: -1 } })).toMatchObject({ ok: false });
    // Failed read rolls back cleanly and releases the shared mutex.
    expect(await action.handler({ ...base, sessionKey: "agent:main:a" })).toMatchObject({ ok: true });
  });
});
