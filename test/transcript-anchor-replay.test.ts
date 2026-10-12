import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import {
  cleanupEngineTestState,
  createEngine,
  createEngineWithConfig,
  withTempHome,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

/** Read one message's persisted anchor-trust state directly from SQLite. */
function readTrustState(engine: ReturnType<typeof createEngine>, messageId: number) {
  return (engine as unknown as { db: DatabaseSync })
    .db.prepare("SELECT trust_state FROM message_transcript_anchor_trust WHERE message_id = ?")
    .get(messageId);
}

// Both provider result ids and assistant response ids reach global replay dedup.
const stableEventMessages: AgentMessage[] = [
  {
    role: "toolResult",
    toolCallId: "call_123456789012",
    toolName: "exec",
    content: [],
  },
  { role: "assistant", responseId: "response-anchor-collision", content: [] },
] as AgentMessage[];

describe("transcript anchor replay", () => {
  it.each(stableEventMessages)(
    "preserves corrected $role payloads with colliding stable ids",
    async (base) => {
      const engine = createEngine();
      const sessionId = "anchor-stable-id-collision";
      const message = (text: string) =>
        attachTranscriptEntryMeta({ ...base, content: [{ type: "text", text }] } as AgentMessage, {
          entryId: "corrected-entry",
          parentId: null,
          timestamp: null,
        });

      // A matching replay stays idempotent before and after correcting the anchor.
      await expect(engine.ingest({ sessionId, message: message("stale result") })).resolves.toEqual(
        { ingested: true },
      );
      await expect(engine.ingest({ sessionId, message: message("stale result") })).resolves.toEqual(
        { ingested: false },
      );
      await expect(
        engine.ingest({ sessionId, message: message("corrected result") }),
      ).resolves.toEqual({ ingested: true });
      await expect(
        engine.ingest({ sessionId, message: message("corrected result") }),
      ).resolves.toEqual({ ingested: false });

      const store = engine.getConversationStore();
      const conversation = await store.getConversationBySessionId(sessionId);
      const rows = await store.getMessages(conversation!.conversationId);
      expect(rows.map((row) => [row.content, row.transcriptEntryId])).toEqual([
        ["stale result", null],
        ["corrected result", "corrected-entry"],
      ]);
      expect((await store.getMessageParts(rows[0]!.messageId))[0]?.textContent).toBe(
        "stale result",
      );
      expect((await store.getMessageParts(rows[1]!.messageId))[0]?.textContent).toBe(
        "corrected result",
      );
      expect(readTrustState(engine, rows[0]!.messageId)).toEqual({ trust_state: "suspect" });
      expect(readTrustState(engine, rows[1]!.messageId)).toEqual({ trust_state: "verified" });
    },
  );

  it("matches an externalized persisted anchor only when the replay payload matches", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "externalized-checkpoint-replay";
      const message = (content: string) =>
        attachTranscriptEntryMeta(
          { role: "user", content },
          { entryId: "externalized-entry", parentId: null, timestamp: null },
        );
      const original = message("original large payload\n".repeat(200));
      const changed = message("different large payload\n".repeat(200));
      await engine.ingest({ sessionId, message: original });

      // Confirm the replay compares original bytes against an externalized row.
      const store = engine.getConversationStore();
      const conversation = await store.getConversationBySessionId(sessionId);
      const rows = await store.getMessages(conversation!.conversationId);
      expect(rows[0]!.content).toContain("[LCM Raw Payload:");
      const dedup = engine.getBatchDeduplicator();
      await expect(dedup.matchesPersistedAnchor(rows[0]!.messageId, original)).resolves.toBe(true);
      await expect(dedup.matchesPersistedAnchor(rows[0]!.messageId, changed)).resolves.toBe(false);
      expect(await store.getMessageCount(conversation!.conversationId)).toBe(1);
    });
  });
});
