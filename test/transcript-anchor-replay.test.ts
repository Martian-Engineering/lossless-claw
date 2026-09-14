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
      expect(await store.getMessageTranscriptAnchorTrust(rows[0]!.messageId)).toMatchObject({
        trustState: "suspect",
      });
      expect(await store.getMessageTranscriptAnchorTrust(rows[1]!.messageId)).toMatchObject({
        trustState: "verified",
      });
    },
  );

  it("deduplicates externalized checkpoint replays only when their payload matches", async () => {
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
      await expect(
        dedup.deduplicateAfterTurnBatchAgainstPreservedCheckpoint(sessionId, undefined, [original]),
      ).resolves.toEqual([]);
      await expect(
        dedup.deduplicateAfterTurnBatchAgainstPreservedCheckpoint(sessionId, undefined, [changed]),
      ).resolves.toEqual([changed]);
      expect(await store.getMessageCount(conversation!.conversationId)).toBe(1);
    });
  });
});
