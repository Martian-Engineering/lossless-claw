/**
 * Regression repro: recurrent model-authored tool-call ids (Kimi K3 style
 * `name:N`, e.g. `exec:101`) must never be treated as globally unique event
 * identities. After PR #1040/8ac4720 the stable-event-key short-circuit in
 * ingestSingle skipped every tool result whose toolCallId had been persisted
 * before — on a model that recycles the same ~30 ids each hour this silently
 * dropped nearly all tool results (2026-08-02 incident, conversation 476).
 */
import { afterEach, describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  appendSessionMessage,
  cleanupEngineTestState,
  createEngine,
  createSessionFilePath,
  makeMessage,
  writeLeafTranscriptMessages,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const NO_OUTPUT = "(no output)";

function assistantToolCall(id: string, command: string): AgentMessage {
  return makeMessage({
    role: "assistant",
    content: [{ type: "tool_use", id, name: "exec", input: { command } }],
  });
}

function toolResult(id: string): AgentMessage {
  return makeMessage({
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text: NO_OUTPUT }],
  });
}

describe("recurrent model-authored toolCallIds (K3 pattern)", () => {
  it("persists every tool result when the same recurrent toolCallId repeats with identical content", async () => {
    const engine = createEngine();
    const sessionId = "k3-recurrent-id-repro";

    // Three K3 turns reusing exec:101 with byte-identical "(no output)"
    // results — the exact pattern from the live incident.
    for (const command of ["ls /tmp/a", "ls /tmp/b", "ls /tmp/c"]) {
      await engine.ingest({ sessionId, message: makeMessage({ role: "user", content: `run ${command}` }) });
      await engine.ingest({ sessionId, message: assistantToolCall("exec:101", command) });
      await engine.ingest({ sessionId, message: toolResult("exec:101") });
    }

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const rows = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const results = rows.filter((row) => row.role === "tool");
    expect(results.length).toBe(3);
    expect(results.every((row) => row.content === NO_OUTPUT)).toBe(true);
  });

  it("persists transcript-imported results even when a same-toolCallId row already exists", async () => {
    // The incident shape: a previous occurrence of recurrent id exec:101 is
    // already persisted AND stamped with its transcript entry id; a later
    // DISTINCT transcript entry (new unique rawId, same model-authored id,
    // same "(no output)" body) must still import. Pre-fix the stable-event
    // short-circuit dropped it; the partial unique index then made the loss
    // unrecoverable.
    const engine = createEngine();
    const sessionId = "k3-recurrent-id-transcript-import";
    const sessionKey = "agent:main:k3-recurrent-id-transcript-import";
    const sessionFile = createSessionFilePath("k3-recurrent-id-transcript-import");

    writeLeafTranscriptMessages(sessionFile, []);
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, makeMessage({ role: "user", content: "run ls /tmp/a" }));
    appendSessionMessage(sm, assistantToolCall("exec:101", "ls /tmp/a"));
    appendSessionMessage(sm, toolResult("exec:101"));
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    // A later turn reuses the recurrent id: same id, same result body, new
    // transcript entry id.
    appendSessionMessage(sm, makeMessage({ role: "user", content: "run ls /tmp/b" }));
    appendSessionMessage(sm, assistantToolCall("exec:101", "ls /tmp/b"));
    appendSessionMessage(sm, toolResult("exec:101"));
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const rows = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const results = rows.filter((row) => row.role === "tool");
    expect(results.length).toBe(2);
    expect(results.every((row) => row.content === NO_OUTPUT)).toBe(true);
  });

  it("persists constant-content results from upstream OpenClaw (update_plan 'Plan updated'), even with repeated ids", async () => {
    // Upstream OpenClaw 87d5cb9f674 makes update_plan / agents-wait return a
    // CONSTANT result string. Combined with recurrent model-authored ids this
    // is the permanent collision class: content and toolCallId both
    // non-discriminating. Every event must still persist.
    const engine = createEngine();
    const sessionId = "k3-constant-content-results";

    for (let turn = 0; turn < 4; turn += 1) {
      await engine.ingest({ sessionId, message: makeMessage({ role: "user", content: `turn ${turn}` }) });
      await engine.ingest({
        sessionId,
        message: makeMessage({
          role: "assistant",
          content: [{ type: "tool_use", id: "update_plan:7", name: "update_plan", input: { plan: [`step ${turn}`] } }],
        }),
      });
      await engine.ingest({
        sessionId,
        message: makeMessage({
          role: "tool",
          toolCallId: "update_plan:7",
          content: "Plan updated",
        }),
      });
    }

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const rows = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const results = rows.filter((row) => row.role === "tool");
    expect(results.length).toBe(4);
    expect(results.every((row) => row.content === "Plan updated")).toBe(true);
  });

  it("still dedupes redacted twins carrying provider-unique tool ids (original #1040 behavior)", async () => {
    const engine = createEngine();
    const sessionId = "unique-id-redacted-twin";
    const sessionKey = "agent:main:unique-id-redacted-twin";
    const sessionFile = createSessionFilePath("unique-id-redacted-twin");

    writeLeafTranscriptMessages(sessionFile, [
      makeMessage({
        role: "toolResult",
        content: [{ type: "text", text: "redacted by logging.redactPatterns" }],
        toolCallId: "toolu_01Y9u9D2Vrv7VdWeLPvHUfwU",
      }),
    ]);
    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({
          role: "toolResult",
          content: "original unredacted tool result body",
          toolCallId: "toolu_01Y9u9D2Vrv7VdWeLPvHUfwU",
        } as never),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const rows = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.content).toBe("redacted by logging.redactPatterns");
  });

  it("assembly after recurrent-id ingestion inserts no synthetic missing-tool-result errors", async () => {
    const engine = createEngine();
    const sessionId = "k3-recurrent-id-assembly";
    const sessionFile = createSessionFilePath("k3-recurrent-id-assembly");
    writeLeafTranscriptMessages(sessionFile, []);
    await engine.bootstrap({ sessionId, sessionFile });

    for (const command of ["ls /tmp/a", "ls /tmp/b", "ls /tmp/c"]) {
      await engine.ingest({ sessionId, message: makeMessage({ role: "user", content: `run ${command}` }) });
      await engine.ingest({ sessionId, message: assistantToolCall("exec:101", command) });
      await engine.ingest({ sessionId, message: toolResult("exec:101") });
    }

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const assembler = new ContextAssembler(
      engine.getConversationStore(),
      engine.getSummaryStore(),
    );
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 64_000,
    });
    const payload = JSON.stringify(assembled.messages);
    expect(payload).not.toContain("missing tool result");
  });
});
