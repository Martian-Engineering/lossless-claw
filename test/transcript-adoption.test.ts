import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDepsOverridesAndDb } from "./helpers.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

afterEach(cleanupEngineTestState);

const baseTime = Date.parse("2026-06-21T10:19:00.000Z");
const at = (seconds: number) => new Date(baseTime + seconds * 1000).toISOString();
const decoratedContent = [
  "Conversation info (untrusted metadata):",
  "```json",
  '{"chat_id":"telegram:10000000x","inbound_event_kind":"room_event","sender":"sam.rivera"}',
  "```",
  "",
  "[Sun 2026-06-21 13:19 GMT+3] ok",
].join("\n");

describe.each(["decorated", "exact"] as const)("%s transcript adoption", (path) => {
  const role = path === "decorated" ? "user" : "assistant";
  const content = path === "decorated" ? decoratedContent : "ok";

  async function reconcile(projectedTimes: Array<string | undefined>, liveTimes: number[], resolvedFirst = false) {
    const sessionId = `adoption-${path}`;
    const sessionKey = `agent:main:${sessionId}`;
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries: vi.fn(async () => projectedTimes.map((createdAt, i) => ({
        entryId: `entry-${i}`,
        parentId: i ? `entry-${i - 1}` : null,
        seq: i + 1,
        role,
        message: { role, content: "ok" } as AgentMessage,
        createdAt,
      }))),
    });
    await engine.ingestBatch({
      sessionId, sessionKey,
      messages: liveTimes.map((seconds, index) => ({
        role, content: resolvedFirst && index === 0 ? "ok" : content, timestamp: baseTime + seconds * 1000,
      }) as AgentMessage),
    });
    const readRows = () => db.prepare(
      "SELECT message_id, content, created_at, transcript_entry_id FROM messages ORDER BY message_id",
    ).all() as Array<{ message_id: number; content: string; created_at: string; transcript_entry_id: string | null }>;
    const before = readRows();
    expect(before).toHaveLength(liveTimes.length);
    if (resolvedFirst) {
      const store = engine.getConversationStore();
      const conversation = await store.getConversationForSession({ sessionId, sessionKey });
      await store.adoptTranscriptEntryIdForMessage(conversation!.conversationId, before[0]!.message_id, "entry-0");
      await store.upsertMessageTranscriptAnchorTrust({
        conversationId: conversation!.conversationId,
        messageId: before[0]!.message_id,
        transcriptEntryId: "entry-0",
        trustState: "verified",
        source: "projection-reconcile",
        reason: "previously resolved entry",
        verifiedAt: new Date(),
      });
    }
    const bootstrap = () => engine.bootstrap({
      sessionId, sessionKey,
      runtimeContext: {
        transcriptStorage: { kind: "sqlite" },
        sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: "/tmp/adoption.sqlite" },
      },
    });
    await bootstrap();
    const after = readRows();
    // Locate live rows by stable identity, never by their position after import.
    const liveRows = before.map((row) => after.find((candidate) => candidate.message_id === row.message_id)!);
    expect(liveRows.map(({ content, created_at }) => ({ content, created_at }))).toEqual(
      before.map(({ content, created_at }) => ({ content, created_at })),
    );
    await bootstrap();
    expect(readRows()).toEqual(after);
    return { liveRows, after };
  }

  it("does not let either nearby projection claim the only later live row", async () => {
    const { liveRows } = await reconcile([at(0), at(1)], [1]);
    expect(liveRows[0]!.transcript_entry_id).toBeNull();
  });

  it("does not turn a remaining repeated row into a timestamp-free singleton", async () => {
    const { liveRows } = await reconcile([at(0), at(30), at(60)], [0, 60]);
    expect(liveRows.map((row) => row.transcript_entry_id)).toEqual(["entry-0", "entry-2"]);
  });

  it.each([[0, 60], [60, 0]])("adopts separated repeats with live order %j", async (...liveTimes) => {
    const { liveRows, after } = await reconcile([at(0), at(60)], liveTimes);
    expect(liveRows.map((row) => row.transcript_entry_id)).toEqual(
      liveTimes.map((time) => time === 0 ? "entry-0" : "entry-1"),
    );
    expect(after).toHaveLength(2);
  });

  it("leaves same-second twins unstamped", async () => {
    const { liveRows } = await reconcile([at(0), at(0)], [0.1, 0.7]);
    expect(liveRows.map((row) => row.transcript_entry_id)).toEqual([null, null]);
  });

  it.each([undefined, "not-a-timestamp"])("keeps an unknown competing time (%s) ambiguous", async (unknownTime) => {
    const { liveRows } = await reconcile([unknownTime, at(60)], [60]);
    expect(liveRows[0]!.transcript_entry_id).toBeNull();
  });

  it("does not let a resolved entry with unknown time block the new repeat", async () => {
    const { liveRows, after } = await reconcile([undefined, at(60)], [0, 60], true);
    expect(liveRows.map((row) => row.transcript_entry_id)).toEqual(["entry-0", "entry-1"]);
    expect(after).toHaveLength(2);
  });

  it("preserves timestamp-free adoption for genuinely unique content", async () => {
    const { liveRows, after } = await reconcile([undefined], [0]);
    expect(liveRows[0]!.transcript_entry_id).toBe("entry-0");
    expect(after).toHaveLength(1);
  });
});
