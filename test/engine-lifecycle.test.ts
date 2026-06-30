// Engine lifecycle: metadata, ignored/stateless sessions, runtime-context leak filtering, session reuse, before_reset/session_end, delegated continuity, connection lifecycle.
// Split from the former monolithic test/engine.test.ts; shared fixtures live in test/helpers.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { createDelegatedExpansionGrant, getRuntimeExpansionAuthManager, resolveDelegatedExpansionGrantId } from "../src/expansion-auth.js";
import {
  cleanupEngineTestState,
  appendSessionMessage,
  createTestConfig,
  createTestDeps,
  createEngine,
  createEngineAtDatabasePath,
  createSessionFilePath,
  writeLeafTranscriptMessages,
  createEngineWithConfig,
  createEngineWithDeps,
  makeMessage,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);
describe("LcmContextEngine metadata", () => {
  it("reports the registered lossless-claw engine id", () => {
    const engine = createEngine();
    expect(engine.info.id).toBe("lossless-claw");
  });

  it("advertises ownsCompaction capability", () => {
    const engine = createEngine();
    expect(engine.info.ownsCompaction).toBe(true);
  });

  it("requires the full native host lifecycle for agent runs", () => {
    const engine = createEngine();
    expect(engine.info.hostRequirements?.["agent-run"]).toEqual({
      requiredCapabilities: [
        "bootstrap",
        "assemble-before-prompt",
        "after-turn",
        "maintain",
        "compact",
        "runtime-llm-complete",
      ],
      unsupportedMessage: expect.stringContaining("native Codex or Pi embedded runtime"),
    });
  });

  it("requires host thread bootstrap projection for subagent forks", () => {
    const engine = createEngine();
    expect(engine.info.hostRequirements?.["subagent-spawn"]).toEqual({
      requiredCapabilities: ["thread-bootstrap-projection"],
      unsupportedMessage: expect.stringContaining("raw parent JSONL branch"),
    });
  });

  it("configures file-backed sqlite connections with WAL and busy_timeout", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-db-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "pragmas.db");
    const db = createLcmDatabaseConnection(dbPath);

    const journal = db.prepare("PRAGMA journal_mode").get() as { journal_mode?: string };
    const busy = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number };

    expect(journal.journal_mode).toBe("wal");
    expect(busy.timeout).toBe(30000);
  });
});

describe("LcmContextEngine ignored sessions", () => {
  const ignoredSessionId = "runtime-ignored-session";
  const ignoredSessionKey = "agent:main:cron:nightly:run:run-123";
  const includedSessionId = "runtime-included-session";
  const includedSessionKey = "agent:main:main";

  it("skips bootstrap for ignored sessions while bootstrapping included sessions", async () => {
    const sessionFile = createSessionFilePath("ignored-bootstrap");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "bootstrap me" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "bootstrap reply" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.bootstrap({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      sessionFile,
    });
    const included = await engine.bootstrap({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      sessionFile,
    });

    expect(ignored).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "session excluded by pattern",
    });
    expect(included.bootstrapped).toBe(true);
    expect(included.importedMessages).toBe(2);
    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();
    expect(
      await engine.getConversationStore().getConversationBySessionId(includedSessionId),
    ).not.toBeNull();
  });

  it("skips ingest for ignored sessions while storing included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.ingest({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      message: makeMessage({ role: "user", content: "drop me" }),
    });
    const included = await engine.ingest({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      message: makeMessage({ role: "user", content: "keep me" }),
    });

    expect(ignored).toEqual({ ingested: false });
    expect(included).toEqual({ ingested: true });
    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();
    expect(
      await engine.getConversationStore().getConversationBySessionId(includedSessionId),
    ).not.toBeNull();
  });

  it("skips ingestBatch for ignored sessions while storing included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.ingestBatch({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      messages: [
        makeMessage({ role: "user", content: "drop batch user" }),
        makeMessage({ role: "assistant", content: "drop batch assistant" }),
      ],
    });
    const included = await engine.ingestBatch({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      messages: [
        makeMessage({ role: "user", content: "keep batch user" }),
        makeMessage({ role: "assistant", content: "keep batch assistant" }),
      ],
    });

    expect(ignored).toEqual({ ingestedCount: 0 });
    expect(included).toEqual({ ingestedCount: 2 });
    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();

    const includedConversation = await engine
      .getConversationStore()
      .getConversationBySessionId(includedSessionId);
    expect(includedConversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(includedConversation!.conversationId),
    ).toBe(2);
  });

  it("skips afterTurn for ignored sessions while persisting included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    await engine.afterTurn({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      sessionFile: createSessionFilePath("ignored-after-turn"),
      messages: [makeMessage({ role: "assistant", content: "ignored turn" })],
      prePromptMessageCount: 0,
    });
    await engine.afterTurn({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      sessionFile: createSessionFilePath("included-after-turn"),
      messages: [makeMessage({ role: "assistant", content: "included turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(
      await engine.getConversationStore().getConversationBySessionId(ignoredSessionId),
    ).toBeNull();

    const includedConversation = await engine
      .getConversationStore()
      .getConversationBySessionId(includedSessionId);
    expect(includedConversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(
      includedConversation!.conversationId,
    );
    expect(stored.map((message) => message.content)).toEqual(["included turn"]);
  });

  it("passes through assemble for ignored sessions while assembling included sessions from LCM", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    await engine.ingest({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      message: makeMessage({ role: "user", content: "persisted context" }),
    });

    const liveMessages = [makeMessage({ role: "user", content: "live ignored turn" })];
    const ignored = await engine.assemble({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      messages: liveMessages,
      tokenBudget: 500,
    });
    const included = await engine.assemble({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      messages: [],
      tokenBudget: 500,
    });

    expect(ignored).toEqual({
      messages: liveMessages,
      estimatedTokens: 0,
    });
    expect(included.messages).toHaveLength(1);
    expect(included.messages[0]?.content).toBe("persisted context");
  });

  it("skips compact for ignored sessions while compact still evaluates included sessions", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    const ignored = await engine.compact({
      sessionId: ignoredSessionId,
      sessionKey: ignoredSessionKey,
      sessionFile: createSessionFilePath("ignored-compact"),
      tokenBudget: 1000,
    });

    await engine.ingest({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      message: makeMessage({ role: "user", content: "compact me maybe" }),
    });
    const included = await engine.compact({
      sessionId: includedSessionId,
      sessionKey: includedSessionKey,
      sessionFile: createSessionFilePath("included-compact"),
      tokenBudget: 1000,
    });

    expect(ignored).toEqual({
      ok: true,
      compacted: false,
      reason: "session excluded",
    });
    expect(included.ok).toBe(true);
    expect(included.reason).not.toBe("session excluded");
  });

  it("skips prepareSubagentSpawn for ignored sessions while creating grants for included sessions", async () => {
    const childSessionKey = "agent:main:subagent:worker-123";
    const includedParentSessionKey = "agent:main:main";
    const runtimeSessionId = "runtime-parent-session";
    const engine = createEngineWithDeps(
      { ignoreSessionPatterns: ["agent:*:cron:**"] },
      {
        resolveSessionIdFromSessionKey: vi.fn(async (sessionKey: string) =>
          sessionKey === includedParentSessionKey ? runtimeSessionId : undefined,
        ),
      },
    );

    await engine.ingest({
      sessionId: runtimeSessionId,
      message: makeMessage({ role: "user", content: "parent context" }),
    });

    const ignored = await engine.prepareSubagentSpawn({
      parentSessionKey: ignoredSessionId,
      childSessionKey,
    });
    const included = await engine.prepareSubagentSpawn({
      parentSessionKey: includedParentSessionKey,
      childSessionKey,
    });

    expect(ignored).toBeUndefined();
    expect(included).toBeDefined();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).not.toBeNull();

    included?.rollback?.();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).toBeNull();
  });

  it("skips onSubagentEnded for ignored sessions while cleaning up included child grants", async () => {
    const ignoredChildSessionKey = "agent:main:cron:child";
    const includedChildSessionKey = "agent:main:subagent:child";
    createDelegatedExpansionGrant({
      delegatedSessionKey: ignoredChildSessionKey,
      issuerSessionId: "issuer-1",
      allowedConversationIds: [1],
    });
    createDelegatedExpansionGrant({
      delegatedSessionKey: includedChildSessionKey,
      issuerSessionId: "issuer-2",
      allowedConversationIds: [2],
    });

    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:*:cron:**"],
    });

    await engine.onSubagentEnded({
      childSessionKey: ignoredChildSessionKey,
      reason: "deleted",
    });
    await engine.onSubagentEnded({
      childSessionKey: includedChildSessionKey,
      reason: "deleted",
    });

    expect(resolveDelegatedExpansionGrantId(ignoredChildSessionKey)).not.toBeNull();
    expect(resolveDelegatedExpansionGrantId(includedChildSessionKey)).toBeNull();
    expect(
      getRuntimeExpansionAuthManager().getGrant(
        resolveDelegatedExpansionGrantId(ignoredChildSessionKey)!,
      ),
    ).not.toBeNull();
  });
});

describe("LcmContextEngine OpenClaw runtime context leak filter", () => {
  const leakedRuntimeContext =
    "OpenClaw runtime context for the immediately preceding user message. This context is runtime-generated, not user-author. Keep internal details private.";

  it("skips leaked assistant runtime context messages through direct ingest", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-leak-direct";

    const result = await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: leakedRuntimeContext }),
    });

    expect(result.ingested).toBe(false);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).toBeNull();
  });

  it("skips leaked assistant runtime context messages without creating a conversation", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-leak-only";

    const result = await engine.ingestBatch({
      sessionId,
      messages: [makeMessage({ role: "assistant", content: leakedRuntimeContext })],
    });

    expect(result.ingestedCount).toBe(0);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).toBeNull();
  });

  it("keeps real assistant replies after skipping leaked runtime context", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-leak-with-reply";

    const result = await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage({ role: "assistant", content: leakedRuntimeContext }),
        makeMessage({ role: "assistant", content: "Real assistant reply." }),
      ],
    });

    expect(result.ingestedCount).toBe(1);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["Real assistant reply."]);
  });

  it("skips leaked runtime context content blocks during afterTurn", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-leak-after-turn";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("runtime-context-leak-after-turn"),
      messages: [
        makeMessage({
          role: "assistant",
          content: [{ type: "text", text: leakedRuntimeContext }],
        }),
        makeMessage({ role: "assistant", content: "Visible answer." }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["Visible answer."]);
  });

  it("skips leaked runtime context imported from bootstrap transcripts", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-leak-bootstrap";
    const sessionFile = createSessionFilePath("runtime-context-leak-bootstrap");
    writeLeafTranscriptMessages(sessionFile, [
      makeMessage({ role: "assistant", content: leakedRuntimeContext }),
      makeMessage({ role: "assistant", content: "Bootstrapped answer." }),
    ]);

    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.importedMessages).toBe(1);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual(["Bootstrapped answer."]);
  });

  it("skips leaked runtime context in append-only bootstrap transcript recovery", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-leak-append-only-bootstrap";
    const sessionFile = createSessionFilePath("runtime-context-leak-append-only-bootstrap");
    writeLeafTranscriptMessages(sessionFile, [
      makeMessage({ role: "user", content: "Initial question." }),
      makeMessage({ role: "assistant", content: "Initial answer." }),
    ]);

    await engine.bootstrap({ sessionId, sessionFile });
    writeLeafTranscriptMessages(sessionFile, [
      makeMessage({ role: "user", content: "Initial question." }),
      makeMessage({ role: "assistant", content: "Initial answer." }),
      makeMessage({ role: "assistant", content: leakedRuntimeContext }),
      makeMessage({ role: "assistant", content: "Recovered answer." }),
    ]);

    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.importedMessages).toBe(1);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([
      "Initial question.",
      "Initial answer.",
      "Recovered answer.",
    ]);
  });

  it("keeps user-authored messages even when they quote the runtime context prefix", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-user-quote";

    const result = await engine.ingestBatch({
      sessionId,
      messages: [makeMessage({ role: "user", content: leakedRuntimeContext })],
    });

    expect(result.ingestedCount).toBe(1);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([leakedRuntimeContext]);
  });

  it("keeps system and tool messages even when they contain the runtime context sentinel", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-non-assistant-roles";

    const result = await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage({ role: "system", content: leakedRuntimeContext }),
        makeMessage({ role: "tool", content: leakedRuntimeContext }),
      ],
    });

    expect(result.ingestedCount).toBe(2);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.role)).toEqual(["system", "tool"]);
    expect(stored.map((m) => m.content)).toEqual([leakedRuntimeContext, leakedRuntimeContext]);
  });

  it("keeps ordinary assistant messages that mention the runtime context phrase later", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-assistant-explanation";
    const content =
      "I found the leak: OpenClaw runtime context for the immediately preceding user message was persisted even though it is runtime-generated, not user-author.";

    const result = await engine.ingestBatch({
      sessionId,
      messages: [makeMessage({ role: "assistant", content })],
    });

    expect(result.ingestedCount).toBe(1);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([content]);
  });

  it("keeps assistant messages that start with runtime context wording without the full sentinel", async () => {
    const engine = createEngine();
    const sessionId = "runtime-context-generic-assistant";
    const content =
      "OpenClaw runtime context for the immediately preceding user message can refer to host-provided fields; this answer is not the private per-turn context block.";

    const result = await engine.ingestBatch({
      sessionId,
      messages: [makeMessage({ role: "assistant", content })],
    });

    expect(result.ingestedCount).toBe(1);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((m) => m.content)).toEqual([content]);
  });
});

describe("LcmContextEngine stateless sessions", () => {
  const statelessSessionKey = "agent:main:subagent:worker-preview";
  const statefulSessionKey = "agent:main:main";
  const runtimeSessionId = "runtime-stateless-session";
  const statefulRuntimeSessionId = "runtime-stateful-session";

  it("matches stateless patterns on sessionKey and can be disabled globally", () => {
    const enabledEngine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });
    const disabledEngine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
      skipStatelessSessions: false,
    });

    expect(enabledEngine.isStatelessSession(statelessSessionKey)).toBe(true);
    expect(enabledEngine.isStatelessSession(statefulSessionKey)).toBe(false);
    expect(disabledEngine.isStatelessSession(statelessSessionKey)).toBe(false);
  });

  it("skips bootstrap persistence for stateless session keys", async () => {
    const sessionFile = createSessionFilePath("stateless-bootstrap");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, {
      role: "user",
      content: [{ type: "text", text: "bootstrap me" }],
    } as AgentMessage);
    appendSessionMessage(sm, {
      role: "assistant",
      content: [{ type: "text", text: "bootstrap reply" }],
    } as AgentMessage);

    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    const stateless = await engine.bootstrap({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      sessionFile,
    });

    const stateful = await engine.bootstrap({
      sessionId: statefulRuntimeSessionId,
      sessionKey: statefulSessionKey,
      sessionFile,
    });

    expect(stateless).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "stateless session",
    });
    expect(
      await engine.getConversationStore().getConversationBySessionId(runtimeSessionId),
    ).toBeNull();
    expect(stateful.bootstrapped).toBe(true);
    expect(stateful.importedMessages).toBe(2);
  });

  it("skips ingest and ingestBatch writes for stateless session keys", async () => {
    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    const ingested = await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      message: makeMessage({ role: "user", content: "drop me" }),
    });
    const batched = await engine.ingestBatch({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      messages: [
        makeMessage({ role: "user", content: "drop batch user" }),
        makeMessage({ role: "assistant", content: "drop batch assistant" }),
      ],
    });
    const included = await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "keep me" }),
    });

    expect(ingested).toEqual({ ingested: false });
    expect(batched).toEqual({ ingestedCount: 0 });
    expect(included).toEqual({ ingested: true });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(runtimeSessionId);
    expect(conversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(conversation!.conversationId),
    ).toBe(1);
  });

  it("skips ingest for assistant messages with error/aborted stop reasons and empty content", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const sessionKey = "agent:poppy:main";

    // Ingest a normal user message first
    const userResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: "ping" }),
    });
    expect(userResult).toEqual({ ingested: true });

    // Ingest an error assistant message with empty content array
    const errorResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [],
        stopReason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorResult).toEqual({ ingested: false });

    // Ingest an error assistant message with empty string content
    const errorResult2 = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: "",
        stopReason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorResult2).toEqual({ ingested: false });

    // Ingest an error assistant message using snake_case stop_reason
    const errorResult3 = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [],
        stop_reason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorResult3).toEqual({ ingested: false });

    // Ingest an aborted assistant message with no content
    const abortedResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [],
        stopReason: "aborted",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(abortedResult).toEqual({ ingested: false });

    // A normal assistant message should still be ingested
    const normalResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "assistant", content: "pong" }),
    });
    expect(normalResult).toEqual({ ingested: true });

    // An error assistant with actual content should still be ingested
    const errorWithContentResult = await engine.ingest({
      sessionId,
      sessionKey,
      message: {
        role: "assistant" as AgentMessage["role"],
        content: [{ type: "text", text: "Partial response before error" }],
        stopReason: "error",
        timestamp: Date.now(),
      } as AgentMessage,
    });
    expect(errorWithContentResult).toEqual({ ingested: true });

    // Verify only the 3 valid messages were stored despite rejected empty error turns.
    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(conversation!.conversationId),
    ).toBe(3);
  });

  it("allows assemble reads for stateless session keys", async () => {
    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "persisted context" }),
    });

    const assembled = await engine.assemble({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      messages: [],
      tokenBudget: 500,
    });

    expect(assembled.messages).toHaveLength(1);
    expect(assembled.messages[0]?.content).toBe("persisted context");
  });

  it("skips afterTurn and compact writes for stateless session keys", async () => {
    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    await engine.afterTurn({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      sessionFile: createSessionFilePath("stateless-after-turn"),
      messages: [makeMessage({ role: "assistant", content: "ignored turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 1000,
    });

    await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "persisted context" }),
    });

    const compactResult = await engine.compact({
      sessionId: runtimeSessionId,
      sessionKey: statelessSessionKey,
      sessionFile: createSessionFilePath("stateless-compact"),
      tokenBudget: 1000,
    });

    expect(compactResult).toEqual({
      ok: true,
      compacted: false,
      reason: "stateless session",
    });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(runtimeSessionId);
    expect(conversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(conversation!.conversationId),
    ).toBe(1);
  });

  it("skips delegated grant writes for stateless session keys", async () => {
    const childSessionKey = "agent:main:subagent:child-456";
    const engine = createEngineWithDeps(
      { statelessSessionPatterns: ["agent:*:subagent:worker-*"] },
      {
        resolveSessionIdFromSessionKey: vi.fn(async (sessionKey: string) =>
          sessionKey === statefulSessionKey ? runtimeSessionId : undefined,
        ),
      },
    );

    await engine.ingest({
      sessionId: runtimeSessionId,
      sessionKey: statefulSessionKey,
      message: makeMessage({ role: "user", content: "parent context" }),
    });

    const skipped = await engine.prepareSubagentSpawn({
      parentSessionKey: statelessSessionKey,
      childSessionKey,
    });
    const included = await engine.prepareSubagentSpawn({
      parentSessionKey: statefulSessionKey,
      childSessionKey,
    });

    expect(skipped).toBeUndefined();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).not.toBeNull();

    included?.rollback?.();
    expect(resolveDelegatedExpansionGrantId(childSessionKey)).toBeNull();
  });

  it("skips subagent cleanup for stateless child session keys", async () => {
    const childSessionKey = statelessSessionKey;
    createDelegatedExpansionGrant({
      delegatedSessionKey: childSessionKey,
      issuerSessionId: "issuer-1",
      allowedConversationIds: [1],
    });

    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:*:subagent:worker-*"],
    });

    await engine.onSubagentEnded({
      childSessionKey,
      reason: "deleted",
    });

    expect(resolveDelegatedExpansionGrantId(childSessionKey)).not.toBeNull();
  });
});

describe("ConversationStore session reuse", () => {
  it("reuses conversation across session resets when sessionKey matches", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const conv1 = await store.getOrCreateConversation("uuid-1", { sessionKey: "agent:main:main" });
    const conv2 = await store.getOrCreateConversation("uuid-2", { sessionKey: "agent:main:main" });

    expect(conv2.conversationId).toBe(conv1.conversationId);

    const refreshed = await store.getConversation(conv1.conversationId);
    expect(refreshed?.sessionId).toBe("uuid-2");
  });

  it("does not resolve archived conversations through active session lookup", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();
    const sessionId = "archived-lookup-session";
    const sessionKey = "agent:main:test:archived-lookup";

    const archived = await store.getOrCreateConversation(sessionId, { sessionKey });
    await store.archiveConversation(archived.conversationId, "rollover-fallback");

    expect(
      await store.getConversationForSession({
        sessionId,
        sessionKey,
      }),
    ).toBeNull();

    const replacement = await store.getOrCreateConversation(sessionId, { sessionKey });
    expect(replacement.conversationId).not.toBe(archived.conversationId);
    expect(replacement.active).toBe(true);
  });
});

describe("LcmContextEngine before_reset lifecycle", () => {
  it("prunes fresh-tail messages and low-depth summaries on /new", async () => {
    const engine = createEngineWithConfig({ newSessionRetainDepth: 2 });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const conversationStore = engine.getConversationStore();
    const summaryStore = engine.getSummaryStore();

    const conversation = await conversationStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });

    const firstMessage = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "first",
      tokenCount: 5,
    });
    const secondMessage = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 2,
      role: "assistant",
      content: "second",
      tokenCount: 5,
    });
    await summaryStore.appendContextMessages(conversation.conversationId, [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);

    await summaryStore.insertSummary({
      summaryId: "sum_d0",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "leaf",
      tokenCount: 10,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_d1",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "session arc",
      tokenCount: 10,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_d2",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 2,
      content: "project arc",
      tokenCount: 10,
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_d0");
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_d1");
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_d2");

    await engine.handleBeforeReset({
      reason: "new",
      sessionId: "uuid-2",
      sessionKey: "agent:main:main",
    });

    const remainingItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(remainingItems).toHaveLength(1);
    expect(remainingItems[0]?.summaryId).toBe("sum_d2");
  });

  it("keeps all context items on /new when retain depth is -1", async () => {
    const engine = createEngineWithConfig({ newSessionRetainDepth: -1 });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const conversationStore = engine.getConversationStore();
    const summaryStore = engine.getSummaryStore();

    const conversation = await conversationStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "first",
      tokenCount: 5,
    });
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);
    await summaryStore.insertSummary({
      summaryId: "sum_keep",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "keep me",
      tokenCount: 10,
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_keep");

    await engine.handleBeforeReset({
      reason: "new",
      sessionId: "uuid-2",
      sessionKey: "agent:main:main",
    });

    const remainingItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(remainingItems).toHaveLength(2);
    expect(remainingItems[0]?.messageId).toBe(message.messageId);
    expect(remainingItems[1]?.summaryId).toBe("sum_keep");
  });

  it("drops fresh-tail messages but keeps all summaries on /new when retain depth is 0", async () => {
    const engine = createEngineWithConfig({ newSessionRetainDepth: 0 });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const conversationStore = engine.getConversationStore();
    const summaryStore = engine.getSummaryStore();

    const conversation = await conversationStore.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    const message = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "first",
      tokenCount: 5,
    });
    await summaryStore.appendContextMessage(conversation.conversationId, message.messageId);
    await summaryStore.insertSummary({
      summaryId: "sum_keep",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "keep me",
      tokenCount: 10,
    });
    await summaryStore.appendContextSummary(conversation.conversationId, "sum_keep");

    await engine.handleBeforeReset({
      reason: "new",
      sessionId: "uuid-2",
      sessionKey: "agent:main:main",
    });

    const remainingItems = await summaryStore.getContextItems(conversation.conversationId);
    expect(remainingItems).toHaveLength(1);
    expect(remainingItems[0]?.summaryId).toBe("sum_keep");
  });

  it("archives the prior active conversation and creates a fresh active row on /reset", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    const archived = await store.getConversation(original.conversationId);

    expect(active).not.toBeNull();
    expect(active?.conversationId).not.toBe(original.conversationId);
    expect(active?.active).toBe(true);
    expect(archived?.active).toBe(false);
    expect(archived?.archivedAt).not.toBeNull();
  });

  it("creates a fresh active conversation on /reset when none exists yet", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    expect(active).not.toBeNull();
    expect(active?.active).toBe(true);
    expect(active?.sessionId).toBe("uuid-1");
  });

  it("treats repeated /reset on an already fresh conversation as a no-op", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    const firstFresh = await store.getConversationBySessionKey("agent:main:main");

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    const secondFresh = await store.getConversationBySessionKey("agent:main:main");

    expect(firstFresh?.conversationId).not.toBe(original.conversationId);
    expect(secondFresh?.conversationId).toBe(firstFresh?.conversationId);
  });
});

describe("LcmContextEngine session_end lifecycle", () => {
  it("ignores session_end new so /new stays a prune-in-place flow", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleSessionEnd({
      reason: "new",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
      nextSessionId: "uuid-2",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    expect(active?.conversationId).toBe(original.conversationId);
    expect(active?.active).toBe(true);
  });

  for (const reason of ["restart", "shutdown"] as const) {
    it(`ignores session_end ${reason} so gateway lifecycle does not orphan conversation history`, async () => {
      const engine = createEngine();
      (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
      const store = engine.getConversationStore();

      const original = await store.getOrCreateConversation("uuid-1", {
        sessionKey: "agent:main:main",
      });
      await store.createMessage({
        conversationId: original.conversationId,
        seq: 1,
        role: "user",
        content: "seed",
        tokenCount: 5,
      });

      await engine.handleSessionEnd({
        reason,
        sessionId: "uuid-1",
        sessionKey: "agent:main:main",
        nextSessionId: "uuid-2",
      });

      const active = await store.getConversationBySessionKey("agent:main:main");
      const originalAfterLifecycle = await store.getConversation(original.conversationId);

      expect(active?.conversationId).toBe(original.conversationId);
      expect(active?.active).toBe(true);
      expect(originalAfterLifecycle?.active).toBe(true);
      expect(originalAfterLifecycle?.archivedAt).toBeNull();
    });
  }

  it("archives the prior active conversation and creates a fresh active row on idle rollover", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleSessionEnd({
      reason: "idle",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
      nextSessionId: "uuid-2",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    const archived = await store.getConversation(original.conversationId);

    expect(active).not.toBeNull();
    expect(active?.conversationId).not.toBe(original.conversationId);
    expect(active?.sessionId).toBe("uuid-2");
    expect(active?.active).toBe(true);
    expect(archived?.active).toBe(false);
    expect(archived?.archivedAt).not.toBeNull();
  });

  it("archives the active conversation without replacement on deleted session_end", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleSessionEnd({
      reason: "deleted",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });

    const active = await store.getConversationBySessionKey("agent:main:main");
    const archived = await store.getConversation(original.conversationId);

    expect(active).toBeNull();
    expect(archived?.active).toBe(false);
    expect(archived?.archivedAt).not.toBeNull();
  });

  it("treats session_end reset after before_reset as a no-op on the fresh replacement row", async () => {
    const engine = createEngine();
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const store = engine.getConversationStore();

    const original = await store.getOrCreateConversation("uuid-1", {
      sessionKey: "agent:main:main",
    });
    await store.createMessage({
      conversationId: original.conversationId,
      seq: 1,
      role: "user",
      content: "seed",
      tokenCount: 5,
    });

    await engine.handleBeforeReset({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
    });
    const firstFresh = await store.getConversationBySessionKey("agent:main:main");

    await engine.handleSessionEnd({
      reason: "reset",
      sessionId: "uuid-1",
      sessionKey: "agent:main:main",
      nextSessionId: "uuid-2",
    });
    const secondFresh = await store.getConversationBySessionKey("agent:main:main");

    expect(firstFresh?.conversationId).not.toBe(original.conversationId);
    expect(secondFresh?.conversationId).toBe(firstFresh?.conversationId);
  });
});

describe("LcmContextEngine delegated session continuity", () => {
  it("prepares subagent spawn from an existing conversation found by sessionKey", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
    tempDirs.push(tempDir);
    const config = createTestConfig(join(tempDir, "lcm.db"));
    const db = createLcmDatabaseConnection(config.databasePath);
    const deps = createTestDeps(config);
    deps.resolveSessionIdFromSessionKey = vi.fn(async () => "uuid-after-reset");
    const engine = new LcmContextEngine(deps, db);

    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    await engine
      .getConversationStore()
      .getOrCreateConversation("uuid-before-reset", { sessionKey: "agent:main:main" });

    const prepared = await engine.prepareSubagentSpawn({
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:main:subagent:child",
    });

    expect(prepared).toBeDefined();
  });
});

// ── Ingest content extraction ───────────────────────────────────────────────

describe("LcmContextEngine connection lifecycle", () => {
  it("keeps shared sqlite handle open while another engine instance is active", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-shared-db-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");

    const engineA = createEngineAtDatabasePath(dbPath);
    const engineB = createEngineAtDatabasePath(dbPath);
    const sessionId = randomUUID();

    await engineA.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "first" }),
    });

    await engineA.dispose();

    await expect(
      engineB.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: "second" }),
      }),
    ).resolves.toEqual({ ingested: true });
  });
});

// ── Bootstrap ───────────────────────────────────────────────────────────────

