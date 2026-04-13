import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { createLcmDatabaseConnection, closeLcmConnection } from "../src/db/connection.js";
import { resolveLcmConfig } from "../src/db/config.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmCommand, __testing } from "../src/plugin/lcm-command.js";
import type { LcmSummarizeFn } from "../src/summarize.js";
import type { LcmDependencies } from "../src/types.js";

function createCommandFixture(options?: {
  summarize?: LcmSummarizeFn;
  deps?: LcmDependencies;
  getLcm?: () => Promise<{
    rotateSessionStorage: (...args: unknown[]) => Promise<unknown>;
  }>;
}) {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-command-"));
  const dbPath = join(tempDir, "lcm.db");
  const db = createLcmDatabaseConnection(dbPath);
  const { fts5Available } = getLcmDbFeatures(db);
  runLcmMigrations(db, { fts5Available });
  const conversationStore = new ConversationStore(db, { fts5Available });
  const summaryStore = new SummaryStore(db, { fts5Available });
  const config = resolveLcmConfig({}, { dbPath });
  const command = createLcmCommand({
    db,
    config,
    summarize: options?.summarize,
    deps: options?.deps,
    getLcm: options?.getLcm,
  });
  return { tempDir, dbPath, db, command, conversationStore, summaryStore };
}

function createCommandContext(
  args?: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    channel: "telegram",
    isAuthorizedSender: true,
    commandBody: args ? `/lossless ${args}` : "/lossless",
    args,
    config: {
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
          },
        },
        slots: {
          contextEngine: "lossless-claw",
        },
      },
    },
    requestConversationBinding: async () => ({ status: "error" as const, message: "unsupported" }),
    detachConversationBinding: async () => ({ removed: false }),
    getCurrentConversationBinding: async () => null,
    ...overrides,
  };
}

describe("lcm command", () => {
  const tempDirs = new Set<string>();
  const dbPaths = new Set<string>();

  afterEach(() => {
    vi.restoreAllMocks();
    for (const dbPath of dbPaths) {
      closeLcmConnection(dbPath);
    }
    dbPaths.clear();
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  it("reports compact global status and help hints", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "status-session",
      title: "Status fixture",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "first source message",
        tokenCount: 10,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "second source message",
        tokenCount: 12,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `leaf summary\n${"[Truncated from 2048 tokens]"}`,
      tokenCount: 50,
      sourceMessageTokenCount: 22,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_parent",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "condensed summary",
      tokenCount: 25,
      sourceMessageTokenCount: 22,
    });
    await fixture.summaryStore.linkSummaryToMessages("sum_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await fixture.summaryStore.linkSummaryToParents("sum_parent", ["sum_leaf"]);

    const result = await fixture.command.handler(createCommandContext());
    expect(result.text).toContain("**🦀 Lossless Claw");
    expect(result.text).toContain("Help: `/lossless help`");
    expect(result.text).toContain("Alias: `/lcm`");
    expect(result.text).toContain("**🧩 Plugin**");
    expect(result.text).toContain("enabled: yes");
    expect(result.text).toContain("selected: yes (slot=lossless-claw)");
    expect(result.text).toContain(`db path: ${fixture.dbPath}`);
    expect(result.text).toContain("**🌐 Global**");
    expect(result.text).toContain("summaries: 2 (1 leaf, 1 condensed)");
    expect(result.text).toContain("stored summary tokens: 75");
    expect(result.text).toContain("summarized source tokens: 22");
    expect(result.text).not.toContain("warning (1 issue; run `/lossless doctor`)");
    expect(result.text).not.toContain("doctor: warning");
    expect(result.text).toContain("**📍 Current conversation**");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain("OpenClaw did not expose an active session key or session id here");
  });

  it("resolves current conversation stats when the host provides a session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "session-key-status-session",
      sessionKey: "agent:main:telegram:direct:4242",
      title: "Current conversation fixture",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "current conversation message one",
        tokenCount: 8,
      },
      {
        conversationId: conversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "current conversation message two",
        tokenCount: 13,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "current_leaf",
      conversationId: conversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `current summary body\n${"[Truncated from 512 tokens]"}`,
      tokenCount: 7,
      sourceMessageTokenCount: 21,
    });
    await fixture.summaryStore.linkSummaryToMessages("current_leaf", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);
    await fixture.summaryStore.insertSummary({
      summaryId: "current_parent",
      conversationId: conversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: "current parent summary",
      tokenCount: 5,
      descendantTokenCount: 7,
      sourceMessageTokenCount: 21,
    });
    await fixture.summaryStore.linkSummaryToParents("current_parent", ["current_leaf"]);
    await fixture.summaryStore.replaceContextRangeWithSummary({
      conversationId: conversation.conversationId,
      startOrdinal: 0,
      endOrdinal: 1,
      summaryId: "current_parent",
    });

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:direct:4242",
      }),
    );

    expect(result.text).toContain("**📍 Current conversation**");
    expect(result.text).not.toContain("status: resolved via session key");
    expect(result.text).toContain(`conversation id: ${conversation.conversationId}`);
    expect(result.text).toContain("session key: `agent:main:telegram:direct:4242`");
    expect(result.text).not.toContain("session id:");
    expect(result.text).toContain("messages: 2");
    expect(result.text).toContain("summaries: 2 (1 leaf, 1 condensed)");
    expect(result.text).toContain("stored summary tokens: 12");
    expect(result.text).toContain("summarized source tokens: 21");
    expect(result.text).toContain("tokens in context: 5");
    expect(result.text).toContain("compression ratio: 1:6");
    expect(result.text).toContain("doctor: 1 issue(s) in this conversation");
  });

  it("reports deferred compaction maintenance state in status output", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "maintenance-status-session",
      sessionKey: "agent:main:telegram:maintenance:1",
      title: "Maintenance fixture",
    });
    fixture.db
      .prepare(
        `INSERT INTO conversation_compaction_maintenance (
           conversation_id,
           pending,
           requested_at,
           reason,
           running,
           last_started_at,
           last_finished_at,
           last_failure_summary,
           token_budget,
           current_token_count,
           updated_at
         ) VALUES (?, 1, ?, ?, 0, ?, ?, ?, ?, ?, datetime('now'))`,
      )
      .run(
        conversation.conversationId,
        "2026-04-12T00:00:00.000Z",
        "budget-trigger",
        "2026-04-12T00:05:00.000Z",
        "2026-04-12T00:07:00.000Z",
        "provider timeout",
        128_000,
        96_000,
      );

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:maintenance:1",
        sessionId: "maintenance-status-session",
      }),
    );

    expect(result.text).toContain("**🛠️ Maintenance**");
    expect(result.text).toContain("state: pending");
    expect(result.text).toContain("reason: budget-trigger");
    expect(result.text).toContain("last failure: provider timeout");
    expect(result.text).toContain("requested token budget: 128,000");
    expect(result.text).toContain("observed token count: 96,000");
  });

  it("falls back to the active session id when the current session key is not stored yet", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const conversation = await fixture.conversationStore.createConversation({
      sessionId: "fallback-session-id",
      title: "Fallback conversation fixture",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: conversation.conversationId,
        seq: 0,
        role: "user",
        content: "fallback message",
        tokenCount: 5,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:direct:not-yet-stored",
        sessionId: "fallback-session-id",
      }),
    );

    expect(result.text).toContain("**📍 Current conversation**");
    expect(result.text).not.toContain(
      "status: resolved from active session key via session id fallback",
    );
    expect(result.text).toContain(`conversation id: ${conversation.conversationId}`);
    expect(result.text).not.toContain("session id:");
    expect(result.text).toContain("session key: missing");
    expect(result.text).toContain("messages: 1");
    expect(result.text).toContain("tokens in context: 0");
    expect(result.text).toContain("compression ratio: n/a");
  });

  it("refuses session id fallback when it resolves to a different stored session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    await fixture.conversationStore.createConversation({
      sessionId: "mismatch-session-id",
      sessionKey: "agent:main:telegram:direct:stored",
      title: "Mismatched fallback fixture",
    });

    const result = await fixture.command.handler(
      createCommandContext(undefined, {
        sessionKey: "agent:main:telegram:direct:active",
        sessionId: "mismatch-session-id",
      }),
    );

    expect(result.text).toContain("📍 Current conversation");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain("Active session key `agent:main:telegram:direct:active` is not stored in LCM yet.");
    expect(result.text).toContain("but it is bound to `agent:main:telegram:direct:stored`, so Global stats are safer.");
    expect(result.text).toContain("fallback: Showing Global stats only.");
  });

  it("scopes doctor output to the resolved current conversation when issues exist", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-current",
      sessionKey: "agent:main:telegram:direct:doctor-current",
    });
    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-other",
      sessionKey: "agent:main:telegram:direct:doctor-other",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_current_old",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `${"[LCM fallback summary; truncated for context management]"}\nlegacy fallback`,
      tokenCount: 10,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_current_new",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `useful summary body\n${"[Truncated from 999 tokens]"}`,
      tokenCount: 11,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_other_new",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `other summary body\n${"[Truncated from 123 tokens]"}`,
      tokenCount: 7,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor", {
        sessionKey: "agent:main:telegram:direct:doctor-current",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor");
    expect(result.text).toContain(`conversation id: ${currentConversation.conversationId}`);
    expect(result.text).toContain("scope: this conversation only");
    expect(result.text).toContain("detected summaries: 2");
    expect(result.text).toContain("old-marker summaries: 1");
    expect(result.text).toContain("truncated-marker summaries: 1");
    expect(result.text).toContain("result: issues found");
    expect(result.text).toContain("sum_current_new (new), sum_current_old (old)");
    expect(result.text).toContain("**🛠️ Next step**");
    expect(result.text).toContain("`/lossless doctor apply` repairs these in place for the current conversation.");
    expect(result.text).not.toContain("sum_other_new");
    expect(result.text).not.toContain(`conversation id: ${otherConversation.conversationId}`);
  });

  it("reports a clean scoped doctor result for the resolved current conversation", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-clean",
      sessionKey: "agent:main:telegram:direct:doctor-clean",
    });
    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-dirty",
      sessionKey: "agent:main:telegram:direct:doctor-dirty",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_clean",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "healthy summary",
      tokenCount: 9,
    });
    await fixture.summaryStore.insertSummary({
      summaryId: "sum_dirty",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `dirty summary\n${"[Truncated from 333 tokens]"}`,
      tokenCount: 12,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor", {
        sessionKey: "agent:main:telegram:direct:doctor-clean",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor");
    expect(result.text).toContain(`conversation id: ${currentConversation.conversationId}`);
    expect(result.text).toContain("scope: this conversation only");
    expect(result.text).toContain("detected summaries: 0");
    expect(result.text).toContain("result: clean");
    expect(result.text).not.toContain("🧷 Affected summaries");
    expect(result.text).not.toContain("sum_dirty");
  });

  it("reports doctor as unavailable when the current conversation cannot be resolved", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-unresolved-other",
      sessionKey: "agent:main:telegram:direct:doctor-unresolved-other",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_unresolved_other",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `other summary body\n${"[Truncated from 204 tokens]"}`,
      tokenCount: 16,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor", {
        sessionKey: "agent:main:telegram:direct:not-stored",
        sessionId: "doctor-unresolved-missing",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain(
      "No LCM conversation is stored yet for active session key `agent:main:telegram:direct:not-stored` or active session id `doctor-unresolved-missing`.",
    );
    expect(result.text).toContain("fallback: Doctor is conversation-scoped, so no global scan ran.");
    expect(result.text).not.toContain("detected summaries:");
    expect(result.text).not.toContain("sum_unresolved_other");
  });

  it("reports global high-confidence cleaner candidates with examples", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archivedSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-archived-subagent",
      sessionKey: "agent:main:subagent:worker-1",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: archivedSubagent.conversationId,
        seq: 0,
        role: "assistant",
        content: "archived subagent chatter",
        tokenCount: 4,
      },
    ]);
    await fixture.conversationStore.archiveConversation(archivedSubagent.conversationId);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-cron",
      sessionKey: "agent:main:cron:nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron wake-up",
        tokenCount: 3,
      },
    ]);

    const nullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-null-subagent",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: nullSubagent.conversationId,
        seq: 1,
        role: "user",
        content: "[Subagent Context] Inspect the repo and summarize the issue.",
        tokenCount: 12,
      },
      {
        conversationId: nullSubagent.conversationId,
        seq: 2,
        role: "assistant",
        content: "Working through the task now.",
        tokenCount: 7,
      },
    ]);

    const normalConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-normal",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: normalConversation.conversationId,
        seq: 0,
        role: "user",
        content: "ordinary conversation",
        tokenCount: 4,
      },
    ]);

    await fixture.conversationStore.archiveConversation(nullSubagent.conversationId);

    const liveNullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-live-null-subagent",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 0,
        role: "user",
        content: "[Subagent Context] Live child session still in progress.",
        tokenCount: 8,
      },
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 1,
        role: "assistant",
        content: "Still active and should not be treated as junk.",
        tokenCount: 10,
      },
    ]);

    const result = await fixture.command.handler(createCommandContext("doctor clean"));

    expect(result.text).toContain("🩺 Lossless Claw Doctor Clean");
    expect(result.text).toContain("mode: read-only diagnostics");
    expect(result.text).toContain("matched conversations: 3");
    expect(result.text).toContain("matched messages: 4");
    expect(result.text).toContain("filter id: `archived_subagents`");
    expect(result.text).toContain("filter id: `cron_sessions`");
    expect(result.text).toContain("filter id: `null_subagent_context`");
    expect(result.text).toContain("agent:main:subagent:worker-1");
    expect(result.text).toContain("agent:main:cron:nightly");
    expect(result.text).toContain("\"[Subagent Context] Inspect the repo and summarize the issue.\"");
    expect(result.text).toContain("run `/lossless doctor clean apply`");
    expect(result.text).not.toContain("\"[Subagent Context] Live child session still in progress.\"");
    expect(result.text).not.toContain("doctor-cleaner-normal");
    expect(result.text).not.toContain("ordinary conversation");
  });

  it("reports a clean doctor clean scan when no high-confidence candidates exist", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaners-clean",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "healthy conversation",
        tokenCount: 3,
      },
    ]);

    const result = await fixture.command.handler(createCommandContext("doctor clean"));

    expect(result.text).toContain("🩺 Lossless Claw Doctor Clean");
    expect(result.text).toContain("matched conversations: 0");
    expect(result.text).toContain("matched messages: 0");
    expect(result.text).toContain("No high-confidence cleaner candidates detected.");
    expect(result.text).not.toContain("🧹 Archived subagents");
  });

  it("applies all doctor clean filters with backup-first deletion and preserves unrelated conversations", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archivedSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-archived-subagent",
      sessionKey: "agent:main:subagent:apply-worker",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: archivedSubagent.conversationId,
        seq: 0,
        role: "assistant",
        content: "archived worker output",
        tokenCount: 5,
      },
    ]);
    await fixture.conversationStore.archiveConversation(archivedSubagent.conversationId);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-cron",
      sessionKey: "agent:main:cron:apply-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron cleanup run",
        tokenCount: 4,
      },
    ]);

    const nullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-null",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: nullSubagent.conversationId,
        seq: 1,
        role: "user",
        content: "[Subagent Context] Collect evidence and respond.",
        tokenCount: 8,
      },
      {
        conversationId: nullSubagent.conversationId,
        seq: 2,
        role: "assistant",
        content: "Subagent result",
        tokenCount: 4,
      },
    ]);
    await fixture.conversationStore.archiveConversation(nullSubagent.conversationId);

    const liveNullSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-live-null",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 0,
        role: "user",
        content: "[Subagent Context] Live child session still in progress.",
        tokenCount: 8,
      },
      {
        conversationId: liveNullSubagent.conversationId,
        seq: 1,
        role: "assistant",
        content: "Still active and should not be treated as junk.",
        tokenCount: 10,
      },
    ]);

    const normalConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-apply-normal",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: normalConversation.conversationId,
        seq: 0,
        role: "user",
        content: "keep this conversation",
        tokenCount: 4,
      },
    ]);

    const result = await fixture.command.handler(createCommandContext("doctor clean apply"));

    const backupPath = result.text.match(/backup path: (.+)/)?.[1]?.trim();
    const quickCheck = fixture.db.prepare(`PRAGMA quick_check`).get() as { quick_check?: string } | undefined;
    const remainingNormal = await fixture.conversationStore.getConversation(normalConversation.conversationId);
    const removedArchived = await fixture.conversationStore.getConversation(archivedSubagent.conversationId);
    const removedCron = await fixture.conversationStore.getConversation(cronConversation.conversationId);
    const removedNull = await fixture.conversationStore.getConversation(nullSubagent.conversationId);
    const remainingLiveNull = await fixture.conversationStore.getConversation(liveNullSubagent.conversationId);

    expect(result.text).toContain("🩺 Lossless Claw Doctor Clean Apply");
    expect(result.text).toContain("matched conversations before apply: 3");
    expect(result.text).toContain("deleted conversations: 3");
    expect(result.text).toContain("deleted messages: 4");
    expect(result.text).toContain("vacuumed: no");
    expect(result.text).toContain("quick_check: ok");
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
    expect(quickCheck?.quick_check).toBe("ok");
    expect(remainingNormal?.conversationId).toBe(normalConversation.conversationId);
    expect(remainingLiveNull?.conversationId).toBe(liveNullSubagent.conversationId);
    expect(removedArchived).toBeNull();
    expect(removedCron).toBeNull();
    expect(removedNull).toBeNull();
  });

  it("applies a single doctor clean filter without deleting other candidate classes", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archivedSubagent = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-single-archived",
      sessionKey: "agent:main:subagent:single-worker",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: archivedSubagent.conversationId,
        seq: 0,
        role: "assistant",
        content: "archived single worker output",
        tokenCount: 5,
      },
    ]);
    await fixture.conversationStore.archiveConversation(archivedSubagent.conversationId);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-single-cron",
      sessionKey: "agent:main:cron:single-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron single run",
        tokenCount: 4,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("doctor clean apply cron_sessions"),
    );

    const remainingArchived = await fixture.conversationStore.getConversation(archivedSubagent.conversationId);
    const removedCron = await fixture.conversationStore.getConversation(cronConversation.conversationId);

    expect(result.text).toContain("filters: `cron_sessions`");
    expect(result.text).toContain("matched conversations before apply: 1");
    expect(result.text).toContain("deleted conversations: 1");
    expect(remainingArchived?.conversationId).toBe(archivedSubagent.conversationId);
    expect(removedCron).toBeNull();
  });

  it("vacuums after doctor clean apply when requested", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-vacuum-cron",
      sessionKey: "agent:main:cron:vacuum-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron vacuum run",
        tokenCount: 4,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("doctor clean apply cron_sessions vacuum"),
    );
    const walCheckpoint = fixture.db
      .prepare(`PRAGMA wal_checkpoint`)
      .get() as { busy?: number; log?: number; checkpointed?: number } | undefined;

    expect(result.text).toContain("filters: `cron_sessions`");
    expect(result.text).toContain("vacuum requested: yes");
    expect(result.text).toContain("deleted conversations: 1");
    expect(result.text).toContain("vacuumed: yes");
    expect(walCheckpoint?.busy).toBe(0);
  });

  it("warns when doctor clean apply quick_check reports integrity issues", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const cronConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-cleaner-warning-cron",
      sessionKey: "agent:main:cron:warning-nightly",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: cronConversation.conversationId,
        seq: 0,
        role: "assistant",
        content: "cron warning run",
        tokenCount: 4,
      },
    ]);

    const config = resolveLcmConfig({}, { dbPath: fixture.dbPath });
    const dbWithQuickCheckWarning = new Proxy(fixture.db, {
      get(target, prop, receiver) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql === "PRAGMA quick_check") {
              return {
                all: () => [{ quick_check: "row 1 missing from index example_idx" }],
              };
            }
            return target.prepare(sql);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as unknown as typeof fixture.db;
    const command = createLcmCommand({
      db: dbWithQuickCheckWarning,
      config,
    });

    const result = await command.handler(
      createCommandContext("doctor clean apply cron_sessions"),
    );

    expect(result.text).toContain("status: warning");
    expect(result.text).toContain("quick_check: row 1 missing from index example_idx");
    expect(result.text).toContain("writes committed, but SQLite integrity verification reported problems");
  });

  it("keeps doctor apply as a clean scoped no-op when no issues exist", async () => {
    const summarize = vi.fn(async () => "should not run");
    const fixture = createCommandFixture({ summarize: summarize as LcmSummarizeFn });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-clean",
      sessionKey: "agent:main:telegram:direct:doctor-apply-clean",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_clean_apply",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: "healthy summary",
      tokenCount: 8,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:doctor-apply-clean",
      }),
    );

    expect(result.text).toContain("🩺 Lossless Claw Doctor Apply");
    expect(result.text).toContain("scope: this conversation only");
    expect(result.text).toContain("detected summaries: 0");
    expect(result.text).toContain("repaired summaries: 0");
    expect(result.text).toContain("result: clean; no writes ran");
    expect(summarize).not.toHaveBeenCalled();
  });

  it("repairs scoped doctor summaries in place and feeds repaired children into parents", async () => {
    const summarize = vi.fn(async (text: string, _aggressive?: boolean, options?: Parameters<LcmSummarizeFn>[2]) => {
      if (options?.isCondensed) {
        return `CONDENSED REPAIR\n${text}`;
      }
      return `LEAF REPAIR\n${text}`;
    });
    const fixture = createCommandFixture({ summarize: summarize as LcmSummarizeFn });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-current",
      sessionKey: "agent:main:telegram:direct:doctor-apply-current",
    });
    const [firstMessage, secondMessage] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first broken message",
        tokenCount: 6,
      },
      {
        conversationId: currentConversation.conversationId,
        seq: 1,
        role: "assistant",
        content: "second broken message",
        tokenCount: 7,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_leaf_fix",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `broken leaf\n${"[Truncated from 512 tokens]"}`,
      tokenCount: 11,
      sourceMessageTokenCount: 13,
    });
    await fixture.summaryStore.linkSummaryToMessages("sum_leaf_fix", [
      firstMessage.messageId,
      secondMessage.messageId,
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_parent_fix",
      conversationId: currentConversation.conversationId,
      kind: "condensed",
      depth: 1,
      content: `${"[LCM fallback summary; truncated for context management]"}\nold parent`,
      tokenCount: 9,
    });
    await fixture.summaryStore.linkSummaryToParents("sum_parent_fix", ["sum_leaf_fix"]);

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:doctor-apply-current",
      }),
    );

    const repairedLeaf = await fixture.summaryStore.getSummary("sum_leaf_fix");
    const repairedParent = await fixture.summaryStore.getSummary("sum_parent_fix");

    expect(result.text).toContain("detected summaries: 2");
    expect(result.text).toContain("repaired summaries: 2");
    expect(result.text).toContain("result: repaired 2 summary(s) in place");
    expect(result.text).toContain("sum_leaf_fix, sum_parent_fix");
    expect(summarize).toHaveBeenCalledTimes(2);
    expect(repairedLeaf?.content).toContain("LEAF REPAIR");
    expect(repairedLeaf?.content).not.toContain("[Truncated from");
    expect(repairedParent?.content).toContain("CONDENSED REPAIR");
    expect(repairedParent?.content).toContain("LEAF REPAIR");
    expect(repairedParent?.content).not.toContain("[LCM fallback summary");
  });

  it("reports doctor apply as unavailable when the current conversation cannot be resolved and does not repair globally", async () => {
    const summarize = vi.fn(async () => "should not run");
    const fixture = createCommandFixture({ summarize: summarize as LcmSummarizeFn });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const otherConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-unresolved-other",
      sessionKey: "agent:main:telegram:direct:doctor-apply-unresolved-other",
    });

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_unresolved_apply_other",
      conversationId: otherConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `other summary body\n${"[Truncated from 204 tokens]"}`,
      tokenCount: 16,
    });

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:not-stored",
        sessionId: "doctor-apply-unresolved-missing",
      }),
    );

    const untouched = await fixture.summaryStore.getSummary("sum_unresolved_apply_other");

    expect(result.text).toContain("🩺 Lossless Claw Doctor Apply");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain(
      "No LCM conversation is stored yet for active session key `agent:main:telegram:direct:not-stored` or active session id `doctor-apply-unresolved-missing`.",
    );
    expect(result.text).toContain("fallback: Doctor apply is conversation-scoped, so no global repair ran.");
    expect(result.text).not.toContain("detected summaries:");
    expect(summarize).not.toHaveBeenCalled();
    expect(untouched?.content).toContain("[Truncated from 204 tokens]");
  });

  it("uses the normal runtime model chain for doctor apply when no explicit summary model is set", async () => {
    const runtimeComplete = vi.fn(async () => ({
      content: [{ type: "text", text: "RUNTIME REPAIR" }],
    }));
    const config = resolveLcmConfig({}, { dbPath: "/tmp/unused.db" });
    const deps: LcmDependencies = {
      config,
      complete: runtimeComplete as LcmDependencies["complete"],
      callGateway: vi.fn(async () => ({})) as LcmDependencies["callGateway"],
      resolveModel: vi.fn((modelRef?: string) => {
        const [provider, model] = String(modelRef ?? "anthropic/claude-haiku-4-5").split("/", 2);
        return { provider, model };
      }) as LcmDependencies["resolveModel"],
      getApiKey: vi.fn(async () => "test-api-key") as LcmDependencies["getApiKey"],
      requireApiKey: vi.fn(async () => "test-api-key") as LcmDependencies["requireApiKey"],
      parseAgentSessionKey: vi.fn(() => ({ agentId: "main", suffix: "test" })) as LcmDependencies["parseAgentSessionKey"],
      isSubagentSessionKey: vi.fn(() => false) as LcmDependencies["isSubagentSessionKey"],
      normalizeAgentId: vi.fn((id?: string) => id?.trim() || "main") as LcmDependencies["normalizeAgentId"],
      buildSubagentSystemPrompt: vi.fn(() => "subagent prompt") as LcmDependencies["buildSubagentSystemPrompt"],
      readLatestAssistantReply: vi.fn(() => undefined) as LcmDependencies["readLatestAssistantReply"],
      resolveAgentDir: vi.fn(() => tmpdir()) as LcmDependencies["resolveAgentDir"],
      resolveSessionIdFromSessionKey: vi.fn(async () => undefined) as LcmDependencies["resolveSessionIdFromSessionKey"],
      resolveSessionTranscriptFile: vi.fn(async () => undefined) as LcmDependencies["resolveSessionTranscriptFile"],
      agentLaneSubagent: "subagent",
      log: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    };

    const fixture = createCommandFixture({ deps });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "doctor-apply-runtime-config",
      sessionKey: "agent:main:telegram:direct:doctor-apply-runtime-config",
    });
    const [message] = await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "runtime-config-backed broken message",
        tokenCount: 7,
      },
    ]);

    await fixture.summaryStore.insertSummary({
      summaryId: "sum_runtime_fix",
      conversationId: currentConversation.conversationId,
      kind: "leaf",
      depth: 0,
      content: `broken leaf\n${"[Truncated from 111 tokens]"}`,
      tokenCount: 10,
    });
    await fixture.summaryStore.linkSummaryToMessages("sum_runtime_fix", [message.messageId]);

    const result = await fixture.command.handler(
      createCommandContext("doctor apply", {
        sessionKey: "agent:main:telegram:direct:doctor-apply-runtime-config",
        config: {
          agents: {
            defaults: {
              model: "anthropic/claude-haiku-4-5",
            },
          },
          plugins: {
            entries: {
              "lossless-claw": {
                enabled: true,
              },
            },
            slots: {
              contextEngine: "lossless-claw",
            },
          },
        },
      }),
    );

    const repaired = await fixture.summaryStore.getSummary("sum_runtime_fix");

    expect(result.text).toContain("repaired summaries: 1");
    expect(result.text).not.toContain("could not resolve a summarizer");
    expect(runtimeComplete).toHaveBeenCalled();
    expect(repaired?.content).toContain("RUNTIME REPAIR");
    expect(repaired?.content).not.toContain("[Truncated from 111 tokens]");
  });

  it("creates a standalone database backup", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(createCommandContext("backup"));
    const backupPath = result.text.match(/backup path: (.+)/)?.[1]?.trim();

    expect(result.text).toContain("💾 Lossless Claw Backup");
    expect(result.text).toContain("status: created");
    expect(result.text).toContain(`db path: ${fixture.dbPath}`);
    expect(backupPath).toBeTruthy();
    expect(existsSync(backupPath!)).toBe(true);
  });

  it("reports backup failure with structured output", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);
    vi.spyOn(fixture.db, "exec").mockImplementation(() => {
      throw new Error("disk full");
    });

    const result = await fixture.command.handler(createCommandContext("backup"));

    expect(result.text).toContain("💾 Lossless Claw Backup");
    expect(result.text).toContain("status: failed");
    expect(result.text).toContain("reason: disk full");
  });

  it("rotates the current session and replaces the latest rotate backup", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    const rotateSessionStorage = vi.fn(async () => ({
      kind: "rotated" as const,
      archivedConversationId: 7,
      activeConversationId: 8,
      archivedMessageCount: 42,
      checkpointSize: 1234,
    }));
    const deps = {
      resolveSessionTranscriptFile: vi.fn(async () => transcriptPath),
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorage,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "rotate-session",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-session",
        sessionKey: "agent:main:main",
      }),
    );

    const backupPath = result.text.match(/backup path: (.+)/)?.[1]?.trim();

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: replaced latest");
    expect(result.text).toContain("status: rotated");
    expect(result.text).toContain("archived conversation id: 7");
    expect(result.text).toContain("new active conversation id: 8");
    expect(result.text).toContain("archived message count: 42");
    expect(result.text).toContain("mode: start from now forward");
    expect(backupPath).toBeTruthy();
    expect(backupPath?.endsWith(".rotate-latest.bak")).toBe(true);
    expect(existsSync(backupPath!)).toBe(true);

    const second = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-session",
        sessionKey: "agent:main:main",
      }),
    );
    const secondBackupPath = second.text.match(/backup path: (.+)/)?.[1]?.trim();
    expect(secondBackupPath).toBe(backupPath);
    expect(existsSync(secondBackupPath!)).toBe(true);

    expect(rotateSessionStorage).toHaveBeenCalledWith({
      sessionId: "rotate-session",
      sessionKey: "agent:main:main",
      sessionFile: transcriptPath,
    });
  });

  it("reports rotate failure when replacing the latest rotate backup throws", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-backup-fail-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    const rotateSessionStorage = vi.fn(async () => ({
      kind: "rotated" as const,
      archivedConversationId: 7,
      activeConversationId: 8,
      archivedMessageCount: 42,
      checkpointSize: 1234,
    }));
    const deps = {
      resolveSessionTranscriptFile: vi.fn(async () => transcriptPath),
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorage,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);
    vi.spyOn(fixture.db, "exec").mockImplementation(() => {
      throw new Error("SQLITE_BUSY");
    });

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "rotate-backup-failure-session",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-backup-failure-session",
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: failed");
    expect(result.text).toContain("reason: SQLITE_BUSY");
    expect(rotateSessionStorage).not.toHaveBeenCalled();
  });

  it("reports rotate failure when the engine rotate call throws", async () => {
    const transcriptPath = join(tmpdir(), `lossless-claw-rotate-engine-fail-${Date.now()}.jsonl`);
    writeFileSync(transcriptPath, "{\"message\":{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"existing\"}]}}\n");
    tempDirs.add(transcriptPath);

    const rotateSessionStorage = vi.fn(async () => {
      throw new Error("rotate exploded");
    });
    const deps = {
      resolveSessionTranscriptFile: vi.fn(async () => transcriptPath),
    } as unknown as LcmDependencies;
    const fixture = createCommandFixture({
      deps,
      getLcm: async () => ({
        rotateSessionStorage,
      }),
    });
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const currentConversation = await fixture.conversationStore.createConversation({
      sessionId: "rotate-engine-failure-session",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.createMessagesBulk([
      {
        conversationId: currentConversation.conversationId,
        seq: 0,
        role: "user",
        content: "first message",
        tokenCount: 2,
      },
    ]);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-engine-failure-session",
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: replaced latest");
    expect(result.text).toContain("status: failed");
    expect(result.text).toContain("reason: rotate exploded");
    expect(result.text).toContain("backup path:");
  });

  it("reports rotate as unavailable when OpenClaw does not expose a session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(
      createCommandContext("rotate", {
        sessionId: "rotate-missing-session-key",
      }),
    );

    expect(result.text).toContain("🪓 Lossless Claw Rotate");
    expect(result.text).toContain("status: unavailable");
    expect(result.text).toContain("OpenClaw must expose both the active session key and session id");
  });

  it("prefers the active conversation when multiple rows share the same session key", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archived = await fixture.conversationStore.createConversation({
      sessionId: "shared-key-old",
      sessionKey: "agent:main:main",
    });
    await fixture.conversationStore.archiveConversation(archived.conversationId);
    const active = await fixture.conversationStore.createConversation({
      sessionId: "shared-key-new",
      sessionKey: "agent:main:main",
    });

    const result = await fixture.command.handler(
      createCommandContext("status", {
        sessionKey: "agent:main:main",
      }),
    );

    expect(result.text).toContain(`conversation id: ${active.conversationId}`);
    expect(result.text).not.toContain(`conversation id: ${archived.conversationId}`);
  });

  it("prefers the active conversation when session_id fallback rows share the same timestamp", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const archived = await fixture.conversationStore.createConversation({
      sessionId: "shared-session-id",
      sessionKey: "agent:main:archived",
    });
    await fixture.conversationStore.archiveConversation(archived.conversationId);
    const active = await fixture.conversationStore.createConversation({
      sessionId: "shared-session-id",
      sessionKey: "agent:main:active",
    });

    const tiedTimestamp = "2026-04-11 22:57:00";
    fixture.db
      .prepare(`UPDATE conversations SET created_at = ? WHERE conversation_id IN (?, ?)`)
      .run(tiedTimestamp, archived.conversationId, active.conversationId);

    const result = await fixture.command.handler(
      createCommandContext("status", {
        sessionId: "shared-session-id",
      }),
    );

    expect(result.text).toContain(`conversation id: ${active.conversationId}`);
    expect(result.text).not.toContain(`conversation id: ${archived.conversationId}`);
  });

  it("falls back to help text for unsupported subcommands", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(createCommandContext("rewrite"));
    expect(result.text).toContain("⚠️ Unknown subcommand `rewrite`.");
    expect(result.text).toContain("`/lossless backup`");
    expect(result.text).toContain("`/lossless rotate`");
    expect(result.text).toContain("`/lossless help`");
    expect(result.text).toContain("`/lcm` is accepted as a shorter alias.");
  });

  it("accepts db as a lazy function and does not invoke it for help", async () => {
    const dbFn = vi.fn((): never => {
      throw new Error("should not be called for help");
    });
    const config = resolveLcmConfig({}, { dbPath: "/tmp/unused.db" });
    const command = createLcmCommand({ db: dbFn, config });

    const result = await command.handler(createCommandContext("help"));
    expect(result.text).toContain("/lossless");
    expect(dbFn).not.toHaveBeenCalled();
  });

  it("invokes the lazy db function for status subcommand", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const db = createLcmDatabaseConnection(fixture.dbPath);
    const config = resolveLcmConfig({}, { dbPath: fixture.dbPath });
    const dbFn = vi.fn(() => db);
    const command = createLcmCommand({ db: dbFn, config });

    const result = await command.handler(createCommandContext());
    expect(dbFn).toHaveBeenCalled();
    expect(result.text).toContain("**🦀 Lossless Claw");
  });

  it("awaits an async lazy db function for status subcommand", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const db = createLcmDatabaseConnection(fixture.dbPath);
    const config = resolveLcmConfig({}, { dbPath: fixture.dbPath });
    const dbFn = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return db;
    });
    const command = createLcmCommand({ db: dbFn, config });

    const result = await command.handler(createCommandContext());
    expect(dbFn).toHaveBeenCalled();
    expect(result.text).toContain("**🦀 Lossless Claw");
  });

  it("registers a Telegram native progress placeholder", () => {
    const config = resolveLcmConfig({}, { dbPath: "/tmp/unused.db" });
    const command = createLcmCommand({ db: vi.fn(), config });

    expect(command.nativeProgressMessages).toEqual({
      telegram: "Lossless Claw is working...",
    });
  });
});

describe("lcm command helpers", () => {
  it("treats native alias and empty slot states as selected defaults", () => {
    expect(__testing.resolvePluginSelected({})).toBe(true);
    expect(
      __testing.resolvePluginSelected({
        plugins: {
          slots: {
            contextEngine: "default",
          },
        },
      }),
    ).toBe(true);
    expect(
      __testing.resolvePluginSelected({
        plugins: {
          slots: {
            contextEngine: "legacy",
          },
        },
      }),
    ).toBe(false);
  });
});
