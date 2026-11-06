import { afterEach, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import { observeUserReplayIdentity, restoreRawUserReplay } from "../src/user-replay.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import type { VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import {
  cleanupEngineTestState,
  createEngineWithDepsOverrides,
  createEngineWithDepsOverridesAndDb,
  seedStoredMessage,
} from "./helpers.js";
import { FakeTranscriptHost } from "./transcript-delta-fake-host.js";

afterEach(cleanupEngineTestState);

/** Replay identities keyed by entry id, as ingestion would observe them. */
function identitiesOf(entries: Array<{ entryId: string; message: AgentMessage }>) {
  return new Map(entries.map(entry => [entry.entryId, observeUserReplayIdentity(entry.message)]));
}

function runtimeCarrier(index: number): AgentMessage {
  return {
    role: "custom", customType: "openclaw.runtime-context", display: false,
    content: `runtime context ${index}`,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    timestamp: 1_800_000_000_000 + index,
  } as AgentMessage;
}

it("keeps retained user replay identity and carriers across user turns, not summaries", async () => {
  const sessionId = "cache-replay";
  const sessionKey = "agent:main:cache-replay";
  const users = Array.from({ length: 3 }, (_, index) => attachTranscriptEntryMeta({
    role: "user", content: "repeat this request", timestamp: 1_800_000_000_000 + index,
    idempotencyKey: `turn-${index}`,
  } as AgentMessage, { entryId: `entry-${index}`, parentId: null, timestamp: null }));
  const carriers = users.map((_, index) => runtimeCarrier(index));
  const entries = users.map((message, index) => ({
    entryId: `entry-${index}`, parentId: null, seq: index, role: message.role, message,
  }));
  let readFailed = false;
  const readVisibleSessionTranscriptMessageEntries = vi.fn(async () => {
    if (readFailed) throw new Error("transcript temporarily unavailable");
    return entries;
  });
  const engine = createEngineWithDepsOverrides({ readVisibleSessionTranscriptMessageEntries });
  const live: AgentMessage[] = [];
  let previous: AgentMessage[] = [];
  for (let index = 0; index < users.length; index++) {
    await seedStoredMessage(engine, { sessionId, sessionKey, message: users[index]! });
    live.push(users[index]!);
    if (index === 0) {
      const conversation = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
      await engine.getSummaryStore().insertSummary({
        summaryId: "old", conversationId: conversation!.conversationId,
        kind: "leaf", depth: 0, content: "Earlier history", tokenCount: 4,
      });
      await engine.getSummaryStore().replaceContextRangeWithSummary({
        conversationId: conversation!.conversationId, startOrdinal: 0, endOrdinal: 0, summaryId: "old",
      });
      live.push(carriers[index]!);
      continue;
    }
    const result = await engine.assemble({
      sessionId, sessionKey, messages: live, tokenBudget: 100_000,
      availableTools: new Set(), prompt: "repeat this request",
    });
    const replayUsers = result.messages.filter(message => Reflect.get(message, "idempotencyKey"));
    expect(replayUsers.map(message => Reflect.get(message, "idempotencyKey"))).toEqual(
      users.slice(1, index + 1).map(message => Reflect.get(message, "idempotencyKey")),
    );
    expect(replayUsers.map(message => message.timestamp)).toEqual(users.slice(1, index + 1).map(message => message.timestamp));
    expect(result.messages.filter(message => message.role === "custom")).toEqual(carriers.slice(1, index));
    expect(result.messages.slice(0, previous.length)).toEqual(previous);
    previous = result.messages;
    const assistant = { role: "assistant", content: `reply ${index}` } as AgentMessage;
    await seedStoredMessage(engine, { sessionId, sessionKey, message: assistant });
    live.push(carriers[index]!, assistant);
  }
  // Rows seeded without transcript ingestion were each observed by one full read.
  expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledTimes(users.length - 1);
  const info = Reflect.get(engine, "deps").log.info as ReturnType<typeof vi.fn>;
  const fullReadLogs = info.mock.calls.map(([line]) => String(line)).filter(line => line.includes("read full visible transcript"));
  expect(fullReadLogs).toHaveLength(users.length - 1);
  expect(fullReadLogs[0]).toMatch(/replay keys unobserved for 1 raw user item\(s\) conversation=\d+ .* entries=3 duration=/);
  const full = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget: 100_000, availableTools: new Set(), prompt: "next" });
  expect(readVisibleSessionTranscriptMessageEntries).toHaveBeenCalledTimes(users.length - 1);
  // Fit the suffix beginning at the first carrier, but not its parent user.
  const suffix = full.messages.slice(full.messages.findIndex(message => message.role === "custom"));
  const tokenBudget = Math.ceil(estimateSerializedMessagesTokens(suffix) / 0.9);
  const bounded = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget, availableTools: new Set(), prompt: "next" });
  expect(bounded.messages).not.toContain(carriers[1]);
  expect(bounded.messages).toContain(carriers[2]);
  expect(bounded.estimatedTokens).toBe(estimateSerializedMessagesTokens(bounded.messages));
  for (const [index, message] of bounded.messages.entries()) {
    if (message.role === "custom") {
      expect(Reflect.get(bounded.messages[index - 1]!, "idempotencyKey")).toBe(
        `turn-${carriers.indexOf(message)}`,
      );
    }
  }
  // An unobserved row whose transcript read fails keeps the stored rendering.
  readFailed = true;
  const late = attachTranscriptEntryMeta({
    role: "user", content: "late request", timestamp: 1_800_000_000_100, idempotencyKey: "turn-late",
  } as AgentMessage, { entryId: "entry-late", parentId: null, timestamp: null });
  await seedStoredMessage(engine, { sessionId, sessionKey, message: late });
  const unavailable = await engine.assemble({ sessionId, sessionKey, messages: [...live, late], tokenBudget: 100_000, availableTools: new Set(), prompt: "next" });
  expect(JSON.stringify(unavailable.messages[0])).toContain("Earlier history");
  expect(unavailable.messages.at(-1)).not.toHaveProperty("idempotencyKey");
  expect(unavailable.messages.filter(message => Reflect.get(message, "idempotencyKey")).map(message => Reflect.get(message, "idempotencyKey")))
    .toEqual(["turn-1", "turn-2"]);
});

it("serves replay identity from cursor ingestion and refreshes it on resync without full reads", async () => {
  const sessionId = "cursor-replay";
  const sessionKey = "agent:main:cursor-replay";
  const sessionTarget = { agentId: "main", sessionId, sessionKey };
  const host = new FakeTranscriptHost(sessionId);
  const readVisibleSessionTranscriptMessageEntries = vi.fn(host.readVisibleEntries);
  const { engine } = createEngineWithDepsOverridesAndDb({
    readSessionTranscriptVisibleMessageDelta: host.readVisibleDelta,
    readSessionTranscriptRawDelta: host.readRawDelta,
    readVisibleSessionTranscriptMessageEntries,
  });
  const userTurn = (index: number, key = `turn-${index}`) => ({
    role: "user", content: `request ${index}`, timestamp: 1_800_000_000_000 + index, idempotencyKey: key,
  } as AgentMessage);
  const live: AgentMessage[] = [];
  const userIds: string[] = [];
  for (let index = 0; index < 3; index++) {
    const message = userTurn(index);
    userIds.push(host.append(message));
    const reply = { role: "assistant", content: [{ type: "text", text: `reply ${index}` }] } as unknown as AgentMessage;
    host.append(reply);
    live.push(message, runtimeCarrier(index), reply);
  }
  await engine.bootstrap({ sessionId, sessionKey, sessionTarget });
  const assemble = () => engine.assemble({
    sessionId, sessionKey, sessionTarget, messages: live, tokenBudget: 100_000, availableTools: new Set(), prompt: "next",
  } as Parameters<typeof engine.assemble>[0]);
  const replayKeys = (messages: AgentMessage[]) =>
    messages.filter(message => Reflect.get(message, "idempotencyKey")).map(message => Reflect.get(message, "idempotencyKey"));

  const first = await assemble();
  expect(replayKeys(first.messages)).toEqual(["turn-0", "turn-1", "turn-2"]);
  expect(first.messages.filter(message => message.role === "custom")).toHaveLength(3);
  expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();

  // An in-place rewrite keeps the entry id but changes the persisted key; resync re-observes it.
  const rewritten = userTurn(1, "turn-1-retry");
  host.rewriteInPlace(userIds[1]!, rewritten);
  live[3] = rewritten;
  await engine.bootstrap({ sessionId, sessionKey, sessionTarget });
  expect(replayKeys((await assemble()).messages)).toEqual(["turn-0", "turn-1-retry", "turn-2"]);
  expect(readVisibleSessionTranscriptMessageEntries).not.toHaveBeenCalled();
});

it("does not infer identity from content or replace externalized media", () => {
  const source = { role: "user", content: "same text", timestamp: 123, idempotencyKey: "key" } as AgentMessage;
  const raw = { role: "user", content: "same text" } as AgentMessage;
  const anchored = attachTranscriptEntryMeta({ ...raw }, { entryId: "entry", parentId: null, timestamp: null });
  const identities = identitiesOf([{ entryId: "entry", message: source }]);
  for (const [assembled, live, canonical] of [
    [[raw], [source], identities], // Unanchored or synthetic user, even with identical text.
    [[anchored], [source, { ...source }], identities], // Ambiguous replay key.
    [[anchored], [source], new Map()], // Missing or different transcript branch.
    [[{ ...anchored, content: "[externalized image]" }], [source], identities],
    // The persisted entry differs from both the stored row and the live copy.
    [[anchored], [source], identitiesOf([{ entryId: "entry", message: { ...source, content: "redacted" } as AgentMessage }])],
  ] as const) {
    expect(restoreRawUserReplay([...assembled], [...live], canonical).messages).toEqual(assembled);
  }
  const imageSource = { ...source, content: [{ type: "text", text: "same text" }, { type: "image", data: "AA==", mimeType: "image/png" }] } as AgentMessage;
  const imageRaw = { ...anchored, content: imageSource.content } as AgentMessage;
  const replay = restoreRawUserReplay([imageRaw], [imageSource], identitiesOf([{ entryId: "entry", message: imageSource }]));
  expect(replay.messages[0]).toMatchObject({ timestamp: 123, idempotencyKey: "key", content: imageSource.content });
});

it("observes no replay identity for keyless entries", () => {
  const entry: Pick<VisibleSessionTranscriptMessageEntry, "message"> = { message: { role: "user", content: "x" } as AgentMessage };
  expect(observeUserReplayIdentity(entry.message)).toEqual({ idempotencyKey: "", signature: "" });
});

it("replays canonical users and carriers after the host hydration window advances", async () => {
  const sessionId = "bounded-host-replay";
  const sessionKey = "agent:main:bounded-host-replay";
  const users = Array.from({ length: 4 }, (_, index) => attachTranscriptEntryMeta({
    role: "user", content: `request ${index}`, timestamp: 1_800_000_000_123 + index,
    idempotencyKey: `turn-${index}`,
    provenance: { kind: "inter_session", sourceSessionKey: "agent:main:child", sourceTool: "subagent_settle" },
    __openclaw: { modelPromptProjection: { version: 1, text: `recorded request ${index}` } },
  } as AgentMessage, { entryId: `bounded-${index}`, parentId: null, timestamp: null }));
  const carriers = users.map((_, index) => runtimeCarrier(index));
  const readSessionTranscriptReplayGroups = vi.fn(async ({ entryIds }: { entryIds: string[] }) =>
    users.flatMap((message, index) => entryIds.includes(`bounded-${index}`)
      ? [{ entryId: `bounded-${index}`, message, carriers: [carriers[index]!] }] : []));
  const engine = createEngineWithDepsOverrides({ readSessionTranscriptReplayGroups });
  for (const message of users.slice(0, 3)) await seedStoredMessage(engine, { sessionId, sessionKey, message });
  const conversation = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
  await engine.getSummaryStore().insertSummary({
    summaryId: "bounded-summary", conversationId: conversation!.conversationId,
    kind: "leaf", depth: 0, content: "Earlier history", tokenCount: 4,
  });
  await engine.getSummaryStore().replaceContextRangeWithSummary({
    conversationId: conversation!.conversationId, startOrdinal: 0, endOrdinal: 0, summaryId: "bounded-summary",
  });
  const assemble = (messages: AgentMessage[]) => engine.assemble({
    sessionId, sessionKey, messages, tokenBudget: 100_000, availableTools: new Set(), prompt: "next",
  });
  const before = await assemble([users[1]!, carriers[1]!, users[2]!, carriers[2]!]);
  await seedStoredMessage(engine, { sessionId, sessionKey, message: users[3]! });
  const after = await assemble([users[3]!, carriers[3]!]);
  expect(after.messages.slice(0, before.messages.length)).toEqual(before.messages);
  expect(after.messages.filter(message => message.role === "custom")).toEqual(carriers.slice(1));
  expect(after.messages.find(message => Reflect.get(message, "idempotencyKey") === "turn-1"))
    .toMatchObject({ timestamp: users[1]!.timestamp, provenance: Reflect.get(users[1]!, "provenance"),
      __openclaw: Reflect.get(users[1]!, "__openclaw") });
  expect(readSessionTranscriptReplayGroups.mock.calls.at(-1)?.[0].entryIds)
    .toEqual(["bounded-1", "bounded-2", "bounded-3"]);
});

it("does not restore canonical carriers onto changed or unanchored content", () => {
  const source = { role: "user", content: "original", timestamp: 123 } as AgentMessage;
  const anchored = attachTranscriptEntryMeta({ ...source }, { entryId: "entry", parentId: null, timestamp: null });
  const carrier = runtimeCarrier(0);
  const sources = new Map([["entry", { message: source, carriers: [carrier] }]]);
  for (const message of [source, { ...anchored, content: "externalized" } as AgentMessage]) {
    expect(restoreRawUserReplay([message], [], new Map(), sources).messages).toEqual([message]);
  }
  const replay = restoreRawUserReplay([anchored], [], new Map(), sources);
  expect(replay.messages).toEqual([anchored, carrier]);
  expect(replay.carrierParents.get(carrier)).toBe(replay.messages[0]);
});

it("logs canonical-reader rejection and returns the intentional bounded live fallback", async () => {
  const sessionId = "canonical-reader-rejection";
  const sessionKey = `agent:main:${sessionId}`;
  const failure = new RangeError("Session transcript replay exceeds maxBytes (8388608)");
  const readSessionTranscriptReplayGroups = vi.fn(async () => { throw failure; });
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const engine = createEngineWithDepsOverrides({ readSessionTranscriptReplayGroups, log });
  const stored = attachTranscriptEntryMeta({ role: "user", content: "retained canonical history" } as AgentMessage,
    { entryId: "retained-entry", parentId: null, timestamp: null });
  await seedStoredMessage(engine, { sessionId, sessionKey, message: stored });
  const latest = { role: "user", content: "latest live request" } as AgentMessage;
  const result = await engine.assemble({
    sessionId, sessionKey,
    messages: [{ role: "user", content: "older live context ".repeat(1000) } as AgentMessage, latest],
    tokenBudget: 256, availableTools: new Set(), prompt: "next",
  });
  expect(readSessionTranscriptReplayGroups).toHaveBeenCalledWith(expect.objectContaining({
    entryIds: ["retained-entry"],
  }));
  // This is explicit degraded coverage, not a guarantee that canonical history survived.
  expect(result.messages).toEqual([latest]);
  expect(result.contextProjection).toBeUndefined();
  expect(result.estimatedTokens).toBe(estimateSerializedMessagesTokens([latest]));
  expect(result.estimatedTokens).toBeLessThanOrEqual(256);
  expect(log.debug).toHaveBeenCalledWith(expect.stringContaining(
    "assemble: failed for session=canonical-reader-rejection",
  ));
  expect(log.debug).toHaveBeenCalledWith(expect.stringContaining(failure.message));
  expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("reason=assemble-error"));
});

it("evicts canonical carriers with their parent under a tight serialized budget", async () => {
  const sessionId = "canonical-carrier-budget";
  const sessionKey = `agent:main:${sessionId}`;
  const users = Array.from({ length: 3 }, (_, index) => attachTranscriptEntryMeta({
    role: "user", content: `request ${index}`, timestamp: 1_800_000_000_000 + index,
    idempotencyKey: `budget-turn-${index}`,
  } as AgentMessage, { entryId: `budget-entry-${index}`, parentId: null, timestamp: null }));
  const carriers = users.map((_, index) => runtimeCarrier(index));
  const readSessionTranscriptReplayGroups = vi.fn(async ({ entryIds }: { entryIds: string[] }) =>
    users.flatMap((message, index) => entryIds.includes(`budget-entry-${index}`)
      ? [{ entryId: `budget-entry-${index}`, message, carriers: [carriers[index]!] }] : []));
  const engine = createEngineWithDepsOverrides({ readSessionTranscriptReplayGroups });
  for (const message of users) await seedStoredMessage(engine, { sessionId, sessionKey, message });
  const conversation = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
  await engine.getSummaryStore().insertSummary({
    summaryId: "budget-summary", conversationId: conversation!.conversationId,
    kind: "leaf", depth: 0, content: "Earlier history", tokenCount: 4,
  });
  await engine.getSummaryStore().replaceContextRangeWithSummary({
    conversationId: conversation!.conversationId, startOrdinal: 0, endOrdinal: 0, summaryId: "budget-summary",
  });
  const assemble = (tokenBudget: number) => engine.assemble({
    sessionId, sessionKey, messages: [users[2]!], tokenBudget,
    availableTools: new Set(), prompt: "next",
  });
  const full = await assemble(100_000);
  expect(full.messages.filter(message => message.role === "custom")).toEqual(carriers.slice(1));
  // The suffix fits its first carrier, but not that carrier's parent user.
  const suffix = full.messages.slice(full.messages.indexOf(carriers[1]!));
  const tokenBudget = Math.ceil(estimateSerializedMessagesTokens(suffix) / 0.9);
  const bounded = await assemble(tokenBudget);
  expect(readSessionTranscriptReplayGroups.mock.calls.at(-1)?.[0].entryIds)
    .toEqual(["budget-entry-1", "budget-entry-2"]);
  expect(bounded.messages).not.toContain(carriers[1]);
  expect(bounded.messages.filter(message => message.role === "custom")).toEqual([carriers[2]]);
  const carrierIndex = bounded.messages.indexOf(carriers[2]!);
  expect(bounded.messages[carrierIndex - 1]).toMatchObject({ idempotencyKey: "budget-turn-2" });
  expect(bounded.estimatedTokens).toBe(estimateSerializedMessagesTokens(bounded.messages));
  expect(bounded.estimatedTokens).toBeLessThanOrEqual(tokenBudget);
});
