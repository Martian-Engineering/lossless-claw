import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import { createLosslessMessageSignature } from "../src/message-signatures.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { cleanupEngineTestState, createEngine } from "./helpers.js";

afterEach(cleanupEngineTestState);

const CONTINUATION_PROMPT =
  "The plugin runtime has been refreshed. Continue the current task from the transcript using the updated tools.";

/** Ingest messages into a fresh conversation and assemble them back from SQLite. */
async function roundTrip(messages: AgentMessage[]): Promise<AgentMessage[]> {
  const engine = createEngine();
  const sessionId = randomUUID();
  for (const message of messages) {
    await engine.ingest({ sessionId, message });
  }
  const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
  expect(conversation).not.toBeNull();
  const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
  const assembled = await assembler.assemble({
    conversationId: conversation!.conversationId,
    tokenBudget: 10_000,
  });
  return assembled.messages;
}

describe("host input provenance", () => {
  it.each([
    ["string", CONTINUATION_PROMPT],
    ["text block", [{ type: "text", text: CONTINUATION_PROMPT }]],
  ])("keeps internal_system provenance and display:false on %s content", async (_shape, content) => {
    const assembled = await roundTrip([
      {
        role: "user",
        content,
        provenance: { kind: "internal_system", sourceTool: "plugin_runtime_refresh" },
        display: false,
      } as unknown as AgentMessage,
      { role: "user", content: "a message the user typed" } as AgentMessage,
    ]);

    expect(assembled[0]).toMatchObject({
      role: "user",
      provenance: { kind: "internal_system", sourceTool: "plugin_runtime_refresh" },
      display: false,
    });
    expect(assembled[1]).not.toHaveProperty("provenance");
    expect(assembled[1]).not.toHaveProperty("display");
  });

  it("keeps provenance out of message identity so earlier rows still match", () => {
    const plain = { role: "user", content: CONTINUATION_PROMPT } as AgentMessage;
    const marked = {
      ...plain,
      provenance: { kind: "internal_system" },
      display: false,
    } as unknown as AgentMessage;

    expect(createLosslessMessageSignature(marked)).toBe(createLosslessMessageSignature(plain));
  });

  it("ignores malformed provenance values", async () => {
    const assembled = await roundTrip([
      { role: "user", content: "odd input", provenance: "internal_system", display: "no" } as unknown as AgentMessage,
    ]);

    expect(assembled[0]).not.toHaveProperty("provenance");
    expect(assembled[0]).not.toHaveProperty("display");
  });
});
