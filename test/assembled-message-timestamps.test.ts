// OpenClaw requires `timestamp: number` (ms) on every AgentMessage and stamps
// user text from it, so assembled output must carry stable stored times.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { ContextAssembler } from "../src/assembler.js";
import { runLcmMigrations } from "../src/db/migration.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { FocusBriefStore } from "../src/store/focus-brief-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { cleanupEngineTestState, createEngine, createEngineWithDeps } from "./helpers.js";

afterEach(cleanupEngineTestState);

function timestampsOf(messages: AgentMessage[]): unknown[] {
  return messages.map((message) => (message as { timestamp?: unknown }).timestamp);
}

function expectFiniteTimestamps(messages: AgentMessage[]): void {
  expect(messages.length).toBeGreaterThan(0);
  for (const timestamp of timestampsOf(messages)) {
    expect(typeof timestamp).toBe("number");
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(() => new Date(timestamp as number).toISOString()).not.toThrow();
  }
}

describe("assembled message timestamps", () => {
  const dbs = new Set<DatabaseSync>();
  afterEach(() => {
    for (const db of dbs) db.close();
    dbs.clear();
  });

  it("stamps summaries, the focus brief and raw messages with their stored times", async () => {
    const db = new DatabaseSync(":memory:");
    dbs.add(db);
    runLcmMigrations(db, { fts5Available: false });
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const focusStore = new FocusBriefStore(db);
    const assembler = new ContextAssembler(conversationStore, summaryStore, "UTC", focusStore);
    const { conversationId } = await conversationStore.createConversation({
      sessionId: "timestamps-session",
    });
    const rows = await conversationStore.createMessagesBulk(
      [
        ["user", "Covered request."],
        ["assistant", "Covered reply."],
        ["user", "Later summarized request."],
        ["assistant", "Later summarized reply."],
        ["user", "Raw request that stays visible."],
        ["assistant", "Raw reply that stays visible."],
      ].map(([role, content], seq) => ({
        conversationId,
        seq,
        role: role as "user" | "assistant",
        content,
        tokenCount: 5,
      })),
    );
    db.prepare(
      `UPDATE messages SET created_at = '2026-01-03 04:05:06' WHERE message_id = ?`,
    ).run(rows[4]!.messageId);
    for (const row of rows) await summaryStore.appendContextMessage(conversationId, row.messageId);

    const coveredLatestAt = new Date("2026-01-01T00:00:00.000Z");
    const laterLatestAt = new Date("2026-01-02T00:00:00.000Z");
    for (const [summaryId, latestAt, sources] of [
      ["covered_summary", coveredLatestAt, rows.slice(0, 2)],
      ["later_summary", laterLatestAt, rows.slice(2, 4)],
    ] as const) {
      await summaryStore.insertSummary({
        summaryId,
        conversationId,
        kind: "leaf",
        depth: 0,
        content: `${summaryId} content.`,
        tokenCount: 5,
        latestAt,
        sourceMessageTokenCount: 10,
      });
      await summaryStore.linkSummaryToMessages(summaryId, sources.map((row) => row.messageId));
    }
    await summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "covered_summary",
    });
    const watermark = await focusStore.getCoveredWatermark(conversationId);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId,
      startOrdinal: 1,
      endOrdinal: 2,
      summaryId: "later_summary",
    });
    await focusStore.createFocusBrief({
      conversationId,
      prompt: "focus",
      content: "Focus brief content.",
      status: "active",
      tokenCount: 5,
      targetTokens: 12,
      coveredLatestAt: watermark.coveredLatestAt,
      coveredMessageSeq: watermark.coveredMessageSeq,
      sourceContextHash: "timestamps",
      sources: [{ summaryId: "covered_summary", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });

    const assemble = () =>
      assembler.assemble({ conversationId, tokenBudget: 10_000, freshTailCount: 8 });
    const first = await assemble();
    const byContent = (needle: string) =>
      first.messages.find((message) => JSON.stringify(message.content).includes(needle)) as
        | (AgentMessage & { timestamp?: unknown })
        | undefined;

    expectFiniteTimestamps(first.messages);
    expect(byContent("<focus_brief")?.timestamp).toBe(coveredLatestAt.getTime());
    expect(byContent("later_summary content.")?.timestamp).toBe(laterLatestAt.getTime());
    expect(byContent("Raw request that stays visible.")?.timestamp).toBe(
      Date.parse("2026-01-03T04:05:06.000Z"),
    );
    expect(byContent("Raw reply that stays visible.")?.role).toBe("assistant");
    // Later turns must not shift timestamps the host renders into user text.
    expect(timestampsOf((await assemble()).messages)).toEqual(timestampsOf(first.messages));
  });
});

it("keeps the summary time when a current-turn tool summary becomes assistant history", async () => {
  const engine = createEngineWithDeps({});
  const sessionId = "timestamps-tool-summary";
  const messages: AgentMessage[] = [
    { role: "user", content: "Inspect this file." },
    {
      role: "assistant",
      content: [{ type: "toolCall", id: "read-1", name: "read", arguments: {} }],
    } as AgentMessage,
    {
      role: "toolResult",
      toolCallId: "read-1",
      toolName: "read",
      content: [{ type: "text", text: "Evidence." }],
    } as AgentMessage,
  ];
  for (const message of messages) await engine.ingest({ sessionId, message });
  const store = engine.getConversationStore();
  const summaries = engine.getSummaryStore();
  const { conversationId } = (await store.getConversationForSession({ sessionId }))!;
  const rows = await store.getMessages(conversationId);
  const latestAt = new Date("2026-02-03T04:05:06.000Z");
  await summaries.insertSummary({
    summaryId: "tool_summary",
    conversationId,
    kind: "leaf",
    depth: 0,
    content: "Tool evidence summary.",
    tokenCount: 4,
    latestAt,
  });
  await summaries.linkSummaryToMessages("tool_summary", rows.slice(1).map((row) => row.messageId));
  await summaries.replaceContextRangeWithSummary({
    conversationId,
    startOrdinal: 1,
    endOrdinal: 2,
    summaryId: "tool_summary",
  });

  const assembled = await new ContextAssembler(store, summaries).assemble({
    conversationId,
    tokenBudget: 8000,
    freshTailCount: 4,
  });
  const toolSummary = assembled.messages.find((message) =>
    JSON.stringify(message.content).includes("Tool evidence summary."),
  ) as (AgentMessage & { timestamp?: unknown }) | undefined;

  expectFiniteTimestamps(assembled.messages);
  expect(toolSummary?.role).toBe("assistant");
  expect(toolSummary?.timestamp).toBe(latestAt.getTime());
});

it("stamps the prompt-recall cue with its newest quoted message time", async () => {
  const engine = createEngine();
  const sessionId = "timestamps-prompt-recall";
  for (const message of [
    { role: "user", content: "Reply with this exact memory marker: CRABPOT_TS_FACT is blue-42." },
    { role: "assistant", content: "CRABPOT_TS_FACT is blue-42." },
    { role: "user", content: "Say one neutral filler response." },
    { role: "assistant", content: "ok" },
  ] as AgentMessage[]) {
    await engine.ingest({ sessionId, message });
  }
  const conversationStore = engine.getConversationStore();
  const { conversationId } = (await conversationStore.getConversationForSession({ sessionId }))!;
  const rows = await conversationStore.getMessages(conversationId);
  const summaryStore = engine.getSummaryStore();
  await summaryStore.insertSummary({
    summaryId: "sum_timestamps_recall",
    conversationId,
    kind: "leaf",
    depth: 0,
    content: "Older setup turn established a recall fact, but this summary omits the exact key.",
    tokenCount: 12,
  });
  await summaryStore.linkSummaryToMessages(
    "sum_timestamps_recall",
    rows.slice(0, 2).map((row) => row.messageId),
  );
  await summaryStore.replaceContextRangeWithSummary({
    conversationId,
    startOrdinal: 0,
    endOrdinal: 1,
    summaryId: "sum_timestamps_recall",
  });
  const matchedTimes = await Promise.all(
    rows.slice(0, 2).map(async (row) =>
      (await conversationStore.getMessageById(row.messageId))!.createdAt.getTime(),
    ),
  );

  const prompt = "What is CRABPOT_TS_FACT? Answer with only the remembered value.";
  const result = await engine.assemble({
    sessionId,
    messages: [{ role: "user", content: prompt, timestamp: 1_800_000_000_000 }] as AgentMessage[],
    prompt,
    tokenBudget: 10_000,
  });
  const recallCue = result.messages.find((message) =>
    JSON.stringify(message.content).includes("<lossless_claw_prompt_recall>"),
  ) as (AgentMessage & { timestamp?: unknown }) | undefined;

  expect(recallCue).toBeDefined();
  expectFiniteTimestamps(result.messages);
  expect(recallCue?.timestamp).toBe(Math.max(...matchedTimes));
});
