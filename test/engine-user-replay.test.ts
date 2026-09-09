import { afterEach, expect, it } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import { restoreRawUserReplay } from "../src/user-replay.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import { cleanupEngineTestState, createEngineWithDepsOverrides } from "./helpers.js";

afterEach(cleanupEngineTestState);

it("keeps retained user replay identity and carriers across user turns, not summaries", async () => {
  const sessionId = "cache-replay";
  const sessionKey = "agent:main:cache-replay";
  const users = Array.from({ length: 3 }, (_, index) => attachTranscriptEntryMeta({
    role: "user", content: "repeat this request", timestamp: 1_800_000_000_000 + index,
    idempotencyKey: `turn-${index}`,
  } as AgentMessage, { entryId: `entry-${index}`, parentId: null, timestamp: null }));
  const carriers = users.map((_, index) => ({
    role: "custom", customType: "openclaw.runtime-context", display: false,
    content: `runtime context ${index}`,
    details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
    timestamp: 1_800_000_000_000 + index,
  } as AgentMessage));
  const entries = users.map((message, index) => ({
    entryId: `entry-${index}`, parentId: null, seq: index, role: message.role, message,
  }));
  let readFailed = false;
  const engine = createEngineWithDepsOverrides({
    readVisibleSessionTranscriptMessageEntries: async () => {
      if (readFailed) throw new Error("transcript temporarily unavailable");
      return entries;
    },
  });
  const live: AgentMessage[] = [];
  let previous: AgentMessage[] = [];
  for (let index = 0; index < users.length; index++) {
    await engine.ingest({ sessionId, sessionKey, message: users[index]! });
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
    await engine.ingest({ sessionId, sessionKey, message: assistant });
    live.push(carriers[index]!, assistant);
  }
  const full = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget: 100_000, availableTools: new Set(), prompt: "next" });
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
  readFailed = true;
  const unavailable = await engine.assemble({ sessionId, sessionKey, messages: live, tokenBudget: 100_000, availableTools: new Set(), prompt: "next" });
  expect(JSON.stringify(unavailable.messages[0])).toContain("Earlier history");
});

it("does not infer identity from content or replace externalized media", () => {
  const source = { role: "user", content: "same text", timestamp: 123, idempotencyKey: "key" } as AgentMessage;
  const raw = { role: "user", content: "same text" } as AgentMessage;
  const anchored = attachTranscriptEntryMeta({ ...raw }, { entryId: "entry", parentId: null, timestamp: null });
  const entries = [{ entryId: "entry", parentId: null, seq: 1, role: source.role, message: source }];
  for (const [assembled, live, canonical] of [
    [[raw], [source], entries], // Unanchored or synthetic user, even with identical text.
    [[anchored], [source, { ...source }], entries], // Ambiguous replay key.
    [[anchored], [source], []], // Missing or different transcript branch.
    [[{ ...anchored, content: "[externalized image]" }], [source], entries],
  ] as const) {
    expect(restoreRawUserReplay([...assembled], [...live], [...canonical]).messages).toEqual(assembled);
  }
  const imageSource = { ...source, content: [{ type: "text", text: "same text" }, { type: "image", data: "AA==", mimeType: "image/png" }] } as AgentMessage;
  const imageRaw = { ...anchored, content: imageSource.content } as AgentMessage;
  const replay = restoreRawUserReplay([imageRaw], [imageSource], [{ ...entries[0]!, message: imageSource }]);
  expect(replay.messages[0]).toMatchObject({ timestamp: 123, idempotencyKey: "key", content: imageSource.content });
});
