import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  getTranscriptEntryId,
  getTranscriptEntryMeta,
  parseBootstrapJsonl,
  readLeafPathMessages,
  resolveTranscriptMessageCreatedAt,
} from "../src/transcript.js";
import type { LcmDependencies } from "../src/types.js";
import { createTestConfig, createTestDeps as createSharedTestDeps } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
  tempDirs.length = 0;
});

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}


function createTestDeps(config: LcmConfig): LcmDependencies {
  return createSharedTestDeps(config, {
    readLatestAssistantReply: () => undefined,
  });
}

function createEngine(): LcmContextEngine {
  const tempDir = createTempDir("lcm-entry-id-");
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  return new LcmContextEngine(createTestDeps(config), db);
}

function createSessionFilePath(name: string): string {
  return join(createTempDir("lcm-entry-id-session-"), `${name}.jsonl`);
}

function appendSessionMessage(manager: SessionManager, message: AgentMessage): string {
  return manager.appendMessage(
    message as unknown as Parameters<SessionManager["appendMessage"]>[0],
  );
}

describe("transcript entry metadata parsing", () => {
  it("attaches envelope id/parentId/timestamp to parsed messages", () => {
    const raw = [
      JSON.stringify({
        type: "message",
        id: "entry-1",
        parentId: null,
        timestamp: "2026-06-10T00:00:00.000Z",
        message: { role: "user", content: "hello" },
      }),
      JSON.stringify({
        type: "message",
        id: "entry-2",
        parentId: "entry-1",
        timestamp: "2026-06-10T00:00:01.000Z",
        message: { role: "assistant", content: "world" },
      }),
    ].join("\n");

    const parsed = parseBootstrapJsonl(raw);
    expect(parsed.messages).toHaveLength(2);
    expect(getTranscriptEntryId(parsed.messages[0]!)).toBe("entry-1");
    expect(getTranscriptEntryMeta(parsed.messages[1]!)).toEqual({
      entryId: "entry-2",
      parentId: "entry-1",
      timestamp: "2026-06-10T00:00:01.000Z",
    });
  });

  it("supports uuid/parentUuid envelope field names", () => {
    const raw = JSON.stringify({
      type: "message",
      uuid: "u-1",
      parentUuid: "u-0",
      message: { role: "user", content: "hi" },
    });
    const parsed = parseBootstrapJsonl(raw);
    expect(parsed.messages).toHaveLength(1);
    expect(getTranscriptEntryMeta(parsed.messages[0]!)).toEqual({
      entryId: "u-1",
      parentId: "u-0",
      timestamp: null,
    });
  });

  it("leaves bare messages and id-less envelopes without entry ids", () => {
    const raw = [
      JSON.stringify({ role: "user", content: "bare" }),
      JSON.stringify({ message: { role: "assistant", content: "enveloped, no id" } }),
    ].join("\n");
    const parsed = parseBootstrapJsonl(raw);
    expect(parsed.messages).toHaveLength(2);
    expect(getTranscriptEntryId(parsed.messages[0]!)).toBeNull();
    expect(getTranscriptEntryId(parsed.messages[1]!)).toBeNull();
  });

  it("keeps metadata invisible to JSON serialization but preserves it across spread", () => {
    const raw = JSON.stringify({
      type: "message",
      id: "entry-7",
      message: { role: "user", content: "hello" },
    });
    const message = parseBootstrapJsonl(raw).messages[0]!;
    expect(JSON.stringify(message)).not.toContain("entry-7");
    const spread = { ...message } as AgentMessage;
    expect(getTranscriptEntryId(spread)).toBe("entry-7");
  });

  it("reads entry ids from SessionManager-written transcripts", async () => {
    const sessionFile = createSessionFilePath("session-manager-ids");
    const manager = SessionManager.open(sessionFile);
    appendSessionMessage(manager, {
      role: "user",
      content: [{ type: "text", text: "question" }],
    } as AgentMessage);
    appendSessionMessage(manager, {
      role: "assistant",
      content: [{ type: "text", text: "answer" }],
    } as AgentMessage);

    const messages = await readLeafPathMessages(sessionFile);
    expect(messages).toHaveLength(2);
    expect(getTranscriptEntryId(messages[0]!)).toBeTruthy();
    expect(getTranscriptEntryId(messages[1]!)).toBeTruthy();
    expect(getTranscriptEntryId(messages[0]!)).not.toBe(getTranscriptEntryId(messages[1]!));
  });

  it("prefers message timestamps over replay envelope timestamps", () => {
    const raw = JSON.stringify({
      type: "message",
      id: "entry-replayed",
      timestamp: "2026-06-17T02:26:07.589Z",
      message: {
        role: "user",
        timestamp: Date.parse("2026-06-05T20:16:17.367Z"),
        content: [{ type: "text", text: "historical user message" }],
      },
    });

    const message = parseBootstrapJsonl(raw).messages[0]!;
    const createdAt = resolveTranscriptMessageCreatedAt(message);
    expect(createdAt).toBeInstanceOf(Date);
    expect((createdAt as Date).toISOString()).toBe("2026-06-05T20:16:17.367Z");
  });

  it("falls back to envelope timestamps for envelope-only transcript entries", () => {
    const raw = JSON.stringify({
      type: "message",
      id: "entry-envelope-only",
      timestamp: "2026-06-10T18:00:00.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "recovered assistant message" }],
      },
    });

    const message = parseBootstrapJsonl(raw).messages[0]!;
    expect(resolveTranscriptMessageCreatedAt(message)).toBe("2026-06-10T18:00:00.000Z");
  });
});

describe("messages.transcript_entry_id schema", () => {
  it("creates the column and a partial unique index, enforced on duplicates", () => {
    const tempDir = createTempDir("lcm-entry-id-schema-");
    const config = createTestConfig(join(tempDir, "lcm.db"));
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(createTestDeps(config), db);
    // Force migrations.
    void engine;
    (engine as unknown as { ensureMigrated: () => void }).ensureMigrated();

    const columns = db.prepare(`PRAGMA table_info(messages)`).all() as Array<{ name?: string }>;
    expect(columns.some((col) => col.name === "transcript_entry_id")).toBe(true);

    db.prepare(
      `INSERT INTO conversations (session_id, created_at, updated_at)
       VALUES ('schema-session', datetime('now'), datetime('now'))`,
    ).run();
    const insert = db.prepare(
      `INSERT INTO messages (conversation_id, seq, role, content, token_count, transcript_entry_id)
       VALUES (1, ?, 'user', ?, 1, ?)`,
    );
    insert.run(1, "first", "dup-entry");
    expect(() => insert.run(2, "second copy of same entry", "dup-entry")).toThrow(/UNIQUE|unique/);
    // NULL entry ids stay exempt from the uniqueness constraint.
    insert.run(3, "legacy row", null);
    insert.run(4, "legacy row", null);
    closeLcmConnection(db);
  });
});

describe("entry-id idempotent ingest", () => {
  it("skips re-ingesting a message whose transcript entry id is already persisted", async () => {
    const engine = createEngine();
    const sessionId = "entry-id-ingest";
    const raw = JSON.stringify({
      type: "message",
      id: "stable-entry",
      message: { role: "user", content: "only once" },
    });

    const first = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(raw).messages[0]!,
    });
    expect(first.ingested).toBe(true);

    // Re-parse to get a distinct object with the same entry id (a replayed
    // transcript line), and confirm it cannot duplicate the row.
    const second = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(raw).messages[0]!,
    });
    expect(second.ingested).toBe(false);

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
  });

  it("still ingests identical content when it arrives under a new entry id", async () => {
    const engine = createEngine();
    const sessionId = "entry-id-distinct";
    const makeRaw = (id: string) =>
      JSON.stringify({
        type: "message",
        id,
        message: { role: "assistant", content: "" },
      });

    const first = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(makeRaw("entry-a")).messages[0]!,
    });
    const second = await engine.ingest({
      sessionId,
      message: parseBootstrapJsonl(makeRaw("entry-b")).messages[0]!,
    });
    expect(first.ingested).toBe(true);
    expect(second.ingested).toBe(true);
  });

  it("stamps transcript_entry_id on rows imported from a transcript bootstrap", async () => {
    const sessionFile = createSessionFilePath("bootstrap-stamps-ids");
    const manager = SessionManager.open(sessionFile);
    for (let index = 0; index < 4; index += 1) {
      appendSessionMessage(manager, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index}` }],
      } as AgentMessage);
    }

    const engine = createEngine();
    const sessionId = "bootstrap-stamps-ids";
    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.importedMessages).toBe(4);

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const config = (engine as unknown as { config: LcmConfig }).config;
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      const rows = db
        .prepare(
          `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
        )
        .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.transcript_entry_id).toBeTruthy();
      }
      expect(new Set(rows.map((row) => row.transcript_entry_id)).size).toBe(4);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("re-running reconciliation over the same transcript imports nothing", async () => {
    const sessionFile = createSessionFilePath("reconcile-idempotent");
    const manager = SessionManager.open(sessionFile);
    for (let index = 0; index < 6; index += 1) {
      appendSessionMessage(manager, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index}` }],
      } as AgentMessage);
    }

    const engine = createEngine();
    const sessionId = "reconcile-idempotent";
    await engine.bootstrap({ sessionId, sessionFile });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    const countBefore = await engine.getConversationStore().getMessageCount(conversationId);

    // Drop the bootstrap checkpoint to force the slow-path full re-read on
    // the next afterTurn, simulating checkpoint loss / crash recovery.
    const config = (engine as unknown as { config: LcmConfig }).config;
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      db.prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`).run(
        conversationId,
      );
    } finally {
      closeLcmConnection(db);
    }

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const countAfter = await engine.getConversationStore().getMessageCount(conversationId);
    expect(countAfter).toBe(countBefore);
  });
});

describe("afterTurn covered-frontier alignment", () => {
  function makeMessage(role: AgentMessage["role"], text: string): AgentMessage {
    return { role, content: [{ type: "text", text }] } as AgentMessage;
  }

  it("does not duplicate a turn that the transcript already flushed", async () => {
    const sessionFile = createSessionFilePath("covered-full-flush");
    const manager = SessionManager.open(sessionFile);
    appendSessionMessage(manager, makeMessage("user", "question one"));
    appendSessionMessage(manager, makeMessage("assistant", "answer one"));

    const engine = createEngine();
    const sessionId = "covered-full-flush";
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "question one"), makeMessage("assistant", "answer one")],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual(["question one", "answer one"]);
  });

  it("collapses the decorated [timestamp] runtime copy onto the bare transcript row (store double-write)", async () => {
    const sessionFile = createSessionFilePath("decorated-timestamp-dup");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "decorated-timestamp-dup-header",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    const entryLine = (id: string, parentId: string | null, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    // Transcript holds the BARE body with an entry id (the real transcript copy).
    writeFileSync(
      sessionFile,
      `${header}\n${entryLine("dup-1", null, "user", "nice! thank you!")}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "decorated-timestamp-dup";
    // The afterTurn runtime batch carries the DECORATED ([timestamp]) copy of the
    // SAME turn — the live shape that double-writes today.
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "[Sun 2026-06-21 17:16 GMT+3] nice! thank you!")],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    // Exactly ONE row — the decorated runtime copy must not double-write.
    expect(messages.map((message) => message.content)).toEqual(["nice! thank you!"]);
  });

  it("keeps a single conv-info-only runtime copy without a sibling anchor", async () => {
    const sessionFile = createSessionFilePath("decorated-convinfo-repeat");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "decorated-convinfo-repeat-header",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    const entryLine = (id: string, parentId: string | null, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    writeFileSync(
      sessionFile,
      `${header}\n${entryLine("ci-1", null, "user", "Hey there! hows it going?")}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "decorated-convinfo-repeat";
    const decorated =
      'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "telegram:100000002"\n}\n```\n\nHey there! hows it going?';
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", decorated)],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "Hey there! hows it going?",
      decorated,
    ]);
  });

  it("uses a sibling exact row to collapse a conv-info-only runtime copy onto its bare transcript row", async () => {
    const sessionFile = createSessionFilePath("decorated-convinfo-anchored-dup");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "decorated-convinfo-anchored-dup-header",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    const entryLine = (id: string, parentId: string | null, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    writeFileSync(
      sessionFile,
      [
        header,
        entryLine("ci-a-1", null, "user", "Hey there! hows it going?"),
        entryLine("ci-a-2", "ci-a-1", "assistant", "all good"),
      ].join("\n") + "\n",
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "decorated-convinfo-anchored-dup";
    const decorated =
      'Conversation info (untrusted metadata):\n```json\n{\n  "chat_id": "telegram:100000002"\n}\n```\n\nHey there! hows it going?';
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", decorated), makeMessage("assistant", "all good")],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "Hey there! hows it going?",
      "all good",
    ]);
  });

  it("keeps a genuinely distinct runtime turn even when it shares a trailing word", async () => {
    const sessionFile = createSessionFilePath("distinct-not-collapsed");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "distinct-not-collapsed-header",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    const entryLine = (id: string, parentId: string | null, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    // Transcript bare row is one turn; the runtime batch is a DIFFERENT new turn
    // that merely shares a trailing word (mid-line, not line-aligned) — must NOT
    // collapse (fail-closed containment).
    writeFileSync(
      sessionFile,
      `${header}\n${entryLine("d-1", null, "user", "ok")}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "distinct-not-collapsed";
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "please say ok to bob")],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    // Both turns survive: the bare "ok" and the genuinely distinct new turn.
    expect(messages.map((message) => message.content)).toEqual(["ok", "please say ok to bob"]);
  });

  it("keeps a distinct multi-line turn whose trailing LINE equals a short prior body (no false-collapse)", async () => {
    const sessionFile = createSessionFilePath("trailing-line-not-collapsed");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "trailing-line-not-collapsed-header",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    const entryLine = (id: string, parentId: string | null, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    // Prior bare turn is a short "ok"; the new runtime turn is genuinely distinct
    // but its trailing line happens to equal "ok". The decoration gate must keep
    // it (arbitrary leading text is NOT recognized decoration) — collapsing would
    // be silent data loss.
    writeFileSync(
      sessionFile,
      `${header}\n${entryLine("tl-1", null, "user", "ok")}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "trailing-line-not-collapsed";
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "here is more context\nok")],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual(["ok", "here is more context\nok"]);
  });

  it("persists only the flush-lagged remainder, then dedupes the transcript catch-up", async () => {
    const sessionFile = createSessionFilePath("covered-flush-lag");
    const manager = SessionManager.open(sessionFile);
    appendSessionMessage(manager, makeMessage("user", "question one"));

    const engine = createEngine();
    const sessionId = "covered-flush-lag";
    // Turn 1: the transcript flushed only the user prompt; the assistant
    // reply exists only in the runtime batch.
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "question one"), makeMessage("assistant", "answer one")],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    const afterTurnOne = await engine.getConversationStore().getMessages(conversationId);
    expect(afterTurnOne.map((message) => message.content)).toEqual([
      "question one",
      "answer one",
    ]);

    // Turn 2: the transcript catches up (flushes the assistant reply) and a
    // new prompt arrives. The caught-up reply must not import twice even
    // though the transcript copy carries an entry id and the runtime row
    // does not.
    appendSessionMessage(manager, makeMessage("assistant", "answer one"));
    appendSessionMessage(manager, makeMessage("user", "question two"));
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "question two"), makeMessage("assistant", "answer two")],
      prePromptMessageCount: 0,
    });

    const afterTurnTwo = await engine.getConversationStore().getMessages(conversationId);
    expect(afterTurnTwo.map((message) => message.content)).toEqual([
      "question one",
      "answer one",
      "question two",
      "answer two",
    ]);
  });

  it("adopts the entry id onto flush-lagged runtime rows when the transcript catches up", async () => {
    const sessionFile = createSessionFilePath("entry-id-adoption");
    // Write the transcript envelopes directly so flush timing is
    // deterministic (SessionManager persists asynchronously).
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "entry-id-adoption-header",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    const entryLine = (id: string, parentId: string | null, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    writeFileSync(
      sessionFile,
      `${header}\n${entryLine("adopt-1", null, "user", "question one")}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "entry-id-adoption";
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "question one"), makeMessage("assistant", "answer one")],
      prePromptMessageCount: 0,
    });

    writeFileSync(
      sessionFile,
      `${header}\n${entryLine("adopt-1", null, "user", "question one")}\n${entryLine("adopt-2", "adopt-1", "assistant", "answer one")}\n${entryLine("adopt-3", "adopt-2", "user", "question two")}\n`,
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("user", "question two")],
      prePromptMessageCount: 0,
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const config = (engine as unknown as { config: LcmConfig }).config;
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      const rows = db
        .prepare(
          `SELECT content, transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
        )
        .all(conversation!.conversationId) as Array<{
        content: string;
        transcript_entry_id: string | null;
      }>;
      expect(rows.map((row) => row.content)).toEqual([
        "question one",
        "answer one",
        "question two",
      ]);
      // The runtime-persisted "answer one" row was adopted (stamped with the
      // catch-up entry's id) instead of duplicated.
      expect(rows.map((row) => row.transcript_entry_id)).toEqual([
        "adopt-1",
        "adopt-2",
        "adopt-3",
      ]);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("anchors by entry id even when stored content was rewritten (externalization)", async () => {
    const sessionFile = createSessionFilePath("entry-id-rewritten-content");
    const header = JSON.stringify({
      type: "session",
      version: 3,
      id: "rewritten-content-header",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
    const entryLine = (index: number, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id: `rewrite-${index}`,
        parentId: index === 0 ? null : `rewrite-${index - 1}`,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    const initialLines = [0, 1, 2, 3].map((index) =>
      entryLine(index, index % 2 === 0 ? "user" : "assistant", `turn ${index}`),
    );
    writeFileSync(sessionFile, [header, ...initialLines].join("\n") + "\n", "utf8");

    const engine = createEngine();
    const sessionId = "entry-id-rewritten-content";
    await engine.bootstrap({ sessionId, sessionFile });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;

    // Simulate post-ingest content rewriting (tool-result externalization)
    // plus checkpoint loss — the combination that defeats content-identity
    // anchors and used to freeze conversations.
    const config = (engine as unknown as { config: LcmConfig }).config;
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      db.prepare(`UPDATE messages SET content = 'externalized-stub-' || seq`).run();
      db.prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`).run(
        conversationId,
      );
    } finally {
      closeLcmConnection(db);
    }

    const appendedLines = [
      entryLine(4, "user", "turn 4"),
      entryLine(5, "assistant", "turn 5"),
    ];
    writeFileSync(
      sessionFile,
      [header, ...initialLines, ...appendedLines].join("\n") + "\n",
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const messages = await engine.getConversationStore().getMessages(conversationId);
    expect(messages).toHaveLength(6);
    expect(messages.at(-2)?.content).toBe("turn 4");
    expect(messages.at(-1)?.content).toBe("turn 5");
  });

  it("imports a same-path rewritten transcript as a declared epoch rollover", async () => {
    const sessionFile = createSessionFilePath("declared-epoch-rollover");
    const headerLine = (headerId: string) =>
      JSON.stringify({
        type: "session",
        version: 3,
        id: headerId,
        timestamp: new Date().toISOString(),
        cwd: process.cwd(),
      });
    const entryLine = (id: string, parentId: string | null, role: AgentMessage["role"], text: string) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    writeFileSync(
      sessionFile,
      [
        headerLine("epoch-one-header"),
        entryLine("old-1", null, "user", "old epoch question"),
        entryLine("old-2", "old-1", "assistant", "old epoch answer"),
      ].join("\n") + "\n",
      "utf8",
    );

    const warnLog = vi.fn();
    const tempDir = createTempDir("lcm-entry-id-rollover-");
    const config = createTestConfig(join(tempDir, "lcm.db"));
    const deps = createTestDeps(config);
    deps.log = { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() };
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(deps, db);
    const sessionId = "declared-epoch-rollover";
    await engine.bootstrap({ sessionId, sessionFile });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(2);

    // Rewrite the same path as a brand-new session (new header id, fresh
    // entry ids, larger than the old file so this is not a shrink).
    const padding = "x".repeat(160);
    writeFileSync(
      sessionFile,
      [
        headerLine("epoch-two-header"),
        entryLine("new-1", null, "user", `new epoch question ${padding}`),
        entryLine("new-2", "new-1", "assistant", `new epoch answer ${padding}`),
        entryLine("new-3", "new-2", "user", `new epoch follow-up ${padding}`),
      ].join("\n") + "\n",
      "utf8",
    );

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    expect(
      warnLog.mock.calls.some((call) =>
        String(call[0]).includes("declared epoch rollover"),
      ),
    ).toBe(true);
    const messages = await engine.getConversationStore().getMessages(conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "old epoch question",
      "old epoch answer",
      `new epoch question ${padding}`,
      `new epoch answer ${padding}`,
      `new epoch follow-up ${padding}`,
    ]);
  });

  it("fails closed on a stale replay batch that overlaps persisted history", async () => {
    const sessionFile = createSessionFilePath("covered-stale-replay");
    const manager = SessionManager.open(sessionFile);
    const texts = ["turn one", "turn two", "turn three", "turn four"];
    for (const [index, text] of texts.entries()) {
      appendSessionMessage(manager, makeMessage(index % 2 === 0 ? "user" : "assistant", text));
    }

    const engine = createEngine();
    const sessionId = "covered-stale-replay";
    await engine.bootstrap({ sessionId, sessionFile });

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(4);

    // Stale runtime snapshot replaying the middle of history: no tail
    // alignment, but identity overlap with persisted rows.
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage("assistant", "turn two"), makeMessage("user", "turn three")],
      prePromptMessageCount: 0,
    });

    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(4);
  });
});

describe("stale entry-id adoption after host history rewrites", () => {
  const headerLine = (headerId: string) =>
    JSON.stringify({
      type: "session",
      version: 3,
      id: headerId,
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
    });
  const entryLine = (
    id: string,
    parentId: string | null,
    role: AgentMessage["role"],
    text: string,
  ) =>
    JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role, content: [{ type: "text", text }] },
    });

  async function readRows(
    engine: LcmContextEngine,
    conversationId: number,
  ): Promise<Array<{ content: string; transcript_entry_id: string | null }>> {
    const config = (engine as unknown as { config: LcmConfig }).config;
    const db = createLcmDatabaseConnection(config.databasePath);
    try {
      return db
        .prepare(
          `SELECT content, transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
        )
        .all(conversationId) as Array<{ content: string; transcript_entry_id: string | null }>;
    } finally {
      closeLcmConnection(db);
    }
  }

  it("re-stamps rows stranded by a host suffix rewrite instead of duplicating", async () => {
    const sessionFile = createSessionFilePath("stale-id-suffix-rewrite");
    const header = headerLine("stale-id-rewrite-header");
    const prefix = [
      entryLine("a", null, "user", "q1"),
      entryLine("b", "a", "assistant", "a1"),
      entryLine("c", "b", "assistant", "big payload"),
      entryLine("d", "c", "assistant", "a2"),
    ];
    writeFileSync(sessionFile, [header, ...prefix].join("\n") + "\n", "utf8");

    const engine = createEngine();
    const sessionId = "stale-id-suffix-rewrite";
    await engine.bootstrap({ sessionId, sessionFile });
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(4);

    // Host rewriteTranscriptEntries: branch from "b" and re-append the suffix
    // under new ids — "c" replaced with a stub, "d" copied verbatim. The old
    // c/d remain in the file as an abandoned branch.
    writeFileSync(
      sessionFile,
      [
        header,
        ...prefix,
        entryLine("c2", "b", "assistant", "[LCM Tool Output: stub]"),
        entryLine("d2", "c2", "assistant", "a2"),
      ].join("\n") + "\n",
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const rows = await readRows(engine, conversationId);
    // The verbatim re-appended "a2" adopted the re-issued id d2 instead of
    // importing a duplicate; only the replaced stub is a genuinely new row.
    expect(rows.map((row) => row.content)).toEqual([
      "q1",
      "a1",
      "big payload",
      "a2",
      "[LCM Tool Output: stub]",
    ]);
    expect(rows.map((row) => row.transcript_entry_id)).toEqual(["a", "b", "c", "d2", "c2"]);
  });

  it("re-stamps across a declared epoch rollover that kept only re-issued ids", async () => {
    const sessionFile = createSessionFilePath("stale-id-rollover");
    const padding = "x".repeat(200);
    writeFileSync(
      sessionFile,
      [
        headerLine("stale-id-epoch-one"),
        entryLine("a", null, "user", "q1"),
        entryLine("b", "a", "assistant", `kept answer ${padding}`),
        entryLine("c", "b", "user", `kept follow-up ${padding}`),
      ].join("\n") + "\n",
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "stale-id-rollover";
    await engine.bootstrap({ sessionId, sessionFile });
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(3);

    // Compaction-successor style rotation after a rewrite: same path, new
    // header id, and the surviving tail carries re-issued ids only.
    writeFileSync(
      sessionFile,
      [
        headerLine("stale-id-epoch-two"),
        entryLine("b2", null, "assistant", `kept answer ${padding}`),
        entryLine("c2", "b2", "user", `kept follow-up ${padding}`),
      ].join("\n") + "\n",
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const rows = await readRows(engine, conversationId);
    expect(rows.map((row) => row.content)).toEqual([
      "q1",
      `kept answer ${padding}`,
      `kept follow-up ${padding}`,
    ]);
    // The surviving rows adopted the successor's re-issued ids; nothing
    // imported twice.
    expect(rows.map((row) => row.transcript_entry_id)).toEqual(["a", "b2", "c2"]);
  });

  it("still imports repeated content under a fresh id when the original is live", async () => {
    const sessionFile = createSessionFilePath("stale-id-live-repeat");
    const header = headerLine("stale-id-live-repeat-header");
    writeFileSync(
      sessionFile,
      [header, entryLine("a", null, "user", "hello")].join("\n") + "\n",
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "stale-id-live-repeat";
    await engine.bootstrap({ sessionId, sessionFile });
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;

    // The user repeats the same prompt later in the same live path: "a" is
    // still on the leaf path, so its row must NOT be re-stamped — the repeat
    // is genuine new traffic.
    writeFileSync(
      sessionFile,
      [
        header,
        entryLine("a", null, "user", "hello"),
        entryLine("b", "a", "assistant", "hi there"),
        entryLine("c", "b", "user", "hello"),
      ].join("\n") + "\n",
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const rows = await readRows(engine, conversationId);
    expect(rows.map((row) => row.content)).toEqual(["hello", "hi there", "hello"]);
    expect(rows.map((row) => row.transcript_entry_id)).toEqual(["a", "b", "c"]);
  });

  it("drains an over-cap id-bearing new epoch via chunked no-anchor import, then entry-id takeover", async () => {
    const sessionFile = createSessionFilePath("chunked-new-epoch");
    const entryWithParent = (
      id: string,
      parentId: string | null,
      role: AgentMessage["role"],
      text: string,
    ) =>
      JSON.stringify({
        type: "message",
        id,
        parentId,
        timestamp: new Date().toISOString(),
        message: { role, content: [{ type: "text", text }] },
      });
    const epochLines = (headerId: string, idPrefix: string, textPrefix: string) => [
      headerLine(headerId),
      ...Array.from({ length: 60 }, (_, index) =>
        entryWithParent(
          `${idPrefix}${index}`,
          index === 0 ? null : `${idPrefix}${index - 1}`,
          index % 2 === 0 ? "user" : "assistant",
          `${textPrefix} ${index}`,
        ),
      ),
    ];
    writeFileSync(
      sessionFile,
      epochLines("chunked-epoch-one", "a", "old turn").join("\n") + "\n",
      "utf8",
    );

    const logLines: string[] = [];
    const logCapture = (message: unknown) => {
      logLines.push(String(message));
    };
    const tempDir = createTempDir("lcm-chunked-epoch-");
    const config = createTestConfig(join(tempDir, "lcm.db"));
    const deps = createTestDeps(config);
    deps.log = { info: logCapture, warn: logCapture, error: logCapture, debug: logCapture };
    const engine = new LcmContextEngine(deps, createLcmDatabaseConnection(config.databasePath));
    const sessionId = "chunked-new-epoch";
    await engine.bootstrap({ sessionId, sessionFile });
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const conversationId = conversation!.conversationId;
    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(60);

    // Declared rollover to an epoch that shares no content with the DB
    // (e.g. a successor whose kept tail was fully rewritten): no content
    // anchor exists and 60 id-bearing candidates exceed the cap (50). The
    // first pass must import a bounded chunk instead of freezing.
    writeFileSync(
      sessionFile,
      epochLines("chunked-epoch-two", "b", "rewritten turn longer text").join("\n") + "\n",
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    expect(
      logLines.some((line) =>
        line.includes(
          "no-anchor entry-id import cap chunking for conversation=1 session=chunked-new-epoch — importing 50/60 new-epoch messages this pass",
        ),
      ),
      "first pass logs the no-anchor chunk",
    ).toBe(true);
    const afterFirstPass = await readRows(engine, conversationId);
    expect(afterFirstPass, "first pass imports exactly one bounded chunk").toHaveLength(110);
    expect(afterFirstPass[60]?.transcript_entry_id).toBe("b0");
    expect(afterFirstPass[109]?.transcript_entry_id).toBe("b49");

    // Second pass: the persisted b-ids give the entry-id planner an anchor,
    // so the remaining backlog drains through the anchored entry-id path.
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const afterSecondPass = await readRows(engine, conversationId);
    expect(afterSecondPass, "no duplicates across the chunked drain").toHaveLength(120);
    expect(afterSecondPass.slice(60).map((row) => row.transcript_entry_id)).toEqual(
      Array.from({ length: 60 }, (_, index) => `b${index}`),
    );

    // Third pass is a no-op: everything is persisted and the checkpoint has
    // advanced past the rollover.
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });
    expect(await engine.getConversationStore().getMessageCount(conversationId)).toBe(120);
  });
});

// ── lossless-claw-3071: repeated identical content must not defeat the
// append-only import path ─────────────────────────────────────────────────────
describe("repeated identical tool calls (lossless-claw-3071)", () => {
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "repeat-loop-header",
    timestamp: new Date().toISOString(),
    cwd: process.cwd(),
  });
  const entryLine = (
    id: string,
    parentId: string | null,
    role: AgentMessage["role"],
    text: string,
  ) =>
    JSON.stringify({
      type: "message",
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message: { role, content: [{ type: "text", text }] },
    });

  function engineWarn(engine: LcmContextEngine): ReturnType<typeof vi.fn> {
    return (engine as unknown as { deps: { log: { warn: ReturnType<typeof vi.fn> } } }).deps.log
      .warn;
  }

  it("imports byte-identical repeated turns once per entry id via the append-only path", async () => {
    const sessionFile = createSessionFilePath("repeat-identical-turns");
    // Live incident shape: a tool loop appends a byte-identical
    // tool_use/result pair (fresh entry ids) every iteration. The old
    // identity-based guard declared each appended pair "already persisted"
    // and forced a full re-read per iteration.
    const callText = "Read first 200 lines of SKILL.md";
    const resultText = "---\nname: github\ndescription: GitHub CLI skill";

    let parent: string | null = null;
    let lines = `${header}\n`;
    const appendPair = (iteration: number): void => {
      const callId = `repeat-call-${iteration}`;
      const resultId = `repeat-result-${iteration}`;
      lines += `${entryLine(callId, parent, "assistant", callText)}\n`;
      lines += `${entryLine(resultId, callId, "toolResult", resultText)}\n`;
      parent = resultId;
      writeFileSync(sessionFile, lines, "utf8");
    };

    const engine = createEngine();
    const sessionId = "repeat-identical-turns";
    const runtimePair = [
      { role: "assistant", content: [{ type: "text", text: callText }] } as AgentMessage,
      { role: "toolResult", content: [{ type: "text", text: resultText }] } as AgentMessage,
    ];

    for (let iteration = 1; iteration <= 4; iteration += 1) {
      appendPair(iteration);
      await engine.afterTurn({
        sessionId,
        sessionFile,
        messages: runtimePair,
        prePromptMessageCount: 0,
      });
      const conversation = await engine
        .getConversationStore()
        .getConversationForSession({ sessionId });
      const persisted = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      // Every iteration lands exactly its own pair: no refusal, no dupes.
      expect(persisted).toHaveLength(iteration * 2);
    }

    // The append-only path must never have been disqualified by content
    // identity: fresh entry ids are new entries by definition.
    const fullReconcileFallbacks = engineWarn(engine).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((message: string) => message.includes("falling back to full reconciliation"));
    expect(fullReconcileFallbacks).toEqual([]);
  });

  it("still falls back to full reconciliation when an appended entry id is already persisted", async () => {
    const sessionFile = createSessionFilePath("repeat-replayed-entry-id");
    let lines = `${header}\n${entryLine("replay-1", null, "user", "question one")}\n${entryLine(
      "replay-2",
      "replay-1",
      "assistant",
      "answer one",
    )}\n`;
    writeFileSync(sessionFile, lines, "utf8");

    const engine = createEngine();
    const sessionId = "repeat-replayed-entry-id";
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [
        { role: "user", content: [{ type: "text", text: "question one" }] } as AgentMessage,
        { role: "assistant", content: [{ type: "text", text: "answer one" }] } as AgentMessage,
      ],
      prePromptMessageCount: 0,
    });

    // A replay snapshot re-appends an ALREADY-persisted entry id: that is a
    // genuine overlap and must still route through full reconciliation
    // (which dedupes by id) instead of blind append-only ingest.
    lines += `${entryLine("replay-2", "replay-1", "assistant", "answer one")}\n`;
    lines += `${entryLine("replay-3", "replay-2", "user", "question two")}\n`;
    writeFileSync(sessionFile, lines, "utf8");
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [
        { role: "user", content: [{ type: "text", text: "question two" }] } as AgentMessage,
      ],
      prePromptMessageCount: 0,
    });

    expect(
      engineWarn(engine).mock.calls
        .map((call: unknown[]) => String(call[0]))
        .some((message: string) =>
          message.includes("already-persisted transcript entry ids"),
        ),
    ).toBe(true);

    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId });
    const persisted = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    // No duplicate rows from the replayed id; the new question imports once.
    expect(persisted.map((message) => message.content)).toEqual([
      "question one",
      "answer one",
      "question two",
    ]);
  });

  it("legacy unstamped empty-content rows do not false-flag flush-lag adoption", async () => {
    const sessionFile = createSessionFilePath("repeat-empty-content-legacy");
    // Conversation with a LEGACY unstamped empty-content assistant row (the
    // stored shape of pre-migration pure tool-call messages). On the live
    // incident lane, thousands of these matched every appended tool-call
    // message by identity and forced full reconciliation per iteration.
    const engine = createEngine();
    const sessionId = "repeat-empty-content-legacy";
    const conversation = await engine
      .getConversationStore()
      .getOrCreateConversation(sessionId, { sessionKey: undefined });
    await engine.getConversationStore().createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "assistant",
      content: "",
      tokenCount: 0,
    });
    await engine.getConversationStore().createMessage({
      conversationId: conversation.conversationId,
      seq: 2,
      role: "user",
      content: "anchor question",
      tokenCount: 4,
    });

    const callText = "";
    let lines = `${header}\n${entryLine("legacy-1", null, "user", "anchor question")}\n`;
    writeFileSync(sessionFile, lines, "utf8");
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    // Appended pure-tool-call pair: assistant content stores as empty.
    lines += `${JSON.stringify({
      type: "message",
      id: "legacy-2",
      parentId: "legacy-1",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_x", name: "read", arguments: { path: "f" } },
        ],
      },
    })}\n${entryLine("legacy-3", "legacy-2", "toolResult", "file contents here")}\n`;
    writeFileSync(sessionFile, lines, "utf8");
    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
    });

    const fallbacks = engineWarn(engine).mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((message: string) => message.includes("falling back to full reconciliation"));
    expect(fallbacks).toEqual([]);
  });
});
