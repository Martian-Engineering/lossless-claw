/**
 * Tests for the preserveHeartbeatPoll toggle (issue #1024).
 *
 * Background: OpenClaw heartbeat polls are synthetic system events. Lossless Claw
 * short-circuits them out of ingest (`ingestSingle`) and out of the after-turn
 * visible-transcript reconcile, so a session that only receives heartbeats can look
 * as if nothing ever happened — the events are perceived by the runtime but never
 * land in LCM storage.
 *
 * `preserveHeartbeatPoll` keeps the poll events in LCM storage/context while still
 * allowing pure HEARTBEAT_OK acknowledgements to be pruned. It defaults to false, so
 * behaviour for existing users is unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resolveLcmConfig } from "../src/db/config.js";
import {
  HEARTBEAT_OK_TOKEN,
  HEARTBEAT_TURN_MARKER,
  OPENCLAW_HEARTBEAT_POLL,
  pruneHeartbeatOkTurns,
} from "../src/heartbeat-filter.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import {
  cleanupEngineTestState,
  createEngine,
  createEngineWithConfig,
  createEngineWithDepsOverridesAndDb,
  makeMessage,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

type StoredLike = { messageId: number; role: string; content: string };

// Build a complete poll/ack cycle recognized by the heartbeat detector.
function heartbeatTurnMessages(): StoredLike[] {
  return [
    { messageId: 1, role: "user", content: `${OPENCLAW_HEARTBEAT_POLL} — read ${HEARTBEAT_TURN_MARKER}` },
    { messageId: 2, role: "assistant", content: HEARTBEAT_OK_TOKEN },
  ];
}

// Record deletion requests without mutating message data in detector unit tests.
function fakeStore(messages: StoredLike[]) {
  const deleted: number[] = [];
  const store = {
    getMessages: async () => messages,
    deleteMessages: async (ids: number[]) => {
      deleted.push(...ids);
      return ids.length;
    },
  } as unknown as ConversationStore;
  return { store, deleted };
}

describe("preserveHeartbeatPoll config resolution", () => {
  it("defaults to false so existing behaviour is unchanged", () => {
    expect(resolveLcmConfig({}, {}).preserveHeartbeatPoll).toBe(false);
  });

  it("honours the plugin config flag", () => {
    expect(resolveLcmConfig({}, { preserveHeartbeatPoll: true }).preserveHeartbeatPoll).toBe(
      true,
    );
    expect(resolveLcmConfig({}, { preserveHeartbeatPoll: false }).preserveHeartbeatPoll).toBe(
      false,
    );
  });

  it("honours the LCM_PRESERVE_HEARTBEAT_POLL environment variable", () => {
    expect(
      resolveLcmConfig({ LCM_PRESERVE_HEARTBEAT_POLL: "true" }, {}).preserveHeartbeatPoll,
    ).toBe(true);
    expect(
      resolveLcmConfig({ LCM_PRESERVE_HEARTBEAT_POLL: "1" }, {}).preserveHeartbeatPoll,
    ).toBe(true);
    expect(
      resolveLcmConfig({ LCM_PRESERVE_HEARTBEAT_POLL: "0" }, {}).preserveHeartbeatPoll,
    ).toBe(false);
  });

  it("declares the flag in the plugin manifest schema", () => {
    const schema = manifest.configSchema as { properties?: Record<string, unknown> };
    expect(schema.properties?.preserveHeartbeatPoll).toEqual({ type: "boolean" });
    expect(manifest.uiHints.preserveHeartbeatPoll).toBeDefined();
  });

  it("lets an explicit environment value override the plugin config", () => {
    expect(resolveLcmConfig({ LCM_PRESERVE_HEARTBEAT_POLL: "0" }, {
      preserveHeartbeatPoll: true,
    }).preserveHeartbeatPoll).toBe(false);
    expect(resolveLcmConfig({ LCM_PRESERVE_HEARTBEAT_POLL: "1" }, {
      preserveHeartbeatPoll: false,
    }).preserveHeartbeatPoll).toBe(true);
  });
});

describe("heartbeat poll ingest gate", () => {
  it("drops heartbeat messages by default", async () => {
    const engine = createEngine();
    const result = await engine.ingestBatch({
      sessionId: "preserve-heartbeat-off-session",
      messages: [
        makeMessage({ role: "user", content: `${OPENCLAW_HEARTBEAT_POLL} ${HEARTBEAT_TURN_MARKER}` }),
      ],
      isHeartbeat: true,
    });
    expect(result.ingestedCount).toBe(0);
  });

  it("ingests heartbeat messages when preserveHeartbeatPoll is on", async () => {
    const engine = createEngineWithConfig({ preserveHeartbeatPoll: true });
    const sessionId = "preserve-heartbeat-on-session";
    const result = await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage({ role: "user", content: `${OPENCLAW_HEARTBEAT_POLL} ${HEARTBEAT_TURN_MARKER}` }),
      ],
      isHeartbeat: true,
    });
    expect(result.ingestedCount).toBe(1);

    const conversation = await engine
      .getConversationStore()
      .getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(
      await engine.getConversationStore().getMessageCount(conversation!.conversationId),
    ).toBe(1);
  });
});

describe("pruneHeartbeatOkTurns with keepPoll", () => {
  it("deletes the whole turn by default (poll + ack)", async () => {
    const { store, deleted } = fakeStore(heartbeatTurnMessages());
    const pruned = await pruneHeartbeatOkTurns(store, 1);
    expect(pruned).toBe(2);
    expect(deleted.sort()).toEqual([1, 2]);
  });

  it("keeps the poll prompt and deletes only the ack when keepPoll is set", async () => {
    const { store, deleted } = fakeStore(heartbeatTurnMessages());
    const pruned = await pruneHeartbeatOkTurns(store, 1, { keepPoll: true });
    expect(pruned).toBe(1);
    expect(deleted).toEqual([2]);
  });

  it("still ignores turns whose assistant reply carried real content", async () => {
    const messages: StoredLike[] = [
      { messageId: 1, role: "user", content: `${OPENCLAW_HEARTBEAT_POLL} ${HEARTBEAT_TURN_MARKER}` },
      { messageId: 2, role: "assistant", content: `${HEARTBEAT_OK_TOKEN} — but also: the plant needs water` },
    ];
    const { store, deleted } = fakeStore(messages);
    const pruned = await pruneHeartbeatOkTurns(store, 1, { keepPoll: true });
    expect(pruned).toBe(0);
    expect(deleted).toEqual([]);
  });

  it("preserves intermediate tool and assistant messages with keepPoll", async () => {
    const [poll, ack] = heartbeatTurnMessages();
    const { store, deleted } = fakeStore([
      poll!,
      { messageId: 3, role: "assistant", content: "Checking a scheduled task" },
      { messageId: 4, role: "tool", content: "Scheduled task completed successfully" },
      ack!,
    ]);
    expect(await pruneHeartbeatOkTurns(store, 1, { keepPoll: true })).toBe(1);
    expect(deleted).toEqual([2]);
  });
});

describe("heartbeat preservation through afterTurn", () => {
  for (const projected of [false, true]) {
    it.each([false, true])(`honours pruneHeartbeatOk=%s with projected=${projected}`, async (pruneHeartbeatOk) => {
      const sessionId = `heartbeat-after-turn-${projected}-${pruneHeartbeatOk}`;
      const sessionKey = `agent:main:${sessionId}`;
      const messages = heartbeatTurnMessages().map(({ role, content }) =>
        makeMessage({ role: role as "user" | "assistant", content }),
      );
      // Keep a visible prefix so runtime-only and fully flushed turns both have coverage proof.
      const prefix = makeMessage({ role: "user", content: "Earlier ordinary conversation" });
      const visible = projected ? [prefix, ...messages] : [prefix];
      const { engine } = createEngineWithDepsOverridesAndDb({
        readVisibleSessionTranscriptMessageEntries: async () => visible.map((message, index) => ({
          entryId: `heartbeat-${index}`,
          parentId: index === 0 ? null : `heartbeat-${index - 1}`,
          seq: index + 1,
          role: message.role,
          message,
          createdAt: `2026-09-14T12:00:0${index}.000Z`,
        })),
      }, { preserveHeartbeatPoll: true, pruneHeartbeatOk });
      await engine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "",
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: "/tmp/heartbeat-host.sqlite" },
        messages,
        prePromptMessageCount: 0,
        isHeartbeat: true,
        tokenBudget: 100_000,
      });

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
      const expectedTurn = pruneHeartbeatOk
        ? [messages[0]!.content]
        : messages.map((message) => message.content);
      const expected = [prefix.content, ...expectedTurn];
      expect(stored.map((message) => message.content)).toEqual(expected);
      const assembled = await engine.assemble({ sessionId, messages: [], tokenBudget: 10_000 });
      expect(JSON.stringify(assembled.messages)).toContain(OPENCLAW_HEARTBEAT_POLL);
    });
  }
});

describe("heartbeat preservation through bootstrap", () => {
  it("prunes acknowledgements re-imported into an existing conversation", async () => {
    const sessionId = "heartbeat-bootstrap-reconcile";
    const sessionKey = `agent:main:${sessionId}`;
    const messages = [makeMessage({ role: "user", content: "Earlier ordinary conversation" })];
    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries: async () => messages.map((message, index) => ({
        entryId: `bootstrap-${index}`,
        parentId: index === 0 ? null : `bootstrap-${index - 1}`,
        seq: index + 1,
        role: message.role,
        message,
        createdAt: `2026-09-14T12:00:0${index}.000Z`,
      })),
    }, { preserveHeartbeatPoll: true, pruneHeartbeatOk: true });
    const params = {
      sessionId,
      sessionKey,
      runtimeContext: {
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: "/tmp/heartbeat-host.sqlite" },
      },
    };
    await engine.bootstrap(params);

    // The host's visible transcript retains acknowledgements across LCM restarts/replays.
    messages.push(
      makeMessage({ role: "user", content: "[OpenClaw heartbeat poll] read HEARTBEAT.md" }),
      makeMessage({ role: "assistant", content: "HEARTBEAT_OK" }),
    );
    await engine.bootstrap(params);
    await engine.bootstrap(params);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(messages.slice(0, 2).map((message) => message.content));
  });
});
