import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { FocusBriefStore, hashFocusSourceContext } from "../src/store/focus-brief-store.js";
import { SummaryStore } from "../src/store/summary-store.js";

function createTestDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false });
  return db;
}

describe("FocusBriefStore", () => {
  const dbs = new Set<DatabaseSync>();

  afterEach(() => {
    for (const db of dbs) {
      db.close();
    }
    dbs.clear();
  });

  it("persists draft focus briefs outside the summary DAG", async () => {
    const db = createTestDb();
    dbs.add(db);
    const conversationStore = new ConversationStore(db, { fts5Available: false });
    const summaryStore = new SummaryStore(db, { fts5Available: false });
    const focusStore = new FocusBriefStore(db);

    const conversation = await conversationStore.createConversation({
      sessionId: "focus-store-session",
      sessionKey: "agent:main:telegram:direct:focus-store",
    });
    const [firstMessage, secondMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "Focus store first source.",
        tokenCount: 5,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "Focus store second source.",
        tokenCount: 5,
      },
    ]);
    await summaryStore.insertSummary({
      summaryId: "focus_store_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Focus store leaf detail.",
      tokenCount: 11,
      sourceMessageTokenCount: 10,
    });
    await summaryStore.linkSummaryToMessages("focus_store_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await summaryStore.insertSummary({
      summaryId: "focus_store_parent",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "Focus store parent detail.",
      tokenCount: 7,
      descendantTokenCount: 11,
      sourceMessageTokenCount: 10,
    });
    await summaryStore.linkSummaryToParents("focus_store_parent", ["focus_store_leaf"]);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "focus_store_parent",
    });

    const activeSummaries = await focusStore.getActiveContextSummaries(conversation.conversationId);
    expect(activeSummaries.map((summary) => summary.summaryId)).toEqual(["focus_store_parent"]);
    const watermark = await focusStore.getCoveredWatermark(conversation.conversationId);
    const sourceContextHash = hashFocusSourceContext(activeSummaries);
    const firstBrief = await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      sessionKey: "agent:main:telegram:direct:focus-store",
      prompt: "focus the store plan",
      content: "First focus draft.",
      status: "draft",
      tokenCount: 4,
      targetTokens: 7,
      coveredLatestAt: watermark.coveredLatestAt,
      coveredMessageSeq: watermark.coveredMessageSeq,
      sourceContextHash,
      generatorRunId: "run-one",
      generatorSessionKey: "agent:main:subagent:one",
      rawResultJson: "{}",
      sources: [
        { summaryId: "focus_store_parent", ordinal: activeSummaries[0]?.ordinal ?? null, role: "active_input" },
        { summaryId: "focus_store_parent", ordinal: activeSummaries[0]?.ordinal ?? null, role: "cited" },
      ],
      supersedeCurrentDrafts: true,
    });
    const secondBrief = await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      prompt: "replace the focus",
      content: "Second focus draft.",
      status: "draft",
      tokenCount: 5,
      targetTokens: 7,
      sourceContextHash,
      sources: [{ summaryId: "focus_store_leaf", ordinal: null, role: "expanded" }],
      supersedeCurrentDrafts: true,
    });

    expect(await focusStore.getLatestFocusBrief(conversation.conversationId)).toMatchObject({
      briefId: secondBrief.briefId,
      status: "draft",
      content: "Second focus draft.",
    });
    expect(await focusStore.getFocusBrief(firstBrief.briefId)).toMatchObject({
      briefId: firstBrief.briefId,
      status: "superseded",
    });
    expect(await focusStore.listFocusBriefs(conversation.conversationId)).toHaveLength(2);
    expect(await focusStore.getFocusBriefSources(firstBrief.briefId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summaryId: "focus_store_parent", role: "active_input" }),
        expect.objectContaining({ summaryId: "focus_store_parent", role: "cited" }),
      ]),
    );
    expect(await focusStore.getFocusBriefSources(secondBrief.briefId)).toEqual([
      expect.objectContaining({ summaryId: "focus_store_leaf", role: "expanded" }),
    ]);

    const activeBrief = await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      prompt: "activate the focus",
      content: "Active focus brief.",
      status: "active",
      tokenCount: 6,
      targetTokens: 12,
      coveredLatestAt: "2026-05-15 00:00:00",
      coveredMessageSeq: watermark.coveredMessageSeq,
      sourceContextHash,
      rawResultJson: JSON.stringify({ truncated: true }),
      sources: [{ summaryId: "focus_store_parent", ordinal: 0, role: "active_input" }],
      supersedeCurrentDrafts: true,
    });
    expect(await focusStore.getActiveFocusBrief(conversation.conversationId)).toMatchObject({
      briefId: activeBrief.briefId,
      status: "active",
    });
    expect(await focusStore.getFocusBrief(secondBrief.briefId)).toMatchObject({
      status: "superseded",
    });

    await focusStore.createFocusBrief({
      conversationId: conversation.conversationId,
      prompt: "failed refocus",
      content: "",
      status: "failed",
      error: "generation timed out",
      supersedeCurrentDrafts: false,
    });
    expect(await focusStore.getActiveFocusBrief(conversation.conversationId)).toMatchObject({
      briefId: activeBrief.briefId,
      status: "active",
    });
    expect(await focusStore.getLatestFocusBrief(conversation.conversationId)).toMatchObject({
      prompt: "failed refocus",
      status: "failed",
    });

    const [postFocusMessage] = await conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 2,
        role: "user",
        content: "Focus store post-focus follow-up.",
        tokenCount: 13,
      },
    ]);
    await summaryStore.insertSummary({
      summaryId: "focus_store_delta",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Focus store post-focus summary.",
      tokenCount: 9,
      sourceMessageTokenCount: 13,
      latestAt: new Date("2026-05-16T00:00:00Z"),
    });
    await summaryStore.linkSummaryToMessages("focus_store_delta", [postFocusMessage.messageId]);
    await summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 0,
      summaryId: "focus_store_delta",
    });

    await expect(focusStore.getFocusBriefDiagnostics(activeBrief)).resolves.toMatchObject({
      postFocusMessageCount: 1,
      postFocusSummaryCount: 1,
      postFocusTokenCount: 22,
      sourceContextChanged: true,
      stale: true,
      truncated: true,
    });

    expect(await focusStore.deactivateActiveFocusBriefs(conversation.conversationId)).toBe(1);
    expect(await focusStore.getActiveFocusBrief(conversation.conversationId)).toBeNull();
    expect(await focusStore.getFocusBrief(activeBrief.briefId)).toMatchObject({
      status: "inactive",
    });

    const contextItems = db
      .prepare(`SELECT item_type, summary_id FROM context_items WHERE conversation_id = ? ORDER BY ordinal`)
      .all(conversation.conversationId);
    expect(contextItems).toEqual([{ item_type: "summary", summary_id: "focus_store_delta" }]);
  });
});
