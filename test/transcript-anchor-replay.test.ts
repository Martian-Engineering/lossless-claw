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
const toolIdAliases = ["toolCallId", "tool_call_id", "toolUseId", "tool_use_id", "call_id", "id"] as const;
const toolIdCases = [
  { label: "without an envelope id", envelopeId: undefined },
  { label: "overriding an envelope id", envelopeId: "envelope-call" },
].flatMap((row) => toolIdAliases.map((alias) => ({ ...row, alias })));

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

  it.each([
    { label: "tool name", changed: { toolName: "read" } },
    { label: "error flag", changed: { isError: true } },
  ])("preserves corrected $label despite an externalized body proof", async ({ changed }) => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "externalized-tool-provenance";
      const original = attachTranscriptEntryMeta({
        role: "toolResult", toolCallId: "exec:101", toolName: "exec", isError: false,
        content: "same large tool output\n".repeat(200),
      }, { entryId: "corrected-tool-entry", parentId: null, timestamp: null });
      await engine.ingest({ sessionId, message: original });
      const store = engine.getConversationStore();
      const conversation = await store.getConversationBySessionId(sessionId);
      const [before] = await store.getMessages(conversation!.conversationId);
      const originalParts = await store.getMessageParts(before!.messageId);
      expect(before!.content).toContain("[LCM Tool Output:");
      await expect(engine.ingest({ sessionId, message: original })).resolves.toEqual({ ingested: false });

      const corrected = { ...original, ...changed };
      await expect(engine.ingest({ sessionId, message: corrected })).resolves.toEqual({ ingested: true });
      const after = await store.getMessages(conversation!.conversationId);
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual({ ...before, transcriptEntryId: null });
      expect(await store.getMessageParts(before!.messageId)).toEqual(originalParts);
      expect(after[1]!.transcriptEntryId).toBe("corrected-tool-entry");
      const newParts = await store.getMessageParts(after[1]!.messageId);
      expect(JSON.parse(newParts[0]!.metadata!)).toMatchObject({
        toolCallId: "exec:101", toolName: corrected.toolName, isError: corrected.isError,
      });
      expect(readTrustState(engine, before!.messageId)).toEqual({ trust_state: "suspect" });
      expect(readTrustState(engine, after[1]!.messageId)).toEqual({ trust_state: "verified" });
      await expect(engine.ingest({ sessionId, message: corrected })).resolves.toEqual({ ingested: false });
      expect(await store.getMessages(conversation!.conversationId)).toEqual(after);
    });
  });

  it("keeps externalized string tool replay idempotent without a declared tool name", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "externalized-unnamed-tool";
      const message = attachTranscriptEntryMeta({
        role: "toolResult", toolCallId: "exec:101", content: "large output\n".repeat(200),
      }, { entryId: "unnamed-tool-entry", parentId: null, timestamp: null });
      await expect(engine.ingest({ sessionId, message })).resolves.toEqual({ ingested: true });
      const store = engine.getConversationStore();
      const conversation = await store.getConversationBySessionId(sessionId);
      const before = await store.getMessages(conversation!.conversationId);
      expect(before[0]!.content).toContain("[LCM Tool Output:");
      await expect(engine.ingest({ sessionId, message })).resolves.toEqual({ ingested: false });
      expect(await store.getMessages(conversation!.conversationId)).toEqual(before);
    });
  });

  it.each(toolIdCases)("preserves corrected externalized text-block $alias ids $label", async ({ envelopeId, alias }) => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = "externalized-text-block-id";
      const message = (id: string, field: (typeof toolIdAliases)[number] = alias) =>
        attachTranscriptEntryMeta({
          role: "toolResult",
          toolCallId: envelopeId,
          content: [{ type: "text", text: "same large tool output\n".repeat(200), [field]: id }],
        }, { entryId: "corrected-text-block-entry", parentId: null, timestamp: null });
      const original = message("exec:101");
      await expect(engine.ingest({ sessionId, message: original })).resolves.toEqual({ ingested: true });
      const store = engine.getConversationStore();
      const conversation = await store.getConversationBySessionId(sessionId);
      const [before] = await store.getMessages(conversation!.conversationId);
      const originalParts = await store.getMessageParts(before!.messageId);
      expect(before!.content).toContain("[LCM Tool Output:");
      expect(originalParts[0]!.toolCallId).toBe("exec:101");
      await expect(engine.ingest({ sessionId, message: original })).resolves.toEqual({ ingested: false });
      await expect(engine.ingest({ sessionId, message: message("exec:101", "toolCallId") })).resolves.toEqual(
        { ingested: false },
      );

      const corrected = message("exec:102");
      await expect(engine.ingest({ sessionId, message: corrected })).resolves.toEqual({ ingested: true });
      const after = await store.getMessages(conversation!.conversationId);
      expect(after).toHaveLength(2);
      expect(after[0]).toEqual({ ...before, transcriptEntryId: null });
      expect(await store.getMessageParts(before!.messageId)).toEqual(originalParts);
      expect(after[1]!.transcriptEntryId).toBe("corrected-text-block-entry");
      const newParts = await store.getMessageParts(after[1]!.messageId);
      expect(newParts[0]!.toolCallId).toBe("exec:102");
      expect(readTrustState(engine, before!.messageId)).toEqual({ trust_state: "suspect" });
      expect(readTrustState(engine, after[1]!.messageId)).toEqual({ trust_state: "verified" });
      await expect(engine.ingest({ sessionId, message: corrected })).resolves.toEqual({ ingested: false });
      await expect(engine.ingest({ sessionId, message: message("exec:102", "toolCallId") })).resolves.toEqual(
        { ingested: false },
      );
      expect(await store.getMessages(conversation!.conversationId)).toEqual(after);
    });
  });
});
