import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDepsOverridesAndDb } from "./helpers.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies, VisibleSessionTranscriptMessageEntry } from "../src/types.js";

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

  it("reconciles afterTurn from the visible projection and ignores a stale session file", async () => {
    const sessionId = "sqlite-afterturn-session";
    const sessionKey = "agent:main:sqlite-afterturn-session";
    const visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "initial user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:00:00.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);

    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.bootstrap({
        sessionId,
        sessionKey,
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

    visibleEntries.push({
      entryId: "entry-assistant",
      parentId: "entry-user",
      seq: 2,
      role: "assistant",
      message: { role: "assistant", content: "projected assistant" } satisfies AgentMessage,
      createdAt: "2026-06-29T12:00:01.000Z",
    });

    await expect(
      engine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "/tmp/does-not-exist-lossless-sqlite-afterturn.jsonl",
        messages: [
          { role: "user", content: "initial user" },
          { role: "assistant", content: "projected assistant" },
        ] satisfies AgentMessage[],
        prePromptMessageCount: 1,
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
    ).resolves.toBeUndefined();

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "initial user",
      "projected assistant",
    ]);
    expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledTimes(2);
  });

  it("does not append missing projected entries that precede the overlap anchor", async () => {
    const sessionId = "sqlite-bootstrap-anchor-prefix-session";
    const sessionKey = "agent:main:sqlite-bootstrap-anchor-prefix-session";
    let visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-anchor",
        parentId: "entry-prefix",
        seq: 2,
        role: "assistant",
        message: { role: "assistant", content: "already imported suffix" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:20:01.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.bootstrap({
        sessionId,
        sessionKey,
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

    visibleEntries = [
      {
        entryId: "entry-prefix",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "trimmed older prefix" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:20:00.000Z",
      },
      {
        entryId: "entry-anchor",
        parentId: "entry-prefix",
        seq: 2,
        role: "assistant",
        message: { role: "assistant", content: "already imported suffix" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:20:01.000Z",
      },
      {
        entryId: "entry-tail",
        parentId: "entry-anchor",
        seq: 3,
        role: "user",
        message: { role: "user", content: "new tail" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:20:02.000Z",
      },
    ];

    await expect(
      engine.bootstrap({
        sessionId,
        sessionKey,
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
    ).resolves.toMatchObject({
      bootstrapped: true,
      importedMessages: 1,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "already imported suffix",
      "new tail",
    ]);
  });

  it("does not treat duplicate content without entry-id overlap as a projection anchor", async () => {
    const sessionId = "sqlite-bootstrap-duplicate-content-session";
    const sessionKey = "agent:main:sqlite-bootstrap-duplicate-content-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-duplicate-ok",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "ok" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:25:00.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingest({
        sessionId,
        sessionKey,
        message: { role: "assistant", content: "ok" } satisfies AgentMessage,
      }),
    ).resolves.toMatchObject({ ingested: true });

    await expect(
      engine.bootstrap({
        sessionId,
        sessionKey,
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
    ).resolves.toMatchObject({
      bootstrapped: false,
      importedMessages: 0,
      reason: "reconcile projection has no overlap",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual(["ok"]);
    const rows = db
      .prepare(
        `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
    expect(rows.map((row) => row.transcript_entry_id)).toEqual([null]);
  });

  it("fails closed instead of appending a no-overlap bootstrap projection to an existing conversation", async () => {
    const sessionId = "sqlite-bootstrap-no-overlap-session";
    const sessionKey = "agent:main:sqlite-bootstrap-no-overlap-session";
    let visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-original-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "original user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:10:00.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.bootstrap({
        sessionId,
        sessionKey,
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

    visibleEntries = [
      {
        entryId: "entry-unrelated-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "unrelated user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:11:00.000Z",
      },
    ];

    await expect(
      engine.bootstrap({
        sessionId,
        sessionKey,
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
    ).resolves.toMatchObject({
      bootstrapped: false,
      importedMessages: 0,
      reason: "reconcile projection has no overlap",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual(["original user"]);
  });

  it("fails closed instead of persisting afterTurn when an existing projection has no overlap", async () => {
    const sessionId = "sqlite-afterturn-no-overlap-session";
    const sessionKey = "agent:main:sqlite-afterturn-no-overlap-session";
    let visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-original-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "original user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:15:00.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.bootstrap({
        sessionId,
        sessionKey,
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

    visibleEntries = [
      {
        entryId: "entry-unrelated-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "unrelated user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:16:00.000Z",
      },
    ];

    await expect(
      engine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "/tmp/ignored-lossless-sqlite-no-overlap.jsonl",
        messages: [
          { role: "user", content: "unrelated user" },
          { role: "assistant", content: "unrelated assistant" },
        ] satisfies AgentMessage[],
        prePromptMessageCount: 1,
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
    ).resolves.toBeUndefined();

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual(["original user"]);
  });

  it("does not persist afterTurn runtime messages when the visible projection is unavailable", async () => {
    const sessionId = "sqlite-afterturn-missing-projection";
    const sessionKey = "agent:main:sqlite-afterturn-missing-projection";
    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries: undefined,
    });

    await expect(
      engine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "/tmp/does-not-exist-lossless-sqlite-missing-projection.jsonl",
        messages: [
          { role: "user", content: "prompt" },
          { role: "assistant", content: "must not persist without projection" },
        ] satisfies AgentMessage[],
        prePromptMessageCount: 1,
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
    ).resolves.toBeUndefined();

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).toBeNull();
  });
});
