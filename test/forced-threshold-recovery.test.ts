import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupEngineTestState,
  createEngineWithDeps,
  createSessionFilePath,
} from "./helpers.js";
import type { CompactionEngine } from "../src/compaction.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";

// Use the public compact() entry point and real stores, planner, fallback, and
// sweep. Only the external LLM is mocked, so dropped recovery flags reproduce
// the production wedge instead of being hidden by a mocked compaction engine.
afterEach(cleanupEngineTestState);

async function setup(options: { freshTailCount?: number; malformed?: boolean; olderPrefix?: boolean } = {}) {
  const complete = vi.fn(async () => ({
    content: [{ type: "text", text: "File inspection found deployment evidence; raw sources remain linked." }],
  }));
  const engine = createEngineWithDeps({
    contextThreshold: 0.75,
    freshTailCount: options.freshTailCount ?? 4,
    freshTailMaxTokens: 3_000,
    leafChunkTokens: 3_000,
    largeFileTokenThreshold: 1_000_000,
    sweepMaxDepth: 0,
  }, { complete });
  const sessionId = "forced-threshold-tool-turn";
  const sessionKey = "agent:main:dashboard:forced-threshold";
  const messages: AgentMessage[] = [];
  if (options.olderPrefix) {
    messages.push({ role: "user", content: "Earlier completed work." } as AgentMessage);
    messages.push({ role: "assistant", content: "Old deployment notes. ".repeat(2_000) } as AgentMessage);
  }
  messages.push({ role: "user", content: "Inspect the files and report their findings." } as AgentMessage);
  for (let index = 0; index < (options.olderPrefix ? 2 : 12); index++) {
    messages.push({
      role: "assistant",
      content: [{ type: "toolCall", id: `call_${index}`, name: "read", arguments: { path: `file-${index}` } }],
    } as AgentMessage);
    messages.push({
      role: "toolResult",
      toolCallId: options.malformed && index === 0 ? "wrong_call" : `call_${index}`,
      toolName: "read",
      content: [{ type: "text", text: `FILE_${index} ${"deployment evidence ".repeat(250)}` }],
    } as AgentMessage);
  }
  for (const message of messages) await engine.ingest({ sessionId, sessionKey, message });
  const conversation = await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey });
  const conversationId = conversation!.conversationId;
  const beforeRows = await engine.getConversationStore().getMessages(conversationId);
  const beforeTokens = await engine.getSummaryStore().getContextTokenCount(conversationId);
  expect(beforeTokens).toBeGreaterThan(8_000);
  return {
    engine, complete, conversationId, beforeRows, beforeTokens,
    params: {
      sessionId, sessionKey,
      sessionFile: createSessionFilePath(sessionId),
      tokenBudget: 8_000,
      compactionTarget: "threshold" as const,
      runtimeSettings: {
        schemaVersion: 1 as const,
        executionHost: { id: "openclaw-embedded", label: "OpenClaw" },
      },
    },
  };
}

describe("forced threshold recovery of a tool-heavy latest turn", () => {
  it("compacts completed groups through the pending fallback and stops at the threshold", async () => {
    const { engine, complete, conversationId, beforeRows, beforeTokens, params } = await setup();
    const afterPass: number[] = [];
    const compaction = (engine as unknown as { compaction: CompactionEngine }).compaction;
    const sweeps = vi.spyOn(compaction, "compactFullSweep");
    const result = await engine.compact({
      ...params, force: true,
      onProgress: async () => {
        afterPass.push(await engine.getSummaryStore().getContextTokenCount(conversationId));
      },
    });
    expect(result).toMatchObject({ ok: true, compacted: true });
    const afterTokens = await engine.getSummaryStore().getContextTokenCount(conversationId);
    expect(afterTokens).toBeLessThanOrEqual(6_000);
    expect(afterTokens).toBeLessThan(beforeTokens);
    expect(complete).toHaveBeenCalled();
    expect(sweeps).toHaveBeenCalledTimes(2);
    expect(sweeps.mock.calls[0]![0].allowCurrentTurnCompaction).toBeUndefined();
    await expect(sweeps.mock.results[0]!.value).resolves.toMatchObject({ actionTaken: false });
    expect(sweeps.mock.calls[1]![0]).toMatchObject({ allowCurrentTurnCompaction: true, stopAtTokens: 6_000 });
    // The first committed pass below the target must be the last pass.
    expect(afterPass.length).toBeGreaterThan(1);
    expect(afterPass.slice(0, -1).every(tokens => tokens > 6_000)).toBe(true);
    expect(afterPass.at(-1)).toBe(afterTokens);

    const store = engine.getConversationStore();
    expect(await store.getMessages(conversationId)).toEqual(beforeRows);
    const items = await engine.getSummaryStore().getContextItems(conversationId);
    const rawIds = items.filter(item => item.itemType === "message").map(item => item.messageId);
    expect(rawIds).toContain(beforeRows[0]!.messageId);
    for (const row of beforeRows.slice(-4)) expect(rawIds).toContain(row.messageId);
    expect(items.some(item => item.itemType === "summary")).toBe(true);
    const raw = beforeRows.filter(row => rawIds.includes(row.messageId));
    // Every remaining call retains its matching result, including the recent tail.
    for (let index = 1; index < raw.length; index += 2) {
      expect(raw[index]!.role).toBe("assistant");
      expect(raw[index + 1]!.role).toBe("tool");
      const call = (await store.getMessageParts(raw[index]!.messageId)).find(part => part.partType === "tool");
      const resultParts = await store.getMessageParts(raw[index + 1]!.messageId);
      expect(resultParts.some(part => part.toolCallId === call!.toolCallId)).toBe(true);
    }
    expect(JSON.stringify(complete.mock.calls)).toContain("FILE_0");
  });

  it("uses eligible older history without entering current-turn recovery", async () => {
    const { engine, conversationId, beforeRows, params } = await setup({ olderPrefix: true });
    const compaction = (engine as unknown as { compaction: CompactionEngine }).compaction;
    const sweeps = vi.spyOn(compaction, "compactFullSweep");
    const result = await engine.compact({ ...params, force: true });
    expect(result).toMatchObject({ ok: true, compacted: true });
    expect(sweeps.mock.calls.every(([input]) => !input.allowCurrentTurnCompaction)).toBe(true);
    expect(await engine.getSummaryStore().getContextTokenCount(conversationId)).toBeLessThanOrEqual(6_000);
    const items = await engine.getSummaryStore().getContextItems(conversationId);
    for (const row of beforeRows.slice(2)) expect(items.some(item => item.messageId === row.messageId)).toBe(true);
    expect(await engine.getConversationStore().getMessages(conversationId)).toEqual(beforeRows);
  });

  it("does not recover the latest turn when already below the target", async () => {
    const { engine, complete, conversationId, beforeTokens, params } = await setup();
    await engine.compact({ ...params, tokenBudget: 100_000, force: true });
    expect(complete).not.toHaveBeenCalled();
    expect(await engine.getSummaryStore().getContextTokenCount(conversationId)).toBe(beforeTokens);
  });

  it.each([
    { name: "sweep budget exhausted", stoppedAtBudget: true },
    { name: "provider authentication failed", authFailure: true },
    { name: "host cancelled", cancelled: true },
    { name: "summary made no token reduction", actionTaken: true },
  ])("does not treat $name as normal-compaction exhaustion", async (failure) => {
    const { engine, complete, beforeTokens, params } = await setup();
    const abort = new AbortController();
    const compaction = (engine as unknown as { compaction: CompactionEngine }).compaction;
    const sweeps = vi.spyOn(compaction, "compactFullSweep").mockImplementation(async () => {
      if (failure.cancelled) abort.abort();
      return {
        actionTaken: failure.actionTaken ?? false,
        tokensBefore: beforeTokens, tokensAfter: beforeTokens,
        condensed: false, stoppedAtBudget: failure.stoppedAtBudget, authFailure: failure.authFailure,
      };
    });
    await engine.compact({ ...params, force: true, abortSignal: abort.signal });
    expect(sweeps).toHaveBeenCalledTimes(failure.actionTaken ? 2 : 1);
    expect(sweeps.mock.calls.every(([input]) => !input.allowCurrentTurnCompaction)).toBe(true);
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps the whole latest turn protected for unforced threshold compaction", async () => {
    const { engine, complete, conversationId, beforeRows, beforeTokens, params } = await setup();
    const result = await engine.compact({ ...params, force: false });
    expect(result).toMatchObject({ ok: false, compacted: false });
    expect(complete).not.toHaveBeenCalled();
    expect(await engine.getSummaryStore().getContextTokenCount(conversationId)).toBe(beforeTokens);
    expect(await engine.getConversationStore().getMessages(conversationId)).toEqual(beforeRows);
  });

  it("refuses to summarize mismatched tool groups and preserves their source rows", async () => {
    const { engine, complete, conversationId, beforeRows, beforeTokens, params } = await setup({ malformed: true });
    const result = await engine.compact({ ...params, force: true });
    expect(result).toMatchObject({ ok: false, compacted: false });
    expect(complete).not.toHaveBeenCalled();
    expect(await engine.getSummaryStore().getContextTokenCount(conversationId)).toBe(beforeTokens);
    expect(await engine.getConversationStore().getMessages(conversationId)).toEqual(beforeRows);
  });

  it("retains the initiating user even when routine fresh-tail protection is disabled", async () => {
    const { engine, conversationId, beforeRows, params } = await setup({ freshTailCount: 0 });
    const result = await engine.compact({ ...params, force: true });
    expect(result).toMatchObject({ ok: true, compacted: true });
    const items = await engine.getSummaryStore().getContextItems(conversationId);
    expect(items.some(item => item.messageId === beforeRows[0]!.messageId)).toBe(true);
    expect(await engine.getConversationStore().getMessages(conversationId)).toEqual(beforeRows);
  });
});
