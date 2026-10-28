import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
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

function writeCodexSession(root: string, fileName: string, entries: unknown[]): string {
  const filePath = join(root, fileName);
  writeFileSync(filePath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return filePath;
}

function codexMeta(id = "codex-thread"): Record<string, unknown> {
  return {
    type: "session_meta",
    payload: { id, timestamp: "2026-10-03T10:00:00.000Z", source: "cli" },
  };
}

function codexResponse(payload: Record<string, unknown>, timestamp = "2026-10-03T10:00:01.000Z") {
  return { type: "response_item", timestamp, payload };
}

function codexEvent(type: string, message?: string, timestamp = "2026-10-03T10:00:01.000Z") {
  return { type: "event_msg", timestamp, payload: { type, ...(message !== undefined ? { message } : {}) } };
}

function codexImportOptions(file: string, dbPath: string, stateDir: string) {
  return {
    sourceFormat: "codex" as const,
    files: [file],
    sessionId: "openclaw-target-id",
    sessionKey: "agent:main:codex-import-target",
    dbPath,
    stateDir,
  };
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

  it("imports only allowlisted OpenClaw sender identity from JSONL messages", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-sender.jsonl", [
      sessionHeader("session-sender"),
      {
        ...messageEntry("m1", null, "user", "group history"),
        message: {
          role: "user",
          content: "group history",
          __openclaw: {
            senderId: "user-42",
            senderName: "Ada Lovelace",
            senderUsername: "ada",
            senderIsOwner: true,
          },
        },
      },
    ]);
    const dbPath = migratedDb(root);

    await runSessionMigration({ dbPath, stateDir: root, apply: true });

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({
        sessionId: "session-sender",
      });
      const messages = await conversationStore.getMessages(conversation!.conversationId);
      expect(messages[0]?.openClawSenderMetadata).toEqual({
        senderId: "user-42",
        senderName: "Ada Lovelace",
        senderUsername: "ada",
      });
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

  it("imports transcript rows instead of weakly adopting existing identity matches", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      {
        ...messageEntry("m1", null, "user", "already persisted"),
        message: {
          role: "user",
          content: "already persisted",
          __openclaw: {
            senderId: "adopted-user",
            senderName: "Adopted Sender",
          },
        },
      },
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

    expect(result.importedMessages).toBe(2);
    expect(result.files[0]).toMatchObject({
      status: "imported",
      importedMessages: 2,
      skippedMessages: 0,
    });

    const reopened = openMigratedDb(dbPath);
    try {
      const conversation = await reopened.conversationStore.getConversationForSession({ sessionId: "session-a" });
      expect(await reopened.conversationStore.getMessageCount(conversation!.conversationId)).toBe(4);
      const rows = reopened.db
        .prepare(
          `SELECT m.content, m.transcript_entry_id, trust.trust_state, trust.reason
           FROM messages AS m
           LEFT JOIN message_transcript_anchor_trust AS trust
             ON trust.message_id = m.message_id
           WHERE m.conversation_id = ?
           ORDER BY m.seq`,
        )
        .all(conversation!.conversationId) as Array<{
        content: string;
        transcript_entry_id: string | null;
        trust_state: string | null;
        reason: string | null;
      }>;
      expect(rows).toEqual([
        {
          content: "already persisted",
          transcript_entry_id: null,
          trust_state: null,
          reason: null,
        },
        {
          content: "existing reply",
          transcript_entry_id: null,
          trust_state: null,
          reason: null,
        },
        {
          content: "already persisted",
          transcript_entry_id: "m1",
          trust_state: "verified",
          reason: "message imported from transcript entry",
        },
        {
          content: "existing reply",
          transcript_entry_id: "m2",
          trust_state: "verified",
          reason: "message imported from transcript entry",
        },
      ]);
    } finally {
      closeLcmConnection(reopened.db);
    }
  });

  it("does not weakly adopt blank assistant transcript ids onto existing rows", async () => {
    const root = tempRoot();
    writeAgentSession(root, "session-a.jsonl", [
      sessionHeader("session-a"),
      messageEntry("m1", null, "assistant", ""),
    ]);
    const dbPath = migratedDb(root);
    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getOrCreateConversation("session-a");
      await conversationStore.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "",
        tokenCount: 0,
      });
    } finally {
      closeLcmConnection(db);
    }

    const result = await runSessionMigration({ dbPath, stateDir: root, apply: true });

    expect(result.importedMessages).toBe(1);
    expect(result.files[0]).toMatchObject({
      status: "imported",
      importedMessages: 1,
      skippedMessages: 0,
    });

    const reopened = openMigratedDb(dbPath);
    try {
      const conversation = await reopened.conversationStore.getConversationForSession({ sessionId: "session-a" });
      const rows = reopened.db
        .prepare(
          `SELECT m.content, m.transcript_entry_id, trust.trust_state
           FROM messages AS m
           LEFT JOIN message_transcript_anchor_trust AS trust
             ON trust.message_id = m.message_id
           WHERE m.conversation_id = ?
           ORDER BY m.seq`,
        )
        .all(conversation!.conversationId) as Array<{
        content: string;
        transcript_entry_id: string | null;
        trust_state: string | null;
      }>;
      expect(rows).toEqual([
        { content: "", transcript_entry_id: null, trust_state: null },
        { content: "", transcript_entry_id: "m1", trust_state: "verified" },
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

  it("dry-runs one Codex rollout without creating or migrating a database", async () => {
    const root = tempRoot();
    const file = writeCodexSession(root, "rollout.jsonl", [
      codexMeta(),
      codexResponse({ type: "message", role: "user", content: [{ type: "input_text", text: "Codex request" }] }),
      codexResponse({ type: "message", role: "assistant", content: [{ type: "output_text", text: "Codex answer" }] }),
    ]);
    const dbPath = migratedDb(root);

    const result = await runSessionMigration(codexImportOptions(file, dbPath, root));

    expect(result).toMatchObject({
      apply: false,
      scannedFiles: 1,
      importedMessages: 0,
      files: [expect.objectContaining({ status: "would-import", sessionId: "openclaw-target-id", candidateMessages: 2 })],
    });
    expect(result.files[0]?.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Native LCM continuation requires a later OpenClaw transcript tail"),
      ]),
    );
    expect(existsSync(dbPath)).toBe(false);
    await expect(runSessionMigration({ ...codexImportOptions(file, dbPath, root), sessionKey: undefined })).rejects.toThrow(
      "explicit --session-id and --session-key",
    );
  });

  it("imports canonical roles, repeated messages, tool arguments, and output with source provenance", async () => {
    const root = tempRoot();
    const file = writeCodexSession(root, "rollout.jsonl", [
      codexMeta("codex-multi-role"),
      codexResponse({ type: "message", role: "user", content: [{ type: "input_text", text: "repeat me" }] }),
      { type: "event_msg", timestamp: "2026-10-03T10:00:01.000Z", payload: { type: "user_message", message: "repeat me" } },
      codexResponse({ type: "message", role: "assistant", content: [{ type: "output_text", text: "reply" }] }),
      { type: "event_msg", timestamp: "2026-10-03T10:00:02.000Z", payload: { type: "agent_message", message: "reply" } },
      codexResponse({ type: "message", role: "user", content: [{ type: "input_text", text: "repeat me" }] }),
      codexResponse({ type: "function_call", name: "shell", arguments: "{\"cmd\":\"pwd\"}", call_id: "call-7" }),
      codexResponse({ type: "function_call_output", call_id: "call-7", output: "workspace root" }),
    ]);
    const dbPath = migratedDb(root);

    const result = await runSessionMigration({ ...codexImportOptions(file, dbPath, root), apply: true });
    expect(result).toMatchObject({ importedMessages: 5, importedFiles: 1 });

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionKey: "agent:main:codex-import-target" });
      expect(conversation).toMatchObject({
        sessionId: "openclaw-target-id",
        sessionKey: "agent:main:codex-import-target",
      });
      const messages = await conversationStore.getMessages(conversation!.conversationId);
      expect(messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "repeat me"],
        ["assistant", "reply"],
        ["user", "repeat me"],
        ["assistant", ""],
        ["tool", ""],
      ]);
      expect(messages.every((message) => message.transcriptEntryId === null)).toBe(true);
      const callParts = await conversationStore.getMessageParts(messages[3]!.messageId);
      expect(callParts[0]).toMatchObject({ partType: "tool", toolCallId: "call-7", toolName: "shell" });
      expect(callParts[0]?.toolInput).toContain("pwd");
      const outputParts = await conversationStore.getMessageParts(messages[4]!.messageId);
      expect(outputParts[0]).toMatchObject({ partType: "tool", toolCallId: "call-7" });
      expect(outputParts[0]?.toolOutput).toContain("workspace root");

      const sourceMarkers = db
        .prepare("SELECT metadata FROM message_parts WHERE message_id = ? ORDER BY ordinal")
        .all(messages[0]!.messageId) as Array<{ metadata: string }>;
      const marker = JSON.parse(sourceMarkers[0]!.metadata) as { codexSource: { id: string; threadId: string; line: number; sourceRecord: { payload: unknown } } };
      expect(marker.codexSource).toMatchObject({ threadId: "codex-multi-role", line: 2 });
      expect(marker.codexSource.id).toContain("codex-multi-role");
      expect(marker.codexSource.sourceRecord.payload).toMatchObject({ role: "user" });
      expect((marker.codexSource as typeof marker.codexSource & { sessionMeta: { source: string } }).sessionMeta.source).toBe("cli");
      const secondParts = await conversationStore.getMessageParts(messages[1]!.messageId);
      const secondMarker = JSON.parse(secondParts[0]!.metadata!) as { codexSource: { sessionMeta?: unknown } };
      expect(secondMarker.codexSource.sessionMeta).toBeUndefined();
      expect(await conversationStore.getMessageCount(conversation!.conversationId)).toBe(5);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("imports the complete source beyond the old 200-item boundary and keeps early records searchable", async () => {
    const root = tempRoot();
    const entries: unknown[] = [codexMeta("codex-long")];
    for (let index = 0; index < 230; index += 1) {
      entries.push(codexResponse({
        type: "message",
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: index % 2 === 0 ? "input_text" : "output_text", text: index === 0 ? "early searchable canary" : `message ${index}` }],
      }, `2026-10-03T10:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`));
    }
    const file = writeCodexSession(root, "long-rollout.jsonl", entries);
    const dbPath = migratedDb(root);

    const result = await runSessionMigration({ ...codexImportOptions(file, dbPath, root), apply: true });

    expect(result).toMatchObject({ importedMessages: 230, files: [expect.objectContaining({ candidateMessages: 230 })] });
    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionKey: "agent:main:codex-import-target" });
      expect(await conversationStore.getMessageCount(conversation!.conversationId)).toBe(230);
      const search = await conversationStore.searchMessages({
        conversationId: conversation!.conversationId,
        query: "canary",
        mode: "full_text",
      });
      expect(search).toHaveLength(1);
      expect(search[0]?.snippet).toContain("early searchable canary");
    } finally {
      closeLcmConnection(db);
    }
  });

  it("replays Codex provenance idempotently, imports append-only deltas, and rejects changed history", async () => {
    const root = tempRoot();
    const file = writeCodexSession(root, "rollout.jsonl", [
      codexMeta("codex-delta"),
      codexResponse({ type: "message", role: "user", content: "first" }),
      codexResponse({ type: "message", role: "assistant", content: "second" }),
    ]);
    const dbPath = migratedDb(root);
    const options = { ...codexImportOptions(file, dbPath, root), apply: true };

    await runSessionMigration(options);
    const replay = await runSessionMigration(options);
    expect(replay).toMatchObject({ importedMessages: 0, files: [expect.objectContaining({ status: "up-to-date", skippedMessages: 2 })] });

    appendFileSync(file, `${JSON.stringify(codexResponse({ type: "message", role: "user", content: "third" }))}\n`);
    const delta = await runSessionMigration(options);
    expect(delta).toMatchObject({ importedMessages: 1, files: [expect.objectContaining({ status: "imported", skippedMessages: 2 })] });

    const originalLines = readFileSync(file, "utf8").trimEnd().split("\n");
    writeFileSync(file, `${originalLines.slice(0, -1).join("\n")}\n`);
    const truncated = await runSessionMigration(options);
    expect(truncated).toMatchObject({
      importedMessages: 0,
      files: [expect.objectContaining({ status: "error", reason: "codex-source-changed-or-truncated" })],
    });

    const lines = [...originalLines];
    const changed = JSON.parse(lines[1]!) as { payload: { content: string } };
    changed.payload.content = "changed earlier source";
    lines[1] = JSON.stringify(changed);
    writeFileSync(file, `${lines.join("\n")}\n`);
    const rejected = await runSessionMigration(options);
    expect(rejected).toMatchObject({ importedMessages: 0, files: [expect.objectContaining({ status: "error", reason: "codex-source-changed-or-truncated" })] });

    const reopened = openMigratedDb(dbPath);
    try {
      const conversation = await reopened.conversationStore.getConversationForSession({ sessionKey: "agent:main:codex-import-target" });
      expect(await reopened.conversationStore.getMessageCount(conversation!.conversationId)).toBe(3);
    } finally {
      closeLcmConnection(reopened.db);
    }
  });

  it("rejects session metadata rewrites and truncation of accepted omitted trailing records", async () => {
    const root = tempRoot();
    const originalEntries = [
      codexMeta("codex-byte-prefix"),
      codexResponse({ type: "message", role: "user", content: "request" }),
      codexResponse({ type: "message", role: "assistant", content: "answer" }),
      codexEvent("task_complete"),
    ];
    const file = writeCodexSession(root, "rollout.jsonl", originalEntries);
    const dbPath = migratedDb(root);
    const options = { ...codexImportOptions(file, dbPath, root), apply: true };

    await runSessionMigration(options);
    const originalText = readFileSync(file, "utf8");
    const changedMetaLines = originalText.trimEnd().split("\n");
    const changedMeta = JSON.parse(changedMetaLines[0]!) as { payload: Record<string, unknown> };
    changedMeta.payload.timestamp = "2026-10-04T10:00:00.000Z";
    changedMetaLines[0] = JSON.stringify(changedMeta);
    writeFileSync(file, `${changedMetaLines.join("\n")}\n`);

    const changedMetaResult = await runSessionMigration(options);
    expect(changedMetaResult).toMatchObject({
      importedMessages: 0,
      files: [expect.objectContaining({ status: "error", reason: "codex-source-changed-or-truncated" })],
    });

    writeFileSync(file, originalText);
    appendFileSync(file, `${JSON.stringify(codexEvent("task_started"))}\n`);
    const omittedAppend = await runSessionMigration(options);
    expect(omittedAppend).toMatchObject({ importedMessages: 0, files: [expect.objectContaining({ status: "up-to-date" })] });

    writeFileSync(file, originalText);
    const truncatedOmittedAppend = await runSessionMigration(options);
    expect(truncatedOmittedAppend).toMatchObject({
      importedMessages: 0,
      files: [expect.objectContaining({ status: "error", reason: "codex-source-changed-or-truncated" })],
    });
  });

  it.each([
    {
      name: "an accepted mirror followed by a closer canonical record",
      initialRecords: [
        codexResponse({ type: "message", role: "user", content: "request" }, "2026-10-03T10:00:00.000Z"),
        codexEvent("user_message", "request", "2026-10-03T10:00:04.000Z"),
      ],
      appended: codexResponse({ type: "message", role: "user", content: "request" }, "2026-10-03T10:00:04.000Z"),
      expectedLines: [2, 4],
    },
    {
      name: "an earlier event followed by a canonical text record",
      initialRecords: [codexEvent("user_message", "request")],
      appended: codexResponse({ type: "message", role: "user", content: [{ type: "input_text", text: "request" }] }),
      expectedLines: [2, 3],
    },
    {
      name: "an earlier event followed by richer canonical content",
      initialRecords: [codexEvent("user_message", "request")],
      appended: codexResponse({ type: "message", role: "user", content: [
        { type: "input_text", text: "request" },
        { type: "input_image", image_url: "https://example.invalid/synthetic.png" },
      ] }),
      expectedLines: [2, 3],
    },
  ])("preserves canonical provenance on replay with $name", async ({ initialRecords, appended, expectedLines }) => {
    const root = tempRoot();
    const file = writeCodexSession(root, "rollout.jsonl", [codexMeta("codex-append-mirrors"), ...initialRecords]);
    const dbPath = migratedDb(root);
    const options = { ...codexImportOptions(file, dbPath, root), apply: true };

    const initial = await runSessionMigration(options);
    expect(initial.importedMessages).toBe(1);
    appendFileSync(file, `${JSON.stringify(appended)}\n`);
    const replay = await runSessionMigration(options);
    expect(replay.importedMessages).toBe(1);
    expect((await runSessionMigration(options)).importedMessages).toBe(0);

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionKey: "agent:main:codex-import-target" });
      const messages = await conversationStore.getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(2);
      const sources = [];
      for (const message of messages) {
        const parts = await db.prepare("SELECT metadata FROM message_parts WHERE message_id = ? ORDER BY ordinal")
          .all(message.messageId) as Array<{ metadata: string | null }>;
        sources.push(parts.map((part) => part.metadata && JSON.parse(part.metadata))
          .find((part) => part?.codexSource)?.codexSource);
      }
      expect(sources.map((source) => source.line)).toEqual(expectedLines);
      expect(sources[1].sourceRecord).toEqual(appended);
    } finally {
      closeLcmConnection(db);
    }
  });

  it("rejects malformed Codex input without creating a database", async () => {
    const root = tempRoot();
    const file = writeRawAgentSession(root, "bad-rollout.jsonl", '{"type":"session_meta","payload":{"id":"bad"}}\nnot-json\n');
    const dbPath = migratedDb(root);

    const result = await runSessionMigration({ ...codexImportOptions(file, dbPath, root), apply: true });

    expect(result).toMatchObject({
      apply: true,
      errorFiles: 1,
      files: [expect.objectContaining({ status: "error", reason: "invalid-codex-source" })],
    });
    expect(existsSync(dbPath)).toBe(false);
  });

  it("rejects a Codex destination whose session id and key resolve to different conversations", async () => {
    const root = tempRoot();
    const file = writeCodexSession(root, "rollout.jsonl", [
      codexMeta("codex-binding"),
      codexResponse({ type: "message", role: "user", content: "request" }),
    ]);
    const dbPath = migratedDb(root);
    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      await conversationStore.createConversation({ sessionId: "openclaw-target-id" });
      await conversationStore.createConversation({ sessionId: "other-target-id", sessionKey: "agent:main:codex-import-target" });
    } finally {
      closeLcmConnection(db);
    }

    const result = await runSessionMigration({ ...codexImportOptions(file, dbPath, root), apply: true });
    expect(result).toMatchObject({
      importedMessages: 0,
      files: [expect.objectContaining({ status: "error", reason: "destination-binding-mismatch" })],
    });

    const reopened = openMigratedDb(dbPath);
    try {
      expect(await reopened.conversationStore.getConversationBySessionId("openclaw-target-id")).toMatchObject({ sessionKey: null });
      const byKey = await reopened.conversationStore.getConversationBySessionKey("agent:main:codex-import-target");
      expect(byKey?.sessionId).toBe("other-target-id");
      expect(await reopened.conversationStore.getMessageCount(byKey!.conversationId)).toBe(0);
    } finally {
      closeLcmConnection(reopened.db);
    }
  });

  it("refuses to append Codex history after unrelated destination messages already exist", async () => {
    const root = tempRoot();
    const file = writeCodexSession(root, "rollout.jsonl", [
      codexMeta("codex-too-late"),
      codexResponse({ type: "message", role: "user", content: "old source request" }),
    ]);
    const dbPath = migratedDb(root);
    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getOrCreateConversation("openclaw-target-id", {
        sessionKey: "agent:main:codex-import-target",
      });
      await conversationStore.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: "already live in this conversation",
        tokenCount: 6,
      });
    } finally {
      closeLcmConnection(db);
    }

    const result = await runSessionMigration({ ...codexImportOptions(file, dbPath, root), apply: true });
    expect(result).toMatchObject({
      importedMessages: 0,
      files: [expect.objectContaining({ status: "error", reason: "codex-destination-not-empty" })],
    });

    const reopened = openMigratedDb(dbPath);
    try {
      const conversation = await reopened.conversationStore.getConversationForSession({ sessionKey: "agent:main:codex-import-target" });
      expect(await reopened.conversationStore.getMessageCount(conversation!.conversationId)).toBe(1);
      expect((await reopened.conversationStore.getMessages(conversation!.conversationId))[0]?.content).toBe("already live in this conversation");
    } finally {
      closeLcmConnection(reopened.db);
    }
  });

  it("rejects appending Codex history after a native live message follows the import", async () => {
    const root = tempRoot();
    const file = writeCodexSession(root, "rollout.jsonl", [
      codexMeta("codex-live-mix"),
      codexResponse({ type: "message", role: "user", content: "imported request" }),
      codexResponse({ type: "message", role: "assistant", content: "imported answer" }),
    ]);
    const dbPath = migratedDb(root);
    const options = { ...codexImportOptions(file, dbPath, root), apply: true };
    await runSessionMigration(options);

    const { db, conversationStore } = openMigratedDb(dbPath);
    try {
      const conversation = await conversationStore.getConversationForSession({ sessionKey: "agent:main:codex-import-target" });
      await conversationStore.createMessage({
        conversationId: conversation!.conversationId,
        seq: 3,
        role: "assistant",
        content: "native live answer",
        tokenCount: 3,
      });
    } finally {
      closeLcmConnection(db);
    }

    appendFileSync(file, `${JSON.stringify(codexResponse({ type: "message", role: "user", content: "later source request" }))}\n`);
    const result = await runSessionMigration(options);
    expect(result).toMatchObject({
      importedMessages: 0,
      files: [expect.objectContaining({ status: "error", reason: "codex-destination-not-empty" })],
    });

    const reopened = openMigratedDb(dbPath);
    try {
      const conversation = await reopened.conversationStore.getConversationForSession({ sessionKey: "agent:main:codex-import-target" });
      expect(await reopened.conversationStore.getMessageCount(conversation!.conversationId)).toBe(3);
      expect((await reopened.conversationStore.getMessages(conversation!.conversationId))[2]?.content).toBe("native live answer");
    } finally {
      closeLcmConnection(reopened.db);
    }
  });
});
