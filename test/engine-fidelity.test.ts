// Engine fidelity and token budget: lossless round-tripping of content through ingest/assemble under budget pressure.
// Split from the former monolithic test/engine.test.ts; shared fixtures live in test/helpers.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { ContextAssembler } from "../src/assembler.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import { estimateSerializedMessageTokens, estimateSerializedMessagesTokens, estimateTokens } from "../src/estimate-tokens.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { applyScopedDoctorRepair } from "../src/plugin/lcm-doctor-apply.js";
import { detectDoctorMarker } from "../src/plugin/lcm-doctor-shared.js";
import type { LcmDependencies } from "../src/types.js";
import {
  cleanupEngineTestState,
  appendSessionMessage,
  getEngineConfig,
  createEngine,
  createEngineWithDepsOverrides,
  createSessionFilePath,
  writeLeafTranscript,
  writeLeafTranscriptMessages,
  createEngineWithConfig,
  createEngineWithDeps,
  makeMessage,
  seedBacklogContext,
  estimateAssembledPayloadTokens,
  tempDirs,
} from "./helpers.js";

afterEach(cleanupEngineTestState);
describe("LcmContextEngine fidelity and token budget", () => {
  it("normalizes tool_result blocks without inflating stored token accounting", async () => {
    // Verify that tool_result blocks with large raw metadata blobs are
    // normalized through toolResultBlockFromPart rather than returned
    // verbatim. Raw metadata should NOT leak into the assembled payload —
    // only the dedicated part columns (toolOutput, textContent) matter.
    const engine = createEngine();
    const sessionId = randomUUID();
    const rawBlob = "x".repeat(24_000);

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_large_raw", name: "read", input: { path: "foo.txt" } },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_large_raw",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_large_raw",
            metadata: {
              raw: rawBlob,
              details: { payload: rawBlob.slice(0, 8_000) },
            },
          },
        ],
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const contextTokens = await engine
      .getSummaryStore()
      .getContextTokenCount(conversation!.conversationId);
    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 500_000,
    });
    const assembledPayloadTokens = estimateAssembledPayloadTokens(assembled.messages);

    // The assembled payload should be small — the 24K raw metadata blob
    // must NOT appear in the output. Tool results use dedicated columns,
    // not the raw metadata object.
    expect(contextTokens).toBe(assembledPayloadTokens);
    expect(assembledPayloadTokens).toBeLessThan(500);
  });

  it("preserves structured toolResult content via message_parts and assembler", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const assistantToolCall = {
      role: "assistant",
      content: [{ type: "toolCall", id: "call_123", name: "read", input: { path: "foo.txt" } }],
    } as AgentMessage;
    const toolResult = {
      role: "toolResult",
      toolCallId: "call_123",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_123",
          content: [{ type: "text", text: "command output" }],
        },
      ],
    } as AgentMessage;

    await engine.ingest({
      sessionId,
      message: assistantToolCall,
    });

    await engine.ingest({
      sessionId,
      message: toolResult,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[1].role).toBe("tool");

    const parts = await engine.getConversationStore().getMessageParts(storedMessages[1].messageId);
    expect(parts).toHaveLength(1);
    expect(parts[0].partType).toBe("tool");
    expect(parts[0].toolCallId).toBe("call_123");

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });
    expect(assembled.messages).toHaveLength(2);
    expect(assembled.messages[0]?.role).toBe("assistant");

    const assembledMessage = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      content?: unknown;
    };
    expect(assembledMessage.role).toBe("toolResult");
    expect(assembledMessage.toolCallId).toBe("call_123");
    expect(Array.isArray(assembledMessage.content)).toBe(true);
    expect((assembledMessage.content as Array<{ type?: string }>)[0]?.type).toBe("tool_result");
    expect(
      (assembledMessage.content as Array<{ content?: unknown }>)[0]?.content,
    ).toEqual([{ type: "text", text: "command output" }]);
  });

  it("does not leak OpenAI function tool payloads into stored message content fallbacks", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          { type: "function_call", call_id: "fc_only", name: "bash", arguments: '{"cmd":"pwd"}' },
        ],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "fc_only",
        toolName: "bash",
        content: [{ type: "function_call_output", call_id: "fc_only", output: "/tmp" }],
        isError: false,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);
    expect(storedMessages[0]?.content).toBe("");
    expect(storedMessages[1]?.content).toBe("");

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });
    const assistant = assembled.messages[0] as { content?: Array<{ type?: string }> };
    const toolResult = assembled.messages[1] as { content?: Array<{ type?: string }> };
    expect(assistant.content?.[0]?.type).toBe("function_call");
    expect(toolResult.content?.[0]?.type).toBe("function_call_output");
  });

  it("preserves toolName through ingest-assemble round-trip for Gemini compatibility", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_456", name: "bash", input: { command: "ls" } }],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_456",
        toolName: "bash",
        content: [{ type: "text", text: "file1.txt\nfile2.txt" }],
        isError: false,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const parts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(parts[0].toolName).toBe("bash");

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const result = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call_456");
    expect(result.toolName).toBe("bash");
    expect(result.isError).toBe(false);
  });

  it("preserves toolResult error state through ingest-assemble round-trip", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_457", name: "bash", input: { command: "false" } }],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_457",
        toolName: "bash",
        content: [{ type: "text", text: "command failed" }],
        isError: true,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const parts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(JSON.parse(parts[0].metadata ?? "{}")).toMatchObject({ isError: true });

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const result = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
    };
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call_457");
    expect(result.toolName).toBe("bash");
    expect(result.isError).toBe(true);
  });

  it("preserves top-level tool metadata for string-content tool results", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_458", name: "bash", input: { command: "pwd" } }],
      } as AgentMessage,
    });

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_458",
        toolName: "bash",
        content: "/tmp/project",
        isError: false,
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const parts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(parts[0].partType).toBe("text");
    expect(JSON.parse(parts[0].metadata ?? "{}")).toMatchObject({
      toolCallId: "call_458",
      toolName: "bash",
      isError: false,
    });

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const result = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      toolName?: string;
      isError?: boolean;
      content?: unknown;
    };
    expect(result.role).toBe("toolResult");
    expect(result.toolCallId).toBe("call_458");
    expect(result.toolName).toBe("bash");
    expect(result.isError).toBe(false);
    expect(result.content).toEqual([{ type: "text", text: "/tmp/project" }]);
  });

  it("preserves top-level reasoning_content for assistant tool-call replay", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const privateReasoning = "PRIVATE_KIMI_REASONING_CONTENT";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        reasoning_content: privateReasoning,
        content: [
          {
            type: "function_call",
            call_id: "fc_kimi_1",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "fc_kimi_1",
        toolName: "bash",
        content: [{ type: "function_call_output", call_id: "fc_kimi_1", output: "/tmp/project" }],
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const assistantParts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[0].messageId);
    expect(storedMessages[0].tokenCount).toBeGreaterThanOrEqual(estimateTokens(privateReasoning));
    expect(assistantParts.map((part) => part.partType)).toEqual(["tool"]);
    expect(JSON.parse(assistantParts[0].metadata ?? "{}")).toMatchObject({
      topLevelReasoningField: "reasoning_content",
      topLevelReasoningContent: privateReasoning,
    });

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    const assistant = assembled.messages[0] as {
      role: string;
      reasoning_content?: string;
      content?: Array<{ type?: string; call_id?: string; arguments?: unknown }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.reasoning_content).toBe(privateReasoning);
    expect(JSON.stringify(assistant.content)).not.toContain(privateReasoning);
    expect(assistant.content?.[0]?.type).toBe("function_call");
    expect(assistant.content?.[0]?.call_id).toBe("fc_kimi_1");
    expect(assistant.content?.[0]?.arguments).toBe('{"cmd":"pwd"}');
  });

  it("reconstructs OpenAI reasoning and function call blocks when raw metadata is missing", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Need shell output before replying." }],
          },
          {
            type: "function_call",
            call_id: "fc_2",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "fc_2",
        toolName: "bash",
        content: [{ type: "function_call_output", call_id: "fc_2", output: { cwd: "/tmp" } }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(2);

    const assistantParts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[0].messageId);
    expect(assistantParts.map((part) => part.partType)).toEqual(["reasoning", "tool"]);
    expect(assistantParts[1].toolCallId).toBe("fc_2");

    const toolResultParts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(toolResultParts).toHaveLength(1);
    expect(toolResultParts[0].partType).toBe("tool");
    expect(toolResultParts[0].toolCallId).toBe("fc_2");

    const db = (engine.getConversationStore() as unknown as {
      db: { prepare: (sql: string) => { run: (metadata: string, partId: string) => void } };
    }).db;

    for (const part of [...assistantParts, ...toolResultParts]) {
      const metadata = JSON.parse(part.metadata ?? "{}") as Record<string, unknown>;
      delete metadata.raw;
      db.prepare("UPDATE message_parts SET metadata = ? WHERE part_id = ?").run(
        JSON.stringify(metadata),
        part.partId,
      );
    }

    const assembler = new ContextAssembler(engine.getConversationStore(), engine.getSummaryStore());
    const assembled = await assembler.assemble({
      conversationId: conversation!.conversationId,
      tokenBudget: 10_000,
    });

    expect(assembled.messages).toHaveLength(2);

    const assistant = assembled.messages[0] as {
      role: string;
      content?: Array<{ type?: string; text?: string; call_id?: string; arguments?: unknown }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content?.map((block) => block.type)).toEqual(["reasoning", "function_call"]);
    expect(assistant.content?.[0]?.text).toBe("Need shell output before replying.");
    expect(assistant.content?.[1]?.call_id).toBe("fc_2");
    expect(assistant.content?.[1]?.arguments).toBe('{"cmd":"pwd"}');

    const toolResult = assembled.messages[1] as {
      role: string;
      toolCallId?: string;
      content?: Array<{ type?: string; call_id?: string; output?: unknown }>;
    };
    expect(toolResult.role).toBe("toolResult");
    expect(toolResult.toolCallId).toBe("fc_2");
    expect(toolResult.content?.[0]?.type).toBe("function_call_output");
    expect(toolResult.content?.[0]?.call_id).toBe("fc_2");
    expect(toolResult.content?.[0]?.output).toEqual({ cwd: "/tmp" });
  });

  it("skips unknown roles instead of storing them as assistant messages", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    const result = await engine.ingest({
      sessionId,
      message: makeMessage({ role: "custom-event", content: "opaque payload" }),
    });

    expect(result.ingested).toBe(false);
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).toBeNull();
  });

  it("uses explicit compact tokenBudget over legacy tokenBudget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 12,
      threshold: 9,
    });
    const compactSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "budget-session",
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    const result = await engine.compact({
      sessionId: "budget-session",
      sessionFile: "/tmp/unused.jsonl",
      tokenBudget: 123,
      legacyParams: { tokenBudget: 999 },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 123);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("ingests completed turn batches with ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-session";
    const messages: AgentMessage[] = [
      makeMessage({ role: "user", content: "turn user 1" }),
      makeMessage({ role: "assistant", content: "turn assistant 1" }),
      makeMessage({ role: "user", content: "turn user 2" }),
    ];

    const result = await engine.ingestBatch({
      sessionId,
      messages,
    });
    expect(result.ingestedCount).toBe(3);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      3,
    );
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(3);
  });

  it("deduplicates persisted replay rows in ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-replay-dedup-session";
    const replayedMessages: AgentMessage[] = [
      makeMessage({
        role: "user",
        content: [{ type: "text", id: "raw-replay-user", text: "checkpoint replay user" }],
      }),
      makeMessage({
        role: "assistant",
        content: [{ type: "text", id: "raw-replay-assistant", text: "checkpoint replay assistant" }],
      }),
    ];

    const first = await engine.ingestBatch({
      sessionId,
      messages: replayedMessages,
    });
    expect(first.ingestedCount).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(
          `UPDATE messages SET created_at = datetime('now', '-10 seconds') WHERE conversation_id = ?`,
        )
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const replay = await engine.ingestBatch({
      sessionId,
      messages: replayedMessages,
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "checkpoint replay user",
      "checkpoint replay assistant",
    ]);
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(2);
  });

  it("keeps content-only repeated rows in ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-legitimate-repeat-session";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "hello" }),
    });

    const result = await engine.ingestBatch({
      sessionId,
      messages: [
        makeMessage({ role: "user", content: "hello" }),
        makeMessage({ role: "assistant", content: "world" }),
      ],
    });
    expect(result.ingestedCount).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["hello", "hello", "world"]);
  });

  it("deduplicates single raw-id replay rows in ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-single-raw-replay-session";
    const replayedMessage = makeMessage({
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "raw-single-tool", output: "same output" }],
    });

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([""]);
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(1);
  });

  it("keeps changed tool output rows that reuse a raw id", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-changed-tool-output-session";
    const firstMessage = makeMessage({
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "raw-changed-tool", output: "old output" }],
    });
    const changedMessage = makeMessage({
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "raw-changed-tool", output: "new output" }],
    });

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
    const changedParts = await engine.getConversationStore().getMessageParts(stored[1]!.messageId);
    const metadata = JSON.parse(changedParts[0]!.metadata ?? "{}") as {
      raw?: { output?: unknown };
    };
    expect(metadata.raw?.output).toBe("new output");
  });

  it("keeps raw-id tool rows when top-level metadata changes but raw output matches", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-raw-id-metadata-change-session";
    const firstMessage = {
      role: "toolResult",
      toolName: "exec",
      content: [{ type: "tool_result", tool_use_id: "raw-metadata-change", output: "same output" }],
      timestamp: Date.now(),
    } as AgentMessage;
    const changedMessage = {
      role: "toolResult",
      toolName: "shell",
      content: [{ type: "tool_result", tool_use_id: "raw-metadata-change", output: "same output" }],
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("deduplicates top-level tool-call replay rows in ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-top-level-tool-replay-session";
    const replayedMessage = {
      role: "tool",
      content: "same output",
      toolCallId: "call_top_level_replay",
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["same output"]);
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(1);
  });

  it("keeps top-level tool rows when metadata changes but text matches", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-top-level-metadata-change-session";
    const firstMessage = {
      role: "tool",
      content: "same output",
      toolCallId: "call_metadata_change",
      toolName: "exec",
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage;
    const changedMessage = {
      ...firstMessage,
      isError: true,
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("deduplicates replay rows when persistence rewrites stored content", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-rewritten-content-replay-session";
    const toolOutput = `${"tool output line\n".repeat(160)}done`;
    const replayedMessage = {
      role: "toolResult",
      toolCallId: "call_rewritten_replay",
      toolName: "exec",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_rewritten_replay",
          name: "exec",
          content: [{ type: "text", text: toolOutput }],
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toContain("[LCM Tool Output: file_");
    expect(
      (await engine.getSummaryStore().getLargeFilesByConversation(conversation!.conversationId)),
    ).toHaveLength(1);
  });

  it("deduplicates externalized tool-result replay rows with aliased ids", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-externalized-alias-replay-session";
    const toolOutput = `${"aliased externalized output\n".repeat(160)}done`;
    const replayedMessage = {
      role: "toolResult",
      toolName: "exec",
      content: [
        {
          type: "toolResult",
          toolCallId: "call_externalized_alias",
          name: "exec",
          output: toolOutput,
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(1);
    expect(
      (await engine.getSummaryStore().getLargeFilesByConversation(conversation!.conversationId)),
    ).toHaveLength(1);
  });

  it("deduplicates large string tool-call replay rows after content rewrite", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-large-string-tool-replay-session";
    const toolOutput = `${"large string tool output\n".repeat(160)}done`;
    const replayedMessage = {
      role: "tool",
      content: toolOutput,
      toolCallId: "call_large_string_replay",
      toolName: "exec",
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toContain("[LCM Tool Output: file_");
    expect(
      (await engine.getSummaryStore().getLargeFilesByConversation(conversation!.conversationId)),
    ).toHaveLength(1);
  });

  it("keeps externalized tool rows when metadata changes but output matches", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-externalized-metadata-change-session";
    const toolOutput = `${"metadata change large output\n".repeat(160)}done`;
    const firstMessage = {
      role: "tool",
      content: toolOutput,
      toolCallId: "call_externalized_metadata",
      toolName: "exec",
      isError: false,
      timestamp: Date.now(),
    } as AgentMessage;
    const changedMessage = {
      ...firstMessage,
      isError: true,
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("keeps externalized tool rows when tool name changes but output matches", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-externalized-tool-name-change-session";
    const toolOutput = `${"tool name change large output\n".repeat(160)}done`;
    const firstMessage = {
      role: "tool",
      content: toolOutput,
      toolCallId: "call_externalized_tool_name",
      toolName: "exec",
      timestamp: Date.now(),
    } as AgentMessage;
    const changedMessage = {
      ...firstMessage,
      toolName: "shell",
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("keeps large string tool-call replay rows when the stored sidecar is unreadable", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-missing-sidecar-replay-session";
    const toolOutput = `${"missing sidecar tool output\n".repeat(160)}done`;
    const replayedMessage = {
      role: "tool",
      content: toolOutput,
      toolCallId: "call_missing_sidecar_replay",
      toolName: "exec",
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const [largeFile] = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation!.conversationId);
    expect(largeFile).toBeDefined();
    rmSync(largeFile!.storageUri);

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("deduplicates multi-part large tool-result replay rows after content rewrite", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-multi-large-tool-replay-session";
    const firstOutput = `${"first large tool output\n".repeat(160)}done`;
    const secondOutput = `${"second large tool output\n".repeat(160)}done`;
    const replayedMessage = {
      role: "toolResult",
      toolName: "exec",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_multi_large_a",
          name: "exec",
          content: [{ type: "text", text: firstOutput }],
        },
        {
          type: "tool_result",
          tool_use_id: "call_multi_large_b",
          name: "exec",
          content: [{ type: "text", text: secondOutput }],
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(1);
    expect(
      (await engine.getSummaryStore().getLargeFilesByConversation(conversation!.conversationId)),
    ).toHaveLength(2);
  });

  it("keeps externalized tool rows when call ids swap between parts", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-swapped-externalized-ids-session";
    const firstOutput = `${"swapped first output\n".repeat(160)}done`;
    const secondOutput = `${"swapped second output\n".repeat(160)}done`;
    const firstMessage = {
      role: "toolResult",
      toolName: "exec",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_swap_a",
          name: "exec",
          content: [{ type: "text", text: firstOutput }],
        },
        {
          type: "tool_result",
          tool_use_id: "call_swap_b",
          name: "exec",
          content: [{ type: "text", text: secondOutput }],
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;
    const swappedMessage = {
      ...firstMessage,
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_swap_b",
          name: "exec",
          content: [{ type: "text", text: firstOutput }],
        },
        {
          type: "tool_result",
          tool_use_id: "call_swap_a",
          name: "exec",
          content: [{ type: "text", text: secondOutput }],
        },
      ],
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const swapped = await engine.ingestBatch({
      sessionId,
      messages: [swappedMessage],
    });
    expect(swapped.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("deduplicates mixed inline and externalized tool-result replay rows", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-mixed-large-inline-tool-replay-session";
    const largeOutput = `${"mixed large tool output\n".repeat(160)}done`;
    const replayedMessage = {
      role: "toolResult",
      toolName: "exec",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_mixed_large",
          name: "exec",
          content: [{ type: "text", text: largeOutput }],
        },
        {
          type: "tool_result",
          tool_use_id: "call_mixed_inline",
          name: "exec",
          output: "small inline output",
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replay = await engine.ingestBatch({
      sessionId,
      messages: [replayedMessage],
    });
    expect(replay.ingestedCount).toBe(0);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(1);
    expect(
      (await engine.getSummaryStore().getLargeFilesByConversation(conversation!.conversationId)),
    ).toHaveLength(1);
  });

  it("keeps mixed externalized tool rows when an untagged part changes", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-externalized-untagged-change-session";
    const largeOutput = `${"externalized with note output\n".repeat(160)}done`;
    const firstMessage = {
      role: "toolResult",
      toolName: "exec",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_externalized_note",
          name: "exec",
          content: [{ type: "text", text: largeOutput }],
        },
        { type: "text", text: "old note" },
      ],
      timestamp: Date.now(),
    } as AgentMessage;
    const changedMessage = {
      ...firstMessage,
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_externalized_note",
          name: "exec",
          content: [{ type: "text", text: largeOutput }],
        },
        { type: "text", text: "new note" },
      ],
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("keeps duplicate-id externalized tool rows when one occurrence changes", async () => {
    const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
    const sessionId = "batch-ingest-duplicate-id-externalized-session";
    const firstOutput = `${"duplicate id first output\n".repeat(160)}done`;
    const secondOutput = `${"duplicate id second output\n".repeat(160)}done`;
    const changedFirstOutput = `${"changed duplicate id first output\n".repeat(160)}done`;
    const firstMessage = {
      role: "toolResult",
      toolName: "exec",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_duplicate_large",
          name: "exec",
          content: [{ type: "text", text: firstOutput }],
        },
        {
          type: "tool_result",
          tool_use_id: "call_duplicate_large",
          name: "exec",
          content: [{ type: "text", text: secondOutput }],
        },
      ],
      timestamp: Date.now(),
    } as AgentMessage;
    const changedMessage = {
      ...firstMessage,
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_duplicate_large",
          name: "exec",
          content: [{ type: "text", text: changedFirstOutput }],
        },
        {
          type: "tool_result",
          tool_use_id: "call_duplicate_large",
          name: "exec",
          content: [{ type: "text", text: secondOutput }],
        },
      ],
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [firstMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
  });

  it("keeps multi-part replay batches with only partial raw-id overlap", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-partial-raw-overlap-session";
    const existingMessage = makeMessage({
      role: "tool",
      content: [{ type: "tool_result", tool_use_id: "raw-part-existing", output: "old output" }],
    });
    const partiallyOverlappingMessage = makeMessage({
      role: "tool",
      content: [
        { type: "tool_result", tool_use_id: "raw-part-existing", output: "old output" },
        { type: "tool_result", tool_use_id: "raw-part-new", output: "new output" },
      ],
    });

    const first = await engine.ingestBatch({
      sessionId,
      messages: [existingMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replayWithNewPart = await engine.ingestBatch({
      sessionId,
      messages: [partiallyOverlappingMessage],
    });
    expect(replayWithNewPart.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
    const newParts = await engine.getConversationStore().getMessageParts(stored[1]!.messageId);
    expect(newParts.map((part) => part.toolCallId)).toEqual([
      "raw-part-existing",
      "raw-part-new",
    ]);
  });

  it("keeps partial raw-id overlap when one stored id matches multiple parts", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-duplicate-row-coverage-session";
    const existingMessage = {
      role: "assistant",
      toolCallId: "raw-repeated-top-level",
      content: [
        { type: "text", text: "existing part one" },
        { type: "text", text: "existing part two" },
      ],
      timestamp: Date.now(),
    } as AgentMessage;
    const partiallyOverlappingMessage = {
      role: "assistant",
      toolCallId: "raw-repeated-top-level",
      content: [
        { type: "text", text: "new part one" },
        { type: "text", id: "raw-distinct-new-part", text: "new part two" },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [existingMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const replayWithNewPart = await engine.ingestBatch({
      sessionId,
      messages: [partiallyOverlappingMessage],
    });
    expect(replayWithNewPart.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
    const newParts = await engine.getConversationStore().getMessageParts(stored[1]!.messageId);
    expect(newParts.map((part) => part.textContent)).toEqual([
      "new part one",
      "new part two",
    ]);
  });

  it("keeps changed untagged parts that share a top-level replay id", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-top-level-id-changed-content-session";
    const existingMessage = {
      role: "assistant",
      toolCallId: "raw-untagged-top-level",
      content: [
        { type: "text", text: "old part one" },
        { type: "text", text: "old part two" },
      ],
      timestamp: Date.now(),
    } as AgentMessage;
    const changedMessage = {
      role: "assistant",
      toolCallId: "raw-untagged-top-level",
      content: [
        { type: "text", text: "old part one" },
        { type: "text", text: "new untagged part" },
      ],
      timestamp: Date.now(),
    } as AgentMessage;

    const first = await engine.ingestBatch({
      sessionId,
      messages: [existingMessage],
    });
    expect(first.ingestedCount).toBe(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const changed = await engine.ingestBatch({
      sessionId,
      messages: [changedMessage],
    });
    expect(changed.ingestedCount).toBe(1);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old part one\nold part two",
      "old part one\nnew untagged part",
    ]);
  });

  it("deduplicates raw-id replay prefix while keeping new ingestBatch tail", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-replay-tail-session";
    const oldMessages: AgentMessage[] = [
      makeMessage({
        role: "user",
        content: [{ type: "text", id: "raw-tail-user-a", text: "checkpoint replay old user" }],
      }),
      makeMessage({
        role: "assistant",
        content: [{ type: "text", id: "raw-tail-assistant-b", text: "checkpoint replay old assistant" }],
      }),
    ];

    const first = await engine.ingestBatch({
      sessionId,
      messages: oldMessages,
    });
    expect(first.ingestedCount).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(
          `UPDATE messages SET created_at = datetime('now', '-10 seconds') WHERE conversation_id = ?`,
        )
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const replayWithTail = await engine.ingestBatch({
      sessionId,
      messages: [
        ...oldMessages,
        makeMessage({
          role: "user",
          content: [{ type: "text", id: "raw-tail-user-c", text: "checkpoint replay new user" }],
        }),
        makeMessage({
          role: "assistant",
          content: [{ type: "text", id: "raw-tail-assistant-d", text: "checkpoint replay new assistant" }],
        }),
      ],
    });
    expect(replayWithTail.ingestedCount).toBe(2);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "checkpoint replay old user",
      "checkpoint replay old assistant",
      "checkpoint replay new user",
      "checkpoint replay new assistant",
    ]);
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(4);
  });

  it("skips heartbeat turn batches in ingestBatch", async () => {
    const engine = createEngine();
    const sessionId = "batch-ingest-heartbeat-session";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "keep this turn" }),
    });

    const heartbeatBatch: AgentMessage[] = [
      makeMessage({ role: "user", content: "heartbeat poll: pending" }),
      makeMessage({ role: "assistant", content: "worker snapshot: large payload" }),
    ];

    const result = await engine.ingestBatch({
      sessionId,
      messages: heartbeatBatch,
      isHeartbeat: true,
    });

    expect(result.ingestedCount).toBe(0);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      1,
    );
    expect(
      (await engine.getSummaryStore().getContextItems(conversation!.conversationId)).length,
    ).toBe(1);

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const assembledText = assembled.messages
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    expect(assembledText).toContain("keep this turn");
    expect(assembledText).not.toContain("heartbeat poll");
    expect(assembledText).not.toContain("worker snapshot");
  });

  it("afterTurn ingests auto-compaction summary and new turn messages", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-ingest";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-ingest"),
      messages: [
        makeMessage({ role: "user", content: "already present before prompt" }),
        makeMessage({ role: "assistant", content: "new assistant reply" }),
      ],
      prePromptMessageCount: 1,
      autoCompactionSummary: "[summary] compacted older history",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[summary] compacted older history",
      "new assistant reply",
    ]);
  });

  it("afterTurn keeps auto-compaction summary that matches stored text", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-same-as-stored";

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "S" }),
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-same-as-stored"),
      messages: [
        makeMessage({ role: "assistant", content: "fresh assistant reply" }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: "S",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "S",
      "S",
      "fresh assistant reply",
    ]);
  });

  it("afterTurn deduplicates replayed history before prepending auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-replay";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-replay-seed"),
      messages: [
        makeMessage({ role: "user", content: "old question" }),
        makeMessage({ role: "assistant", content: "old answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-replay"),
      messages: [
        makeMessage({ role: "system", content: "system prompt" }),
        makeMessage({ role: "user", content: "old question" }),
        makeMessage({ role: "assistant", content: "old answer" }),
        makeMessage({ role: "user", content: "new question" }),
        makeMessage({ role: "assistant", content: "new answer" }),
      ],
      prePromptMessageCount: 1,
      autoCompactionSummary: "[summary] compacted older history",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old question",
      "old answer",
      "[summary] compacted older history",
      "new question",
      "new answer",
    ]);
  });

  it("afterTurn skips new-message content already covered by auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-overlap";
    const repeatedInstruction =
      "kick off workers to review all of these pull requests and report back";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-overlap"),
      messages: [
        makeMessage({ role: "user", content: repeatedInstruction }),
        makeMessage({ role: "assistant", content: "Workers are running now." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: `Summary of compacted context: the user said "${repeatedInstruction}" and the assistant began coordinating the work.`,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      `Summary of compacted context: the user said "${repeatedInstruction}" and the assistant began coordinating the work.`,
      "Workers are running now.",
    ]);
  });

  it("afterTurn does not drop short messages just because they appear in auto-compaction summary", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-summary-short-overlap";

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-short-overlap"),
      messages: [
        makeMessage({ role: "user", content: "yes" }),
        makeMessage({ role: "assistant", content: "Proceeding." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: "Summary: the user previously said yes to the plan.",
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "Summary: the user previously said yes to the plan.",
      "yes",
      "Proceeding.",
    ]);
  });

  it("afterTurn keeps a 24+ char user message that only collides as a substring of the summary narrative (F6)", async () => {
    // PR-6 #566 / F6: bare summary.includes(content) was too loose. A medium-
    // length user instruction that coincidentally appears inside a long
    // narrative summary must NOT be silently dropped — only anchored or
    // quoted matches count as covered.
    const engine = createEngine();
    const sessionId = "after-turn-summary-substring-collision";
    const collidingInstruction = "please update the readme file"; // 30 chars
    const summary =
      "Summary of compacted context: the assistant was asked to please " +
      "update the readme file with new sections, then verify CI passes " +
      "and report back to the operator before EOD.";
    expect(summary.toLowerCase()).toContain(collidingInstruction);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-substring-collision"),
      messages: [
        makeMessage({ role: "user", content: collidingInstruction }),
        makeMessage({ role: "assistant", content: "Acknowledged." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: summary,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    // The user instruction must survive: it's only a coincidental substring,
    // not anchored or quoted.
    expect(stored.map((message) => message.content)).toEqual([
      summary,
      collidingInstruction,
      "Acknowledged.",
    ]);
  });

  it("afterTurn drops a user message when the summary ends with that exact content (F6 anchored)", async () => {
    // Anchored truth case: content appears at the end of the summary's
    // normalized text — that's a real coverage signal, drop the dup.
    const engine = createEngine();
    const sessionId = "after-turn-summary-suffix-anchored";
    const repeatedInstruction = "kick off the workers and check back in an hour";
    const summary = `Summary of compacted context. ${repeatedInstruction}`;

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-summary-suffix-anchored"),
      messages: [
        makeMessage({ role: "user", content: repeatedInstruction }),
        makeMessage({ role: "assistant", content: "On it." }),
      ],
      prePromptMessageCount: 0,
      autoCompactionSummary: summary,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([summary, "On it."]);
  });

  it("afterTurn runs inline threshold compaction only after context threshold is crossed", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compact";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const leafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger");
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
      result: {
        tokensBefore: 3_500,
        tokensAfter: 2_000,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-inline-threshold-compact"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(leafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
  });

  it("afterTurn runs inline threshold compaction when projected raw backlog crosses threshold", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
      freshTailCount: 1,
    });
    const sessionId = "after-turn-inline-projected-raw-backlog-threshold";
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-inline-projected-raw-backlog-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 600,
      runtimeContext: { currentTokenCount: 300 },
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 600,
        currentTokenCount: 300,
        compactionTarget: "threshold",
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    await expect(
      engine.getSummaryStore().getContextTokenCount(conversation!.conversationId),
    ).resolves.toBeLessThan(450);
  });

  it("afterTurn records deferred threshold debt when projected raw backlog crosses threshold", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      { freshTailCount: 1 },
      {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: debugLog },
      },
    );
    const sessionId = "after-turn-deferred-projected-raw-backlog-threshold";
    const privateEngine = engine as unknown as {
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    await seedBacklogContext(engine, sessionId, [100, 100, 100]);
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-projected-raw-backlog-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 600,
      runtimeContext: { currentTokenCount: 300 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 600,
        currentTokenCount: 300,
        reason: "threshold",
      }),
    );
    expect(maintenance).toMatchObject({
      pending: true,
      running: false,
      reason: "threshold",
      tokenBudget: 600,
      currentTokenCount: 300,
      projectedTokenCount: expect.any(Number),
      rawTokensOutsideTail: expect.any(Number),
    });
    await expect(
      engine.getSummaryStore().getContextTokenCount(conversation!.conversationId),
    ).resolves.toBeLessThan(450);
    const deferredDebtLog = debugLog.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("deferred compaction debt recorded"));
    expect(deferredDebtLog).toContain("projectedTokenCount=");
    expect(deferredDebtLog).not.toContain("projectedTokenCount=null");
    expect(deferredDebtLog).toContain("rawTokensOutsideTail=");
    expect(deferredDebtLog).not.toContain("rawTokensOutsideTail=null");
  });

  it("afterTurn ignores raw leaf pressure below the context threshold", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-below-threshold-ignores-leaf-pressure";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };

    const leafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger");
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 20_000,
      threshold: 96_000,
    });
    const scheduleSpy = vi.spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain");
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-below-threshold-ignores-leaf-pressure"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: { currentTokenCount: 20_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(leafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending ?? false).toBe(false);
  });

  it("afterTurn resolves tokenBudget from runtimeContext and forwards it as legacyParams", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-runtime-context";
    const runtimeContext = {
      provider: "anthropic",
      model: "claude-opus-4-5",
      tokenBudget: 2048,
      currentTokenCount: 1800,
    };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 1800,
      threshold: 1536,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-context"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      runtimeContext,
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 2048,
        currentTokenCount: 1800,
        legacyParams: runtimeContext,
        compactionTarget: "threshold",
      }),
    );
  });

  it("afterTurn keeps the bootstrap checkpoint stale and records retry debt when inline threshold compaction fails", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compaction-failure";
    const sessionFile = createSessionFilePath("after-turn-inline-threshold-compaction-failure");
    writeFileSync(sessionFile, "0123456789\n");

    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const sessionFileStats = statSync(sessionFile);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 1,
      lastSeenMtimeMs: Math.trunc(sessionFileStats.mtimeMs),
      lastProcessedOffset: 1,
      lastProcessedEntryHash: null,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider auth failure",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    const bootstrapState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation.conversationId);
    expect(bootstrapState).not.toBeNull();
    expect(bootstrapState?.lastSeenSize).toBe(1);
    expect(bootstrapState?.lastProcessedOffset).toBe(1);

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("threshold");
    expect(maintenance?.tokenBudget).toBe(4_096);
    expect(compactSpy).toHaveBeenCalled();
  });

  it("afterTurn waits for inline threshold compaction before completing", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-inline-threshold-compaction-queue-order";
    const sessionFile = createSessionFilePath("after-turn-inline-threshold-compaction-queue-order");
    writeFileSync(sessionFile, "0123456789\n");

    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const sessionFileStats = statSync(sessionFile);
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: sessionFile,
      lastSeenSize: 1,
      lastSeenMtimeMs: Math.trunc(sessionFileStats.mtimeMs),
      lastProcessedOffset: 1,
      lastProcessedEntryHash: null,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });

    let releaseCompaction!: () => void;
    let notifyCompactionStarted!: () => void;
    const compactionStarted = new Promise<void>((resolve) => {
      notifyCompactionStarted = resolve;
    });
    const compactionGate = new Promise<void>((resolve) => {
      releaseCompaction = resolve;
    });

    vi.spyOn(engine, "compact").mockImplementation(async () => {
      notifyCompactionStarted();
      await compactionGate;
      return {
        ok: false,
        compacted: false,
        reason: "provider auth failure",
      };
    });

    const afterTurnPromise = engine.afterTurn({
      sessionId,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    await compactionStarted;

    let afterTurnResolved = false;
    afterTurnPromise.then(() => {
      afterTurnResolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(afterTurnResolved).toBe(false);

    releaseCompaction();

    await afterTurnPromise;
    expect(afterTurnResolved).toBe(true);

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
  });

  it("afterTurn falls back to the default token budget when no budget is provided", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {
        proactiveThresholdCompactionMode: "inline",
      },
      {
        log: {
          info: vi.fn(),
          warn: warnLog,
          error: vi.fn(),
          debug: vi.fn(),
        },
      },
    );
    const sessionId = "after-turn-default-token-budget";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 100_000,
      threshold: 96_000,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-default-token-budget"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      runtimeContext: { currentTokenCount: 100_000 },
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 128_000,
        compactionTarget: "threshold",
      }),
    );
    expect(warnLog).toHaveBeenCalledWith(
      "[lcm] afterTurn: tokenBudget not provided; using default 128000",
    );
  });

  it("afterTurn falls back to legacyCompactionParams when runtimeContext is missing", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-legacy-compaction-params";
    const legacyCompactionParams = { provider: "anthropic", model: "claude-opus-4-5" };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-legacy-compaction-params"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      legacyCompactionParams,
      currentTokenCount: 3_500,
    });

    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        legacyParams: legacyCompactionParams,
      }),
    );
  });

  it("afterTurn prefers runtimeContext when both runtimeContext and legacyCompactionParams are set", async () => {
    const engine = createEngineWithConfig({
      proactiveThresholdCompactionMode: "inline",
    });
    const sessionId = "after-turn-runtime-context-priority";
    const runtimeContext = { provider: "anthropic", model: "claude-opus-4-5", source: "rt" };
    const legacyCompactionParams = {
      provider: "anthropic",
      model: "claude-opus-4-5",
      source: "legacy",
    };
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-context-priority"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      runtimeContext,
      legacyCompactionParams,
    });

    expect((compactSpy.mock.calls[0]?.[0] as { legacyParams?: unknown }).legacyParams).toBe(
      runtimeContext,
    );
  });

  it("afterTurn prefers runtimeContext.currentTokenCount for compaction decisions", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-runtime-current-token-count";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-current-token-count"),
      messages: [makeMessage({ role: "assistant", content: "tiny" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: {
        provider: "openai",
        model: "gpt-5.4",
        currentTokenCount: 500,
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 4_096, 500);
  });

  it("afterTurn falls back to local message token estimates when runtimeContext.currentTokenCount is absent", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-local-current-token-count-fallback";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 1,
      threshold: 3_072,
    });

    const turnMessage = makeMessage({ role: "assistant", content: "tiny" });
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-local-current-token-count-fallback"),
      messages: [turnMessage],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: {
        provider: "openai",
        model: "gpt-5.4",
      },
    });

    // Local estimates use full-message serialization so structured payloads count.
    expect(evaluateSpy).toHaveBeenCalledWith(
      expect.any(Number),
      4_096,
      estimateSerializedMessageTokens(turnMessage),
    );
  });

  it("afterTurn records deferred threshold debt instead of compacting inline by default", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    const sessionId = "after-turn-deferred-compaction-debt";
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-deferred-compaction-debt"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(compactSpy).not.toHaveBeenCalled();
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reason: "threshold",
        tokenBudget: 4_096,
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.reason).toBe("threshold");
    expect(maintenance?.requestedAt).toBeInstanceOf(Date);
  });

  it("afterTurn evaluates threshold compaction when ingestBatch is empty", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-empty-ingest-still-evaluates-compaction";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      deduplicateAfterTurnBatch: (
        sessionId: string,
        sessionKey: string | undefined,
        messages: AgentMessage[],
        opts: unknown,
      ) => Promise<AgentMessage[]>;
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed message" }),
    });
    vi.spyOn(privateEngine, "deduplicateAfterTurnBatch").mockResolvedValue([]);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 200_000,
      threshold: 180_000,
    });
    vi.spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain").mockImplementation(() => undefined);
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-empty-ingest-still-evaluates-compaction"),
      messages: [
        makeMessage({ role: "user", content: "already-stored user message" }),
        makeMessage({ role: "assistant", content: "already-stored assistant reply" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 258_000,
      runtimeContext: { currentTokenCount: 200_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("afterTurn skips compaction work when ingestBatch is empty AND conversation is below threshold", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-empty-ingest-below-threshold-noop";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      deduplicateAfterTurnBatch: (
        sessionId: string,
        sessionKey: string | undefined,
        messages: AgentMessage[],
        opts: unknown,
      ) => Promise<AgentMessage[]>;
    };

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "seed message" }),
    });
    vi.spyOn(privateEngine, "deduplicateAfterTurnBatch").mockResolvedValue([]);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 30_000,
      threshold: 180_000,
    });
    const compactSpy = vi.spyOn(engine, "compact");

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-empty-ingest-below-threshold-noop"),
      messages: [makeMessage({ role: "assistant", content: "already-stored" })],
      prePromptMessageCount: 0,
      tokenBudget: 258_000,
      runtimeContext: { currentTokenCount: 30_000 },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending ?? false).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
  });

  it("afterTurn schedules a deferred threshold drain even when compactionTelemetry has no provider/model", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-no-cache-context-threshold";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const scheduleSpy = vi
      .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
      .mockImplementation(() => undefined);

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-no-cache-context-threshold"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    expect(scheduleSpy).toHaveBeenCalledTimes(1);
    expect(scheduleSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        reason: "threshold",
        tokenBudget: 4_096,
      }),
    );
    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.reason).toBe("threshold");
  });

  it("afterTurn caps the transcript-reconcile slow path to one full re-read per session+file (F7)", async () => {
    // PR-6 #566 / F7: PR #551 added reconcileTranscriptTailForAfterTurn but
    // its slow path called readLeafPathMessages on the entire session file
    // every afterTurn when the checkpoint was missing or path-mismatched.
    // After PR-6: the slow path runs once per (session-key|id, sessionFile),
    // refreshes the checkpoint, and subsequent afterTurns take the
    // incremental path or the cap branch.
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: infoLog, warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-reconcile-slow-path-cap";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    // Seed conversation by ingesting one turn through afterTurn first, with
    // a DIFFERENT sessionFile so the next call has a path-mismatched
    // checkpoint and is forced into the slow path.
    const seedSessionFile = createSessionFilePath("after-turn-reconcile-slow-path-seed");
    writeLeafTranscript(seedSessionFile, [{ role: "assistant", content: "seed turn" }]);
    await engine.afterTurn({
      sessionId,
      sessionFile: seedSessionFile,
      messages: [makeMessage({ role: "assistant", content: "seed turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Spy on the (module-scoped) full reader by spying on the slow-path
    // log, since readLeafPathMessages is a free function. The slow-path warn
    // is the canonical signal that the full re-read happened.
    warnLog.mockClear();
    debugLog.mockClear();

    // First call with a different sessionFile triggers the slow path.
    // Pre-populate the target sessionFile with at least one historical
    // overlapping message so readLeafPathMessages returns a successful
    // same-frontier full read and the slow-path cap can be remembered.
    const targetSessionFile = createSessionFilePath("after-turn-reconcile-slow-path-target");
    writeLeafTranscript(targetSessionFile, [{ role: "assistant", content: "seed turn" }]);
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn one" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const slowPathWarns = warnLog.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("transcript reconcile slow path"));
    expect(slowPathWarns.length).toBe(1);

    // Second call against the SAME (sessionId, sessionFile) tuple must NOT
    // re-enter the slow path. After the first slow-path read we refresh the
    // checkpoint, so this normally goes through the fast (incremental) path
    // and emits no slow-path warn. If somehow the slow path is reached again
    // (e.g. checkpoint not append-only-eligible), the cap log fires instead
    // of a second full re-read.
    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn two" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const secondSlowPathWarns = warnLog.mock.calls
      .map((c) => String(c[0]))
      .filter((m) => m.includes("transcript reconcile slow path (full re-read)"));
    expect(secondSlowPathWarns.length).toBe(0);
  });

  it("afterTurn treats missing tracked transcripts as a cheap degraded path without full reread", async () => {
    const warnLog = vi.fn();
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: debugLog },
      },
    );
    const sessionId = "after-turn-missing-transcript-cheap-skip";
    const sessionKey = "agent:main:test:missing-transcript-cheap-skip";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey,
    });
    const bulkMessages = await engine.getConversationStore().createMessagesBulk(
      Array.from({ length: 120 }, (_, index) => ({
        conversationId: conversation.conversationId,
        seq: index,
        role: index % 2 === 0 ? "user" : "assistant",
        content: `persisted historical message ${index}`,
        tokenCount: 5,
        skipReplayTimestampFloodGuard: true,
      })),
    );
    await engine
      .getSummaryStore()
      .appendContextMessages(
        conversation.conversationId,
        bulkMessages.map((message) => message.messageId),
      );
    const missingSessionFile = createSessionFilePath("after-turn-missing-transcript-cheap-skip");
    await engine.getSummaryStore().upsertConversationBootstrapState({
      conversationId: conversation.conversationId,
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastSeenMtimeMs: 1_700_000_000_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: missingSessionFile,
      messages: [
        makeMessage({ role: "assistant", content: "persisted historical message 119" }),
        makeMessage({ role: "user", content: "live user after missing transcript" }),
        makeMessage({ role: "assistant", content: "live assistant after missing transcript" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation.conversationId);
    expect(stored.slice(-2).map((message) => message.content)).toEqual([
      "live user after missing transcript",
      "live assistant after missing transcript",
    ]);
    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation.conversationId);
    expect(checkpoint).toMatchObject({
      sessionFilePath: missingSessionFile,
      lastSeenSize: 24_000,
      lastProcessedOffset: 24_000,
      lastProcessedEntryHash: "checkpoint-hash",
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("session file missing; skipping transcript reconcile full reread")),
    ).toBe(true);
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toBe(false);
  });

  it("seeds placeholder bootstrap_state when afterTurn stat-fail fallback runs (#649 follow-up)", async () => {
    // #649 added a permissive stat-fail fallback in the slow path that
    // returns hasOverlap:true to allow live afterTurn ingest even when the
    // transcript cannot be stat-ed. It assumed the afterTurn-tail
    // refreshAfterTurnBootstrapState hook would persist the checkpoint, but
    // that hook delegates to refreshBootstrapState, which itself stat()s and
    // throws on failure; the catch then logs a warn and leaves
    // conversation_bootstrap_state NULL. Every subsequent afterTurn then
    // re-enters the slow path with reason="checkpoint-missing" (excluded
    // from allowNoAnchorImport), the slow path returns hasOverlap:false +
    // 0 imports, and the outer transcriptReconcileUnsafeToAdvance guard
    // skips the ingest batch. The conversation gets stuck in a
    // transparent-passthrough state where assemble() falls back to
    // params.messages and compaction never runs (LCM effectively becomes a
    // no-op for that conversation).
    //
    // Observed in production: a long-running session got stuck in this
    // state for ~11 hours before auto-healing when the host runtime
    // rewrote the JSONL small enough to flip the slow-path reason to
    // `same-path-shrink`, which IS in the allowNoAnchorImport whitelist.
    //
    // Fix: seed a placeholder bootstrap_state row directly (no stat call)
    // anchored to the current sessionFile with `lastProcessedOffset=0`.
    // On the next afterTurn whose stat() succeeds, the placeholder recovery
    // path re-walks from offset=0 but reconciles against the DB frontier so
    // already-ingested live afterTurn messages are not duplicated.
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-stat-fail-checkpoint-seed";
    const sessionKey = "agent:main:test:after-turn-stat-fail-checkpoint-seed";

    // Prime a conversation row WITHOUT a bootstrap_state row by ingesting
    // one message directly. This matches the production incident shape
    // (one message already in the DB but the very first afterTurn
    // slow-path hit stat() failure and never persisted a bootstrap_state
    // row).
    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({ role: "user", content: "primer" }),
    });
    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const preState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(preState).toBeNull();

    // First turn: transcript file does not exist yet. stat() will throw
    // ENOENT, readLeafPathMessages() will return []. This must NOT leave
    // the conversation in checkpoint-missing deadlock state.
    const sessionFile = createSessionFilePath("after-turn-stat-fail-checkpoint-seed");
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "first user turn" }),
        makeMessage({ role: "assistant", content: "first assistant turn" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Placeholder checkpoint must exist pointing at the current sessionFile
    // with offset=0 so the next turn can recover from the beginning.
    const seededState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(seededState).not.toBeNull();
    expect(seededState?.sessionFilePath).toBe(sessionFile);
    expect(seededState?.lastProcessedOffset).toBe(0);
    expect(seededState?.lastSeenSize).toBe(0);

    const statFailWarn = warnLog.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes("could not stat/read transcript"));
    expect(statFailWarn).toBeDefined();
    expect(statFailWarn).toContain("seeding placeholder bootstrap_state at offset=0");

    // Second turn: transcript now exists with real content. Placeholder
    // recovery should read from offset=0 but only ingest messages after the
    // already-stored frontier.
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "first user turn" },
      { role: "assistant", content: "first assistant turn" },
      { role: "user", content: "second user turn" },
      { role: "assistant", content: "second assistant turn" },
    ]);
    warnLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "second assistant turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Without the checkpoint seed, ingestion stays at 0 messages forever.
    // With placeholder recovery, only genuinely missing transcript messages
    // are imported; the first turn was already persisted by the live
    // afterTurn batch and must not be replayed from offset=0.
    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    const contents = messages.map((m) => m.content);
    expect(contents).toContain("first user turn");
    expect(contents).toContain("first assistant turn");
    expect(contents).toContain("second user turn");
    expect(contents).toContain("second assistant turn");
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(conversation!.conversationId, "user", "first user turn"),
    ).resolves.toBe(1);
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(
          conversation!.conversationId,
          "assistant",
          "first assistant turn",
        ),
    ).resolves.toBe(1);
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(conversation!.conversationId, "user", "second user turn"),
    ).resolves.toBe(1);
    await expect(
      engine
        .getConversationStore()
        .countMessagesByIdentity(
          conversation!.conversationId,
          "assistant",
          "second assistant turn",
        ),
    ).resolves.toBe(1);

    // After successful ingest, checkpoint should be advanced past offset=0
    // (via the fast-path refreshBootstrapState call).
    const advancedState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(advancedState).not.toBeNull();
    expect(advancedState?.lastProcessedOffset).toBeGreaterThan(0);
  });

  it("afterTurn recovers a checkpoint-missing conversation with a non-anchoring frontier instead of looping forever (#837)", async () => {
    // #837: a conversation with bootstrapped_at set but NO
    // conversation_bootstrap_state row classifies as reason="checkpoint-missing"
    // on the afterTurn slow path. Unlike the rotate lane, afterTurn used to call
    // reconcileSessionTail WITHOUT allowNoAnchorImportOnCheckpointMissing, so a
    // DB frontier of only non-anchoring rows (e.g. an injected metadata
    // preamble) imported 0 messages and never persisted a checkpoint. Net
    // effect: every turn emitted "found no anchor and imported 0 messages" +
    // "did not cover the transcript frontier" forever, compaction never ran, and
    // the conversation was a permanent LCM no-op until manually archived.
    //
    // This is the sibling of the #649 follow-up above: there the transcript
    // could not be stat/read (ENOENT) and the placeholder-seed escape hatch
    // fired; here the transcript EXISTS with real content, so stat/read succeeds
    // and the only escape is to let afterTurn import the no-anchor epoch the same
    // way the rotate lane already does.
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-checkpoint-missing-no-anchor-recovery";
    const sessionKey = "agent:main:test:checkpoint-missing-no-anchor-recovery";

    // Build the exact production shape: a single non-anchoring DB frontier row
    // (the injected metadata preamble), bootstrapped_at set, and NO
    // bootstrap_state row.
    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({
        role: "user",
        content: "Conversation info (untrusted metadata): injected preamble",
      }),
    });
    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    await engine
      .getConversationStore()
      .markConversationBootstrapped(conversation!.conversationId);

    const refreshed = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(refreshed?.bootstrappedAt).toBeTruthy();
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();

    // A real, growing transcript whose messages do NOT anchor to the lone
    // injected preamble row in the DB.
    const sessionFile = createSessionFilePath("after-turn-checkpoint-missing-no-anchor");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "CRABPOT_837_FACT is amber-beacon-7." },
      { role: "assistant", content: "noted the fact" },
      { role: "user", content: "follow-up question" },
      { role: "assistant", content: "follow-up answer" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "follow-up question" }),
        makeMessage({ role: "assistant", content: "follow-up answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    // Recovery, not deadlock: the transcript history is imported and a
    // bootstrap_state checkpoint is persisted so future turns advance.
    const recoveredState = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(recoveredState).not.toBeNull();
    expect(recoveredState?.sessionFilePath).toBe(sessionFile);
    expect(recoveredState?.lastProcessedOffset).toBeGreaterThan(0);

    const contents = (
      await engine.getConversationStore().getMessages(conversation!.conversationId)
    ).map((m) => m.content);
    expect(contents).toContain("CRABPOT_837_FACT is amber-beacon-7.");
    expect(contents).toContain("follow-up answer");

    // The forever-loop warning pair must NOT have fired.
    const warns = warnLog.mock.calls.map((c) => String(c[0]));
    expect(
      warns.some((m) => m.includes("did not cover the transcript frontier")),
    ).toBe(false);
    expect(
      warns.some((m) =>
        m.includes("found no anchor and imported 0 messages; skipping checkpoint refresh"),
      ),
    ).toBe(false);

    // A second ordinary turn must keep advancing on the fast path (no relapse
    // into the checkpoint-missing slow-path loop).
    warnLog.mockClear();
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "CRABPOT_837_FACT is amber-beacon-7." },
      { role: "assistant", content: "noted the fact" },
      { role: "user", content: "follow-up question" },
      { role: "assistant", content: "follow-up answer" },
      { role: "user", content: "third turn user" },
      { role: "assistant", content: "third turn assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "third turn assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    const secondWarns = warnLog.mock.calls.map((c) => String(c[0]));
    expect(
      secondWarns.some((m) => m.includes("did not cover the transcript frontier")),
    ).toBe(false);
    const finalContents = (
      await engine.getConversationStore().getMessages(conversation!.conversationId)
    ).map((m) => m.content);
    expect(finalContents).toContain("third turn assistant");
  });

  it("afterTurn does not recover checkpoint-missing delivery-only transcript traffic", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-checkpoint-missing-delivery-only";
    const sessionKey = "agent:main:signal:checkpoint-missing-delivery-only";

    await engine.ingest({
      sessionId,
      sessionKey,
      message: makeMessage({
        role: "user",
        content: "Conversation info (untrusted metadata): injected preamble",
      }),
    });
    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    await engine
      .getConversationStore()
      .markConversationBootstrapped(conversation!.conversationId);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();

    const sessionFile = createSessionFilePath("after-turn-checkpoint-missing-delivery-only");
    writeLeafTranscript(sessionFile, [
      { role: "system", content: "delivery-mirror config-audit: refreshed host policy" },
      { role: "system", content: "config-audit delivery-mirror: no user turn" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "assistant", content: "assistant delta without foreground user" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("delivery-only path-mismatched transcript")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "Conversation info (untrusted metadata): injected preamble",
    ]);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();
  });

  it("afterTurn does not recover checkpoint-missing transcript traffic from another runtime session", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const firstSessionId = "after-turn-checkpoint-missing-rollover-old-runtime";
    const secondSessionId = "after-turn-checkpoint-missing-rollover-new-runtime";
    const sessionKey = "agent:main:test:checkpoint-missing-runtime-rollover";

    const oldSessionFile = createSessionFilePath("after-turn-checkpoint-missing-rollover-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old checkpoint-missing rollover question" },
      { role: "assistant", content: "old checkpoint-missing rollover answer" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation?.bootstrappedAt).toBeTruthy();

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    const newSessionFile = createSessionFilePath("after-turn-checkpoint-missing-rollover-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new unrelated checkpoint-missing runtime question" },
      { role: "assistant", content: "new unrelated checkpoint-missing runtime answer" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({
          role: "assistant",
          content: "new unrelated checkpoint-missing runtime answer",
        }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("did not cover the transcript frontier")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old checkpoint-missing rollover question",
      "old checkpoint-missing rollover answer",
    ]);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();
    await expect(
      engine.getConversationStore().getConversationBySessionId(secondSessionId),
    ).resolves.toBeNull();
  });

  it("afterTurn does not recover checkpoint-missing divergent transcript over real history", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-checkpoint-missing-real-history";
    const sessionKey = "agent:main:test:checkpoint-missing-real-history";

    const oldSessionFile = createSessionFilePath("after-turn-checkpoint-missing-real-history-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old checkpoint-missing real-history question" },
      { role: "assistant", content: "old checkpoint-missing real-history answer" },
    ]);
    await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation?.bootstrappedAt).toBeTruthy();

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "rewritten unrelated checkpoint-missing question" },
      { role: "assistant", content: "rewritten unrelated checkpoint-missing answer" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({
          role: "assistant",
          content: "rewritten unrelated checkpoint-missing answer",
        }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("did not cover the transcript frontier")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old checkpoint-missing real-history question",
      "old checkpoint-missing real-history answer",
    ]);
    expect(
      await engine.getSummaryStore().getConversationBootstrapState(conversation!.conversationId),
    ).toBeNull();
  });

  it("bootstrap imports a bounded path-mismatched transcript with no old anchor as a new epoch", async () => {
    const engine = createEngine();
    const sessionId = "bootstrap-transcript-epoch-no-anchor";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const oldSessionFile = createSessionFilePath("bootstrap-transcript-epoch-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old runtime question" },
      { role: "assistant", content: "old runtime answer" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old runtime question" }),
        makeMessage({ role: "assistant", content: "old runtime answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const newSessionFile = createSessionFilePath("bootstrap-transcript-epoch-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "current codex user report" },
      { role: "assistant", content: "current codex assistant reply" },
    ]);

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);
    expect(result.reason).toBe("reconciled missing session messages");

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old runtime question",
      "old runtime answer",
      "current codex user report",
      "current codex assistant reply",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.sessionFilePath).toBe(newSessionFile);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(newSessionFile).size);
  });

  it("bootstrap preserves a long-lived checkpoint when a rotated transcript is only delivery audit traffic", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "bootstrap-delivery-only-path-mismatch";
    const sessionKey = "agent:main:signal:direct:delivery-only";

    const oldSessionFile = createSessionFilePath("bootstrap-delivery-only-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "long-lived DM question" },
      { role: "assistant", content: "long-lived DM answer" },
    ]);
    await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("bootstrap-delivery-only-new");
    writeLeafTranscript(newSessionFile, [
      { role: "system", content: "delivery-mirror config-audit: refreshed host policy" },
      { role: "system", content: "config-audit delivery-mirror: no user turn" },
    ]);

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
    });

    expect(result).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "already bootstrapped",
    });
    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("delivery-only path-mismatched transcript")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "long-lived DM question",
      "long-lived DM answer",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint).toEqual(oldCheckpoint);
  });

  it("bootstrap imports real path-mismatched user turns that mention config audit", async () => {
    const engine = createEngine();
    const sessionId = "bootstrap-real-config-audit-path-mismatch";
    const sessionKey = "agent:main:test:direct:real-config-audit";

    const oldSessionFile = createSessionFilePath("bootstrap-real-config-audit-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old config-audit setup question" },
      { role: "assistant", content: "old config-audit setup answer" },
    ]);
    await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const newSessionFile = createSessionFilePath("bootstrap-real-config-audit-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "please run a config audit for this deployment" },
      { role: "assistant", content: "config audit result: deployment policy is current" },
    ]);

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
    });

    expect(result).toEqual({
      bootstrapped: true,
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old config-audit setup question",
      "old config-audit setup answer",
      "please run a config audit for this deployment",
      "config audit result: deployment policy is current",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.sessionFilePath).toBe(newSessionFile);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(newSessionFile).size);
  });

  it("bootstrap fails closed on ambiguous runtime rollover while the old transcript still exists", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const firstSessionId = "bootstrap-ambiguous-rollover-old-runtime";
    const secondSessionId = "bootstrap-ambiguous-rollover-new-runtime";
    const sessionKey = "agent:main:test:ambiguous-runtime-rollover";

    const oldSessionFile = createSessionFilePath("bootstrap-ambiguous-rollover-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old long-lived question" },
      { role: "assistant", content: "Done" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("bootstrap-ambiguous-rollover-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new unrelated first turn" },
      { role: "assistant", content: "Done" },
    ]);

    const result = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
    });

    expect(result).toEqual({
      bootstrapped: false,
      importedMessages: 0,
      reason: "ambiguous session-key runtime rollover",
    });
    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("ambiguous session-key runtime rollover")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old long-lived question",
      "Done",
    ]);
    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint).toEqual(oldCheckpoint);
    const active = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(active?.conversationId).toBe(conversation!.conversationId);
    expect(active?.sessionId).toBe(firstSessionId);
    await expect(
      engine.getConversationStore().getConversationBySessionId(secondSessionId),
    ).resolves.toBeNull();
  });

  it("isolates cron runs that reuse a stable sessionKey while preserving prior runs", async () => {
    const engine = createEngine();
    const firstSessionId = "cron-isolated-stable-key-run-1";
    const secondSessionId = "cron-isolated-stable-key-run-2";
    const sessionKey = "agent:main:cron:nightly:run:run-123";

    const oldSessionFile = createSessionFilePath("cron-isolated-stable-key-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "prior cron input should stay archived" },
      { role: "assistant", content: "prior cron output should not leak" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const priorConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(priorConversation).not.toBeNull();

    const newSessionFile = createSessionFilePath("cron-isolated-stable-key-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "current cron input" },
      { role: "assistant", content: "current cron output" },
    ]);

    const result = await engine.bootstrap({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
    });

    expect(result).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(priorConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);

    const archivedPrior = await engine.getConversationStore().getConversation(
      priorConversation!.conversationId,
    );
    expect(archivedPrior?.active).toBe(false);
    const priorMessages = await engine.getConversationStore().getMessages(
      priorConversation!.conversationId,
    );
    expect(priorMessages.map((message) => message.content)).toEqual([
      "prior cron input should stay archived",
      "prior cron output should not leak",
    ]);

    const activeMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(activeMessages.map((message) => message.content)).toEqual([
      "current cron input",
      "current cron output",
    ]);

    const assembled = await engine.assemble({
      sessionId: secondSessionId,
      sessionKey,
      messages: [makeMessage({ role: "user", content: "current live cron prompt" })],
      tokenBudget: 4_096,
    });
    const assembledText = assembled.messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    expect(assembledText).toContain("current cron input");
    expect(assembledText).not.toContain("prior cron input should stay archived");
    expect(assembledText).not.toContain("prior cron output should not leak");
  });

  it("isolates cron sessionKey rollover during afterTurn transcript reconcile", async () => {
    const engine = createEngine();
    const firstSessionId = "cron-after-turn-isolated-run-1";
    const secondSessionId = "cron-after-turn-isolated-run-2";
    const sessionKey = "agent:main:cron:nightly:run:after-turn-123";

    const oldSessionFile = createSessionFilePath("cron-after-turn-isolated-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "prior afterTurn cron input should stay archived" },
      { role: "assistant", content: "prior afterTurn cron output should not leak" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const priorConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(priorConversation).not.toBeNull();

    const newSessionFile = createSessionFilePath("cron-after-turn-isolated-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "current afterTurn cron input" },
      { role: "assistant", content: "current afterTurn cron output" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "current afterTurn cron output" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const archivedPrior = await engine.getConversationStore().getConversation(
      priorConversation!.conversationId,
    );
    expect(archivedPrior?.active).toBe(false);

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(priorConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);

    const activeMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(activeMessages.map((message) => message.content)).toEqual([
      "current afterTurn cron input",
      "current afterTurn cron output",
    ]);

    const assembled = await engine.assemble({
      sessionId: secondSessionId,
      sessionKey,
      messages: [makeMessage({ role: "user", content: "current live afterTurn cron prompt" })],
      tokenBudget: 4_096,
    });
    const assembledText = assembled.messages
      .map((message) =>
        typeof message.content === "string" ? message.content : JSON.stringify(message.content),
      )
      .join("\n");
    expect(assembledText).toContain("current afterTurn cron input");
    expect(assembledText).not.toContain("prior afterTurn cron input should stay archived");
    expect(assembledText).not.toContain("prior afterTurn cron output should not leak");
  });

  it("afterTurn fails closed on ambiguous runtime rollover while the old transcript still exists", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    const evaluateLeafTriggerSpy = vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "above threshold",
      currentTokens: 10_000,
      threshold: 3_072,
      projectedTokens: 10_000,
      rawTokensOutsideTail: 6_000,
    });
    const firstSessionId = "after-turn-ambiguous-rollover-old-runtime";
    const secondSessionId = "after-turn-ambiguous-rollover-new-runtime";
    const sessionKey = "agent:main:test:after-turn-ambiguous-runtime-rollover";

    const oldSessionFile = createSessionFilePath("after-turn-ambiguous-rollover-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old afterTurn long-lived question" },
      { role: "assistant", content: "Done" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("after-turn-ambiguous-rollover-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new afterTurn unrelated first turn" },
      { role: "assistant", content: "Done" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "Done" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("ambiguous session-key runtime rollover")),
    ).toBe(true);
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old afterTurn long-lived question",
      "Done",
    ]);
    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint).toEqual(oldCheckpoint);
    const activeByKey = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeByKey?.conversationId).toBe(conversation!.conversationId);
    expect(activeByKey?.sessionId).toBe(firstSessionId);
    await expect(
      engine.getConversationStore().getConversationBySessionId(secondSessionId),
    ).resolves.toBeNull();
    await expect(
      engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation!.conversationId),
    ).resolves.toBeNull();
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(evaluateSpy).not.toHaveBeenCalled();
  });

  it("assemble falls back to live messages on ambiguous runtime rollover while the old transcript still exists", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const firstSessionId = "assemble-ambiguous-rollover-old-runtime";
    const secondSessionId = "assemble-ambiguous-rollover-new-runtime";
    const sessionKey = "agent:main:test:assemble-ambiguous-runtime-rollover";

    const oldSessionFile = createSessionFilePath("assemble-ambiguous-rollover-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "what model produced the stale answer?" },
      { role: "assistant", content: "openai-codex/gpt-5.5" },
    ]);
    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    const liveMessages = [makeMessage({ role: "user", content: "new live user prompt" })];
    const assembled = await engine.assemble({
      sessionId: secondSessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget: 4_096,
    });

    expect(assembled.messages).toEqual(liveMessages);
    expect(
      assembled.messages.some((message) => message.content === "openai-codex/gpt-5.5"),
    ).toBe(false);
    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("ambiguous session-key runtime rollover")),
    ).toBe(true);
    const activeByKey = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeByKey?.conversationId).toBe(originalConversation!.conversationId);
    expect(activeByKey?.sessionId).toBe(firstSessionId);
    await expect(
      engine.getConversationStore().getConversationBySessionId(secondSessionId),
    ).resolves.toBeNull();
  });

  it("afterTurn reconciles a path-mismatched no-anchor transcript before oversized delta dedup", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-transcript-epoch-no-anchor";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    } as unknown as Record<string, unknown>);
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-transcript-epoch-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old turn user 1" },
      { role: "assistant", content: "old turn assistant 1" },
      { role: "user", content: "old turn user 2" },
      { role: "assistant", content: "old turn assistant 2" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old turn user 1" }),
        makeMessage({ role: "assistant", content: "old turn assistant 1" }),
        makeMessage({ role: "user", content: "old turn user 2" }),
        makeMessage({ role: "assistant", content: "old turn assistant 2" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const newSessionFile = createSessionFilePath("after-turn-transcript-epoch-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new codex user prompt" },
      { role: "assistant", content: "new codex assistant delta" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new codex assistant delta" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old turn user 1",
      "old turn assistant 1",
      "old turn user 2",
      "old turn assistant 2",
      "new codex user prompt",
      "new codex assistant delta",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.sessionFilePath).toBe(newSessionFile);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(newSessionFile).size);
  });

  it("afterTurn preserves continuity when a path-mismatched transcript is only delivery audit traffic", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-delivery-only-path-mismatch";
    const sessionKey = "agent:main:signal:direct:after-turn-delivery-only";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-delivery-only-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "long-lived afterTurn DM question" },
      { role: "assistant", content: "long-lived afterTurn DM answer" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "long-lived afterTurn DM question" }),
        makeMessage({ role: "assistant", content: "long-lived afterTurn DM answer" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("after-turn-delivery-only-new");
    writeLeafTranscript(newSessionFile, [
      { role: "system", content: "delivery-mirror config-audit: refreshed host policy" },
      { role: "system", content: "config-audit delivery-mirror: no user turn" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "assistant delta without foreground user" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((call) => String(call[0]))
        .some((message) => message.includes("delivery-only path-mismatched transcript")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "long-lived afterTurn DM question",
      "long-lived afterTurn DM answer",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint).toEqual(oldCheckpoint);
  });

  it("afterTurn archives a stale active conversation when the prior keyed transcript was pruned", async () => {
    const engine = createEngine();
    const firstSessionId = "after-turn-missed-reset-fallback-1";
    const secondSessionId = "after-turn-missed-reset-fallback-2";
    const sessionKey = "agent:main:test:after-turn-missed-reset-fallback";
    const oldSessionFile = createSessionFilePath("after-turn-missed-reset-fallback-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old turn user" },
      { role: "assistant", content: "openai-codex/gpt-5.5" },
    ]);

    const first = await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });
    expect(first).toEqual({
      bootstrapped: true,
      importedMessages: 2,
    });

    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    rmSync(oldSessionFile, { force: true });

    const newSessionFile = createSessionFilePath("after-turn-missed-reset-fallback-new");
    writeLeafTranscript(newSessionFile, [
      { role: "user", content: "new turn user" },
      { role: "assistant", content: "new turn assistant" },
    ]);

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new turn assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).not.toBeNull();
    expect(activeConversation!.conversationId).not.toBe(originalConversation!.conversationId);
    expect(activeConversation!.sessionId).toBe(secondSessionId);
    expect(activeConversation!.active).toBe(true);

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const activeMessages = await engine.getConversationStore().getMessages(
      activeConversation!.conversationId,
    );
    expect(activeMessages.map((message) => message.content)).toEqual([
      "new turn user",
      "new turn assistant",
    ]);
  });

  it("afterTurn skips assistant-only rollover when the replacement transcript is unreadable", async () => {
    const engine = createEngine();
    const firstSessionId = "after-turn-missed-reset-unreadable-1";
    const secondSessionId = "after-turn-missed-reset-unreadable-2";
    const sessionKey = "agent:main:test:after-turn-missed-reset-unreadable";
    const oldSessionFile = createSessionFilePath("after-turn-missed-reset-unreadable-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old unreadable user" },
      { role: "assistant", content: "old unreadable assistant" },
    ]);

    await engine.bootstrap({
      sessionId: firstSessionId,
      sessionKey,
      sessionFile: oldSessionFile,
    });
    const originalConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: firstSessionId,
      sessionKey,
    });
    expect(originalConversation).not.toBeNull();

    rmSync(oldSessionFile, { force: true });
    const unreadableSessionFile = createSessionFilePath("after-turn-missed-reset-unreadable-new");
    writeFileSync(unreadableSessionFile, '{"message":', "utf8");

    await engine.afterTurn({
      sessionId: secondSessionId,
      sessionKey,
      sessionFile: unreadableSessionFile,
      messages: [makeMessage({ role: "assistant", content: "new unreadable assistant delta" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const archivedConversation = await engine.getConversationStore().getConversation(
      originalConversation!.conversationId,
    );
    expect(archivedConversation?.active).toBe(false);
    expect(archivedConversation?.archivedAt).not.toBeNull();

    const activeConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: secondSessionId,
      sessionKey,
    });
    expect(activeConversation).toBeNull();
  });

  it("afterTurn bounds initial transcript imports to the bootstrap budget", async () => {
    const engine = createEngineWithConfig({ bootstrapMaxTokens: 120 });
    const sessionId = "after-turn-initial-transcript-budget";
    const sessionKey = "agent:main:test:after-turn-initial-transcript-budget";
    const sessionFile = createSessionFilePath("after-turn-initial-transcript-budget");
    const transcriptMessages = Array.from({ length: 60 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: `initial afterTurn bulk transcript ${index} ${"x".repeat(200)}`,
    })) as Array<{ role: AgentMessage["role"]; content: string }>;
    writeLeafTranscript(sessionFile, transcriptMessages);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({
          role: "assistant",
          content: transcriptMessages[transcriptMessages.length - 1]!.content,
        }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.length).toBeLessThan(10);
    expect(stored.map((message) => message.content)).toContain(
      transcriptMessages[transcriptMessages.length - 1]!.content,
    );
  });

  it("afterTurn skips persistence when full reread finds no anchor and imports nothing", async () => {
    const engine = createEngineWithDeps({}, {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const sessionId = "after-turn-no-anchor-no-import";
    const sessionKey = "agent:main:test:direct:no-anchor-no-import";

    const privateEngine = engine as unknown as {
      config: LcmConfig;
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-no-anchor-no-import");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old no-anchor user" },
      { role: "assistant", content: "old no-anchor assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old no-anchor user" }),
        makeMessage({ role: "assistant", content: "old no-anchor assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    const rawDb = createLcmDatabaseConnection(privateEngine.config.databasePath);
    try {
      rawDb
        .prepare(`DELETE FROM conversation_bootstrap_state WHERE conversation_id = ?`)
        .run(conversation!.conversationId);
    } finally {
      closeLcmConnection(rawDb);
    }

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "rewritten missing prefix user" },
      { role: "assistant", content: "rewritten missing prefix assistant" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "live no-anchor user" }),
        makeMessage({ role: "assistant", content: "live no-anchor assistant" }),
        makeMessage({ role: "user", content: "live no-anchor follow-up" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const checkpointAfterNoImport = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterNoImport).toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old no-anchor user",
      "old no-anchor assistant",
    ]);
  });

  it("afterTurn imports a bounded same-path transcript epoch after the file shrinks", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-same-path-shrink";
    const sessionKey = "agent:main:test:direct:same-path-shrink";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old shrink user" },
      { role: "assistant", content: "old shrink assistant" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old shrink user" }),
        makeMessage({ role: "assistant", content: "old shrink assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(sessionFile);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "missed shrink prefix user" },
      { role: "assistant", content: "missed shrink prefix assistant" },
      { role: "user", content: "live shrink user" },
      { role: "assistant", content: "live shrink assistant" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);
    const shrinkStats = statSync(sessionFile);
    (
      engine as unknown as {
        afterTurnReconcileFullReadStates: Map<string, { size: number; mtimeMs: number }>;
      }
    ).afterTurnReconcileFullReadStates.set(`${sessionKey}\u0000${sessionFile}`, {
      size: shrinkStats.size,
      mtimeMs: Math.trunc(shrinkStats.mtimeMs),
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "live shrink user" }),
        makeMessage({ role: "assistant", content: "live shrink assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("same-path-shrink")),
    ).toBe(true);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old shrink user",
      "old shrink assistant",
      "missed shrink prefix user",
      "missed shrink prefix assistant",
      "live shrink user",
      "live shrink assistant",
    ]);

    const newCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(newCheckpoint?.sessionFilePath).toBe(sessionFile);
    expect(newCheckpoint?.lastProcessedOffset).toBe(statSync(sessionFile).size);
  });

  it("afterTurn imports the full bounded same-path shrink epoch instead of trusting a stale externalized frontier", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-same-path-shrink-externalized";
    const sessionKey = "agent:main:test:direct:same-path-shrink-externalized";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink-externalized");
    const rawFrontier = "afterTurn externalized raw shrink frontier";
    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: rawFrontier })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const firstStored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(firstStored).toHaveLength(1);

    const rawDb = createLcmDatabaseConnection(getEngineConfig(engine).databasePath);
    try {
      rawDb
        .prepare(`UPDATE messages SET content = ?, token_count = ? WHERE message_id = ?`)
        .run(
          "[LCM afterTurn externalized payload reference]",
          estimateTokens("[LCM afterTurn externalized payload reference]"),
          firstStored[0].messageId,
        );
    } finally {
      closeLcmConnection(rawDb);
    }

    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.lastProcessedEntryHash).toMatch(/^[a-f0-9]{64}$/);

    writeLeafTranscript(sessionFile, [
      { role: "assistant", content: rawFrontier },
      { role: "user", content: "afterTurn tail after externalized shrink" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: "afterTurn tail after externalized shrink" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[LCM afterTurn externalized payload reference]",
      rawFrontier,
      "afterTurn tail after externalized shrink",
    ]);
  });

  it("afterTurn imports a full same-path shrink epoch when new content repeats an old frontier message", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-same-path-shrink-duplicate-frontier";
    const sessionKey = "agent:main:test:direct:same-path-shrink-duplicate-frontier";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const sessionFile = createSessionFilePath("after-turn-same-path-shrink-duplicate-frontier");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "old afterTurn duplicate frontier user" },
      { role: "assistant", content: "OK" },
    ]);
    appendFileSync(
      sessionFile,
      `${JSON.stringify({ type: "custom", payload: "x".repeat(20_000) })}\n`,
      "utf8",
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [
        makeMessage({ role: "user", content: "old afterTurn duplicate frontier user" }),
        makeMessage({ role: "assistant", content: "OK" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);

    writeLeafTranscript(sessionFile, [
      { role: "user", content: "new afterTurn duplicate frontier user" },
      { role: "assistant", content: "OK" },
      { role: "user", content: "new afterTurn duplicate frontier tail" },
    ]);
    expect(oldCheckpoint!.lastProcessedOffset).toBeGreaterThan(statSync(sessionFile).size);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "user", content: "new afterTurn duplicate frontier tail" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old afterTurn duplicate frontier user",
      "OK",
      "new afterTurn duplicate frontier user",
      "OK",
      "new afterTurn duplicate frontier tail",
    ]);
  });

  it("afterTurn keeps the old checkpoint when a path-mismatched no-anchor import is capped", async () => {
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      { proactiveThresholdCompactionMode: "inline" },
      {
        log: { info: vi.fn(), warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-transcript-epoch-no-anchor-capped";
    const sessionKey = "agent:main:test:direct:transcript-epoch";

    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    const oldSessionFile = createSessionFilePath("after-turn-transcript-epoch-capped-old");
    writeLeafTranscript(oldSessionFile, [
      { role: "user", content: "old capped user" },
      { role: "assistant", content: "old capped assistant" },
    ]);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: oldSessionFile,
      messages: [
        makeMessage({ role: "user", content: "old capped user" }),
        makeMessage({ role: "assistant", content: "old capped assistant" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const oldCheckpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(oldCheckpoint?.sessionFilePath).toBe(oldSessionFile);

    const newSessionFile = createSessionFilePath("after-turn-transcript-epoch-capped-new");
    writeLeafTranscript(
      newSessionFile,
      Array.from({ length: 60 }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `oversized no-anchor epoch ${index}`,
      })),
    );

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({ role: "user", content: "live after capped epoch user" }),
        makeMessage({ role: "assistant", content: "live after capped epoch assistant" }),
        makeMessage({ role: "user", content: "live after capped epoch follow-up" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("no anchor import cap exceeded")),
    ).toBe(true);

    const checkpointAfterCap = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterCap).toEqual(oldCheckpoint);

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "old capped user",
      "old capped assistant",
    ]);

    appendFileSync(
      newSessionFile,
      `${JSON.stringify({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "live after capped epoch assistant" }],
        },
      })}\n${JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "second live after capped epoch user" }],
        },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: newSessionFile,
      messages: [
        makeMessage({ role: "assistant", content: "live after capped epoch assistant" }),
        makeMessage({ role: "user", content: "second live after capped epoch user" }),
      ],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("no anchor import cap exceeded")),
    ).toBe(true);
    const checkpointAfterRetry = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpointAfterRetry).toEqual(oldCheckpoint);

    const storedAfterRetry = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(storedAfterRetry.map((message) => message.content)).toEqual([
      "old capped user",
      "old capped assistant",
    ]);
  });

  it("afterTurn retries a capped reconcile when the transcript file changed with an append-only-ineligible suffix (F7)", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const warnLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: { info: infoLog, warn: warnLog, error: vi.fn(), debug: vi.fn() },
      },
    );
    const sessionId = "after-turn-reconcile-cap-retries-on-file-change";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 0,
      threshold: 3_072,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-reconcile-cap-retry-seed"),
      messages: [makeMessage({ role: "assistant", content: "seed turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    const targetSessionFile = createSessionFilePath("after-turn-reconcile-cap-retry-target");
    writeFileSync(
      targetSessionFile,
      `${JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "seed turn" }] },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "next turn one" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toHaveLength(1);

    appendFileSync(
      targetSessionFile,
      `not-json\n${JSON.stringify({
        message: {
          role: "user",
          content: [{ type: "text", text: "append-only-ineligible user" }],
        },
      })}\n`,
      "utf8",
    );

    warnLog.mockClear();
    debugLog.mockClear();
    await engine.afterTurn({
      sessionId,
      sessionFile: targetSessionFile,
      messages: [makeMessage({ role: "assistant", content: "append-only-ineligible assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
    });

    expect(
      infoLog.mock.calls
        .map((c) => String(c[0]))
        .some((m) => m.includes("transcript reconcile slow path skipped")),
    ).toBe(false);
    expect(
      warnLog.mock.calls
        .map((c) => String(c[0]))
        .filter((m) => m.includes("transcript reconcile slow path (full re-read)")),
    ).toHaveLength(1);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed turn",
      "next turn one",
      "append-only-ineligible user",
      "append-only-ineligible assistant",
    ]);

    const checkpoint = await engine
      .getSummaryStore()
      .getConversationBootstrapState(conversation!.conversationId);
    expect(checkpoint?.lastProcessedOffset).toBe(statSync(targetSessionFile).size);
  });

  it("afterTurn drains deferred threshold debt in the background without cache telemetry", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-background-threshold-drain";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-background-threshold-drain"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext: { currentTokenCount: 3_500 },
    });

    await vi.waitFor(() => {
      expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
          compactionTarget: "threshold",
        }),
      );
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation!.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
  });

  it("afterTurn drains threshold debt even when cache telemetry stays hot", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-hot-cache-threshold-drain";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionTelemetryStore().upsertConversationCompactionTelemetry({
      conversationId: conversation.conversationId,
      cacheState: "hot",
      consecutiveColdObservations: 0,
      retention: "long",
      lastObservedCacheHitAt: new Date("2026-05-31T12:00:00.000Z"),
      lastObservedCacheRead: 123_000,
      lastObservedPromptTokenCount: 189_666,
    });

    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 189_666,
      threshold: 102_400,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-hot-cache-threshold-drain"),
      messages: [makeMessage({ role: "assistant", content: "fresh hot-cache turn" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: {
        currentTokenCount: 189_666,
        provider: "openai-codex",
        model: "gpt-5.5",
        promptCache: {
          retention: "long",
          lastCallUsage: {
            input: 66_666,
            cacheRead: 123_000,
            cacheWrite: 0,
          },
          observation: {
            broke: false,
          },
        },
      },
    });

    await vi.waitFor(() => {
      expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: conversation.conversationId,
          sessionId,
          tokenBudget: 128_000,
          currentTokenCount: 189_666,
          compactionTarget: "threshold",
          legacyParams: {
            provider: "openai-codex",
            model: "gpt-5.5",
          },
        }),
      );
    });

    const telemetry = await engine
      .getCompactionTelemetryStore()
      .getConversationCompactionTelemetry(conversation.conversationId);
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(telemetry?.cacheState).toBe("hot");
    expect(telemetry?.consecutiveColdObservations).toBe(0);
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
  });

  it("background deferred drain leaves threshold debt durable when the session is busy", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-background-busy-threshold-debt";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      drainDeferredCompactionDebtIfIdle: (params: unknown) => Promise<void>;
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const executeCompactionCoreSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    await privateEngine.drainDeferredCompactionDebtIfIdle({
      conversationId: conversation.conversationId,
      sessionId,
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
      reason: "threshold",
      queueKey: sessionId,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);

    releaseQueue();
    await heldQueue;
  });

  it("maintain() leaves deferred threshold debt pending until the host opts in", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-disabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });

    const compactSpy = vi.spyOn(engine, "compact");
    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-disabled-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: false,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance).not.toBeNull();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(compactSpy).not.toHaveBeenCalled();
    expect(maintenanceResult.changed).toBe(false);
  });

  it("maintain() consumes deferred threshold debt when the host opts in", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-enabled";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-enabled-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(true);
  });

  it("maintain() clears stale legacy non-threshold debt when threshold no longer applies", async () => {
    const engine = createEngine();
    const sessionId = "maintain-legacy-leaf-debt-cleared";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "leaf-trigger",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "below threshold",
      currentTokens: 1_024,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    const maintenanceResult = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-legacy-leaf-debt-cleared"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 1_024,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(evaluateSpy).toHaveBeenCalledWith(conversation.conversationId, 4_096, 1_024);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(maintenanceResult.changed).toBe(false);
    expect(maintenanceResult.reason).toBe("legacy deferred compaction no longer needed");
  });

  it("maintain() revalidates legacy non-threshold debt as threshold work when still over threshold", async () => {
    const engine = createEngine();
    const sessionId = "maintain-legacy-leaf-debt-threshold-revalidated";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "cold-cache-catchup",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number, observed?: number) => Promise<unknown>;
      };
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 3_500,
      threshold: 3_072,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-legacy-leaf-debt-threshold-revalidated"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
        compactionTarget: "threshold",
      }),
    );
  });

  it("maintain() keeps threshold debt pending when compaction fails", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-auth-failure";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine, "executeCompactionCore").mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider auth failure",
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-auth-failure-maintain"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.retryAttempts).toBe(0);
    expect(maintenance?.nextAttemptAfter).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("provider auth failure");
  });

  it("maintain() keeps threshold debt pending when the auth circuit breaker is open", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-compaction-circuit-open";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    vi.spyOn(privateEngine, "executeCompactionCore").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "circuit breaker open",
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-circuit-open"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("summary provider circuit breaker is open");
    expect(maintenance?.retryAttempts).toBe(0);
    expect(maintenance?.nextAttemptAfter).toBeNull();
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("circuit breaker open");
  });

  it("maintain() backs off deferred threshold debt after non-auth compaction failures", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:00:00.000Z"));
    try {
      const engine = createEngine();
      const sessionId = "maintain-deferred-compaction-provider-timeout-backoff";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      });
      const privateEngine = engine as unknown as {
        executeCompactionCore: (params: unknown) => Promise<unknown>;
      };
      const executeSpy = vi.spyOn(privateEngine, "executeCompactionCore");
      executeSpy.mockResolvedValueOnce({
        ok: false,
        compacted: false,
        reason: "provider timeout",
      });
      executeSpy.mockResolvedValueOnce({
        ok: true,
        compacted: true,
        reason: "compacted",
      });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-provider-timeout-backoff"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(first.changed).toBe(false);
      expect(first.reason).toBe("provider timeout");
      expect(executeSpy).toHaveBeenCalledTimes(1);

      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-provider-timeout-backoff-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(executeSpy).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(5 * 60 * 1000 + 1);
      const third = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-provider-timeout-after-backoff"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(third.changed).toBe(true);
      expect(third.reason).toBe("compacted");
      expect(executeSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintain() keeps threshold debt pending when a no-action sweep stops at budget", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-no-action-budget-stop";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };
    vi.spyOn(privateEngine.compaction, "compactFullSweep").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 3_500,
      tokensAfter: 3_500,
      condensed: false,
      stoppedAtBudget: true,
    });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-no-action-budget-stop"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("live context still exceeds target");
    expect(maintenance?.retryAttempts).toBe(1);
    expect(maintenance?.nextAttemptAfter).toBeInstanceOf(Date);
    expect(result.changed).toBe(false);
    expect(result.reason).toBe("live context still exceeds target");
  });

  it("maintain() keeps threshold debt pending when partial compaction remains over target", async () => {
    const engine = createEngine();
    const sessionId = "maintain-deferred-partial-still-over-threshold";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const privateEngine = engine as unknown as {
      compaction: {
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 3_500,
        tokensAfter: 3_200,
        condensed: false,
      });

    const result = await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-partial-still-over-threshold"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      },
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        tokenBudget: 4_096,
        force: true,
        hardTrigger: false,
        stopAtTokens: 1,
      }),
    );
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(maintenance?.lastFailureSummary).toBe("compacted but still over target");
    expect(result.changed).toBe(true);
    expect(result.reason).toBe("compacted but still over target");
  });

  it("maintain() backs off after partial deferred compaction still exceeds target", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:10:00.000Z"));
    try {
      const engine = createEngine();
      const sessionId = "maintain-deferred-partial-still-over-backoff";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      });
      const privateEngine = engine as unknown as {
        compaction: {
          compactFullSweep: (input: unknown) => Promise<unknown>;
        };
      };
      const compactFullSweepSpy = vi
        .spyOn(privateEngine.compaction, "compactFullSweep")
        .mockResolvedValue({
          actionTaken: true,
          tokensBefore: 3_500,
          tokensAfter: 3_200,
          condensed: false,
        });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-partial-over-backoff"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(first.changed).toBe(true);
      expect(first.reason).toBe("compacted but still over target");
      // The sweep chain retries once after the first partial round and stops
      // when the second round shows no further reduction.
      expect(compactFullSweepSpy).toHaveBeenCalledTimes(2);

      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-deferred-partial-over-backoff-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(compactFullSweepSpy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintain() stops model-backed deferred compaction at the summary call cap", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:20:00.000Z"));
    try {
      const complete = vi.fn(async () => ({
        content: [{ type: "text", text: "short summary" }],
      }));
      const engine = createEngineWithDeps(
        {
          summaryProvider: "anthropic",
          summaryModel: "claude-opus-4-5",
          summaryMaxCallsPerWindow: 1,
          summaryCallWindowMs: 10 * 60 * 1000,
          summarySpendBackoffMs: 20 * 60 * 1000,
        },
        { complete },
      );
      const sessionId = "maintain-summary-spend-call-cap";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 3_500,
      });
      const privateEngine = engine as unknown as {
        compaction: {
          compactFullSweep: (input: {
            summarize: (text: string, aggressive?: boolean) => Promise<string>;
          }) => Promise<unknown>;
        };
      };
      vi.spyOn(privateEngine.compaction, "compactFullSweep").mockImplementation(async (input) => {
        await input.summarize("first chunk ".repeat(200));
        await input.summarize("second chunk ".repeat(200));
        return {
          actionTaken: true,
          tokensBefore: 3_500,
          tokensAfter: 2_000,
          condensed: false,
        };
      });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-summary-spend-call-cap"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(first.changed).toBe(false);
      expect(first.reason).toBe("summary spend backoff open");
      expect(complete).toHaveBeenCalledTimes(1);

      const maintenance = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation.conversationId);
      expect(maintenance?.pending).toBe(true);
      expect(maintenance?.retryAttempts).toBe(1);
      expect(maintenance?.nextAttemptAfter?.toISOString()).toBe("2026-05-31T12:40:00.000Z");

      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-summary-spend-call-cap-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 3_500,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(complete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maintain() bounds provider-fallback recursive sweeps with unlimited depth and repairable lineage", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:30:00.000Z"));
    try {
      const maxSweepIterations = 5;
      const complete = vi.fn(async (params: Parameters<LcmDependencies["complete"]>[0]) => {
        if (params.provider === "anthropic") {
          throw new Error("FallbackError: secondary summarizer unavailable");
        }
        throw new Error("FailoverError: ChatGPT prolite plan, try again in ~61 min");
      });
      const engine = createEngineWithDeps(
        {
          summaryProvider: "openai-codex",
          summaryModel: "gpt-5.3-codex",
          fallbackProviders: [{ provider: "anthropic", model: "claude-sonnet-4-6" }],
          sweepMaxDepth: -1,
          incrementalMaxDepth: -1,
          freshTailCount: 2,
          leafMinFanout: 2,
          condensedMinFanout: 2,
          condensedMinFanoutHard: 2,
          leafChunkTokens: 2_500,
          leafTargetTokens: 600,
          condensedTargetTokens: 900,
          summaryPrefixTargetTokens: 1,
          maxSweepIterations,
          sweepDeadlineMs: 1_000,
          summarySpendBackoffMs: 30 * 60 * 1000,
        },
        {
          complete,
          resolveModel: vi.fn((modelRef?: string, providerHint?: string) => {
            if (providerHint === "anthropic" || modelRef === "anthropic/claude-sonnet-4-6") {
              return { provider: "anthropic", model: "claude-sonnet-4-6" };
            }
            return { provider: "openai-codex", model: "gpt-5.3-codex" };
          }),
        },
      );
      const sessionId = "maintain-provider-fallback-unlimited-depth-repairable";
      const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
        sessionKey: undefined,
      });
      const summaryStore = engine.getSummaryStore();
      await summaryStore.insertSummary({
        summaryId: "sum_provider_fallback_old_1",
        conversationId: conversation.conversationId,
        kind: "condensed",
        depth: 1,
        content: `old provider-stress arc 1 ${"a".repeat(3_600)}`,
        tokenCount: 1_000,
      });
      await summaryStore.insertSummary({
        summaryId: "sum_provider_fallback_old_2",
        conversationId: conversation.conversationId,
        kind: "condensed",
        depth: 1,
        content: `old provider-stress arc 2 ${"b".repeat(3_600)}`,
        tokenCount: 1_000,
      });
      await summaryStore.appendContextSummary(
        conversation.conversationId,
        "sum_provider_fallback_old_1",
      );
      await summaryStore.appendContextSummary(
        conversation.conversationId,
        "sum_provider_fallback_old_2",
      );
      const rawMessages = await engine.getConversationStore().createMessagesBulk(
        Array.from({ length: 6 }, (_, index) => ({
          conversationId: conversation.conversationId,
          seq: index + 1,
          role: index % 2 === 0 ? "user" as const : "assistant" as const,
          content: `provider stress turn ${index} ${"x".repeat(5_000)}`,
          tokenCount: 1_000,
          skipReplayTimestampFloodGuard: true,
        })),
      );
      await summaryStore.appendContextMessages(
        conversation.conversationId,
        rawMessages.map((message) => message.messageId),
      );
      const tokensBefore = await summaryStore.getContextTokenCount(conversation.conversationId);
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation.conversationId,
        reason: "threshold",
        tokenBudget: 4_096,
        currentTokenCount: 9_000,
      });

      const first = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-provider-fallback-unlimited-depth"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 9_000,
        },
      });

      expect(first.changed).toBe(true);
      expect(first.reason).toBe("compacted but still over target");
      expect(complete.mock.calls.length).toBeGreaterThan(0);
      expect(complete.mock.calls.length).toBeLessThanOrEqual(maxSweepIterations * 2);
      const calledProviders = new Set(
        complete.mock.calls.map(([params]) => params.provider ?? ""),
      );
      expect(calledProviders).toEqual(new Set(["openai-codex", "anthropic"]));

      const maintenance = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation.conversationId);
      expect(maintenance?.pending).toBe(true);
      expect(maintenance?.running).toBe(false);
      expect(maintenance?.lastFailureSummary).toBe("compacted but still over target");
      expect(maintenance?.nextAttemptAfter?.toISOString()).toBe("2026-05-31T13:00:00.000Z");

      const afterFirstCallCount = complete.mock.calls.length;
      const second = await engine.maintain({
        sessionId,
        sessionFile: createSessionFilePath("maintain-provider-fallback-unlimited-depth-retry"),
        runtimeContext: {
          allowDeferredCompactionExecution: true,
          tokenBudget: 4_096,
          currentTokenCount: 9_000,
        },
      });
      expect(second.changed).toBe(false);
      expect(second.reason).toBe("deferred compaction backoff active");
      expect(complete).toHaveBeenCalledTimes(afterFirstCallCount);

      const summaries = await summaryStore.getSummariesByConversation(conversation.conversationId);
      const markerSummaries = summaries.filter(
        (summary) => detectDoctorMarker(summary.content) !== null,
      );
      const markerLeaves = markerSummaries.filter((summary) => summary.kind === "leaf");
      const markerCondensed = markerSummaries.filter((summary) => summary.kind === "condensed");
      expect(markerLeaves.length).toBeGreaterThan(0);
      expect(markerCondensed.length).toBeGreaterThan(0);

      const contextItems = await summaryStore.getContextItems(conversation.conversationId);
      expect(contextItems.length).toBeGreaterThan(1);
      expect(contextItems.filter((item) => item.itemType === "message")).toHaveLength(2);
      expect(contextItems.filter((item) => item.itemType === "summary")).not.toHaveLength(1);

      const reachableSummaryIds = new Set<string>();
      const collectReachableSummaryIds = async (summaryId: string): Promise<void> => {
        if (reachableSummaryIds.has(summaryId)) {
          return;
        }
        reachableSummaryIds.add(summaryId);
        for (const parent of await summaryStore.getSummaryParents(summaryId)) {
          await collectReachableSummaryIds(parent.summaryId);
        }
      };
      for (const item of contextItems) {
        if (item.itemType === "summary" && item.summaryId != null) {
          await collectReachableSummaryIds(item.summaryId);
        }
      }
      expect(reachableSummaryIds).toContain("sum_provider_fallback_old_1");
      expect(reachableSummaryIds).toContain("sum_provider_fallback_old_2");

      for (const summary of markerLeaves) {
        expect(await summaryStore.getSummaryMessages(summary.summaryId)).not.toHaveLength(0);
      }
      for (const summary of markerCondensed) {
        expect(await summaryStore.getSummaryParents(summary.summaryId)).not.toHaveLength(0);
      }
      const tokensAfter = await summaryStore.getContextTokenCount(conversation.conversationId);
      expect(Number.isFinite(tokensAfter)).toBe(true);
      expect(tokensAfter).toBeLessThanOrEqual(tokensBefore);

      const privateEngine = engine as unknown as { db: Parameters<typeof applyScopedDoctorRepair>[0]["db"] };
      const repairSummarize = vi.fn(async (
        text: string,
        _aggressive?: boolean,
        options?: Parameters<NonNullable<Parameters<typeof applyScopedDoctorRepair>[0]["summarize"]>>[2],
      ) => {
        if (options?.isCondensed) {
          return `CONDENSED REPAIR\n${text}`;
        }
        return `LEAF REPAIR\n${text}`;
      });
      const repairResult = await applyScopedDoctorRepair({
        db: privateEngine.db,
        config: getEngineConfig(engine),
        conversationId: conversation.conversationId,
        summarize: repairSummarize,
      });
      expect(repairResult.kind).toBe("applied");
      if (repairResult.kind !== "applied") {
        throw new Error(`expected doctor repair to apply: ${repairResult.reason}`);
      }
      expect(repairResult.detected).toBe(markerSummaries.length);
      expect(repairResult.repaired).toBe(markerSummaries.length);
      expect(repairResult.skipped).toEqual([]);
      expect(repairSummarize).toHaveBeenCalledTimes(markerSummaries.length);

      const condensedRepairCalls = repairSummarize.mock.calls.filter(
        ([, , options]) => options?.isCondensed === true,
      );
      expect(
        repairSummarize.mock.calls.some(
          ([text, , options]) =>
            options?.isCondensed !== true &&
            text.includes("provider stress turn 0"),
        ),
      ).toBe(true);
      expect(
        condensedRepairCalls.some(
          ([text]) =>
            text.includes("old provider-stress arc 1") &&
            text.includes("old provider-stress arc 2"),
        ),
      ).toBe(true);

      const repairedSummaries = await summaryStore.getSummariesByConversation(conversation.conversationId);
      expect(repairedSummaries.every((summary) => detectDoctorMarker(summary.content) === null)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("compact() is not blocked by deferred-maintenance retry backoff", async () => {
    const engine = createEngine();
    const sessionId = "manual-compact-ignores-maintenance-backoff";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: "provider timeout",
      keepPending: true,
    });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const executeSpy = vi.spyOn(privateEngine, "executeCompactionCore").mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: createSessionFilePath("manual-compact-ignores-maintenance-backoff"),
      tokenBudget: 4_096,
      force: true,
    });

    expect(result).toMatchObject({
      ok: true,
      compacted: true,
      reason: "compacted",
    });
    expect(executeSpy).toHaveBeenCalledTimes(1);
  });

  it("poor-reduction spend backoff blocks custom summarizers in the same compaction scope", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:35:00.000Z"));
    try {
      const engine = createEngineWithConfig({
        summarySpendBackoffMs: 10 * 60 * 1000,
      });
      const sessionId = "custom-summarizer-poor-reduction-backoff";
      await engine.ingest({
        sessionId,
        message: { role: "user", content: "custom summarize poor reduction" } as AgentMessage,
      });
      const summarize = vi.fn(async () => "custom summary");
      const privateEngine = engine as unknown as {
        compaction: {
          compactUntilUnder: (input: {
            summarize: (text: string, aggressive?: boolean) => Promise<string>;
          }) => Promise<unknown>;
        };
      };
      vi.spyOn(privateEngine.compaction, "compactUntilUnder").mockImplementation(async (input) => {
        await input.summarize("source text for custom summarizer");
        return {
          success: false,
          rounds: 1,
          finalTokens: 3_500,
        };
      });

      const first = await engine.compact({
        sessionId,
        sessionFile: createSessionFilePath("custom-summarizer-poor-reduction-backoff"),
        tokenBudget: 4_096,
        currentTokenCount: 4_096,
        force: true,
        legacyParams: { summarize },
      });
      expect(first.reason).toBe("could not reach target");
      expect(summarize).toHaveBeenCalledTimes(1);

      const second = await engine.compact({
        sessionId,
        sessionFile: createSessionFilePath("custom-summarizer-poor-reduction-backoff-retry"),
        tokenBudget: 4_096,
        currentTokenCount: 4_096,
        force: true,
        legacyParams: { summarize },
      });
      expect(second.reason).toBe("summary spend backoff open");
      expect(summarize).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("afterTurn refreshes threshold debt while retry backoff is active without compacting", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-05-31T12:30:00.000Z"));
    try {
      const engine = createEngineWithConfig({ freshTailCount: 1 });
      const sessionId = "after-turn-records-debt-during-backoff";
      await seedBacklogContext(engine, sessionId, [100, 100, 100]);
      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();
      await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
        conversationId: conversation!.conversationId,
        reason: "threshold",
        tokenBudget: 600,
        currentTokenCount: 300,
      });
      await engine.getCompactionMaintenanceStore().markProactiveCompactionRunning({
        conversationId: conversation!.conversationId,
      });
      await engine.getCompactionMaintenanceStore().markProactiveCompactionFinished({
        conversationId: conversation!.conversationId,
        failureSummary: "provider timeout",
        keepPending: true,
      });
      const before = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation!.conversationId);
      const privateEngine = engine as unknown as {
        scheduleDeferredCompactionDebtDrain: (params: unknown) => void;
      };
      const scheduleSpy = vi
        .spyOn(privateEngine, "scheduleDeferredCompactionDebtDrain")
        .mockImplementation(() => undefined);
      const compactSpy = vi.spyOn(engine, "compact");

      await engine.afterTurn({
        sessionId,
        sessionFile: createSessionFilePath("after-turn-records-debt-during-backoff"),
        messages: [makeMessage({ role: "assistant", content: "fresh projected turn" })],
        prePromptMessageCount: 0,
        tokenBudget: 600,
        runtimeContext: { currentTokenCount: 300 },
      });

      const after = await engine
        .getCompactionMaintenanceStore()
        .getConversationCompactionMaintenance(conversation!.conversationId);
      expect(compactSpy).not.toHaveBeenCalled();
      expect(scheduleSpy).toHaveBeenCalled();
      expect(after?.pending).toBe(true);
      expect(after?.running).toBe(false);
      expect(after?.nextAttemptAfter?.toISOString()).toBe(
        before?.nextAttemptAfter?.toISOString(),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("assemble() leaves pending threshold debt for post-turn maintenance while under budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-left-pending";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() uses bounded live context when pending maintenance is near budget", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-near-budget-degrades";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const [storedMessage] = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "stored context should be skipped while maintenance is pending",
        tokenCount: 20,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, [storedMessage.messageId]);
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 100,
      currentTokenCount: 90,
    });
    const executeCompactionCoreSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "current delivery turn" })],
      tokenBudget: 100,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).not.toHaveBeenCalled();
    expect(maintenance?.pending).toBe(true);
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "current delivery turn",
    ]);
    expect(assembleResult.estimatedTokens).toBeLessThanOrEqual(100);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reason=near-budget"));
  });

  it("assemble() intercepts large tool results in live messages before degraded fallback", async () => {
    const largeFilesDir = mkdtempSync(join(tmpdir(), "lossless-claw-large-files-"));
    tempDirs.push(largeFilesDir);
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDeps(
      {
        largeFileTokenThreshold: 20,
        stubLargeToolPayloads: true,
        largeFilesDir,
      },
      { log },
    );
    const sessionId = "assemble-intercepts-large-tool-results-before-degraded";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const [storedMessage] = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "stored content",
        tokenCount: 20,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, [storedMessage.messageId]);
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 100,
      currentTokenCount: 90,
    });

    const largeToolContent = "tool output. ".repeat(200); // well above 20-token threshold
    const liveMessages = [
      makeMessage({ role: "user", content: "current turn" }),
      makeMessage({
        role: "assistant",
        content: [{ type: "tool_use", id: "call_1", name: "exec", input: {} }],
      }),
      makeMessage({
        role: "toolResult",
        content: [
          {
            type: "tool_result",
            tool_use_id: "call_1",
            output: largeToolContent,
          },
        ],
      }),
    ];
    const originalLiveMessages = structuredClone(liveMessages);
    const assembleResult = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 100,
    });

    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    // The tool result should have been intercepted and replaced with a
    // [LCM Tool Output: …] stub; the output field should reference the
    // externalized file, not contain the raw content.
    const hasStub = assembleResult.messages.some((msg) => {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return text.includes("[LCM Tool Output: file_")
        && text.includes("externalizedFileId");
    });
    expect(hasStub).toBe(true);
    expect(liveMessages).toEqual(originalLiveMessages);

    const firstLargeFiles = await engine
      .getSummaryStore()
      .getLargeFilesByConversation(conversation.conversationId);
    expect(firstLargeFiles).toHaveLength(1);

    const secondAssembleResult = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 100,
    });
    const secondHasStub = secondAssembleResult.messages.some((msg) => {
      const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      return text.includes(`[LCM Tool Output: ${firstLargeFiles[0]!.fileId}`)
        && text.includes("externalizedFileId");
    });
    expect(secondHasStub).toBe(true);
    await expect(
      engine.getSummaryStore().getLargeFilesByConversation(conversation.conversationId),
    ).resolves.toHaveLength(1);
  });

  it("assemble() clears exhausted threshold debt and preserves leading system context via degraded fallback (#639 Mode 2)", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const sessionId = "assemble-degraded-preserves-system";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 30,
      currentTokenCount: 29,
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [
        makeMessage({ role: "system", content: "critical runtime policy" }),
        makeMessage({ role: "user", content: "current delivery turn" }),
      ],
      tokenBudget: 10,
    });

    // #639 Mode 2: exhausted threshold debt (empty conversation -> nothing to
    // compact) is now CLEARED rather than left pending. Because this drain
    // happens during an already-over-budget assemble call, the current turn still
    // uses the degraded fallback instead of returning raw live messages.
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "critical runtime policy",
      "current delivery turn",
    ]);
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=emergency-debt-exhausted"),
    );
  });

  it("assemble() bounds live context when emergency debt drain reaches exhaustion", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const sessionId = "assemble-exhausted-emergency-debt-bounds-live";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 30,
      currentTokenCount: 500,
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [
        makeMessage({ role: "user", content: "oversized historical live turn ".repeat(100) }),
        makeMessage({ role: "user", content: "current delivery turn" }),
      ],
      tokenBudget: 10,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(false);
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "current delivery turn",
    ]);
    // The single kept message exceeds the tiny budget; the estimate is the
    // honest serialized size of what was returned.
    expect(assembleResult.estimatedTokens).toBe(
      estimateSerializedMessagesTokens(assembleResult.messages),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=emergency-debt-exhausted"),
    );
  });

  it("assemble() degrades to bounded live context if emergency compaction leaves debt pending", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-emergency-failed-degrades";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    const [storedMessage] = await engine.getConversationStore().createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "stored context should not be used after failed emergency compaction",
        tokenCount: 20,
      },
    ]);
    await engine
      .getSummaryStore()
      .appendContextMessages(conversation.conversationId, [storedMessage.messageId]);
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 100,
      currentTokenCount: 150,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "provider timeout",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "current emergency turn" })],
      tokenBudget: 100,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 100,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(true);
    expect(maintenance?.lastFailureSummary).toBe("provider timeout");
    expect(assembleResult.messages.map((message) => message.content)).toEqual([
      "current emergency turn",
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[lcm] assemble: emergency deferred compaction debt draining pre-assembly",
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] assemble: degraded live fallback"),
    );
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining("reason=emergency-debt-still-pending"),
    );
  });

  it("assemble() drains pending threshold debt as an emergency when already over budget", async () => {
    const log = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };
    const engine = createEngineWithDepsOverrides({ log });
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 10,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[lcm] assemble: emergency deferred compaction debt draining pre-assembly",
      ),
    );
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reason=over-budget"));
  });

  it("assemble() drains pending threshold debt when recorded runtime tokens are over budget", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-runtime-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 5_000,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 5_000,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() uses projected deferred pressure for emergency drain without passing it as observed tokens", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-threshold-debt-projected-over-budget-drains";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 300,
      projectedTokenCount: 5_000,
      rawTokensOutsideTail: 4_700,
    });
    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: true,
      reason: "compacted",
    });

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    });

    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: conversation.conversationId,
        sessionId,
        tokenBudget: 4_096,
        currentTokenCount: 300,
        compactionTarget: "threshold",
      }),
    );
    expect(maintenance?.pending).toBe(false);
    expect(maintenance?.running).toBe(false);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() does not wait for the session queue when deferred threshold debt is not urgent", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      consumeDeferredCompactionDebt: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-not-urgent";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    const consumeSpy = vi.spyOn(privateEngine, "consumeDeferredCompactionDebt");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });

    let assembleSettled = false;
    const assemblePromise = engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello" })],
      tokenBudget: 4_096,
    }).then((result) => {
      assembleSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleSettled).toBe(true);

    releaseQueue();
    await heldQueue;
    const assembleResult = await assemblePromise;

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() waits for the session queue before emergency deferred threshold compaction", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      withSessionQueue<T>(queueKey: string, operation: () => Promise<T>): Promise<T>;
      consumeDeferredCompactionDebt: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-queued";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 42,
    });
    const consumeSpy = vi.spyOn(privateEngine, "consumeDeferredCompactionDebt");

    let releaseQueue!: () => void;
    const heldQueue = privateEngine.withSessionQueue(sessionId, async () => {
      await new Promise<void>((resolve) => {
        releaseQueue = resolve;
      });
    });

    let assembleSettled = false;
    const assemblePromise = engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    }).then((result) => {
      assembleSettled = true;
      return result;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consumeSpy).not.toHaveBeenCalled();
    expect(assembleSettled).toBe(false);

    releaseQueue();
    await heldQueue;
    const assembleResult = await assemblePromise;

    expect(consumeSpy).toHaveBeenCalledTimes(1);
    expect(assembleResult.messages).toHaveLength(1);
  });

  it("assemble() degrades instead of spending during active deferred retry backoff", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "assemble-deferred-compaction-backoff-degrades";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 3_500,
    });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionRunning({
      conversationId: conversation.conversationId,
    });
    await engine.getCompactionMaintenanceStore().markProactiveCompactionFinished({
      conversationId: conversation.conversationId,
      failureSummary: "provider timeout",
      keepPending: true,
    });
    const executeSpy = vi.spyOn(privateEngine, "executeCompactionCore");

    const assembleResult = await engine.assemble({
      sessionId,
      messages: [makeMessage({ role: "user", content: "hello ".repeat(200) })],
      tokenBudget: 10,
    });

    expect(executeSpy).not.toHaveBeenCalled();
    expect(assembleResult.messages).toHaveLength(1);
    const maintenance = await engine
      .getCompactionMaintenanceStore()
      .getConversationCompactionMaintenance(conversation.conversationId);
    expect(maintenance?.pending).toBe(true);
  });

  it("maintain() uses the stricter current token budget for deferred threshold debt", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      executeCompactionCore: (params: unknown) => Promise<unknown>;
    };
    const sessionId = "maintain-deferred-compaction-current-budget";
    const conversation = await engine.getConversationStore().getOrCreateConversation(sessionId, {
      sessionKey: undefined,
    });
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({
      conversationId: conversation.conversationId,
      reason: "threshold",
      tokenBudget: 4_096,
      currentTokenCount: 1_024,
    });

    const executeCompactionCoreSpy = vi.spyOn(
      privateEngine,
      "executeCompactionCore",
    ).mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "already under target",
    });

    await engine.maintain({
      sessionId,
      sessionFile: createSessionFilePath("maintain-deferred-compaction-current-budget"),
      runtimeContext: {
        allowDeferredCompactionExecution: true,
        tokenBudget: 2_048,
      },
    });

    expect(executeCompactionCoreSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        tokenBudget: 2_048,
      }),
    );
  });

  it("afterTurn persists prompt-cache telemetry for hot sessions", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      },
    );
    const sessionId = "after-turn-prompt-cache-hot";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 500,
      threshold: 3_072,
    });
    vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-prompt-cache-hot"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
      runtimeContext: {
        promptCache: {
          retention: "long",
          lastCallUsage: {
            input: 512,
            cacheRead: 1_024,
            cacheWrite: 128,
          },
          observation: {
            broke: false,
          },
        },
      },
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const telemetry = await engine
      .getCompactionTelemetryStore()
      .getConversationCompactionTelemetry(conversation!.conversationId);
    expect(telemetry).not.toBeNull();
    expect(telemetry).toMatchObject({
      cacheState: "hot",
      lastObservedCacheRead: 1_024,
      lastObservedCacheWrite: 128,
      lastObservedPromptTokenCount: 1_664,
      retention: "long",
    });
    expect(telemetry?.lastObservedCacheHitAt).toBeInstanceOf(Date);
    expect(telemetry?.lastObservedCacheBreakAt).toBeNull();
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("[lcm] compaction telemetry updated:"),
    );
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("cacheState=hot"),
    );
  });

  it("afterTurn prefers runtime prompt tokens over transcript estimates for compaction decisions", async () => {
    const debugLog = vi.fn();
    const engine = createEngineWithDeps(
      {},
      {
        log: {
          info: vi.fn(),
          warn: vi.fn(),
          error: vi.fn(),
          debug: debugLog,
        },
      },
    );
    const sessionId = "after-turn-runtime-prompt-tokens";
    const privateEngine = engine as unknown as {
      compaction: {
        evaluateLeafTrigger: (conversationId: number, leafChunkTokens?: number) => Promise<unknown>;
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 204_800,
      threshold: 98_304,
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-runtime-prompt-tokens"),
      messages: [makeMessage({ role: "assistant", content: "small transcript estimate" })],
      prePromptMessageCount: 0,
      tokenBudget: 128_000,
      runtimeContext: {
        usage: {
          prompt_tokens: 204_800,
        },
      },
    });

    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), expect.any(Number), 204_800);
    expect(debugLog).toHaveBeenCalledWith(
      expect.stringContaining("using runtime prompt token count currentTokenCount=204800"),
    );
  });

  it("afterTurn skips compaction when ingest fails", async () => {
    const errorLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: errorLog,
        debug: vi.fn(),
      },
    });
    const sessionId = "after-turn-ingest-failure";

    const ingestBatchSpy = vi
      .spyOn(engine, "ingestBatch")
      .mockRejectedValue(new Error("ingest exploded"));
    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-ingest-failure"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(ingestBatchSpy).toHaveBeenCalled();
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[lcm] afterTurn: ingest failed, skipping compaction: ingest exploded",
    );
  });

  it("afterTurn prunes heartbeat-shaped ACK turns before compaction even without the heartbeat flag", async () => {
    const infoLog = vi.fn();
    const debugLog = vi.fn();
    const engine = createEngineWithDepsOverrides({
      log: {
        info: infoLog,
        warn: vi.fn(),
        error: vi.fn(),
        debug: debugLog,
      },
    });
    const sessionId = "after-turn-heartbeat-prune";
    const sessionKey = "agent:main:test:after-turn-heartbeat-prune";
    const heartbeatMessages = [
      makeMessage({
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
      makeMessage({
        role: "tool",
        content: "# HEARTBEAT.md\n\n## Worker heartbeat (minimal)",
      }),
      makeMessage({
        role: "tool",
        content: '{\n  "active_session_ids": []\n}',
      }),
      makeMessage({ role: "assistant", content: "HEARTBEAT_OK" }),
    ];
    const sessionFile = createSessionFilePath("after-turn-heartbeat-prune");
    writeLeafTranscriptMessages(sessionFile, heartbeatMessages);

    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactSpy = vi.spyOn(engine, "compact");
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: heartbeatMessages,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(0);
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
    expect(infoLog).toHaveBeenCalledWith(
      expect.stringContaining(
        `heartbeat ack messages for conversation=${conversation!.conversationId} session=${sessionId} sessionKey=${sessionKey}`,
      ),
    );
  });

  it("afterTurn heartbeat flag skips non-empty transcript imports", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-heartbeat-flag-transcript-skip";
    const sessionKey = "agent:main:test:after-turn-heartbeat-flag-transcript-skip";
    const sessionFile = createSessionFilePath("after-turn-heartbeat-flag-transcript-skip");
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "heartbeat transcript user" },
      { role: "assistant", content: "HEARTBEAT_OK" },
    ]);

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "HEARTBEAT_OK" })],
      isHeartbeat: true,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).toBeNull();
  });

  it("afterTurn heartbeat flag skips append-only transcript deltas and advances the checkpoint", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-heartbeat-flag-append-only-skip";
    const sessionKey = "agent:main:test:after-turn-heartbeat-flag-append-only-skip";
    const sessionFile = createSessionFilePath("after-turn-heartbeat-flag-append-only-skip");
    const sm = SessionManager.open(sessionFile);
    appendSessionMessage(sm, makeMessage({ role: "user", content: "seed user" }));
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "seed assistant" }));

    const first = await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(first.bootstrapped).toBe(true);

    const heartbeatMessages = [
      makeMessage({
        role: "user",
        content:
          "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly.",
      }),
      makeMessage({
        role: "tool",
        content: "# HEARTBEAT.md\n\nIf nothing needs attention, stay quiet.",
      }),
      makeMessage({ role: "assistant", content: "HEARTBEAT_OK" }),
    ];
    for (const message of heartbeatMessages) {
      appendSessionMessage(sm, message);
    }

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "HEARTBEAT_OK" })],
      isHeartbeat: true,
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    let stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
    ]);

    appendSessionMessage(sm, makeMessage({ role: "user", content: "real user" }));
    appendSessionMessage(sm, makeMessage({ role: "assistant", content: "real assistant" }));

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [makeMessage({ role: "assistant", content: "real assistant" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "real user",
      "real assistant",
    ]);
  });
});

// ── afterTurn dedup guard ────────────────────────────────────────────────────

