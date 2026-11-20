import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  cleanupEngineTestState,
  createEngineWithConfig,
  makeMessage,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const NL = String.fromCharCode(10);
const SENTINEL = "UNIQUE_MIDDLE_SENTINEL_7f3a9c";

function makeExecPayload(chars: number): string {
  const unit = "log line: the quick brown fox jumps over the lazy dog 0123456789" + NL;
  let out = "";
  while (out.length < chars) out += unit;
  return out;
}

/** Payload whose only copy of SENTINEL sits far from both ends. */
function makePayloadWithSentinel(chars: number): string {
  const head = makeExecPayload(Math.floor(chars / 2));
  const tail = makeExecPayload(chars - head.length);
  return head + "middle-marker-" + SENTINEL + NL + tail;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Flatten assembled content into readable text (real newlines preserved). */
function renderText(messages: AgentMessage[]): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      parts.push(message.content);
      continue;
    }
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block && typeof block === "object") {
        const record = block as Record<string, unknown>;
        if (typeof record.text === "string") parts.push(record.text);
        else if (typeof record.output === "string") parts.push(record.output);
        else parts.push(JSON.stringify(block));
      }
    }
  }
  return parts.join(NL);
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

describe("tool-result externalization (Step 5)", () => {
  it("round-trips a large exec result: stub in context, exact bytes recoverable from disk", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lcm-trx-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      toolResultExternalization: true,
      toolResultExternalizationTokenThreshold: 50,
      largeFilesDir,
    });
    const sessionId = "trx-roundtrip";
    const command = "journalctl -u openclaw --since today";
    const payload = makePayloadWithSentinel(12000);
    const messages = execToolPair("call_exec_rt", command, payload);

    await engine.getConversationStore().getOrCreateConversation(sessionId);
    const result = await engine.assemble({ sessionId, messages, tokenBudget: 4096 });
    const text = renderText(result.messages);

    // 1) the context holds a compact stub, not the full payload
    expect(text).toContain("[LCM Tool Output:");
    expect(text).toContain("tool=exec");
    expect(text).toContain("Command: " + command);
    expect(text).not.toContain(SENTINEL);
    expect(text.length).toBeLessThan(payload.length / 2);

    // 2) the stub names the on-disk path and the file id
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const files = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(files).toHaveLength(1);
    const storageUri = files[0]!.storageUri;
    expect(text).toContain("Original text on disk: " + storageUri);
    expect(text).toContain(files[0]!.fileId);

    // 3) reading the path stated in the stub returns the payload byte-for-byte
    const pathMatch = text.match(new RegExp("Original text on disk: ([^" + NL + "]+)"));
    expect(pathMatch).not.toBeNull();
    const stubPath = pathMatch![1]!;
    expect(stubPath).toBe(storageUri);
    const recovered = readFileSync(stubPath, "utf8");
    expect(recovered).toBe(payload);
    expect(sha256(recovered)).toBe(sha256(payload));

    // 4) the agent's real retrieval path returns it too
    const described = await engine.getRetrieval().describe(files[0]!.fileId, {
      expandFile: true,
      largeFilesDir: engine.configView.largeFilesDir,
    });
    expect(described?.file?.content).toBe(payload);
    expect(described?.file?.contentTruncated).toBe(false);

    console.log(
      "ROUNDTRIP stubChars=" +
        text.length +
        " payloadChars=" +
        payload.length +
        " stubSha=" +
        sha256(recovered).slice(0, 16) +
        " payloadSha=" +
        sha256(payload).slice(0, 16),
    );
  });

  it("ingestBatch leaves the payload inline — externalization happens at assemble", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lcm-trx-ingest-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineWithConfig({
      toolResultExternalization: true,
      toolResultExternalizationTokenThreshold: 50,
      largeFilesDir,
    });
    const sessionId = "trx-ingest";
    const payload = makePayloadWithSentinel(12000);
    await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage({ role: "user", content: "run the command" }),
        {
          role: "toolResult",
          toolCallId: "call_exec_in",
          content: payload,
        } as AgentMessage,
      ],
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const files = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    // Step 5 is assemble-time only: ingest must not externalize anything.
    expect(files).toHaveLength(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const storedText = stored
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(NL);
    expect(storedText).toContain(SENTINEL);
    expect(storedText).not.toContain("[LCM Tool Output:");
  });

  it("falls back to inlining the full result when disk write fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-trx-block-"));
    tempDirs.push(root);
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory", "utf8");
    const engine = createEngineWithConfig({
      toolResultExternalization: true,
      toolResultExternalizationTokenThreshold: 50,
      largeFilesDir: join(blocker, "nested"),
    });
    const sessionId = "trx-fallback";
    const payload = makePayloadWithSentinel(12000);
    const messages = execToolPair("call_exec_fb", "cat huge.log", payload);

    await engine.getConversationStore().getOrCreateConversation(sessionId);
    const result = await engine.assemble({ sessionId, messages, tokenBudget: 4096 });
    const text = renderText(result.messages);

    expect(text).not.toContain("[LCM Tool Output:");
    expect(text).toContain(SENTINEL);
    expect(text).toContain("log line: the quick brown fox");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const files = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(files).toHaveLength(0);
  });
});
