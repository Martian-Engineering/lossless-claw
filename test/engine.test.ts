import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    autocompactDisabled: false,
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
    getApiKey: vi.fn(() => process.env.ANTHROPIC_API_KEY),
    requireApiKey: vi.fn(() => process.env.ANTHROPIC_API_KEY ?? "test-api-key"),
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
    expect(result.importedMessages).toBe(4);

    const conversation = await engine.getConversationStore().getConversationBySessionId(sessionId);
    expect(conversation).not.toBeNull();
    expect(conversation!.bootstrappedAt).not.toBeNull();

    const stored = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(stored).toHaveLength(4);
    expect(stored.map((m) => m.content)).toEqual([
      "root user",
      "abandoned assistant",
      "abandoned user",
      "active assistant",
    ]);

    const contextItems = await engine
      .getSummaryStore()
      .getContextItems(conversation!.conversationId);
    expect(contextItems).toHaveLength(4);
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

  it("uses the bulk import path for initial bootstrap", async () => {
    const sessionFile = createSessionFilePath("bulk");
    const sm = SessionManager.open(sessionFile);
    sm.appendMessage({
      role: "user",
      content: [{ type: "text", text: "bulk one" }],
    } as AgentMessage);
    sm.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "bulk two" }],
    } as AgentMessage);

    const engine = createEngine();
    const bulkSpy = vi.spyOn(engine.getConversationStore(), "createMessagesBulk");
    const singleSpy = vi.spyOn(engine.getConversationStore(), "createMessage");

    const result = await engine.bootstrap({
      sessionId: "bootstrap-bulk",
      sessionFile,
    });

    expect(result.bootstrapped).toBe(true);
    expect(bulkSpy).toHaveBeenCalledTimes(1);
    expect(singleSpy).not.toHaveBeenCalled();
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
});
