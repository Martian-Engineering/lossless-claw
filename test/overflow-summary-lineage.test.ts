import { afterEach, expect, it } from "vitest";
import { cleanupEngineTestState, createEngineWithDeps } from "./helpers.js";
import { ContextAssembler } from "../src/assembler.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

afterEach(cleanupEngineTestState);

it.each(["valid", "user source", "earlier source", "empty branch", "cycle"])(
  "requires complete current-turn provenance through nested summaries: %s",
  async (variant) => {
    const engine = createEngineWithDeps({});
    const sessionId = "lineage-proof";
    const messages: AgentMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier history." }],
      } as AgentMessage,
      { role: "user", content: "Inspect this file." },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "read-1", name: "read", arguments: {} },
        ],
      } as AgentMessage,
      {
        role: "toolResult",
        toolCallId: "read-1",
        toolName: "read",
        content: [{ type: "text", text: "Evidence." }],
      } as AgentMessage,
    ];
    for (const message of messages) await engine.ingest({ sessionId, message });
    const store = engine.getConversationStore();
    const summaries = engine.getSummaryStore();
    const conversation = (await store.getConversationForSession({
      sessionId,
    }))!;
    const conversationId = conversation.conversationId;
    const rows = await store.getMessages(conversationId);
    await summaries.insertSummary({
      summaryId: "leaf",
      conversationId,
      kind: "leaf",
      depth: 0,
      content: "Tool evidence.",
      tokenCount: 4,
    });
    await summaries.linkSummaryToMessages(
      "leaf",
      rows.slice(2).map((row) => row.messageId)
    );
    // A bad source on any leaf must invalidate the whole condensed proof.
    if (variant === "user source" || variant === "earlier source") {
      await summaries.linkSummaryToMessages("leaf", [
        rows[variant === "user source" ? 1 : 0]!.messageId,
      ]);
    }
    await summaries.insertSummary({
      summaryId: "middle",
      conversationId,
      kind: "condensed",
      depth: 1,
      content: "Condensed evidence.",
      tokenCount: 4,
    });
    await summaries.linkSummaryToParents("middle", ["leaf"]);
    await summaries.insertSummary({
      summaryId: "outer",
      conversationId,
      kind: "condensed",
      depth: 2,
      content: "Nested recovery evidence.",
      tokenCount: 4,
    });
    await summaries.linkSummaryToParents("outer", ["middle"]);
    if (variant === "empty branch") {
      await summaries.insertSummary({
        summaryId: "empty",
        conversationId,
        kind: "leaf",
        depth: 0,
        content: "Unproven history.",
        tokenCount: 4,
      });
      await summaries.linkSummaryToParents("middle", ["empty"]);
    }
    if (variant === "cycle")
      await summaries.linkSummaryToParents("middle", ["outer"]);
    await summaries.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: 2,
      endOrdinal: 3,
      summaryId: "outer",
    });
    const assembled = await new ContextAssembler(store, summaries).assemble({
      conversationId,
      tokenBudget: 8000,
      freshTailCount: 4,
    });
    const nested = assembled.messages.find((message) =>
      JSON.stringify(message.content).includes("Nested recovery evidence.")
    );
    expect(nested?.role).toBe(variant === "valid" ? "assistant" : "user");
    expect(JSON.stringify(nested?.content)).toContain('trust=\\"untrusted\\"');
  }
);
