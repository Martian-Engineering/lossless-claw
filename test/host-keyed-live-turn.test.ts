import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { VisibleSessionTranscriptMessageEntry } from "../src/types.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { attachTranscriptEntryMeta } from "../src/transcript.js";
import { restoreCurrentUserTurn } from "../src/user-replay.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import {
  cleanupEngineTestState, createEngineWithDepsOverridesAndDb, createSessionFilePath,
  createTestDeps, getEngineConfig, TestLcmContextEngine,
} from "./helpers.js";

afterEach(() => { vi.restoreAllMocks(); cleanupEngineTestState(); });

const BODY = "The label maker needs a fresh ribbon.";
const INJECTED = `<inherited-rules>Keep confirmations short.</inherited-rules>\n<relevant-memories>Bench lamp repaired.</relevant-memories>\n\n[Thu 2026-09-17 06:03 GMT+3] ${BODY}`;

/** Model the host's occurrence key separately from repeated message content. */
function user(content: string, key?: string): AgentMessage {
  return { role: "user", content, timestamp: 3_000, ...(key ? { idempotencyKey: key } : {}) } as AgentMessage;
}

/** Build the visible transcript projection, including its stable entry identities. */
function entries(messages: AgentMessage[]): VisibleSessionTranscriptMessageEntry[] {
  return messages.map((message, index) => ({
    entryId: `entry-${index}`, parentId: index ? `entry-${index - 1}` : null,
    seq: index, role: message.role, message,
  }));
}

/** Each harness owns a real SQLite store and a mutable host-visible projection. */
function harness() {
  const visible: AgentMessage[] = [];
  const deps = { readVisibleSessionTranscriptMessageEntries: async () => entries(visible) };
  const { engine, db } = createEngineWithDepsOverridesAndDb(deps);
  const session = { sessionId: "keyed-turn", sessionKey: "agent:main:keyed-turn" };
  const sessionFile = createSessionFilePath("keyed-turn");
  const prior = [user(BODY, "older:user"), { role: "assistant", content: "Prior answer" }];
  return { engine, db, deps, visible, session, sessionFile, prior };
}

/** Mirror the eager hook's transcript-form afterTurn, then provider-form assemble. */
async function eagerTurn(h: ReturnType<typeof harness>, key: string | undefined = "current:user") {
  const current = user(BODY, key);
  h.visible.push(...h.prior, current);
  await h.engine.bootstrap({ ...h.session, sessionFile: h.sessionFile });
  await h.engine.afterTurn({
    ...h.session, sessionFile: h.sessionFile, messages: [...h.prior, current],
    prePromptMessageCount: h.prior.length, tokenBudget: 4_000,
  });
  const live = [...h.prior, user(INJECTED, key)];
  return { live, result: await h.engine.assemble({ ...h.session, messages: live, tokenBudget: 4_000 }) };
}

/** Assert that each actual user occurrence survives, with the live current envelope. */
function expectCurrent(messages: AgentMessage[], historical = 1) {
  expect(messages.filter(message => message.role === "user")).toHaveLength(historical + 1);
  expect(messages.filter(message => message.content === BODY)).toHaveLength(historical);
  expect(messages.filter(message => message.content === INJECTED)).toHaveLength(1);
}

describe("keyed host current user replay", () => {
  it("preserves an identical historical body and the current injection after bootstrap catch-up", async () => {
    const h = harness();
    const { live, result } = await eagerTurn(h);
    expectCurrent(result.messages);
    expect(result.messages.at(-1)).toMatchObject({ idempotencyKey: "current:user", timestamp: 3_000 });
    expect(result.estimatedTokens).toBe(estimateSerializedMessagesTokens(result.messages));
    expect(live.at(-1)?.content).toBe(INJECTED);
    expect(h.visible.at(-1)?.content).toBe(BODY);
    const conversation = await h.engine.getConversationStore().getConversationBySessionId(h.session.sessionId);
    expect(await h.engine.getConversationStore().getMessageCount(conversation!.conversationId)).toBe(3);
  });

  it("preserves injections between sender metadata and body without structural matching", async () => {
    const h = harness();
    const sender = 'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"sender":{"id":"sam"}}\n```\n\n';
    const transcript = `${sender}${BODY}`;
    const provider = `${sender}<organization-policy>Confirm briefly.</organization-policy>\n\n${BODY}`;
    h.visible.push(...h.prior, user(transcript, "current:user"));
    await h.engine.bootstrap({ ...h.session, sessionFile: h.sessionFile });
    const result = await h.engine.assemble({ ...h.session,
      messages: [...h.prior, user(provider, "current:user")], tokenBudget: 4_000 });
    expect(result.messages.filter(message => message.role === "user")).toHaveLength(2);
    expect(result.messages.some(message => message.content === transcript)).toBe(false);
    expect(result.messages.some(message => message.content === provider)).toBe(true);
  });

  it("preserves historical rows when the identity projection is unavailable", async () => {
    const h = harness();
    const { live } = await eagerTurn(h);
    // Reconstruct with an unavailable reader so no earlier proof can be reused.
    const config = getEngineConfig(h.engine);
    const unavailable = new TestLcmContextEngine(createTestDeps(config, {
      readVisibleSessionTranscriptMessageEntries: async () => { throw new Error("unavailable"); },
    }), h.db);
    const result = await unavailable.assemble({ ...h.session, messages: live, tokenBudget: 4_000 });
    expect(result.messages.filter(message => message.content === BODY)).toHaveLength(2);
  });

  it("preserves the live occurrence through later iterations and more than 30 minutes", async () => {
    const h = harness();
    const { live } = await eagerTurn(h);
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 31 * 60 * 1000);
    const reply = { role: "assistant", content: "Checking stock" };
    h.visible.push(reply);
    await h.engine.afterTurn({ ...h.session, sessionFile: h.sessionFile, messages: h.visible,
      prePromptMessageCount: 3, tokenBudget: 4_000 });
    const result = await h.engine.assemble({ ...h.session, messages: [...live, reply], tokenBudget: 4_000 });
    expectCurrent(result.messages);
  });

  it("reconstructs proof from the host projection after reopening the persisted database", async () => {
    const h = harness();
    const { live } = await eagerTurn(h);
    const config = getEngineConfig(h.engine);
    closeLcmConnection(h.db);
    const restarted = new TestLcmContextEngine(createTestDeps(config, h.deps), createLcmDatabaseConnection(config.databasePath));
    await restarted.bootstrap({ ...h.session, sessionFile: h.sessionFile });
    const result = await restarted.assemble({ ...h.session, messages: live, tokenBudget: 4_000 });
    expectCurrent(result.messages);
  });

  it("keeps current proof when an older commit receipt is retried", async () => {
    const h = harness();
    h.visible.push(...h.prior);
    await h.engine.bootstrap({ ...h.session, sessionFile: h.sessionFile });
    const scope = { ...h.session, agentId: "main", storePath: "/tmp/host.sqlite", generation: "generation-1" };
    const admission = { ...scope, entryId: "entry-0", effectiveParentId: null, rawSeq: 0,
      activeMessagePosition: 0, logicalTurnId: "older-turn", role: "user" as const };
    const receipt = { ...h.session, advancementKey: admission.logicalTurnId, admission,
      terminal: { ...scope, entryId: "entry-1", effectiveParentId: "entry-0", rawSeq: 1, activeMessagePosition: 1 },
      messages: h.prior };
    expect(await h.engine.commitTurn(receipt)).toEqual({ status: "committed" });
    h.visible.push(user(BODY, "current:user"));
    await h.engine.afterTurn({ ...h.session, sessionFile: h.sessionFile, messages: h.visible,
      prePromptMessageCount: 2, tokenBudget: 4_000 });
    expect(await h.engine.commitTurn(receipt)).toEqual({ status: "duplicate" });
    const result = await h.engine.assemble({ ...h.session,
      messages: [...h.prior, user(INJECTED, "current:user")], tokenBudget: 4_000 });
    expectCurrent(result.messages);
  });

  it("preserves admitted-turn live content when the host appends it after history assembly", async () => {
    const h = harness();
    // 2026.9.4 deferredTurn omits afterTurn and fences the current row out.
    h.visible.push(...h.prior);
    await h.engine.bootstrap({ ...h.session, sessionFile: h.sessionFile });
    const assembled = await h.engine.assemble({ ...h.session, messages: h.prior,
      prompt: INJECTED, availableTools: new Set(), tokenBudget: 4_000 });
    expectCurrent([...assembled.messages, user(INJECTED, "current:user")]);
  });

  it("keeps the current runtime carrier attached to its restored user", async () => {
    const h = harness();
    const { live } = await eagerTurn(h);
    const carrier = { role: "custom", customType: "openclaw.runtime-context", content: "host context",
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true } } as AgentMessage;
    // A summary keeps this probe on store assembly despite the extra live carrier.
    const conversation = await h.engine.getConversationStore().getConversationBySessionId(h.session.sessionId);
    const summaries = h.engine.getSummaryStore();
    await summaries.insertSummary({ summaryId: "history", conversationId: conversation!.conversationId,
      kind: "leaf", depth: 0, content: "Older history", tokenCount: 4 });
    await summaries.replaceContextRangeWithSummary({ conversationId: conversation!.conversationId,
      startOrdinal: 0, endOrdinal: 0, summaryId: "history" });
    const result = await h.engine.assemble({ ...h.session, messages: [...live, carrier], tokenBudget: 4_000 });
    const index = result.messages.findIndex(message => message.content === INJECTED);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(result.messages[index + 1]).toEqual(carrier);
    expect(result.estimatedTokens).toBe(estimateSerializedMessagesTokens(result.messages));
  });

  it("leaves pre-prompt and 2026.9.4 admitted history intact", async () => {
    const h = harness();
    await eagerTurn(h);
    const result = await h.engine.assemble({ ...h.session, messages: h.prior,
      prompt: "An unrelated next question", availableTools: new Set(), tokenBudget: 4_000 });
    expect(result.messages.filter(message => message.content === BODY)).toHaveLength(2);
    expect(result.messages.some(message => message.content === INJECTED)).toBe(false);
  });

  it("retains the known unkeyed duplicate because text and timestamps do not prove occurrence", async () => {
    const h = harness();
    // Use a keyless current turn; both bodies remain until the host supplies identity.
    const { result } = await eagerTurn(h, "");
    expect(result.messages.filter(message => message.content === BODY)).toHaveLength(2);
    expect(result.messages.filter(message => message.content === INJECTED)).toHaveLength(1);
  });
});

describe("current-turn identity proof", () => {
  function proof() {
    const current = user(INJECTED, "current:user");
    const canonical = entries([user(BODY, "current:user")]);
    const row = attachTranscriptEntryMeta(user(BODY), { entryId: "entry-0", parentId: null, timestamp: null });
    return { assembled: [row], live: [current], canonical };
  }

  it.each([
    "missing-key", "reused-live-key", "reused-transcript-key", "conflicting-envelope-key",
    "missing-entry", "reused-entry", "untrusted-row", "reused-row", "externalized-row", "different-key",
  ])("preserves ambiguous history: %s", reason => {
    const p = proof();
    if (reason === "missing-key") p.live = [user(INJECTED)];
    if (reason === "reused-live-key") p.live.unshift(user(BODY, "current:user"));
    if (reason === "reused-transcript-key") p.canonical.push({ ...p.canonical[0]!, entryId: "entry-other" });
    if (reason === "conflicting-envelope-key") p.canonical[0]!.idempotencyKey = "other:user";
    if (reason === "missing-entry") p.canonical = [];
    if (reason === "reused-entry") p.canonical.push({ ...p.canonical[0]!, message: user("other", "other:user") });
    if (reason === "untrusted-row") p.assembled = [user(BODY)];
    if (reason === "reused-row") p.assembled.push({ ...p.assembled[0]! });
    if (reason === "externalized-row") p.assembled[0]!.content = "[externalized payload]";
    if (reason === "different-key") p.live = [user(INJECTED, "new:user")];
    expect(restoreCurrentUserTurn(p.assembled, p.live, p.canonical).messages).toBe(p.assembled);
  });

  it("does not replace an earlier keyed live user when the final user is unrelated", () => {
    const p = proof();
    p.live.push(user("new question", "new:user"));
    expect(restoreCurrentUserTurn(p.assembled, p.live, p.canonical).messages).toBe(p.assembled);
  });

  it("accepts a unique envelope-only key", () => {
    const p = proof();
    p.canonical[0]!.message = user(BODY);
    p.canonical[0]!.idempotencyKey = "current:user";
    const restored = restoreCurrentUserTurn(p.assembled, p.live, p.canonical);
    expect(restored.messages[0]?.content).toBe(INJECTED);
    expect(restored.tokenDelta).toBeGreaterThan(0);
  });
  it("preserves image blocks when replacing the keyed provider text", () => {
    const p = proof();
    const image = { type: "image", mimeType: "image/png", data: "AA==" };
    p.canonical[0]!.message.content = [{ type: "text", text: BODY }, image];
    p.assembled[0]!.content = [{ type: "text", text: BODY }, image];
    p.live[0]!.content = [{ type: "text", text: INJECTED }, image];
    expect(restoreCurrentUserTurn(p.assembled, p.live, p.canonical).messages[0]?.content).toEqual(p.live[0]!.content);
  });

});
