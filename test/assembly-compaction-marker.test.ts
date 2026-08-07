import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupEngineTestState,
  createEngine,
  makeMessage,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("LcmContextEngine compaction marker", () => {
  it("preserves the compaction marker through production assembly", async () => {
    const engine = createEngine();
    const sessionId = "session-compaction-marker";
    const sessionKey = "agent:main:test:compaction-marker";
    const summaryContent = "This is a compaction summary.";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey,
    });

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_compaction_marker",
      conversationId: conversation.conversationId,
      kind: "leaf",
      content: summaryContent,
      tokenCount: 10,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(conversation.conversationId, "sum_compaction_marker");

    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [],
      tokenBudget: 100_000,
    });
    const summaryMessage = result.messages.find(
      (message) =>
        typeof message.content === "string" && message.content.includes(summaryContent),
    );

    expect(summaryMessage?.__openclaw).toEqual({ kind: "compaction" });
    expect(JSON.parse(JSON.stringify(summaryMessage)).__openclaw).toEqual({
      kind: "compaction",
    });
  });

  it("does not mark ordinary messages as compaction summaries", async () => {
    const engine = createEngine();
    const sessionId = "session-without-compaction-marker";
    const sessionKey = "agent:main:test:without-compaction-marker";
    const message = makeMessage({ role: "user", content: "Ordinary user message." });

    await engine.ingest({ sessionId, sessionKey, message });

    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [message],
      tokenBudget: 100_000,
    });
    const ordinaryMessage = result.messages.find(
      (candidate) => candidate.content === "Ordinary user message.",
    );

    expect(ordinaryMessage).toBeDefined();
    expect(ordinaryMessage?.__openclaw).toBeUndefined();
  });
});
