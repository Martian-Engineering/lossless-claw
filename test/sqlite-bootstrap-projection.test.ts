import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDepsOverridesAndDb } from "./helpers.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies } from "../src/types.js";

afterEach(cleanupEngineTestState);

describe("LcmContextEngine.bootstrap sqlite transcript projection", () => {
  it("imports visible transcript entries from runtimeContext.sessionTarget without a session file", async () => {
    const sessionId = "sqlite-bootstrap-session";
    const sessionKey = "agent:main:sqlite-bootstrap-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "sqlite user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:00:00.000Z",
      },
      {
        entryId: "entry-assistant",
        parentId: "entry-user",
        seq: 2,
        role: "assistant",
        message: { role: "assistant", content: "sqlite assistant" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:00:01.000Z",
      },
    ]);

    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    const result = await engine.bootstrap({
      sessionId,
      sessionKey,
      runtimeContext: {
        transcriptStorage: { kind: "sqlite" },
        sessionTarget: {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: "/tmp/openclaw-agent.sqlite",
          threadId: "thread-1",
        },
      },
    });

    expect(result).toMatchObject({ bootstrapped: true, importedMessages: 2 });
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledWith({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath: "/tmp/openclaw-agent.sqlite",
      threadId: "thread-1",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    expect(conversation?.bootstrappedAt).not.toBeNull();

    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "sqlite user",
      "sqlite assistant",
    ]);

    const rows = db
      .prepare(
        `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
    expect(rows.map((row) => row.transcript_entry_id)).toEqual([
      "entry-user",
      "entry-assistant",
    ]);

    const second = await engine.bootstrap({
      sessionId,
      sessionKey,
      runtimeContext: {
        transcriptStorage: { kind: "sqlite" },
        sessionTarget: {
          agentId: "main",
          sessionId,
          sessionKey,
          storePath: "/tmp/openclaw-agent.sqlite",
          threadId: "thread-1",
        },
      },
    });

    expect(second).toMatchObject({ bootstrapped: false, importedMessages: 0 });
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledTimes(2);
    await expect(
      engine.getConversationStore().getMessages(conversation!.conversationId),
    ).resolves.toHaveLength(2);
  });

  it("stores bootstrap data under the resolved runtimeContext session key", async () => {
    const sessionId = "sqlite-bootstrap-runtime-key";
    const sessionKey = "agent:main:sqlite-bootstrap-runtime-key";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-runtime-key",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "runtime keyed user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:05:00.000Z",
      },
    ]);

    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.bootstrap({
        sessionId,
        runtimeContext: {
          transcriptStorage: { kind: "sqlite" },
          sessionTarget: {
            agentId: "main",
            sessionId,
            sessionKey,
            storePath: "/tmp/openclaw-agent.sqlite",
          },
        },
      }),
    ).resolves.toMatchObject({ bootstrapped: true, importedMessages: 1 });

    const keyedConversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(keyedConversation).not.toBeNull();
    expect(keyedConversation?.sessionKey).toBe(sessionKey);
    await expect(
      engine.getConversationStore().getMessages(keyedConversation!.conversationId),
    ).resolves.toHaveLength(1);
  });
});
