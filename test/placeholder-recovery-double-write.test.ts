// On a brand-new conversation whose first turn was persisted by the live
// afterTurn ingest (a decorated, id-less row) BEFORE the session jsonl was
// flushed, the placeholder-checkpoint recovery later re-imports the same turn's
// bare, id-bearing transcript row. The bare and decorated faces differ on both
// identity_hash and content, so the existing entry-id / exact-content adoption
// misses them and the bare row is imported as a duplicate (and the spurious new
// epoch strips the agent's continuity). Recovery must dedup the bare row against
// the already-persisted decorated runtime row instead of importing it.
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appendSessionMessage,
  cleanupEngineTestState,
  createEngineWithDeps,
  createSessionFilePath,
  makeMessage,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const BODY = "what did we decide about the deploy window?";

// The live afterTurn ingest persists the DECORATED, id-less face of a turn: an
// OpenClaw room-event inbound (non-anchoring frontier) whose trailing line is
// the real user body.
function decoratedRoomEvent(body: string): string {
  return [
    "Conversation info (untrusted metadata):",
    "```json",
    JSON.stringify({
      chat_id: "telegram:10000000x",
      inbound_event_kind: "room_event",
      sender: "sam.rivera",
    }),
    "```",
    "",
    `[Sun 2026-06-21 13:19 GMT+3] ${body}`,
  ].join("\n");
}

const DECORATED_FIRST_TURN = decoratedRoomEvent(BODY);

describe("placeholder-checkpoint recovery double-write", () => {
  it("dedups the bare transcript row of a turn already persisted decorated instead of double-writing it", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = "new-conv-double-write";
    const sessionKey = "agent:agent-one:telegram:new-conv";

    // Live afterTurn ingest of the first turn (decorated, transcript_entry_id NULL).
    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: DECORATED_FIRST_TURN }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    expect(conversation).not.toBeNull();

    // The session jsonl now holds the BARE, id-bearing face of that SAME turn,
    // plus the assistant reply (what OpenClaw flushes once the turn completes).
    // Built through the SessionManager so each entry carries a real JSONL
    // envelope id, exactly as production transcripts do (a bare {role, content}
    // file would be id-less and take a different reconcile path).
    const sessionFile = createSessionFilePath("new-conv");
    const sessionManager = SessionManager.open(sessionFile);
    appendSessionMessage(sessionManager, makeMessage({ role: "user", content: BODY }));
    appendSessionMessage(
      sessionManager,
      makeMessage({ role: "assistant", content: "we decided on 9pm" }),
    );

    // The all-zero placeholder checkpoint the missing-jsonl afterTurn left behind.
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation!.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
      lastProcessedEntryHash: null,
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Prove we actually exercised the placeholder-checkpoint-recovery path.
    const warns = warnLog.mock.calls.map((call) => String(call[0]));
    expect(
      warns.some((message) => message.includes("reason=placeholder-checkpoint-recovery")),
    ).toBe(true);

    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);

    // The first turn must survive EXACTLY ONCE. Before the fix the bare transcript
    // row imports alongside the decorated runtime row (the double-write bug).
    const firstTurnFaces = messages.filter(
      (message) => message.role === "user" && message.content.includes(BODY),
    );
    expect(firstTurnFaces).toHaveLength(1);
    // The survivor is the decorated runtime row (recovery adopted onto it rather
    // than dropping it for the bare copy).
    expect(firstTurnFaces[0].content).toContain("inbound_event_kind");
    // The genuinely-new assistant reply is still imported (no over-suppression).
    expect(
      messages.some(
        (message) => message.role === "assistant" && message.content.includes("we decided on 9pm"),
      ),
    ).toBe(true);

    // Continuity: adoption reported overlap, so the checkpoint advanced off the
    // all-zero placeholder instead of re-importing a fresh epoch every turn (the
    // mechanism behind the "newborn" continuity strip).
    const advancedState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(advancedState?.lastProcessedOffset ?? 0).toBeGreaterThan(0);
  });

  it("does not mis-adopt across turns or re-import a duplicate when recovery covers multiple turns", async () => {
    const engine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = "multi-turn-recovery";
    const sessionKey = "agent:agent-one:telegram:multi-turn";

    // Turn 1's body ("ok") is the trailing line of turn 2's body ("sounds good\nok").
    // Both are persisted decorated + unstamped by the live ingest. A newest-first
    // candidate scan adopts turn 2's row for turn 1's bare face, then re-imports
    // turn 2 as a duplicate; oldest-first chronological pairing keeps each once.
    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: decoratedRoomEvent("ok") }),
    });
    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: decoratedRoomEvent("sounds good\nok") }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    expect(conversation).not.toBeNull();

    // Transcript alternates user/assistant (real transcripts never have two
    // consecutive same-role entries) and carries both turns' bare faces.
    const sessionFile = createSessionFilePath("multi-turn");
    const sessionManager = SessionManager.open(sessionFile);
    appendSessionMessage(sessionManager, makeMessage({ role: "user", content: "ok" }));
    appendSessionMessage(sessionManager, makeMessage({ role: "assistant", content: "first reply" }));
    appendSessionMessage(sessionManager, makeMessage({ role: "user", content: "sounds good\nok" }));
    appendSessionMessage(
      sessionManager,
      makeMessage({ role: "assistant", content: "second reply" }),
    );

    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation!.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 0,
      lastSeenMtimeMs: 0,
      lastProcessedOffset: 0,
      lastProcessedEntryHash: null,
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const userRows = (
      await engine.getConversationStore().getMessages(conversation!.conversationId)
    ).filter((message) => message.role === "user");
    // Exactly the two decorated rows survive — neither turn re-imported as a duplicate.
    expect(userRows).toHaveLength(2);
    expect(userRows.filter((message) => message.content.includes("sounds good"))).toHaveLength(1);
  });

  it("dedups the bare transcript row on checkpoint-missing recovery too", async () => {
    // The sibling never-ingested recovery reason: no bootstrap_state row at all
    // (vs an all-zero placeholder). The same decorated-then-bare double-write
    // applies, so the gate must cover this reason as well.
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      { log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() } },
    );
    const sessionId = "checkpoint-missing-double-write";
    const sessionKey = "agent:agent-one:slack:channel:c0example";

    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: DECORATED_FIRST_TURN }),
    });
    const conversation = await engine
      .getConversationStore()
      .getConversationForSession({ sessionId, sessionKey });
    expect(conversation).not.toBeNull();
    // checkpoint-missing recovery requires the conversation be marked bootstrapped
    // with NO bootstrap_state row (the #837 shape).
    await engine
      .getConversationStore()
      .markConversationBootstrapped(conversation!.conversationId);

    const sessionFile = createSessionFilePath("checkpoint-missing");
    const sessionManager = SessionManager.open(sessionFile);
    appendSessionMessage(sessionManager, makeMessage({ role: "user", content: BODY }));
    appendSessionMessage(
      sessionManager,
      makeMessage({ role: "assistant", content: "we decided on 9pm" }),
    );

    // No bootstrap_state seeded — recovery resolves to checkpoint-missing.
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const warns = warnLog.mock.calls.map((call) => String(call[0]));
    expect(
      warns.some((message) => message.includes("reason=checkpoint-missing-recovery")),
    ).toBe(true);

    const firstTurnFaces = (
      await engine.getConversationStore().getMessages(conversation!.conversationId)
    ).filter((message) => message.role === "user" && message.content.includes(BODY));
    expect(firstTurnFaces).toHaveLength(1);
  });
});
