import { mkdtempSync, rmSync } from "node:fs";
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

function createCommandFixture(options?: { summarize?: LcmSummarizeFn; deps?: LcmDependencies }) {
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
  });
  return { tempDir, dbPath, command, conversationStore, summaryStore };
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

  it("falls back to help text for unsupported subcommands", async () => {
    const fixture = createCommandFixture();
    tempDirs.add(fixture.tempDir);
    dbPaths.add(fixture.dbPath);

    const result = await fixture.command.handler(createCommandContext("rewrite"));
    expect(result.text).toContain("⚠️ Unknown subcommand `rewrite`.");
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
