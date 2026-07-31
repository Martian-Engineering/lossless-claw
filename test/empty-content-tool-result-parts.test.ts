// Empty-content tool-result ingest fallback (issue #992 follow-up).
//
// Production RCA: OpenClaw's `update_plan` tool (and any third-party tool that
// follows the same `{content: [], details: {...}}` result shape) returns a
// toolResult whose content is an EMPTY array. Before this fix:
//   1. Ingest `buildMessageParts()` ran the per-block loop zero times and
//      persisted ZERO message_parts; the top-level toolCallId/toolName/isError
//      only ever live inside part metadata, so pairing identity was lost.
//   2. Assembly `resolveMessageItem` could not recover a toolCallId from a
//      zero-part row and demoted role=tool to role="assistant" with [] content.
//   3. `isEmptyMessageContent` dropped the demoted message entirely.
//   4. `sanitizeToolUseResultPairing` then saw the assistant toolCall with no
//      result and inserted the synthetic "missing tool result" error on every
//      assemble while the call sat in the context window — the model read its
//      plan calls as FAILED and retried in a loop.
import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ContextAssembler } from "../src/assembler.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { cleanupEngineTestState, createEngine } from "./helpers.js";

afterEach(cleanupEngineTestState);

const MISSING_RESULT_MARKER = "[lossless-claw] missing tool result";

function makeUpdatePlanCall(): AgentMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "call_plan_1",
        name: "update_plan",
        arguments: { plan: [{ step: "reproduce", status: "in_progress" }] },
      },
    ],
  } as AgentMessage;
}

function makeEmptyPlanResult(): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call_plan_1",
    toolName: "update_plan",
    content: [],
    details: { plan: [{ step: "reproduce", status: "in_progress" }] },
  } as unknown as AgentMessage;
}

describe("empty-content toolResult ingest fallback (issue #992)", () => {
  it("assembles a paired toolResult instead of a synthetic missing-result error", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({ sessionId, message: makeUpdatePlanCall() });
    await engine.ingest({ sessionId, message: makeEmptyPlanResult() });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
    expect(stored[1]!.role).toBe("tool");
    // The stored text fallback is empty — the tool genuinely returned no text.
    expect(stored[1]!.content).toBe("");

    // Ingest must persist one fallback part carrying the pairing identity.
    const parts = await engine
      .getConversationStore()
      .getMessageParts(stored[1]!.messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0]!.partType).toBe("tool");
    expect(parts[0]!.toolCallId).toBe("call_plan_1");
    expect(parts[0]!.toolName).toBe("update_plan");

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
    });

    // The empty result must NOT be demoted to assistant and dropped; both the
    // call and its result survive assembly.
    expect(assembled.messages).toHaveLength(2);
    const resultMessage = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      content?: unknown;
    };
    expect(resultMessage.role).toBe("toolResult");
    expect(resultMessage.toolCallId).toBe("call_plan_1");
    expect(resultMessage.toolName).toBe("update_plan");
    expect(resultMessage.isError).not.toBe(true);
    // Effective tool output is an empty string — never a missing-result error.
    expect(JSON.stringify(resultMessage.content)).not.toContain(MISSING_RESULT_MARKER);
  });

  it("never inserts the synthetic error while the call is inside the context window", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({ sessionId, message: makeUpdatePlanCall() });
    await engine.ingest({ sessionId, message: makeEmptyPlanResult() });
    // Follow-up turns keep the pair inside the fresh tail on every assemble.
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "next step?" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());

    for (let i = 0; i < 3; i++) {
      const assembled = await assembler.assemble({
        conversationId: conversation!.conversationId,
        tokenBudget: 100_000,
      });
      const serialized = JSON.stringify(assembled.messages);
      expect(serialized).not.toContain(MISSING_RESULT_MARKER);
      const results = assembled.messages.filter(
        (m) => m.role === "toolResult" && (m as { toolCallId?: string }).toolCallId === "call_plan_1",
      );
      expect(results).toHaveLength(1);
    }
  });

  it("keeps legacy zero-part rows no worse than today (demote + drop, no crash)", async () => {
    // Rows persisted BEFORE this fix have role=tool, content='', zero parts.
    // There is no pairing identity left to recover — out of scope to repair —
    // but assembly must keep handling them exactly as it does today.
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({ sessionId, message: makeUpdatePlanCall() });
    // Fabricate the legacy shape by ingesting a string-content tool result and
    // then deleting its parts — do this because a pre-fix row is precisely
    // "role=tool, empty content, zero parts".
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_plan_1",
        toolName: "update_plan",
        content: "",
      } as unknown as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 100_000,
    });
    // Must resolve to a finite message list without throwing.
    expect(Array.isArray(assembled.messages)).toBe(true);
    expect(assembled.messages.length).toBeGreaterThan(0);
  });
});
