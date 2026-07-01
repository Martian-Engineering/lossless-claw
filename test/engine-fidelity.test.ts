// Engine fidelity: lossless round-tripping of content shapes through ingest/assemble under token budgets.
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
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 123, undefined, { contextThreshold: 0.75 });
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

  it("force compaction clears poor-reduction spend backoff for custom summarizers in the same scope", async () => {
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

      // force:true clears the spend backoff before compaction, so a
      // second force-driven call proceeds instead of being blocked.
      // The backoff is still set by the first call's failure, but force
      // overrides it (overflow recovery and other forced paths must not
      // be blocked by a spend backoff).
      const second = await engine.compact({
        sessionId,
        sessionFile: createSessionFilePath("custom-summarizer-poor-reduction-backoff-retry"),
        tokenBudget: 4_096,
        currentTokenCount: 4_096,
        force: true,
        legacyParams: { summarize },
      });
      expect(second.reason).toBe("could not reach target");
      expect(summarize).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks non-force pending compaction while a summary spend backoff is open", async () => {
    const engine = createEngineWithConfig({
      summarySpendBackoffMs: 10 * 60 * 1000,
    });
    const sessionId = "pending-spend-backoff-block";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "spend backoff pending block" } as AgentMessage,
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

    // The failed force compaction opens the poor-reduction spend backoff.
    const first = await engine.compact({
      sessionId,
      sessionFile: createSessionFilePath("pending-spend-backoff-block"),
      tokenBudget: 4_096,
      currentTokenCount: 4_096,
      force: true,
      legacyParams: { summarize },
    });
    expect(first.reason).toBe("could not reach target");
    expect(summarize).toHaveBeenCalledTimes(1);

    // A non-force pass must refuse before spending any summarizer calls.
    const second = await engine.compact({
      sessionId,
      sessionFile: createSessionFilePath("pending-spend-backoff-block-retry"),
      tokenBudget: 4_096,
      currentTokenCount: 4_096,
      legacyParams: { summarize },
    });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe("summary spend backoff open");
    expect(summarize).toHaveBeenCalledTimes(1);
  });
});
