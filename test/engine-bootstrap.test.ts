// Engine bootstrap: transcript reconciliation on session start, checkpoints, rollover detection, replay/flood guards.
// Split from the former monolithic test/engine.test.ts; shared fixtures live in test/helpers.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import { estimateTokens } from "../src/estimate-tokens.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { LcmProviderAuthError, LcmSummarySpendLimitError } from "../src/summarize.js";
import {
  cleanupEngineTestState,
  appendSessionMessage,
  expectUnavailableRotate,
  getEngineConfig,
  createTestConfig,
  createTestDeps,
  createEngine,
  createEngineWithDepsOverrides,
  createEngineAtDatabasePath,
  createSessionFilePath,
  writeLeafTranscript,
  writeLeafTranscriptMessages,
  createEngineWithConfig,
  createEngineWithDeps,
  withTempHome,
  makeMessage,
  readSessionMessages,
  createBulkySession,
  corruptSessionFilePreservingObservedStats,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

function openClawInboundMetadataContent(params: {
  messageId: string;
  senderName: string;
  text: string;
}): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      chat_id: "telegram:chat-1",
      message_id: params.messageId,
      timestamp: "2026-06-16T00:00:00.000Z",
    }),
    "```",
    "",
    "Sender (untrusted metadata):",
    "```json",
    JSON.stringify({ name: params.senderName }),
    "```",
    "",
    params.text,
  ].join("\n");
}

describe("LcmContextEngine.bootstrap", () => {
  it("imports only active leaf-path messages from SessionManager context", async () => {
    const sessionFile = createSessionFilePath("branched");
    const sm = SessionManager.open(sessionFile);

    const rootUserId = appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "root user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "abandoned assistant" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "abandoned user" }],
    } as AgentMessage);

    // Re-branch from the first user entry so prior turns are abandoned.
    sm.branch(rootUserId);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "active assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-leaf-path";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(conversation!.bootstrappedAt).not.toBeNull();

    // The abandoned pre-branch turns are not on the leaf path and stay out.
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
    expect(stored.map((m) => m.content)).toEqual(["root user", "active assistant"]);

    const contextItems = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    expect(contextItems).toHaveLength(2);
    expect(contextItems.every((item) => item.itemType === "message")).toBe(true);

    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    const sessionFileStats = statSync(sessionFile);
    expect(bootstrapState).not.toBeNull();
    expect(bootstrapState?.sessionFilePath).toBe(sessionFile);
    expect(bootstrapState?.lastSeenSize).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastSeenMtimeMs).toBe(Math.trunc(sessionFileStats.mtimeMs));
    expect(bootstrapState?.lastProcessedOffset).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is idempotent and does not duplicate already bootstrapped sessions", async () => {
    const sessionFile = createSessionFilePath("idempotent");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-idempotent";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    const second = await engine.bootstrap({ sessionId, sessionFile });

    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);
    expect(second.reason).toBe("already bootstrapped");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      2,
    );
  });

  it("does not rewrite prior assistant transcript rows when bootstrap re-instantiates a conversation", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-reinstantiation-replay");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-reinstantiation-replay";

    for (let turn = 1; turn <= 5; turn += 1) {
      appendSessionMessage(sm, {
        role: "user",
        content: [{ type: "text", text: `question ${turn}` }],
      } as AgentMessage);
      appendSessionMessage(sm, {
        role: "assistant",
        content: [{ type: "text", text: `answer ${turn}` }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 10 });

    const conversation = await engineA.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const before = await engineA.getConversationStore().getMessages(conversation!.conversationId);
    await engineA.dispose();

    for (const answer of ["answer 3", "answer 4", "answer 5"]) {
      appendSessionMessage(sm, {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineB = createEngineAtDatabasePath(dbPath);
    const second = await engineB.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);

    const after = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(after.map((message) => `${message.role}\0${message.content}`)).toEqual(
      before.map((message) => `${message.role}\0${message.content}`),
    );

    const seen = new Set<string>();
    const duplicateContentRows = after.filter((message) => {
      const identity = `${message.role}\0${message.content}`;
      if (seen.has(identity)) {
        return true;
      }
      seen.add(identity);
      return false;
    });
    expect(duplicateContentRows).toHaveLength(0);
  });

  it("keeps fresh tool-only rows after dropping a replayed assistant prefix", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-reinstantiation-tool-tail");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-reinstantiation-tool-tail";

    for (let turn = 1; turn <= 5; turn += 1) {
      appendSessionMessage(sm, {
        role: "user",
        content: [{ type: "text", text: `question ${turn}` }],
      } as AgentMessage);
      appendSessionMessage(sm, {
        role: "assistant",
        content: [{ type: "text", text: `answer ${turn}` }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 10 });

    const conversation = await engineA.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const before = await engineA.getConversationStore().getMessages(conversation!.conversationId);
    await engineA.dispose();

    for (const answer of ["answer 3", "answer 4", "answer 5"]) {
      appendSessionMessage(sm, {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }
    appendSessionMessage(sm, {
      role: "toolResult",
      toolCallId: "call_new",
      content: [{ type: "tool_result", tool_use_id: "call_new", output: { ok: true } }],
    } as AgentMessage);

    const engineB = createEngineAtDatabasePath(dbPath);
    const second = await engineB.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(1);
    expect(second.reason).toBe("reconciled missing session messages");

    const after = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(after).toHaveLength(before.length + 1);

    const imported = after[after.length - 1]!;
    expect(imported.role).toBe("tool");
    expect(imported.content).toBe("");

    const parts = await engineB.getConversationStore().getMessageParts(imported.messageId);
    expect(parts.some((part) => part.toolCallId === "call_new")).toBe(true);
  });

  it("keeps legitimate repeated assistant text when the ordering does not match a prior replay", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-repeated-assistant-order");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-repeated-assistant-order";

    for (const [question, answer] of [
      ["question 1", "alpha"],
      ["question 2", "beta"],
      ["question 3", "gamma"],
    ] as const) {
      appendSessionMessage(sm, {
        role: "user",
        content: [{ type: "text", text: question }],
      } as AgentMessage);
      appendSessionMessage(sm, {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 6 });
    await engineA.dispose();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb.prepare(`UPDATE messages SET created_at = '2000-01-01 00:00:00'`).run();
    } finally {
      closeLcmConnection(rawDb);
    }

    for (const answer of ["alpha", "gamma", "beta"]) {
      appendSessionMessage(sm, {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineB = createEngineAtDatabasePath(dbPath);
    const second = await engineB.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(3);
    expect(second.reason).toBe("reconciled missing session messages");

    const conversation = await engineB.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const after = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(after.slice(-3).map((message) => message.content)).toEqual(["alpha", "gamma", "beta"]);
  });

  it("skips replayed transcript lines exactly while importing repeated content under fresh entry ids", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("bootstrap-user-leading-replay");
    const sm = SessionManager.open(sessionFile);
    const sessionId = "bootstrap-user-leading-replay";

    for (const [question, answer] of [
      ["question 1", "alpha"],
      ["question 2", "beta"],
      ["question 3", "gamma"],
    ] as const) {
      appendSessionMessage(sm, {
        role: "user",
        content: [{ type: "text", text: question }],
      } as AgentMessage);
      appendSessionMessage(sm, {
        role: "assistant",
        content: [{ type: "text", text: answer }],
      } as AgentMessage);
    }

    const engineA = createEngineAtDatabasePath(dbPath);
    const first = await engineA.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 6 });

    const conversation = await engineA.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const before = await engineA.getConversationStore().getMessages(conversation!.conversationId);
    await engineA.dispose();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb.prepare(`UPDATE messages SET created_at = '2000-01-01 00:00:00'`).run();
    } finally {
      closeLcmConnection(rawDb);
    }

    // A true replay duplicates JSONL lines verbatim — same entry ids. The
    // entry-id reconciliation must skip every one without tripping guards.
    const replayedLines = readFileSync(sessionFile, "utf8")
      .split("\n")
      .filter((line) => line.includes('"type":"message"') && line.includes("question"));
    expect(replayedLines.length).toBe(3);
    appendFileSync(sessionFile, replayedLines.join("\n") + "\n", "utf8");

    const engineB = createEngineAtDatabasePath(dbPath);
    const replayResult = await engineB.bootstrap({ sessionId, sessionFile });
    expect(replayResult.importedMessages ?? 0).toBe(0);
    const afterReplay = await engineB.getConversationStore().getMessages(conversation!.conversationId);
    expect(afterReplay).toHaveLength(before.length);
    await engineB.dispose();

    // Repeated content written by the host as NEW entries (fresh entry ids)
    // is genuine conversation traffic, not a replay — it must import.
    const smAppend = SessionManager.open(sessionFile);
    for (const question of ["question 1", "question 2", "question 3"]) {
      appendSessionMessage(smAppend, {
        role: "user",
        content: [{ type: "text", text: question }],
      } as AgentMessage);
    }

    const engineC = createEngineAtDatabasePath(dbPath);
    const freshResult = await engineC.bootstrap({ sessionId, sessionFile });
    expect(freshResult.bootstrapped).toBe(true);
    expect(freshResult.importedMessages).toBe(3);

    const after = await engineC.getConversationStore().getMessages(conversation!.conversationId);
    expect(after).toHaveLength(before.length + 3);
  });

  it("skips reopening the transcript when checkpoint stats match", async () => {
    const sessionFile = createSessionFilePath("unchanged-fast-path");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-unchanged-fast-path";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    corruptSessionFilePreservingObservedStats(sessionFile);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);
    expect(second.reason).toBe("already bootstrapped");
  });

  it("preserves ordinary bootstrap behavior when no checkpoint exists", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("missing-checkpoint");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-missing-checkpoint";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
      rawDb
        .prepare(`UPDATE conversations SET bootstrapped_at = NULL WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    corruptSessionFilePreservingObservedStats(sessionFile);

    await expect(engine.bootstrap({ sessionId, sessionFile })).resolves.toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "conversation already has messages",
    });
  });

  it("preserves existing conversation data when the session file rotates", async () => {
    const firstSessionFile = createSessionFilePath("rotation-old");
    const firstManager = SessionManager.open(firstSessionFile);
    appendSessionMessage(firstManager, {
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    appendSessionMessage(firstManager, {
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-rotation";

    const first = await engine.bootstrap({ sessionId, sessionFile: firstSessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_rotation_old",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      content: "old summary",
      tokenCount: 5,
    });
    await engine.getSummaryStore().appendContextSummary(conversation!.conversationId, "sum_rotation_old");

    const rotatedSessionFile = createSessionFilePath("rotation-new");
    const rotatedManager = SessionManager.open(rotatedSessionFile);
    appendSessionMessage(rotatedManager, {
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    appendSessionMessage(rotatedManager, {
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);
    appendSessionMessage(rotatedManager, {
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    appendSessionMessage(rotatedManager, {
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile: rotatedSessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old user",
      "old assistant",
      "new user",
      "new assistant",
    ]);

    const contextItems = await engine.getSummaryStore().getContextItems(conversation!.conversationId);
    expect(contextItems.some((item) => item.itemType === "summary")).toBe(true);
    expect(contextItems.filter((item) => item.itemType === "message")).toHaveLength(4);

    const rotatedBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(rotatedBootstrapState?.sessionFilePath).toBe(rotatedSessionFile);
    expect(await engine.getSummaryStore().getSummary("sum_rotation_old")).not.toBeNull();
  });

  it("preserves conversation history when the session file rotates across a stable sessionKey", async () => {
    const engine = createEngine();
    const firstSessionId = "bootstrap-rotation-session-key-1";
    const secondSessionId = "bootstrap-rotation-session-key-2";
    const sessionKey = "agent:main:test:bootstrap-rotation";
    const firstSessionFile = createSessionFilePath("rotation-session-key-old");
    const firstManager = SessionManager.open(firstSessionFile);
    appendSessionMessage(firstManager, {
      role: "user",
      content: [{ type: "text", text: "old keyed user" }],
    } as AgentMessage);
    appendSessionMessage(firstManager, {
      role: "assistant",
      content: [{ type: "text", text: "old keyed assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const firstConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(firstConversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_rotation_session_key_old",
      conversationId: firstConversation!.conversationId,
      kind: "leaf",
      content: "old keyed summary",
      tokenCount: 5,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(firstConversation!.conversationId, "sum_rotation_session_key_old");

    const rotatedSessionFile = createSessionFilePath("rotation-session-key-new");
    const rotatedManager = SessionManager.open(rotatedSessionFile);
    appendSessionMessage(rotatedManager, {
      role: "user",
      content: [{ type: "text", text: "old keyed user" }],
    } as AgentMessage);
    appendSessionMessage(rotatedManager, {
      role: "assistant",
      content: [{ type: "text", text: "old keyed assistant" }],
    } as AgentMessage);
    appendSessionMessage(rotatedManager, {
      role: "user",
      content: [{ type: "text", text: "new keyed user" }],
    } as AgentMessage);
    appendSessionMessage(rotatedManager, {
      role: "assistant",
      content: [{ type: "text", text: "new keyed assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: rotatedSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.conversationId).toBe(firstConversation!.conversationId);
    expect(conversation!.sessionId).toBe(secondSessionId);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old keyed user",
      "old keyed assistant",
      "new keyed user",
      "new keyed assistant",
    ]);

    const contextItems = await engine.getSummaryStore().getContextItems(conversation!.conversationId);
    expect(contextItems.some((item) => item.itemType === "summary")).toBe(true);
    expect(contextItems.filter((item) => item.itemType === "message")).toHaveLength(4);

    const rotatedBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(rotatedBootstrapState?.sessionFilePath).toBe(rotatedSessionFile);
    expect(await engine.getSummaryStore().getSummary("sum_rotation_session_key_old")).not.toBeNull();
  });

  it("rotates to a fresh conversation when a stable sessionKey resumes on a new transcript after the old file disappears", async () => {
    const engine = createEngine();
    const firstSessionId = "bootstrap-missed-reset-fallback-1";
    const secondSessionId = "bootstrap-missed-reset-fallback-2";
    const sessionKey = "agent:main:test:bootstrap-missed-reset-fallback";
    const firstSessionFile = createSessionFilePath("missed-reset-fallback-old");
    const firstManager = SessionManager.open(firstSessionFile);
    appendSessionMessage(firstManager, {
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    appendSessionMessage(firstManager, {
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_missed_reset_fallback_old",
      conversationId: originalConversation!.conversationId,
      kind: "leaf",
      content: "old summary",
      tokenCount: 5,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(originalConversation!.conversationId, "sum_missed_reset_fallback_old");

    rmSync(firstSessionFile, { force: true });

    const secondSessionFile = createSessionFilePath("missed-reset-fallback-new");
    const secondManager = SessionManager.open(secondSessionFile);
    appendSessionMessage(secondManager, {
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    appendSessionMessage(secondManager, {
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: secondSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(originalConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);
    expect(activeConversation!.active).toBe(true);

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const archivedMessages = await engine.getConversationStore().getMessages(
      originalConversation!.conversationId,
    );
    expect(archivedMessages.map((message) => message.content)).toEqual([
      "old user",
      "old assistant",
    ]);

    const activeMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(activeMessages.map((message) => message.content)).toEqual([
      "new user",
      "new assistant",
    ]);
  });

  it("rotates before assemble when a stable sessionKey points at a pruned transcript", async () => {
    const engine = createEngine();
    const firstSessionId = "assemble-missed-reset-fallback-1";
    const secondSessionId = "assemble-missed-reset-fallback-2";
    const sessionKey = "agent:main:test:assemble-missed-reset-fallback";
    const firstSessionFile = createSessionFilePath("assemble-missed-reset-fallback-old");
    writeLeafTranscript(firstSessionFile, [
      { role: "user", content: "what model produced this response?" },
      { role: "assistant", content: "openai-codex/gpt-5.5" },
    ]);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    rmSync(firstSessionFile, { force: true });

    const newSessionFile = createSessionFilePath("assemble-missed-reset-fallback-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new live prompt" },
      { role: "assistant", content: "new assistant reply" },
    ]);
    const liveMessages = [makeMessage({ role: "user", content: "new live prompt" })];
    const assembled = await engine.assemble({
      sessionId: secondSessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget: 4_096,
    });

    expect(assembled.messages).toEqual(liveMessages);
    expect(
      assembled.messages.some((message) => message.content === "openai-codex/gpt-5.5"),
    ).toBe(false);

    const activeConversationBeforeAfterTurn = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversationBeforeAfterTurn).toBeNull();

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new assistant reply" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(originalConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);
    expect(activeConversation!.active).toBe(true);

    const storedActiveMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(storedActiveMessages.map((message) => message.content)).toEqual([
      "new live prompt",
      "new assistant reply",
    ]);
  });

  it("preserves the active conversation when the tracked transcript stat fails for a non-missing reason", async () => {
    const engine = createEngine();
    const firstSessionId = "bootstrap-stat-failure-fallback-1";
    const secondSessionId = "bootstrap-stat-failure-fallback-2";
    const sessionKey = "agent:main:test:bootstrap-stat-failure-fallback";
    const firstSessionFile = createSessionFilePath("stat-failure-fallback-old");
    const firstManager = SessionManager.open(firstSessionFile);
    appendSessionMessage(firstManager, {
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    appendSessionMessage(firstManager, {
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_stat_failure_fallback_old",
      conversationId: originalConversation!.conversationId,
      kind: "leaf",
      content: "old summary",
      tokenCount: 5,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(originalConversation!.conversationId, "sum_stat_failure_fallback_old");

    const secondSessionFile = createSessionFilePath("stat-failure-fallback-new");
    const secondManager = SessionManager.open(secondSessionFile);
    appendSessionMessage(secondManager, {
      role: "user",
      content: [{ type: "text", text: "old user" }],
    } as AgentMessage);
    appendSessionMessage(secondManager, {
      role: "assistant",
      content: [{ type: "text", text: "old assistant" }],
    } as AgentMessage);
    appendSessionMessage(secondManager, {
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    appendSessionMessage(secondManager, {
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const firstSessionDir = dirname(firstSessionFile);
    const firstSessionDirMode = statSync(firstSessionDir).mode & 0o777;
    chmodSync(firstSessionDir, 0o000);

    let second: Awaited<ReturnType<LcmContextEngine["bootstrap"]>>;
    try {
      second = await engine.bootstrap({
        sessionId: secondSessionId,
        sessionKey,
        sessionFile: secondSessionFile,
      });
    } finally {
      chmodSync(firstSessionDir, firstSessionDirMode);
    }

    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation!.conversationId).toBe(originalConversation!.conversationId);
    expect(conversation!.sessionId).toBe(secondSessionId);
    expect(conversation!.active).toBe(true);

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.archivedAt).toBeNull();

    const storedMessages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedMessages.map((message) => message.content)).toEqual([
      "old user",
      "old assistant",
      "new user",
      "new assistant",
    ]);

    expect(await engine.getSummaryStore().getSummary("sum_stat_failure_fallback_old")).not.toBeNull();
  });

  it("does not reapply bootstrapMaxTokens after session file rotation", async () => {
    const engine = createEngineWithConfig({ bootstrapMaxTokens: 250 });
    const firstSessionId = "bootstrap-rotation-full-reseed-1";
    const secondSessionId = "bootstrap-rotation-full-reseed-2";
    const sessionKey = "agent:main:test:bootstrap-rotation-full-reseed";
    const firstSessionFile = createSessionFilePath("rotation-full-reseed-old");
    const firstManager = SessionManager.open(firstSessionFile);
    appendSessionMessage(firstManager, {
      role: "user",
      content: [{ type: "text", text: "old seed user" }],
    } as AgentMessage);
    appendSessionMessage(firstManager, {
      role: "assistant",
      content: [{ type: "text", text: "old seed assistant" }],
    } as AgentMessage);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: firstSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const rotatedSessionFile = createSessionFilePath("rotation-full-reseed-new");
    const rotatedManager = SessionManager.open(rotatedSessionFile);
    const originalMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "old seed user" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "old seed assistant" }],
      },
    ] as AgentMessage[];
    for (const message of originalMessages) {
      appendSessionMessage(rotatedManager, message);
    }
    const rotatedMessages = Array.from({ length: 5 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `rotated turn ${index} ${"x".repeat(396)}` }],
    })) as AgentMessage[];
    for (const message of rotatedMessages) {
      appendSessionMessage(rotatedManager, message);
    }

    const second = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: rotatedSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 5,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(
      [...originalMessages, ...rotatedMessages].map(
        (message) => (message.content[0] as { text: string }).text,
      ),
    );
  });

  it("rotates the current transcript in place without replacing the conversation", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage");
    const sessionKey = "agent:main:main";
    const sessionId = "rotate-storage-session";
    const sm = SessionManager.open(sessionFile);
    const originalMessages = [
      { role: "user", content: [{ type: "text", text: "old user 1" }] },
      { role: "assistant", content: [{ type: "text", text: "old assistant 1" }] },
      { role: "user", content: [{ type: "text", text: "old user 2" }] },
      { role: "assistant", content: [{ type: "text", text: "old assistant 2" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    for (const message of originalMessages) {
      appendSessionMessage(sm, message);
    }

    const engine = createEngineWithConfig({ freshTailCount: 2 });

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 6,
    });

    const original = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(original).not.toBeNull();
    const originalStoredMessages = await engine.getConversationStore().getMessages(original!.conversationId);

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_rotate_old_history",
      conversationId: original!.conversationId,
      kind: "leaf",
      content: "summarized old history",
      tokenCount: 12,
    });
    await engine.getSummaryStore().linkSummaryToMessages(
      "sum_rotate_old_history",
      originalStoredMessages.slice(0, 4).map((message) => message.messageId),
    );
    await engine.getSummaryStore().replaceContextRangeWithSummary({
      conversationId: original!.conversationId,
      startOrdinal: 0,
      endOrdinal: 3,
      summaryId: "sum_rotate_old_history",
    });

    const originalSize = statSync(sessionFile).size;
    const rotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(rotate).toEqual({
      kind: "rotated",
      conversationId: original!.conversationId,
      preservedTailMessageCount: 2,
      checkpointSize: statSync(sessionFile).size,
      bytesRemoved: expect.any(Number),
    });
    expect(rotate.kind === "rotated" ? rotate.bytesRemoved : 0).toBeGreaterThan(0);
    expect(statSync(sessionFile).size).toBeLessThan(originalSize);

    const active = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
    expect(active?.conversationId).toBe(original!.conversationId);
    expect(await engine.getConversationStore().getMessageCount(active!.conversationId)).toBe(6);
    expect(await engine.getSummaryStore().getSummary("sum_rotate_old_history")).not.toBeNull();

    const rotatedBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(original!.conversationId);
    expect(rotatedBootstrapState?.sessionFilePath).toBe(sessionFile);
    expect(rotatedBootstrapState?.lastProcessedOffset).toBe(statSync(sessionFile).size);
    expect(rotatedBootstrapState?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

    const rotatedManager = SessionManager.open(sessionFile);
    const rotatedBranchMessages = rotatedManager
      .getBranch()
      .filter((entry) => entry.type === "message")
      .map((entry) => entry.message as { content: Array<{ text: string }> });
    expect(rotatedBranchMessages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "tail user",
      "tail assistant",
    ]);

    const checkpointHit = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(checkpointHit.bootstrapped).toBe(false);
    expect(checkpointHit.importedMessages).toBe(0);

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "new user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "new assistant" }],
    } as AgentMessage);

    const appended = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(appended).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const storedMessages = await engine.getConversationStore().getMessages(original!.conversationId);
    expect(storedMessages.map((message) => message.content)).toEqual([
      "old user 1",
      "old assistant 1",
      "old user 2",
      "old assistant 2",
      "tail user",
      "tail assistant",
      "new user",
      "new assistant",
    ]);
  });

  it("summarizes raw context outside the fresh tail before rotating the transcript", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-leaf-coverage");
    const sessionKey = "agent:main:rotate-leaf-coverage";
    const sessionId = "rotate-storage-leaf-coverage-session";
    const sm = SessionManager.open(sessionFile);
    const originalMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "CRABPOT_LCM_FACT is blue-lantern-42." }],
      },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "user", content: [{ type: "text", text: "older detail before rotate" }] },
      { role: "assistant", content: [{ type: "text", text: "older answer before rotate" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    for (const message of originalMessages) {
      appendSessionMessage(sm, message);
    }

    const engine = createEngineWithConfig({
      freshTailCount: 2,
      leafChunkTokens: 1,
      leafMinFanout: 1,
    });

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 6,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const contextItemsBeforeRotate = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    expect(contextItemsBeforeRotate.filter((item) => item.itemType === "message")).toHaveLength(6);

    const rotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(rotate).toMatchObject({
      kind: "rotated",
      conversationId: conversation!.conversationId,
      preservedTailMessageCount: 2,
    });
    const contextItems = await engine.getSummaryStore().getContextItems(conversation!.conversationId);
    expect(contextItems.slice(0, -2).every((item) => item.itemType === "summary")).toBe(true);
    expect(contextItems.slice(-2).map((item) => item.itemType)).toEqual(["message", "message"]);
    const summaryItem = contextItems.find((item) => item.itemType === "summary");
    expect(summaryItem?.summaryId).toBeTypeOf("string");
    const summary = await engine.getSummaryStore().getSummary(summaryItem!.summaryId!);
    expect(summary?.content).toContain("blue-lantern-42");

    const storedMessages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedMessages.map((message) => message.content)).toEqual(
      originalMessages.map((message) => (message.content[0] as { text: string }).text),
    );

    const rotatedBranchMessages = readSessionMessages(sessionFile);
    expect(rotatedBranchMessages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "tail user",
      "tail assistant",
    ]);

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages: rotatedBranchMessages,
      tokenBudget: 4000,
      prompt: "What is CRABPOT_LCM_FACT?",
    });
    expect(assembled.messages.some((message) => message.content.includes("blue-lantern-42"))).toBe(true);
  });

  it("records rotate summary auth failures in the compaction circuit breaker", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-auth-breaker");
    const sessionKey = "agent:main:rotate-auth-breaker";
    const sessionId = "rotate-storage-auth-breaker-session";
    const sm = SessionManager.open(sessionFile);
    for (const message of [
      { role: "user", content: [{ type: "text", text: "older detail before rotate" }] },
      { role: "assistant", content: [{ type: "text", text: "older answer before rotate" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[]) {
      appendSessionMessage(sm, message);
    }

    const complete = vi.fn(async () => {
      throw new LcmProviderAuthError({
        provider: "test-provider",
        model: "test-model",
        failure: {
          statusCode: 401,
          message: "test auth failure",
          missingModelRequestScope: false,
        },
      });
    });
    const engine = createEngineWithDeps(
      {
        summaryProvider: "test-provider",
        summaryModel: "test-model",
        freshTailCount: 2,
        leafChunkTokens: 1,
        leafMinFanout: 1,
        circuitBreakerThreshold: 1,
      },
      { complete },
    );

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });

    const firstRotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(expectUnavailableRotate(firstRotate).reason).toContain("summary provider rejected authentication");
    expect(complete).toHaveBeenCalledTimes(1);

    const secondRotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(expectUnavailableRotate(secondRotate).reason).toContain("summary provider circuit breaker is open");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("scopes rotate summarization spend guards per session", async () => {
    const complete = vi.fn(async () => ({
      content: [{ type: "text", text: "rotate summary" }],
    }));
    const engine = createEngineWithDeps(
      {
        summaryProvider: "test-provider",
        summaryModel: "test-model",
        freshTailCount: 2,
        leafChunkTokens: 1,
        leafMinFanout: 1,
        summaryMaxCallsPerWindow: 1,
        summaryCallWindowMs: 10 * 60 * 1000,
        summarySpendBackoffMs: 30 * 60 * 1000,
      },
      { complete },
    );

    for (const suffix of ["one", "two"]) {
      const sessionFile = createSessionFilePath(`lcm-rotate-spend-scope-${suffix}`);
      const sessionKey = `agent:main:rotate-spend-scope-${suffix}`;
      const sessionId = `rotate-spend-scope-${suffix}-session`;
      const sm = SessionManager.open(sessionFile);
      for (const message of [
        { role: "user", content: [{ type: "text", text: `older detail ${suffix}` }] },
        { role: "assistant", content: [{ type: "text", text: `tail assistant ${suffix}` }] },
        { role: "user", content: [{ type: "text", text: `tail user ${suffix}` }] },
      ] as AgentMessage[]) {
        appendSessionMessage(sm, message);
      }

      await engine.bootstrap({ sessionId, sessionKey, sessionFile });

      const rotate = await engine.rotateSessionStorage({
        sessionId,
        sessionKey,
        sessionFile,
      });
      expect(rotate).toMatchObject({ kind: "rotated" });
    }

    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("returns rotate unavailable when summarization spend backoff opens", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-spend-backoff");
    const sessionKey = "agent:main:rotate-spend-backoff";
    const sessionId = "rotate-spend-backoff-session";
    const sm = SessionManager.open(sessionFile);
    for (const message of [
      { role: "user", content: [{ type: "text", text: "older detail before rotate" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
    ] as AgentMessage[]) {
      appendSessionMessage(sm, message);
    }

    const engine = createEngineWithConfig({
      freshTailCount: 2,
      leafChunkTokens: 1,
      leafMinFanout: 1,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        compactLeaf: (input: unknown) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "compactLeaf").mockRejectedValue(
      new LcmSummarySpendLimitError({
        scopeKey: "compaction:rotate-spend-backoff-session",
        backoffUntil: new Date("2026-05-31T13:00:00.000Z"),
      }),
    );

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });

    const rotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(expectUnavailableRotate(rotate).reason).toContain("summary spend backoff is open");
  });

  it("reconciles unimported transcript messages before rotate summary coverage", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-reconcile-before-coverage");
    const sessionKey = "agent:main:rotate-reconcile-before-coverage";
    const sessionId = "rotate-storage-reconcile-before-coverage-session";
    const originalMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "CRABPOT_LCM_FACT is blue-lantern-42." }],
      },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "user", content: [{ type: "text", text: "older detail before rotate" }] },
      { role: "assistant", content: [{ type: "text", text: "older answer before rotate" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    const sm = SessionManager.open(sessionFile);
    for (const message of originalMessages.slice(0, 2)) {
      appendSessionMessage(sm, message);
    }

    const engine = createEngineWithConfig({
      freshTailCount: 2,
      leafChunkTokens: 1,
      leafMinFanout: 1,
    });

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });
    for (const message of originalMessages.slice(2)) {
      appendSessionMessage(sm, message);
    }

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const contextItemsBeforeRotate = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    expect(contextItemsBeforeRotate.filter((item) => item.itemType === "message")).toHaveLength(2);

    const rotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(rotate).toMatchObject({
      kind: "rotated",
      conversationId: conversation!.conversationId,
      preservedTailMessageCount: 2,
    });

    const contextItems = await engine.getSummaryStore().getContextItems(conversation!.conversationId);
    expect(contextItems.slice(0, -2).every((item) => item.itemType === "summary")).toBe(true);
    expect(contextItems.slice(-2).map((item) => item.itemType)).toEqual(["message", "message"]);
    const summaryItem = contextItems.find((item) => item.itemType === "summary");
    expect(summaryItem?.summaryId).toBeTypeOf("string");
    const summary = await engine.getSummaryStore().getSummary(summaryItem!.summaryId!);
    expect(summary?.content).toContain("blue-lantern-42");

    const storedMessages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedMessages.map((message) => message.content)).toEqual(
      originalMessages.map((message) => (message.content[0] as { text: string }).text),
    );

    const rotatedBranchMessages = readSessionMessages(sessionFile);
    expect(rotatedBranchMessages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "tail user",
      "tail assistant",
    ]);

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages: rotatedBranchMessages,
      tokenBudget: 4000,
      prompt: "What is CRABPOT_LCM_FACT?",
    });
    expect(assembled.messages.some((message) => message.content.includes("blue-lantern-42"))).toBe(true);
  });

  it("imports checkpoint-missing transcript history before rotate summary coverage", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-checkpoint-missing-coverage");
    const sessionKey = "agent:main:rotate-checkpoint-missing-coverage";
    const sessionId = "rotate-storage-checkpoint-missing-coverage-session";
    const engine = createEngineWithConfig({
      freshTailCount: 2,
      leafChunkTokens: 1,
      leafMinFanout: 1,
    });

    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({
        role: "user",
        content: "Sender metadata\n\nCRABPOT_LCM_FACT is blue-lantern-42.",
      }),
    });

    const transcriptMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "CRABPOT_LCM_FACT is blue-lantern-42." }],
      },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "user", content: [{ type: "text", text: "older detail before rotate" }] },
      { role: "assistant", content: [{ type: "text", text: "older answer before rotate" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    const sm = SessionManager.open(sessionFile);
    for (const message of transcriptMessages) {
      appendSessionMessage(sm, message);
    }

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();

    const rotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });
    expect(rotate).toMatchObject({
      kind: "rotated",
      conversationId: conversation!.conversationId,
      preservedTailMessageCount: 2,
    });

    const contextItems = await engine.getSummaryStore().getContextItems(conversation!.conversationId);
    expect(contextItems.slice(0, -2).every((item) => item.itemType === "summary")).toBe(true);
    expect(contextItems.slice(-2).map((item) => item.itemType)).toEqual(["message", "message"]);
    const summaryItem = contextItems.find((item) => item.itemType === "summary");
    expect(summaryItem?.summaryId).toBeTypeOf("string");
    const summary = await engine.getSummaryStore().getSummary(summaryItem!.summaryId!);
    expect(summary?.content).toContain("blue-lantern-42");

    const storedMessages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedMessages.map((message) => message.content)).toEqual([
      "Sender metadata\n\nCRABPOT_LCM_FACT is blue-lantern-42.",
      ...transcriptMessages.map((message) => (message.content[0] as { text: string }).text),
    ]);

    const rotatedBranchMessages = readSessionMessages(sessionFile);
    expect(rotatedBranchMessages.map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "tail user",
      "tail assistant",
    ]);
  });

  it("refuses to rotate when transcript reconciliation has no safe overlap", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-no-overlap");
    const sessionKey = "agent:main:rotate-no-overlap";
    const sessionId = "rotate-storage-no-overlap-session";
    const transcriptMessages = [
      { role: "user", content: [{ type: "text", text: "uncovered old user" }] },
      { role: "assistant", content: [{ type: "text", text: "uncovered old assistant" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    writeLeafTranscriptMessages(sessionFile, transcriptMessages);
    const originalTranscript = readFileSync(sessionFile, "utf8");
    const engine = createEngineWithConfig({ freshTailCount: 2 });

    const conversation = await engine.getConversationStore().createConversation({
      sessionId,
      sessionKey,
    });
    expect(await engine.getConversationStore().getMessageCount(conversation.conversationId)).toBe(0);

    const rotate = await engine.rotateSessionStorage({
      sessionId,
      sessionKey,
      sessionFile,
    });

    expect(expectUnavailableRotate(rotate).reason).toContain("could not prove transcript coverage");
    expect(readFileSync(sessionFile, "utf8")).toBe(originalTranscript);
  });

  it("takes the rotate backup after covering transcript-only rows and before rewrite", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-backup-before-reconcile");
    const sessionKey = "agent:main:rotate-backup-before-reconcile";
    const sessionId = "rotate-storage-backup-before-reconcile-session";
    const transcriptMessages = [
      {
        role: "user",
        content: [{ type: "text", text: "CRABPOT_LCM_FACT is blue-lantern-42." }],
      },
      { role: "assistant", content: [{ type: "text", text: "noted" }] },
      { role: "user", content: [{ type: "text", text: "older detail before rotate" }] },
      { role: "assistant", content: [{ type: "text", text: "older answer before rotate" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    const sm = SessionManager.open(sessionFile);
    for (const message of transcriptMessages.slice(0, 2)) {
      appendSessionMessage(sm, message);
    }

    const engine = createEngineWithConfig({
      freshTailCount: 2,
      leafChunkTokens: 1,
      leafMinFanout: 1,
    });
    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });
    for (const message of transcriptMessages.slice(2)) {
      appendSessionMessage(sm, message);
    }

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();

    const rotate = await engine.rotateSessionStorageWithBackup({
      sessionId,
      sessionKey,
      sessionFile,
      lockTimeoutMs: 1_000,
    });
    expect(rotate).toMatchObject({
      kind: "rotated",
      currentConversationId: conversation!.conversationId,
      currentMessageCount: 2,
      preservedTailMessageCount: 2,
    });
    if (rotate.kind !== "rotated") {
      throw new Error(`Expected rotate to succeed, received ${rotate.kind}`);
    }

    const backupDb = createLcmDatabaseConnection(rotate.backupPath);
    try {
      const backedUpMessageCount = backupDb
        .prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`)
        .get(conversation!.conversationId) as { count: number };
      expect(backedUpMessageCount.count).toBe(6);
    } finally {
      closeLcmConnection(backupDb);
    }

    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(6);
    expect(readSessionMessages(sessionFile).map((message) => (message.content[0] as { text: string }).text)).toEqual([
      "tail user",
      "tail assistant",
    ]);
  });

  it("uses stored compaction telemetry to summarize raw context before automatic rotate", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-telemetry-model");
    const sessionKey = "agent:main:rotate-telemetry-model";
    const sessionId = "rotate-storage-telemetry-model-session";
    const transcriptMessages = [
      { role: "user", content: [{ type: "text", text: "older fact before telemetry rotate" }] },
      { role: "assistant", content: [{ type: "text", text: "older answer before telemetry rotate" }] },
      { role: "user", content: [{ type: "text", text: "tail user" }] },
      { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
    ] as AgentMessage[];
    const sm = SessionManager.open(sessionFile);
    for (const message of transcriptMessages.slice(0, 2)) {
      appendSessionMessage(sm, message);
    }

    const complete = vi.fn(async () => ({
      content: [{ type: "text", text: "telemetry backed summary" }],
    }));
    const resolveModel = vi.fn((modelRef?: string, providerHint?: string) => ({
      provider: providerHint ?? "fallback",
      model: modelRef ?? "fallback-model",
    }));
    const engine = createEngineWithDeps(
      {
        freshTailCount: 2,
        leafChunkTokens: 1,
        leafMinFanout: 1,
      },
      {
        complete,
        resolveModel,
      },
    );
    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    for (const message of transcriptMessages.slice(2)) {
      appendSessionMessage(sm, message);
    }

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation!.conversationId,
      cacheState: "unknown",
      provider: "openai",
      model: "gpt-5.5",
    });

    const rotate = await engine.rotateSessionStorageWithBackup({
      sessionId,
      sessionKey,
      sessionFile,
      lockTimeoutMs: 1_000,
    });

    expect(rotate).toMatchObject({ kind: "rotated" });
    expect(resolveModel).toHaveBeenCalledWith("gpt-5.5", "openai");
    expect(complete).toHaveBeenCalled();
  });

  it("waits for an in-flight managed transaction before backing up and rotating", async () => {
    const sessionFile = createSessionFilePath("lcm-rotate-storage-wait");
    const sessionManager = SessionManager.inMemory(process.cwd());
    appendSessionMessage(sessionManager, {
      role: "user",
      content: [{ type: "text", text: "existing" }],
    } as AgentMessage);
    writeFileSync(
      sessionFile,
      [
        JSON.stringify(sessionManager.getHeader()),
        ...sessionManager.getBranch().map((entry) => JSON.stringify(entry)),
      ].join("\n") + "\n",
    );
    const engine = createEngine();
    const sessionId = "rotate-storage-wait-session";
    const sessionKey = "agent:main:main";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 1,
    });

    const current = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(current).not.toBeNull();

    let releaseTransaction!: () => void;
    let notifyTransactionStarted!: () => void;
    const transactionStarted = new Promise<void>((resolve) => {
      notifyTransactionStarted = resolve;
    });
    const transactionGate = new Promise<void>((resolve) => {
      releaseTransaction = resolve;
    });

    const pendingTransaction = engine.getConversationStore().withTransaction(async () => {
      const nextSeq = (await engine.getConversationStore().getMaxSeq(current!.conversationId)) + 1;
      await engine.getConversationStore().createMessage({
        conversationId: current!.conversationId,
        seq: nextSeq,
        role: "assistant",
        content: "queued rotate message",
        tokenCount: 3,
      });
      notifyTransactionStarted();
      await transactionGate;
    });

    await transactionStarted;

    let rotateResolved = false;
    const rotatePromise = engine
      .rotateSessionStorageWithBackup({
        sessionId,
        sessionKey,
        sessionFile,
        lockTimeoutMs: 1_000,
      })
      .then((result) => {
        rotateResolved = true;
        return result;
      });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(rotateResolved).toBe(false);

    releaseTransaction();
    await pendingTransaction;

    const rotate = await rotatePromise;
    expect(rotate).toMatchObject({
      kind: "rotated",
      currentConversationId: current!.conversationId,
      currentMessageCount: 2,
      preservedTailMessageCount: 1,
    });
    if (rotate.kind !== "rotated") {
      throw new Error(`Expected rotate to succeed, received ${rotate.kind}`);
    }

    const backupDb = createLcmDatabaseConnection(rotate.backupPath);
    try {
      const backedUpMessageCount = backupDb
        .prepare(`SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ?`)
        .get(current!.conversationId) as { count: number };
      expect(backedUpMessageCount.count).toBe(2);
    } finally {
      closeLcmConnection(backupDb);
    }
  });

  it("reports rotate as unavailable when the session transcript cannot be read", async () => {
    const engine = createEngine();

    const conversation = await engine.getConversationStore().createConversation({
      sessionId: "rotate-unreadable-session",
      sessionKey: "agent:main:main",
    });
    await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "seed",
        tokenCount: 1,
      },
    ]);

    const result = await engine.rotateSessionStorage({
      sessionId: "rotate-unreadable-session",
      sessionKey: "agent:main:main",
      sessionFile: join(tmpdir(), `missing-rotate-transcript-${Date.now()}.jsonl`),
    });

    expect(expectUnavailableRotate(result).reason).toContain("could not rotate the current session transcript");
  });

  it("defers oversized session-file rewrites from afterTurn runtime hooks", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-runtime");
    const messages = createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const beforeSize = statSync(sessionFile).size;
    const databaseDir = mkdtempSync(join(tmpdir(), "lossless-claw-auto-rotate-db-"));
    tempDirs.push(databaseDir);
    const databasePath = join(databaseDir, "lcm.db");
    const latestBackupPath = join(databaseDir, "lcm.db.rotate-latest.bak");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        databasePath,
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-runtime-session";
    const sessionKey = "agent:main:test:auto-rotate-runtime";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });

    const afterSize = statSync(sessionFile).size;
    expect(beforeSize).toBeGreaterThan(1_500);
    expect(afterSize).toBe(beforeSize);
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const skipLog = autoRotateLogs.find((message) =>
      message.includes("phase=runtime action=skip"),
    );
    expect(skipLog).toContain(`sessionId=${sessionId}`);
    expect(skipLog).toContain(`sessionKey=${sessionKey}`);
    expect(skipLog).toContain(`sessionFile=${sessionFile}`);
    expect(skipLog).toContain("sizeBytes=");
    expect(skipLog).toContain("thresholdBytes=1500");
    expect(skipLog).toContain("durationMs=");
    expect(skipLog).toContain("reason=after-turn-session-file-rewrite-deferred-to-startup-or-manual-rotate");
    expect(autoRotateLogs.some((message) => message.includes("phase=runtime action=rotate"))).toBe(false);
    expect(existsSync(latestBackupPath)).toBe(false);
  });

  it("does not directly auto-rotate session files during background maintenance", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-background-maintenance");
    createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const beforeSize = statSync(sessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-background-maintenance-session";
    const sessionKey = "agent:main:test:auto-rotate-background-maintenance";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const afterSize = statSync(sessionFile).size;
    expect(beforeSize).toBeGreaterThan(1_500);
    expect(afterSize).toBe(beforeSize);
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const skipLog = autoRotateLogs.find((message) =>
      message.includes("phase=runtime action=skip"),
    );
    expect(skipLog).toContain(`sessionId=${sessionId}`);
    expect(skipLog).toContain(`sessionKey=${sessionKey}`);
    expect(skipLog).toContain(`sessionFile=${sessionFile}`);
    expect(skipLog).toContain("sizeBytes=");
    expect(skipLog).toContain("thresholdBytes=1500");
    expect(skipLog).toContain("durationMs=");
    expect(skipLog).toContain("reason=runtime-session-file-rewrite-deferred-to-startup-or-manual-rotate");
    expect(autoRotateLogs.some((message) => message.includes("phase=runtime action=rotate"))).toBe(false);
  });

  it("does not rewrite oversized session files from maintain runtime checks", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-maintain-active-turn");
    createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-maintain-active-turn-session";
    const sessionKey = "agent:main:test:auto-rotate-maintain-active-turn";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {},
    });

    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("phase=runtime action=skip"),
        expect.stringContaining("reason=runtime-session-file-rewrite-deferred-to-startup-or-manual-rotate"),
      ]),
    );
  });

  it("leaves below-threshold session files alone while logging the decision", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-below-threshold");
    const messages = createBulkySession(sessionFile, 4);
    const beforeSize = statSync(sessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: beforeSize + 1_000,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-below-session";
    const sessionKey = "agent:main:test:auto-rotate-below";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });

    expect(statSync(sessionFile).size).toBe(beforeSize);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("phase=runtime action=skip"),
        expect.stringContaining("reason=below-threshold"),
      ]),
    );
  });

  it("skips ignored, stateless, and untracked runtime sessions", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-skip-guards");
    const messages = createBulkySession(sessionFile, 10);
    const original = readFileSync(sessionFile, "utf8");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        ignoreSessionPatterns: ["agent:*:cron:**"],
        statelessSessionPatterns: ["agent:*:subagent:**"],
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );

    await engine.afterTurn({
      sessionId: "auto-rotate-ignored-session",
      sessionKey: "agent:main:cron:nightly",
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });
    await engine.afterTurn({
      sessionId: "auto-rotate-stateless-session",
      sessionKey: "agent:main:subagent:worker",
      sessionFile,
      messages,
      prePromptMessageCount: messages.length,
    });
    await engine.afterTurn({
      sessionId: "auto-rotate-untracked-session",
      sessionKey: "agent:main:test:auto-rotate-untracked",
      sessionFile,
      messages: [messages[0]!],
      prePromptMessageCount: 0,
      isHeartbeat: true,
    });

    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("reason=session-excluded"),
        expect.stringContaining("reason=stateless-session"),
        expect.stringContaining("reason=no-active-conversation"),
      ]),
    );
  });

  it("startup scan rotates oversized active conversations with checkpointed files", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-startup");
    const messages = createBulkySession(sessionFile, 14);
    const beforeSize = statSync(sessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const sessionId = "auto-rotate-startup-session";
    const sessionKey = "agent:main:test:auto-rotate-startup";
    const listStartupSessionFileCandidates = vi.fn(async () => [
      { sessionId, sessionKey, sessionFile },
    ]);
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "rotate",
          runtime: "off",
        },
      },
      { log, listStartupSessionFileCandidates },
    );

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.autoRotateManagedSessionFilesAtStartup();

    expect(beforeSize).toBeGreaterThan(1_500);
    expect(statSync(sessionFile).size).toBeLessThan(beforeSize);
    const autoRotateLogs = log.info.mock.calls.map(([message]) => String(message));
    expect(autoRotateLogs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("phase=startup action=rotate"),
      ]),
    );
    expect(autoRotateLogs.some((message) => message.includes("backupPath="))).toBe(false);
    const summaryLog = autoRotateLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("backupCreated=0");
    expect(readSessionMessages(sessionFile)).toHaveLength(1);
    expect(readSessionMessages(sessionFile)[0]?.role).toBe(messages[messages.length - 1]?.role);
  });

  it("startup scan ignores stale active LCM conversations outside indexed candidates", async () => {
    const indexedSessionFile = createSessionFilePath("auto-rotate-indexed-startup");
    const staleSessionFile = createSessionFilePath("auto-rotate-stale-startup");
    createBulkySession(indexedSessionFile, 14);
    createBulkySession(staleSessionFile, 14);
    const indexedBeforeSize = statSync(indexedSessionFile).size;
    const staleBeforeSize = statSync(staleSessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const indexedSessionId = "auto-rotate-indexed-session";
    const indexedSessionKey = "agent:main:test:auto-rotate-indexed";
    const staleSessionId = "auto-rotate-stale-session";
    const staleSessionKey = "agent:old:test:auto-rotate-stale";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "rotate",
          runtime: "off",
        },
      },
      {
        log,
        listStartupSessionFileCandidates: vi.fn(async () => [
          {
            sessionId: indexedSessionId,
            sessionKey: indexedSessionKey,
            sessionFile: indexedSessionFile,
          },
        ]),
      },
    );

    await engine.bootstrap({
      sessionId: indexedSessionId,
      sessionKey: indexedSessionKey,
      sessionFile: indexedSessionFile,
    });
    await engine.bootstrap({
      sessionId: staleSessionId,
      sessionKey: staleSessionKey,
      sessionFile: staleSessionFile,
    });
    await engine.autoRotateManagedSessionFilesAtStartup();

    expect(statSync(indexedSessionFile).size).toBeLessThan(indexedBeforeSize);
    expect(statSync(staleSessionFile).size).toBe(staleBeforeSize);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    expect(autoRotateLogs.filter((message) => message.includes("action=rotate"))).toHaveLength(1);
    const summaryLog = autoRotateLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("scanned=1");
    expect(summaryLog).toContain("eligible=1");
    expect(summaryLog).toContain("rotated=1");
    expect(summaryLog).toContain("skipped=0");
  });

  it("startup scan logs one compact summary for quiet skips", async () => {
    const rotateSessionFile = createSessionFilePath("auto-rotate-summary-rotate");
    const belowSessionFile = createSessionFilePath("auto-rotate-summary-below");
    const missingSessionFile = createSessionFilePath("auto-rotate-summary-missing");
    createBulkySession(rotateSessionFile, 14);
    createBulkySession(belowSessionFile, 4);
    const belowThresholdBytes = statSync(belowSessionFile).size + 500;
    rmSync(missingSessionFile, { force: true });
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const rotateSessionId = "auto-rotate-summary-rotate-session";
    const rotateSessionKey = "agent:main:test:auto-rotate-summary-rotate";
    const belowSessionId = "auto-rotate-summary-below-session";
    const belowSessionKey = "agent:main:test:auto-rotate-summary-below";
    const missingSessionId = "auto-rotate-summary-missing-session";
    const missingSessionKey = "agent:main:test:auto-rotate-summary-missing";
    const noBootstrapSessionId = "auto-rotate-summary-no-bootstrap-session";
    const noBootstrapSessionKey = "agent:main:test:auto-rotate-summary-no-bootstrap";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: belowThresholdBytes,
          startup: "rotate",
          runtime: "off",
        },
      },
      {
        log,
        listStartupSessionFileCandidates: vi.fn(async () => [
          { sessionId: rotateSessionId, sessionKey: rotateSessionKey, sessionFile: rotateSessionFile },
          { sessionId: belowSessionId, sessionKey: belowSessionKey, sessionFile: belowSessionFile },
          { sessionId: missingSessionId, sessionKey: missingSessionKey, sessionFile: missingSessionFile },
          {
            sessionId: noBootstrapSessionId,
            sessionKey: noBootstrapSessionKey,
            sessionFile: createSessionFilePath("auto-rotate-summary-no-bootstrap"),
          },
        ]),
      },
    );

    await engine.bootstrap({
      sessionId: rotateSessionId,
      sessionKey: rotateSessionKey,
      sessionFile: rotateSessionFile,
    });
    await engine.bootstrap({
      sessionId: belowSessionId,
      sessionKey: belowSessionKey,
      sessionFile: belowSessionFile,
    });
    const missingConversation = await engine.getConversationStore().createConversation({
      sessionId: missingSessionId,
      sessionKey: missingSessionKey,
    });
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: missingConversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 2_000,
      lastSeenMtimeMs: Date.now(),
      lastProcessedOffset: 0,
    });
    await engine.getConversationStore().createConversation({
      sessionId: noBootstrapSessionId,
      sessionKey: noBootstrapSessionKey,
    });
    await engine.autoRotateManagedSessionFilesAtStartup();

    const autoRotateInfoLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const autoRotateWarnLogs = log.warn.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    expect(autoRotateInfoLogs.filter((message) => message.includes("action=summary"))).toHaveLength(1);
    expect(autoRotateInfoLogs.filter((message) => message.includes("action=skip"))).toHaveLength(0);
    expect(autoRotateWarnLogs).toHaveLength(0);
    const summaryLog = autoRotateInfoLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("scanned=4");
    expect(summaryLog).toContain("eligible=1");
    expect(summaryLog).toContain("rotated=1");
    expect(summaryLog).toContain("warned=0");
    expect(summaryLog).toContain("skipped=3");
  });

  it("startup batch creates one pre-rotation backup for multiple rotations", async () => {
    const firstSessionFile = createSessionFilePath("auto-rotate-batch-first");
    const secondSessionFile = createSessionFilePath("auto-rotate-batch-second");
    createBulkySession(firstSessionFile, 14);
    createBulkySession(secondSessionFile, 14);
    const firstBeforeSize = statSync(firstSessionFile).size;
    const secondBeforeSize = statSync(secondSessionFile).size;
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const firstSessionId = "auto-rotate-batch-first-session";
    const firstSessionKey = "agent:main:test:auto-rotate-batch-first";
    const secondSessionId = "auto-rotate-batch-second-session";
    const secondSessionKey = "agent:main:test:auto-rotate-batch-second";
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: true,
          sizeBytes: 1_500,
          startup: "rotate",
          runtime: "off",
        },
      },
      {
        log,
        listStartupSessionFileCandidates: vi.fn(async () => [
          { sessionId: firstSessionId, sessionKey: firstSessionKey, sessionFile: firstSessionFile },
          { sessionId: secondSessionId, sessionKey: secondSessionKey, sessionFile: secondSessionFile },
        ]),
      },
    );

    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey: firstSessionKey,
      sessionFile: firstSessionFile,
    });
    await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey: secondSessionKey,
      sessionFile: secondSessionFile,
    });
    const firstConversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId: firstSessionId, sessionKey: firstSessionKey });
    const secondConversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId: secondSessionId, sessionKey: secondSessionKey });

    await engine.autoRotateManagedSessionFilesAtStartup();

    expect(statSync(firstSessionFile).size).toBeLessThan(firstBeforeSize);
    expect(statSync(secondSessionFile).size).toBeLessThan(secondBeforeSize);
    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    const rotateLogs = autoRotateLogs.filter((message) =>
      message.includes("phase=startup action=rotate"),
    );
    expect(rotateLogs).toHaveLength(2);
    const backupPaths = new Set(
      rotateLogs.map((message) => message.match(/backupPath=([^ ]+)/)?.[1]).filter(Boolean),
    );
    expect(backupPaths.size).toBe(1);
    const backupPath = Array.from(backupPaths)[0]!;
    const backupDb = createLcmDatabaseConnection(backupPath);
    try {
      const firstBackupState = backupDb
        .prepare(`SELECT last_seen_size AS lastSeenSize FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .get(firstConversation!.conversationId) as { lastSeenSize: number } | undefined;
      const secondBackupState = backupDb
        .prepare(`SELECT last_seen_size AS lastSeenSize FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .get(secondConversation!.conversationId) as { lastSeenSize: number } | undefined;
      expect(firstBackupState?.lastSeenSize).toBe(firstBeforeSize);
      expect(secondBackupState?.lastSeenSize).toBe(secondBeforeSize);
    } finally {
      closeLcmConnection(backupDb);
    }
    const summaryLog = autoRotateLogs.find((message) => message.includes("action=summary"));
    expect(summaryLog).toContain("scanned=2");
    expect(summaryLog).toContain("eligible=2");
    expect(summaryLog).toContain("rotated=2");
    expect(summaryLog).toContain("backupCreated=1");
  });

  it("does not repeatedly rewrite oversized transcripts during runtime deferral", async () => {
    const sessionFile = createSessionFilePath("auto-rotate-no-loop");
    createBulkySession(sessionFile, 14);
    const original = readFileSync(sessionFile, "utf8");
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        freshTailCount: 1,
        autoRotateSessionFiles: {
          enabled: true,
          createBackups: false,
          sizeBytes: 1_500,
          startup: "off",
          runtime: "rotate",
        },
      },
      { log },
    );
    const sessionId = "auto-rotate-no-loop-session";
    const sessionKey = "agent:main:test:auto-rotate-no-loop";

    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });
    await engine.maintain({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {
        allowDeferredCompactionExecution: true,
      },
    });

    const autoRotateLogs = log.info.mock.calls
      .map(([message]) => String(message))
      .filter((message) => message.startsWith("[lcm] auto-rotate:"));
    expect(readFileSync(sessionFile, "utf8")).toBe(original);
    expect(autoRotateLogs.filter((message) => message.includes("action=rotate"))).toHaveLength(0);
    expect(
      autoRotateLogs.filter((message) =>
        message.includes("reason=runtime-session-file-rewrite-deferred-to-startup-or-manual-rotate"),
      ),
    ).toHaveLength(2);
  });

  it("reconciles missing tail messages when JSONL advanced past LCM", async () => {
    const sessionFile = createSessionFilePath("reconcile-tail");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const firstBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(firstBootstrapState).not.toBeNull();

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "lost user turn" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "lost assistant turn" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(2);
    expect(second.reason).toBe("reconciled missing session messages");

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "lost user turn",
      "lost assistant turn",
    ]);

    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    const sessionFileStats = statSync(sessionFile);
    expect(bootstrapState).not.toBeNull();
    expect(bootstrapState?.lastSeenSize).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastSeenMtimeMs).toBe(Math.trunc(sessionFileStats.mtimeMs));
    expect(bootstrapState?.lastProcessedOffset).toBe(sessionFileStats.size);
    expect(bootstrapState?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);
    expect(bootstrapState?.lastSeenSize).toBeGreaterThan(firstBootstrapState!.lastSeenSize);
    expect(bootstrapState?.lastProcessedEntryHash).not.toBe(firstBootstrapState!.lastProcessedEntryHash);
  });

  it("skips synthetic heartbeat polls during bootstrap full-reconcile", async () => {
    const sessionFile = createSessionFilePath("bootstrap-reconcile-heartbeat-polls");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, makeMessage({ role: "user", content: "seed user" }));
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "seed assistant" }));

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-heartbeat-polls";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine
      .getSummaryStore()
      .upsertConversationBootstrapState({
        conversationId: conversation!.conversationId,
        sessionFilePath: sessionFile,
        lastSeenSize: 1,
        lastSeenMtimeMs: 0,
        lastProcessedOffset: 1,
        lastProcessedEntryHash: "mismatch",
      });

    for (let index = 0; index < 4; index += 1) {
      appendSessionMessage(sm, makeMessage({ role: "user", content: "[OpenClaw heartbeat poll]" }));
    }

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "already bootstrapped",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["seed user", "seed assistant"]);
  });

  it("skips heartbeat ACK turns while reconciling real bootstrap tail messages", async () => {
    const sessionFile = createSessionFilePath("bootstrap-reconcile-heartbeat-turn-tail");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, makeMessage({ role: "user", content: "seed user" }));
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "seed assistant" }));

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-heartbeat-turn-tail";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await engine
      .getSummaryStore()
      .upsertConversationBootstrapState({
        conversationId: conversation!.conversationId,
        sessionFilePath: sessionFile,
        lastSeenSize: 1,
        lastSeenMtimeMs: 0,
        lastProcessedOffset: 1,
        lastProcessedEntryHash: "mismatch",
      });

    appendSessionMessage(
      sm,
      makeMessage({
        role: "user",
        content: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
    );
    appendSessionMessage(
      sm,
      makeMessage({ role: "tool", content: "# HEARTBEAT.md\n\nIf nothing needs attention, stay quiet." }),
    );
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "HEARTBEAT_OK" }));
    appendSessionMessage(sm, makeMessage({ role: "user", content: "real recovered user" }));
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "real recovered assistant" }));

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "real recovered user",
      "real recovered assistant",
    ]);
  });

  it("imports appended tail messages without replaying full reconciliation", async () => {
    const sessionFile = createSessionFilePath("append-only-tail");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("keeps append-only bootstrap moving when OpenClaw inbound metadata changes around the same user text", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("append-only-openclaw-inbound-metadata");
    const initialContent = openClawInboundMetadataContent({
      messageId: "telegram-1",
      senderName: "Syu",
      text: "please keep this context",
    });
    writeLeafTranscriptMessages(sessionFile, [
      makeMessage({ role: "user", content: initialContent }),
    ]);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-append-only-openclaw-inbound-metadata";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 1 });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const storedBefore = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedBefore[0]?.content).toBe(initialContent);

    const volatileContent = openClawInboundMetadataContent({
      messageId: "telegram-2",
      senderName: "Syu",
      text: "please keep this context",
    });
    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(`UPDATE messages SET content = ? WHERE conversation_id = ?`)
        .run(volatileContent, conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");
    appendFileSync(
      sessionFile,
      `${JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "tail assistant" }] },
      })}\n`,
      "utf8",
    );

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 1,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    const storedAfter = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfter.map((message) => message.content)).toEqual([
      volatileContent,
      "tail assistant",
    ]);
    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(sessionFile).size);
  });

  it("falls back to full reconciliation when append-only suffix overlaps persisted history", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("append-only-overlap-fallback");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "seed user" },
      { role: "assistant", content: "OK" },
      { role: "user", content: "middle user" },
      { role: "assistant", content: "OK" },
    ]);
    const firstTwoLineOffset = Buffer.byteLength(
      readFileSync(sessionFile, "utf8").split("\n").slice(0, 2).join("\n") + "\n",
      "utf8",
    );

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-append-only-overlap-fallback";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 4 });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    appendFileSync(
      sessionFile,
      `${JSON.stringify({
        message: { role: "user", content: [{ type: "text", text: "actual new tail" }] },
      })}\n`,
      "utf8",
    );

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_offset = ?,
               last_seen_size = ?,
               last_seen_mtime_ms = 0
           WHERE conversation_id = ?`,
        )
        .run(firstTwoLineOffset, firstTwoLineOffset, conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 1,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "OK",
      "middle user",
      "OK",
      "actual new tail",
    ]);
  });

  it("blocks bounded no-anchor imports that are mostly already persisted history", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("no-anchor-duplicate-replay");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old one" },
      { role: "assistant", content: "old two" },
      { role: "user", content: "old three" },
      { role: "assistant", content: "old four" },
    ]);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-no-anchor-duplicate-replay";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 4 });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const fileSize = statSync(sessionFile).size;
    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_offset = ?,
               last_seen_size = ?,
               last_seen_mtime_ms = 0
           WHERE conversation_id = ?`,
        )
        .run(fileSize + 10_000, fileSize + 10_000, conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "reconcile duplicate transcript replay",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old one",
      "old two",
      "old three",
      "old four",
    ]);
  });

  it("imports the new tail when a same-path shrink keeps an already-persisted prefix", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("same-path-shrink-prefix-tail");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "prefix one" },
      { role: "assistant", content: "prefix two" },
      { role: "user", content: "prefix three" },
    ]);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-same-path-shrink-prefix-tail";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first).toEqual({ bootstrapped: true, importedMessages: 3 });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "prefix one" },
      { role: "assistant", content: "prefix two" },
      { role: "user", content: "prefix three" },
      { role: "assistant", content: "actual same-path shrink tail" },
    ]);

    const rewrittenSize = statSync(sessionFile).size;
    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_offset = ?,
               last_seen_size = ?,
               last_seen_mtime_ms = 0
           WHERE conversation_id = ?`,
        )
        .run(rewrittenSize + 10_000, rewrittenSize + 10_000, conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 1,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "prefix one",
      "prefix two",
      "prefix three",
      "actual same-path shrink tail",
    ]);
  });

  it("keeps the append-only fast path after heartbeat pruning changes the DB frontier", async () => {
    const sessionFile = createSessionFilePath("append-only-heartbeat-prune");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly." }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "tool",
      content: "# HEARTBEAT.md\n\n## Worker heartbeat (minimal)",
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "HEARTBEAT_OK" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({ pruneHeartbeatOk: true });
    const sessionId = "bootstrap-append-only-heartbeat-prune";
    const sessionKey = "agent:main:test:bootstrap-append-only-heartbeat-prune";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedAfterPrune = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterPrune.map((message) => message.content)).toEqual(["seed user", "seed assistant"]);

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();

    const storedAfterAppend = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterAppend.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "tail user",
      "tail assistant",
    ]);
  });

  it("ignores non-message envelopes in appended transcript tails without forcing reconcile", async () => {
    const sessionFile = createSessionFilePath("append-only-noncanonical-envelope");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-noncanonical-envelope";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");

    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "commentary", message: { role: "assistant", content: "ignore me" } })}\n`,
      "utf8",
    );
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("tolerates custom bootstrap sidecar entries in append-only suffixes", async () => {
    const sessionFile = createSessionFilePath("append-only-bootstrap-sidecar");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-bootstrap-sidecar";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");

    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", customType: "openclaw:bootstrap-context:full", data: { ok: true } })}\n`,
      "utf8",
    );
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 1,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("refreshes the bootstrap checkpoint after afterTurn heartbeat pruning", async () => {
    const sessionFile = createSessionFilePath("append-only-after-turn-heartbeat-prune");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({ pruneHeartbeatOk: true });
    const sessionId = "bootstrap-append-only-after-turn-heartbeat-prune";
    const sessionKey = "agent:main:test:bootstrap-append-only-after-turn-heartbeat-prune";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const heartbeatBatch = [
      makeMessage({
        role: "user",
        content: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
      makeMessage({
        role: "tool",
        content: "# HEARTBEAT.md\n\n## Worker heartbeat (minimal)",
      }),
      makeMessage({
        role: "assistant",
        content: "HEARTBEAT_OK",
      }),
    ];
    for (const message of heartbeatBatch) {
      appendSessionMessage(sm, message as AgentMessage);
    }

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: heartbeatBatch,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");
    const second = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("refreshes the bootstrap checkpoint after a normal afterTurn before the next append-only bootstrap", async () => {
    const sessionFile = createSessionFilePath("append-only-after-turn-normal-ingest");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-append-only-after-turn-normal-ingest";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const realTurn = [
      makeMessage({
        role: "user",
        content: "new user",
      }),
      makeMessage({
        role: "assistant",
        content: "new assistant",
      }),
    ];
    for (const message of realTurn) {
      appendSessionMessage(sm, message as AgentMessage);
    }

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: realTurn,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");
    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).not.toHaveBeenCalled();
  });

  it("reconciles foreground transcript messages before assistant-only afterTurn deltas", async () => {
    const sessionFile = createSessionFilePath("after-turn-foreground-transcript-reconcile");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "kick off workers" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "same status reply" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "after-turn-foreground-transcript-reconcile";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "You set up a monitor too right?" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "same status reply" }],
    } as AgentMessage);

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "same status reply" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "kick off workers",
      "same status reply",
      "You set up a monitor too right?",
      "same status reply",
    ]);

    const sessionFileStats = statSync(sessionFile);
    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(bootstrapState?.lastProcessedOffset).toBe(sessionFileStats.size);
  });

  it("falls back to full reconciliation when append-only checkpoint validation mismatches", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("append-only-mismatch");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "bootstrap-append-only-mismatch";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_entry_hash = ?
           WHERE conversation_id = ?`,
        )
        .run("mismatch", conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");

    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "tail user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "tail assistant" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).toHaveBeenCalledTimes(1);
  });

  it("does not anchor hash-only checkpoint recovery on an ambiguous repeated inbound message", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("ambiguous-canonical-checkpoint");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: openClawInboundMetadataContent({
        messageId: "telegram-1",
        senderName: "Syu",
        text: "repeat me",
      }) }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "middle assistant" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: openClawInboundMetadataContent({
        messageId: "telegram-2",
        senderName: "Syu",
        text: "repeat me",
      }) }],
    } as AgentMessage);

    const engine = createEngineAtDatabasePath(dbPath);
    const sessionId = "ambiguous-canonical-checkpoint";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `DELETE FROM context_items
           WHERE conversation_id = ?
             AND message_id IN (
               SELECT message_id FROM messages WHERE conversation_id = ? AND seq > 1
             )`,
        )
        .run(conversation!.conversationId, conversation!.conversationId);
      rawDb
        .prepare(
          `DELETE FROM message_parts
           WHERE message_id IN (
             SELECT message_id FROM messages WHERE conversation_id = ? AND seq > 1
           )`,
        )
        .run(conversation!.conversationId);
      rawDb
        .prepare(
          `DELETE FROM messages
           WHERE conversation_id = ?
             AND seq > 1`,
        )
        .run(conversation!.conversationId);
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_entry_id = NULL,
               last_seen_size = 0,
               last_seen_mtime_ms = 0
           WHERE conversation_id = ?`,
        )
        .run(conversation!.conversationId);
      rawDb
        .prepare(
          `UPDATE messages
           SET transcript_entry_id = NULL
           WHERE conversation_id = ?`,
        )
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const secondEngine = createEngineAtDatabasePath(dbPath);
    const second = await secondEngine.bootstrap({ sessionId, sessionFile });

    expect(second.importedMessages).toBe(2);
    const stored = await secondEngine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      openClawInboundMetadataContent({
        messageId: "telegram-1",
        senderName: "Syu",
        text: "repeat me",
      }),
      "middle assistant",
      openClawInboundMetadataContent({
        messageId: "telegram-2",
        senderName: "Syu",
        text: "repeat me",
      }),
    ]);
  });

  it("does not count distinct OpenClaw metadata variants as no-anchor replay overlaps", async () => {
    const engine = createEngine();
    const conversation = await engine
      .getConversationStore()
      .createConversation({ sessionId: "no-anchor-openclaw-overlap" });
    const persisted = openClawInboundMetadataContent({
      messageId: "telegram-1",
      senderName: "Syu",
      text: "repeat me",
    });
    await engine.getConversationStore().createMessage({
      conversationId: conversation.conversationId,
      seq: 0,
      role: "user",
      content: persisted,
      tokenCount: 1,
    });

    const candidate = openClawInboundMetadataContent({
      messageId: "telegram-2",
      senderName: "Syu",
      text: "repeat me",
    });
    const analysis = await engine
      .getTranscriptReconciler()
      .analyzePersistedTranscriptIdentityOverlaps({
        conversationId: conversation.conversationId,
        messages: [makeMessage({ role: "user", content: candidate })],
      });

    expect(analysis).toEqual({ overlaps: 0, firstNonOverlappingIndex: 0 });
  });

  it("reconciles missing structured tool-call tail when prior empty tool content exists", async () => {
    const sessionFile = createSessionFilePath("reconcile-tool-tail");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_existing", name: "read", input: { path: "a.txt" } }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "toolResult",
      toolCallId: "call_existing",
      content: [{ type: "tool_result", tool_use_id: "call_existing", output: { ok: true } }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-tool-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(4);

    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_missing", name: "read", input: { path: "b.txt" } }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "toolResult",
      toolCallId: "call_missing",
      content: [{ type: "tool_result", tool_use_id: "call_missing", output: { ok: true } }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(2);
    expect(second.reason).toBe("reconciled missing session messages");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(6);
    expect(stored[4].role).toBe("assistant");
    expect(stored[4].content).toBe("");
    expect(stored[5].role).toBe("tool");
    expect(stored[5].content).toBe("");
  });

  it("bootstraps a bounded same-path transcript epoch after the file shrinks", async () => {
    const warnLog = vi.fn();
    const sessionFile = createSessionFilePath("bootstrap-same-path-shrink");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old bootstrap shrink user" },
      { role: "assistant", content: "old bootstrap shrink assistant" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "bootstrap-same-path-shrink";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "missed bootstrap shrink user" },
      { role: "assistant", content: "missed bootstrap shrink assistant" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("same-path-shrink")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old bootstrap shrink user",
      "old bootstrap shrink assistant",
      "missed bootstrap shrink user",
      "missed bootstrap shrink assistant",
    ]);

    const newCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(newCheckpoint?.sessionFilePath).toBe(sessionFile);
    expect(newCheckpoint?.lastProcessedOffset).toBe(statSync(sessionFile).size);
  });

  it("blocks same-path shrink import when raw ids belong to another active conversation", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );

    const mainSessionId = "bootstrap-same-path-shrink-cross-main";
    const mainSessionKey = "agent:main:main";
    const mainSessionFile = createSessionFilePath("bootstrap-same-path-shrink-cross-main");
    writeLeafTranscript(mainSessionFile, [
      { role: "user", content: "main old user" },
      { role: "assistant", content: "main old assistant" },
    ]);
    appendFileSync(
      mainSessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const first = await engine.bootstrap({
      sessionId: mainSessionId,
      sessionKey: mainSessionKey,
      sessionFile: mainSessionFile,
    });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const mainConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: mainSessionId,
      sessionKey: mainSessionKey,
    });
    expect(mainConversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(mainConversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(mainSessionFile);

    const duplicateMessages = [
      makeMessage({
        role: "user",
        content: [{ type: "text", id: "raw-cross-user", text: "telegram duplicate user" }],
      }),
      makeMessage({
        role: "assistant",
        content: [{ type: "text", id: "raw-cross-assistant", text: "telegram duplicate assistant" }],
      }),
    ];
    const directSessionFile = createSessionFilePath("bootstrap-same-path-shrink-cross-direct");
    writeLeafTranscriptMessages(directSessionFile, duplicateMessages);
    await engine.bootstrap({
      sessionId: "bootstrap-same-path-shrink-cross-direct",
      sessionKey: "agent:main:telegram:default:direct:8455538490",
      sessionFile: directSessionFile,
    });

    writeLeafTranscriptMessages(mainSessionFile, duplicateMessages);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(mainSessionFile).size);

    const second = await engine.bootstrap({
      sessionId: mainSessionId,
      sessionKey: mainSessionKey,
      sessionFile: mainSessionFile,
    });
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "reconcile duplicate raw ids",
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("blocked same-path-shrink no-anchor import")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(mainConversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "main old user",
      "main old assistant",
    ]);

    const checkpointAfterBlock = await engine
      .getSummaryStore()
      .getConversationBootstrapState(mainConversation!.conversationId);
    expect(checkpointAfterBlock?.lastProcessedOffset).toBe(oldCheckpoint?.lastProcessedOffset);
  });

  it("imports the full bounded same-path shrink epoch instead of trusting a stale externalized frontier", async () => {
    const sessionFile = createSessionFilePath("bootstrap-same-path-shrink-externalized");
    const rawFrontier = "externalized raw shrink frontier";
    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "bootstrap-same-path-shrink-externalized";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const firstStored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(firstStored).toHaveLength(1);

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(`UPDATE messages SET content = ?, token_count = ? WHERE message_id = ?`)
        .run(
          "[LCM externalized payload reference]",
          estimateTokens("[LCM externalized payload reference]"),
          firstStored[0].messageId,
        );
    } finally {
      closeLcmConnection(rawDb);
    }

    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
      { role: "user", content: "tail after externalized shrink" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[LCM externalized payload reference]",
      rawFrontier,
      "tail after externalized shrink",
    ]);
  });

  it("imports a full same-path shrink epoch when new content repeats an old frontier message", async () => {
    const sessionFile = createSessionFilePath("bootstrap-same-path-shrink-duplicate-frontier");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old duplicate frontier user" },
      { role: "assistant", content: "OK" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    const engine = createEngine();
    const sessionId = "bootstrap-same-path-shrink-duplicate-frontier";
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "new duplicate frontier user" },
      { role: "assistant", content: "OK" },
      { role: "user", content: "new duplicate frontier tail" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: true,
      importedMessages: 3,
      reason: "reconciled missing session messages",
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old duplicate frontier user",
      "OK",
      "new duplicate frontier user",
      "OK",
      "new duplicate frontier tail",
    ]);
  });

  it("does not append JSONL when no overlapping anchor exists in LCM", async () => {
    const sessionFile = createSessionFilePath("reconcile-no-overlap");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "json only user" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "json only assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-no-overlap";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "db only user" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "db only assistant" } as AgentMessage,
    });

    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(false);
    expect(result.importedMessages).toBe(0);
    expect(result.reason).toBe("conversation already has messages");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["db only user", "db only assistant"]);
  });

  it("does not advance the bootstrap checkpoint when reconcile aborts at the import cap", async () => {
    const warnLog = vi.fn();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("reconcile-import-cap");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    const seedAssistantId = appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const config = createTestConfig(dbPath);
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(
      createTestDeps(config, {
        log: {
          info: vi.fn(),
          warn: warnLog,
          error: vi.fn(),
          debug: vi.fn(),
        },
      }),
      db,
    );
    const sessionId = "bootstrap-reconcile-import-cap";
    const sessionKey = "agent:main:test:bootstrap-reconcile-import-cap";

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const firstBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(firstBootstrapState).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_entry_hash = ?
           WHERE conversation_id = ?`,
        )
        .run("mismatch", conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const staleBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(staleBootstrapState).not.toBeNull();
    expect(staleBootstrapState?.lastProcessedEntryHash).toBe("mismatch");

    const recoveredTailContents = Array.from({ length: 60 }, (_, index) =>
      index < 3 ? "repeat ack" : `missing tail ${index}`,
    );
    const recoveredTailTimestamps = recoveredTailContents.map(
      (_content, index) => `2026-06-10T18:${String(index).padStart(2, "0")}:00.000Z`,
    );
    const invalidTimestampIndex = 4;
    const recoveredTailEntries = recoveredTailContents.map((content, index) => ({
      type: "message",
      id: `recovered-tail-${index}`,
      parentId: index === 0 ? seedAssistantId : `recovered-tail-${index - 1}`,
      timestamp:
        index === invalidTimestampIndex ? "not-a-valid-transcript-timestamp" : recoveredTailTimestamps[index],
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: content }],
      },
    }));
    appendFileSync(
      sessionFile,
      recoveredTailEntries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    const second = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    // Anchored backlog over the cap imports a bounded oldest-first chunk
    // instead of freezing; the checkpoint must still not advance.
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 50,
      reason: "reconcile import capped",
    });
    expect(warnLog).toHaveBeenCalledWith(
      `[lcm] reconcileSessionTail: entry-id import cap chunking for conversation=${conversation!.conversationId} session=${sessionId} sessionKey=${sessionKey} — importing 50/60 anchored backlog messages this pass (existing: 2, cap: 50); remaining backlog continues next pass`,
    );

    const storedAfterCap = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterCap).toHaveLength(52);
    expect(storedAfterCap.slice(0, 2).map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
    ]);
    expect(storedAfterCap[2]?.content).toBe("repeat ack");
    expect(storedAfterCap[51]?.content).toBe("missing tail 49");

    const secondBootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(secondBootstrapState).toEqual(staleBootstrapState);

    // The next pass drains the remaining backlog and completes reconcile.
    const reconcileSpy = vi.spyOn(engine.getTranscriptReconciler(), "reconcileSessionTail");
    const third = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(third).toEqual({
      bootstrapped: true,
      importedMessages: 10,
      reason: "reconciled missing session messages",
    });
    expect(reconcileSpy).toHaveBeenCalledTimes(1);

    const storedAfterDrain = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedAfterDrain).toHaveLength(62);
    expect(storedAfterDrain[61]?.content).toBe("missing tail 59");
    expect(
      storedAfterDrain.slice(2, 5).map((message) => message.createdAt.toISOString()),
    ).toEqual(recoveredTailTimestamps.slice(0, 3));
    expect(storedAfterDrain[2 + invalidTimestampIndex]?.content).toBe(
      recoveredTailContents[invalidTimestampIndex],
    );
    expect(
      Number.isFinite(storedAfterDrain[2 + invalidTimestampIndex]!.createdAt.getTime()),
    ).toBe(true);
  });

  it("uses the live ingest path for initial bootstrap", async () => {
    const sessionFile = createSessionFilePath("bootstrap-ingest-path");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "ingest one" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "ingest two" }],
    } as AgentMessage);

    const warnLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: warnLog,
        error: vi.fn(),
        debug: vi.fn(),
      },
    });
    const bulkSpy = vi.spyOn(engine.getConversationStore(), "createMessagesBulk");
    const singleSpy = vi.spyOn(engine.getConversationStore(), "createMessage");

    const result = await engine.bootstrap({
      sessionId: "bootstrap-ingest-path",
      sessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);
    expect(bulkSpy).not.toHaveBeenCalled();
    expect(singleSpy).toHaveBeenCalledTimes(2);
  });

  it("externalizes oversized file blocks during first-time bootstrap and still reconciles later tail messages", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("bootstrap-large-file-parity");
      const fileText = `${"bootstrap file line\n".repeat(160)}done`;
      writeFileSync(
        sessionFile,
        `${JSON.stringify({
          role: "user",
          content: `<file name="bootstrap.md" mime="text/markdown">${fileText}</file>`,
        })}\n`,
        "utf8",
      );

      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "bootstrap-large-file-parity";
      const first = await engine.bootstrap({ sessionId, sessionFile });
      expect(first).toEqual({
        bootstrapped: true,
        importedMessages: 1,
      });

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const initiallyStored = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(initiallyStored).toHaveLength(1);
      expect(initiallyStored[0].content).toContain("[LCM File: file_");
      expect(initiallyStored[0].content).not.toContain("<file name=");
      expect(initiallyStored[0].content).not.toContain(fileText.slice(0, 64));

      const fileIdMatch = initiallyStored[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("bootstrap.md");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(fileText);

      const parts = await engine.getConversationStore().getMessageParts(initiallyStored[0].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toContain("[LCM File: file_");

      appendFileSync(
        sessionFile,
        `${JSON.stringify({
          role: "assistant",
          content: [{ type: "text", text: "tail after externalized bootstrap" }],
        })}\n`,
        "utf8",
      );

      const second = await engine.bootstrap({ sessionId, sessionFile });
      expect(second).toEqual({
        bootstrapped: true,
        importedMessages: 1,
        reason: "reconciled missing session messages",
      });

      const afterReconcile = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(afterReconcile.map((message) => message.content)).toEqual([
        initiallyStored[0].content,
        "tail after externalized bootstrap",
      ]);
    });
  });

  it("externalizes inline images during first-time bootstrap", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const sessionFile = createSessionFilePath("bootstrap-inline-image-parity");
    const base64Image = `iVBOR${"A".repeat(600)}`;
    writeFileSync(
      sessionFile,
      `${JSON.stringify({
        role: "user",
        content: `[media attached: bootstrap.png]\n${base64Image}\n`,
      })}\n`,
      "utf8",
    );

    const engine = createEngineWithConfig({
      largeFileTokenThreshold: 1000,
      largeFilesDir,
    });
    const sessionId = "bootstrap-inline-image-parity";
    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("[User image: bootstrap.png");
    expect(messages[0].content).not.toContain(base64Image.slice(0, 32));

    const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
    expect(fileIdMatch).not.toBeNull();
    const storedFile = await engine.getSummaryStore().getLargeFile(fileIdMatch![0]);
    expect(storedFile).not.toBeNull();
    expect(storedFile!.mimeType).toBe("image/png");
    expect(storedFile!.storageUri).toContain(`${largeFilesDir}/${conversation!.conversationId}/`);
  });

  it("externalizes oversized tool results during first-time bootstrap", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("bootstrap-tool-result-parity");
      const sm = SessionManager.open(sessionFile);
      const toolOutput = `${"bootstrap tool output\n".repeat(160)}done`;
      appendSessionMessage(sm, {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call_bootstrap_externalized",
            name: "exec",
            input: { cmd: "cat large.txt" },
          },
        ],
      } as AgentMessage);
      appendSessionMessage(sm, {
        role: "toolResult",
        toolCallId: "call_bootstrap_externalized",
        toolName: "exec",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_bootstrap_externalized",
            name: "exec",
            content: [{ type: "text", text: toolOutput }],
          },
        ],
      } as AgentMessage);

      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "bootstrap-tool-result-parity";
      const result = await engine.bootstrap({ sessionId, sessionFile });
      expect(result.bootstrapped).toBe(true);
      expect(result.importedMessages).toBe(2);

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();
      const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(2);
      expect(messages[1].content).toContain("[LCM Tool Output: file_");
      expect(messages[1].content).toContain("tool=exec");
      expect(messages[1].content).not.toContain(toolOutput.slice(0, 64));

      const fileIdMatch = messages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];
      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("exec.txt");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(toolOutput);

      const parts = await engine.getConversationStore().getMessageParts(messages[1].messageId);
      expect(parts).toHaveLength(1);
      const metadata = JSON.parse(parts[0].metadata ?? "{}") as Record<string, unknown>;
      expect(metadata).toMatchObject({
        externalizedFileId: fileId,
        originalByteSize: Buffer.byteLength(toolOutput, "utf8"),
        toolOutputExternalized: true,
        externalizationReason: "large_tool_result",
      });
    });
  });

  it("limits first-time bootstrap imports to the newest messages within bootstrapMaxTokens", async () => {
    const sessionFile = createSessionFilePath("bootstrap-token-cap");
    const sm = SessionManager.open(sessionFile);
    for (let index = 0; index < 5; index += 1) {
      appendSessionMessage(sm, {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `turn ${index} ${"x".repeat(396)}` }],
      } as AgentMessage);
    }

    const engine = createEngineWithConfig({ bootstrapMaxTokens: 250 });
    const sessionId = "bootstrap-token-cap";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      `turn 3 ${"x".repeat(396)}`,
      `turn 4 ${"x".repeat(396)}`,
    ]);
  });

  it("bounds forked child bootstrap and assembly even when the host transcript contains a raw parent branch", async () => {
    const sessionFile = createSessionFilePath("bootstrap-fork-token-cap");
    const header = {
      type: "session",
      version: 3,
      id: "forked-child-session",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      parentSession: "/state/sessions/parent.jsonl",
    };
    const forkedParentBranch = Array.from({ length: 60 }, (_, index) => ({
      type: "message",
      id: `parent-${index}`,
      parentId: index === 0 ? null : `parent-${index - 1}`,
      timestamp: new Date().toISOString(),
      message: {
        role: index % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `fork parent turn ${index} ${"x".repeat(240)}` }],
      },
    }));
    writeFileSync(
      sessionFile,
      [header, ...forkedParentBranch].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    const engine = createEngineWithConfig({ bootstrapMaxTokens: 320 });
    const sessionId = "bootstrap-fork-token-cap";
    const sessionKey = "agent:main:discord:channel:child-thread";
    const result = await engine.bootstrap({ sessionId, sessionKey, sessionFile });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBeLessThan(60);
    expect(result.importedMessages).toBeGreaterThan(0);

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.length).toBe(result.importedMessages);
    expect(stored[0]?.content).not.toContain("fork parent turn 0");
    expect(stored.at(-1)?.content).toContain("fork parent turn 59");

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET fork_bounded = 0, fork_source_message_count = 0
           WHERE conversation_id = ?`,
        )
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const secondBootstrap = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(secondBootstrap.bootstrapped).toBe(false);

    const restartedEngine = createEngineAtDatabasePath(getEngineConfig(engine).databasePath);
    const repeatedChildPrompt = `fork parent turn 58 ${"x".repeat(240)}`;
    const liveMessages = [
      ...forkedParentBranch.map((entry) => entry.message as AgentMessage),
      makeMessage({
        role: "user",
        content: [{ type: "text", text: repeatedChildPrompt }],
      }),
    ];
    const assembled = await restartedEngine.assemble({
      sessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget: 10_000,
    });
    const assembledText = JSON.stringify(assembled.messages);

    expect(assembled.messages.length).toBeLessThan(liveMessages.length);
    expect(assembledText).not.toContain("fork parent turn 0");
    expect(assembledText).toContain("fork parent turn 59");
    expect(assembledText.split(repeatedChildPrompt).length - 1).toBeGreaterThanOrEqual(2);
  });

  it("drops an oversized singleton bootstrap tail that exceeds bootstrapMaxTokens", async () => {
    const sessionFile = createSessionFilePath("bootstrap-oversized-singleton");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "x".repeat(5000) }],
    } as AgentMessage);

    const engine = createEngineWithConfig({ bootstrapMaxTokens: 100 });
    const sessionId = "bootstrap-oversized-singleton";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(false);
    expect(result.importedMessages).toBe(0);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toEqual([]);
  });

  it("does not return raw fork history when a forked oversized bootstrap tail imports no messages", async () => {
    const sessionFile = createSessionFilePath("bootstrap-fork-oversized-singleton");
    const header = {
      type: "session",
      version: 3,
      id: "forked-child-oversized-session",
      timestamp: new Date().toISOString(),
      cwd: process.cwd(),
      parentSession: "/state/sessions/parent.jsonl",
    };
    const oversizedParentMessage = {
      type: "message",
      id: "parent-oversized",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [{ type: "text", text: `oversized fork parent ${"x".repeat(5000)}` }],
      },
    };
    writeFileSync(
      sessionFile,
      [header, oversizedParentMessage].map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      "utf8",
    );

    const engine = createEngineWithConfig({ bootstrapMaxTokens: 100 });
    const sessionId = "bootstrap-fork-oversized-singleton";
    const sessionKey = "agent:main:discord:channel:oversized-child-thread";
    const result = await engine.bootstrap({ sessionId, sessionKey, sessionFile });

    expect(result.bootstrapped).toBe(false);
    expect(result.importedMessages).toBe(0);

    const assembled = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [
        oversizedParentMessage.message as AgentMessage,
        makeMessage({ role: "user", content: "fresh child prompt after oversized parent" }),
      ],
      tokenBudget: 10_000,
    });
    const assembledText = JSON.stringify(assembled.messages);

    expect(assembledText).not.toContain("oversized fork parent");
    expect(assembledText).toContain("fresh child prompt after oversized parent");
  });

  it("streams JSONL replay and skips malformed lines while keeping later messages", async () => {
    const sessionFile = createSessionFilePath("streaming-jsonl");
    const lines: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const role = index % 2 === 0 ? "user" : "assistant";
      lines.push(
        JSON.stringify({
          message: {
            role,
            content: [{ type: "text", text: `${role}-${index}` }],
          },
        }),
      );
      if (index === 17) {
        lines.push("{ malformed json line");
      }
    }
    writeFileSync(sessionFile, `${lines.join("\n")}\n`, "utf8");

    const engine = createEngine();
    const sessionId = "bootstrap-streaming-jsonl";

    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(40);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(40);
    expect(stored[0]?.content).toBe("user-0");
    expect(stored[39]?.content).toBe("assistant-39");
  });

  it("prepareSubagentSpawn resolves parent conversation by sessionKey before UUID backfill", async () => {
    const sessionKey = "agent:main:main";
    const engine = createEngineWithDepsOverrides({
      resolveSessionIdFromSessionKey: async () => "runtime-fresh",
    });

    await engine.ingest({
      sessionId: "runtime-stale",
      sessionKey,
      message: makeMessage({ role: "assistant", content: "parent context" }),
    });

    const preparation = await engine.prepareSubagentSpawn({
      parentSessionKey: sessionKey,
      childSessionKey: "agent:main:subagent:test-child",
    });

    expect(preparation).toBeDefined();
    preparation?.rollback?.();
  });

  it("skips full read when file is unchanged and conversation is already bootstrapped", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionFile = createSessionFilePath("cache-guard");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "one" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "two" }],
    } as AgentMessage);

    const config = createTestConfig(dbPath);
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(
      createTestDeps(config, {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      }),
      db,
    );

    const sessionId = "cache-guard";

    // First bootstrap: full read
    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    // Corrupt both the checkpoint stats and hash to force BOTH the checkpoint
    // fast path and the append-only fast path to fail, exercising the file-level
    // cache guard.
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const rawDb = createLcmDatabaseConnection(dbPath);
    try {
      rawDb
        .prepare(
          `UPDATE conversation_bootstrap_state
           SET last_processed_entry_hash = ?,
               last_seen_size = 0,
               last_seen_mtime_ms = 0
           WHERE conversation_id = ?`,
        )
        .run("corrupted", conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    // Second bootstrap: checkpoint path fails (stats corrupted), append-only
    // path fails (hash corrupted + size condition), but file-level cache guard
    // skips the full read because the file hasn't changed since the first read
    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "already bootstrapped",
    });

    // Verify the cache guard fired (skipped full read)
    const cacheGuardLogs = debugLog.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("skipped full read (file unchanged)"),
    );
    expect(cacheGuardLogs).toHaveLength(1);

    // Verify only one full transcript read occurred (the first bootstrap)
    const fullReadLogs = debugLog.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("full transcript read"),
    );
    expect(fullReadLogs).toHaveLength(1);
  });

  it("file-level cache guard allows full read when file changes", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");
    const sessionDir = mkdtempSync(join(tmpdir(), "lossless-claw-session-"));
    tempDirs.push(sessionDir);
    const sessionFile = join(sessionDir, "cache-guard-grows.jsonl");

    // Write initial JSONL directly (avoids SessionManager lifecycle issues)
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ role: "user", content: [{ type: "text", text: "initial" }] })}\n`,
    );

    const config = createTestConfig(dbPath);
    const db = createLcmDatabaseConnection(config.databasePath);
    const engine = new LcmContextEngine(
      createTestDeps(config, {
        log: {
          info: infoLog,
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      }),
      db,
    );

    const sessionId = "cache-guard-grows";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);

    // Corrupt checkpoint stats AND hash so both fast paths fail
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    db.prepare(
      `UPDATE conversation_bootstrap_state
       SET last_processed_entry_hash = ?,
           last_seen_size = 0,
           last_seen_mtime_ms = 0
       WHERE conversation_id = ?`,
    ).run("corrupted", conversation!.conversationId);

    // Grow the file so the cache guard also sees a size change
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ role: "assistant", content: [{ type: "text", text: "reply" }] })}\n`,
    );

    // Bootstrap should NOT use cache guard (file changed), should do full read
    const second = await engine.bootstrap({ sessionId, sessionFile });
    // The newly appended assistant message must be picked up by the full read —
    // a vacuous `>= 0` assertion here would pass even if readLeafPathMessages
    // silently returned no rows, which is exactly the failure mode this test
    // is supposed to catch.
    expect(second.importedMessages).toBeGreaterThanOrEqual(1);

    // Two full reads should have occurred
    const fullReadLogs = debugLog.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === "string" && call[0].includes("full transcript read"),
    );
    expect(fullReadLogs).toHaveLength(2);

    // And the cache guard must not have fired after the file grew
    const skippedLogs = debugLog.mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === "string" && call[0].includes("skipped full read (file unchanged)"),
    );
    expect(skippedLogs).toHaveLength(0);
  });
});

// ── Assemble canonical path with fallback ───────────────────────────────────
