import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeLcmConnection } from "../src/db/connection.js";
import type {
  ContextEngine,
  TranscriptEntryAnchor,
  TranscriptTurnAdmission,
} from "../src/openclaw-bridge.js";
import {
  cleanupEngineTestState,
  createEngine,
  createEngineAtDatabasePath,
  createEngineWithConfig,
  makeMessage,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

/** Receipt produced for the default fixture by lossless-claw 1.0.0-beta.1. */
const BETA_1_RECEIPT_HASH =
  "894ebf9d9233e5d8ceb3da959cac9a4bb2ebf422633e65cacb4750fdbb8c8dfb";

function buildCommitTurnParams(overrides?: {
  advancementKey?: string;
  answer?: string;
}): Parameters<NonNullable<ContextEngine["commitTurn"]>>[0] {
  const sessionId = "durable-turn-session";
  const sessionKey = "agent:main:durable-turn-session";
  const storePath = "/tmp/openclaw-agent.sqlite";
  const generation = "generation-1";
  const advancementKey = overrides?.advancementKey ?? "logical-turn-1";
  const admission: TranscriptTurnAdmission = {
    activeMessagePosition: 41,
    agentId: "main",
    effectiveParentId: "prior-entry",
    entryId: "user-entry",
    generation,
    logicalTurnId: advancementKey,
    rawSeq: 2,
    role: "user",
    sessionId,
    sessionKey,
    storePath,
  };
  const terminal: TranscriptEntryAnchor = {
    activeMessagePosition: 42,
    agentId: "main",
    effectiveParentId: admission.entryId,
    entryId: "assistant-entry",
    generation,
    rawSeq: 3,
    sessionId,
    sessionKey,
    storePath,
  };
  return {
    advancementKey,
    admission,
    terminal,
    messages: [
      makeMessage({ role: "user", content: "current question", timestamp: 2_000 }),
      makeMessage({
        role: "assistant",
        content: overrides?.answer ?? "current answer",
        timestamp: 3_000,
      }),
    ],
    sessionId,
    sessionKey,
    sessionTarget: {
      agentId: admission.agentId,
      sessionId,
      sessionKey,
      storePath,
    },
  };
}

async function readStoredMessages(engine: ReturnType<typeof createEngine>) {
  const conversation = await engine
    .getConversationStore()
    .getConversationBySessionId("durable-turn-session");
  if (!conversation) {
    return [];
  }
  return engine.getConversationStore().getMessages(conversation.conversationId);
}

function getEngineDatabase(engine: ReturnType<typeof createEngine>): DatabaseSync {
  return (engine as unknown as { db: DatabaseSync }).db;
}

describe("LcmContextEngine commitTurn", () => {
  it("declares the fenced atomic-idempotent transcript contract", () => {
    const engine = createEngine();

    expect(engine.info.transcriptSemantics).toEqual({
      currentTurnFence: "before-current-turn-entry-v1",
      turnAdvancementIdempotency: "atomic-idempotent-v1",
    });
  });

  it("atomically commits only the accepted turn delta and its ledger receipt", async () => {
    const engine = createEngine();
    const params = buildCommitTurnParams();

    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });

    expect((await readStoredMessages(engine)).map((message) => message.content)).toEqual([
      "current question",
      "current answer",
    ]);
    const ledger = getEngineDatabase(engine)
      .prepare(
        `SELECT advancement_key, session_id, session_key, admission_entry_id,
                terminal_entry_id, message_count, length(payload_hash) AS hash_length
         FROM turn_advancements`,
      )
      .get() as Record<string, unknown>;
    expect(ledger).toMatchObject({
      advancement_key: params.advancementKey,
      session_id: params.sessionId,
      session_key: params.sessionKey,
      admission_entry_id: params.admission.entryId,
      terminal_entry_id: params.terminal.entryId,
      message_count: 2,
      hash_length: 64,
    });
  });

  it("preserves recurrent model-authored tool results across committed turns", async () => {
    const engine = createEngine();
    const commands = ["ls /tmp/first", "ls /tmp/second"];

    for (const [index, command] of commands.entries()) {
      const params = buildCommitTurnParams({ advancementKey: `tool-turn-${index + 1}` });
      const startPosition = 41 + index * 4;
      params.admission = {
        ...params.admission,
        activeMessagePosition: startPosition,
        entryId: `user-entry-${index + 1}`,
      };
      params.terminal = {
        ...params.terminal,
        activeMessagePosition: startPosition + 3,
        effectiveParentId: `tool-result-entry-${index + 1}`,
        entryId: `assistant-entry-${index + 1}`,
      };
      params.messages = [
        makeMessage({ role: "user", content: `run ${command}` }),
        makeMessage({
          role: "assistant",
          content: [{ type: "tool_use", id: "exec:101", name: "exec", input: { command } }],
        }),
        makeMessage({
          role: "toolResult",
          toolCallId: "exec:101",
          content: [{ type: "text", text: "(no output)" }],
        }),
        makeMessage({ role: "assistant", content: `finished ${command}` }),
      ];

      await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });
    }

    const stored = await readStoredMessages(engine);
    expect(
      stored.filter((message) => message.role === "tool").map((message) => message.content),
    ).toEqual(["(no output)", "(no output)"]);
    expect(stored).toHaveLength(8);
  });

  it("rejects a terminal anchor outside the supplied message range", async () => {
    const engine = createEngine();
    const params = buildCommitTurnParams();
    params.messages = params.messages.slice(0, 1);

    await expect(engine.commitTurn(params)).rejects.toThrow(
      "turn advancement transcript range is invalid",
    );

    expect(await readStoredMessages(engine)).toHaveLength(0);
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM turn_advancements").get(),
    ).toEqual({ count: 0 });
  });

  it("returns duplicate without repeating message or context persistence", async () => {
    const engine = createEngine();
    const params = buildCommitTurnParams();

    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });
    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "duplicate" });

    expect(await readStoredMessages(engine)).toHaveLength(2);
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM context_items").get(),
    ).toEqual({ count: 2 });
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM turn_advancements").get(),
    ).toEqual({ count: 1 });
  });

  it("recognizes a beta.1 receipt after the turn-local contract upgrade", async () => {
    const engine = createEngine();
    const params = buildCommitTurnParams();
    await engine.commitTurn(params);
    getEngineDatabase(engine)
      .prepare("UPDATE turn_advancements SET payload_hash = ? WHERE advancement_key = ?")
      .run(BETA_1_RECEIPT_HASH, params.advancementKey);

    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "duplicate" });
    expect(await readStoredMessages(engine)).toHaveLength(2);
  });

  it("includes the admitted user message in retry identity", async () => {
    const engine = createEngine();
    const params = buildCommitTurnParams();
    await engine.commitTurn(params);
    params.messages[0] = makeMessage({
      role: "user",
      content: "colliding question",
      timestamp: 1_500,
    });

    await expect(engine.commitTurn(params)).rejects.toThrow(
      `context-engine advancement key collision: ${params.advancementKey}`,
    );
    expect((await readStoredMessages(engine)).map((message) => message.content)).toEqual([
      "current question",
      "current answer",
    ]);
  });

  it("acknowledges excluded session turns without writing LCM state", async () => {
    const engine = createEngineWithConfig({
      ignoreSessionPatterns: ["agent:main:durable-turn-session"],
    });
    const params = buildCommitTurnParams();

    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });
    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });

    expect(await readStoredMessages(engine)).toHaveLength(0);
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM context_items").get(),
    ).toEqual({ count: 0 });
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM turn_advancements").get(),
    ).toEqual({ count: 0 });
  });

  it("acknowledges stateless session turns without writing LCM state", async () => {
    const engine = createEngineWithConfig({
      statelessSessionPatterns: ["agent:main:durable-turn-session"],
      skipStatelessSessions: true,
    });
    const params = buildCommitTurnParams();

    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });
    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });

    expect(await readStoredMessages(engine)).toHaveLength(0);
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM context_items").get(),
    ).toEqual({ count: 0 });
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM turn_advancements").get(),
    ).toEqual({ count: 0 });
  });

  it("records deferred compaction debt after a durable turn commit", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const params = buildCommitTurnParams();
    params.runtimeContext = {
      currentTokenCount: 1_000,
      tokenBudget: 100,
    };

    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(params.sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).toMatchObject({
      currentTokenCount: 1_000,
      reason: "threshold",
      tokenBudget: 100,
    });
  });

  it("fails closed when the same advancement key carries a different payload", async () => {
    const engine = createEngine();
    const params = buildCommitTurnParams();
    await engine.commitTurn(params);

    await expect(
      engine.commitTurn(buildCommitTurnParams({ answer: "colliding answer" })),
    ).rejects.toThrow(`context-engine advancement key collision: ${params.advancementKey}`);

    expect((await readStoredMessages(engine)).map((message) => message.content)).toEqual([
      "current question",
      "current answer",
    ]);
  });

  it("rolls back messages, context, and ledger together when persistence fails", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      ingestSingle: (params: Record<string, unknown>) => Promise<{ ingested: boolean }>;
    };
    const originalIngest = privateEngine.ingestSingle.bind(privateEngine);
    const ingestSpy = vi
      .spyOn(privateEngine, "ingestSingle")
      .mockImplementationOnce(async (params) => {
        await originalIngest(params);
        throw new Error("injected persistence failure");
      });

    await expect(engine.commitTurn(buildCommitTurnParams())).rejects.toThrow(
      "injected persistence failure",
    );
    expect(await readStoredMessages(engine)).toHaveLength(0);
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM context_items").get(),
    ).toEqual({ count: 0 });
    expect(
      getEngineDatabase(engine).prepare("SELECT count(*) AS count FROM turn_advancements").get(),
    ).toEqual({ count: 0 });

    ingestSpy.mockRestore();
    await expect(engine.commitTurn(buildCommitTurnParams())).resolves.toEqual({
      status: "committed",
    });
    expect(await readStoredMessages(engine)).toHaveLength(2);
  });

  it("recognizes a committed advancement after the engine restarts", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-durable-turn-"));
    tempDirs.push(tempDir);
    const databasePath = join(tempDir, "lcm.db");
    const firstEngine = createEngineAtDatabasePath(databasePath);
    const params = buildCommitTurnParams();
    await firstEngine.commitTurn(params);
    closeLcmConnection(databasePath);

    const restartedEngine = createEngineAtDatabasePath(databasePath);
    await expect(restartedEngine.commitTurn(params)).resolves.toEqual({ status: "duplicate" });
    expect(await readStoredMessages(restartedEngine)).toHaveLength(2);
  });
});
