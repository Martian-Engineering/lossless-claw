import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { cleanupEngineTestState, createEngineWithConfig, makeMessage, tempDirs } from "./helpers.js";

afterEach(cleanupEngineTestState);

const NL = String.fromCharCode(10);
const SENTINEL = "UNIQUE_MIDDLE_SENTINEL_7f3a9c";

function makeExecPayload(chars: number): string {
  const unit = "log line: the quick brown fox jumps over the lazy dog 0123456789" + NL;
  let out = "";
  while (out.length < chars) out += unit;
  return out;
}

function makePayloadWithSentinel(chars: number): string {
  const head = makeExecPayload(Math.floor(chars / 2));
  const tail = makeExecPayload(chars - head.length);
  return head + "middle-marker-" + SENTINEL + NL + tail;
}

function execToolPair(callId: string, command: string, payload: string): AgentMessage[] {
  return [
    makeMessage({ role: "user", content: "run the command" }),
    makeMessage({
      role: "assistant",
      content: [{ type: "tool_use", id: callId, name: "exec", input: { command } }],
    }),
    makeMessage({
      role: "toolResult",
      content: [{ type: "tool_result", tool_use_id: callId, name: "exec", output: payload }],
    }),
  ];
}

describe("tool-result externalization is assemble-time only", () => {
  it("does not externalize at ingest even when the switch is on", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lcm-trx-ingest-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      toolResultExternalization: true,
      toolResultExternalizationTokenThreshold: 50,
      largeFilesDir,
    });
    const sessionId = "trx-ingest-stays-legacy";
    const payload = makePayloadWithSentinel(12000);

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "run the command" }),
    });
    await engine.ingest({
      sessionId,
      message: { role: "toolResult", toolCallId: "call_exec_ingest", content: payload } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    // Nothing was moved to disk at ingest.
    const files = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(files).toHaveLength(0);
    expect(readdirSync(largeFilesDir)).toHaveLength(0);

    // The full payload is still stored inline, with no stub in the row.
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const storedText = stored.map((m) => m.content).join(NL);
    expect(storedText).toContain(SENTINEL);
    expect(storedText).not.toContain("[LCM Tool Output:");
  });

  it("still externalizes in the live assemble pre-flight when the switch is on", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lcm-trx-assemble-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      toolResultExternalization: true,
      toolResultExternalizationTokenThreshold: 50,
      largeFilesDir,
    });
    const sessionId = "trx-assemble-still-works";
    const payload = makePayloadWithSentinel(12000);
    const messages = execToolPair("call_exec_asm", "journalctl -u openclaw", payload);

    await engine.getConversationStore().getOrCreateConversation(sessionId);
    const result = await engine.assemble({ sessionId, messages, tokenBudget: 4096 });
    const serialized = JSON.stringify(result.messages ?? []);
    expect(serialized).toContain("LCM Tool Output");
    expect(serialized).not.toContain(SENTINEL);
  });
});
