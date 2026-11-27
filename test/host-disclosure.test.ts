import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLcmDbFeatures } from "../src/db/features.js";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  createDisclosureGate,
  DISCLOSURE_RESULT_WITHHELD,
  type LcmDisclosureCapability,
} from "../src/disclosure.js";
import type { LcmContextEngine } from "../src/engine.js";
import {
  createDelegatedExpansionGrant,
  resetDelegatedExpansionGrantsForTests,
} from "../src/expansion-auth.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { ConversationStore } from "../src/store/conversation-store.js";
import { SummaryStore } from "../src/store/summary-store.js";
import { createLcmDescribeTool } from "../src/tools/lcm-describe-tool.js";
import { createLcmExpandQueryTool } from "../src/tools/lcm-expand-query-tool.js";
import { createLcmExpandTool } from "../src/tools/lcm-expand-tool.js";
import { createLcmGrepTool } from "../src/tools/lcm-grep-tool.js";
import { resolveLcmConversationScope } from "../src/tools/lcm-conversation-scope.js";

const ALICE = "agent:main:telegram:direct:alice";
const BOB = "agent:main:telegram:direct:bob";
const ROOM = "agent:main:telegram:group:room";
const childKey = "agent:main:subagent:disclosure-child";

const deps = {
  isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  config: { maxExpandTokens: 4000, delegationTimeoutMs: 1000 },
  normalizeAgentId: (value?: string) => value ?? "main",
  parseAgentSessionKey: () => ({ agentId: "main" }),
} as never;

/** Live host capability: the audience may see exactly the session keys in `visible`. */
function capability(visible: Set<string>, overrides: Partial<LcmDisclosureCapability> = {}) {
  return {
    version: 1 as const,
    requesterId: "person:test",
    audienceId: "audience:test",
    authorizeConversations: (targets) =>
      targets.map((target) => target.sessionKey != null && visible.has(target.sessionKey)),
    ...overrides,
  } satisfies LcmDisclosureCapability;
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ text: string }> }).content;
  return content.map((part) => part.text).join("\n");
}

describe("host-bound disclosure capability", () => {
  let db: DatabaseSync;
  let conversations: ConversationStore;
  let summaries: SummaryStore;
  let lcm: LcmContextEngine;
  let filesDir: string;
  const ids = {} as Record<"alice" | "bob" | "room", number>;

  beforeEach(async () => {
    resetDelegatedExpansionGrantsForTests();
    filesDir = mkdtempSync(join(tmpdir(), "lcm-disclosure-"));
    db = new DatabaseSync(":memory:");
    const { fts5Available } = getLcmDbFeatures(db);
    runLcmMigrations(db, { fts5Available });
    conversations = new ConversationStore(db, { fts5Available });
    summaries = new SummaryStore(db, { fts5Available });
    const retrieval = new RetrievalEngine(conversations, summaries);
    lcm = {
      getConversationStore: () => conversations,
      getSummaryStore: () => summaries,
      getRetrieval: () => retrieval,
      timezone: "UTC",
      configView: { largeFilesDir: filesDir },
    } as unknown as LcmContextEngine;

    for (const [name, key] of [["alice", ALICE], ["bob", BOB], ["room", ROOM]] as const) {
      const conversation = await conversations.createConversation({
        sessionId: `${name}-runtime`,
        sessionKey: key,
      });
      ids[name] = conversation.conversationId;
      await conversations.createMessage({
        conversationId: conversation.conversationId,
        seq: 1,
        role: "user",
        content: `${name.toUpperCase()}-BODY secret ${name}`,
        tokenCount: 5,
      });
      await summaries.insertSummary({
        summaryId: `sum_${name}`,
        conversationId: conversation.conversationId,
        kind: "leaf",
        content: `${name.toUpperCase()}-SUMMARY marker ${name}`,
        tokenCount: 5,
      });
      const storageUri = join(filesDir, `${name}.txt`);
      writeFileSync(storageUri, `${name.toUpperCase()}-FILE marker ${name}\n`);
      await summaries.insertLargeFile({
        fileId: `file_${name}`,
        conversationId: conversation.conversationId,
        fileName: `${name}-private-name.txt`,
        mimeType: "text/plain",
        byteSize: 40,
        lineCount: 1,
        storageUri,
        explorationSummary: `${name.toUpperCase()}-EXPLORATION`,
      });
    }
  });

  afterEach(() => {
    resetDelegatedExpansionGrantsForTests();
    db.close();
    rmSync(filesDir, { recursive: true, force: true });
  });

  function describeTool(sessionKey: string, disclosure?: unknown) {
    return createLcmDescribeTool({
      deps,
      lcm,
      sessionKey,
      sessionId: `${sessionKey}-runtime`,
      disclosure,
    });
  }
  function grepTool(sessionKey: string, disclosure?: unknown) {
    return createLcmGrepTool({ deps, lcm, sessionKey, disclosure });
  }

  describe("fail-closed gate construction", () => {
    it("treats an absent capability as unchanged and anything unusable as deny-all", () => {
      expect(createDisclosureGate(undefined)).toBeNull();
      expect(createDisclosureGate(null)).toBeNull();
      for (const bad of [{}, "yes", 42, { version: 1 }, { ...capability(new Set()), audienceId: "" }, { ...capability(new Set()), requesterId: " " }, { ...capability(new Set()), version: 2 }]) {
        expect(createDisclosureGate(bad)?.denyAll).toBe(true);
      }
    });

    it("denies on a throwing, short, or non-true decision", async () => {
      const everything = [ids.alice, ids.bob, ids.room];
      for (const authorizeConversations of [
        () => { throw new Error("host unavailable"); },
        () => [true],
        () => everything.map(() => "true" as unknown as boolean),
        async () => { throw new Error("async host unavailable"); },
      ]) {
        const gate = createDisclosureGate(capability(new Set(), { authorizeConversations }));
        expect([...(await gate!.authorizeConversationIds(lcm, everything))]).toEqual([]);
      }
    });
  });

  describe("explicit and global conversation targets", () => {
    it("lets a known conversation ID select but never grant access", async () => {
      const gate = createDisclosureGate(capability(new Set([ALICE])));
      const foreign = await resolveLcmConversationScope({
        lcm, deps, sessionKey: ALICE, disclosure: gate, params: { conversationId: ids.bob },
      });
      const missing = await resolveLcmConversationScope({
        lcm, deps, sessionKey: ALICE, disclosure: gate, params: { conversationId: 999_999 },
      });
      expect(foreign.error).toBeTruthy();
      expect(foreign.error).toBe(missing.error);
      expect(foreign.conversationIds).toBeUndefined();
    });

    it("limits allConversations to the live authorized set instead of the database", async () => {
      const bobAndRoom = createDisclosureGate(capability(new Set([BOB, ROOM])));
      const scope = await resolveLcmConversationScope({
        lcm, deps, sessionKey: BOB, disclosure: bobAndRoom, params: { allConversations: true },
      });
      expect(scope.conversationIds).toEqual([ids.bob, ids.room]);

      const ungated = await resolveLcmConversationScope({
        lcm, deps, sessionKey: BOB, params: { allConversations: true },
      });
      expect(ungated.allConversations).toBe(true);
      expect(ungated.conversationIds).toBeUndefined();
    });

    it("lets a room audience see only what was admitted to the room", async () => {
      const room = capability(new Set([ROOM]));
      const result = await grepTool(ROOM, room).execute("call", {
        pattern: "marker",
        allConversations: true,
        scope: "both",
      });
      const text = textOf(result);
      expect(text).toContain("sum_room");
      expect(text).not.toMatch(/sum_alice|sum_bob|conv=1|conv=2/);
    });
  });

  describe("recall tools", () => {
    it("lcm_grep default scope, messages, summaries and files never include denied conversations", async () => {
      const aliceOnly = capability(new Set([ALICE]));
      for (const scope of ["messages", "summaries", "files", "both"] as const) {
        const text = textOf(await grepTool(ALICE, aliceOnly).execute("call", {
          pattern: "marker|secret",
          mode: "regex",
          scope,
          allConversations: true,
          ...(scope === "files" ? { fileIds: ["file_bob", "file_alice"] } : {}),
        }));
        expect(text).not.toMatch(/BOB|bob-private/);
      }
    });

    it("lcm_describe answers a forbidden summary or file exactly like a missing one", async () => {
      const aliceOnly = capability(new Set([ALICE]));
      const tool = describeTool(ALICE, aliceOnly);
      const forbiddenSummary = textOf(await tool.execute("c", { id: "sum_bob" }));
      const missingSummary = textOf(await tool.execute("c", { id: "sum_nope" }));
      expect(forbiddenSummary.replace("sum_bob", "X")).toBe(missingSummary.replace("sum_nope", "X"));

      const forbiddenFile = textOf(await tool.execute("c", {
        id: "file_bob", expandFile: true, allConversations: true,
      }));
      const missingFile = textOf(await tool.execute("c", {
        id: "file_nope", expandFile: true, allConversations: true,
      }));
      expect(forbiddenFile.replace("file_bob", "X")).toBe(missingFile.replace("file_nope", "X"));
      expect(forbiddenFile).not.toMatch(/BOB|bob-private|EXPLORATION/);
    });

    it("lcm_describe still serves permitted content", async () => {
      const text = textOf(await describeTool(ALICE, capability(new Set([ALICE])))
        .execute("c", { id: "file_alice", expandFile: true }));
      expect(text).toContain("ALICE-FILE");
      expect(text).toContain("ALICE-EXPLORATION");
    });

    it("drops derived lineage and file references owned by a denied conversation", async () => {
      await summaries.insertSummary({
        summaryId: "sum_alice_parent_of_bob",
        conversationId: ids.alice,
        kind: "condensed",
        content: "ALICE-CONDENSED",
        tokenCount: 3,
        fileIds: ["file_bob", "file_alice"],
      });
      await summaries.linkSummaryToParents("sum_alice_parent_of_bob", ["sum_alice", "sum_bob"]);
      const result = await describeTool(ALICE, capability(new Set([ALICE])))
        .execute("c", { id: "sum_alice_parent_of_bob" });
      const details = (result as { details: { summary: { parentIds: string[]; fileIds: string[]; subtree: Array<{ summaryId: string }> } } }).details;
      expect(details.summary.parentIds).toEqual(["sum_alice"]);
      expect(details.summary.fileIds).toEqual(["file_alice"]);
      expect(JSON.stringify(result)).not.toContain("sum_bob");
      expect(JSON.stringify(result)).not.toContain("file_bob");
    });

    it("without a capability behavior is unchanged", async () => {
      const text = textOf(await describeTool(ALICE).execute("c", {
        id: "sum_bob", allConversations: true,
      }));
      expect(text).toContain("BOB-SUMMARY");
    });
  });

  describe("revocation and release", () => {
    it("withholds a result when authority is revoked while the lookup awaits", async () => {
      const visible = new Set([ALICE]);
      const retrieval = lcm.getRetrieval();
      const realGrep = retrieval.grep.bind(retrieval);
      vi.spyOn(retrieval, "grep").mockImplementation(async (input) => {
        const out = await realGrep(input);
        visible.delete(ALICE); // revocation lands between lookup and release
        return out;
      });
      const text = textOf(await grepTool(ALICE, capability(visible)).execute("c", {
        pattern: "marker", scope: "summaries",
      }));
      expect(text).toContain(DISCLOSURE_RESULT_WITHHELD);
      expect(text).not.toContain("ALICE-SUMMARY");
    });

    it("withholds describe output when the audience changes mid-request", async () => {
      const visible = new Set([ALICE]);
      const retrieval = lcm.getRetrieval();
      const realDescribe = retrieval.describe.bind(retrieval);
      vi.spyOn(retrieval, "describe").mockImplementation(async (id, options) => {
        const out = await realDescribe(id, options);
        visible.clear();
        return out;
      });
      const text = textOf(await describeTool(ALICE, capability(visible)).execute("c", { id: "sum_alice" }));
      expect(text).toContain(DISCLOSURE_RESULT_WITHHELD);
      expect(text).not.toContain("ALICE-SUMMARY");
    });

    it("re-evaluates every call so a revoked grant stops new disclosures", async () => {
      const visible = new Set([ALICE]);
      const tool = describeTool(ALICE, capability(visible));
      expect(textOf(await tool.execute("c", { id: "sum_alice" }))).toContain("ALICE-SUMMARY");
      visible.delete(ALICE);
      const after = textOf(await tool.execute("c", { id: "sum_alice" }));
      expect(after).not.toContain("ALICE-SUMMARY");
    });
  });

  describe("delegation intersects, never widens", () => {
    it("limits a delegated child to grant ∩ host authority", async () => {
      createDelegatedExpansionGrant({
        delegatedSessionKey: childKey,
        issuerSessionId: "alice-runtime",
        allowedConversationIds: [ids.alice, ids.bob],
        tokenCap: 1000,
      });
      const gate = createDisclosureGate(capability(new Set([ALICE])));
      const scope = await resolveLcmConversationScope({
        lcm, deps, sessionKey: childKey, disclosure: gate, params: { allConversations: true },
      });
      expect(scope.conversationIds).toEqual([ids.alice]);

      const denied = await resolveLcmConversationScope({
        lcm, deps, sessionKey: childKey, disclosure: gate, params: { conversationId: ids.bob },
      });
      expect(denied.error).toBeTruthy();
    });

    it("a capability on a child without any grant does not create access", async () => {
      const scope = await resolveLcmConversationScope({
        lcm, deps, sessionKey: childKey,
        disclosure: createDisclosureGate(capability(new Set([ALICE, BOB, ROOM]))),
        params: { conversationId: ids.alice },
      });
      expect(scope.error).toBeTruthy();
    });

    it("lcm_expand refuses summaries outside host authority even inside the grant", async () => {
      createDelegatedExpansionGrant({
        delegatedSessionKey: childKey,
        issuerSessionId: "alice-runtime",
        allowedConversationIds: [ids.alice, ids.bob],
        tokenCap: 1000,
      });
      const tool = createLcmExpandTool({
        deps, lcm, sessionKey: childKey, sessionId: childKey,
        disclosure: capability(new Set([ALICE])),
      });
      const forbidden = textOf(await tool.execute("c", { summaryIds: ["sum_bob"], conversationId: ids.alice }));
      const missing = textOf(await tool.execute("c", { summaryIds: ["sum_nope"], conversationId: ids.alice }));
      expect(forbidden).toBe(missing);
      expect(forbidden).not.toContain("BOB");
    });
  });

  describe("lcm_expand_query", () => {
    it("treats forbidden and missing explicit summaries identically and withholds on revoked scope", async () => {
      const tool = createLcmExpandQueryTool({
        deps, lcm, sessionKey: ALICE, sessionId: "alice-runtime", requesterSessionKey: ALICE,
        disclosure: capability(new Set([ALICE])),
      });
      const forbidden = textOf(await tool.execute("c", {
        summaryIds: ["sum_bob"], prompt: "what", allConversations: true,
      }));
      const missing = textOf(await tool.execute("c", {
        summaryIds: ["sum_nope"], prompt: "what", allConversations: true,
      }));
      expect(forbidden.replace("sum_bob", "X")).toBe(missing.replace("sum_nope", "X"));
      expect(forbidden).not.toContain("BOB");

      const foreignConversation = textOf(await tool.execute("c", {
        query: "marker", prompt: "what", conversationId: ids.bob,
      }));
      expect(foreignConversation).not.toContain("BOB");
    });
  });
});
