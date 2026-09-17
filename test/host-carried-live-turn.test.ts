// The loop hook persists the live current turn through afterTurn and then calls
// assemble with the live message array that still carries that turn. Replaying
// the persisted row next to the live copy sends the current turn twice; the
// pre-prompt path (current turn delivered separately) must keep replaying.
import { afterEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  cleanupEngineTestState,
  createEngineWithDepsOverrides,
  createSessionFilePath,
  makeMessage,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

const SENDER_BLOCK = 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"sam.rivera"}}\n```\n\n';
const BODY = "The label maker needs a fresh ribbon before the next batch of tags.";
const TRANSCRIPT_FORM = `${SENDER_BLOCK}${BODY}`;
const LIVE_FORM = `[Thu 2026-09-17 06:03 GMT+3] ${SENDER_BLOCK}<derived-focus>\nRecent runs favour terse confirmations.\n</derived-focus>\n\n${BODY}`;
const LIVE_FORM_WITH_MEMORY = `[Thu 2026-09-17 06:03 GMT+3] ${SENDER_BLOCK}<inherited-rules>\nKeep confirmations to one line.\n</inherited-rules>\n\n<relevant-memories>\n- The bench lamp got a new bulb last week.\n</relevant-memories>\n\n${BODY}`;

function bodyCarriers(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (message) =>
      message.role === "user" && typeof message.content === "string" && message.content.includes(BODY),
  );
}

function history(): AgentMessage[] {
  return [
    makeMessage({ role: "user", content: "Earlier note: the bench lamp got a new bulb.", timestamp: 1_000 }),
    makeMessage({ role: "assistant", content: "Logged the bulb swap.", timestamp: 2_000 }),
  ];
}

type Engine = ReturnType<typeof createEngineWithDepsOverrides>;

async function storedMessageCount(engine: Engine, sessionId: string): Promise<number> {
  const store = engine.getConversationStore();
  const conversation = await store.getConversationBySessionId(sessionId);
  return conversation ? store.getMessageCount(conversation.conversationId) : 0;
}

/**
 * Mirror the 2026.9.x host: the engine reads the visible transcript projection
 * (entries with host entry ids) and afterTurn reconciles it before assemble.
 */
function createProjectionEngine() {
  const visible: AgentMessage[] = [];
  const engine = createEngineWithDepsOverrides({
    readVisibleSessionTranscriptMessageEntries: async () =>
      visible.map((message, index) => ({
        entryId: `entry-${index}`,
        parentId: index === 0 ? null : `entry-${index - 1}`,
        seq: index,
        role: message.role,
        message,
      })),
  });
  return { engine, visible };
}

async function seedOpenTurn(name: string) {
  const { engine, visible } = createProjectionEngine();
  const sessionId = `host-carried-live-turn-${name}`;
  const sessionKey = `agent:agent-one:${name}`;
  const sessionFile = createSessionFilePath(sessionId);
  const prior = history();
  visible.push(...prior);
  await engine.afterTurn({ sessionId, sessionKey, sessionFile, messages: prior, prePromptMessageCount: 0, tokenBudget: 4_000 });
  expect(await storedMessageCount(engine, sessionId)).toBe(prior.length);
  const currentTranscript = makeMessage({ role: "user", content: TRANSCRIPT_FORM, timestamp: 3_000 });
  visible.push(currentTranscript);
  await engine.afterTurn({
    sessionId,
    sessionKey,
    sessionFile,
    messages: [...prior, currentTranscript],
    prePromptMessageCount: prior.length,
    tokenBudget: 4_000,
  });
  expect(await storedMessageCount(engine, sessionId)).toBe(prior.length + 1);
  return { engine, visible, sessionId, sessionKey, sessionFile, prior, currentTranscript };
}

describe("host-carried live turn on the loop-hook path", () => {
  it("replaces the replayed persisted row with the live copy of the current turn", async () => {
    const { engine, sessionId, sessionKey, prior } = await seedOpenTurn("loop");
    const live = makeMessage({ role: "user", content: LIVE_FORM, timestamp: 3_000 });

    const result = await engine.assemble({ sessionId, sessionKey, messages: [...prior, live], tokenBudget: 4_000 });

    const carriers = bodyCarriers(result.messages);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.content).toBe(LIVE_FORM);
  });

  it("keeps suppressing on later loop iterations of the same turn", async () => {
    const { engine, visible, sessionId, sessionKey, sessionFile, prior, currentTranscript } = await seedOpenTurn("iteration");
    const reply = makeMessage({ role: "assistant", content: "Ribbon swap noted.", timestamp: 4_000 });
    visible.push(reply);
    await engine.afterTurn({
      sessionId,
      sessionKey,
      sessionFile,
      messages: [...prior, currentTranscript, reply],
      prePromptMessageCount: prior.length + 1,
      tokenBudget: 4_000,
    });
    const live = makeMessage({ role: "user", content: LIVE_FORM, timestamp: 3_000 });

    const result = await engine.assemble({ sessionId, sessionKey, messages: [...prior, live, reply], tokenBudget: 4_000 });

    const carriers = bodyCarriers(result.messages);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.content).toBe(LIVE_FORM);
  });

  it("leaves the replay alone when the host delivers the current turn separately", async () => {
    const { engine, sessionId, sessionKey, prior, currentTranscript } = await seedOpenTurn("pre-prompt");

    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [...prior, currentTranscript],
      tokenBudget: 4_000,
      availableTools: new Set(),
      prompt: "Next turn: is the ribbon in stock?",
    });

    const carriers = bodyCarriers(result.messages);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.content).toBe(TRANSCRIPT_FORM);
  });

  it("sends the current turn once when the live copy carries injected memory blocks", async () => {
    const { engine, sessionId, sessionKey, prior } = await seedOpenTurn("memory-blocks");
    const live = makeMessage({ role: "user", content: LIVE_FORM_WITH_MEMORY, timestamp: 3_000 });

    const result = await engine.assemble({ sessionId, sessionKey, messages: [...prior, live], tokenBudget: 4_000 });

    const carriers = bodyCarriers(result.messages);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.content).toBe(LIVE_FORM_WITH_MEMORY);
  });

  it("drops a projection-imported current turn on the pre-prompt path and appends nothing", async () => {
    const { engine, visible } = createProjectionEngine();
    const sessionId = "host-carried-live-turn-bootstrap";
    const sessionKey = "agent:agent-one:bootstrap";
    const sessionFile = createSessionFilePath(sessionId);
    const prior = history();
    visible.push(...prior);
    await engine.afterTurn({ sessionId, sessionKey, sessionFile, messages: prior, prePromptMessageCount: 0, tokenBudget: 4_000 });
    expect(await storedMessageCount(engine, sessionId)).toBe(prior.length);
    // The host admits the new turn to its transcript before the pre-prompt
    // bootstrap; the projection now carries it and bootstrap imports it.
    visible.push(makeMessage({ role: "user", content: TRANSCRIPT_FORM, timestamp: 3_000 }));
    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(await storedMessageCount(engine, sessionId)).toBe(prior.length + 1);

    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: prior,
      tokenBudget: 4_000,
      availableTools: new Set(),
      prompt: LIVE_FORM,
    });

    expect(bodyCarriers(result.messages)).toHaveLength(0);
    expect(result.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("keeps a projection-imported history row that the host history also carries", async () => {
    const { engine, visible } = createProjectionEngine();
    const sessionId = "host-carried-live-turn-history";
    const sessionKey = "agent:agent-one:history";
    const sessionFile = createSessionFilePath(sessionId);
    const prior = history();
    const olderTurn = makeMessage({ role: "user", content: TRANSCRIPT_FORM, timestamp: 3_000 });
    const olderReply = makeMessage({ role: "assistant", content: "Ribbon ordered.", timestamp: 4_000 });
    visible.push(...prior, olderTurn, olderReply);
    await engine.bootstrap({ sessionId, sessionKey, sessionFile });
    expect(await storedMessageCount(engine, sessionId)).toBe(4);

    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [...prior, olderTurn, olderReply],
      tokenBudget: 4_000,
      availableTools: new Set(),
      prompt: "Next turn: did the ribbon arrive?",
    });

    const carriers = bodyCarriers(result.messages);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.content).toBe(TRANSCRIPT_FORM);
  });

  it("does nothing without a persisted current turn", async () => {
    const { engine, visible } = createProjectionEngine();
    const sessionId = "host-carried-live-turn-none";
    const sessionKey = "agent:agent-one:none";
    const sessionFile = createSessionFilePath(sessionId);
    const prior = history();
    visible.push(...prior);
    await engine.afterTurn({ sessionId, sessionKey, sessionFile, messages: prior, prePromptMessageCount: 0, tokenBudget: 4_000 });
    expect(await storedMessageCount(engine, sessionId)).toBe(prior.length);
    const live = makeMessage({ role: "user", content: LIVE_FORM, timestamp: 3_000 });

    const result = await engine.assemble({ sessionId, sessionKey, messages: [...prior, live], tokenBudget: 4_000 });

    const carriers = bodyCarriers(result.messages);
    expect(carriers).toHaveLength(1);
    expect(carriers[0]?.content).toBe(LIVE_FORM);
  });
});
