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
