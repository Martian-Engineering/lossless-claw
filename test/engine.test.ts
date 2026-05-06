import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import type { LcmDependencies } from "../src/types.js";

const tempDirs: string[] = [];

function createTestConfig(databasePath: string): LcmConfig {
  return {
    enabled: true,
    databasePath,
    contextThreshold: 0.75,
    freshTailCount: 8,
    leafMinFanout: 8,
    condensedMinFanout: 4,
    condensedMinFanoutHard: 2,
    incrementalMaxDepth: 0,
    leafChunkTokens: 20_000,
    leafTargetTokens: 600,
    condensedTargetTokens: 900,
    maxExpandTokens: 4000,
    largeFileTokenThreshold: 25_000,
    toolResultPersistEnabled: true,
    toolResultPersistThresholdChars: 8_000,
    toolResultPreviewChars: 1_800,
    largeFileSummaryProvider: "",
    largeFileSummaryModel: "",
    autocompactDisabled: false,
    timezone: "UTC",
    pruneHeartbeatOk: false,
  };
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return null;
  }
  return {
    agentId: parts[1] ?? "main",
    suffix: parts.slice(2).join(":"),
  };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return {
    config,
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({ provider: "anthropic", model: "claude-opus-4-5" })),
    getApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY),
    requireApiKey: vi.fn(async () => process.env.ANTHROPIC_API_KEY ?? "test-api-key"),
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: (messages: unknown[]) => {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i] as { role?: unknown; content?: unknown };
        if (message.role !== "assistant") {
          continue;
        }
        if (typeof message.content === "string") {
          return message.content;
        }
      }
      return undefined;
    },
    resolveAgentDir: () => process.env.HOME ?? tmpdir(),
    resolveSessionIdFromSessionKey: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
}

function createEngine(): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  return new LcmContextEngine(createTestDeps(config));
}

function createEngineAtDatabasePath(databasePath: string): LcmContextEngine {
  const config = createTestConfig(databasePath);
  return new LcmContextEngine(createTestDeps(config));
}

function createSessionFilePath(name: string): string {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-session-"));
  tempDirs.push(tempDir);
  return join(tempDir, `${name}.jsonl`);
}

function listFilesRecursive(root: string): string[] {
  if (!existsSync(root)) {
    return [];
  }
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

function createEngineWithConfig(overrides: Partial<LcmConfig>): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-engine-"));
  tempDirs.push(tempDir);
  const config = {
    ...createTestConfig(join(tempDir, "lcm.db")),
    ...overrides,
  };
  return new LcmContextEngine(createTestDeps(config));
}

async function withTempHome<T>(run: (homeDir: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME;
  const tempHome = mkdtempSync(join(tmpdir(), "lossless-claw-home-"));
  tempDirs.push(tempHome);
  process.env.HOME = tempHome;

  try {
    return await run(tempHome);
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
  }
}

function makeMessage(params: { role?: string; content: unknown }): AgentMessage {
  return {
    role: (params.role ?? "assistant") as AgentMessage["role"],
    content: params.content,
    timestamp: Date.now(),
  } as AgentMessage;
}

function estimateAssembledPayloadTokens(messages: AgentMessage[]): number {
  let total = 0;
  for (const message of messages) {
    if ("content" in message) {
      if (typeof message.content === "string") {
        total += Math.ceil(message.content.length / 4);
        continue;
      }
      const serialized = JSON.stringify(message.content);
      total += Math.ceil((typeof serialized === "string" ? serialized : "").length / 4);
    }
  }
  return total;
}

async function ingestAndReadStoredContent(params: {
  engine: LcmContextEngine;
  sessionId: string;
  message: AgentMessage;
}): Promise<string> {
  await params.engine.ingest({
    sessionId: params.sessionId,
    message: params.message,
  });

  const conversation = await params.engine
    .getConversationStore()
    .getConversationBySessionId(params.sessionId);
  expect(conversation).not.toBeNull();

  const messages = await params.engine
    .getConversationStore()
    .getMessages(conversation!.conversationId);
  expect(messages).toHaveLength(1);

  return messages[0].content;
}

afterEach(() => {
  closeLcmConnection();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("LcmContextEngine metadata", () => {
  it("advertises ownsCompaction capability", () => {
    const engine = createEngine();
    expect(engine.info.ownsCompaction).toBe(true);
  });
});

// ── Ingest content extraction ───────────────────────────────────────────────

describe("LcmContextEngine.ingest content extraction", () => {
  it("stores string content as-is", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ role: "user", content: "hello world" }),
    });

    expect(content).toBe("hello world");
  });

  it("flattens text content block arrays to plain text", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "hello" }],
      }),
    });

    expect(content).toBe("hello");
  });

  it("extracts only text blocks from mixed content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({
        content: [
          { type: "text", text: "line one" },
          { type: "thinking", thinking: "internal chain of thought" },
          { type: "tool_use", name: "bash" },
          { type: "text", text: "line two" },
        ],
      }),
    });

    expect(content).toBe("line one\nline two");
  });

  it("stores empty string for empty content arrays", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: [] }),
    });

    expect(content).toBe("");
  });

  it("falls back to JSON.stringify for non-array, non-string content", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const content = await ingestAndReadStoredContent({
      engine,
      sessionId,
      message: makeMessage({ content: { status: "ok", count: 2 } }),
    });

    expect(content).toBe('{"status":"ok","count":2}');
  });

  it("roundtrip stores plain text, not JSON content blocks", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    await engine.ingest({
      sessionId,
      message: makeMessage({
        content: [{ type: "text", text: "HEARTBEAT_OK" }],
      }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].content).toBe("HEARTBEAT_OK");
    expect(storedMessages[0].content).not.toContain('{"type":"text"');
  });

  it("intercepts oversized <file> blocks and persists large file metadata", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const fileText = `${"line about architecture\n".repeat(160)}closing notes`;
      const messageContent = `<file name="lcm-paper.md" mime="text/markdown">${fileText}</file>`;

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: messageContent }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toContain("[LCM File: file_");
      expect(messages[0].content).toContain("Exploration Summary:");
      expect(messages[0].content).not.toContain("<file name=");

      const fileIdMatch = messages[0].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("lcm-paper.md");
      expect(storedFile!.mimeType).toBe("text/markdown");
      expect(storedFile!.storageUri).toContain(
        `.openclaw/lcm-files/${conversation!.conversationId}/`,
      );
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(fileText);

      const parts = await engine.getConversationStore().getMessageParts(messages[0].messageId);
      expect(parts).toHaveLength(1);
      expect(parts[0].textContent).toContain("[LCM File: file_");
      expect(parts[0].textContent).not.toContain("<file name=");
    });
  });

  it("keeps <file> blocks inline when below the large-file threshold", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 100_000 });
      const sessionId = randomUUID();
      const messageContent = '<file name="small.json" mime="application/json">{"ok":true}</file>';

      await engine.ingest({
        sessionId,
        message: makeMessage({ role: "user", content: messageContent }),
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const messages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe(messageContent);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);
    });
  });

  it("offloads oversized tool results into large_files and pending offloads", async () => {
    await withTempHome(async () => {
      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = randomUUID();
      const toolResultText = `head ${"x".repeat(400)} tail`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_tool_offload", name: "exec", input: { cmd: "pwd" } }],
        } as AgentMessage,
      });

      await engine.ingest({
        sessionId,
        message: {
          role: "toolResult",
          toolCallId: "call_tool_offload",
          toolName: "exec",
          isError: false,
          timestamp: 1_717_171_717,
          content: toolResultText,
          details: {
            status: "completed",
            exitCode: 0,
            aggregated: toolResultText,
          },
        } as AgentMessage,
      });

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[1].content).toContain("[LCM Tool Result Offloaded: file_");

      const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const storedFile = await engine.getSummaryStore().getLargeFile(fileId);
      expect(storedFile).not.toBeNull();
      expect(storedFile!.fileName).toBe("tool-result-exec.txt");
      expect(readFileSync(storedFile!.storageUri, "utf8")).toBe(toolResultText);

      const pending = await engine.getSummaryStore().getPendingToolResultOffloads(sessionId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.fileId).toBe(fileId);
      expect(pending[0]?.messageId).toBe(storedMessages[1].messageId);
      expect(pending[0]?.toolCallId).toBe("call_tool_offload");

      const replacement = JSON.parse(pending[0]!.replacementMessageJson) as {
        details?: Record<string, unknown>;
      };
      expect(replacement.details).toMatchObject({
        status: "completed",
        exitCode: 0,
        lcmOffload: {
          fileId,
        },
      });
      expect(replacement.details?.aggregated).toBeUndefined();

      const assembled = await engine.assemble({
        sessionId,
        messages: [],
        tokenBudget: 10_000,
      });
      expect(assembled.messages).toHaveLength(2);
      expect(assembled.messages[0]?.role).toBe("assistant");
      expect(assembled.messages[1]?.role).toBe("toolResult");
      expect((assembled.messages[1] as { toolCallId?: string }).toolCallId).toBe("call_tool_offload");
      expect(JSON.stringify((assembled.messages[1] as { content?: unknown }).content)).toContain(fileId);
    });
  });

  it("rolls back live tool-result offload state when attach fails", async () => {
    await withTempHome(async (homeDir) => {
      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = randomUUID();
      const toolResultText = `head ${"x".repeat(400)} tail`;

      await engine.ingest({
        sessionId,
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_tool_offload_rollback", name: "exec", input: { cmd: "pwd" } }],
        } as AgentMessage,
      });

      const attachSpy = vi
        .spyOn(engine.getSummaryStore(), "attachToolResultOffloadMessageId")
        .mockRejectedValueOnce(new Error("attach boom"));

      await expect(
        engine.ingest({
          sessionId,
          message: {
            role: "toolResult",
            toolCallId: "call_tool_offload_rollback",
            toolName: "exec",
            isError: false,
            timestamp: 1_717_171_730,
            content: toolResultText,
            details: {
              status: "completed",
              exitCode: 0,
              aggregated: toolResultText,
            },
          } as AgentMessage,
        }),
      ).rejects.toThrow("attach boom");

      attachSpy.mockRestore();

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(1);

      const pending = await engine.getSummaryStore().getPendingToolResultOffloads(sessionId);
      expect(pending).toHaveLength(0);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(0);

      const storageDir = join(
        homeDir,
        ".openclaw",
        "lcm-files",
        String(conversation!.conversationId),
      );
      expect(existsSync(storageDir) ? readdirSync(storageDir) : []).toHaveLength(0);
    });
  });

  it("rolls back live large-file interception state when message_parts creation fails", async () => {
    await withTempHome(async (homeDir) => {
      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const sessionId = randomUUID();
      const fileText = `${"system design line\n".repeat(80)}closing note`;

      const createMessagePartsSpy = vi
        .spyOn(engine.getConversationStore(), "createMessageParts")
        .mockRejectedValueOnce(new Error("parts boom"));

      await expect(
        engine.ingest({
          sessionId,
          message: makeMessage({
            role: "user",
            content: `<file name="system-design.md" mime="text/markdown">${fileText}</file>`,
          }),
        }),
      ).rejects.toThrow("parts boom");

      createMessagePartsSpy.mockRestore();

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId(sessionId);
      if (conversation) {
        const storedMessages = await engine
          .getConversationStore()
          .getMessages(conversation.conversationId);
        expect(storedMessages).toHaveLength(0);

        const largeFiles = await engine
          .getSummaryStore()
          .getLargeFilesByConversation(conversation.conversationId);
        expect(largeFiles).toHaveLength(0);
      }

      const lcmFilesRoot = join(homeDir, ".openclaw", "lcm-files");
      expect(listFilesRecursive(lcmFilesRoot)).toEqual([]);
    });
  });
});

describe("LcmContextEngine connection lifecycle", () => {
  it("keeps shared sqlite handle open while another engine instance is active", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-shared-db-"));
    tempDirs.push(tempDir);
    const dbPath = join(tempDir, "lcm.db");

    const engineA = createEngineAtDatabasePath(dbPath);
    const engineB = createEngineAtDatabasePath(dbPath);
    const sessionId = randomUUID();

    await engineA.ingest({
      sessionId,
      message: makeMessage({ role: "user", content: "first" }),
    });

    await engineA.dispose();

    await expect(
      engineB.ingest({
        sessionId,
        message: makeMessage({ role: "assistant", content: "second" }),
      }),
    ).resolves.toEqual({ ingested: true });
  });
});

// ── Bootstrap ───────────────────────────────────────────────────────────────

describe("LcmContextEngine.bootstrap", () => {
  it("imports only active leaf-path messages from SessionManager context", async () => {
    const sessionFile = createSessionFilePath("branched");
    const sm = SessionManager.open(sessionFile);

    const rootUserId = sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "root user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "abandoned assistant" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "abandoned user" }],
    } as AgentMessage);

    // Re-branch from the first user entry so prior turns are abandoned.
    sm.branch(rootUserId);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "active assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-leaf-path";
    const result = await engine.bootstrap({ sessionId, sessionFile });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(conversation!.bootstrappedAt).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(2);
    expect(stored.map((m) => m.content)).toEqual([
      "root user",
      "active assistant",
    ]);

    const contextItems = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    expect(contextItems).toHaveLength(2);
    expect(contextItems.every((item) => item.itemType === "message")).toBe(true);
  });

  it("is idempotent and does not duplicate already bootstrapped sessions", async () => {
    const sessionFile = createSessionFilePath("idempotent");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "first" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "second" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-idempotent";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    const second = await engine.bootstrap({ sessionId, sessionFile });

    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);
    expect(second.bootstrapped).toBe(false);
    expect(second.importedMessages).toBe(0);
    expect(second.reason).toBe("already bootstrapped");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(await engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(
      2,
    );
  });

  it("reconciles missing tail messages when JSONL advanced past LCM", async () => {
    const sessionFile = createSessionFilePath("reconcile-tail");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(2);

    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "lost user turn" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "lost assistant turn" }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(2);
    expect(second.reason).toBe("reconciled missing session messages");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "seed user",
      "seed assistant",
      "lost user turn",
      "lost assistant turn",
    ]);
  });

  it("reconciles missing structured tool-call tail when prior empty tool content exists", async () => {
    const sessionFile = createSessionFilePath("reconcile-tool-tail");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "seed user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "seed assistant" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_existing", name: "read", input: { path: "a.txt" } }],
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_existing",
      content: [{ type: "tool_result", tool_use_id: "call_existing", output: { ok: true } }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-tool-tail";

    const first = await engine.bootstrap({ sessionId, sessionFile });
    expect(first.bootstrapped).toBe(true);
    expect(first.importedMessages).toBe(4);

    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_missing", name: "read", input: { path: "b.txt" } }],
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_missing",
      content: [{ type: "tool_result", tool_use_id: "call_missing", output: { ok: true } }],
    } as AgentMessage);

    const second = await engine.bootstrap({ sessionId, sessionFile });
    expect(second.bootstrapped).toBe(true);
    expect(second.importedMessages).toBe(2);
    expect(second.reason).toBe("reconciled missing session messages");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(6);
    expect(stored[4].role).toBe("assistant");
    expect(stored[4].content).toBe("");
    expect(stored[5].role).toBe("tool");
    expect(stored[5].content).toBe("");
  });

  it("does not append JSONL when no overlapping anchor exists in LCM", async () => {
    const sessionFile = createSessionFilePath("reconcile-no-overlap");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "json only user" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "json only assistant" }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-reconcile-no-overlap";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "db only user" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "db only assistant" } as AgentMessage,
    });

    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(false);
    expect(result.importedMessages).toBe(0);
    expect(result.reason).toBe("conversation already has messages");

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual(["db only user", "db only assistant"]);
  });

  it("uses the canonical import path for initial bootstrap and writes message_parts", async () => {
    const sessionFile = createSessionFilePath("bulk");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "bulk one" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_bootstrap", name: "read", input: { path: "bulk.txt" } }],
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_bootstrap",
      toolName: "read",
      isError: false,
      timestamp: Date.now(),
      content: [{ type: "tool_result", tool_use_id: "call_bootstrap", output: { ok: true } }],
    } as AgentMessage);

    const engine = createEngine();
    const bulkSpy = vi.spyOn(engine.getConversationStore(), "createMessagesBulk");
    const singleSpy = vi.spyOn(engine.getConversationStore(), "createMessage");

    const result = await engine.bootstrap({
      sessionId: "bootstrap-bulk",
      sessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(3);
    expect(bulkSpy).not.toHaveBeenCalled();
    expect(singleSpy).toHaveBeenCalledTimes(3);

    const conversation = await engine.getConversationStore().getConversationBySessionId("bootstrap-bulk");
    expect(conversation).not.toBeNull();

    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(3);

    const assistantParts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[1].messageId);
    expect(assistantParts).toHaveLength(1);
    expect(assistantParts[0].partType).toBe("tool");
    expect(assistantParts[0].toolCallId).toBe("call_bootstrap");

    const toolResultParts = await engine
      .getConversationStore()
      .getMessageParts(storedMessages[2].messageId);
    expect(toolResultParts).toHaveLength(1);
    expect(toolResultParts[0].partType).toBe("tool");
    expect(toolResultParts[0].toolCallId).toBe("call_bootstrap");
  });

  it("rehydrates bootstrapped tool results as toolResult messages", async () => {
    const sessionFile = createSessionFilePath("bootstrap-tool-roundtrip");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "call_bootstrap_rt", name: "read", input: { path: "rt.txt" } }],
    } as AgentMessage);
    sm.appendMessage({
      role: "toolResult",
      toolCallId: "call_bootstrap_rt",
      toolName: "read",
      isError: false,
      timestamp: Date.now(),
      content: [{ type: "tool_result", tool_use_id: "call_bootstrap_rt", output: { ok: true } }],
    } as AgentMessage);

    const engine = createEngine();
    const sessionId = "bootstrap-tool-roundtrip";

    const result = await engine.bootstrap({ sessionId, sessionFile });
    expect(result.bootstrapped).toBe(true);
    expect(result.importedMessages).toBe(2);

    const assembled = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(assembled.messages).toHaveLength(2);
    expect(assembled.messages[0]?.role).toBe("assistant");
    expect(assembled.messages[1]?.role).toBe("toolResult");
    expect((assembled.messages[1] as { toolCallId?: string }).toolCallId).toBe("call_bootstrap_rt");
  });

  it("offloads oversized bootstrapped tool results into large_files and pending offloads", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("bootstrap-tool-offload");
      const sm = SessionManager.open(sessionFile);
      const toolResultText = `bootstrap ${"z".repeat(400)} tail`;

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bootstrap_offload", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_bootstrap_offload",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_718,
        content: toolResultText,
        details: {
          status: "completed",
          exitCode: 0,
          aggregated: toolResultText,
        },
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "bootstrap-tool-offload";

      const result = await engine.bootstrap({ sessionId, sessionFile });
      expect(result.bootstrapped).toBe(true);
      expect(result.importedMessages).toBe(2);

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[1].content).toContain("[LCM Tool Result Offloaded: file_");

      const fileIdMatch = storedMessages[1].content.match(/file_[a-f0-9]{16}/);
      expect(fileIdMatch).not.toBeNull();
      const fileId = fileIdMatch![0];

      const pending = await engine.getSummaryStore().getPendingToolResultOffloads(sessionId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.fileId).toBe(fileId);
      expect(pending[0]?.messageId).toBe(storedMessages[1].messageId);
      expect(pending[0]?.toolCallId).toBe("call_bootstrap_offload");
    });
  });

  it("rolls back bootstrapped tool-result offload state when attach fails", async () => {
    await withTempHome(async (homeDir) => {
      const sessionFile = createSessionFilePath("bootstrap-tool-offload-rollback");
      const sm = SessionManager.open(sessionFile);
      const toolResultText = `bootstrap ${"k".repeat(400)} tail`;

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bootstrap_offload_rollback", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_bootstrap_offload_rollback",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_731,
        content: toolResultText,
        details: {
          status: "completed",
          exitCode: 0,
          aggregated: toolResultText,
        },
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const attachSpy = vi
        .spyOn(engine.getSummaryStore(), "attachToolResultOffloadMessageId")
        .mockRejectedValueOnce(new Error("attach boom"));

      await expect(
        engine.bootstrap({
          sessionId: "bootstrap-tool-offload-rollback",
          sessionFile,
        }),
      ).rejects.toThrow("attach boom");

      attachSpy.mockRestore();

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId("bootstrap-tool-offload-rollback");
      if (conversation) {
        const storedMessages = await engine
          .getConversationStore()
          .getMessages(conversation.conversationId);
        expect(storedMessages).toHaveLength(0);

        const largeFiles = await engine
          .getSummaryStore()
          .getLargeFilesByConversation(conversation.conversationId);
        expect(largeFiles).toHaveLength(0);
      }

      const pending = await engine
        .getSummaryStore()
        .getPendingToolResultOffloads("bootstrap-tool-offload-rollback");
      expect(pending).toHaveLength(0);

      const lcmFilesRoot = join(homeDir, ".openclaw", "lcm-files");
      const residualFiles = existsSync(lcmFilesRoot)
        ? readdirSync(lcmFilesRoot, { recursive: true }).filter((entry) => String(entry).endsWith(".txt"))
        : [];
      expect(residualFiles).toHaveLength(0);
    });
  });

  it("rolls back bootstrapped large-file interception state when message_parts creation fails", async () => {
    await withTempHome(async (homeDir) => {
      const sessionFile = createSessionFilePath("bootstrap-user-file-rollback");
      const sm = SessionManager.open(sessionFile);
      const fileText = `${"architecture line\n".repeat(80)}tail`;
      sm.appendMessage({
        role: "user",
        content: `<file name="architecture.md" mime="text/markdown">${fileText}</file>`,
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant anchor after raw file" }],
      } as AgentMessage);

      const engine = createEngineWithConfig({ largeFileTokenThreshold: 20 });
      const createMessagePartsSpy = vi
        .spyOn(engine.getConversationStore(), "createMessageParts")
        .mockRejectedValueOnce(new Error("parts boom"));

      await expect(
        engine.bootstrap({
          sessionId: "bootstrap-user-file-rollback",
          sessionFile,
        }),
      ).rejects.toThrow("parts boom");

      createMessagePartsSpy.mockRestore();

      const conversation = await engine
        .getConversationStore()
        .getConversationBySessionId("bootstrap-user-file-rollback");
      if (conversation) {
        const storedMessages = await engine
          .getConversationStore()
          .getMessages(conversation.conversationId);
        expect(storedMessages).toHaveLength(0);

        const largeFiles = await engine
          .getSummaryStore()
          .getLargeFilesByConversation(conversation.conversationId);
        expect(largeFiles).toHaveLength(0);
      }

      const lcmFilesRoot = join(homeDir, ".openclaw", "lcm-files");
      expect(listFilesRecursive(lcmFilesRoot)).toEqual([]);
    });
  });

  it("does not re-offload an already bootstrapped oversized tool result before transcript rewrite", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("bootstrap-tool-offload-idempotent");
      const sm = SessionManager.open(sessionFile);
      const toolResultText = `bootstrap ${"q".repeat(400)} tail`;

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_bootstrap_offload_idempotent", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_bootstrap_offload_idempotent",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_719,
        content: toolResultText,
        details: {
          status: "completed",
          exitCode: 0,
          aggregated: toolResultText,
        },
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "bootstrap-tool-offload-idempotent";

      const first = await engine.bootstrap({ sessionId, sessionFile });
      expect(first.bootstrapped).toBe(true);
      expect(first.importedMessages).toBe(2);

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const second = await engine.bootstrap({ sessionId, sessionFile });
      expect(second.bootstrapped).toBe(false);
      expect(second.importedMessages).toBe(0);
      expect(second.reason).toBe("already bootstrapped");

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);

      const pending = await engine.getSummaryStore().getPendingToolResultOffloads(sessionId);
      expect(pending).toHaveLength(1);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(1);
    });
  });

  it("reconciles only new tail messages after an offloaded bootstrapped tool result", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("reconcile-after-tool-offload");
      const sm = SessionManager.open(sessionFile);
      const toolResultText = `bootstrap ${"r".repeat(400)} tail`;

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_reconcile_after_offload", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_reconcile_after_offload",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_720,
        content: toolResultText,
        details: {
          status: "completed",
          exitCode: 0,
          aggregated: toolResultText,
        },
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "reconcile-after-tool-offload";

      const first = await engine.bootstrap({ sessionId, sessionFile });
      expect(first.bootstrapped).toBe(true);
      expect(first.importedMessages).toBe(2);

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "tail after offload" }],
      } as AgentMessage);

      const second = await engine.bootstrap({ sessionId, sessionFile });
      expect(second.bootstrapped).toBe(true);
      expect(second.importedMessages).toBe(1);
      expect(second.reason).toBe("reconciled missing session messages");

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(3);
      expect(storedMessages[2]?.content).toBe("tail after offload");

      const pending = await engine.getSummaryStore().getPendingToolResultOffloads(sessionId);
      expect(pending).toHaveLength(1);

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(1);
    });
  });

  it("does not re-intercept an already bootstrapped oversized user <file> message before transcript rewrite", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("bootstrap-user-file-idempotent");
      const sm = SessionManager.open(sessionFile);
      const fileText = `${"system design line\n".repeat(80)}closing note`;
      sm.appendMessage({
        role: "user",
        content: `<file name="system-design.md" mime="text/markdown">${fileText}</file>`,
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant anchor after intercepted file" }],
      } as AgentMessage);

      const engine = createEngineWithConfig({
        largeFileTokenThreshold: 20,
      });
      const sessionId = "bootstrap-user-file-idempotent";

      const first = await engine.bootstrap({ sessionId, sessionFile });
      expect(first.bootstrapped).toBe(true);
      expect(first.importedMessages).toBe(2);

      const second = await engine.bootstrap({ sessionId, sessionFile });
      expect(second.bootstrapped).toBe(false);
      expect(second.importedMessages).toBe(0);
      expect(second.reason).toBe("already bootstrapped");

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(2);
      expect(storedMessages[0]?.content).toContain("[LCM File: file_");
      expect(storedMessages[0]?.content).not.toContain("<file name=");
      expect(storedMessages[1]?.content).toBe("assistant anchor after intercepted file");

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(1);
    });
  });

  it("reconciles only new tail messages after an intercepted bootstrapped oversized user <file> message", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("reconcile-after-user-file-intercept");
      const sm = SessionManager.open(sessionFile);
      const fileText = `${"architecture note\n".repeat(80)}tail`;
      sm.appendMessage({
        role: "user",
        content: `<file name="architecture.md" mime="text/markdown">${fileText}</file>`,
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "assistant anchor after raw file" }],
      } as AgentMessage);

      const engine = createEngineWithConfig({
        largeFileTokenThreshold: 20,
      });
      const sessionId = "reconcile-after-user-file-intercept";

      const first = await engine.bootstrap({ sessionId, sessionFile });
      expect(first.bootstrapped).toBe(true);
      expect(first.importedMessages).toBe(2);

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: "tail after intercepted file" }],
      } as AgentMessage);

      const second = await engine.bootstrap({ sessionId, sessionFile });
      expect(second.bootstrapped).toBe(true);
      expect(second.importedMessages).toBe(1);
      expect(second.reason).toBe("reconciled missing session messages");

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      const storedMessages = await engine
        .getConversationStore()
        .getMessages(conversation!.conversationId);
      expect(storedMessages).toHaveLength(3);
      expect(storedMessages[0]?.content).toContain("[LCM File: file_");
      expect(storedMessages[1]?.content).toBe("assistant anchor after raw file");
      expect(storedMessages[2]?.content).toBe("tail after intercepted file");

      const largeFiles = await engine
        .getSummaryStore()
        .getLargeFilesByConversation(conversation!.conversationId);
      expect(largeFiles).toHaveLength(1);
    });
  });
});

describe("LcmContextEngine.maintain", () => {
  it("rewrites multiple matched pending offloads in one batch", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-batch");
      const sm = SessionManager.open(sessionFile);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_batch_1", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      const toolResultEntryId1 = sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_batch_1",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_721,
        content: `batch-one ${"a".repeat(400)} tail`,
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_batch_2", name: "exec", input: { cmd: "ls" } }],
      } as AgentMessage);
      const toolResultEntryId2 = sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_batch_2",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_722,
        content: `batch-two ${"b".repeat(400)} tail`,
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-batch";

      await engine.bootstrap({ sessionId, sessionFile });
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(2);

      const rewriteTranscriptEntries = vi.fn(async (request: {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      }) => ({
        changed: true,
        bytesFreed: 1024,
        rewrittenEntries: request.replacements.length,
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: { rewriteTranscriptEntries },
      });

      expect(result).toEqual({
        changed: true,
        bytesFreed: 1024,
        rewrittenEntries: 2,
      });
      expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);

      const request = rewriteTranscriptEntries.mock.calls[0]?.[0] as {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      };
      expect(request.replacements.map((replacement) => replacement.entryId)).toEqual([
        toolResultEntryId1,
        toolResultEntryId2,
      ]);

      expect(await engine.getSummaryStore().getPendingToolResultOffloads(sessionId)).toEqual([]);
    });
  });

  it("rewrites one pending offload on the active branch and marks it rewritten", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-tool-offload");
      const sm = SessionManager.open(sessionFile);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_maintain", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      const toolResultEntryId = sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_maintain",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_719,
        content: `maintain ${"m".repeat(400)} tail`,
        details: {
          status: "completed",
          exitCode: 0,
          aggregated: `maintain ${"m".repeat(400)} tail`,
        },
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-tool-offload";

      await engine.bootstrap({ sessionId, sessionFile });
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(1);

      const rewriteTranscriptEntries = vi.fn(async (request: {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      }) => ({
        changed: true,
        bytesFreed: 512,
        rewrittenEntries: request.replacements.length,
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: { rewriteTranscriptEntries },
      });

      expect(result).toEqual({
        changed: true,
        bytesFreed: 512,
        rewrittenEntries: 1,
      });
      expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);

      const request = rewriteTranscriptEntries.mock.calls[0]?.[0] as {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      };
      expect(request.replacements).toHaveLength(1);
      expect(request.replacements[0]?.entryId).toBe(toolResultEntryId);
      expect(JSON.stringify(request.replacements[0]?.message.content)).toContain("file_");

      expect(await engine.getSummaryStore().getPendingToolResultOffloads(sessionId)).toEqual([]);
      const rewritten = await engine.getSummaryStore().getToolResultOffload(1);
      expect(rewritten?.rewriteState).toBe("rewritten");
      expect(rewritten?.transcriptEntryId).toBe(toolResultEntryId);
    });
  });

  it("self-heals pending offloads when transcript already contains the replacement", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-self-heal");
      const sm = SessionManager.open(sessionFile);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_self_heal", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      const toolResultEntryId = sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_self_heal",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_732,
        content: `self-heal ${"h".repeat(400)} tail`,
        details: {
          status: "completed",
          exitCode: 0,
          aggregated: `self-heal ${"h".repeat(400)} tail`,
        },
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-self-heal";

      await engine.bootstrap({ sessionId, sessionFile });
      const [pendingBefore] = await engine.getSummaryStore().getPendingToolResultOffloads(sessionId);
      expect(pendingBefore).toBeTruthy();

      const rewriteTranscriptEntries = vi.fn(async (request: {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      }) => {
        const target = request.replacements[0];
        expect(target?.entryId).toBe(toolResultEntryId);
        const targetMessage = target?.message as {
          toolCallId?: string;
          toolName?: string;
          isError?: boolean;
          timestamp?: number;
          content?: unknown;
        };
        const targetText =
          typeof targetMessage?.content === "string"
            ? targetMessage.content
            : JSON.stringify(targetMessage?.content ?? "");
        const targetFileId = targetText.match(/\bfile_[a-f0-9]{16}\b/i)?.[0];

        const sessionManager = SessionManager.open(sessionFile) as unknown as {
          getBranch: () => Array<{ id: string; parentId?: string }>;
          resetLeaf: () => void;
          branch: (parentId: string) => void;
          appendMessage: (message: AgentMessage) => string;
        };
        const targetEntry = sessionManager.getBranch().find((entry) => entry.id === target?.entryId);
        expect(targetEntry).toBeTruthy();
        if (targetEntry?.parentId) {
          sessionManager.branch(targetEntry.parentId);
        } else {
          sessionManager.resetLeaf();
        }
        sessionManager.appendMessage({
          timestamp: targetMessage.timestamp,
          role: "toolResult",
          toolName: targetMessage.toolName,
          toolCallId: targetMessage.toolCallId,
          isError: targetMessage.isError,
          details: targetFileId
            ? {
                lcmOffload: { fileId: targetFileId },
                normalized: true,
              }
            : undefined,
          content: [{ type: "text", text: targetText }],
        } as AgentMessage);

        return {
          changed: true,
          bytesFreed: 512,
          rewrittenEntries: request.replacements.length,
        };
      });

      const markRewrittenSpy = vi
        .spyOn(engine.getSummaryStore(), "markToolResultOffloadRewritten")
        .mockRejectedValueOnce(new Error("mark boom"));

      await expect(
        engine.maintain({
          sessionId,
          sessionFile,
          runtimeContext: { rewriteTranscriptEntries },
        }),
      ).rejects.toThrow("mark boom");

      markRewrittenSpy.mockRestore();

      const secondRewriteTranscriptEntries = vi.fn(async () => ({
        changed: true,
        bytesFreed: 0,
        rewrittenEntries: 0,
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: { rewriteTranscriptEntries: secondRewriteTranscriptEntries },
      });

      expect(result).toEqual({
        changed: true,
        bytesFreed: 0,
        rewrittenEntries: 1,
        reason: "pending offloads already reflected in transcript",
      });
      expect(secondRewriteTranscriptEntries).not.toHaveBeenCalled();
      expect(await engine.getSummaryStore().getPendingToolResultOffloads(sessionId)).toEqual([]);

      const rewritten = await engine.getSummaryStore().getToolResultOffload(1);
      expect(rewritten?.rewriteState).toBe("rewritten");
      expect(rewritten?.transcriptEntryId).toBeTruthy();
      expect(rewritten?.transcriptEntryId).not.toBe(toolResultEntryId);
    });
  });

  it("keeps matched pending offloads when runtime reports no transcript change", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-no-change");
      const sm = SessionManager.open(sessionFile);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_no_change", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_no_change",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_723,
        content: `no-change ${"c".repeat(400)} tail`,
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-no-change";

      await engine.bootstrap({ sessionId, sessionFile });
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(1);

      const rewriteTranscriptEntries = vi.fn(async () => ({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "runtime skipped rewrite",
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: { rewriteTranscriptEntries },
      });

      expect(result).toEqual({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "runtime skipped rewrite",
      });
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(1);
    });
  });

  it("rewrites only matched pending offloads and leaves unmatched ones pending", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-partial-match");
      const sm = SessionManager.open(sessionFile);
      const toolResultText = `partial ${"p".repeat(400)} tail`;

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_partial_match", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      const toolResultEntryId = sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_partial_match",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_724,
        content: toolResultText,
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-partial-match";

      await engine.bootstrap({ sessionId, sessionFile });

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      await engine.getSummaryStore().insertLargeFile({
        fileId: "file_feedfacecafebeef",
        conversationId: conversation!.conversationId,
        fileName: "tool-result-unmatched.txt",
        mimeType: "text/plain",
        byteSize: 2048,
        storageUri: "/tmp/tool-result-unmatched.txt",
        explorationSummary: "Unmatched offload",
      });
      await engine.getSummaryStore().insertToolResultOffload({
        conversationId: conversation!.conversationId,
        sessionId,
        fileId: "file_feedfacecafebeef",
        toolCallId: "call_unmatched",
        toolName: "exec",
        messageTimestamp: 1_717_171_725,
        originalCharCount: 4096,
        originalByteSize: 4096,
        previewText: "unmatched preview",
        replacementMessageJson: JSON.stringify({
          role: "toolResult",
          toolCallId: "call_unmatched",
          toolName: "exec",
          isError: false,
          timestamp: 1_717_171_725,
          content: "unmatched preview",
        }),
      });

      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(2);

      const rewriteTranscriptEntries = vi.fn(async (request: {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      }) => ({
        changed: true,
        bytesFreed: 256,
        rewrittenEntries: request.replacements.length,
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: { rewriteTranscriptEntries },
      });

      expect(result).toEqual({
        changed: true,
        bytesFreed: 256,
        rewrittenEntries: 1,
      });
      expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);

      const request = rewriteTranscriptEntries.mock.calls[0]?.[0] as {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      };
      expect(request.replacements).toHaveLength(1);
      expect(request.replacements[0]?.entryId).toBe(toolResultEntryId);

      const pending = await engine.getSummaryStore().getPendingToolResultOffloads(sessionId);
      expect(pending).toHaveLength(1);
      expect(pending[0]?.toolCallId).toBe("call_unmatched");
    });
  });

  it("rewrites valid matches even when another matched offload has invalid replacement payload", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-invalid-payload");
      const sm = SessionManager.open(sessionFile);

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_valid_payload", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      const validEntryId = sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_valid_payload",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_726,
        content: `valid ${"v".repeat(400)} tail`,
      } as AgentMessage);

      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_invalid_payload", name: "exec", input: { cmd: "ls" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_invalid_payload",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_727,
        content: "small tool result that stays inline",
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-invalid-payload";

      await engine.bootstrap({ sessionId, sessionFile });

      const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
      expect(conversation).not.toBeNull();

      await engine.getSummaryStore().insertLargeFile({
        fileId: "file_badpayloadcafebeef",
        conversationId: conversation!.conversationId,
        fileName: "tool-result-invalid.txt",
        mimeType: "text/plain",
        byteSize: 1024,
        storageUri: "/tmp/tool-result-invalid.txt",
        explorationSummary: "Invalid payload offload",
      });
      await engine.getSummaryStore().insertToolResultOffload({
        conversationId: conversation!.conversationId,
        sessionId,
        fileId: "file_badpayloadcafebeef",
        toolCallId: "call_invalid_payload",
        toolName: "exec",
        messageTimestamp: 1_717_171_727,
        originalCharCount: 2048,
        originalByteSize: 2048,
        previewText: "invalid payload preview",
        replacementMessageJson: "{not-valid-json",
      });

      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(2);

      const rewriteTranscriptEntries = vi.fn(async (request: {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      }) => ({
        changed: true,
        bytesFreed: 333,
        rewrittenEntries: request.replacements.length,
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: { rewriteTranscriptEntries },
      });

      expect(result).toEqual({
        changed: true,
        bytesFreed: 333,
        rewrittenEntries: 1,
      });
      expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);

      const request = rewriteTranscriptEntries.mock.calls[0]?.[0] as {
        replacements: Array<{ entryId: string; message: AgentMessage }>;
      };
      expect(request.replacements).toHaveLength(1);
      expect(request.replacements[0]?.entryId).toBe(validEntryId);

      expect(await engine.getSummaryStore().getPendingToolResultOffloads(sessionId)).toEqual([]);
      const failed = await engine.getSummaryStore().getToolResultOffload(2);
      expect(failed?.rewriteState).toBe("failed");
      expect(failed?.lastError).toBe("invalid replacement_message_json");
    });
  });

  it("keeps all matched offloads pending when runtime reports a partial rewrite count", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-partial-runtime");
      const sm = SessionManager.open(sessionFile);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_partial_runtime_1", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_partial_runtime_1",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_728,
        content: `runtime-one ${"r".repeat(400)} tail`,
      } as AgentMessage);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_partial_runtime_2", name: "exec", input: { cmd: "ls" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_partial_runtime_2",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_729,
        content: `runtime-two ${"s".repeat(400)} tail`,
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-partial-runtime";

      await engine.bootstrap({ sessionId, sessionFile });
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(2);

      const rewriteTranscriptEntries = vi.fn(async () => ({
        changed: true,
        bytesFreed: 512,
        rewrittenEntries: 1,
        reason: "runtime only rewrote part of the batch",
      }));

      const result = await engine.maintain({
        sessionId,
        sessionFile,
        runtimeContext: { rewriteTranscriptEntries },
      });

      expect(result).toEqual({
        changed: true,
        bytesFreed: 512,
        rewrittenEntries: 1,
        reason: "runtime only rewrote part of the batch",
      });
      expect(rewriteTranscriptEntries).toHaveBeenCalledTimes(1);
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(2);
    });
  });

  it("keeps pending offloads when rewrite helper is unavailable", async () => {
    await withTempHome(async () => {
      const sessionFile = createSessionFilePath("maintain-no-helper");
      const sm = SessionManager.open(sessionFile);
      sm.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: "call_no_helper", name: "exec", input: { cmd: "pwd" } }],
      } as AgentMessage);
      sm.appendMessage({
        role: "toolResult",
        toolCallId: "call_no_helper",
        toolName: "exec",
        isError: false,
        timestamp: 1_717_171_720,
        content: `no-helper ${"n".repeat(400)} tail`,
      } as AgentMessage);

      const engine = createEngineWithConfig({
        toolResultPersistThresholdChars: 120,
        toolResultPreviewChars: 90,
      });
      const sessionId = "maintain-no-helper";

      await engine.bootstrap({ sessionId, sessionFile });
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(1);

      const result = await engine.maintain({
        sessionId,
        sessionFile,
      });

      expect(result).toEqual({
        changed: false,
        bytesFreed: 0,
        rewrittenEntries: 0,
        reason: "rewrite helper unavailable",
      });
      expect((await engine.getSummaryStore().getPendingToolResultOffloads(sessionId))).toHaveLength(1);
    });
  });
});

// ── Assemble canonical path with fallback ───────────────────────────────────

describe("LcmContextEngine.assemble canonical path", () => {
  it("falls back to live messages when no DB conversation exists", async () => {
    const engine = createEngine();
    const liveMessages: AgentMessage[] = [
      { role: "user", content: "first turn" },
      { role: "assistant", content: "first reply" },
    ] as AgentMessage[];

    const result = await engine.assemble({
      sessionId: "session-missing",
      messages: liveMessages,
      tokenBudget: 100,
    });

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
  });

  it("falls back when DB context clearly trails live context", async () => {
    const engine = createEngine();
    const sessionId = "session-incomplete";
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted only one message" } as AgentMessage,
    });

    const liveMessages: AgentMessage[] = [
      { role: "user", content: "live message 1" },
      { role: "assistant", content: "live message 2" },
      { role: "user", content: "live message 3" },
    ] as AgentMessage[];

    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 256,
    });

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
  });

  it("assembles context from DB when coverage exists", async () => {
    const engine = createEngine();
    const sessionId = "session-canonical";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message one" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "persisted message two" } as AgentMessage,
    });

    const liveMessages: AgentMessage[] = [{ role: "user", content: "live turn" }] as AgentMessage[];
    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 10_000,
    });

    expect(result.messages).not.toBe(liveMessages);
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0].role).toBe("user");
    expect(result.messages[0].content).toBe("persisted message one");
    expect(result.messages[1].role).toBe("assistant");
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it("respects token budget in assembled output", async () => {
    const engine = createEngine();
    const sessionId = "session-budget";

    for (let i = 0; i < 12; i++) {
      await engine.ingest({
        sessionId,
        message: {
          role: "user",
          content: `turn ${i} ${"x".repeat(396)}`,
        } as AgentMessage,
      });
    }

    const result = await engine.assemble({
      sessionId,
      messages: [{ role: "user", content: "live tail marker" }] as AgentMessage[],
      tokenBudget: 500,
    });

    expect(result.messages.length).toBeLessThan(12);
    expect(result.messages[0].content).not.toBe(`turn 0 ${"x".repeat(396)}`);
  });

  it("falls back to live messages if assembler throws", async () => {
    const engine = createEngine();
    const sessionId = "session-assemble-error";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "persisted message" } as AgentMessage,
    });

    const originalAssembler = (engine as unknown as { assembler: { assemble: unknown } }).assembler;
    (engine as unknown as { assembler: { assemble: () => Promise<never> } }).assembler = {
      ...originalAssembler,
      assemble: async () => {
        throw new Error("boom");
      },
    };

    const liveMessages: AgentMessage[] = [
      { role: "user", content: "live fallback message" },
    ] as AgentMessage[];
    const result = await engine.assemble({
      sessionId,
      messages: liveMessages,
      tokenBudget: 1000,
    });

    expect(result.messages).toBe(liveMessages);
    expect(result.estimatedTokens).toBe(0);
  });

  it("drops orphan tool results during assembled transcript repair", async () => {
    const engine = createEngine();
    const sessionId = "session-orphan-tool-result";

    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "call_orphan",
        content: [{ type: "tool_result", tool_use_id: "call_orphan", content: "ok" }],
      } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(result.messages).toEqual([]);
  });

  it("inserts synthetic tool results when assembled tool calls have no result", async () => {
    const engine = createEngine();
    const sessionId = "session-missing-tool-result";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read", input: { path: "foo.txt" } }],
      } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]?.role).toBe("assistant");
    expect(result.messages[1]?.role).toBe("toolResult");
    expect((result.messages[1] as { toolCallId?: string }).toolCallId).toBe("call_2");
  });

  it("repairs OpenAI function_call transcripts without dropping reasoning blocks", async () => {
    const engine = createEngine();
    const sessionId = "session-openai-function-call";

    await engine.ingest({
      sessionId,
      message: {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "Need to inspect the working directory." }],
          },
          {
            type: "function_call",
            call_id: "fc_1",
            name: "bash",
            arguments: '{"cmd":"pwd"}',
          },
        ],
      } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "user", content: "interleaved user turn" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: {
        role: "toolResult",
        toolCallId: "fc_1",
        toolName: "bash",
        content: [{ type: "function_call_output", call_id: "fc_1", output: "/tmp" }],
        isError: false,
        timestamp: Date.now(),
      } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    expect(result.messages).toHaveLength(3);

    const assistant = result.messages[0] as {
      role: string;
      content?: Array<{ type?: string; call_id?: string }>;
    };
    expect(assistant.role).toBe("assistant");
    expect(assistant.content?.map((block) => block.type)).toEqual(["reasoning", "function_call"]);
    expect(assistant.content?.[1]?.call_id).toBe("fc_1");

    expect(result.messages[1]?.role).toBe("toolResult");
    expect((result.messages[1] as { toolCallId?: string }).toolCallId).toBe("fc_1");
    expect(result.messages[2]?.role).toBe("user");
  });

  it("omits dynamic LCM system prompt guidance when no summaries exist", async () => {
    const engine = createEngine();
    const sessionId = "session-no-summary-guidance";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "plain context one" } as AgentMessage,
    });
    await engine.ingest({
      sessionId,
      message: { role: "assistant", content: "plain context two" } as AgentMessage,
    });

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const promptAddition = (result as { systemPromptAddition?: string }).systemPromptAddition;
    expect(promptAddition).toBeUndefined();
  });

  it("adds recall workflow guidance when summaries are present", async () => {
    const engine = createEngine();
    const sessionId = "session-summary-guidance";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "seed message" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_guidance_leaf",
      conversationId: conversation!.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Leaf summary content",
      tokenCount: 16,
      descendantCount: 0,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(conversation!.conversationId, "sum_guidance_leaf");

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const promptAddition = (result as { systemPromptAddition?: string }).systemPromptAddition;
    // Core recall section
    expect(promptAddition).toContain("## LCM Recall");
    expect(promptAddition).toContain("maps to details, not the details themselves");
    expect(promptAddition).toContain("**Recall priority:** LCM tools first");
    // Tool escalation
    expect(promptAddition).toContain("1. `lcm_grep`");
    expect(promptAddition).toContain("2. `lcm_describe`");
    expect(promptAddition).toContain("3. `lcm_expand_query`");
    // Usage patterns
    expect(promptAddition).toContain("lcm_expand_query(summaryIds:");
    expect(promptAddition).toContain("lcm_expand_query(query:");
    // Expand for details footer guidance
    expect(promptAddition).toContain("Expand for details about:");
    // Shallow precision guidance (not full checklist)
    expect(promptAddition).toContain("precision/evidence questions");
    expect(promptAddition).toContain("Do not guess from condensed summaries");
    // Should NOT include deep-compaction-specific content
    expect(promptAddition).not.toContain("Uncertainty checklist");
    expect(promptAddition).not.toContain("Deeply compacted context");
  });

  it("emphasizes expand-before-asserting when summaries are deeply compacted", async () => {
    const engine = createEngine();
    const sessionId = "session-deep-summary-guidance";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "seed message" } as AgentMessage,
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    await engine.getSummaryStore().insertSummary({
      summaryId: "sum_guidance_deep",
      conversationId: conversation!.conversationId,
      kind: "condensed",
      depth: 2,
      content: "Deep condensed summary",
      tokenCount: 24,
      descendantCount: 12,
    });
    await engine
      .getSummaryStore()
      .appendContextSummary(conversation!.conversationId, "sum_guidance_deep");

    const result = await engine.assemble({
      sessionId,
      messages: [],
      tokenBudget: 10_000,
    });

    const promptAddition = (result as { systemPromptAddition?: string }).systemPromptAddition;
    // Deep-specific guidance
    expect(promptAddition).toContain("Deeply compacted context");
    expect(promptAddition).toContain("expand before asserting specifics");
    // Full recall flow
    expect(promptAddition).toContain("1) `lcm_grep` to locate relevant summary/message IDs");
    expect(promptAddition).toContain("2) `lcm_expand_query` with a focused prompt");
    expect(promptAddition).toContain("3) Answer with citations to summary IDs used");
    // Uncertainty checklist
    expect(promptAddition).toContain("Uncertainty checklist");
    expect(promptAddition).toContain("Am I making exact factual claims from a condensed summary?");
    expect(promptAddition).toContain("Could compaction have omitted a crucial detail?");
    // Refusal-to-guess
    expect(promptAddition).toContain("Do not guess");
    expect(promptAddition).toContain("Expand first or state that you need to expand");
  });
});

describe("LcmContextEngine fidelity and token budget", () => {
  it("counts large raw metadata blocks in stored context token totals", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const rawBlob = "x".repeat(24_000);

    await engine.ingest({
      sessionId,
      message: makeMessage({
        role: "assistant",
        content: [
          { type: "text", text: "small visible text" },
          {
            type: "tool_result",
            tool_use_id: "call_large_raw",
            metadata: {
              raw: rawBlob,
              details: { payload: rawBlob.slice(0, 8_000) },
            },
          },
        ],
      }),
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

    expect(contextTokens).toBe(assembledPayloadTokens);
    expect(contextTokens).toBeGreaterThan(8_000);
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

  it("maps unknown roles to assistant instead of silently coercing to user", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "custom-event", content: "opaque payload" }),
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    const storedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(storedMessages).toHaveLength(1);
    expect(storedMessages[0].role).toBe("assistant");
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
    });

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored.map((message) => message.content)).toEqual([
      "[summary] compacted older history",
      "new assistant reply",
    ]);
  });

  it("afterTurn runs proactive threshold compaction when tokenBudget is provided", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-proactive-compact";

    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger").mockResolvedValue({
      shouldCompact: false,
      rawTokensOutsideTail: 0,
      threshold: 20_000,
    });
    const compactLeafAsyncSpy = vi.spyOn(engine, "compactLeafAsync");
    const compactSpy = vi.spyOn(engine, "compact").mockResolvedValue({
      ok: true,
      compacted: false,
      reason: "below threshold",
      result: {
        tokensBefore: 42,
      },
    });

    await engine.afterTurn({
      sessionId,
      sessionFile: createSessionFilePath("after-turn-proactive-compact"),
      messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
      prePromptMessageCount: 0,
      tokenBudget: 4096,
    });

    expect(evaluateLeafTriggerSpy).toHaveBeenCalledWith(sessionId);
    expect(compactLeafAsyncSpy).not.toHaveBeenCalled();
    expect(compactSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        tokenBudget: 4096,
        compactionTarget: "threshold",
      }),
    );
  });

  it("afterTurn rethrows ingest failures before running compaction", async () => {
    const engine = createEngine();
    const sessionId = "after-turn-ingest-failure";

    const ingestBatchSpy = vi
      .spyOn(engine, "ingestBatch")
      .mockRejectedValueOnce(new Error("ingest boom"));
    const evaluateLeafTriggerSpy = vi.spyOn(engine, "evaluateLeafTrigger");
    const compactLeafAsyncSpy = vi.spyOn(engine, "compactLeafAsync");
    const compactSpy = vi.spyOn(engine, "compact");

    await expect(
      engine.afterTurn({
        sessionId,
        sessionFile: createSessionFilePath("after-turn-ingest-failure"),
        messages: [makeMessage({ role: "assistant", content: "fresh turn content" })],
        prePromptMessageCount: 0,
        tokenBudget: 4096,
      }),
    ).rejects.toThrow("ingest boom");

    expect(ingestBatchSpy).toHaveBeenCalledTimes(1);
    expect(evaluateLeafTriggerSpy).not.toHaveBeenCalled();
    expect(compactLeafAsyncSpy).not.toHaveBeenCalled();
    expect(compactSpy).not.toHaveBeenCalled();
  });
});

// ── Compact token budget plumbing ───────────────────────────────────────────

describe("LcmContextEngine.compact token budget plumbing", () => {
  it("fails when compact token budget is missing", async () => {
    const engine = createEngine();
    const sessionId = "session-missing-budget";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "hello compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: "/tmp/session.jsonl",
      legacyParams: {
        provider: "anthropic",
        model: "claude-opus-4-5",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toContain("missing token budget");
  });

  it("accepts explicit token budget without falling back to defaults", async () => {
    const engine = createEngineWithConfig({ contextThreshold: 0.9 });
    const sessionId = "session-explicit-budget";

    await engine.ingest({
      sessionId,
      message: { role: "user", content: "small message" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId,
      sessionFile: "/tmp/session.jsonl",
      legacyParams: {
        tokenBudget: 10_000,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below threshold");
  });

  it("forces one compaction round for manual compaction requests", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: false,
      reason: "none",
      currentTokens: 116_000,
      threshold: 150_000,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 116_000,
        tokensAfter: 92_000,
        condensed: false,
      });
    const compactUntilUnderSpy = vi.spyOn(privateEngine.compaction, "compactUntilUnder");

    await engine.ingest({
      sessionId: "manual-compact-session",
      message: { role: "user", content: "trigger manual compact" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "manual-compact-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 200_000,
      legacyParams: {
        manualCompaction: true,
      },
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(result.reason).toBe("compacted");
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 200_000);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 200_000,
        summarize: expect.any(Function),
        force: true,
        hardTrigger: false,
      }),
    );
    expect(compactUntilUnderSpy).not.toHaveBeenCalled();
  });

  it("uses threshold target for proactive threshold compaction mode", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 380,
      threshold: 300,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 380,
        tokensAfter: 280,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "threshold-target-session",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "threshold-target-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 400,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 400);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 400,
        summarize: expect.any(Function),
        force: false,
        hardTrigger: false,
      }),
    );
  });

  it("passes currentTokenCount through to compaction evaluation and loop", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    const evaluateSpy = vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 500,
      threshold: 300,
    });
    const compactFullSweepSpy = vi
      .spyOn(privateEngine.compaction, "compactFullSweep")
      .mockResolvedValue({
        actionTaken: true,
        tokensBefore: 500,
        tokensAfter: 280,
        condensed: false,
      });

    await engine.ingest({
      sessionId: "observed-token-session",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "observed-token-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 400,
      currentTokenCount: 500,
      compactionTarget: "threshold",
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(true);
    expect(evaluateSpy).toHaveBeenCalledWith(expect.any(Number), 400, 500);
    expect(compactFullSweepSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: expect.any(Number),
        tokenBudget: 400,
        summarize: expect.any(Function),
        force: false,
        hardTrigger: false,
      }),
    );
  });

  it("reports already under target when compaction rounds are zero", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (conversationId: number, tokenBudget: number) => Promise<unknown>;
        compactUntilUnder: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 2_050,
      threshold: 1_500,
    });
    vi.spyOn(privateEngine.compaction, "compactUntilUnder").mockResolvedValue({
      success: true,
      rounds: 0,
      finalTokens: 2_000,
    });

    await engine.ingest({
      sessionId: "under-target-session",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "under-target-session",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 2_000,
    });

    expect(result.ok).toBe(true);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("already under target");
  });

  it("reports live overflow when a forced sweep cannot compact stored context", async () => {
    const engine = createEngine();
    const privateEngine = engine as unknown as {
      compaction: {
        evaluate: (
          conversationId: number,
          tokenBudget: number,
          observed?: number,
        ) => Promise<unknown>;
        compactFullSweep: (input: unknown) => Promise<unknown>;
      };
    };

    vi.spyOn(privateEngine.compaction, "evaluate").mockResolvedValue({
      shouldCompact: true,
      reason: "threshold",
      currentTokens: 277_403,
      threshold: 150_000,
    });
    vi.spyOn(privateEngine.compaction, "compactFullSweep").mockResolvedValue({
      actionTaken: false,
      tokensBefore: 17_561,
      tokensAfter: 17_561,
      condensed: false,
    });

    await engine.ingest({
      sessionId: "forced-sweep-live-overflow",
      message: { role: "user", content: "trigger" } as AgentMessage,
    });

    const result = await engine.compact({
      sessionId: "forced-sweep-live-overflow",
      sessionFile: "/tmp/session.jsonl",
      tokenBudget: 200_000,
      currentTokenCount: 277_403,
      force: true,
      compactionTarget: "budget",
    });

    expect(result.ok).toBe(false);
    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("live context still exceeds target");
    expect(result.result?.tokensBefore).toBe(277_403);
    expect(result.result?.tokensAfter).toBe(17_561);
    expect(result.result?.details).toEqual(
      expect.objectContaining({
        rounds: 0,
        targetTokens: 200_000,
      }),
    );
  });
});
