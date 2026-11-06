import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
});

function createFixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  const features = getLcmDbFeatures(db);
  runLcmMigrations(db, features);
  const conversations = new ConversationStore(db, features);
  const summaries = new SummaryStore(db, features);
  return { db, conversations, summaries, assembler: new ContextAssembler(conversations, summaries) };
}

describe("assembler message hydration", () => {
  it("preserves context order and current rows across a batch boundary without per-message reads", async () => {
    const { db, conversations, summaries, assembler } = createFixture();
    const conversation = await conversations.createConversation({ sessionId: "batch-order" });
    const conversationId = conversation.conversationId;
    const messages = await conversations.createMessagesBulk(Array.from({ length: 257 }, (_, seq) => ({
      conversationId,
      seq,
      role: seq % 2 ? "assistant" as const : "user" as const,
      content: `message-${seq}`,
      tokenCount: 4,
    })));
    await summaries.insertSummary({
      summaryId: "batch-prefix", conversationId, kind: "leaf", content: "Earlier context", tokenCount: 4,
    });
    await summaries.appendContextSummary(conversationId, "batch-prefix");
    const ordered = [...messages].reverse();
    await summaries.appendContextMessages(conversationId, ordered.map((message) => message.messageId));
    const prepare = vi.spyOn(db, "prepare");
    const assemble = () => assembler.assemble({ conversationId, tokenBudget: 100_000 });

    const result = await assemble();
    expect(result.messages[0]?.content).toContain('id="batch-prefix"');
    expect(result.messages.slice(1).map((message) => message.content)).toEqual(
      ordered.map((message) => message.role === "user"
        ? message.content : [{ type: "text", text: message.content }]),
    );
    // A 257-message assembly needs two bounded hydration batches, not 514
    // individual message/parts statements. Observe the actual SQLite owner.
    expect(prepare.mock.calls.filter(([sql]) => /\bFROM (messages|message_parts)\b/i.test(sql))).toHaveLength(4);

    db.prepare("UPDATE messages SET content = ? WHERE message_id = ?")
      .run("rewritten-after-first-assembly", ordered[0].messageId);
    const next = await assemble();
    expect(next.messages[1]?.content).toBe("rewritten-after-first-assembly");
    expect(result.messages[1]?.content).toBe("message-256");
  });

  it("does not share legacy part backfill between duplicate context occurrences", async () => {
    const { conversations, summaries, assembler } = createFixture();
    const { conversationId } = await conversations.createConversation({ sessionId: "batch-duplicates" });
    const user = await conversations.createMessage({
      conversationId, seq: 0, role: "user", content: "Earlier input", tokenCount: 3,
    });
    const legacy = await conversations.createMessage({
      conversationId, seq: 1, role: "tool", content: "", tokenCount: 4,
    });
    await conversations.createMessageParts(legacy.messageId, [{
      sessionId: "batch-duplicates", partType: "tool", ordinal: 0,
      metadata: JSON.stringify({
        originalRole: "toolResult", rawType: "function_call_output",
        raw: { type: "function_call_output", call_id: "legacy-call", output: "LEGACY_RESULT" },
      }),
    }]);
    await summaries.appendContextMessages(conversationId, [user.messageId, legacy.messageId, legacy.messageId]);

    const result = await assembler.assemble({ conversationId, tokenBudget: 100_000 });
    // Both legacy rows start without a normalized call ID. Reconstructing the
    // first must not promote the second to a different runtime role.
    expect(result.messages.map((message) => message.role)).toEqual(["user", "assistant", "assistant"]);
    for (const message of result.messages.slice(1)) {
      expect(JSON.stringify(message.content)).toContain("LEGACY_RESULT");
    }
    expect((await conversations.getMessageParts(legacy.messageId))[0].toolCallId).toBeNull();
  });
});
