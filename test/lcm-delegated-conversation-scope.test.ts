import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import type { LcmContextEngine } from "../src/engine.js";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
  revokeDelegatedExpansionGrantForSession,
} from "../src/expansion-auth.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { resolveLcmConversationScope } from "../src/tools/lcm-conversation-scope.js";

const childKey = "agent:main:subagent:scope-child";
const deps = {
  isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
};

describe("delegated own-conversation authorization", () => {
  let db: DatabaseSync;
  let store: ConversationStore;
  let lcm: LcmContextEngine;
  let parentId: number;
  let childId: number;
  let foreignId: number;

  beforeEach(async () => {
    resetDelegatedExpansionGrantsForTests();
    db = new DatabaseSync(":memory:");
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });
    store = new ConversationStore(db, { fts5Available });
    lcm = { getConversationStore: () => store } as LcmContextEngine;

    // Separate identities exercise the real store's key and runtime-ID lookups.
    parentId = (await store.createConversation({
      sessionId: "parent-runtime", sessionKey: "agent:main:main",
    })).conversationId;
    childId = (await store.createConversation({
      sessionId: "child-runtime", sessionKey: childKey,
    })).conversationId;
    foreignId = (await store.createConversation({
      sessionId: "foreign-runtime", sessionKey: "agent:other:main",
    })).conversationId;
  });

  afterEach(() => {
    resetDelegatedExpansionGrantsForTests();
    db.close();
  });

  // Grant the parent source only; own-conversation access is the tested addition.
  function grant(allowedConversationIds = [parentId], ttlMs = 60_000) {
    return createDelegatedExpansionGrant({
      delegatedSessionKey: childKey,
      issuerSessionId: "parent-runtime",
      allowedConversationIds,
      tokenCap: 100,
      ttlMs,
    });
  }

  it("adds only the active exact-key child without mutating the source grant", async () => {
    const sourceGrant = grant();
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: childKey, sessionId: "foreign-runtime",
      params: { allConversations: true },
    });
    expect(scope).toMatchObject({ delegated: true, allConversations: false });
    expect(scope.conversationIds).toEqual([parentId, childId]);
    expect(sourceGrant.allowedConversationIds).toEqual([parentId]);
  });

  it("accepts a delegated session key supplied through sessionId", async () => {
    grant();
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionId: childKey, params: { conversationId: childId },
    });
    expect(scope.error).toBeUndefined();
    expect(scope.conversationIds).toEqual([childId]);
  });

  it.each(["inactive", "foreign"])("rejects an ungranted %s conversation", async (kind) => {
    grant();
    if (kind === "inactive") await store.archiveConversation(childId, "manual-reset");
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: childKey, sessionId: "child-runtime",
      params: { conversationId: kind === "inactive" ? childId : foreignId },
    });
    expect(scope.error).toContain("outside delegated conversation scope");
  });

  it.each(["absent", "empty", "expired", "revoked"])("rejects own access with an %s grant", async (kind) => {
    if (kind !== "absent") grant(kind === "empty" ? [] : [parentId], kind === "expired" ? -1 : 60_000);
    if (kind === "revoked") revokeDelegatedExpansionGrantForSession(childKey);
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: childKey, params: { conversationId: childId },
    });
    expect(scope.error).toBeTruthy();
    expect(scope.conversationIds).toBeUndefined();
  });

  it("preserves explicitly granted parent access", async () => {
    grant();
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: childKey, params: { conversationId: parentId },
    });
    expect(scope.error).toBeUndefined();
    expect(scope.conversationIds).toEqual([parentId]);
  });

  it("does not broaden grants when exact-key lookup misses and runtime ID belongs elsewhere", async () => {
    const missingKey = "agent:main:subagent:missing";
    createDelegatedExpansionGrant({
      delegatedSessionKey: missingKey, issuerSessionId: "parent-runtime",
      allowedConversationIds: [parentId], tokenCap: 100,
    });
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: missingKey, sessionId: "foreign-runtime",
      params: { conversationId: foreignId },
    });
    expect(scope.error).toContain("outside delegated conversation scope");
  });

  it("leaves ordinary parent-session lookup unchanged", async () => {
    const scope = await resolveLcmConversationScope({
      lcm, deps, sessionKey: "agent:main:main", sessionId: "parent-runtime", params: {},
    });
    expect(scope).toMatchObject({ delegated: false, conversationId: parentId });
    expect(scope.conversationIds).toEqual([parentId]);
  });
});
