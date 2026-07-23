// OpenClaw preserves verbatim user content in the host transcript projection
// while its runtime message face may collapse internal runs of spaces. These
// tests prove covered-frontier dedup treats those two faces as one turn without
// weakening byte-preserving storage or collapsing meaningful whitespace.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies, VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import {
  cleanupEngineTestState,
  createEngineWithDepsOverridesAndDb,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const LABEL = "tool policy update; the disabled tools are listed below:";
const VERBATIM = `${LABEL}\n\n      "exec",\n      "read",\n      "shell"`;
const COLLAPSED = `${LABEL}\n\n "exec",\n "read",\n "shell"`;

/** Create an engine whose persisted frontier comes from OpenClaw's SQLite projection. */
async function createProjectionHarness(params: {
  sessionId: string;
  sessionKey: string;
  persistedContent: string;
}) {
  const visibleEntries: VisibleSessionTranscriptMessageEntry[] = [
    {
      entryId: `${params.sessionId}-entry-user`,
      parentId: null,
      seq: 1,
      role: "user",
      message: { role: "user", content: params.persistedContent },
      createdAt: "2026-07-15T12:00:00.000Z",
    },
  ];
  const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => visibleEntries);
  const { engine } = createEngineWithDepsOverridesAndDb({
    readVisibleSessionTranscriptMessageEntries,
  } satisfies Partial<LcmDependencies>);
  const runtimeContext = {
    transcriptStorage: { kind: "sqlite" as const },
    sessionTarget: {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: "/tmp/openclaw-agent.sqlite",
    },
  };

  await expect(
    engine.bootstrap({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      runtimeContext,
    }),
  ).resolves.toMatchObject({ bootstrapped: true, importedMessages: 1 });

  return { engine, runtimeContext };
}

/** Run one after-turn batch against the same host-visible transcript frontier. */
async function runAfterTurn(params: {
  sessionId: string;
  sessionKey: string;
  persistedContent: string;
  runtimeContent: string;
  assistantContent?: string;
}) {
  const { engine, runtimeContext } = await createProjectionHarness({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    persistedContent: params.persistedContent,
  });
  const messages: AgentMessage[] = [
    { role: "user", content: params.runtimeContent },
    ...(params.assistantContent
      ? [{ role: "assistant", content: params.assistantContent } satisfies AgentMessage]
      : []),
  ];

  await engine.afterTurn({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: "/tmp/ignored-sqlite-projection.jsonl",
    messages,
    prePromptMessageCount: 0,
    tokenBudget: 4_096,
    runtimeContext,
  });

  const conversation = await engine.getConversationStore().getConversationForSession({
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
  });
  expect(conversation).not.toBeNull();
  return engine.getConversationStore().getMessages(conversation!.conversationId);
}

describe("whitespace-divergent covered-frontier dedup", () => {
  it("keeps the verbatim projection row and ingests only post-frontier output", async () => {
    const stored = await runAfterTurn({
      sessionId: "whitespace-covered-double-write",
      sessionKey: "agent:main:whitespace-covered-double-write",
      persistedContent: VERBATIM,
      runtimeContent: COLLAPSED,
      assistantContent: "updated the tool policy",
    });

    const userRows = stored.filter((message) => message.role === "user");
    expect(userRows).toHaveLength(1);
    expect(userRows[0]!.content).toBe(VERBATIM);
    expect(stored.some((message) => message.content === "updated the tool policy")).toBe(true);
  });

  it("keeps turns that differ beyond whitespace", async () => {
    const persisted = `${LABEL}\n\n      "exec",\n      "read"`;
    const runtime = `${LABEL}\n\n "gateway",\n "process"`;
    const { engine, runtimeContext } = await createProjectionHarness({
      sessionId: "whitespace-distinct-content",
      sessionKey: "agent:main:whitespace-distinct-content",
      persistedContent: persisted,
    });

    await engine.afterTurn({
      sessionId: "whitespace-distinct-content",
      sessionKey: "agent:main:whitespace-distinct-content",
      sessionFile: "/tmp/ignored-sqlite-projection.jsonl",
      messages: [{ role: "user", content: runtime }],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId: "whitespace-distinct-content",
      sessionKey: "agent:main:whitespace-distinct-content",
    });
    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it("keeps turns that replace a meaningful newline with a space", async () => {
    const sessionId = "whitespace-newline-distinct";
    const sessionKey = "agent:main:whitespace-newline-distinct";
    const persisted = `${LABEL}\n"exec"`;
    const runtime = `${LABEL} "exec"`;
    const { engine, runtimeContext } = await createProjectionHarness({
      sessionId,
      sessionKey,
      persistedContent: persisted,
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: "/tmp/ignored-sqlite-projection.jsonl",
      messages: [{ role: "user", content: runtime }],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored.filter((message) => message.role === "user")).toHaveLength(2);
  });

  it.each([
    ["leading", `  ${VERBATIM}`, ` ${COLLAPSED}`],
    ["trailing", `${VERBATIM}  `, `${COLLAPSED} `],
  ])("keeps turns with distinct %s boundary spaces", async (boundary, persisted, runtime) => {
    const sessionId = `whitespace-${boundary}-distinct`;
    const sessionKey = `agent:main:${sessionId}`;
    const { engine, runtimeContext } = await createProjectionHarness({
      sessionId,
      sessionKey,
      persistedContent: persisted,
    });

    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile: "/tmp/ignored-sqlite-projection.jsonl",
      messages: [{ role: "user", content: runtime }],
      prePromptMessageCount: 0,
      tokenBudget: 4_096,
      runtimeContext,
    });

    const conversation = await engine.getConversationStore().getConversationForSession({
      sessionId,
      sessionKey,
    });
    const stored = await engine
      .getConversationStore()
      .getMessages(conversation!.conversationId);
    expect(stored.filter((message) => message.role === "user")).toHaveLength(2);
  });
});
