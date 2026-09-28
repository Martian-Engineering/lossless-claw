import { afterEach, expect, it } from "vitest";
import { cleanupEngineTestState, createEngineWithDepsOverridesAndDb } from "./helpers.js";
import { buildDegradedLiveAssembleResult, buildForkBoundedLiveFallback, clampMessagesToSerializedBudget } from "../src/assemble-fallback.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

afterEach(cleanupEngineTestState);

// A large initiating user followed by a complete small tool exchange and new turn.
const history: AgentMessage[] = [
  { role: "user", content: "original user ".repeat(2000) },
  { role: "assistant", content: [{ type: "toolCall", id: "call-1193", name: "exec", arguments: { command: "pwd" } }] },
  { role: "toolResult", toolCallId: "call-1193", toolName: "exec", content: [{ type: "text", text: "/tmp" }] },
  { role: "user", content: "next question" },
];

it("omits an incomplete bootstrap tool turn from assembly without changing stored history", async () => {
  const original = structuredClone(history);
  const sessionId = "diagnostic-1193";
  const sessionKey = "agent:main:diagnostic-1193";
  const entries = history.map((message, index) => ({
    entryId: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
    seq: index + 1, role: message.role, message: structuredClone(message), createdAt: "2026-09-24T12:00:00Z",
  }));
  const { engine } = createEngineWithDepsOverridesAndDb({
    readVisibleSessionTranscriptMessageEntries: async () => entries,
  }, { bootstrapMaxTokens: 500 });
  await engine.ingest({ sessionId, sessionKey, message: { role: "user", content: "persisted sentinel" } });
  const oldConversation = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
  await engine.handleBeforeReset({ sessionId, sessionKey, reason: "reset" });
  const bootstrap = await engine.bootstrap({ sessionId, sessionKey, runtimeContext: {
    transcriptStorage: { kind: "sqlite" },
    sessionTarget: { agentId: "main", sessionId, sessionKey, storePath: "/tmp/diagnostic-host.sqlite", threadId: "thread-1193" },
  } });
  const active = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
  const stored = await engine.getConversationStore().getMessages(active!.conversationId);
  const result = await engine.assemble({ sessionId, sessionKey, messages: history.slice(1), tokenBudget: 10000 });
  const archived = await engine.getConversationStore().getMessages(oldConversation!.conversationId);
  expect(archived[0].content).toBe("persisted sentinel");
  expect(history).toEqual(original);
  expect(bootstrap).toMatchObject({ bootstrapped: true, importedMessages: 3 });
  expect(stored.map(message => message.role)).toEqual(["assistant", "tool", "user"]);
  expect(await engine.getConversationStore().getMessages(active!.conversationId)).toEqual(stored);
  expect(result.messages.find(m => m.role !== "system" && m.role !== "developer")?.role).toBe("user");
});

it("restores the initiating user when clamping retains a tool exchange before a later user", () => {
  const original = structuredClone(history);
  const budget = Math.ceil(estimateSerializedMessagesTokens(history.slice(1)) / 0.9) + 10;
  const result = clampMessagesToSerializedBudget({ messages: history, tokenBudget: budget, preserveSubstantiveAssistantTail: true });
  expect(history).toEqual(original);
  expect(result.clamped).toBe(true);
  expect(result.messages[0].role).toBe("user");
  expect(result.messages).toEqual(history);
  expect(result.overBudget).toBe(true);
});

it.each(["tool", "toolResult"] as const)("preserves framing and complete multi-call turns when clamping %s", (role) => {
  const messages: AgentMessage[] = [
    { role: "system", content: "system framing" },
    { role: "developer", content: "developer framing" },
    history[0],
    { role: "assistant", content: [
      { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
      { type: "toolCall", id: "b", name: "read", arguments: { path: "b" } },
    ] },
    { role, toolCallId: "a", toolName: "read", content: [{ type: "text", text: "a" }] },
    { role, toolCallId: "b", toolName: "read", content: [{ type: "text", text: "b" }] },
    history[3],
  ] as AgentMessage[];
  const before = structuredClone(messages);
  const tokenBudget = Math.ceil(estimateSerializedMessagesTokens(messages.slice(5)) / 0.9);
  const result = clampMessagesToSerializedBudget({ messages, tokenBudget });
  expect(result.messages.map(message => message.role)).toEqual([
    "system", "developer", "user", "assistant", "toolResult", "toolResult", "user",
  ]);
  expect(result.messages[2]).toBe(messages[2]);
  expect(result.messages[3]).toBe(messages[3]);
  expect(messages).toEqual(before);
});

it.each([false, true])("omits only the incomplete historical prefix in degraded output (preserve tail: %s)", (preserveSubstantiveAssistantTail) => {
  const framing = { role: "system", content: "system framing" } as AgentMessage;
  const liveMessages = [framing, ...history.slice(1), { role: "assistant", content: "completed reply" }] as AgentMessage[];
  const result = buildDegradedLiveAssembleResult({
    liveMessages, tokenBudget: 10000, preserveSubstantiveAssistantTail,
    contextProjection: { mode: "thread_bootstrap" },
  });
  expect(result.messages).toEqual([
    framing, history[3], ...(preserveSubstantiveAssistantTail ? liveMessages.slice(-1) : []),
  ]);
});

it("preserves an unclassified userless live continuation", () => {
  const messages = history.slice(1, 3);
  const result = clampMessagesToSerializedBudget({ messages, tokenBudget: 10000 });
  expect(result.messages).toBe(messages);
  expect(result.clamped).toBe(false);
});

it("omits displaced results of a discarded historical call without breaking a newer tool turn", () => {
  const messages = [history[1], history[3], history[2], history[1], history[2]];
  const original = structuredClone(messages);
  const result = clampMessagesToSerializedBudget({ messages, tokenBudget: 10000 });
  expect(result.messages).toEqual([history[3], history[1], history[2]]);
  expect(messages).toEqual(original);
});

it("repairs the outgoing fork-bounded fallback without changing its source", () => {
  const liveMessages = history.slice(1);
  const result = buildForkBoundedLiveFallback({
    liveMessages, forkSourceMessageCount: 0, tokenBudget: 10000, bootstrapMaxTokens: 10000,
  });
  expect(result.messages).toEqual([history[3]]);
  expect(liveMessages).toEqual(history.slice(1));
});

it("preserves a plain assistant greeting before the first user", () => {
  const messages = [{ role: "assistant", content: "Welcome" }, history[3]] as AgentMessage[];
  expect(clampMessagesToSerializedBudget({ messages, tokenBudget: 10000 }).messages).toBe(messages);
});

it("preserves the admitted tool turn when the host submits the next prompt separately", async () => {
  const { engine } = createEngineWithDepsOverridesAndDb({});
  const sessionId = "separate-prompt-tool-turn";
  const messages = history.slice(0, 3);
  for (const message of messages) {
    await engine.ingest({ sessionId, message });
  }
  // The host adopts this prior history before appending the next user prompt.
  const result = await engine.assemble({
    sessionId, messages, tokenBudget: 100000, availableTools: new Set(["exec"]), prompt: "next question",
  });
  expect(result.messages.map(message => message.role)).toEqual(["user", "assistant", "toolResult"]);
  expect(result.messages[1].content).toEqual(messages[1].content);
  expect(result.messages[2]).toMatchObject({ toolCallId: "call-1193" });
});

it("preserves a pending admitted call for prompt-separate host pairing repair", async () => {
  const { engine } = createEngineWithDepsOverridesAndDb({});
  const sessionId = "separate-prompt-pending-call";
  const messages = history.slice(0, 2);
  for (const message of messages) {
    await engine.ingest({ sessionId, message });
  }
  const result = await engine.assemble({
    sessionId, messages, tokenBudget: 1, availableTools: new Set(["exec"]), prompt: "next question",
  });
  expect(result.messages.map(message => message.role)).toEqual(["user", "assistant"]);
  expect(result.messages[1].content).toEqual(messages[1].content);
});
