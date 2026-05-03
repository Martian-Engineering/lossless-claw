import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { RollupBuilder } from "../src/rollup-builder.js";
import { RollupStore } from "../src/store/rollup-store.js";
import { estimateTokens } from "../src/estimate-tokens.js";

function createStores() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  return {
    db,
    conversationStore: new ConversationStore(db, { fts5Available }),
    summaryStore: new SummaryStore(db, { fts5Available }),
    rollupStore: new RollupStore(db),
  };
}

describe("LCM temporal rollup MVP", () => {
  it("creates rollup schema and compatibility views", () => {
    const { db } = createStores();

    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollups'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollup_sources'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lcm_rollup_state'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'daily_rollups'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'weekly_rollups'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'monthly_rollups'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_conversation_created_at_idx'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_created_at_idx'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_conversation_created_at_jd_idx'"
        )
        .get()
    ).toBeTruthy();
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'messages_created_at_jd_idx'"
        )
        .get()
    ).toBeTruthy();
    const queryPlanRows = db
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT m.message_id
         FROM messages m
         WHERE m.conversation_id = ?
           AND julianday(m.created_at) < julianday(?)
           AND julianday(m.created_at) >= julianday(?)
         ORDER BY julianday(m.created_at) DESC
         LIMIT 1001`
      )
      .all(1, "2026-04-28T00:00:00.000Z", "2026-04-27T00:00:00.000Z") as Array<{
      detail: string;
    }>;
    expect(
      queryPlanRows.some((row) =>
        row.detail.includes("messages_conversation_created_at_jd_idx")
      )
    ).toBe(true);
  });

  it("builds a stable daily rollup and preserves rollup_id across rebuilds", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-stability",
      sessionKey: "agent:main:rollup-stability",
      title: "Rollup stability",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_rollup_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Decided to restore the daily rollup MVP.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_rollup_b",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content:
        "Completed a safe fallback audit and found the old wildcard path.",
      tokenCount: 12,
      sourceMessageTokenCount: 12,
      earliestAt: new Date("2026-04-27T12:00:00.000Z"),
      latestAt: new Date("2026-04-27T12:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    const first = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27"
    );
    expect(first?.status).toBe("ready");
    expect(first?.content).toContain("Daily Summary: 2026-04-27");
    expect(first?.source_summary_ids).toBe(
      JSON.stringify(["sum_rollup_a", "sum_rollup_b"])
    );

    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    const second = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27"
    );
    expect(second?.rollup_id).toBe(first?.rollup_id);
    expect(second?.source_message_count).toBe(2);
    expect(
      rollupStore
        .getRollupSources(second!.rollup_id)
        .map((source) => source.source_id)
    ).toEqual(["sum_rollup_a", "sum_rollup_b"]);
  });

  it("deletes an existing daily rollup when a direct rebuild finds no sources", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "empty-direct-day",
      sessionKey: "agent:main:empty-direct-day",
      title: "Empty direct day",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_empty_direct",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Temporary direct day rollup content.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
    ).toBeTruthy();

    db.prepare("DELETE FROM summaries WHERE summary_id = ?").run("sum_empty_direct");
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
    ).toBeNull();
  });

  it("builds daily rollups when local midnight is skipped by DST", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "midnight-gap-day",
      sessionKey: "agent:main:midnight-gap-day",
      title: "Midnight gap day",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_midnight_gap",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Captured work after a skipped local midnight.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-23T22:30:00.000Z"),
      latestAt: new Date("2026-04-23T22:45:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, {
      timezone: "Africa/Cairo",
    });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-24")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(
        conversation.conversationId,
        "day",
        "2026-04-24",
        "Africa/Cairo"
      )?.content
    ).toContain("skipped local midnight");
  });

  it("uses the requested UTC+13 local date key for daily rollups", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "utc-plus-day",
      sessionKey: "agent:main:utc-plus-day",
      title: "UTC plus day",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_utc_plus_day",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Captured work in the Pacific/Auckland local day.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-26T12:30:00.000Z"),
      latestAt: new Date("2026-04-26T13:00:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, {
      timezone: "Pacific/Auckland",
    });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);

    const rollup = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27",
      "Pacific/Auckland"
    );
    expect(rollup?.period_start).toBe("2026-04-26T12:00:00.000Z");
    expect(rollup?.period_end).toBe("2026-04-27T12:00:00.000Z");
    expect(rollup?.content).toContain("Pacific/Auckland local day");
  });

  it("looks up existing daily rollups inside the rebuild transaction", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "day-toctou",
      sessionKey: "agent:main:day-toctou",
      title: "Day TOCTOU",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_day_toctou",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Existing rollup lookup happens under the write lock.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });

    const lookupSpy = vi.spyOn(rollupStore, "getRollup");
    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);

    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy).toHaveBeenCalledWith(
      conversation.conversationId,
      "day",
      "2026-04-27",
      "UTC"
    );
    lookupSpy.mockRestore();
  });
});

import {
  createLcmRecentTool,
  __lcmRecentTestInternals,
} from "../src/tools/lcm-recent-tool.js";
import { createLcmRollupDebugTool } from "../src/tools/lcm-rollup-debug-tool.js";
import type { LcmDependencies } from "../src/types.js";

function makeRecentDeps(): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      largeFilesDir: "/tmp/lcm-large-files",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      promptAwareEviction: false,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      rollupDebugEnabled: false,
      proactiveThresholdCompactionMode: "deferred",
      summaryMaxOverageFactor: 3,
    },
    complete: async () => ({ content: [] }),
    callGateway: async () => ({}),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey: () => null,
    isSubagentSessionKey: () => false,
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => "/tmp/openclaw-agent",
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
  } as unknown as LcmDependencies;
}

function makeLcmForConversation(input: {
  conversationId: number;
  rollupStore: RollupStore;
  sessionId: string;
  timezone?: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return {
    timezone: input.timezone ?? "UTC",
    getRollupStore: () => input.rollupStore,
    getConversationStore: () => ({
      getConversationBySessionId: async () => ({
        conversationId: input.conversationId,
        sessionId: input.sessionId,
        title: null,
        bootstrappedAt: null,
        createdAt: now,
        updatedAt: now,
      }),
      getConversationBySessionKey: async () => null,
    }),
  };
}

describe("LCM sub-day window retrieval", () => {
  it("parses deterministic local-time windows with DST-safe UTC bounds", () => {
    const dateWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-03-08 1:30-3:30",
      "America/New_York"
    );
    expect(dateWindow.label).toBe("2026-03-08 1:30-3:30");
    expect(dateWindow.window?.startMinutes).toBe(90);
    expect(dateWindow.window?.endMinutes).toBe(210);
    expect(dateWindow.start.toISOString()).toBe("2026-03-08T06:30:00.000Z");
    expect(dateWindow.end.toISOString()).toBe("2026-03-08T07:30:00.000Z");

    const namedWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-27 morning",
      "Asia/Bangkok"
    );
    expect(namedWindow.label).toBe("2026-04-27 morning");
    expect(namedWindow.start.toISOString()).toBe("2026-04-26T23:00:00.000Z");
    expect(namedWindow.end.toISOString()).toBe("2026-04-27T05:00:00.000Z");

    const meridiemWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-27 4-8pm",
      "Asia/Bangkok"
    );
    expect(meridiemWindow.window?.startMinutes).toBe(16 * 60);
    expect(meridiemWindow.window?.endMinutes).toBe(20 * 60);

    expect(() =>
      __lcmRecentTestInternals.resolvePeriod(
        "date:2026-03-08 2:30-3:30",
        "America/New_York"
      )
    ).toThrow(/Nonexistent local time/);

    const nightWindow = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-27 night",
      "Pacific/Auckland"
    );
    expect(nightWindow.start.toISOString()).toBe("2026-04-27T10:00:00.000Z");
    expect(nightWindow.end.toISOString()).toBe("2026-04-27T12:00:00.000Z");

    const midnightTransition = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-03-28",
      "Asia/Gaza"
    );
    expect(midnightTransition.start.toISOString()).toBe(
      "2026-03-27T22:00:00.000Z"
    );

    const skippedMidnight = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-24",
      "Africa/Cairo"
    );
    expect(skippedMidnight.start.toISOString()).toBe(
      "2026-04-23T22:00:00.000Z"
    );

    const skippedMidnightNight = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-23 night",
      "Africa/Cairo"
    );
    expect(skippedMidnightNight.start.toISOString()).toBe(
      "2026-04-23T20:00:00.000Z"
    );
    expect(skippedMidnightNight.end.toISOString()).toBe(
      "2026-04-23T22:00:00.000Z"
    );

    const explicitEndOfDay = __lcmRecentTestInternals.resolvePeriod(
      "date:2026-04-23 22:00-24:00",
      "Africa/Cairo"
    );
    expect(explicitEndOfDay.window?.endMinutes).toBe(24 * 60);
    expect(explicitEndOfDay.start.toISOString()).toBe(
      "2026-04-23T20:00:00.000Z"
    );
    expect(explicitEndOfDay.end.toISOString()).toBe(
      "2026-04-23T22:00:00.000Z"
    );
  });

  it("falls back to leaf summaries inside the requested sub-day window", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "window-retrieval",
      sessionKey: "agent:main:window-retrieval",
      title: "Window retrieval",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_before_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Morning setup before the interesting window.",
      tokenCount: 8,
      latestAt: new Date("2026-04-27T08:00:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_inside_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content:
        "Eric Wilder npm ENOTEMPTY repair happened in the afternoon window.",
      tokenCount: 12,
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_spanning_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Spanning summary began before the window but overlaps it.",
      tokenCount: 11,
      earliestAt: new Date("2026-04-27T09:50:00.000Z"),
      latestAt: new Date("2026-04-27T11:10:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_after_window",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Evening connector rollout after the requested window.",
      tokenCount: 9,
      latestAt: new Date("2026-04-27T13:00:00.000Z"),
    });

    const lcm = {
      timezone: "Asia/Bangkok",
      getRollupStore: () => new RollupStore(db),
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "window-retrieval",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "window-retrieval",
    });

    const result = await tool.execute("call-window", {
      period: "date:2026-04-27 17:00-18:00",
      includeSources: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("sum_inside_window");
    expect(text).toContain("sum_spanning_window");
    expect(text).toContain("ENOTEMPTY repair");
    expect(text).not.toContain("sum_before_window");
    expect(text).not.toContain("sum_after_window");
    expect((result.details as { summaryIds?: string[] }).summaryIds).toEqual([
      "sum_spanning_window",
      "sum_inside_window",
    ]);
  });

  it("uses stored daily rollups, validates date periods, and falls back across mixed timestamp formats", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "recent-rollup-fallback",
      sessionKey: "agent:main:recent-rollup-fallback",
      title: "Recent rollup fallback",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_recent_rollup",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Stored daily rollup should be served for this local date.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_recent_fallback",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content:
        "Fallback summary with a space-separated SQLite timestamp should match the day.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
    });
    db.prepare(
      `UPDATE summaries
       SET created_at = ?, earliest_at = NULL, latest_at = NULL
       WHERE summary_id = ?`
    ).run("2026-04-26 10:00:00", "sum_recent_fallback");

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);

    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: makeLcmForConversation({
        conversationId: conversation.conversationId,
        rollupStore,
        sessionId: "recent-rollup-fallback",
      }) as never,
      sessionId: "recent-rollup-fallback",
    });

    const stored = await tool.execute("call-stored-day", {
      period: "date:2026-04-27",
      includeSources: true,
    });
    const storedText = (stored.content[0] as { text: string }).text;
    expect(storedText).toContain("sum_recent_rollup");
    expect(storedText).toContain("Stored daily rollup should be served");
    expect((stored.details as { status?: string }).status).toBe("ready");

    const hiddenStored = await tool.execute("call-hidden-stored-day", {
      period: "date:2026-04-27",
      includeSources: false,
    });
    const hiddenStoredText = (hiddenStored.content[0] as { text: string }).text;
    expect(hiddenStoredText).toContain("*Sources: omitted*");
    expect(hiddenStoredText).not.toContain("sum_recent_rollup");
    expect(
      (hiddenStored.details as { summaryIds?: string[] }).summaryIds
    ).toEqual([]);

    const fallback = await tool.execute("call-mixed-timestamp-day", {
      period: "date:2026-04-26",
      includeSources: true,
    });
    const fallbackText = (fallback.content[0] as { text: string }).text;
    expect(fallbackText).toContain("sum_recent_fallback");
    expect(fallbackText).toContain("**Confidence:** medium");
    expect(fallbackText).toContain("space-separated SQLite timestamp");
    expect(
      (fallback.details as { confidence?: string; usedFallback?: boolean })
        .usedFallback
    ).toBe(true);
    expect(
      (fallback.details as { confidence?: string; usedFallback?: boolean })
        .confidence
    ).toBe("medium");

    const hiddenFallback = await tool.execute("call-hidden-fallback-day", {
      period: "date:2026-04-26",
      includeSources: false,
    });
    const hiddenFallbackText = (hiddenFallback.content[0] as { text: string })
      .text;
    expect(hiddenFallbackText).toContain("*Sources: omitted*");
    expect(hiddenFallbackText).not.toContain("sum_recent_fallback");
    expect(
      (hiddenFallback.details as { summaryIds?: string[] }).summaryIds
    ).toEqual([]);

    const emptyFallback = await tool.execute("call-empty-fallback-day", {
      period: "date:2026-04-25",
      includeSources: false,
    });
    const emptyFallbackText = (emptyFallback.content[0] as { text: string })
      .text;
    expect(emptyFallbackText).toContain("**Confidence:** none");
    // P3 fix: an empty source list emits "none" regardless of
    // includeSources — saying "omitted" would falsely imply hidden ids exist.
    expect(emptyFallbackText).toContain("*Sources: none*");
    expect(emptyFallbackText).not.toContain("*Sources: omitted*");
    expect(
      (emptyFallback.details as { confidence?: string; usedFallback?: boolean })
        .confidence
    ).toBe("none");

    const emptyFallbackWithSources = await tool.execute(
      "call-empty-fallback-day-with-sources",
      {
        period: "date:2026-04-25",
        includeSources: true,
      }
    );
    const emptyFallbackWithSourcesText = (
      emptyFallbackWithSources.content[0] as { text: string }
    ).text;
    expect(emptyFallbackWithSourcesText).toContain("*Sources: none*");
    expect(emptyFallbackWithSourcesText).not.toContain("*Sources: omitted*");
    expect(
      (emptyFallbackWithSources.details as { summaryIds?: string[] }).summaryIds
    ).toEqual([]);

    const invalid = await tool.execute("call-invalid-date", {
      period: "date:2026-02-31",
    });
    expect((invalid.details as { error?: string }).error).toMatch(
      /real calendar date/
    );
  });

  it("orders fallback rows by the displayed effective time", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "fallback-effective-order",
      sessionKey: "agent:main:fallback-effective-order",
      title: "Fallback effective order",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_late_effective",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Late effective fallback should appear first.",
      tokenCount: 8,
      sourceMessageTokenCount: 8,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T11:55:00.000Z"),
    });
    await summaryStore.insertSummary({
      summaryId: "sum_early_effective",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Earlier effective fallback should appear second.",
      tokenCount: 8,
      sourceMessageTokenCount: 8,
      earliestAt: new Date("2026-04-27T11:00:00.000Z"),
      latestAt: new Date("2026-04-27T11:05:00.000Z"),
    });

    const lcm = {
      timezone: "UTC",
      getRollupStore: () => new RollupStore(db),
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "fallback-effective-order",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "fallback-effective-order",
    });

    const result = await tool.execute("call-effective-order", {
      period: "date:2026-04-27 10:00-12:00",
      includeSources: true,
    });

    expect((result.details as { summaryIds?: string[] }).summaryIds).toEqual([
      "sum_late_effective",
      "sum_early_effective",
    ]);
  });

  it("includes unsummarized raw messages in bounded fallback without treating them as summary IDs", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "raw-message-fallback",
      sessionKey: "agent:main:raw-message-fallback",
      title: "Raw message fallback",
    });

    const summarizedMessage = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 1,
      role: "user",
      content: "This raw message is already covered by a leaf summary.",
      tokenCount: 12,
    });
    const rawMessage = await conversationStore.createMessage({
      conversationId: conversation.conversationId,
      seq: 2,
      role: "assistant",
      content:
        "Unsummarized raw note: restored the Lexar worktree before the audit.",
      tokenCount: 14,
    });
    db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?").run(
      "2026-04-27T10:00:00.000Z",
      summarizedMessage.messageId
    );
    db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?").run(
      "2026-04-27T10:15:00.000Z",
      rawMessage.messageId
    );
    await summaryStore.insertSummary({
      summaryId: "sum_covers_raw_message",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Leaf summary for the already summarized raw message.",
      tokenCount: 10,
      sourceMessageTokenCount: 12,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:05:00.000Z"),
    });
    await summaryStore.linkSummaryToMessages("sum_covers_raw_message", [
      summarizedMessage.messageId,
    ]);

    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: makeLcmForConversation({
        conversationId: conversation.conversationId,
        rollupStore,
        sessionId: "raw-message-fallback",
      }) as never,
      sessionId: "raw-message-fallback",
    });

    const result = await tool.execute("call-raw-message-fallback", {
      period: "date:2026-04-27 10:10-10:30",
      includeSources: true,
    });
    const text = (result.content[0] as { text: string }).text;
    const details = result.details as {
      summaryIds?: string[];
      sourceIds?: string[];
      totalMatches?: number;
    };

    expect(text).toContain("Unsummarized raw note");
    expect(text).toContain(`message:${rawMessage.messageId}`);
    expect(text).not.toContain("already covered by a leaf summary");
    expect(details.summaryIds).toEqual([]);
    expect(details.sourceIds).toEqual([`message:${rawMessage.messageId}`]);
    expect(details.totalMatches).toBe(1);

    const hidden = await tool.execute("call-hidden-raw-message-fallback", {
      period: "date:2026-04-27 10:10-10:30",
      includeSources: false,
    });
    const hiddenText = (hidden.content[0] as { text: string }).text;
    const hiddenDetails = hidden.details as {
      summaryIds?: string[];
      sourceIds?: string[];
    };
    expect(hiddenText).toContain("Unsummarized raw note");
    expect(hiddenText).not.toContain(`message:${rawMessage.messageId}`);
    expect(hiddenDetails.summaryIds).toEqual([]);
    expect(hiddenDetails.sourceIds).toEqual([]);
  });

  it("hides fallback source IDs unless requested and clamps output budget", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "fallback-budget",
      sessionKey: "agent:main:fallback-budget",
      title: "Fallback budget",
    });

    for (let index = 0; index < 80; index += 1) {
      await summaryStore.insertSummary({
        summaryId: `sum_budget_${index}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: `Budgeted fallback item ${index} ${"detail ".repeat(80)}`,
        tokenCount: 90,
        sourceMessageTokenCount: 90,
        latestAt: new Date(`2026-04-27T10:${String(index % 60).padStart(2, "0")}:00.000Z`),
      });
    }

    const lcm = {
      timezone: "UTC",
      getRollupStore: () => new RollupStore(db),
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "fallback-budget",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "fallback-budget",
    });

    const result = await tool.execute("call-budget", {
      period: "date:2026-04-27 10:00-11:30",
      includeSources: false,
      maxOutputTokens: 500,
      globalMaxOutputTokens: 500,
      maxSourceSummaries: 80,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("*Sources: omitted*");
    expect(text).not.toContain("sum_budget_");
    expect(estimateTokens(text)).toBeLessThanOrEqual(500);
    expect((result.details as { summaryIds?: string[] }).summaryIds).toEqual([]);
  });

  it("surfaces SQL-level fallback truncation", async () => {
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "fallback-sql-cap",
      sessionKey: "agent:main:fallback-sql-cap",
      title: "Fallback SQL cap",
    });

    for (let index = 0; index < 1005; index += 1) {
      await summaryStore.insertSummary({
        summaryId: `sum_cap_${index}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: `Fallback cap item ${index}.`,
        tokenCount: 4,
        sourceMessageTokenCount: 4,
        latestAt: new Date(Date.UTC(2026, 3, 27, 10, 0, index)),
      });
    }

    const lcm = {
      timezone: "UTC",
      getRollupStore: () => new RollupStore(db),
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "fallback-sql-cap",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "fallback-sql-cap",
    });

    const result = await tool.execute("call-cap", {
      period: "date:2026-04-27",
      includeSources: false,
      maxSourceSummaries: 20,
    });
    const details = result.details as {
      confidence?: string;
      totalMatches?: number;
      truncated?: boolean;
      summaryIds?: string[];
    };
    expect((result.content[0] as { text: string }).text).toContain(
      "**Confidence:** medium"
    );
    expect(details.confidence).toBe("medium");
    expect(details.totalMatches).toBe(1005);
    expect(details.truncated).toBe(true);
    expect(details.summaryIds).toEqual([]);
  });

  it("uses fallback status for today's window even when a rollup exists", async () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "today-freshness",
        sessionKey: "agent:main:today-freshness",
        title: "Today freshness",
      });
      const todayKey = now.toISOString().slice(0, 10);

      await summaryStore.insertSummary({
        summaryId: "sum_today_fresh",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Fresh same-day work should come from bounded fallback.",
        tokenCount: 8,
        latestAt: now,
      });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, todayKey);
      db.prepare(
        `UPDATE lcm_rollups
         SET content = ?
         WHERE conversation_id = ? AND period_kind = 'day' AND period_key = ?`
      ).run(
        "STALE CURRENT DAY ROLLUP SHOULD NOT BE USED",
        conversation.conversationId,
        todayKey
      );

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "today-freshness",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "today-freshness",
      });

      const result = await tool.execute("call-today", {
        period: "today",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Fresh same-day work");
      expect(text).not.toContain("STALE CURRENT DAY ROLLUP");
      expect(
        (result.details as { status?: string; usedFallback?: boolean }).status
      ).toBe("fallback");
      expect(
        (result.details as { status?: string; usedFallback?: boolean })
          .usedFallback
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("formatSourcesLine emits 'none' for empty list regardless of includeSources (P3)", () => {
    const fmt = __lcmRecentTestInternals.formatSourcesLine;
    // Pre-fix `includeSources=false && empty` returned "omitted" which lied:
    // there was nothing to omit.
    expect(fmt([], false)).toBe("*Sources: none*");
    expect(fmt([], true)).toBe("*Sources: none*");
    // Hidden ids when caller asked to suppress.
    expect(fmt(["sum_a", "sum_b"], false)).toBe("*Sources: omitted*");
    // Visible ids when caller asked to include.
    expect(fmt(["sum_a", "sum_b"], true)).toBe("*Sources: sum_a, sum_b*");
  });

  it("returns null lastBuiltAt for index mode when built_at is missing (P2-9)", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "built-at-missing",
      sessionKey: "agent:main:built-at-missing",
      title: "built_at missing",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_built_at_missing",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Source for built_at-missing index test.",
      tokenCount: 7,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });
    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
    // Force built_at to empty string — pre-fix the index mode would coerce
    // this to a wall-clock new Date() and taint replay determinism.
    db.prepare(
      `UPDATE lcm_rollups
       SET built_at = ''
       WHERE conversation_id = ? AND period_kind = 'day' AND period_key = ?`
    ).run(conversation.conversationId, "2026-04-27");

    const lcm = {
      timezone: "UTC",
      getRollupStore: () => rollupStore,
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "built-at-missing",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "built-at-missing",
    });

    const result = await tool.execute("call-built-at-missing", {
      period: "date:2026-04-27",
      mode: "index",
      includeSources: true,
    });
    const details = result.details as { lastBuiltAt?: Date | null };
    expect(details.lastBuiltAt).toBeNull();
    const text = (result.content[0] as { text: string }).text;
    // Index entry header should fall back to "(unknown)" rather than a fake
    // wall-clock timestamp.
    expect(text).toMatch(/Built:\s*\(unknown\)/);
  });

  it("uses BEGIN IMMEDIATE in replaceRollupSources to acquire write lock upfront (P2-4)", async () => {
    // Smoke: with no outer transaction, replaceRollupSources should still
    // succeed. The fix (BEGIN -> BEGIN IMMEDIATE) only changes lock-acquisition
    // semantics, not API surface.
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "begin-immediate-smoke",
      sessionKey: "agent:main:begin-immediate-smoke",
      title: "BEGIN IMMEDIATE smoke",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_begin_immediate",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Source for replaceRollupSources smoke.",
      tokenCount: 6,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });
    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
    const rollup = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27",
      "UTC"
    );
    expect(rollup).toBeTruthy();
    if (!rollup) return;
    await expect(
      rollupStore.replaceRollupSources(rollup.rollup_id, [
        { type: "summary", id: "sum_begin_immediate", ordinal: 0 },
      ])
    ).resolves.toBeUndefined();

    // Source-level structural check: replaceRollupSources must declare
    // BEGIN IMMEDIATE so concurrent writers serialize on lock acquisition,
    // not at first write time.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const source = fs.readFileSync(
      path.join(path.dirname(here), "..", "src", "store", "rollup-store.ts"),
      "utf8"
    );
    const fnStart = source.indexOf("async replaceRollupSources(");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = source.slice(fnStart, fnStart + 600);
    expect(fnBody).toContain('"BEGIN IMMEDIATE"');
    expect(fnBody).not.toMatch(/withDatabaseTransaction\(\s*this\.db\s*,\s*"BEGIN"\s*,/);
  });

  it("clamps weeklyMaxTokens >= dailyMaxTokens and monthlyMaxTokens >= weeklyMaxTokens (P2-3)", () => {
    const { rollupStore } = createStores();
    // Pathological config: dailyMaxTokens > default weekly/monthly. Pre-fix
    // the constructor accepted this, leaving weeklyMaxTokens < dailyMaxTokens
    // — the aggregate trim path's `length > 1` exit then silently produced
    // a weekly that exceeded its declared cap (single oversized day case).
    const builder = new RollupBuilder(rollupStore, {
      timezone: "UTC",
      dailyMaxTokens: 200_000,
    });
    type Mut = {
      dailyMaxTokens: number;
      weeklyMaxTokens: number;
      monthlyMaxTokens: number;
    };
    const introspect = builder as unknown as Mut;
    expect(introspect.weeklyMaxTokens).toBeGreaterThanOrEqual(
      introspect.dailyMaxTokens
    );
    expect(introspect.monthlyMaxTokens).toBeGreaterThanOrEqual(
      introspect.weeklyMaxTokens
    );
  });

  it("returns deterministic order from listConversationsBySessionKey when created_at ties (P1-9)", async () => {
    const { db, conversationStore } = createStores();
    const sessionKey = "agent:main:tiebreak-stability";

    // Insert two conversations sharing both session_key and created_at,
    // simulating the low-resolution clock case (e.g. SQLite second-precision
    // ties under load). The unique active+session_key index forces one to be
    // archived; both rows still come back from listConversationsBySessionKey.
    const archived = await conversationStore.createConversation({
      sessionId: "tiebreak-A",
      sessionKey,
    });
    db.prepare(
      `UPDATE conversations SET active = 0, archived_at = datetime('now') WHERE conversation_id = ?`,
    ).run(archived.conversationId);
    await conversationStore.createConversation({
      sessionId: "tiebreak-B",
      sessionKey,
    });
    db.prepare(
      `UPDATE conversations
       SET created_at = '2026-04-27 12:00:00'
       WHERE session_key = ?`,
    ).run(sessionKey);

    const list1 = await conversationStore.listConversationsBySessionKey(sessionKey);
    const list2 = await conversationStore.listConversationsBySessionKey(sessionKey);
    const list3 = await conversationStore.listConversationsBySessionKey(sessionKey);

    expect(list1.length).toBe(2);
    const ids1 = list1.map((c) => c.conversationId);
    const ids2 = list2.map((c) => c.conversationId);
    const ids3 = list3.map((c) => c.conversationId);
    expect(ids2).toEqual(ids1);
    expect(ids3).toEqual(ids1);
    // Deterministic tiebreak puts the higher conversation_id first.
    expect(ids1[0]).toBeGreaterThan(ids1[1]);
  });

  it("returns deterministic order from getRecentSummaryFallback when timestamps tie (R3-FIX-1)", async () => {
    // Pre-fix: ORDER BY julianday(...) DESC alone has no PK tiebreaker.
    // Within one SQLite instance the rowid backstop usually keeps order
    // stable, but a `.dump | sqlite3 newdb` reimport flips it. We assert
    // the fix here by inserting two summaries with identical latest_at and
    // checking that the SQL ordering puts the lexicographically smaller
    // summary_id first (ASC tiebreak), the same property post-dump-restore
    // would also satisfy. Mirrors the c192ee8 fix for P1-9.
    const { db, conversationStore, summaryStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "fallback-tiebreak",
      sessionKey: "agent:main:fallback-tiebreak",
    });
    const sharedTime = new Date("2026-04-27T10:00:00.000Z");
    // Insert in "wrong" order so a missing tiebreaker would yield insertion-
    // order DESC (i.e. zeta first); the ASC tiebreak must put alpha first.
    await summaryStore.insertSummary({
      summaryId: "sum_zeta_tiebreak",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Z entry sharing latest_at.",
      tokenCount: 5,
      latestAt: sharedTime,
    });
    await summaryStore.insertSummary({
      summaryId: "sum_alpha_tiebreak",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "A entry sharing latest_at.",
      tokenCount: 5,
      latestAt: sharedTime,
    });
    // Force-update both rows to share created_at as well, removing any
    // chance of the strftime() coalesce sorting on a different field.
    db.prepare(
      `UPDATE summaries
       SET created_at = '2026-04-27 10:00:00',
           earliest_at = '2026-04-27T10:00:00.000Z'
       WHERE summary_id IN ('sum_zeta_tiebreak', 'sum_alpha_tiebreak')`,
    ).run();

    const callFallback = () =>
      __lcmRecentTestInternals.getRecentSummaryFallback(
        db,
        conversation.conversationId,
        new Date("2026-04-27T09:00:00.000Z"),
        new Date("2026-04-27T11:00:00.000Z"),
      );

    const a = callFallback();
    const b = callFallback();
    const c = callFallback();
    const idsA = a.summaries.map((s) => s.summary_id);
    const idsB = b.summaries.map((s) => s.summary_id);
    const idsC = c.summaries.map((s) => s.summary_id);
    expect(idsA).toContain("sum_alpha_tiebreak");
    expect(idsA).toContain("sum_zeta_tiebreak");
    expect(idsB).toEqual(idsA);
    expect(idsC).toEqual(idsA);
    // Deterministic ASC tiebreak puts the lexicographically smaller
    // summary_id first when latest_at ties (the property that survives
    // a SQL dump/restore round-trip, unlike rowid-backstop ordering).
    const alphaIdx = idsA.indexOf("sum_alpha_tiebreak");
    const zetaIdx = idsA.indexOf("sum_zeta_tiebreak");
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("performs the existing-row read inside the transaction in buildAggregateRollup (P1-8)", async () => {
    // Structural assertion: reading rollup-builder.ts source must show that
    // the FIRST `this.store.getRollup(` call inside buildAggregateRollup
    // appears AFTER `withDatabaseTransaction(` — mirrors buildDayRollup's
    // pattern. Pre-fix the call was outside the transaction, allowing a
    // concurrent writer to swap the row between read and replaceRollupSources
    // (FK violation rollback under load).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const source = fs.readFileSync(
      path.join(path.dirname(here), "..", "src", "rollup-builder.ts"),
      "utf8"
    );
    const buildAggregateStart = source.indexOf("async buildAggregateRollup(");
    expect(buildAggregateStart).toBeGreaterThan(-1);
    // Find the next function declaration so we don't accidentally read
    // beyond buildAggregateRollup.
    const afterAggregate = source.slice(buildAggregateStart);
    const nextFnIdx = (() => {
      const candidates = [
        afterAggregate.indexOf("\n  async build", 1),
        afterAggregate.indexOf("\n  private ", 1),
        afterAggregate.indexOf("\n}", 1),
      ].filter((idx) => idx > 0);
      return candidates.length > 0 ? Math.min(...candidates) : afterAggregate.length;
    })();
    const body = afterAggregate.slice(0, nextFnIdx);
    const txStart = body.indexOf("withDatabaseTransaction(");
    const firstGetRollup = body.indexOf("this.store.getRollup(");
    expect(firstGetRollup).toBeGreaterThan(-1);
    expect(txStart).toBeGreaterThan(-1);
    expect(firstGetRollup).toBeGreaterThan(txStart);
  });

  it("wraps both buildDayRollup empty-day cleanup branches in a transaction (R3-FIX-2)", async () => {
    // Structural assertion mirroring P1-8's: P1-8 closed the FK-consistency
    // hole in buildAggregateRollup and the non-empty buildDayRollup path, but
    // the empty-day cleanup branches still ran getRollup + deleteRollup
    // outside any transaction. A concurrent rebuild that upserts a fresh
    // rollup at the same (conv, kind, key) slot had its work destroyed by a
    // stale-empty-snapshot delete from a racing caller. The fix wraps both
    // empty-day branches (one in buildDailyRollups' loop, one in
    // buildDayRollup itself) in withDatabaseTransaction("BEGIN IMMEDIATE", …)
    // and reads getRollup INSIDE the transaction.
    //
    // A deterministic concurrency repro is hard; the structural assertion
    // is acceptable per the Round-1 spec (matches P1-8's approach).
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const source = fs.readFileSync(
      path.join(path.dirname(here), "..", "src", "rollup-builder.ts"),
      "utf8"
    );

    // Site 1: buildDailyRollups' empty-day branch.
    const dailyStart = source.indexOf("async buildDailyRollups(");
    expect(dailyStart).toBeGreaterThan(-1);
    const dailyBody = source.slice(dailyStart);
    const emptyBranch1 = dailyBody.indexOf("if (leafSummaries.length === 0)");
    expect(emptyBranch1).toBeGreaterThan(-1);
    // Bound the slice so we don't fall through into the non-empty branch's
    // own withDatabaseTransaction(...) (would mask a missing tx in the
    // empty-day branch).
    const branch1Region = dailyBody.slice(
      emptyBranch1,
      dailyBody.indexOf("\n      const fingerprint = computeFingerprint(", emptyBranch1)
    );
    const tx1 = branch1Region.indexOf("withDatabaseTransaction(");
    const get1 = branch1Region.indexOf("this.store.getRollup(");
    const del1 = branch1Region.indexOf("this.store.deleteRollup(");
    expect(tx1).toBeGreaterThan(-1);
    expect(get1).toBeGreaterThan(tx1);
    expect(del1).toBeGreaterThan(tx1);

    // Site 2: buildDayRollup's empty-day branch.
    const dayStart = source.indexOf("async buildDayRollup(");
    expect(dayStart).toBeGreaterThan(-1);
    const dayBody = source.slice(dayStart);
    const emptyBranch2 = dayBody.indexOf("if (summaries.length === 0)");
    expect(emptyBranch2).toBeGreaterThan(-1);
    const branch2Region = dayBody.slice(
      emptyBranch2,
      dayBody.indexOf("\n    const totalSourceTokens", emptyBranch2)
    );
    const tx2 = branch2Region.indexOf("withDatabaseTransaction(");
    const get2 = branch2Region.indexOf("this.store.getRollup(");
    const del2 = branch2Region.indexOf("this.store.deleteRollup(");
    expect(tx2).toBeGreaterThan(-1);
    expect(get2).toBeGreaterThan(tx2);
    expect(del2).toBeGreaterThan(tx2);
  });

  it("does not extract just the first nested day's Key Items section for weekly/monthly aggregate rollups", () => {
    // The regex `/##\s+Key Items[\s\S]*?(?=\n##\s|$)/` extracts up to the next
    // ## header, so the FIRST nested day's bullets — and only those — would
    // be returned for a weekly/monthly. The post-fix path emits a generic
    // content prefix instead.
    const weekly = [
      "# Weekly summary skeleton",
      "",
      "## 2026-04-20",
      "",
      "Day 1 narrative paragraph.",
      "",
      "## Key Items",
      "- day one bullet alpha",
      "- day one bullet beta",
      "",
      "## 2026-04-21",
      "",
      "Day 2 narrative paragraph.",
      "",
      "## Key Items",
      "- day two bullet gamma",
      "- day two bullet delta",
    ].join("\n");

    // PRE-FIX behavior would be: digest === "## Key Items\n- day one bullet alpha\n- day one bullet beta"
    // POST-FIX: digest is a generic prefix that ALSO includes the weekly skeleton header.
    const digestWithKind =
      __lcmRecentTestInternals.extractRollupDigest(weekly, 600, "week");
    expect(digestWithKind.startsWith("## Key Items")).toBe(false);
    expect(digestWithKind).toContain("Weekly summary skeleton");
    expect(digestWithKind).toContain("2026-04-20");

    // Defensive: even without the periodKind hint, embedded `## YYYY-MM-DD`
    // headers should trigger the same generic-prefix path.
    const digestWithoutKind = __lcmRecentTestInternals.extractRollupDigest(
      weekly,
      600,
    );
    expect(digestWithoutKind.startsWith("## Key Items")).toBe(false);
    expect(digestWithoutKind).toContain("Weekly summary skeleton");

    // Sanity: a real daily rollup's Key Items still flows through the
    // section-extraction branch and starts with "## Key Items".
    const daily = [
      "# Daily 2026-04-20",
      "",
      "Narrative.",
      "",
      "## Key Items",
      "- single-day bullet stays in digest",
    ].join("\n");
    const dailyDigest = __lcmRecentTestInternals.extractRollupDigest(
      daily,
      600,
      "day",
    );
    expect(dailyDigest.startsWith("## Key Items")).toBe(true);
    expect(dailyDigest).toContain("single-day bullet stays in digest");
  });

  it("includes sibling-conversation leaf content via relatedConversationIds for today fallback", async () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const sharedSessionKey = "agent:main:cross-conv-fallback";

      // Older sibling holds the actual leaf summaries for today.
      const sibling = await conversationStore.createConversation({
        sessionId: "cross-conv-fallback-sibling",
        sessionKey: sharedSessionKey,
        title: "Cross-conv sibling",
      });
      // Active conversation (created via /new) is empty.
      const active = await conversationStore.createConversation({
        sessionId: "cross-conv-fallback-active",
        sessionKey: sharedSessionKey,
        title: "Cross-conv active",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_sibling_today",
        conversationId: sibling.conversationId,
        kind: "leaf",
        depth: 0,
        content:
          "Sibling conversation captured today's work BEFORE /new fired, must surface on the active side.",
        tokenCount: 16,
        latestAt: now,
      });

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: active.conversationId,
            sessionId: "cross-conv-fallback-active",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => ({
            conversationId: active.conversationId,
            sessionKey: sharedSessionKey,
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          listConversationsBySessionKey: async () => [
            { conversationId: active.conversationId },
            { conversationId: sibling.conversationId },
          ],
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "cross-conv-fallback-active",
        sessionKey: sharedSessionKey,
      });

      const result = await tool.execute("call-cross-conv", {
        period: "today",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Sibling conversation captured today's work");
      expect(text).toContain("sum_sibling_today");
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes live-fallback digest entries when mode:'index' covers today's window", async () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "today-index-live",
        sessionKey: "agent:main:today-index-live",
        title: "Today index live",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_today_live_index",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content:
          "Live fallback digest content from same-day work that should appear in index mode.",
        tokenCount: 14,
        latestAt: now,
      });

      // No stored rollup at all for today — index mode previously returned
      // "(no rollups in window)" because liveFallbackKeys were ignored.
      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "today-index-live",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "today-index-live",
      });

      const result = await tool.execute("call-today-index", {
        period: "today",
        mode: "index",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Live fallback digest content");
      expect(text).not.toContain("(no rollups in window)");
      expect(text).toContain("(live fallback)");
      expect(
        (result.details as { status?: string; usedFallback?: boolean }).status
      ).toBe("fallback");
      expect(
        (result.details as { status?: string; usedFallback?: boolean })
          .usedFallback
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts stored + live entries in the index header (R2-FIX-3)", async () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "index-header-count",
        sessionKey: "agent:main:index-header-count",
        title: "Index header count",
      });

      // Two stored daily rollups + one live-fallback (today).
      for (const day of ["2026-04-25", "2026-04-26"]) {
        await summaryStore.insertSummary({
          summaryId: `sum_${day}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Stored leaf for ${day}.`,
          tokenCount: 10,
          sourceMessageTokenCount: 10,
          earliestAt: new Date(`${day}T10:00:00.000Z`),
          latestAt: new Date(`${day}T10:30:00.000Z`),
        });
      }
      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, "2026-04-25");
      await builder.buildDayRollup(conversation.conversationId, "2026-04-26");

      // Today live-fallback leaf.
      await summaryStore.insertSummary({
        summaryId: "sum_today_live_hdr",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Today live fallback leaf for header-count test.",
        tokenCount: 10,
        latestAt: now,
      });

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "index-header-count",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "index-header-count",
      });

      const result = await tool.execute("call-index-hdr", {
        period: "7d",
        mode: "index",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;

      // 2 stored + 1 live = 3 emitted `####` entries.
      const headerMatch = text.match(/### Rollup index \((\d+) periods?\)/);
      expect(headerMatch).not.toBeNull();
      expect(headerMatch?.[1]).toBe("3");

      const entryCount = (text.match(/^#### /gm) ?? []).length;
      expect(entryCount).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-truncates combined index output to effectiveOutputTokens after live-fallback append (R2-FIX-2)", async () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "index-budget-overflow",
        sessionKey: "agent:main:index-budget-overflow",
        title: "Index budget overflow",
      });

      // Stored rollups across SIX prior days. We need enough indexed.content
      // bulk that the combined output (indexed.content + live-fallback
      // digest sections) genuinely overflows the 500-token budget — i.e.
      // the post-fix re-truncation path at lcm-recent-tool.ts:1944 actually
      // FIRES, rather than the test silently passing because the content
      // happens to fit. Each stored day digest contributes ~one block to
      // indexed.content; the live-fallback day adds another.
      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      for (let day = 21; day <= 26; day += 1) {
        for (let i = 0; i < 6; i += 1) {
          await summaryStore.insertSummary({
            summaryId: `sum_d${day}_${i}`,
            conversationId: conversation.conversationId,
            kind: "leaf",
            depth: 0,
            content: `Day-${day}-leaf-${i} ` + "L".repeat(220),
            tokenCount: 80,
            sourceMessageTokenCount: 80,
            earliestAt: new Date(`2026-04-${day}T1${i}:00:00.000Z`),
            latestAt: new Date(`2026-04-${day}T1${i}:30:00.000Z`),
          });
        }
        await builder.buildDayRollup(
          conversation.conversationId,
          `2026-04-${day}`,
        );
      }

      // Today: live-fallback leaves the index path will splice in AFTER the
      // already-truncated `indexed.content`. Pre-fix this pushed the total
      // over `effectiveOutputTokens` because the live entries were appended
      // without re-truncation; the outer enforceResponseBudget then clamped
      // the WHOLE response (header + structure + sources line + hint),
      // stripping trailing structural lines like the `*Sources: ...*`
      // footer. Post-fix the inner re-truncation cuts only combinedContent
      // before outer wrapping is added, so the structure survives.
      for (let i = 0; i < 4; i += 1) {
        await summaryStore.insertSummary({
          summaryId: `sum_today_${i}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Today-leaf-${i} ` + "T".repeat(220),
          tokenCount: 60,
          sourceMessageTokenCount: 60,
          earliestAt: new Date(`2026-04-27T0${i}:00:00.000Z`),
          latestAt: new Date(`2026-04-27T0${i}:30:00.000Z`),
        });
      }

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "index-budget-overflow",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "index-budget-overflow",
      });

      // Tight budget: maxOutputTokens=500 forces effectiveOutputTokens=500.
      const result = await tool.execute("call-index-budget", {
        period: "7d",
        mode: "index",
        maxOutputTokens: 500,
        globalMaxOutputTokens: 500,
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      const details = result.details as {
        tokenCount: number;
        truncated?: boolean;
      };

      // (1) Budget honored. Pre-fix the outer enforceResponseBudget would
      //     also clamp this — so this assertion alone was tautological
      //     (R3-H ⚠ flagged this).
      expect(details.tokenCount).toBeLessThanOrEqual(500);

      // (2) The structural assembly survives the truncation pipeline.
      //     The inner re-truncation cuts combinedContent (rollup body)
      //     to fit `effectiveOutputTokens` BEFORE outer wrappers are
      //     added. We discriminate from a degenerate pipeline where the
      //     inner combined-assembly was skipped entirely (no header, no
      //     live-fallback section) by asserting both elements are still
      //     present in the body of the response.
      const indexHeader = text.match(/### Rollup index \((\d+) periods?\)/);
      expect(indexHeader).not.toBeNull();
      // R2-FIX-3 invariant: header period count matches the number of
      // emitted `####` entries. Re-asserted here so a future refactor
      // that broke either fix would surface in this test rather than
      // only the R2-FIX-3 test.
      const claimedCount = Number(indexHeader?.[1] ?? "0");
      const entryCount = (text.match(/^#### /gm) ?? []).length;
      expect(claimedCount).toBeGreaterThan(0);
      expect(claimedCount).toBe(entryCount);

      // (3) The live-fallback section header for today is present —
      //     proves the index-mode + live-fallback combined-content path
      //     was actually exercised (rather than e.g. silently falling
      //     through to a different rendering). Pre-R2-FIX-2 the
      //     truncation could still emit this header; the value of this
      //     assertion is that a refactor which accidentally re-routed
      //     index-mode to a path that drops the live-fallback header
      //     entirely would now fail the test.
      expect(text).toContain("(live fallback)");

      // (4) The truncated flag survived. With six prior-day digests +
      //     a live-fallback today, combinedContent overflows 500 tokens
      //     and SOMETHING in the truncation pipeline must have flipped
      //     `truncated`. Whether the inner re-truncation (R2-FIX-2) or
      //     the outer enforceResponseBudget set it is implementation
      //     detail; what matters externally is that the caller sees an
      //     accurate truncation signal. (The R2-H finding was that the
      //     pre-R2-FIX-2 path could under-report `truncated` when the
      //     outer happened to not fire — see audit/pr516/round2-B-*.md.)
      expect(details.truncated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders digest-style listing for mode:'index' on the global fallback path (R2-FIX-1)", async () => {
    const now = new Date("2026-04-27T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "global-fallback-index",
        sessionKey: "agent:main:global-fallback-index",
        title: "Global fallback index",
      });

      // Drop a leaf summary in the recent window. NO stored rollup at all,
      // and we use a sub-day "last 30m" period whose resolution.kind is
      // undefined — that bypasses every coverage path and falls through to
      // the global fallback at `rollupContent == null`. Pre-fix that path
      // unconditionally rendered renderFallbackRollupSection's full content,
      // ignoring mode:'index'.
      await summaryStore.insertSummary({
        summaryId: "sum_global_fb_idx",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content:
          "FALLBACK_LONG_BODY_THAT_SHOULD_BE_DIGESTED_NOT_FULLY_RENDERED_INTO_THE_RESPONSE_BECAUSE_INDEX_MODE_IS_DIGEST_STYLE",
        tokenCount: 14,
        latestAt: new Date("2026-04-27T11:55:00.000Z"),
      });

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "global-fallback-index",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "global-fallback-index",
      });

      const result = await tool.execute("call-global-fb-index", {
        period: "last 30m",
        mode: "index",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;

      // Index-mode shape: a `### Rollup index (1 period)` header plus a
      // `#### <kind>/<label> (live fallback)` entry. Pre-fix the global
      // fallback always rendered the full-content "No pre-built rollup
      // available. Here's what LCM captured for this period:" preamble —
      // index mode silently violated.
      expect(text).toContain("### Rollup index (1 period)");
      expect(text).toContain("(live fallback)");
      expect(text).toContain("Status: fallback | Built: (live)");
      expect(text).not.toContain(
        "Here's what LCM captured for this period",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports failed stored rollups as degraded fallback responses", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "failed-rollup-fallback",
      sessionKey: "agent:main:failed-rollup-fallback",
      title: "Failed rollup fallback",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_failed_rollup_fallback",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Fallback should explain that the stored daily rollup failed.",
      tokenCount: 8,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
    db.prepare(
      `UPDATE lcm_rollups
       SET status = 'failed', error_text = ?
       WHERE conversation_id = ? AND period_kind = 'day' AND period_key = ?`
    ).run("summarizer timeout", conversation.conversationId, "2026-04-27");

    const now = new Date("2026-04-29T12:00:00.000Z");
    const lcm = {
      timezone: "UTC",
      getRollupStore: () => rollupStore,
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "failed-rollup-fallback",
          title: null,
          bootstrappedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "failed-rollup-fallback",
    });

    const result = await tool.execute("call-failed-rollup", {
      period: "date:2026-04-27",
      includeSources: false,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("**Status:** fallback");
    expect(text).toContain("**Degraded:** Stored day rollup is failed: summarizer timeout.");
    expect(text).toContain("Fallback should explain");
    expect((result.details as { degradedReason?: string }).degradedReason).toBe(
      "Stored day rollup is failed: summarizer timeout."
    );
  });

  it("bypasses a stored day rollup when pending rebuild touches that day", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-prior-day",
      sessionKey: "agent:main:pending-prior-day",
      title: "Pending prior day",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_pending_prior_day",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Fresh prior-day work should not be hidden behind a stale ready rollup.",
      tokenCount: 10,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });
    rollupStore.upsertRollup({
      rollup_id: "rollup_pending_prior_day",
      conversation_id: conversation.conversationId,
      period_kind: "day",
      period_key: "2026-04-27",
      period_start: "2026-04-27T00:00:00.000Z",
      period_end: "2026-04-28T00:00:00.000Z",
      timezone: "UTC",
      content: "STALE READY DAY ROLLUP SHOULD NOT BE USED",
      token_count: 10,
      source_summary_ids: JSON.stringify([]),
      source_message_count: 0,
      source_token_count: 0,
      status: "ready",
      coverage_start: null,
      coverage_end: null,
      summarizer_model: null,
      source_fingerprint: null,
    });
    rollupStore.upsertState(conversation.conversationId, {
      timezone: "UTC",
      last_message_at: "2026-04-27T10:05:00.000Z",
      pending_rebuild: 1,
    });

    const now = new Date("2026-04-29T12:00:00.000Z");
    const lcm = {
      timezone: "UTC",
      getRollupStore: () => rollupStore,
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "pending-prior-day",
          title: null,
          bootstrappedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "pending-prior-day",
    });

    const result = await tool.execute("call-pending-prior-day", {
      period: "date:2026-04-27",
      includeSources: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("**Status:** fallback");
    expect(text).toContain("**Degraded:** Rollup rebuild is pending for 2026-04-27");
    expect(text).toContain("Fresh prior-day work");
    expect(text).not.toContain("STALE READY DAY ROLLUP");
    expect(
      (result.details as { usedFallback?: boolean; degradedReason?: string }).usedFallback
    ).toBe(true);
  });

  it("bypasses stored day rollups when rebuild is pending without a message timestamp", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "pending-summary-only",
      sessionKey: "agent:main:pending-summary-only",
      title: "Pending summary only",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_pending_summary_only",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Summary-only repair should be visible through fallback.",
      tokenCount: 10,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });
    rollupStore.upsertRollup({
      rollup_id: "rollup_pending_summary_only",
      conversation_id: conversation.conversationId,
      period_kind: "day",
      period_key: "2026-04-27",
      period_start: "2026-04-27T00:00:00.000Z",
      period_end: "2026-04-28T00:00:00.000Z",
      timezone: "UTC",
      content: "STALE SUMMARY-ONLY ROLLUP SHOULD NOT BE USED",
      token_count: 10,
      source_summary_ids: JSON.stringify([]),
      source_message_count: 0,
      source_token_count: 0,
      status: "ready",
      coverage_start: null,
      coverage_end: null,
      summarizer_model: null,
      source_fingerprint: null,
    });
    rollupStore.upsertState(conversation.conversationId, {
      timezone: "UTC",
      pending_rebuild: 1,
    });

    const now = new Date("2026-04-29T12:00:00.000Z");
    const lcm = {
      timezone: "UTC",
      getRollupStore: () => rollupStore,
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "pending-summary-only",
          title: null,
          bootstrappedAt: null,
          createdAt: now,
          updatedAt: now,
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRecentTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "pending-summary-only",
    });

    const result = await tool.execute("call-pending-summary-only", {
      period: "date:2026-04-27",
      includeSources: true,
    });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("**Status:** fallback");
    expect(text).toContain("**Degraded:** Rollup rebuild is pending, so stored day rollups were bypassed.");
    expect(text).toContain("Summary-only repair");
    expect(text).not.toContain("STALE SUMMARY-ONLY ROLLUP");
  });

  it("combines complete prior daily rollups with live fallback for 7d", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "seven-day-live",
        sessionKey: "agent:main:seven-day-live",
        title: "Seven day live",
      });
      const priorDays = [
        "2026-04-22",
        "2026-04-23",
        "2026-04-24",
        "2026-04-25",
        "2026-04-26",
        "2026-04-27",
      ];
      for (const day of priorDays) {
        await summaryStore.insertSummary({
          summaryId: `sum_${day}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Completed archived work for ${day}.`,
          tokenCount: 8,
          latestAt: new Date(`${day}T10:00:00.000Z`),
        });
      }
      await summaryStore.insertSummary({
        summaryId: "sum_today_live",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Fresh current-day work should use live fallback.",
        tokenCount: 8,
        latestAt: now,
      });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      for (const day of priorDays) {
        await builder.buildDayRollup(conversation.conversationId, day);
      }

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "seven-day-live",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "seven-day-live",
      });

      const result = await tool.execute("call-7d", {
        period: "7d",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Completed archived work for 2026-04-22");
      expect(text).toContain("Fresh current-day work should use live fallback");
      expect((result.details as { usedFallback?: boolean }).usedFallback).toBe(
        true
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not treat days with unsummarized raw messages as covered by missing rollups", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "seven-day-raw-gap",
        sessionKey: "agent:main:seven-day-raw-gap",
        title: "Seven day raw gap",
      });
      await summaryStore.insertSummary({
        summaryId: "sum_raw_gap_rollup_source",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Leaf summary for the only prebuilt day.",
        tokenCount: 8,
        latestAt: new Date("2026-04-22T10:00:00.000Z"),
      });
      const rawMessage = await conversationStore.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "Unsummarized raw gap work should force degraded fallback.",
        tokenCount: 11,
      });
      db.prepare("UPDATE messages SET created_at = ? WHERE message_id = ?").run(
        "2026-04-23T10:00:00.000Z",
        rawMessage.messageId
      );
      rollupStore.upsertRollup({
        rollup_id: "rollup_raw_gap_prebuilt",
        conversation_id: conversation.conversationId,
        period_kind: "day",
        period_key: "2026-04-22",
        period_start: "2026-04-22T00:00:00.000Z",
        period_end: "2026-04-23T00:00:00.000Z",
        timezone: "UTC",
        content: "STORED PARTIAL ROLLUP SHOULD NOT MASK RAW GAP",
        token_count: 8,
        source_summary_ids: JSON.stringify(["sum_raw_gap_rollup_source"]),
        source_message_count: 1,
        source_token_count: 8,
        status: "ready",
        coverage_start: "2026-04-22T10:00:00.000Z",
        coverage_end: "2026-04-22T10:00:00.000Z",
        summarizer_model: null,
        source_fingerprint: null,
      });

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "seven-day-raw-gap",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "seven-day-raw-gap",
      });

      const result = await tool.execute("call-7d-raw-gap", {
        period: "7d",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Unsummarized raw gap work");
      expect(text).toContain(`message:${rawMessage.messageId}`);
      expect(text).not.toContain("STORED PARTIAL ROLLUP");
      expect((result.details as { status?: string; usedFallback?: boolean }).status).toBe(
        "fallback"
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats inactive days as covered when combining 7d rollups", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "seven-day-sparse",
        sessionKey: "agent:main:seven-day-sparse",
        title: "Seven day sparse",
      });

      for (let index = 0; index < 25; index += 1) {
        await summaryStore.insertSummary({
          summaryId: `sum_sparse_${index}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Sparse inactive-day item ${index}.`,
          tokenCount: 8,
          latestAt: new Date(`2026-04-22T10:${String(index).padStart(2, "0")}:00.000Z`),
        });
      }

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, "2026-04-22");

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "seven-day-sparse",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "seven-day-sparse",
      });

      const result = await tool.execute("call-7d-sparse", {
        period: "7d",
        includeSources: true,
      });
      const details = result.details as {
        status?: string;
        summaryIds?: string[];
      };
      expect(details.status).toBe("ready");
      expect(details.summaryIds).toHaveLength(25);
    } finally {
      vi.useRealTimers();
    }
  });

  it("caps combined multi-day rollups by dropping older days first", async () => {
    const now = new Date("2026-04-29T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "seven-day-budget",
        sessionKey: "agent:main:seven-day-budget",
        title: "Seven day budget",
      });
      const priorDays = [
        "2026-04-23",
        "2026-04-24",
        "2026-04-25",
        "2026-04-26",
        "2026-04-27",
        "2026-04-28",
      ];

      for (const day of priorDays) {
        await summaryStore.insertSummary({
          summaryId: `sum_budget_rollup_${day}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Rollup seed for ${day}.`,
          tokenCount: 10,
          sourceMessageTokenCount: 10,
          latestAt: new Date(`${day}T10:00:00.000Z`),
        });
      }

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      for (const day of priorDays) {
        await expect(
          builder.buildDayRollup(conversation.conversationId, day)
        ).resolves.toBe(true);
        db.prepare(
          `UPDATE lcm_rollups
           SET content = ?, token_count = ?, source_summary_ids = ?
           WHERE conversation_id = ? AND period_kind = 'day' AND period_key = ?`
        ).run(
          `Rollup payload ${day}. ${"detail ".repeat(1000)}`,
          10_000,
          JSON.stringify([`sum_budget_rollup_${day}`]),
          conversation.conversationId,
          day
        );
      }

      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: makeLcmForConversation({
          conversationId: conversation.conversationId,
          rollupStore,
          sessionId: "seven-day-budget",
          now,
        }) as never,
        sessionId: "seven-day-budget",
      });

      const result = await tool.execute("call-7d-budget", {
        period: "7d",
        includeSources: true,
        maxOutputTokens: 700,
        globalMaxOutputTokens: 700,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("earlier rollups omitted to fit budget");
      expect(text).not.toContain("Rollup payload 2026-04-23");
      expect(text).toContain("Rollup payload 2026-04-28");
      expect((result.details as { truncated?: boolean }).truncated).toBe(true);
      expect(estimateTokens(text)).toBeLessThanOrEqual(700);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("LCM weekly and monthly rollups", () => {
  it("rebuilds a day rollup when content changes without changing ids or tokens", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "fingerprint-rebuild",
      sessionKey: "agent:main:fingerprint-rebuild",
      title: "Fingerprint rebuild",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_same",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Alpha work item.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    const first = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-27"
    );
    expect(first?.content).toContain("Alpha work item");

    rollupStore.db
      .prepare(
        `UPDATE summaries
         SET content = ?
         WHERE summary_id = ?`
      )
      .run("Bravo work item.", "sum_same");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
    try {
      const result = await builder.buildDailyRollups(conversation.conversationId, {
        forceCurrentDay: true,
        daysBack: 2,
      });
      expect(result.built).toBeGreaterThan(0);
      const second = rollupStore.getRollup(
        conversation.conversationId,
        "day",
        "2026-04-27"
      );
      expect(second?.rollup_id).toBe(first?.rollup_id);
      expect(second?.content).toContain("Bravo work item");
      expect(second?.source_fingerprint).not.toBe(first?.source_fingerprint);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid plain dates", async () => {
    expect(() =>
      __lcmRecentTestInternals.resolvePeriod("date:2026-02-30", "UTC")
    ).toThrow(/real calendar date/i);
    expect(() =>
      __lcmRecentTestInternals.resolvePeriod("date:2026-13-01", "UTC")
    ).toThrow(/real calendar date/i);
  });

  it("builds week and month aggregates whose boundaries skip local midnight", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const weeklyConversation = await conversationStore.createConversation({
      sessionId: "aggregate-week-midnight-gap",
      sessionKey: "agent:main:aggregate-week-midnight-gap",
      title: "Aggregate week midnight gap",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_tehran_week_gap",
      conversationId: weeklyConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Weekly aggregate began after a skipped local midnight.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2021-03-21T20:45:00.000Z"),
      latestAt: new Date("2021-03-21T21:00:00.000Z"),
    });
    const weeklyBuilder = new RollupBuilder(rollupStore, {
      timezone: "Asia/Tehran",
    });
    await expect(
      weeklyBuilder.buildDayRollup(weeklyConversation.conversationId, "2021-03-22")
    ).resolves.toBe(true);
    await expect(
      weeklyBuilder.buildWeeklyRollup(weeklyConversation.conversationId, "2021-03-22")
    ).resolves.toBe(true);

    const monthlyConversation = await conversationStore.createConversation({
      sessionId: "aggregate-month-midnight-gap",
      sessionKey: "agent:main:aggregate-month-midnight-gap",
      title: "Aggregate month midnight gap",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_cairo_month_gap",
      conversationId: monthlyConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Monthly aggregate began after a skipped local midnight.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2014-07-31T22:30:00.000Z"),
      latestAt: new Date("2014-07-31T22:45:00.000Z"),
    });
    const monthlyBuilder = new RollupBuilder(rollupStore, {
      timezone: "Africa/Cairo",
    });
    await expect(
      monthlyBuilder.buildDayRollup(monthlyConversation.conversationId, "2014-08-01")
    ).resolves.toBe(true);
    await expect(
      monthlyBuilder.buildMonthlyRollup(monthlyConversation.conversationId, "2014-08")
    ).resolves.toBe(true);
  });

  it("rebuilds stale day and aggregate rows even when fingerprints match", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "stale-fingerprint-rebuild",
      sessionKey: "agent:main:stale-fingerprint-rebuild",
      title: "Stale fingerprint rebuild",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_stale_rebuild",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Stale rollup should become ready again.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
    const day = rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27");
    rollupStore.markStale(day!.rollup_id);

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
    try {
      const daily = await builder.buildDailyRollups(conversation.conversationId, {
        forceCurrentDay: true,
        daysBack: 2,
      });
      expect(daily.built).toBeGreaterThan(0);
      expect(
        rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
          ?.status
      ).toBe("ready");
    } finally {
      vi.useRealTimers();
    }

    await builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27");
    const week = rollupStore.getRollup(
      conversation.conversationId,
      "week",
      "2026-04-27"
    );
    rollupStore.markStale(week!.rollup_id);
    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(conversation.conversationId, "week", "2026-04-27")
        ?.status
    ).toBe("ready");
  });

  it("does not build ready aggregate rollups from stale daily sources", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "stale-daily-aggregate",
      sessionKey: "agent:main:stale-daily-aggregate",
      title: "Stale daily aggregate",
    });
    const weekDays = [
      "2026-04-27",
      "2026-04-28",
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ];
    for (const day of weekDays) {
      await summaryStore.insertSummary({
        summaryId: `sum_stale_daily_${day}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: `Daily source for ${day}.`,
        tokenCount: 10,
        sourceMessageTokenCount: 10,
        latestAt: new Date(`${day}T10:00:00.000Z`),
      });
    }

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    for (const day of weekDays) {
      await expect(
        builder.buildDayRollup(conversation.conversationId, day)
      ).resolves.toBe(true);
    }
    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);

    const staleDay = rollupStore.getRollup(
      conversation.conversationId,
      "day",
      "2026-04-29"
    );
    expect(staleDay).toBeTruthy();
    rollupStore.markStale(staleDay!.rollup_id);

    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(false);
    expect(
      rollupStore.getRollup(conversation.conversationId, "week", "2026-04-27")
    ).toBeNull();
  });

  it("builds aggregate week/month rollups from stable daily rollups", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "aggregate-rollups",
      sessionKey: "agent:main:aggregate-rollups",
      title: "Aggregate rollups",
    });

    const aggregateDays = [
      ...Array.from({ length: 30 }, (_, index) =>
        `2026-04-${String(index + 1).padStart(2, "0")}`
      ),
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ];
    const specialContent = new Map([
      ["2026-04-27", "Monday decision completed."],
      ["2026-04-28", "Tuesday rollout shipped."],
      ["2026-05-01", "May follow-up issue created."],
    ]);
    for (const day of aggregateDays) {
      await summaryStore.insertSummary({
        summaryId: `sum_${day}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: specialContent.get(day) ?? `Routine aggregate coverage for ${day}.`,
        tokenCount: 10,
        sourceMessageTokenCount: 10,
        earliestAt: new Date(`${day}T10:00:00.000Z`),
        latestAt: new Date(`${day}T10:00:00.000Z`),
      });
    }

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    for (const day of aggregateDays) {
      await expect(
        builder.buildDayRollup(conversation.conversationId, day)
      ).resolves.toBe(true);
    }

    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    await expect(
      builder.buildMonthlyRollup(conversation.conversationId, "2026-04")
    ).resolves.toBe(true);

    const week = rollupStore.getRollup(
      conversation.conversationId,
      "week",
      "2026-04-27"
    );
    expect(week?.status).toBe("ready");
    expect(week?.content).toContain("Weekly Summary: 2026-04-27");
    expect(week?.source_message_count).toBe(7);
    expect(
      rollupStore
        .getRollupSources(week!.rollup_id)
        .map((source) => source.source_type)
    ).toEqual(Array.from({ length: 7 }, () => "rollup"));

    const month = rollupStore.getRollup(
      conversation.conversationId,
      "month",
      "2026-04"
    );
    expect(month?.status).toBe("ready");
    expect(month?.content).toContain("Monthly Summary: 2026-04");
    expect(month?.source_message_count).toBe(30);
    expect(rollupStore.getRollupSources(month!.rollup_id)).toHaveLength(30);

    const firstMonthId = month?.rollup_id;
    await expect(
      builder.buildMonthlyRollup(conversation.conversationId, "2026-04")
    ).resolves.toBe(false);
    expect(
      rollupStore.getRollup(conversation.conversationId, "month", "2026-04")
        ?.rollup_id
    ).toBe(firstMonthId);

    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(false);
  });

  it("rejects non-canonical weekly rollup keys", async () => {
    const { conversationStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "bad-week-key",
      sessionKey: "agent:main:bad-week-key",
      title: "Bad week key",
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-29")
    ).rejects.toThrow(/Monday calendar week start/);
  });

  it("treats missing no-activity days as covered for aggregate rollups", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "aggregate-quiet-days",
      sessionKey: "agent:main:aggregate-quiet-days",
      title: "Aggregate quiet days",
    });

    for (const [day, content] of [
      ["2026-04-27", "Monday work happened."],
      ["2026-04-29", "Wednesday follow-up happened."],
    ] as const) {
      await summaryStore.insertSummary({
        summaryId: `sum_quiet_${day}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content,
        tokenCount: 10,
        sourceMessageTokenCount: 10,
        latestAt: new Date(`${day}T10:00:00.000Z`),
      });
    }

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    await expect(
      builder.buildDayRollup(conversation.conversationId, "2026-04-29")
    ).resolves.toBe(true);
    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);

    const week = rollupStore.getRollup(
      conversation.conversationId,
      "week",
      "2026-04-27"
    );
    expect(week?.status).toBe("ready");
    expect(week?.source_message_count).toBe(2);
    expect(week?.content).toContain("Wednesday follow-up happened");
  });

  it("uses local UTC+13 day keys for week and month aggregation", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "aggregate-utc-plus",
      sessionKey: "agent:main:aggregate-utc-plus",
      title: "Aggregate UTC+13",
    });

    const aggregateDays = Array.from(
      { length: 31 },
      (_, index) => `2026-01-${String(index + 1).padStart(2, "0")}`
    );
    for (const day of aggregateDays) {
      await summaryStore.insertSummary({
        summaryId: `sum_auckland_${day}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content:
          day === "2026-01-05"
            ? "Completed the Pacific/Auckland aggregate key fix."
            : `Routine Pacific/Auckland aggregate coverage for ${day}.`,
        tokenCount: 10,
        sourceMessageTokenCount: 10,
        earliestAt: new Date(`${day}T00:30:00+13:00`),
        latestAt: new Date(`${day}T01:00:00+13:00`),
      });
    }

    const builder = new RollupBuilder(rollupStore, {
      timezone: "Pacific/Auckland",
    });
    for (const day of aggregateDays) {
      await expect(
        builder.buildDayRollup(conversation.conversationId, day)
      ).resolves.toBe(true);
    }
    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-01-05")
    ).resolves.toBe(true);
    await expect(
      builder.buildMonthlyRollup(conversation.conversationId, "2026-01")
    ).resolves.toBe(true);

    expect(
      rollupStore.getRollup(conversation.conversationId, "week", "2026-01-05")
        ?.content
    ).toContain("2026-01-05");
    expect(
      rollupStore.getRollup(conversation.conversationId, "month", "2026-01")
        ?.source_message_count
    ).toBe(31);
  });

  it("does not serve stored aggregate rollups while rebuild is pending", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "pending-week",
        sessionKey: "agent:main:pending-week",
        title: "Pending week",
      });

      const weekDays = [
        "2026-04-27",
        "2026-04-28",
        "2026-04-29",
        "2026-04-30",
        "2026-05-01",
        "2026-05-02",
        "2026-05-03",
      ];
      for (const day of weekDays) {
        await summaryStore.insertSummary({
          summaryId: `sum_week_old_${day}`,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Original weekly aggregate content for ${day}.`,
          tokenCount: 10,
          latestAt: new Date(`${day}T10:00:00.000Z`),
        });
      }

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      for (const day of weekDays) {
        await expect(
          builder.buildDayRollup(conversation.conversationId, day)
        ).resolves.toBe(true);
      }
      await expect(
        builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
      ).resolves.toBe(true);
      await summaryStore.insertSummary({
        summaryId: "sum_week_new",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Pending rebuild activity must be visible via fallback.",
        tokenCount: 10,
        latestAt: now,
      });

      const update = db.prepare(
        `UPDATE lcm_rollups
         SET content = ?
         WHERE conversation_id = ? AND period_kind = 'week' AND period_key = ?`
      ).run("STALE WEEK ROLLUP SHOULD NOT BE USED", conversation.conversationId, "2026-04-27");
      expect(update.changes).toBe(1);
      rollupStore.upsertState(conversation.conversationId, {
        timezone: "UTC",
        pending_rebuild: 1,
      });

      const lcm = {
        timezone: "UTC",
        getRollupStore: () => rollupStore,
        getConversationStore: () => ({
          getConversationBySessionId: async () => ({
            conversationId: conversation.conversationId,
            sessionId: "pending-week",
            title: null,
            bootstrappedAt: null,
            createdAt: now,
            updatedAt: now,
          }),
          getConversationBySessionKey: async () => null,
        }),
      };
      const tool = createLcmRecentTool({
        deps: makeRecentDeps(),
        lcm: lcm as never,
        sessionId: "pending-week",
      });

      const result = await tool.execute("call-week", {
        period: "week",
        includeSources: true,
      });
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Pending rebuild activity");
      expect(text).not.toContain("STALE WEEK ROLLUP");
      expect((result.details as { usedFallback?: boolean }).usedFallback).toBe(
        true
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("updates aggregate phase timestamps only for successful phases", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "aggregate-phase-state",
      sessionKey: "agent:main:aggregate-phase-state",
      title: "Aggregate phase state",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_phase_state",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Monthly phase can still build if weekly phase fails.",
      tokenCount: 10,
      sourceMessageTokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
    const originalBuildAggregate = (
      builder as unknown as {
        buildAggregateRollup: (
          conversationId: number,
          periodKind: "week" | "month",
          periodKey: string
        ) => Promise<boolean>;
      }
    ).buildAggregateRollup.bind(builder);
    const aggregateSpy = vi
      .spyOn(
        builder as unknown as {
          buildAggregateRollup: (
            conversationId: number,
            periodKind: "week" | "month",
            periodKey: string
          ) => Promise<boolean>;
        },
        "buildAggregateRollup"
      )
      .mockImplementation(async (conversationId, periodKind, periodKey) => {
        if (periodKind === "week") {
          throw new Error("week phase failed");
        }
        return originalBuildAggregate(conversationId, periodKind, periodKey);
      });

    const result = await builder.buildWeeklyMonthlyRollups(
      conversation.conversationId
    );
    aggregateSpy.mockRestore();

    expect(result.errors).toHaveLength(1);
    const state = rollupStore.getState(conversation.conversationId);
    expect(state?.last_weekly_build_at).toBeNull();
    expect(state?.last_monthly_build_at).toBeTruthy();
    expect(state?.pending_rebuild).toBe(1);
  });

  it("bounds aggregate maintenance to affected recent periods", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-29T12:00:00.000Z"));
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "aggregate-maintenance-bounds",
        sessionKey: "agent:main:aggregate-maintenance-bounds",
        title: "Aggregate maintenance bounds",
      });

      for (const [summaryId, day] of [
        ["sum_old_aggregate_window", "2026-01-01"],
        ["sum_recent_aggregate_window", "2026-04-29"],
      ] as const) {
        await summaryStore.insertSummary({
          summaryId,
          conversationId: conversation.conversationId,
          kind: "leaf",
          depth: 0,
          content: `Aggregate maintenance coverage for ${day}.`,
          tokenCount: 10,
          sourceMessageTokenCount: 10,
          earliestAt: new Date(`${day}T10:00:00.000Z`),
          latestAt: new Date(`${day}T10:00:00.000Z`),
        });
      }

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, "2026-01-01");
      await builder.buildDayRollup(conversation.conversationId, "2026-04-29");

      const originalBuildAggregate = (
        builder as unknown as {
          buildAggregateRollup: (
            conversationId: number,
            periodKind: "week" | "month",
            periodKey: string
          ) => Promise<boolean>;
        }
      ).buildAggregateRollup.bind(builder);
      const aggregateSpy = vi
        .spyOn(
          builder as unknown as {
            buildAggregateRollup: (
              conversationId: number,
              periodKind: "week" | "month",
              periodKey: string
            ) => Promise<boolean>;
          },
          "buildAggregateRollup"
        )
        .mockImplementation(originalBuildAggregate);

      await builder.buildWeeklyMonthlyRollups(conversation.conversationId, {
        daysBack: 2,
      });

      const aggregateKeys = aggregateSpy.mock.calls.map(
        ([, periodKind, periodKey]) => `${periodKind}:${periodKey}`
      );
      aggregateSpy.mockRestore();

      expect(aggregateKeys).toContain("week:2026-04-27");
      expect(aggregateKeys).toContain("month:2026-04");
      expect(aggregateKeys).not.toContain("week:2025-12-29");
      expect(aggregateKeys).not.toContain("month:2026-01");
    } finally {
      vi.useRealTimers();
    }
  });

  it("removes orphaned aggregate rollups when source days disappear", async () => {
    const { db, conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "orphaned-week",
      sessionKey: "agent:main:orphaned-week",
      title: "Orphaned week",
    });
    const weekDays = [
      "2026-04-27",
      "2026-04-28",
      "2026-04-29",
      "2026-04-30",
      "2026-05-01",
      "2026-05-02",
      "2026-05-03",
    ];
    for (const day of weekDays) {
      await summaryStore.insertSummary({
        summaryId: `sum_orphan_${day}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: `Temporary week coverage for ${day}.`,
        tokenCount: 10,
        sourceMessageTokenCount: 10,
        latestAt: new Date(`${day}T10:00:00.000Z`),
      });
    }

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    for (const day of weekDays) {
      await expect(
        builder.buildDayRollup(conversation.conversationId, day)
      ).resolves.toBe(true);
    }
    await expect(
      builder.buildWeeklyRollup(conversation.conversationId, "2026-04-27")
    ).resolves.toBe(true);
    expect(
      rollupStore.getRollup(conversation.conversationId, "week", "2026-04-27")
    ).not.toBeNull();

    db.prepare("DELETE FROM summaries WHERE summary_id LIKE 'sum_orphan_%'").run();
    for (const day of weekDays) {
      await expect(
        builder.buildDayRollup(conversation.conversationId, day)
      ).resolves.toBe(true);
    }
    const result = await builder.buildWeeklyMonthlyRollups(
      conversation.conversationId
    );

    expect(result.built).toBeGreaterThan(0);
    expect(
      rollupStore.getRollup(conversation.conversationId, "week", "2026-04-27")
    ).toBeNull();
  });

  it("removes stale rollups when a day becomes empty", async () => {
    const now = new Date("2026-04-28T12:00:00.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "empty-day",
        sessionKey: "agent:main:empty-day",
        title: "Empty day",
      });
      await summaryStore.insertSummary({
        summaryId: "sum_deleted_day",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "This day will be deleted.",
        tokenCount: 10,
        latestAt: new Date("2026-04-27T10:00:00.000Z"),
      });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
      expect(
        rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
      ).not.toBeNull();

      rollupStore.db
        .prepare(`DELETE FROM summaries WHERE summary_id = ?`)
        .run("sum_deleted_day");
      const result = await builder.buildDailyRollups(conversation.conversationId, {
        forceCurrentDay: true,
        daysBack: 2,
      });

      expect(result.built).toBeGreaterThan(0);
      expect(
        rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
      ).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not move last_rollup_check_at backwards after sweep builds", async () => {
    const scanStart = new Date("2026-04-28T12:00:00.000Z");
    const buildTime = new Date("2026-04-28T12:00:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(scanStart);
    try {
      const { conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "rollup-check-monotonic",
        sessionKey: "agent:main:rollup-check-monotonic",
        title: "Rollup check monotonic",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_rollup_check_monotonic",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Completed a monotonic state update check.",
        tokenCount: 10,
        earliestAt: new Date("2026-04-27T10:00:00.000Z"),
        latestAt: new Date("2026-04-27T10:30:00.000Z"),
      });

      const originalGetLeafSummaries =
        rollupStore.getLeafSummariesForDay.bind(rollupStore);
      const lookupSpy = vi
        .spyOn(rollupStore, "getLeafSummariesForDay")
        .mockImplementation((...args) => {
          vi.setSystemTime(buildTime);
          return originalGetLeafSummaries(...args);
        });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await expect(
        builder.buildDailyRollups(conversation.conversationId, {
          forceCurrentDay: true,
          daysBack: 2,
        })
      ).resolves.toMatchObject({ built: 1, errors: [] });
      lookupSpy.mockRestore();

      const state = rollupStore.getState(conversation.conversationId);
      expect(state?.last_rollup_check_at).toBe(buildTime.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps rebuild pending when leaf summaries change during a daily sweep", async () => {
    const scanStart = new Date("2026-04-28T12:00:00.000Z");
    const summaryChange = new Date("2026-04-28T12:00:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(scanStart);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "rollup-summary-watermark",
        sessionKey: "agent:main:rollup-summary-watermark",
        title: "Rollup summary watermark",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_watermark",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Summary changes during sweep should keep rebuild pending.",
        tokenCount: 10,
        earliestAt: new Date("2026-04-27T10:00:00.000Z"),
        latestAt: new Date("2026-04-27T10:30:00.000Z"),
      });
      db.prepare(
        `UPDATE summaries
         SET created_at = ?
         WHERE summary_id = ?`
      ).run("2026-04-28T11:59:00.000Z", "sum_watermark");

      const originalGetLeafSummaries =
        rollupStore.getLeafSummariesForDay.bind(rollupStore);
      let movedWatermark = false;
      const lookupSpy = vi
        .spyOn(rollupStore, "getLeafSummariesForDay")
        .mockImplementation((...args) => {
          const rows = originalGetLeafSummaries(...args);
          if (!movedWatermark && args[1] === "2026-04-27T00:00:00.000Z") {
            movedWatermark = true;
            vi.setSystemTime(summaryChange);
            db.prepare(
              `UPDATE summaries
               SET created_at = ?
               WHERE summary_id = ?`
            ).run(summaryChange.toISOString(), "sum_watermark");
          }
          return rows;
        });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await expect(
        builder.buildDailyRollups(conversation.conversationId, {
          forceCurrentDay: true,
          daysBack: 2,
        })
      ).resolves.toMatchObject({ built: 1, errors: [] });
      lookupSpy.mockRestore();

      const state = rollupStore.getState(conversation.conversationId);
      expect(state?.pending_rebuild).toBe(1);
      expect(state?.last_rollup_check_at).toBe(summaryChange.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps rebuild pending when leaf summary content changes during a daily sweep", async () => {
    const scanStart = new Date("2026-04-28T12:00:00.000Z");
    const summaryChange = new Date("2026-04-28T12:00:05.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(scanStart);
    try {
      const { db, conversationStore, summaryStore, rollupStore } = createStores();
      const conversation = await conversationStore.createConversation({
        sessionId: "rollup-summary-content-watermark",
        sessionKey: "agent:main:rollup-summary-content-watermark",
        title: "Rollup summary content watermark",
      });

      await summaryStore.insertSummary({
        summaryId: "sum_content_watermark",
        conversationId: conversation.conversationId,
        kind: "leaf",
        depth: 0,
        content: "Original summary content.",
        tokenCount: 10,
        earliestAt: new Date("2026-04-27T10:00:00.000Z"),
        latestAt: new Date("2026-04-27T10:30:00.000Z"),
      });

      const originalGetLeafSummaries =
        rollupStore.getLeafSummariesForDay.bind(rollupStore);
      let changedContent = false;
      const lookupSpy = vi
        .spyOn(rollupStore, "getLeafSummariesForDay")
        .mockImplementation((...args) => {
          const rows = originalGetLeafSummaries(...args);
          if (!changedContent && args[1] === "2026-04-27T00:00:00.000Z") {
            changedContent = true;
            vi.setSystemTime(summaryChange);
            db.prepare(
              `UPDATE summaries
               SET content = ?, token_count = ?
               WHERE summary_id = ?`
            ).run(
              "Updated summary content with same created_at.",
              10,
              "sum_content_watermark"
            );
          }
          return rows;
        });

      const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
      await expect(
        builder.buildDailyRollups(conversation.conversationId, {
          forceCurrentDay: true,
          daysBack: 2,
        })
      ).resolves.toMatchObject({ built: 1, errors: [] });
      lookupSpy.mockRestore();

      const state = rollupStore.getState(conversation.conversationId);
      expect(state?.pending_rebuild).toBe(1);
      expect(state?.last_rollup_check_at).toBe(summaryChange.toISOString());
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports final sweep-state write failures without aborting built rollups", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "rollup-final-state-error",
      sessionKey: "agent:main:rollup-final-state-error",
      title: "Rollup final state error",
    });

    await summaryStore.insertSummary({
      summaryId: "sum_final_state_error",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Built work should survive a final state write failure.",
      tokenCount: 10,
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });

    const originalUpsertState = rollupStore.upsertState.bind(rollupStore);
    const upsertSpy = vi
      .spyOn(rollupStore, "upsertState")
      .mockImplementation((conversationId, input) => {
        if (input.pending_rebuild != null) {
          throw new Error("state write failed");
        }
        originalUpsertState(conversationId, input);
      });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    let result!: Awaited<ReturnType<RollupBuilder["buildDailyRollups"]>>;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
    try {
      result = await builder.buildDailyRollups(conversation.conversationId, {
        forceCurrentDay: true,
        daysBack: 2,
      });
    } finally {
      vi.useRealTimers();
    }
    upsertSpy.mockRestore();

    expect(result.built).toBe(1);
    expect(result.errors).toEqual([
      "final sweep state update failed: state write failed",
    ]);
    expect(
      rollupStore.getRollup(conversation.conversationId, "day", "2026-04-27")
    ).toBeTruthy();
  });

  it("hides debug source IDs unless includeSources is true", async () => {
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "debug-source-hiding",
      sessionKey: "agent:main:debug-source-hiding",
      title: "Debug source hiding",
    });
    await summaryStore.insertSummary({
      summaryId: "sum_debug_hidden",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Debug provenance should stay hidden by default.",
      tokenCount: 10,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:00:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });
    await builder.buildDayRollup(conversation.conversationId, "2026-04-27");
    const lcm = {
      timezone: "UTC",
      getRollupStore: () => rollupStore,
      getConversationStore: () => ({
        getConversationBySessionId: async () => ({
          conversationId: conversation.conversationId,
          sessionId: "debug-source-hiding",
          title: null,
          bootstrappedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }),
        getConversationBySessionKey: async () => null,
      }),
    };
    const tool = createLcmRollupDebugTool({
      deps: makeRecentDeps(),
      lcm: lcm as never,
      sessionId: "debug-source-hiding",
    });

    const hidden = await tool.execute("debug-hidden", { periodKind: "day" });
    const hiddenText = (hidden.content[0] as { text: string }).text;
    expect(hiddenText).not.toContain("sum_debug_hidden");
    expect(JSON.stringify(hidden.details)).not.toContain("sum_debug_hidden");

    const shown = await tool.execute("debug-shown", {
      periodKind: "day",
      includeSources: true,
    });
    const shownText = (shown.content[0] as { text: string }).text;
    expect(shownText).toContain("sum_debug_hidden");

    const invalid = await tool.execute("debug-invalid", {
      periodKind: "year",
    });
    expect((invalid.content[0] as { text: string }).text).toContain(
      "periodKind must be one of"
    );

    for (let index = 0; index < 120; index += 1) {
      rollupStore.upsertRollup({
        rollup_id: `debug_extra_${index}`,
        conversation_id: conversation.conversationId,
        period_kind: "day",
        period_key: `debug-${index}`,
        period_start: "2026-04-27T00:00:00.000Z",
        period_end: "2026-04-28T00:00:00.000Z",
        timezone: "UTC",
        content: `Debug extra ${index}`,
        token_count: 1,
        source_summary_ids: "[]",
        source_message_count: 0,
        source_token_count: 0,
        status: "ready",
        coverage_start: null,
        coverage_end: null,
        summarizer_model: "test",
        source_fingerprint: `debug-extra-${index}`,
      });
    }
    const capped = await tool.execute("debug-capped", {
      periodKind: "day",
      limit: 1000,
    });
    expect((capped.details as { rollups?: unknown[] }).rollups).toHaveLength(
      100
    );
  });

  it("re-reads rollup state INSIDE a BEGIN IMMEDIATE transaction in buildDailyRollups (P1-3)", async () => {
    // Structural pin (mirrors P1-8 / R3-FIX-2 patterns). Pre-fix, the
    // post-build state-update block read latestState / latestSummaryCreatedAt /
    // latestSummaryFingerprint OUTSIDE any transaction, decided
    // shouldClearPending, then wrote pending_rebuild=0 — a concurrent ingest
    // that flipped pending_rebuild=1 between our read and our write was
    // silently clobbered. The fix wraps read-decide-write in
    // withDatabaseTransaction("BEGIN IMMEDIATE", …) and re-reads INSIDE the
    // txn. A deterministic concurrency repro is hard once BEGIN IMMEDIATE is
    // in place (the race is now serialized by the SQLite write lock); the
    // structural assertion is acceptable.
    const fs = await import("node:fs");
    const path = await import("node:path");
    const url = await import("node:url");
    const here = url.fileURLToPath(import.meta.url);
    const source = fs.readFileSync(
      path.join(path.dirname(here), "..", "src", "rollup-builder.ts"),
      "utf8"
    );

    const dailyStart = source.indexOf("async buildDailyRollups(");
    expect(dailyStart).toBeGreaterThan(-1);
    const dailyBody = source.slice(dailyStart);

    // Locate the post-build "final sweep state update" block — anchored on
    // the catch's error-message string, which is unique in the file.
    const finalSweepCatch = dailyBody.indexOf(
      "final sweep state update failed:"
    );
    expect(finalSweepCatch).toBeGreaterThan(-1);

    // Walk backwards to the enclosing try-block so we can scan it.
    const tryStart = dailyBody.lastIndexOf("try {", finalSweepCatch);
    expect(tryStart).toBeGreaterThan(-1);
    const blockRegion = dailyBody.slice(tryStart, finalSweepCatch);

    // Inside that try-block, every wall-state read must come AFTER
    // withDatabaseTransaction("BEGIN IMMEDIATE", …).
    const txStart = blockRegion.indexOf('withDatabaseTransaction(');
    expect(txStart).toBeGreaterThan(-1);
    const beginImmediate = blockRegion.indexOf('"BEGIN IMMEDIATE"');
    expect(beginImmediate).toBeGreaterThan(txStart);

    const getStateRead = blockRegion.indexOf("this.store.getState(");
    expect(getStateRead).toBeGreaterThan(txStart);
    const fingerprintRead = blockRegion.indexOf(
      "this.store.getLeafSummarySweepFingerprint("
    );
    expect(fingerprintRead).toBeGreaterThan(txStart);
    const summaryAtRead = blockRegion.indexOf(
      "this.store.getLatestLeafSummaryCreatedAt("
    );
    expect(summaryAtRead).toBeGreaterThan(txStart);

    // The upsertState write must also be inside the txn.
    const upsertWrite = blockRegion.indexOf("this.store.upsertState(");
    expect(upsertWrite).toBeGreaterThan(txStart);
  });

  it("clears pending_rebuild on a clean build and re-arms when state advanced mid-sweep (P1-3)", async () => {
    // End-to-end: a clean build without concurrent writers clears the flag.
    // A simulated concurrent writer that advances last_message_at past
    // scannedAt before the post-build txn runs causes shouldClearPending to
    // observe the fresh value INSIDE the txn and re-arm pending_rebuild=1.
    const { conversationStore, summaryStore, rollupStore } = createStores();
    const conversation = await conversationStore.createConversation({
      sessionId: "race-pending-rebuild",
      sessionKey: "agent:main:race",
      title: "race",
    });

    await summaryStore.insertSummary({
      summaryId: "race_sum_a",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "Leaf alpha",
      tokenCount: 5,
      sourceMessageTokenCount: 5,
      earliestAt: new Date("2026-04-27T10:00:00.000Z"),
      latestAt: new Date("2026-04-27T10:30:00.000Z"),
    });

    const builder = new RollupBuilder(rollupStore, { timezone: "UTC" });

    // Happy path — no concurrent writer.
    rollupStore.upsertState(conversation.conversationId, {
      timezone: "UTC",
      pending_rebuild: 1,
      last_message_at: "2026-04-27T10:30:00.000Z",
    });
    await builder.buildDailyRollups(conversation.conversationId, {
      forceCurrentDay: true,
    });
    const cleanState = rollupStore.getState(conversation.conversationId);
    expect(cleanState?.pending_rebuild).toBe(0);

    // Race path — patch the store's getState to simulate a concurrent ingest
    // writing last_message_at AFTER scannedAt right before the builder's
    // post-build txn body reads state. The builder's BEGIN IMMEDIATE serializes
    // this, but we model the "writer committed before txn started" case by
    // mutating the row inside the same txn at the moment getState fires —
    // which is exactly what the OLD code missed.
    rollupStore.upsertState(conversation.conversationId, {
      timezone: "UTC",
      pending_rebuild: 1,
      last_message_at: "2026-04-27T10:30:00.000Z",
    });

    const originalGetState = rollupStore.getState.bind(rollupStore);
    let stateCallCount = 0;
    const spy = vi
      .spyOn(rollupStore, "getState")
      .mockImplementation((convId: number) => {
        stateCallCount += 1;
        // On the post-build txn read (the SECOND call from this test path),
        // simulate a concurrent ingest that just advanced last_message_at
        // far past scannedAt. With the fix, the builder observes this
        // advance INSIDE its own txn and re-arms pending_rebuild=1.
        if (stateCallCount === 2) {
          rollupStore.db
            .prepare(
              `UPDATE lcm_rollup_state
                 SET last_message_at = ?
               WHERE conversation_id = ?`
            )
            .run("2099-12-31T23:59:59.000Z", convId);
        }
        return originalGetState(convId);
      });

    await builder.buildDailyRollups(conversation.conversationId, {
      forceCurrentDay: true,
    });
    spy.mockRestore();

    // The fresh last_message_at observed inside the txn is well after
    // scannedAt, so the builder must re-arm rather than clear.
    const racedState = rollupStore.getState(conversation.conversationId);
    expect(racedState?.pending_rebuild).toBe(1);
  });
});
