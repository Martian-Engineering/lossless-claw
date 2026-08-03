/**
 * End-to-end round-trip: ingest (buildMessageParts) → assemble → assert
 * model identity and sentinel thinkingSignature survive the DB round-trip.
 *
 * Style: mirrors test/lcm-integration-assemble.test.ts (mock stores + real
 * ContextAssembler) to verify the full persistence→reassembly path without
 * heavy LcmContextEngine scaffolding.
 */
import { describe, expect, it, beforeEach } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import { buildMessageParts } from "../src/message-content.js";
import {
  createMockConversationStore,
  createMockSummaryStore,
  wireStores,
  CONV_ID,
} from "./integration-helpers.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { MessagePartRecord } from "../src/store/conversation-store.js";

describe("LCM integration: model identity round-trip", () => {
  let convStore: ReturnType<typeof createMockConversationStore>;
  let sumStore: ReturnType<typeof createMockSummaryStore>;
  let assembler: ContextAssembler;

  beforeEach(() => {
    convStore = createMockConversationStore();
    sumStore = createMockSummaryStore();
    wireStores(convStore, sumStore);
    assembler = new ContextAssembler(convStore as any, sumStore as any);
  });

  it("preserves model identity and sentinel thinkingSignature through ingest→assemble", async () => {
    // 1. Simulate a live assistant message with model identity + sentinel sig.
    const liveMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "reasoning text", thinkingSignature: "reasoning_content" },
        { type: "text", text: "visible answer" },
      ],
      provider: "moonshot",
      api: "openai-completions",
      model: "kimi-k3",
      responseModel: "kimi-k3",
    } as unknown as AgentMessage;

    // 2. Ingest: buildMessageParts → store parts.
    await convStore.createConversation({ sessionId: "session-1" });
    const msg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "assistant",
      content: "visible answer",
      tokenCount: 10,
    });
    const parts = buildMessageParts({
      sessionId: "session-1",
      message: liveMessage,
      fallbackContent: "visible answer",
    });
    const partRecords: MessagePartRecord[] = parts.map((part, index) => ({
      partId: `part-${index}`,
      messageId: msg.messageId,
      sessionId: part.sessionId,
      partType: part.partType,
      ordinal: part.ordinal,
      textContent: part.textContent ?? null,
      toolCallId: part.toolCallId ?? null,
      toolName: part.toolName ?? null,
      toolInput: part.toolInput ?? null,
      toolOutput: part.toolOutput ?? null,
      metadata: part.metadata ?? null,
    }));
    await convStore.createMessageParts(
      msg.messageId,
      partRecords.map((p) => ({
        sessionId: p.sessionId,
        partType: p.partType,
        ordinal: p.ordinal,
        textContent: p.textContent,
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        toolInput: p.toolInput,
        toolOutput: p.toolOutput,
        metadata: p.metadata,
      })),
    );
    await sumStore.appendContextMessage(CONV_ID, msg.messageId);

    // 3. Assemble with a generous budget.
    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    expect(result.messages).toHaveLength(1);
    const assembled = result.messages[0] as Record<string, unknown>;

    // 4. Assert model identity survived.
    expect(assembled.provider).toBe("moonshot");
    expect(assembled.api).toBe("openai-completions");
    expect(assembled.model).toBe("kimi-k3");
    expect(assembled.responseModel).toBe("kimi-k3");

    // 5. Assert sentinel thinkingSignature survived on the thinking block.
    const content = assembled.content as Array<Record<string, unknown>>;
    const thinkingBlock = content.find((b) => b.type === "thinking");
    expect(thinkingBlock).toBeDefined();
    expect(thinkingBlock!.thinkingSignature).toBe("reasoning_content");
    expect(thinkingBlock!.thinking).toBe("reasoning text");
  });

  it("drops legacy sentinel thinking blocks without stored identity", async () => {
    // Simulate a pre-upgrade row: sentinel sig but no identity metadata.
    await convStore.createConversation({ sessionId: "session-1" });
    const msg = await convStore.createMessage({
      conversationId: CONV_ID,
      seq: 1,
      role: "assistant",
      content: "",
      tokenCount: 10,
    });
    const legacyPart: MessagePartRecord = {
      partId: "part-0",
      messageId: msg.messageId,
      sessionId: "session-1",
      partType: "reasoning",
      ordinal: 0,
      textContent: "legacy reasoning",
      toolCallId: null,
      toolName: null,
      toolInput: null,
      toolOutput: null,
      metadata: JSON.stringify({
        originalRole: "assistant",
        raw: {
          type: "thinking",
          thinking: "legacy reasoning",
          thinkingSignature: "reasoning_content",
        },
      }),
    };
    await convStore.createMessageParts(msg.messageId, [
      {
        sessionId: legacyPart.sessionId,
        partType: legacyPart.partType,
        ordinal: legacyPart.ordinal,
        textContent: legacyPart.textContent,
        toolCallId: legacyPart.toolCallId,
        toolName: legacyPart.toolName,
        toolInput: legacyPart.toolInput,
        toolOutput: legacyPart.toolOutput,
        metadata: legacyPart.metadata,
      },
    ]);
    await sumStore.appendContextMessage(CONV_ID, msg.messageId);

    const result = await assembler.assemble({
      conversationId: CONV_ID,
      tokenBudget: 100_000,
    });

    // The sentinel-only thinking block is dropped (no identity → null →
    // filtered). With no other content, the message is empty and the
    // assembler drops it entirely — correct behavior, since the alternative
    // (preserving the block) would let the host downgrade it to
    // response-channel text.
    expect(result.messages).toHaveLength(0);
  });
});
