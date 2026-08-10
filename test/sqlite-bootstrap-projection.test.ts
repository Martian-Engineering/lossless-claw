import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import {
  cleanupEngineTestState,
  createEngineWithDepsOverrides,
  createSessionFilePath,
  writeLeafTranscript,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

describe("LcmContextEngine.bootstrap SQLite transcript projection", () => {
  it("ignores an opaque heartbeat session marker and reconciles visible entries by id", async () => {
    const sessionId = "sqlite-heartbeat-session";
    const sessionKey = "agent:main:main:heartbeat";
    const visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "sqlite user" } satisfies AgentMessage,
        createdAt: "2026-07-20T12:00:00.000Z",
      },
      {
        entryId: "entry-assistant",
        parentId: "entry-user",
        seq: 2,
        role: "assistant",
        message: { role: "assistant", content: "sqlite assistant" } satisfies AgentMessage,
        createdAt: "2026-07-20T12:00:01.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
    const engine = createEngineWithDepsOverrides({
      readVisibleSessionTranscriptMessageEntries,
    });
    const runtimeContext = {
      transcriptStorage: { kind: "sqlite" },
      sessionTarget: {
        agentId: "main",
        sessionId,
        sessionKey,
        storePath: "/tmp/openclaw-agent.sqlite",
      },
    } as const;

    const first = await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
      runtimeContext,
    });

    expect(first).toMatchObject({ bootstrapped: true, importedMessages: 2 });
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenLastCalledWith({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: "/tmp/openclaw-agent.sqlite",
    });

    visibleEntries.push({
      entryId: "entry-user-2",
      parentId: "entry-assistant",
      seq: 3,
      role: "user",
      message: { role: "user", content: "sqlite follow-up" } satisfies AgentMessage,
      createdAt: "2026-07-20T12:00:02.000Z",
    });
    const second = await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile: sessionKey,
      runtimeContext,
    });

    expect(second).toMatchObject({ bootstrapped: true, importedMessages: 1 });
    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "sqlite user",
      "sqlite assistant",
      "sqlite follow-up",
    ]);
  });

  it("preserves JSONL bootstrap when the host does not report SQLite storage", async () => {
    const sessionId = "jsonl-bootstrap-session";
    const sessionKey = "agent:main:jsonl-bootstrap-session";
    const sessionFile = createSessionFilePath(sessionId);
    writeLeafTranscript(sessionFile, [
      { role: "user", content: "jsonl user" },
      { role: "assistant", content: "jsonl assistant" },
    ]);
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => {
      throw new Error("projection reader must not run for JSONL bootstrap");
    });
    const engine = createEngineWithDepsOverrides({
      readVisibleSessionTranscriptMessageEntries,
    });

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      sessionFile,
      runtimeContext: {
        transcriptStorage: { kind: "jsonl" },
        sessionTarget: {
          sessionId,
          sessionKey,
          storePath: "/tmp/openclaw-agent.sqlite",
        },
      },
    });

    expect(result).toMatchObject({ bootstrapped: true, importedMessages: 2 });
    expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
  });
});
