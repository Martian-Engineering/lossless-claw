import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  MAX_LIVE_READ_RECOVERY_BYTES,
  recoverLiveReadToolContent,
} from "../src/read-tool-recovery.js";
import {
  cleanupEngineTestState,
  createEngineWithConfig,
  createSessionFilePath,
  makeMessage,
  tempDirs,
  writeLeafTranscriptMessages,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

function createEngineForRecovery(overrides?: Partial<{ largeFilesDir: string }>) {
  const largeFilesDir = overrides?.largeFilesDir ?? mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
  tempDirs.push(largeFilesDir);
  return createEngineWithConfig({
    largeFileTokenThreshold: 20,
    stubLargeToolPayloads: true,
    largeFilesDir,
  });
}

function makeTruncatedOutput(marker: string): string {
  return `${"truncated fragment ".repeat(25)}\n${marker}`;
}

function readToolResultMessages(params: {
  filePath: string;
  truncatedOutput: string;
  callId?: string;
}): AgentMessage[] {
  const callId = params.callId ?? "call_read_1";
  return [
    makeMessage({
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: callId,
          name: "read",
          input: { path: params.filePath },
        },
      ],
    }),
    makeMessage({
      role: "toolResult",
      content: [
        {
          type: "tool_result",
          tool_use_id: callId,
          output: params.truncatedOutput,
        },
      ],
    }),
  ];
}

describe("read tool truncation recovery", () => {
  it("rejects non-file read paths during live recovery", () => {
    const dirPath = mkdtempSync(join(tmpdir(), "lossless-claw-read-dir-"));
    tempDirs.push(dirPath);
    const truncatedOutput = makeTruncatedOutput("[Read output capped at 20 bytes]");

    const recovered = recoverLiveReadToolContent({
      callId: "call_read_dir",
      extractedText: truncatedOutput,
      toolCallInputMap: new Map([
        ["call_read_dir", { name: "read", input: { path: dirPath } }],
      ]),
    });

    expect(recovered).toBe(truncatedOutput);
  });

  it("rejects oversized read paths during live recovery", () => {
    const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-read-large-"));
    tempDirs.push(fileDir);
    const filePath = join(fileDir, "large-source.txt");
    writeFileSync(filePath, Buffer.alloc(MAX_LIVE_READ_RECOVERY_BYTES + 1, "x"));
    const truncatedOutput = makeTruncatedOutput("[Truncated: content exceeded limit]");

    const recovered = recoverLiveReadToolContent({
      callId: "call_read_large",
      extractedText: truncatedOutput,
      toolCallInputMap: new Map([
        ["call_read_large", { name: "read", input: { path: filePath } }],
      ]),
    });

    expect(recovered).toBe(truncatedOutput);
  });

  it("assemble() recovers full file content from a live current-turn read tool result", async () => {
    const engine = createEngineForRecovery();
    const sessionId = "assemble-read-truncation-recovery";

    const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-read-source-"));
    tempDirs.push(fileDir);
    const filePath = join(fileDir, "source.txt");
    const fullContent = ["line 1", "line 2", "line 3", "line 4", "line 5"].join("\n");
    writeFileSync(filePath, fullContent, "utf8");

    const truncatedOutput = makeTruncatedOutput("[Read output capped at 50 bytes]");
    const liveMessages = [
      makeMessage({ role: "user", content: "read the file" }),
      ...readToolResultMessages({ filePath, truncatedOutput }),
    ];

    await engine.getConversationStore().getOrCreateConversation(sessionId);

    const assembleResult = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);

    const storedContent = readFileSync(largeFiles[0]!.storageUri, "utf8");
    expect(storedContent).toBe(fullContent);

    const described = await engine.getRetrieval().describe(largeFiles[0]!.fileId, {
      expandFile: true,
      largeFilesDir: engine.configView.largeFilesDir,
    });
    expect(described?.file?.content).toBe(fullContent);
    expect(described?.file?.contentTruncated).toBe(false);

    const stubText = assembleResult.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(stubText).toContain(`[LCM Tool Output: ${largeFiles[0]!.fileId}`);
    expect(stubText).toContain("tool=read");
  });

  it("afterTurn() ingest preserves truncated read tool result without recovery", async () => {
    const engine = createEngineForRecovery();
    const sessionId = "afterturn-read-truncation-no-recovery";
    const sessionFile = createSessionFilePath("afterturn-read-truncation-no-recovery");

    const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-read-source-"));
    tempDirs.push(fileDir);
    const filePath = join(fileDir, "source.txt");
    const fullContent = ["alpha", "beta", "gamma", "delta", "epsilon"].join("\n");
    writeFileSync(filePath, fullContent, "utf8");

    const truncatedOutput = makeTruncatedOutput("[Truncated: content exceeded limit]");
    const messages = [
      makeMessage({ role: "user", content: "read the file" }),
      ...readToolResultMessages({ filePath, truncatedOutput }),
    ];

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);

    const storedContent = readFileSync(largeFiles[0]!.storageUri, "utf8");
    expect(storedContent).toBe(truncatedOutput);
    expect(storedContent).not.toBe(fullContent);
  });

  it("bootstrap import does not rehydrate truncated read tool results from current disk", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const engine = createEngineForRecovery({ largeFilesDir });
    const sessionId = "bootstrap-read-truncation-no-recovery";
    const sessionFile = createSessionFilePath("bootstrap-read-truncation-no-recovery");

    const fileDir = mkdtempSync(join(tmpdir(), "lossless-claw-read-source-"));
    tempDirs.push(fileDir);
    const filePath = join(fileDir, "source.txt");
    const currentContent = "completely rewritten content";
    writeFileSync(filePath, currentContent, "utf8");

    const truncatedOutput = makeTruncatedOutput("[Read output capped at 20 bytes]");
    const transcriptMessages = [
      makeMessage({ role: "user", content: "read the file" }),
      ...readToolResultMessages({ filePath, truncatedOutput }),
    ];
    writeLeafTranscriptMessages(sessionFile, transcriptMessages);

    const result = await engine.bootstrap({
      sessionId,
      sessionFile,
    });
    expect(result.bootstrapped).toBe(true);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);

    const storedContent = readFileSync(largeFiles[0]!.storageUri, "utf8");
    expect(storedContent).toBe(truncatedOutput);
    expect(storedContent).not.toBe(currentContent);
  });

  it("falls back to truncated content when the read tool path is relative or missing", async () => {
    const engine = createEngineForRecovery();
    const sessionId = "assemble-read-truncation-fallback";

    const relativePath = "./relative-file.txt";
    const truncatedOutput = makeTruncatedOutput("[Read output capped at 20 bytes]");
    const liveMessages = [
      makeMessage({ role: "user", content: "read the file" }),
      makeMessage({
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_read_missing",
            name: "read",
            input: { path: relativePath },
          },
        ],
      }),
      makeMessage({
        role: "toolResult",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_read_missing",
            output: truncatedOutput,
          },
        ],
      }),
    ];

    await engine.getConversationStore().getOrCreateConversation(sessionId);

    const assembleResult = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const largeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFiles).toHaveLength(1);

    const storedContent = readFileSync(largeFiles[0]!.storageUri, "utf8");
    expect(storedContent).toBe(truncatedOutput);

    const stubText = assembleResult.messages
      .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
      .join("\n");
    expect(stubText).toContain(`[LCM Tool Output: ${largeFiles[0]!.fileId}`);
  });
});
