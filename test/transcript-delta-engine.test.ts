import { afterEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmConfig } from "../src/db/config.js";
import type { LcmContextEngine } from "../src/engine.js";
import { buildMessageParts, toStoredMessage } from "../src/message-content.js";
import { cleanupEngineTestState, createEngineWithDepsOverridesAndDb } from "./helpers.js";
import { FakeTranscriptHost } from "./transcript-delta-fake-host.js";

afterEach(cleanupEngineTestState);

const sessionId = "delta-session";
const sessionKey = "agent:main:delta-session";
const sessionTarget = { agentId: "main", sessionId, sessionKey };

function user(content: string): AgentMessage {
  return { role: "user", content } as AgentMessage;
}

function assistant(content: string): AgentMessage {
  return { role: "assistant", content: [{ type: "text", text: content }] } as unknown as AgentMessage;
}

/** Assistant message carrying only a tool call; stores empty text content. */
function toolCallOnly(toolCallId: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: { command: "true" } }],
  } as unknown as AgentMessage;
}

function toolResult(toolCallId: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "exec",
    content: [{ type: "text", text }],
  } as unknown as AgentMessage;
}

function setup(configOverrides: Partial<LcmConfig> = {}) {
  const host = new FakeTranscriptHost(sessionId);
  const readVisibleSessionTranscriptMessageEntries = vi.fn(host.readVisibleEntries);
  const { engine, db } = createEngineWithDepsOverridesAndDb(
    {
      readSessionTranscriptVisibleMessageDelta: host.readVisibleDelta,
      readSessionTranscriptRawDelta: host.readRawDelta,
      readVisibleSessionTranscriptMessageEntries,
    },
    configOverrides,
  );
  return { host, engine, db, readVisibleSessionTranscriptMessageEntries };
}

function bootstrap(engine: LcmContextEngine) {
  return engine.bootstrap({ sessionId, sessionKey, sessionTarget });
}

function afterTurn(
  engine: LcmContextEngine,
  messages: AgentMessage[],
  extra: { isHeartbeat?: boolean; autoCompactionSummary?: string } = {},
) {
  return engine.afterTurn({
    sessionId,
    sessionKey,
    sessionTarget,
    sessionFile: "",
    messages,
    prePromptMessageCount: 0,
    tokenBudget: 200_000,
    ...extra,
  });
}

/** Build commitTurn params for the host range [admissionId .. terminalId]. */
function commitParams(host: FakeTranscriptHost, admissionId: string, terminalId: string, key = admissionId) {
  const admissionPosition = host.positionOf(admissionId);
  const terminalPosition = host.positionOf(terminalId);
  const anchor = (entryId: string, activeMessagePosition: number) => ({
    agentId: "main",
    sessionId,
    sessionKey,
    storePath: "/tmp/openclaw-agent.sqlite",
    generation: host.generation,
    entryId,
    rawSeq: activeMessagePosition,
    effectiveParentId: null,
    activeMessagePosition,
  });
  return {
    advancementKey: key,
    admission: { ...anchor(admissionId, admissionPosition), logicalTurnId: key, role: "user" as const },
    terminal: anchor(terminalId, terminalPosition),
    messages: host
      .visibleMessages()
      .slice(admissionPosition, terminalPosition + 1)
      .map((event) => event.message),
    sessionId,
    sessionKey,
  };
}

function rows(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT m.role, m.content, m.transcript_entry_id AS entryId
       FROM messages m JOIN conversations c ON c.conversation_id = m.conversation_id
       WHERE c.active = 1 AND c.session_key = ?
       ORDER BY m.seq`,
    )
    .all(sessionKey) as Array<{ role: string; content: string; entryId: string | null }>;
}

function unstampedRowCount(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE transcript_entry_id IS NULL`).get() as {
    n: number;
  }).n;
}

function cursorRow(db: DatabaseSync) {
  return db
    .prepare(
      `SELECT t.mode, t.origin, t.frontier_seq AS frontierSeq
       FROM conversation_transcript_cursors t JOIN conversations c ON c.conversation_id = t.conversation_id
       WHERE c.active = 1 AND c.session_key = ?`,
    )
    .get(sessionKey) as { mode: string; origin: string; frontierSeq: number } | undefined;
}

describe("transcript delta single writer through engine entry points", () => {
  it("bootstrap -> commitTurn -> afterTurn reads only the delta and never stores runtime arrays", async () => {
    const { host, engine, db, readVisibleSessionTranscriptMessageEntries } = setup();
    host.append(user("hello"));
    host.append(assistant("hi there"));

    await expect(bootstrap(engine)).resolves.toMatchObject({ bootstrapped: true, importedMessages: 2 });
    expect(cursorRow(db)).toMatchObject({ mode: "cursor_v1", origin: "fresh", frontierSeq: 2 });

    // Turn 2: the admission is appended before bootstrap; the host fence hides it.
    const admission = host.append(user("second question"));
    host.fencePosition = host.positionOf(admission);
    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 0 });
    expect(rows(db).map((row) => row.content)).toEqual(["hello", "hi there"]);

    host.fencePosition = null;
    const terminal = host.append(assistant("second answer"));
    await expect(engine.commitTurn(commitParams(host, admission, terminal))).resolves.toEqual({
      status: "committed",
    });
    expect(rows(db).map((row) => row.content)).toEqual([
      "hello",
      "hi there",
      "second question",
      "second answer",
    ]);
    expect(
      db.prepare(`SELECT message_count FROM turn_advancements WHERE advancement_key = ?`).get(admission),
    ).toEqual({ message_count: 2 });

    // afterTurn receives a runtime-only message and a compaction summary; neither is stored.
    host.append(user("third"));
    await afterTurn(engine, [user("third"), assistant("runtime only, never in transcript")], {
      autoCompactionSummary: "host summary",
    });
    expect(rows(db).map((row) => row.content)).toEqual([
      "hello",
      "hi there",
      "second question",
      "second answer",
      "third",
    ]);
    expect(unstampedRowCount(db)).toBe(0);

    // Steady state: one visible-delta read that returns nothing; the full read never runs.
    host.visibleReads = 0;
    host.visibleEntriesReturned = 0;
    await bootstrap(engine);
    await afterTurn(engine, []);
    expect(host.visibleReads).toBe(2);
    expect(host.visibleEntriesReturned).toBe(0);
    expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
  });

  it("routes ingest and ingestBatch through the delta instead of their payloads", async () => {
    const { host, engine, db } = setup();
    host.append(user("from transcript"));
    await expect(
      engine.ingestBatch({ sessionId, sessionKey, messages: [user("runtime payload")] }),
    ).resolves.toEqual({ ingestedCount: 1 });
    await expect(engine.ingest({ sessionId, sessionKey, message: user("runtime single") })).resolves.toEqual({
      ingested: false,
    });
    expect(rows(db).map((row) => row.content)).toEqual(["from transcript"]);
    expect(unstampedRowCount(db)).toBe(0);
  });

  it("keeps commitTurn idempotent and leaves turns uncommitted while the projection rebuilds", async () => {
    const { host, engine, db } = setup();
    const admission = host.append(user("q"));
    const terminal = host.append(assistant("a"));
    const params = commitParams(host, admission, terminal);

    host.unavailable = true;
    await expect(engine.commitTurn(params)).rejects.toThrow(/transcript delta unavailable/);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM turn_advancements`).get()).toEqual({ n: 0 });
    expect(rows(db)).toEqual([]);

    host.unavailable = false;
    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "committed" });
    await expect(engine.commitTurn(params)).resolves.toEqual({ status: "duplicate" });
    await expect(
      engine.commitTurn({ ...params, messages: [user("other"), assistant("payload")] }),
    ).rejects.toThrow(/advancement key collision/);
    expect(rows(db).map((row) => row.content)).toEqual(["q", "a"]);
  });

  it("proceeds with stored state when the projection is unavailable and catches up later", async () => {
    const { host, engine, db } = setup();
    host.append(user("one"));
    await bootstrap(engine);
    host.append(assistant("two"));
    host.unavailable = true;
    await expect(bootstrap(engine)).resolves.toMatchObject({
      importedMessages: 0,
      reason: "transcript projection rebuilding",
    });
    expect(rows(db)).toHaveLength(1);
    host.unavailable = false;
    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 1 });
  });

  it("treats a cursor past the current-turn fence as already covered", async () => {
    const { host, engine, db } = setup();
    const admission = host.append(user("q"));
    host.append(assistant("a"));
    await bootstrap(engine);
    host.fencePosition = host.positionOf(admission);
    await expect(bootstrap(engine)).resolves.toMatchObject({
      importedMessages: 0,
      reason: "transcript read fenced at current turn",
    });
    expect(rows(db)).toHaveLength(2);
  });

  it("does not drain heartbeat turns that are not preserved", async () => {
    const { host, engine, db } = setup();
    host.append(user("real"));
    await bootstrap(engine);
    host.append(user("heartbeat poll"));
    host.visibleReads = 0;
    await afterTurn(engine, [user("heartbeat poll")], { isHeartbeat: true });
    expect(host.visibleReads).toBe(0);
    expect(rows(db)).toHaveLength(1);
  });
});

describe("transcript delta resync", () => {
  async function seeded() {
    const context = setup();
    const ids = [
      context.host.append(user("u1")),
      context.host.append(assistant("a1")),
      context.host.append(user("u2")),
      context.host.append(assistant("a2")),
    ];
    await bootstrap(context.engine);
    return { ...context, ids };
  }

  it("resyncs a generation_mismatch in bulk and idempotently", async () => {
    const { host, engine, db, ids } = await seeded();
    host.rewriteInPlace(ids[1]!, assistant("a1 edited in place"));
    const store = engine.getConversationStore();
    const candidateSpy = vi.spyOn(store, "getTranscriptEntryAnchorCandidate");
    const partsSpy = vi.spyOn(store, "getMessageParts");

    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 0 });
    expect(candidateSpy).not.toHaveBeenCalled();
    expect(partsSpy).not.toHaveBeenCalled();
    const before = rows(db);
    expect(before.map((row) => row.content)).toEqual(["u1", "a1", "u2", "a2"]);

    // A second rotation over the same ids is again a no-op, and the next call is incremental.
    host.rotate();
    await bootstrap(engine);
    expect(rows(db)).toEqual(before);
    host.visibleReads = 0;
    await bootstrap(engine);
    expect(host.visibleReads).toBe(1);
  });

  it("restamps rows named by supersedesEntryId instead of importing", async () => {
    const { host, engine, db, ids } = await seeded();
    const mapping = host.rewriteSuffixFrom(ids[2]!, { declareSupersedes: true });
    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 0 });
    expect(rows(db).map((row) => row.entryId)).toEqual([
      ids[0],
      ids[1],
      mapping.get(ids[2]!),
      mapping.get(ids[3]!),
    ]);
  });

  it("content-matches a rewritten suffix in order without supersedes markers", async () => {
    const { host, engine, db, ids } = await seeded();
    const mapping = host.rewriteSuffixFrom(ids[2]!, { declareSupersedes: false });
    host.append(user("u3"));
    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 1 });
    expect(rows(db).map((row) => [row.content, row.entryId])).toEqual([
      ["u1", ids[0]],
      ["a1", ids[1]],
      ["u2", mapping.get(ids[2]!)],
      ["a2", mapping.get(ids[3]!)],
      ["u3", expect.any(String)],
    ]);
  });

  it("keeps the older row instead of appending a replaced entry out of order", async () => {
    const { host, engine, db, ids } = await seeded();
    const mapping = host.rewriteSuffixFrom(ids[2]!, {
      declareSupersedes: false,
      replace: () => user("u2 truncated"),
    });
    await bootstrap(engine);
    expect(rows(db).map((row) => [row.content, row.entryId])).toEqual([
      ["u1", ids[0]],
      ["a1", ids[1]],
      ["u2", ids[2]],
      ["a2", mapping.get(ids[3]!)],
    ]);
  });
});

describe("transcript delta reset window", () => {
  it("does not import pre-reset history into the conversation created by /reset", async () => {
    const { host, engine, db } = setup();
    host.appendControl("model_change");
    host.append(user("before reset"));
    host.append(assistant("old answer"));
    await bootstrap(engine);

    host.appendControl("reset");
    await engine.handleBeforeReset({ reason: "reset", sessionId, sessionKey });
    host.append(user("after reset"));
    host.append(assistant("new answer"));

    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 2 });
    expect(rows(db).map((row) => row.content)).toEqual(["after reset", "new answer"]);
    const archived = db
      .prepare(`SELECT COUNT(*) AS n FROM conversations WHERE active = 0 AND archive_cause = 'manual-reset'`)
      .get() as { n: number };
    expect(archived.n).toBe(1);
  });

  it("does not back-fill pre-reset history when a post-reset conversation resyncs", async () => {
    const { host, engine, db } = setup();
    host.append(user("before reset"));
    host.appendControl("reset");
    await engine.handleBeforeReset({ reason: "reset", sessionId, sessionKey });
    host.append(user("after reset"));
    await bootstrap(engine);
    host.rotate();
    host.append(assistant("answer"));
    await bootstrap(engine);
    expect(rows(db).map((row) => row.content)).toEqual(["after reset", "answer"]);
  });
});

describe("one-time legacy migration", () => {
  /** Engine over `host` plus a legacy conversation seeded directly in the store. */
  async function legacyConversation(
    host: FakeTranscriptHost,
    seed: Array<{ role: "user" | "assistant"; content: string; entryId?: string }>,
  ) {
    const readVisibleSessionTranscriptMessageEntries = vi.fn(host.readVisibleEntries);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readSessionTranscriptVisibleMessageDelta: host.readVisibleDelta,
      readSessionTranscriptRawDelta: host.readRawDelta,
      readVisibleSessionTranscriptMessageEntries,
    });
    const store = engine.getConversationStore();
    const conversation = await store.getOrCreateConversation(sessionId, { sessionKey });
    await store.markConversationBootstrapped(conversation.conversationId);
    for (const [index, row] of seed.entries()) {
      const message = await store.createMessage({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: row.role,
        content: row.content,
        tokenCount: 3,
        ...(row.entryId ? { transcriptEntryId: row.entryId } : {}),
      });
      await engine.getSummaryStore().appendContextMessage(conversation.conversationId, message.messageId);
    }
    return { engine, db, readVisibleSessionTranscriptMessageEntries };
  }

  /** Like `legacyConversation`, but stores full messages with their parts as ingestion does. */
  async function legacyConversationFromMessages(
    host: FakeTranscriptHost,
    seed: Array<{ message: AgentMessage; entryId?: string }>,
  ) {
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readSessionTranscriptVisibleMessageDelta: host.readVisibleDelta,
      readSessionTranscriptRawDelta: host.readRawDelta,
      readVisibleSessionTranscriptMessageEntries: vi.fn(host.readVisibleEntries),
    });
    const store = engine.getConversationStore();
    const conversation = await store.getOrCreateConversation(sessionId, { sessionKey });
    await store.markConversationBootstrapped(conversation.conversationId);
    for (const [index, { message, entryId }] of seed.entries()) {
      const stored = toStoredMessage(message);
      const record = await store.createMessage({
        conversationId: conversation.conversationId,
        seq: index + 1,
        role: stored.role,
        content: stored.content,
        tokenCount: stored.tokenCount,
        ...(entryId ? { transcriptEntryId: entryId } : {}),
      });
      await store.createMessageParts(
        record.messageId,
        buildMessageParts({ sessionId, message, fallbackContent: stored.content }),
      );
      await engine.getSummaryStore().appendContextMessage(conversation.conversationId, record.messageId);
    }
    return { engine, db };
  }

  it("stamps legacy rows by in-order content match, then drains incrementally", async () => {
    const host = new FakeTranscriptHost(sessionId);
    const ids = [host.append(user("legacy one")), host.append(assistant("legacy two"))];
    const { engine, db, readVisibleSessionTranscriptMessageEntries } = await legacyConversation(host, [
      { role: "user", content: "legacy one" },
      { role: "assistant", content: "legacy two" },
    ]);
    host.append(user("new after upgrade"));

    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 1 });
    expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
    expect(cursorRow(db)).toMatchObject({ mode: "cursor_v1", origin: "legacy-migration" });
    const migrated = rows(db);
    expect(migrated.map((row) => row.content)).toEqual(["legacy one", "legacy two", "new after upgrade"]);
    expect(migrated.slice(0, 2).map((row) => row.entryId)).toEqual(ids);

    host.append(assistant("steady"));
    host.visibleReads = 0;
    await bootstrap(engine);
    expect(host.visibleReads).toBe(1);
    expect(rows(db).map((row) => row.content).at(-1)).toBe("steady");
  });

  it("anchors on the last visible stamped id and imports the whole suffix without a cap", async () => {
    const host = new FakeTranscriptHost(sessionId);
    const first = host.append(user("first"));
    const { engine, db } = await legacyConversation(host, [{ role: "user", content: "first", entryId: first }]);
    for (let index = 0; index < 120; index += 1) {
      host.append(index % 2 === 0 ? assistant(`answer ${index}`) : user(`question ${index}`));
    }
    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 120 });
    expect(rows(db)).toHaveLength(121);
    expect(cursorRow(db)).toMatchObject({ origin: "legacy-migration", frontierSeq: 121 });
  });

  it("never deletes rows, clears ids, or imports before the anchor", async () => {
    const host = new FakeTranscriptHost(sessionId);
    const kept = host.append(user("kept question"));
    host.append(assistant("visible but never stored"));
    const anchor = host.append(user("anchor question"));
    const { engine, db } = await legacyConversation(host, [
      // A stamped row whose stored content no longer matches its entry.
      { role: "user", content: "content drifted from the transcript", entryId: kept },
      { role: "assistant", content: "unstamped legacy row" },
      { role: "user", content: "anchor question", entryId: anchor },
    ]);
    host.append(assistant("after anchor"));
    const before = rows(db);

    await bootstrap(engine);
    const after = rows(db);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(after.map((row) => row.content).slice(before.length)).toEqual(["after anchor"]);
  });

  it("matches tool-call-only rows by tool-call id, not into an older unstored hole", async () => {
    // Legacy shape: rows stop at an anchor, the old code never stored the next
    // stretch (the hole), then appended the newest turn without ids. Every
    // tool-call-only assistant message stores empty content, so they all share
    // one identity hash; only their tool-call ids tell them apart.
    const host = new FakeTranscriptHost(sessionId);
    const anchor = host.append(user("anchor question"));
    host.append(toolCallOnly("call-hole-1"));
    host.append(toolResult("call-hole-1", "hole output 1"));
    host.append(toolCallOnly("call-hole-2"));
    host.append(toolResult("call-hole-2", "hole output 2"));
    const newerTurn = [
      user("newest question"),
      toolCallOnly("call-new-1"),
      toolResult("call-new-1", "new output 1"),
      toolCallOnly("call-new-2"),
      toolResult("call-new-2", "new output 2"),
      assistant("newest answer"),
    ];
    const newerIds = newerTurn.map((message) => host.append(message));
    const { engine, db } = await legacyConversationFromMessages(host, [
      { message: user("anchor question"), entryId: anchor },
      ...newerTurn.map((message) => ({ message })),
    ]);

    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 0 });
    const migrated = rows(db);
    expect(migrated).toHaveLength(7);
    expect(migrated.map((row) => row.entryId)).toEqual([anchor, ...newerIds]);
  });

  it("imports nothing without an anchor or content match, keeping every legacy row", async () => {
    const host = new FakeTranscriptHost(sessionId);
    host.append(user("decorated transcript text"));
    const { engine, db } = await legacyConversation(host, [{ role: "user", content: "legacy runtime text" }]);
    await expect(bootstrap(engine)).resolves.toMatchObject({ importedMessages: 0 });
    expect(rows(db).map((row) => [row.content, row.entryId])).toEqual([["legacy runtime text", null]]);
    host.append(assistant("next turn"));
    await bootstrap(engine);
    expect(rows(db).map((row) => row.content)).toEqual(["legacy runtime text", "next turn"]);
  });
});

describe("missing visible-delta reader", () => {
  it("is a logged capability error, never a fallback to the legacy reconcile", async () => {
    const host = new FakeTranscriptHost(sessionId);
    host.append(user("hello"));
    const readVisibleSessionTranscriptMessageEntries = vi.fn(host.readVisibleEntries);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readSessionTranscriptVisibleMessageDelta: undefined,
      readVisibleSessionTranscriptMessageEntries,
    });
    const error = Reflect.get(engine, "deps").log.error as ReturnType<typeof vi.fn>;

    await expect(bootstrap(engine)).resolves.toMatchObject({
      importedMessages: 0,
      reason: "transcript delta reader unavailable",
    });
    await afterTurn(engine, [user("hello")]);
    const admission = host.visibleMessages()[0]!.id;
    await expect(engine.commitTurn(commitParams(host, admission, admission))).rejects.toThrow(
      /transcript delta reader unavailable/,
    );
    expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
    expect(rows(db)).toEqual([]);
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0]?.[0])).toContain("readSessionTranscriptVisibleMessageDelta is required");
  });
});

describe("transcript delta paging", () => {
  it("drains many pages and grows the byte bound for one oversized entry", async () => {
    const { host, engine, db } = setup({ bootstrapMaxTokens: 100_000_000 });
    for (let index = 0; index < 2_100; index += 1) {
      host.append(user(`message ${index}`));
    }
    await bootstrap(engine);
    expect(rows(db)).toHaveLength(2_100);
    host.append(assistant("x".repeat(9 * 1024 * 1024)));
    host.visibleReads = 0;
    await bootstrap(engine);
    expect(rows(db)).toHaveLength(2_101);
    expect(host.visibleReads).toBe(2);
  });
});
