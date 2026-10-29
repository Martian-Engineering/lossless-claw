import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resolveLcmConfig } from "../src/db/config.js";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import type { LcmContextEngine } from "../src/engine.js";
import { createDelegatedExpansionGrant, resetDelegatedExpansionGrantsForTests } from "../src/expansion-auth.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { resolveSessionPrincipal } from "../src/session-principal.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmDescribeTool } from "../src/tools/lcm-describe-tool.js";
import { createLcmExpandQueryTool } from "../src/tools/lcm-expand-query-tool.js";
import { createLcmExpandTool } from "../src/tools/lcm-expand-tool.js";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import { getLcmConversationIds, resolveLcmConversationScope } from "../src/tools/lcm-conversation-scope.js";
import { resetExpansionDelegationGuardForTests } from "../src/tools/lcm-expansion-recursion-guard.js";
import type { LcmDependencies } from "../src/types.js";

const ownKey = "agent:service:telegram:direct:alice";

describe("principal policy configuration and identities", () => {
  it("keeps the default unrestricted and exposes the same schema", () => {
    expect(resolveLcmConfig({}).conversationScopePolicy).toEqual({ mode: "unrestricted", unrestrictedAgents: [] });
    expect(manifest.configSchema.properties.conversationScopePolicy.properties.mode.enum).toEqual(["unrestricted", "principal"]);
    expect(manifest.configSchema.properties.conversationScopePolicy.properties.mode.default).toBe("unrestricted");
    expect(manifest.configSchema.properties.conversationScopePolicy.additionalProperties).toBe(false);
    expect(resolveLcmConfig({}, { conversationScopePolicy: { mode: "principal", unrestrictedAgents: ["main", "main"] } }).conversationScopePolicy)
      .toEqual({ mode: "principal", unrestrictedAgents: ["main"] });
  });

  it.each([null, [], { mode: "other" }, { unrestrictedAgents: "main" }, { unrestrictedAgents: [""] }, { unrestrictedAgents: ["agent:main"] }, { typo: true }])(
    "rejects malformed policy instead of silently enabling global recall: %j", (policy) => {
      expect(() => resolveLcmConfig({}, { conversationScopePolicy: policy })).toThrow("conversationScopePolicy");
    },
  );

  it.each([
    [ownKey, ownKey],
    [`${ownKey}:topic:12`, ownKey],
    [`${ownKey}:heartbeat`, ownKey],
    ["agent:service:main:heartbeat", "agent:service:main"],
    ["agent:service:custom:child", "agent:service:custom:child"],
    ["agent:service:custom:direct:alice:private", "agent:service:custom:direct:alice:private"],
    ["agent:service:line:group:friends:topic:1", "agent:service:line:group:friends"],
    [undefined, undefined], ["unscoped", undefined], ["agent::main", undefined],
  ])("normalizes only host agent-scoped identities: %s", (key, expected) => {
    expect(resolveSessionPrincipal(key)).toBe(expected);
  });
});

describe("principal-scoped recall with real SQLite stores", () => {
  let db: DatabaseSync;
  let dir: string;
  let conversations: ConversationStore;
  let summaries: SummaryStore;
  let retrieval: RetrievalEngine;
  let lcm: LcmContextEngine;
  let deps: LcmDependencies;
  let ids: Record<string, number>;
  const replies = new Map<string, string>();

  beforeEach(async () => {
    resetDelegatedExpansionGrantsForTests();
    resetExpansionDelegationGuardForTests();
    replies.clear();
    dir = mkdtempSync(join(tmpdir(), "lcm-principal-policy-"));
    db = new DatabaseSync(":memory:");
    const features = getLcmDbFeatures(db);
    runLcmMigrations(db, features);
    conversations = new ConversationStore(db, features);
    summaries = new SummaryStore(db, features);
    retrieval = new RetrievalEngine(conversations, summaries);
    lcm = {
      timezone: "UTC", configView: { largeFilesDir: dir },
      getConversationStore: () => conversations,
      getSummaryStore: () => summaries,
      getRetrieval: () => retrieval,
    } as LcmContextEngine;
    deps = {
      config: resolveLcmConfig({}, { conversationScopePolicy: { mode: "principal" }, largeFilesDir: dir }),
      isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
      parseAgentSessionKey: (key: string) => ({ agentId: key.split(":")[1]!, suffix: key.split(":").slice(2).join(":") }),
      normalizeAgentId: (id?: string) => id || "main",
      buildSubagentSystemPrompt: () => "test retrieval",
      readLatestAssistantReply: (messages: unknown[]) => (messages[0] as { content?: string })?.content,
      agentLaneSubagent: "subagent",
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    } as unknown as LcmDependencies;
    // The fake host actually invokes the child retrieval tool under the issued
    // grant. No model, network, production database, or outbound delivery is used.
    deps.callGateway = vi.fn(async ({ method, params }) => {
      const p = params ?? {};
      if (method === "agent") {
        const key = String(p.sessionKey);
        const task = String(p.message);
        const conversationId = Number(task.match(/Conversation scope: (\d+)/)?.[1]);
        const summaryIds = task.match(/Seed summary IDs: ([^\n]+)/)![1]!.split(", ");
        const expanded = await createLcmExpandTool({ deps, lcm, sessionKey: key }).execute("child-expand", {
          conversationId, summaryIds, includeMessages: true,
        });
        const details = expanded.details as { citedIds?: string[]; text?: string; error?: string };
        expect(details.error).toBeUndefined();
        replies.set(key, JSON.stringify({
          answer: details.text || "Expanded owner history", citedIds: details.citedIds,
          expandedSummaryCount: summaryIds.length, totalSourceTokens: 20, truncated: false,
        }));
        return { runId: key };
      }
      if (method === "agent.wait") return { status: "ok" };
      if (method === "sessions.get") return { messages: [{ role: "assistant", content: replies.get(String(p.key)) }] };
      return {};
    });
    ids = {};
    const keys: Record<string, string | undefined> = {
      archive: ownKey, own: ownKey, topic: `${ownKey}:topic:12`, heartbeat: `${ownKey}:heartbeat`,
      otherdm: "agent:service:telegram:direct:bob",
      group: "agent:service:telegram:group:alice",
      channel: "agent:service:telegram:channel:alice",
      otherchannel: "agent:service:discord:direct:alice",
      otheragent: "agent:other:telegram:direct:alice",
      unknown: undefined,
    };
    for (const [label, sessionKey] of Object.entries(keys)) {
      const conversationId = (await conversations.createConversation({ sessionId: label, sessionKey })).conversationId;
      ids[label] = conversationId;
      const message = await conversations.createMessage({ conversationId, seq: 1, role: "user", content: `policyfact ${label}`, tokenCount: 3 });
      await summaries.insertSummary({ summaryId: `sum_${label}`, conversationId, kind: "leaf", content: `policyfact ${label}`, tokenCount: 3 });
      await summaries.linkSummaryToMessages(`sum_${label}`, [message.messageId]);
      const storageUri = join(dir, `${label}.txt`);
      writeFileSync(storageUri, `policyfact ${label}`);
      await summaries.insertLargeFile({ fileId: `file_${label}`, conversationId, storageUri, mimeType: "text/plain", byteSize: 32 });
      if (label === "archive") await conversations.archiveConversation(conversationId, "manual-reset");
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetDelegatedExpansionGrantsForTests();
    resetExpansionDelegationGuardForTests();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function grep(sessionKey = ownKey) {
    return createLcmGrepTool({ deps, lcm, sessionKey });
  }
  function describeItem(sessionKey = ownKey) {
    return createLcmDescribeTool({ deps, lcm, sessionKey });
  }
  function expandQuery(sessionKey = ownKey) {
    return createLcmExpandQueryTool({ deps, lcm, sessionKey, requesterSessionKey: sessionKey });
  }

  it.each(["full_text", "regex"])("bounds %s message and summary search, including archives", async (mode) => {
    const result = await grep().execute("grep", { pattern: "policyfact", mode, allConversations: true });
    const text = JSON.stringify(result);
    for (const label of ["own", "archive", "topic", "heartbeat"]) expect(text).toContain(`sum_${label}`);
    for (const label of ["otherdm", "group", "channel", "otherchannel", "otheragent", "unknown"]) expect(text).not.toContain(`sum_${label}`);
    const details = result.details as { messages: Array<{ conversationId: number }>; summaries: Array<{ conversationId: number }> };
    const allowed = [ids.own, ids.archive, ids.topic, ids.heartbeat];
    expect(details.messages).toHaveLength(4);
    expect(details.summaries).toHaveLength(4);
    for (const row of [...details.messages, ...details.summaries]) expect(allowed).toContain(row.conversationId);
  });

  it.each(["otherdm", "group", "channel", "otherchannel", "otheragent", "unknown"])("rejects foreign explicit conversation %s", async (label) => {
    const search = vi.spyOn(retrieval, "grep");
    const result = await grep().execute("foreign", { pattern: "policyfact", conversationId: ids[label] });
    expect(JSON.stringify(result)).toContain("outside this principal scope");
    expect(search).not.toHaveBeenCalled();
  });

  it("rejects a runtime-ID fallback to a different principal", async () => {
    const result = await createLcmGrepTool({ deps, lcm, sessionKey: ownKey, sessionId: "otherdm" })
      .execute("stale", { pattern: "policyfact" });
    expect(JSON.stringify(result)).toContain("outside this principal scope");
  });

  it("denies an unresolved exact topic within a known principal before content access", async () => {
    const sessionKey = `${ownKey}:topic:uncreated`;
    expect(await conversations.getConversationIdsForPrincipal(sessionKey)).not.toHaveLength(0);
    expect(await conversations.getConversationBySessionKey(sessionKey)).toBeNull();
    const scope = await resolveLcmConversationScope({ deps, lcm, sessionKey, params: {} });
    expect(scope.error).toContain("No LCM conversation found in this principal scope");
    expect(getLcmConversationIds(scope)).toBeUndefined();
    const read = vi.spyOn(retrieval, "describe");
    const result = await describeItem(sessionKey).execute("new-topic", { id: "file_otherdm", expandFile: true });
    expect(JSON.stringify(result)).toContain("No LCM conversation found in this principal scope");
    expect(read).not.toHaveBeenCalled();
  });

  it.each(["grep", "describe", "expand_query"])("keeps unresolved exact topic %s calls out of retrieval", async (kind) => {
    const sessionKey = `${ownKey}:topic:uncreated`;
    const search = vi.spyOn(retrieval, "grep");
    const read = vi.spyOn(retrieval, "describe");
    const tool = kind === "grep" ? grep(sessionKey) : kind === "describe" ? describeItem(sessionKey) : expandQuery(sessionKey);
    const result = await tool.execute("uncreated", {
      pattern: "policyfact", id: "file_otherdm", summaryIds: ["sum_otherdm"], prompt: "Recall", expandFile: true,
    });
    expect(JSON.stringify(result)).toContain("No LCM conversation found");
    expect(JSON.stringify(result)).not.toContain("policyfact otherdm");
    expect(search).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(deps.callGateway).not.toHaveBeenCalled();
  });

  it("permits bounded allConversations for a new exact topic within a known principal", async () => {
    const sessionKey = `${ownKey}:topic:uncreated`;
    const scope = await resolveLcmConversationScope({ deps, lcm, sessionKey, params: { allConversations: true } });
    expect(scope.error).toBeUndefined();
    expect(scope.conversationIds?.sort()).toEqual([ids.own, ids.archive, ids.topic, ids.heartbeat].sort());
    const own = await describeItem(sessionKey).execute("own", { id: "file_own", expandFile: true, allConversations: true });
    const foreign = await describeItem(sessionKey).execute("foreign", { id: "file_otherdm", expandFile: true, allConversations: true });
    expect(JSON.stringify(own)).toContain("policyfact own");
    expect(JSON.stringify(foreign)).toContain("Not found");
  });

  it.each([undefined, "not-an-agent", "agent:service:telegram:direct:missing"])("fails closed on a missing or unknown host identity %s", async (sessionKey) => {
    const search = vi.spyOn(retrieval, "grep");
    const result = await createLcmGrepTool({ deps, lcm, sessionKey }).execute("unknown", {
      pattern: "policyfact", allConversations: true, agentId: "other", sessionKey: ownKey,
    });
    expect(JSON.stringify(result)).toMatch(/requires an agent-scoped|No conversations are available/);
    expect(search).not.toHaveBeenCalled();
  });

  it("filters explicit file IDs before loading any foreign file body", async () => {
    const fileRecord = vi.spyOn(summaries, "getLargeFile");
    const read = vi.spyOn(summaries as unknown as {
      readValidatedLargeFileContentUpTo: (uri: string, options: unknown) => Promise<unknown>;
    }, "readValidatedLargeFileContentUpTo");
    const result = await grep().execute("files", {
      pattern: "policyfact", scope: "files", fileIds: ["file_own", "file_otherdm"], allConversations: true,
    });
    expect(JSON.stringify(result)).toContain("policyfact own");
    expect(JSON.stringify(result)).not.toContain("policyfact otherdm");
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]?.[0]).toBe(join(dir, "own.txt"));
    expect(fileRecord).toHaveBeenCalledTimes(1);
    expect(fileRecord).toHaveBeenCalledWith("file_own");
  });

  it.each(["sum", "file"])("rejects foreign direct %s IDs before content/lineage/file reads", async (kind) => {
    const summaryRead = vi.spyOn(summaries, "getSummary");
    const fileRead = vi.spyOn(summaries, "getLargeFile");
    const result = await describeItem().execute("describe", { id: `${kind}_otherdm`, expandFile: true, allConversations: true });
    expect(JSON.stringify(result)).toContain("Not found");
    expect(summaryRead).not.toHaveBeenCalled();
    expect(fileRead).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("policyfact otherdm");
  });

  it("permits own archived file expansion and summary description", async () => {
    const file = await describeItem().execute("file", { id: "file_archive", expandFile: true, allConversations: true });
    const summary = await describeItem().execute("summary", { id: "sum_archive", allConversations: true });
    expect(JSON.stringify(file)).toContain("policyfact archive");
    expect(JSON.stringify(summary)).toContain("policyfact archive");
  });

  it("treats an explicit empty describe scope as deny-all", async () => {
    const read = vi.spyOn(summaries, "getItemConversationId");
    expect(await retrieval.describe("file_own", { conversationIds: [], expandFile: true, largeFilesDir: dir })).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("expands multiple permitted buckets through real child tools and bounded grants", async () => {
    const result = await expandQuery().execute("query", { summaryIds: ["sum_own", "sum_archive"], prompt: "Recall the facts", allConversations: true });
    expect((result.details as { sourceConversationIds: number[] }).sourceConversationIds.sort()).toEqual(
      [ids.own, ids.archive].sort(),
    );
    expect(replies.size).toBe(2);
    for (const value of replies.values()) expect(value).not.toContain("policyfact other");
  });

  it.each([true, false])("rejects mixed/foreign explicit summary IDs before delegation, all=%s", async (allConversations) => {
    const result = await expandQuery().execute("mixed", {
      summaryIds: ["sum_own", "sum_otherdm"], prompt: "Recall", allConversations,
    });
    expect(JSON.stringify(result)).toContain("Summary not found");
    expect(deps.callGateway).not.toHaveBeenCalled();
  });

  it("preserves unrestricted defaults and explicit operator exceptions", async () => {
    for (const policy of [undefined, { mode: "unrestricted" }, { mode: "principal", unrestrictedAgents: ["service"] }]) {
      deps.config = resolveLcmConfig({}, policy ? { conversationScopePolicy: policy } : {});
      const result = await grep().execute("global", { pattern: "policyfact", allConversations: true });
      expect(JSON.stringify(result)).toContain("sum_otheragent");
      const direct = await describeItem().execute("direct", { id: "sum_otheragent", allConversations: true });
      expect(JSON.stringify(direct)).toContain("policyfact otheragent");
    }
  });

  it("preserves delegated source and own-child file scope without widening the grant", async () => {
    const childKey = "agent:service:subagent:test-child";
    const childId = (await conversations.createConversation({ sessionId: "child", sessionKey: childKey })).conversationId;
    const storageUri = join(dir, "child.txt");
    writeFileSync(storageUri, "own child instructions");
    await summaries.insertLargeFile({ fileId: "file_child", conversationId: childId, storageUri, mimeType: "text/plain" });
    const grant = createDelegatedExpansionGrant({ delegatedSessionKey: childKey, issuerSessionId: "own", allowedConversationIds: [ids.own!], tokenCap: 100 });
    deps.config.conversationScopePolicy!.unrestrictedAgents = ["service"];
    const file = await describeItem(childKey).execute("child-file", { id: "file_child", expandFile: true, allConversations: true });
    expect(JSON.stringify(file)).toContain("own child instructions");
    const expanded = await createLcmExpandTool({ deps, lcm, sessionKey: childKey }).execute("allowed", {
      summaryIds: ["sum_own"], conversationId: ids.own, includeMessages: true,
    });
    expect((expanded.details as { citedIds: string[] }).citedIds).toContain("sum_own");
    const foreign = await createLcmExpandTool({ deps, lcm, sessionKey: childKey }).execute("foreign", {
      summaryIds: ["sum_otherdm"], conversationId: ids.own,
    });
    expect(JSON.stringify(foreign)).toContain("outside conversation");
    const foreignFile = await describeItem(childKey).execute("foreign-file", { id: "file_otherdm", allConversations: true, expandFile: true });
    expect(JSON.stringify(foreignFile)).not.toContain("policyfact otherdm");
    expect(grant.allowedConversationIds).toEqual([ids.own]);
  });

  it.each(["missing", "expired"])("denies delegated reads with %s grants even for an exempt agent", async (state) => {
    const key = "agent:service:subagent:invalid";
    deps.config.conversationScopePolicy!.unrestrictedAgents = ["service"];
    if (state === "expired") createDelegatedExpansionGrant({ delegatedSessionKey: key, issuerSessionId: "own", allowedConversationIds: [ids.own!], tokenCap: 100, ttlMs: -1 });
    const result = await describeItem(key).execute("invalid", { id: "sum_own", allConversations: true });
    expect(JSON.stringify(result)).toMatch(/requires a valid grant|authorization failed/);
    expect(JSON.stringify(result)).not.toContain("policyfact own");
  });

  it("matches unusual agent keys exactly and escapes SQL LIKE metacharacters", async () => {
    const key = "agent:percent_%:custom:exact";
    const own = (await conversations.createConversation({ sessionId: "special", sessionKey: key })).conversationId;
    const heartbeat = (await conversations.createConversation({ sessionId: "special-heartbeat", sessionKey: `${key}:heartbeat` })).conversationId;
    await conversations.createConversation({ sessionId: "special-other", sessionKey: `${key}:other` });
    await conversations.createConversation({ sessionId: "wildcard", sessionKey: "agent:percent_AB:custom:exact" });
    expect((await conversations.getConversationIdsForPrincipal(key)).sort()).toEqual([own, heartbeat].sort());
    const custom = "agent:service:custom:direct:alice";
    const exact = (await conversations.createConversation({ sessionId: "custom", sessionKey: custom })).conversationId;
    await conversations.createConversation({ sessionId: "custom-private", sessionKey: `${custom}:private` });
    expect(await conversations.getConversationIdsForPrincipal(custom)).toEqual([exact]);
  });
});
