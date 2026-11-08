import { describe, it, expect } from "vitest";
import { LcmContextEngine } from "../src/engine.js";
import { NativeDatabase } from "../src/storage/turbopuffer-native/database.js";
import { MemoryIo } from "./helpers/turbopuffer-native-io.js";
import { createTestConfig, createTestDeps } from "./helpers.js";
import { FakeTranscriptHost } from "./transcript-delta-fake-host.js";
async function setup() {
  const io = new MemoryIo(),
    database = await NativeDatabase.open({
      organizationId: "org",
      agentId: "main",
      namespacePrefix: "native-engine-test",
      io,
    }),
    host = new FakeTranscriptHost("native-session");
  const deps = createTestDeps(
    createTestConfig("/must-not-open/lcm.db", {
      freshTailCount: 2,
      leafChunkTokens: 600,
      leafMinFanout: 2,
      leafTargetTokens: 40,
    }),
    {
      readSessionTranscriptVisibleMessageDelta: host.readVisibleDelta,
      readSessionTranscriptRawDelta: host.readRawDelta,
      readVisibleSessionTranscriptMessageEntries: host.readVisibleEntries,
    }
  );
  const engine = new LcmContextEngine(deps, database),
    sessionKey = "agent:main:native",
    target = { agentId: "main", sessionId: host.sessionId, sessionKey };
  return { io, database, host, engine, deps, sessionKey, target };
}
describe("native LCM engine lifecycle", () => {
  it("bootstraps, commits transcript turns atomically, deduplicates after restart and assembles", async () => {
    const { database, host, engine, deps, sessionKey, target } = await setup();
    expect(Reflect.get(engine, "db")).toBeNull();
    expect(engine.info.ownsCompaction).toBe(true);
    const user = host.append({
        role: "user",
        content: "quartz native question",
      }),
      answer = host.append({
        role: "assistant",
        content: [{ type: "text", text: "native answer" }],
      });
    const anchor = (entryId: string) => ({
      agentId: "main",
      sessionId: host.sessionId,
      sessionKey,
      storePath: "/host-owned/native-transcript",
      generation: host.generation,
      entryId,
      rawSeq: host.positionOf(entryId),
      effectiveParentId: null,
      activeMessagePosition: host.positionOf(entryId),
    });
    const params = {
      advancementKey: "turn-one",
      admission: {
        ...anchor(user),
        logicalTurnId: "turn-one",
        role: "user" as const,
      },
      terminal: anchor(answer),
      messages: host.visibleMessages().map((row) => row.message),
      sessionId: host.sessionId,
      sessionKey,
      sessionTarget: target,
    };
    await engine.bootstrap({
      sessionId: host.sessionId,
      sessionKey,
      sessionTarget: target,
    });
    expect(await engine.commitTurn(params)).toEqual({ status: "committed" });
    expect(await engine.commitTurn(params)).toEqual({ status: "duplicate" });
    const fresh = new LcmContextEngine(deps, database);
    expect(await fresh.commitTurn(params)).toEqual({ status: "duplicate" });
    const result = await fresh.assemble({
      sessionId: host.sessionId,
      sessionKey,
      messages: [],
      tokenBudget: 4000,
    });
    expect(JSON.stringify(result.messages)).toContain("native answer");
    expect(
      await fresh.control({
        operation: "status",
        sessionId: host.sessionId,
        sessionKey,
      })
    ).toMatchObject({ messageCount: 2, active: true });
    await expect(
      fresh.control({ operation: "status", agentId: "foreign" })
    ).rejects.toThrow("another native agent");
  });
  it("compacts real native context through the unchanged compaction algorithm and expands the DAG", async () => {
    const { engine } = await setup(),
      c = engine.getConversationStore(),
      s = engine.getSummaryStore(),
      conversation = await c.createConversation({
        sessionId: "compact",
        sessionKey: "agent:main:compact",
      }),
      cid = conversation.conversationId;
    await c.withTransaction(async () => {
      const messages = await c.createMessagesBulk(
        Array.from({ length: 16 }, (_, i) => ({
          conversationId: cid,
          seq: i + 1,
          role: i % 2 ? ("assistant" as const) : ("user" as const),
          content: `message ${i} ` + "synthetic quartz ".repeat(20),
          tokenCount: 100,
        }))
      );
      await s.appendContextMessages(
        cid,
        messages.map((row) => row.messageId)
      );
    });
    const compacted = await engine.getCompactionEngine().compactLeaf({
      conversationId: cid,
      tokenBudget: 600,
      force: true,
      summarize: async () => "Deterministic synthetic summary quartz",
      allowCondensedPasses: false,
    });
    expect(compacted.actionTaken).toBe(true);
    expect(await c.getMessageCount(cid)).toBe(16);
    const summaries = await s.getSummariesByConversation(cid);
    expect(summaries.length).toBeGreaterThan(0);
    expect(
      (await s.getSummaryMessages(summaries[0].summaryId)).length
    ).toBeGreaterThan(0);
    const described = await engine
      .getRetrieval()
      .describe(summaries[0].summaryId);
    expect(described?.type).toBe("summary");
  });
  it("persists scoped delegated authorization and atomically clamps token consumption", async () => {
    const { engine, database, deps } = await setup(),
      conversation = await engine.getConversationStore().createConversation({
        sessionId: "grant",
        sessionKey: "agent:main:grant",
      });
    const grant = await engine.createExpansionGrant({
      delegatedSessionKey: "agent:main:subagent:child",
      issuerSessionId: "agent:main:grant",
      allowedConversationIds: [conversation.conversationId],
      tokenCap: 10,
    });
    const fresh = new LcmContextEngine(deps, database),
      auth = fresh.getExpansionAuthorization();
    expect(await fresh.resolveExpansionGrant("agent:main:subagent:child")).toBe(
      grant.grantId
    );
    await Promise.all([
      auth.consumeTokenBudget(grant.grantId, 7),
      auth.consumeTokenBudget(grant.grantId, 7),
    ]);
    expect(await auth.getRemainingTokenBudget(grant.grantId)).toBe(0);
    expect(
      await auth.validateExpansion(grant.grantId, {
        conversationId: 99,
        summaryIds: [],
        depth: 1,
        tokenCap: 1,
      })
    ).toMatchObject({ valid: false });
    await fresh.revokeExpansionGrant("agent:main:subagent:child", {
      removeBinding: true,
    });
    expect(
      await fresh.resolveExpansionGrant("agent:main:subagent:child")
    ).toBeNull();
  });
});

describe("native competing compaction source validation", () => {
  it("rejects a second stale compaction even when both inference calls used the admitted writer", async () => {
    const { engine } = await setup(),
      c = engine.getConversationStore(),
      s = engine.getSummaryStore(),
      conversation = await c.createConversation({
        sessionId: "race",
        sessionKey: "agent:main:race",
      }),
      cid = conversation.conversationId;
    await c.withTransaction(async () => {
      const messages = await c.createMessagesBulk(
        Array.from({ length: 24 }, (_, i) => ({
          conversationId: cid,
          seq: i + 1,
          role: i % 2 ? ("assistant" as const) : ("user" as const),
          content: `race ${i} ` + "quartz ".repeat(60),
          tokenCount: 100,
        }))
      );
      await s.appendContextMessages(
        cid,
        messages.map((row) => row.messageId)
      );
    });
    let firstReady!: () => void,
      secondReady!: () => void,
      firstRelease!: () => void,
      secondRelease!: () => void;
    const ready1 = new Promise<void>((r) => {
        firstReady = r;
      }),
      ready2 = new Promise<void>((r) => {
        secondReady = r;
      }),
      gate1 = new Promise<void>((r) => {
        firstRelease = r;
      }),
      gate2 = new Promise<void>((r) => {
        secondRelease = r;
      });
    const first = engine.getCompactionEngine().compactLeaf({
      conversationId: cid,
      tokenBudget: 600,
      force: true,
      allowCondensedPasses: false,
      summarize: async () => {
        firstReady();
        await gate1;
        return "First committed summary";
      },
    });
    const second = engine.getCompactionEngine().compactLeaf({
      conversationId: cid,
      tokenBudget: 600,
      force: true,
      allowCondensedPasses: false,
      summarize: async () => {
        secondReady();
        await gate2;
        return "Stale summary";
      },
    });
    await Promise.all([ready1, ready2]);
    firstRelease();
    await first;
    secondRelease();
    await expect(second).rejects.toThrow("source projection changed");
    expect(await c.getMessageCount(cid)).toBe(24);
    expect(
      (await s.getSummariesByConversation(cid)).some(
        (row) => row.content === "Stale summary"
      )
    ).toBe(false);
  });
});

it("runs the upstream pending coordinator and publisher on native repositories", async () => {
  const { PendingCompactionCoordinator } = await import(
    "../src/pending-summary-coordinator.js"
  );
  const { engine } = await setup(),
    c = engine.getConversationStore(),
    s = engine.getSummaryStore(),
    p = engine.getPendingSummaryStore(),
    conversation = await c.createConversation({
      sessionId: "pending-native",
      sessionKey: "agent:main:pending-native",
    }),
    cid = conversation.conversationId;
  await c.withTransaction(async () => {
    const messages = await c.createMessagesBulk(
      Array.from({ length: 24 }, (_, i) => ({
        conversationId: cid,
        seq: i + 1,
        role: i % 2 ? ("assistant" as const) : ("user" as const),
        content: `pending ${i} ` + "quartz ".repeat(60),
        tokenCount: 100,
      }))
    );
    await s.appendContextMessages(
      cid,
      messages.map((row) => row.messageId)
    );
  });
  const coordinator = new PendingCompactionCoordinator({
    conversationStore: c,
    summaryStore: s,
    pendingSummaryStore: p,
    model: "fake",
    leaseOwner: "native",
    config: {
      freshTailCount: 2,
      leafChunkTokens: 600,
      condensedMinFanout: 2,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 1200,
    },
    summarize: async () => "Deterministic native pending summary.",
  });
  let published = false;
  for (let step = 0; step < 12; step++) {
    const result = await coordinator.runOnce({ conversationId: cid });
    if (result.status === "published") {
      published = true;
      break;
    }
    expect(result.status).not.toBe("failed");
  }
  expect(published).toBe(true);
  expect(await c.getMessageCount(cid)).toBe(24);
  expect(
    (await s.getContextItems(cid)).some((row) => row.summaryId !== null)
  ).toBe(true);
});
