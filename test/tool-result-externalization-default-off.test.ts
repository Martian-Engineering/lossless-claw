/**
 * Default-off regression harness for tool-result externalization (Step 5).
 *
 * Deliberately avoids any reference to the new Step 5 config keys so it
 * compiles and runs unchanged on both 7e45514 (pre-Step-5) and the feature
 * branch. Diff the GOLDEN lines across the two trees to prove the default
 * configuration is byte-for-byte unchanged.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { cleanupEngineTestState, createEngineWithConfig, makeMessage } from "./helpers.js";

afterEach(cleanupEngineTestState);

const NL = String.fromCharCode(10);
const FILE_ID_RE = new RegExp("file_[0-9a-f]{16}", "g");

function bigToolOutput(label: string, chars?: number): string {
  const unit = "line for " + label + ": the quick brown fox jumps over the lazy dog 0123456789" + NL;
  const target = chars === undefined ? 200000 : chars;
  let out = "";
  while (out.length < target) out += unit;
  return out;
}

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}

function projectMessages(messages: AgentMessage[]): string {
  const projection = messages.map((m) => ({ role: m.role, content: m.content }));
  return JSON.stringify(projection).replace(FILE_ID_RE, "<FILE>");
}

function serializedText(messages: AgentMessage[]): string {
  return messages
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join(NL);
}

describe("tool-result externalization default-off harness", () => {
  it("A: default config leaves the oversized live tool result inline", async () => {
    const engine = createEngineWithConfig({});
    const sessionId = "trx-default-off-live";
    const payload = bigToolOutput("default-off-live");
    const messages = [
      makeMessage({ role: "user", content: "run the command" }),
      makeMessage({
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_exec_1", name: "exec", input: { command: "ls -la" } },
        ],
      }),
      makeMessage({
        role: "toolResult",
        content: [
          { type: "tool_result", tool_use_id: "call_exec_1", name: "exec", output: payload },
        ],
      }),
    ];
    await engine.getConversationStore().getOrCreateConversation(sessionId);

    const result = await engine.assemble({ sessionId, messages, tokenBudget: 4096 });
    const text = serializedText(result.messages);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const files = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);

    expect(text).toContain("line for default-off-live");
    expect(text).not.toContain("[LCM Tool Output:");
    expect(files).toHaveLength(0);

    console.log("GOLDEN A msgs=" + sha(projectMessages(result.messages)) + " files=" + files.length);
  });

  it("B: default config ingestBatch externalizes past the 25k-token threshold", async () => {
    const engine = createEngineWithConfig({});
    const sessionId = "trx-default-off-ingest";
    const payload = bigToolOutput("default-off-ingest");
    const messages = [
      makeMessage({ role: "user", content: "run the command" }),
      makeMessage({
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_exec_2", name: "exec", input: { command: "ls -la" } },
        ],
      }),
      makeMessage({
        role: "toolResult",
        content: [
          { type: "tool_result", tool_use_id: "call_exec_2", name: "exec", output: payload },
        ],
      }),
    ];

    await engine.ingestBatch({ sessionId, messages });
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const files = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(files).toHaveLength(1);

    const onDisk = readFileSync(files[0]!.storageUri, "utf8");
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    const storedText = stored
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join(NL)
      .replace(FILE_ID_RE, "<FILE>");

    expect(onDisk).toBe(payload);
    console.log(
      "GOLDEN B stored=" +
        sha(storedText) +
        " disk=" +
        sha(onDisk) +
        " bytes=" +
        files[0]!.byteSize +
        " lines=" +
        files[0]!.lineCount,
    );
  });

  it("C: legacy stubLargeToolPayloads live path is unchanged", async () => {
    const engine = createEngineWithConfig({
      stubLargeToolPayloads: true,
      largeFileTokenThreshold: 50,
    });
    const sessionId = "trx-legacy-stub-live";
    const payload = bigToolOutput("legacy-stub-live", 4000);
    const messages = [
      makeMessage({ role: "user", content: "run the command" }),
      makeMessage({
        role: "assistant",
        content: [
          { type: "tool_use", id: "call_exec_3", name: "exec", input: { command: "ls -la" } },
        ],
      }),
      makeMessage({
        role: "toolResult",
        content: [
          { type: "tool_result", tool_use_id: "call_exec_3", name: "exec", output: payload },
        ],
      }),
    ];
    await engine.getConversationStore().getOrCreateConversation(sessionId);

    const result = await engine.assemble({ sessionId, messages, tokenBudget: 4096 });
    const text = serializedText(result.messages);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    const files = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);

    expect(text).toContain("[LCM Tool Output:");
    expect(files).toHaveLength(1);
    const onDisk = readFileSync(files[0]!.storageUri, "utf8");
    expect(onDisk).toBe(payload);

    console.log(
      "GOLDEN C msgs=" +
        sha(projectMessages(result.messages)) +
        " files=" +
        files.length +
        " disk=" +
        sha(onDisk),
    );
  });
});
