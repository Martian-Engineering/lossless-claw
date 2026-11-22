import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import type { LcmContextEngine } from "../src/engine.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import type { LcmDependencies } from "../src/types.js";
import { resolveLcmConversationScope } from "../src/tools/lcm-conversation-scope.js";

describe("runtime session recall identity", () => {
  const requestedKey = "agent:fixture:main";

  async function resolve(input: {
    runtimeKey: string | null;
    runtimeActive?: boolean;
    sameConversation?: boolean;
    missingRuntime?: boolean;
  }) {
    const keyed = {
      conversationId: 101,
      sessionId: "keyed-runtime",
      sessionKey: requestedKey,
      active: true,
    };
    const runtime = {
      conversationId: input.sameConversation ? 101 : 202,
      sessionId: "shared-runtime",
      sessionKey: input.runtimeKey,
      active: input.runtimeActive ?? true,
    };
    const store = {
      getConversationBySessionKey: vi.fn(async () => keyed),
      getConversationBySessionId: vi.fn(async () => input.missingRuntime ? null : runtime),
      getConversationFamilyIds: vi.fn(async ({ conversationId }: { conversationId: number }) =>
        conversationId === 101 ? [101, 100] : [202, 201]),
    };
    const warn = vi.fn();
    const scope = await resolveLcmConversationScope({
      lcm: { getConversationStore: () => store } as never,
      sessionKey: " " + requestedKey + " ",
      sessionId: "shared-runtime",
      params: {},
      deps: {
        isSubagentSessionKey: () => false,
        log: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
      },
    });
    return { scope, store, warn };
  }

  it("keeps the requested key when an active runtime ID collides", async () => {
    const { scope, store, warn } = await resolve({
      runtimeKey: "agent:fixture:internal-review",
    });
    expect(scope).toMatchObject({ conversationId: 101, conversationIds: [101, 100], delegated: false });
    expect(store.getConversationFamilyIds).toHaveBeenCalledWith({
      conversationId: 101, sessionId: undefined, sessionKey: requestedKey,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([requestedKey, " " + requestedKey + " ", null, "", "  "])("preserves active runtime preference for a matching or absent key (%s)", async (runtimeKey) => {
    const { scope, warn } = await resolve({ runtimeKey });
    expect(scope).toMatchObject({ conversationId: 202, conversationIds: [202, 201] });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("does not prefer an inactive runtime generation", async () => {
    const { scope, warn } = await resolve({ runtimeKey: requestedKey, runtimeActive: false });
    expect(scope.conversationId).toBe(101);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not warn when both identities select the same conversation", async () => {
    const { scope, warn } = await resolve({ runtimeKey: requestedKey, sameConversation: true });
    expect(scope.conversationId).toBe(101);
    expect(warn).not.toHaveBeenCalled();
  });

  it("preserves keyed lookup when the runtime ID is not found", async () => {
    const { scope, warn } = await resolve({ runtimeKey: requestedKey, missingRuntime: true });
    expect(scope.conversationId).toBe(101);
    expect(warn).not.toHaveBeenCalled();
  });
});


describe("runtime fallback recall identity with persisted conversations", () => {
  const requestedKey = "agent:fixture:main";
  const deps = {
    isSubagentSessionKey: () => false,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
  let db: DatabaseSync;
  let store: ConversationStore;
  let lcm: LcmContextEngine;
  let foreignId: number;

  beforeEach(async () => {
    db = new DatabaseSync(":memory:");
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });
    store = new ConversationStore(db, { fts5Available });
    const retrieval = new RetrievalEngine(store, new SummaryStore(db, { fts5Available }));
    lcm = {
      getConversationStore: () => store,
      getRetrieval: () => retrieval,
      timezone: "UTC",
    } as LcmContextEngine;
    foreignId = (await store.createConversation({
      sessionId: "shared-runtime", sessionKey: "agent:fixture:internal-review",
    })).conversationId;
    await store.createMessage({
      conversationId: foreignId, seq: 1, role: "user",
      content: "collision-sentinel foreign history", tokenCount: 8,
    });
  });

  afterEach(() => db.close());

  async function archiveRequestedConversation() {
    const conversation = await store.createConversation({
      sessionId: "keyed-runtime", sessionKey: requestedKey,
    });
    await store.archiveConversation(conversation.conversationId, "manual-reset");
  }

  it.each(["archived", "missing"])("leaves the %s requested key unresolved instead of selecting a foreign runtime", async (kind) => {
    if (kind === "archived") await archiveRequestedConversation();
    expect(await store.getConversationBySessionKey(requestedKey)).toBeNull();
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: " " + requestedKey + " ", sessionId: "shared-runtime", params: {},
    });
    expect(scope).toEqual({
      conversationId: undefined, conversationIds: undefined,
      allConversations: false, delegated: false,
    });
  });

  it.each(["archived", "missing"])("lcm_grep refuses foreign history for the %s key unless explicitly requested", async (kind) => {
    if (kind === "archived") await archiveRequestedConversation();
    const tool = createLcmGrepTool({
      lcm, deps: deps as unknown as LcmDependencies, sessionKey: requestedKey, sessionId: "shared-runtime",
    });
    const params = { pattern: "collision-sentinel", scope: "messages" };
    const result = await tool.execute("default-scope", params);
    expect(result.details).toMatchObject({ error: expect.stringContaining("No LCM conversation found") });
    expect(JSON.stringify(result)).not.toContain("collision-sentinel");
    for (const override of [{ allConversations: true }, { conversationId: foreignId }]) {
      const explicit = await tool.execute("explicit-scope", { ...params, ...override });
      expect(explicit.details).toMatchObject({
        totalMatches: 1, messages: [expect.objectContaining({ conversationId: foreignId })],
      });
    }
  });

  it("preserves an unkeyed legacy runtime fallback", async () => {
    const legacy = await store.createConversation({ sessionId: "legacy-runtime" });
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: requestedKey, sessionId: "legacy-runtime", params: {},
    });
    expect(scope).toMatchObject({
      conversationId: legacy.conversationId, conversationIds: [legacy.conversationId],
    });
  });

  it("preserves runtime lookup without an explicit key", async () => {
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionId: "shared-runtime", params: {},
    });
    expect(scope).toMatchObject({ conversationId: foreignId, conversationIds: [foreignId] });
  });
});
