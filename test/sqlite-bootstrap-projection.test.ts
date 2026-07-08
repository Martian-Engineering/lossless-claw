import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupEngineTestState, createEngineWithDepsOverridesAndDb } from "./helpers.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies, VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";

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

  it("uses runtimeContext session target identity during afterTurn", async () => {
    const sessionId = "sqlite-afterturn-runtime-key";
    const sessionKey = "agent:main:sqlite-afterturn-runtime-key";
    const visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-runtime-afterturn-user",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "runtime keyed user" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:06:00.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
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

    visibleEntries.push({
      entryId: "entry-runtime-afterturn-assistant",
      parentId: "entry-runtime-afterturn-user",
      seq: 2,
      role: "assistant",
      message: { role: "assistant", content: "runtime keyed assistant" } satisfies AgentMessage,
      createdAt: "2026-06-29T12:06:01.000Z",
    });

    await expect(
      engine.afterTurn({
        sessionId: "top-level-runtime-id",
        sessionFile: "/tmp/ignored-lossless-sqlite-runtime-key.jsonl",
        messages: [
          { role: "user", content: "runtime keyed user" },
          { role: "assistant", content: "runtime keyed assistant" },
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

    const keyedConversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(keyedConversation).not.toBeNull();
    const unkeyedConversation = await engine.getConversationStore().getConversationForSession({
      sessionId: "top-level-runtime-id",
    });
    expect(unkeyedConversation).toBeNull();
    await expect(
      engine.getConversationStore().getMessages(keyedConversation!.conversationId),
    ).resolves.toHaveLength(2);
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
    for (let index = 0; index < 9; index += 1) {
      await expect(
        engine.ingest({
          sessionId,
          sessionKey,
          message: { role: "user", content: `later filler ${index}` } satisfies AgentMessage,
        }),
      ).resolves.toMatchObject({ ingested: true });
    }

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
      reason: "conversation already up to date",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual([
      "ok",
      ...Array.from({ length: 9 }, (_, index) => `later filler ${index}`),
    ]);
    const rows = db
      .prepare(
        `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
    expect(rows.map((row) => row.transcript_entry_id)).toEqual(Array(10).fill(null));
  });

  it("adopts a recent unstamped tail message as the projection anchor", async () => {
    const sessionId = "sqlite-bootstrap-recent-adopt-session";
    const sessionKey = "agent:main:sqlite-bootstrap-recent-adopt-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-recent-ok",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "ok" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:26:00.000Z",
      },
      {
        entryId: "entry-recent-tail",
        parentId: "entry-recent-ok",
        seq: 2,
        role: "user",
        message: { role: "user", content: "tail after adoption" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:26:01.000Z",
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
    expect(messages.map((message) => message.content)).toEqual(["ok", "tail after adoption"]);
    const rows = db
      .prepare(
        `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
    expect(rows.map((row) => row.transcript_entry_id)).toEqual([
      "entry-recent-ok",
      "entry-recent-tail",
    ]);
  });

  it("restamps a recent stale transcript id instead of duplicating the message", async () => {
    const sessionId = "sqlite-bootstrap-restamp-stale-id-session";
    const sessionKey = "agent:main:sqlite-bootstrap-restamp-stale-id-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-anchor",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "already anchored" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:26:58.000Z",
      },
      {
        entryId: "entry-current",
        parentId: "entry-anchor",
        seq: 2,
        role: "user",
        message: { role: "user", content: "same logical turn" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:27:00.000Z",
      },
      {
        entryId: "entry-after-restamp",
        parentId: "entry-current",
        seq: 3,
        role: "assistant",
        message: { role: "assistant", content: "tail after restamp" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:27:01.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [
          attachTranscriptEntryMeta(
            { role: "assistant", content: "already anchored" } satisfies AgentMessage,
            {
              entryId: "entry-anchor",
              parentId: null,
              timestamp: "2026-06-29T12:26:58.000Z",
            },
          ),
          attachTranscriptEntryMeta(
            { role: "user", content: "same logical turn" } satisfies AgentMessage,
            {
              entryId: "entry-stale",
              parentId: null,
              timestamp: "2026-06-29T12:27:00.000Z",
            },
          ),
        ],
      }),
    ).resolves.toMatchObject({ ingestedCount: 2 });

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
      "already anchored",
      "same logical turn",
      "tail after restamp",
    ]);
    const rows = db
      .prepare(
        `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
    expect(rows.map((row) => row.transcript_entry_id)).toEqual([
      "entry-anchor",
      "entry-current",
      "entry-after-restamp",
    ]);
  });

  it("does not restamp a stale transcript id without an independent overlap anchor", async () => {
    const sessionId = "sqlite-bootstrap-stale-id-no-overlap-session";
    const sessionKey = "agent:main:sqlite-bootstrap-stale-id-no-overlap-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-current-reset",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "same repeated content" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:29:00.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [
          attachTranscriptEntryMeta(
            { role: "user", content: "same repeated content" } satisfies AgentMessage,
            {
              entryId: "entry-stale-reset",
              parentId: null,
              timestamp: "2026-06-29T12:28:59.000Z",
            },
          ),
        ],
      }),
    ).resolves.toMatchObject({ ingestedCount: 1 });

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
      reason: "conversation already up to date",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const rows = db
      .prepare(
        `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
    expect(rows.map((row) => row.transcript_entry_id)).toEqual(["entry-stale-reset"]);
  });

  it("does not weakly adopt a blank legacy row as an overlap anchor", async () => {
    const sessionId = "sqlite-bootstrap-blank-weak-adoption-session";
    const sessionKey = "agent:main:sqlite-bootstrap-blank-weak-adoption-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-current-blank",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:29:05.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [{ role: "assistant", content: "" } satisfies AgentMessage],
      }),
    ).resolves.toMatchObject({ ingestedCount: 1 });

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
      reason: "conversation already up to date",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const rows = db
      .prepare(
        `SELECT content, transcript_entry_id
         FROM messages
         WHERE conversation_id = ?
         ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{
      content: string;
      transcript_entry_id: string | null;
    }>;
    expect(rows).toEqual([
      { content: "", transcript_entry_id: null },
    ]);

    const epoch = await engine
      .getConversationStore()
      .getConversationTranscriptEpoch(conversation!.conversationId);
    expect(epoch).toMatchObject({
      migrationMode: "legacy_prefix",
      metadata: { reason: "unproven transcript anchors", classification: "legacy_prefix" },
    });
  });

  it("does not use a stale blank assistant id as a projection overlap anchor", async () => {
    const sessionId = "sqlite-bootstrap-stale-blank-anchor-session";
    const sessionKey = "agent:main:sqlite-bootstrap-stale-blank-anchor-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-current-user-before-blank",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "this is the user message that was skipped" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:29:10.000Z",
      },
      {
        entryId: "entry-current-assistant-blank-id",
        parentId: "entry-current-user-before-blank",
        seq: 2,
        role: "assistant",
        message: { role: "assistant", content: "current assistant content" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:29:11.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [
          attachTranscriptEntryMeta(
            { role: "assistant", content: "" } satisfies AgentMessage,
            {
              entryId: "entry-current-assistant-blank-id",
              parentId: null,
              timestamp: "2026-05-20T12:00:00.000Z",
            },
          ),
        ],
      }),
    ).resolves.toMatchObject({ ingestedCount: 1 });

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
      importedMessages: 2,
      reason: "reconciled missing session messages",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const rows = db
      .prepare(
        `SELECT message_id, content, transcript_entry_id
         FROM messages
         WHERE conversation_id = ?
         ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{
      message_id: number;
      content: string;
      transcript_entry_id: string | null;
    }>;
    expect(rows).toEqual([
      { message_id: 1, content: "", transcript_entry_id: null },
      {
        message_id: 2,
        content: "this is the user message that was skipped",
        transcript_entry_id: "entry-current-user-before-blank",
      },
      {
        message_id: 3,
        content: "current assistant content",
        transcript_entry_id: "entry-current-assistant-blank-id",
      },
    ]);

    const trustRows = db
      .prepare(
        `SELECT message_id, transcript_entry_id, trust_state, reason
         FROM message_transcript_anchor_trust
         WHERE conversation_id = ?
         ORDER BY message_id`,
      )
      .all(conversation!.conversationId) as Array<{
      message_id: number;
      transcript_entry_id: string | null;
      trust_state: string;
      reason: string;
    }>;
    expect(trustRows).toEqual([
      {
        message_id: 1,
        transcript_entry_id: "entry-current-assistant-blank-id",
        trust_state: "suspect",
        reason: "entry id content mismatch",
      },
      {
        message_id: 2,
        transcript_entry_id: "entry-current-user-before-blank",
        trust_state: "verified",
        reason: "message imported from transcript entry",
      },
      {
        message_id: 3,
        transcript_entry_id: "entry-current-assistant-blank-id",
        trust_state: "verified",
        reason: "message imported from transcript entry",
      },
    ]);

    const epochRow = db
      .prepare(
        `SELECT session_id, session_key, frontier_entry_id, frontier_seq, migration_mode, metadata_json
         FROM conversation_transcript_epochs
         WHERE conversation_id = ?`,
      )
      .get(conversation!.conversationId) as {
      session_id: string;
      session_key: string;
      frontier_entry_id: string | null;
      frontier_seq: number;
      migration_mode: string;
      metadata_json: string;
    };
    expect(epochRow).toEqual({
      session_id: sessionId,
      session_key: sessionKey,
      frontier_entry_id: null,
      frontier_seq: 0,
      migration_mode: "legacy_prefix",
      metadata_json: JSON.stringify({
        reason: "unproven transcript anchors",
        classification: "legacy_prefix",
      }),
    });
  });

  it("imports fresh post-tail messages when establishing a legacy-prefix epoch", async () => {
    const sessionId = "sqlite-afterturn-legacy-prefix-fresh-suffix-session";
    const sessionKey = "agent:main:sqlite-afterturn-legacy-prefix-fresh-suffix-session";
    const visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-fresh-user",
        parentId: "entry-model-snapshot",
        seq: 4,
        role: "user",
        message: { role: "user", content: "you there?" } satisfies AgentMessage,
        createdAt: "2026-07-08T16:45:51.306Z",
      },
      {
        entryId: "entry-fresh-assistant",
        parentId: "entry-fresh-user",
        seq: 5,
        role: "assistant",
        message: { role: "assistant", content: "I am here." } satisfies AgentMessage,
        createdAt: "2026-07-08T16:45:57.463Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [
          attachTranscriptEntryMeta(
            { role: "assistant", content: "" } satisfies AgentMessage,
            {
              entryId: "entry-stale-blank",
              parentId: null,
              timestamp: "2026-05-20T12:00:00.000Z",
            },
          ),
        ],
      }),
    ).resolves.toMatchObject({ ingestedCount: 1 });

    await expect(
      engine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "/tmp/ignored-lossless-sqlite-fresh-suffix.jsonl",
        messages: [] satisfies AgentMessage[],
        prePromptMessageCount: 0,
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
      "",
      "you there?",
      "I am here.",
    ]);

    const trustRows = db
      .prepare(
        `SELECT m.content, m.transcript_entry_id, t.trust_state, t.source
         FROM messages m
         LEFT JOIN message_transcript_anchor_trust t ON t.message_id = m.message_id
         WHERE m.conversation_id = ?
         ORDER BY m.seq`,
      )
      .all(conversation!.conversationId) as Array<{
      content: string;
      transcript_entry_id: string | null;
      trust_state: string | null;
      source: string | null;
    }>;
    expect(trustRows).toEqual([
      {
        content: "",
        transcript_entry_id: "entry-stale-blank",
        trust_state: "suspect",
        source: "projection-audit",
      },
      {
        content: "you there?",
        transcript_entry_id: "entry-fresh-user",
        trust_state: "verified",
        source: "transcript-import",
      },
      {
        content: "I am here.",
        transcript_entry_id: "entry-fresh-assistant",
        trust_state: "verified",
        source: "transcript-import",
      },
    ]);

    const epoch = await engine
      .getConversationStore()
      .getConversationTranscriptEpoch(conversation!.conversationId);
    expect(epoch).toMatchObject({
      frontierEntryId: null,
      frontierSeq: 0,
      migrationMode: "legacy_prefix",
    });
  });

  it("does not restamp a repeated same-content turn with a different timestamp", async () => {
    const sessionId = "sqlite-bootstrap-stale-id-repeat-session";
    const sessionKey = "agent:main:sqlite-bootstrap-stale-id-repeat-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-repeat-anchor",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "repeat anchor" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:31:00.000Z",
      },
      {
        entryId: "entry-repeat-current",
        parentId: "entry-repeat-anchor",
        seq: 2,
        role: "user",
        message: { role: "user", content: "ok" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:31:05.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [
          attachTranscriptEntryMeta(
            { role: "assistant", content: "repeat anchor" } satisfies AgentMessage,
            {
              entryId: "entry-repeat-anchor",
              parentId: null,
              timestamp: "2026-06-29T12:31:00.000Z",
            },
          ),
          attachTranscriptEntryMeta(
            { role: "user", content: "ok" } satisfies AgentMessage,
            {
              entryId: "entry-repeat-stale",
              parentId: "entry-repeat-anchor",
              timestamp: "2026-06-29T12:31:01.000Z",
            },
          ),
        ],
      }),
    ).resolves.toMatchObject({ ingestedCount: 2 });

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
    const rows = db
      .prepare(
        `SELECT content, transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{
      content: string;
      transcript_entry_id: string | null;
    }>;
    expect(rows).toEqual([
      { content: "repeat anchor", transcript_entry_id: "entry-repeat-anchor" },
      { content: "ok", transcript_entry_id: "entry-repeat-stale" },
      { content: "ok", transcript_entry_id: "entry-repeat-current" },
    ]);
  });

  it("blocks stale transcript id restamp for ambiguous same-second repeats", async () => {
    const sessionId = "sqlite-bootstrap-stale-id-ambiguous-session";
    const sessionKey = "agent:main:sqlite-bootstrap-stale-id-ambiguous-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-ambiguous-anchor",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "ambiguous anchor" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:32:00.000Z",
      },
      {
        entryId: "entry-ambiguous-current",
        parentId: "entry-ambiguous-anchor",
        seq: 2,
        role: "user",
        message: { role: "user", content: "ok" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:32:01.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [
          attachTranscriptEntryMeta(
            { role: "assistant", content: "ambiguous anchor" } satisfies AgentMessage,
            {
              entryId: "entry-ambiguous-anchor",
              parentId: null,
              timestamp: "2026-06-29T12:32:00.000Z",
            },
          ),
          attachTranscriptEntryMeta(
            { role: "user", content: "ok" } satisfies AgentMessage,
            {
              entryId: "entry-ambiguous-stale-a",
              parentId: "entry-ambiguous-anchor",
              timestamp: "2026-06-29T12:32:01.000Z",
            },
          ),
          attachTranscriptEntryMeta(
            { role: "user", content: "ok" } satisfies AgentMessage,
            {
              entryId: "entry-ambiguous-stale-b",
              parentId: "entry-ambiguous-stale-a",
              timestamp: "2026-06-29T12:32:01.000Z",
            },
          ),
        ],
      }),
    ).resolves.toMatchObject({ ingestedCount: 3 });

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
      reason: "reconcile stale transcript id ambiguous",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const rows = db
      .prepare(
        `SELECT content, transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{
      content: string;
      transcript_entry_id: string | null;
    }>;
    expect(rows).toEqual([
      { content: "ambiguous anchor", transcript_entry_id: "entry-ambiguous-anchor" },
      { content: "ok", transcript_entry_id: "entry-ambiguous-stale-a" },
      { content: "ok", transcript_entry_id: "entry-ambiguous-stale-b" },
    ]);
  });

  it("blocks stale transcript id restamp when projection entries are missing before it", async () => {
    const sessionId = "sqlite-bootstrap-stale-id-gap-session";
    const sessionKey = "agent:main:sqlite-bootstrap-stale-id-gap-session";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => [
      {
        entryId: "entry-gap-anchor",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "gap anchor" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:30:00.000Z",
      },
      {
        entryId: "entry-gap-missing",
        parentId: "entry-gap-anchor",
        seq: 2,
        role: "user",
        message: { role: "user", content: "missing before stale id" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:30:01.000Z",
      },
      {
        entryId: "entry-gap-current",
        parentId: "entry-gap-missing",
        seq: 3,
        role: "user",
        message: { role: "user", content: "stale id after gap" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:30:02.000Z",
      },
    ]);
    const { engine, db } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.ingestBatch({
        sessionId,
        sessionKey,
        messages: [
          attachTranscriptEntryMeta(
            { role: "assistant", content: "gap anchor" } satisfies AgentMessage,
            {
              entryId: "entry-gap-anchor",
              parentId: null,
              timestamp: "2026-06-29T12:30:00.000Z",
            },
          ),
          attachTranscriptEntryMeta(
            { role: "user", content: "stale id after gap" } satisfies AgentMessage,
            {
              entryId: "entry-gap-stale",
              parentId: "entry-gap-anchor",
              timestamp: "2026-06-29T12:30:02.000Z",
            },
          ),
        ],
      }),
    ).resolves.toMatchObject({ ingestedCount: 2 });

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
      reason: "reconcile stale transcript id gap",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const rows = db
      .prepare(
        `SELECT content, transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{
      content: string;
      transcript_entry_id: string | null;
    }>;
    expect(rows).toEqual([
      { content: "gap anchor", transcript_entry_id: "entry-gap-anchor" },
      { content: "stale id after gap", transcript_entry_id: "entry-gap-stale" },
    ]);
  });

  it("adopts a recent externalized tail message when the projection catches up", async () => {
    const sessionId = "sqlite-bootstrap-externalized-adopt-session";
    const sessionKey = "agent:main:sqlite-bootstrap-externalized-adopt-session";
    const fileText = `${"line about sqlite transcript projection\n".repeat(160)}closing notes`;
    const fileMessageContent = `<file name="projection.md" mime="text/markdown">${fileText}</file>`;
    let visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-externalized-anchor",
        parentId: null,
        seq: 1,
        role: "user",
        message: { role: "user", content: "anchor before file" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:28:00.000Z",
      },
    ];
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
    const { engine, db } = createEngineWithDepsOverridesAndDb(
      { readVisibleSessionTranscriptMessageEntries } satisfies Partial<LcmDependencies>,
      { largeFileTokenThreshold: 20 },
    );

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

    await expect(
      engine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "/tmp/ignored-lossless-sqlite-externalized-adopt.jsonl",
        messages: [
          { role: "user", content: "anchor before file" },
          { role: "user", content: fileMessageContent },
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

    visibleEntries = [
      visibleEntries[0]!,
      {
        entryId: "entry-externalized-file",
        parentId: "entry-externalized-anchor",
        seq: 2,
        role: "user",
        message: { role: "user", content: fileMessageContent } satisfies AgentMessage,
        createdAt: "2026-06-29T12:28:01.000Z",
      },
      {
        entryId: "entry-externalized-tail",
        parentId: "entry-externalized-file",
        seq: 3,
        role: "assistant",
        message: { role: "assistant", content: "tail after externalized file" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:28:02.000Z",
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
    expect(messages).toHaveLength(3);
    expect(messages[1]!.content).toContain("[LCM File: file_");
    expect(messages[2]!.content).toBe("tail after externalized file");
    const rows = db
      .prepare(
        `SELECT transcript_entry_id FROM messages WHERE conversation_id = ? ORDER BY seq`,
      )
      .all(conversation!.conversationId) as Array<{ transcript_entry_id: string | null }>;
    expect(rows.map((row) => row.transcript_entry_id)).toEqual([
      "entry-externalized-anchor",
      "entry-externalized-file",
      "entry-externalized-tail",
    ]);
  });

  it("caps existing-conversation projection tail imports after the overlap anchor", async () => {
    const sessionId = "sqlite-bootstrap-import-cap-session";
    const sessionKey = "agent:main:sqlite-bootstrap-import-cap-session";
    let visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
      {
        entryId: "entry-cap-anchor",
        parentId: null,
        seq: 1,
        role: "assistant",
        message: { role: "assistant", content: "anchor" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:27:00.000Z",
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
      visibleEntries[0]!,
      ...Array.from({ length: 60 }, (_, index) => ({
        entryId: `entry-cap-tail-${index}`,
        parentId: index === 0 ? "entry-cap-anchor" : `entry-cap-tail-${index - 1}`,
        seq: index + 2,
        role: "user" as const,
        message: { role: "user", content: `tail ${index}` } satisfies AgentMessage,
        createdAt: "2026-06-29T12:27:01.000Z",
      })),
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
      importedMessages: 50,
      reason: "reconcile import capped",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages).toHaveLength(51);
    expect(messages.at(-1)?.content).toBe("tail 49");
  });

  it("keeps an existing conversation at a legacy frontier for a no-overlap bootstrap projection", async () => {
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
    const { engine, db } = createEngineWithDepsOverridesAndDb({
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
      reason: "already bootstrapped",
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    expect(conversation).not.toBeNull();
    const messages = await engine.getConversationStore().getMessages(conversation!.conversationId);
    expect(messages.map((message) => message.content)).toEqual(["original user"]);
    const rows = db
      .prepare(
        `SELECT conversation_id, active FROM conversations WHERE session_key = ? ORDER BY conversation_id`,
      )
      .all(sessionKey) as Array<{ conversation_id: number; active: number }>;
    expect(rows).toHaveLength(1);
    expect(rows.map((row) => row.active)).toEqual([1]);

    const epoch = await engine
      .getConversationStore()
      .getConversationTranscriptEpoch(conversation!.conversationId);
    expect(epoch).toMatchObject({
      frontierEntryId: "entry-unrelated-user",
      migrationMode: "legacy_prefix",
    });

    visibleEntries = [
      ...visibleEntries,
      {
        entryId: "entry-after-legacy-frontier",
        parentId: "entry-unrelated-user",
        seq: 2,
        role: "assistant",
        message: { role: "assistant", content: "after legacy frontier" } satisfies AgentMessage,
        createdAt: "2026-06-29T12:11:01.000Z",
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

    const updatedMessages = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(updatedMessages.map((message) => message.content)).toEqual([
      "original user",
      "after legacy frontier",
    ]);
  });

  it("persists only post-frontier afterTurn output when an existing projection has no row overlap", async () => {
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
    expect(messages.map((message) => message.content)).toEqual([
      "original user",
      "unrelated assistant",
    ]);
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

  it("does not persist afterTurn runtime messages when the visible projection is empty", async () => {
    const sessionId = "sqlite-afterturn-empty-projection";
    const sessionKey = "agent:main:sqlite-afterturn-empty-projection";
    const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => []);
    const { engine } = createEngineWithDepsOverridesAndDb({
      readVisibleSessionTranscriptMessageEntries,
    } satisfies Partial<LcmDependencies>);

    await expect(
      engine.afterTurn({
        sessionId,
        sessionKey,
        sessionFile: "/tmp/ignored-lossless-sqlite-empty-projection.jsonl",
        messages: [
          { role: "user", content: "prompt" },
          { role: "assistant", content: "must not persist from empty projection" },
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
