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
import { describe, expect, it } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resolveLcmConfig } from "../src/db/config.js";
import {
  HEARTBEAT_OK_TOKEN,
  HEARTBEAT_TURN_MARKER,
  OPENCLAW_HEARTBEAT_POLL,
  pruneHeartbeatOkTurns,
} from "../src/heartbeat-filter.js";
import type { ConversationStore } from "../src/store/conversation-store.js";
import { createEngine, createEngineWithConfig, makeMessage } from "./helpers.js";

type StoredLike = { messageId: number; role: string; content: string };

function heartbeatTurnMessages(): StoredLike[] {
  return [
    { messageId: 1, role: "user", content: `${OPENCLAW_HEARTBEAT_POLL} — read ${HEARTBEAT_TURN_MARKER}` },
    { messageId: 2, role: "assistant", content: HEARTBEAT_OK_TOKEN },
  ];
}

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
});
