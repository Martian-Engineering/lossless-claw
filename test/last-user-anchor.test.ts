import { afterEach, describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import { appendUncoveredVolatileLiveInputsWithinBudget } from "../src/live-coverage.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  cleanupEngineTestState,
  createEngineWithConfig,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("last-user fresh-tail anchor", () => {
  it("keeps the current user after stale volatile input and before its tool suffix", async () => {
    const engine = createEngineWithConfig({
      freshTailCount: 64,
      freshTailMaxTokens: 1_000,
    });
    (engine as unknown as { ensureMigrated(): void }).ensureMigrated();
    const sessionId = "session-last-user-anchor-after-volatile-input";
    const conversationStore = engine.getConversationStore();
    const summaryStore = engine.getSummaryStore();
    const conversation = await conversationStore.getOrCreateConversation(sessionId, {});

    // Seed a post-compaction projection whose earlier plain user survives only
    // through its summary wrapper.
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "Earlier plain user turn" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "Earlier assistant reply" } as AgentMessage,
    });
    const historicalMessages = await conversationStore.getMessages(conversation.conversationId);
    const historicalMessageIds = historicalMessages.map((message) => message.messageId);
    await summaryStore.insertSummary({
      summaryId: "sum_before_last_user_anchor",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Earlier user and assistant context.",
      tokenCount: 8,
    });
    await summaryStore.linkSummaryToMessages("sum_before_last_user_anchor", historicalMessageIds);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "sum_before_last_user_anchor",
    });

    // Follow the current user with a tool result large enough to consume the
    // configured fresh-tail cap before a role-blind scan reaches that user.
    const currentUserContent = "Inspect the deployment and report the result.";
    const toolCallId = "call_last_user_anchor";
    const toolResultText = `Deployment is healthy. ${"result ".repeat(1_000)}`;
    await engine.ingest({
      sessionId,
      message: { role: "user", content: currentUserContent } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting the deployment." },
          { type: "toolCall", id: toolCallId, name: "read", input: { path: "deploy.log" } },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: toolResultText }],
      } as AgentMessage,
    });

    // Compose the capped projection with the same volatile-input reconciliation
    // used by engine assembly. The stale event must remain losslessly present,
    // but it must not replace the current user as the final user boundary.
    const staleVolatileInput =
      "[Inter-session message] sourceSession=agent:main:subagent:stale sourceTool=subagent_announce\n" +
      "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>\n" +
      "[Internal task completion event]\n" +
      "Child result: stale prior completion.\n" +
      "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";
    const liveMessages = [
      { role: "user", content: staleVolatileInput },
      { role: "user", content: currentUserContent },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Inspecting the deployment." },
          { type: "toolCall", id: toolCallId, name: "read", input: { path: "deploy.log" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId,
        toolName: "read",
        content: [{ type: "text", text: toolResultText }],
      },
    ] as AgentMessage[];
    const projected = await new ContextAssembler(conversationStore, summaryStore).assemble({
      conversationId: conversation.conversationId,
      tokenBudget: 100,
      freshTailCount: 64,
      freshTailMaxTokens: 1_000,
    });
    const result = appendUncoveredVolatileLiveInputsWithinBudget({
      assembledMessages: projected.messages,
      assembledEstimatedTokens: projected.estimatedTokens,
      liveMessages,
      tokenBudget: 10_000,
    });

    const staleIndex = result.messages.findIndex(
      (message) =>
        typeof message.content === "string" && message.content.includes("stale prior completion"),
    );
    const currentUserIndex = result.messages.findIndex(
      (message) => message.role === "user" && message.content === currentUserContent,
    );
    const toolCallIndex = result.messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some(
          (part) =>
            typeof part === "object" && part !== null && "id" in part && part.id === toolCallId,
        ),
    );
    const toolResultIndex = result.messages.findIndex(
      (message) => message.role === "toolResult" && message.toolCallId === toolCallId,
    );
    const lastUser = result.messages.findLast((message) => message.role === "user");

    expect(staleIndex).toBeGreaterThanOrEqual(0);
    expect(currentUserIndex).toBeGreaterThan(staleIndex);
    expect(toolCallIndex).toBeGreaterThan(currentUserIndex);
    expect(toolResultIndex).toBe(toolCallIndex + 1);
    expect(lastUser?.content).toBe(currentUserContent);
  });
});
