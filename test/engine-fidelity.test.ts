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
});
