import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { runSessionMigration } from "../src/migrate-sessions.js";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "lcm-migrate-sessions-"));
  roots.push(root);
  return root;
}

function writeAgentSession(root: string, fileName: string, entries: unknown[]): string {
  const sessionsDir = join(root, "agents", "main", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, fileName);
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return filePath;
}

function writeRawAgentSession(root: string, fileName: string, content: string): string {
  const sessionsDir = join(root, "agents", "main", "sessions");
  mkdirSync(sessionsDir, { recursive: true });
  const filePath = join(sessionsDir, fileName);
  writeFileSync(filePath, content);
  return filePath;
}

function sessionHeader(id: string): Record<string, unknown> {
  return {
    type: "session",
    version: 3,
    id,
    timestamp: "2026-06-10T00:00:00.000Z",
  };
}

function messageEntry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant" | "system" | "tool",
  content: string,
): Record<string, unknown> {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-06-10T00:00:00.000Z",
    message: { role, content },
  };
}

function bareMessage(role: "user" | "assistant", content: string): Record<string, unknown> {
  return { role, content };
}

function migratedDb(root: string): string {
  return join(root, "lcm.db");
}

function openMigratedDb(dbPath: string): {
  db: ReturnType<typeof createLcmDatabaseConnection>;
  conversationStore: ConversationStore;
} {
  const db = createLcmDatabaseConnection(dbPath);
  runLcmMigrations(db);
  return {
    db,
    conversationStore: new ConversationStore(db),
  };
}

afterEach(() => {
  closeLcmConnection();
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("runSessionMigration", () => {
  it("dry-runs by default and leaves the database untouched", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      messageEntry("m1", null, "user", "hello from history"),
      messageEntry("m2", "m1", "assistant", "saved reply"),
    ]);
    const dbPath = migratedDb(root);

    const result = await runSessionMigration({ dbPath, stateDir: root });

    expect(result.apply).toBe(false);
    expect(result.scannedFiles).toBe(1);
    expect(result.importedMessages).toBe(0);
    expect(result.files[0]).toMatchObject({
      status: "would-import",
      candidateMessages: 2,
      sessionId: "session-a",
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("imports a fresh session into conversations, messages, parts, context, and FTS", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      messageEntry("m1", null, "user", "hello searchable history"),
      messageEntry("m2", "m1", "assistant", "saved reply"),
    ]);
    const dbPath = migratedDb(root);

    const result = await runSessionMigration({ dbPath, stateDir: root, apply: true });

    expect(result).toMatchObject({
      apply: true,
      scannedFiles: 1,
      importedFiles: 1,
      importedMessages: 2,
    });
    expect(result.files[0]).toMatchObject({
      status: "imported",
      importedMessages: 2,
      skippedMessages: 0,
    });

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionId: "session-a" });
      expect(conversation).not.toBeNull();
      expect(await conversationStore.getMessageCount(conversation!.conversationId)).toBe(2);
      const messages = await conversationStore.getMessages(conversation!.conversationId);
      expect(messages.map((message) => message.content)).toEqual([
        "hello searchable history",
        "saved reply",
      ]);
      const firstParts = await conversationStore.getMessageParts(messages[0]!.messageId);
      expect(firstParts).toMatchObject([{ partType: "text", textContent: "hello searchable history" }]);
      const contextRows = db
        .prepare(
          `SELECT item_type, message_id
           FROM context_items
           WHERE conversation_id = ?
           ORDER BY ordinal`,
        )
        .all(conversation!.conversationId);
      expect(contextRows).toHaveLength(2);
      const search = await conversationStore.searchMessages({
        conversationId: conversation!.conversationId,
        query: "searchable",
        mode: "full_text",
      });
      expect(search).toHaveLength(1);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("is idempotent on rerun and imports no duplicate rows", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      messageEntry("m1", null, "user", "hello"),
      messageEntry("m2", "m1", "assistant", "reply"),
    ]);
    const dbPath = migratedDb(root);

    await runSessionMigration({ dbPath, stateDir: root, apply: true });
    const rerun = await runSessionMigration({ dbPath, stateDir: root, apply: true });

    expect(rerun.importedMessages).toBe(0);
    expect(rerun.backupPath).not.toBeNull();
    expect(existsSync(rerun.backupPath!)).toBe(true);
    expect(rerun.files[0]).toMatchObject({
      status: "up-to-date",
      skippedMessages: 2,
    });

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionId: "session-a" });
      expect(await conversationStore.getMessageCount(conversation!.conversationId)).toBe(2);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("catches up a plugin-off session by importing only missing transcript entry ids", async () => {
    const root = tempRoot();
    const sessionFile = writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      messageEntry("m1", null, "user", "first"),
      messageEntry("m2", "m1", "assistant", "second"),
    ]);
    const dbPath = migratedDb(root);
    await runSessionMigration({ dbPath, stateDir: root, apply: true });
    appendFileSync(sessionFile, `${JSON.stringify(messageEntry("m3", "m2", "user", "third"))}\n`);

    const catchup = await runSessionMigration({ dbPath, stateDir: root, apply: true });

    expect(catchup.importedMessages).toBe(1);
    expect(catchup.files[0]).toMatchObject({
      status: "imported",
      importedMessages: 1,
      skippedMessages: 2,
    });

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionId: "session-a" });
      const messages = await conversationStore.getMessages(conversation!.conversationId);
      expect(messages.map((message) => message.content)).toEqual(["first", "second", "third"]);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("adopts transcript entry ids onto existing identity-matching rows instead of duplicating them", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      messageEntry("m1", null, "user", "already persisted"),
      messageEntry("m2", "m1", "assistant", "existing reply"),
    ]);
    const dbPath = migratedDb(root);
    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getOrCreateConversation("session-a");
      await conversationStore.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "already persisted",
        tokenCount: 2,
      });
      await conversationStore.createMessage({
        conversationId: conversation.conversationId,
        seq: 2,
        role: "assistant",
        content: "existing reply",
        tokenCount: 2,
      });
    } finally {
      closeLcmConnection(db);
    }

    const result = await runSessionMigration({ dbPath, stateDir: root, apply: true });

    expect(result.importedMessages).toBe(0);
    expect(result.files[0]).toMatchObject({
      status: "up-to-date",
      skippedMessages: 2,
    });

    const reopened = openMigratedDb(dbPath);
    try {
      const conversation = await reopened.conversationStore.getConversationForSession({ sessionId: "session-a" });
      expect(await reopened.conversationStore.getMessageCount(conversation!.conversationId)).toBe(2);
      const rows = reopened.db
        .prepare(
          `SELECT content, transcript_entry_id
           FROM messages
           WHERE conversation_id = ?
           ORDER BY seq`,
        )
        .all(conversation!.conversationId) as Array<{ content: string; transcript_entry_id: string | null }>;
      expect(rows).toEqual([
        { content: "already persisted", transcript_entry_id: "m1" },
        { content: "existing reply", transcript_entry_id: "m2" },
      ]);
    } finally {
      closeLcmConnection(reopened.db);
    }
  });

  it("imports only the active leaf path from branched JSONL", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      messageEntry("m1", null, "user", "root"),
      messageEntry("abandoned", "m1", "assistant", "abandoned branch"),
      messageEntry("m2", "m1", "assistant", "active branch"),
      messageEntry("m3", "m2", "user", "active leaf"),
    ]);
    const dbPath = migratedDb(root);

    await runSessionMigration({ dbPath, stateDir: root, apply: true });

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionId: "session-a" });
      const messages = await conversationStore.getMessages(conversation!.conversationId);
      expect(messages.map((message) => message.content)).toEqual([
        "root",
        "active branch",
        "active leaf",
      ]);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("skips non-empty legacy/idless conversations instead of duplicating them", async () => {
    const root = tempRoot();
    writeAgentSession(root, "legacy.jsonl", [
      bareMessage("user", "legacy first"),
      bareMessage("assistant", "legacy reply"),
    ]);
    const dbPath = migratedDb(root);
    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getOrCreateConversation("legacy");
      await conversationStore.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "already imported",
        tokenCount: 2,
      });
    } finally {
      closeLcmConnection(db);
    }

    const result = await runSessionMigration({ dbPath, stateDir: root, apply: true });

    expect(result.importedMessages).toBe(0);
    expect(result.files[0]).toMatchObject({
      status: "skipped",
      reason: "existing-conversation-without-transcript-entry-ids",
      warnings: expect.arrayContaining([
        expect.stringContaining("already has messages but the transcript lacks stable entry ids"),
      ]),
    });

    const reopened = openMigratedDb(dbPath);
    try {
      const conversation = await reopened.conversationStore.getConversationForSession({ sessionId: "legacy" });
      expect(await reopened.conversationStore.getMessageCount(conversation!.conversationId)).toBe(1);
    } finally {
      closeLcmConnection(reopened.db);
    }
  });

  it("reports malformed or empty files and continues the batch", async () => {
    const root = tempRoot();
    writeRawAgentSession(root, "bad.jsonl", "{not json}\n");
    writeAgentSession(root, "good.jsonl", [
      sessionHeader("good"),
      messageEntry("g1", null, "user", "good"),
    ]);
    const dbPath = migratedDb(root);

    const result = await runSessionMigration({ dbPath, stateDir: root, apply: true });

    expect(result.scannedFiles).toBe(2);
    expect(result.importedMessages).toBe(1);
    expect(result.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: expect.stringContaining("bad.jsonl"), status: "skipped" }),
        expect.objectContaining({ file: expect.stringContaining("good.jsonl"), status: "imported" }),
      ]),
    );
  });
});
