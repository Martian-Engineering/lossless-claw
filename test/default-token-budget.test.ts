import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resolveLcmConfig, resolveDefaultTokenBudget } from "../src/db/config.js";
import type { ContextAssembler } from "../src/assembler.js";
import type { LcmContextEngine } from "../src/engine.js";
import { cleanupEngineTestState, createEngineWithConfig, seedStoredMessage } from "./helpers.js";

afterEach(cleanupEngineTestState);

const sessionId = "configured-budget";
const sessionKey = `agent:main:${sessionId}`;
const settings = (budget: number) => ({ schemaVersion: 1 as const,
  executionHost: { id: "test", label: "Test" }, limits: { promptTokenBudget: budget } });

describe("defaultTokenBudget configuration", () => {
  it("keeps the built-in default and schema/UI synchronized", () => {
    expect(resolveLcmConfig({}, {}).defaultTokenBudget).toBe(128_000);
    expect(manifest.configSchema.properties.defaultTokenBudget).toEqual({ type: "integer", minimum: 1, default: 128000 });
    expect(manifest.uiHints.defaultTokenBudget).toBeDefined();
  });
  it("uses a valid environment override before plugin config", () => {
    expect(resolveLcmConfig({ LCM_DEFAULT_TOKEN_BUDGET: "320000" }, { defaultTokenBudget: 200000 }).defaultTokenBudget).toBe(320000);
    expect(resolveLcmConfig({}, { defaultTokenBudget: 320000 }).defaultTokenBudget).toBe(320000);
  });
  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, 1.5])("rejects invalid fallback %s", value => {
    expect(resolveLcmConfig({}, { defaultTokenBudget: value }).defaultTokenBudget).toBe(128000);
    expect(resolveDefaultTokenBudget({ defaultTokenBudget: value })).toBe(128000);
  });
  it.each(["0", "-1", "NaN", "Infinity", "1.5"])("invalid env %s falls through to plugin config", value => {
    expect(resolveLcmConfig({ LCM_DEFAULT_TOKEN_BUDGET: value }, { defaultTokenBudget: 320000 }).defaultTokenBudget).toBe(320000);
  });
});

describe("configured lifecycle fallback", () => {
  it.each([
    { name: "missing allowance", expected: 320000 },
    { name: "invalid direct", direct: Number.NaN, expected: 320000 },
    { name: "smaller direct", direct: 64000, expected: 64000 },
    { name: "smaller host settings", host: 64000, expected: 64000 },
    { name: "conflicting current allowances", direct: 500000, host: 64000, expected: 64000 },
    { name: "explicit budget above default", direct: 500000, expected: 500000 },
    { name: "ceiling applies to fallback", cap: 200000, expected: 200000 },
    { name: "runtime context", context: 96000, expected: 96000 },
  ])("assembly and post-turn: $name", async ({ direct, host, cap, context, expected }) => {
    const engine = createEngineWithConfig({ defaultTokenBudget: 320000, maxAssemblyTokenBudget: cap });
    await seedStoredMessage(engine, { sessionId, sessionKey, message: { role: "user", content: "Retained evidence" } });
    const internal = engine as unknown as { assembler: ContextAssembler; compaction: { evaluate: (...args: unknown[]) => Promise<unknown> } };
    const assemble = vi.spyOn(internal.assembler, "assemble");
    const evaluate = vi.spyOn(internal.compaction, "evaluate").mockResolvedValue({ shouldCompact: false, reason: "none", currentTokens: 10, threshold: expected * 0.75 });
    const budgets = { tokenBudget: direct, runtimeSettings: host === undefined ? undefined : settings(host), runtimeContext: context === undefined ? undefined : { tokenBudget: context } };
    await engine.assemble({ sessionId, sessionKey, messages: [], ...budgets });
    expect(assemble).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: expected }));
    await engine.afterTurn({ sessionId, sessionKey, sessionFile: "", messages: [], prePromptMessageCount: 0, ...budgets });
    expect(evaluate).toHaveBeenCalledWith(expect.any(Number), expected, undefined, expect.any(Object));
  });

  it.each([undefined, 1000])("error fallback clamps against configured or smaller host budget (%s)", async host => {
    const engine = createEngineWithConfig({ defaultTokenBudget: 2000 });
    await seedStoredMessage(engine, { sessionId, sessionKey, message: { role: "user", content: "Evidence" } });
    const store = engine.getConversationStore();
    vi.spyOn(store, "getConversationForSession").mockRejectedValueOnce(new Error("synthetic read failure"));
    const result = await engine.assemble({ sessionId, sessionKey,
      messages: [
        { role: "user", content: "large ".repeat(12000) },
        { role: "assistant", content: "Older answer" },
        { role: "user", content: "Current small question" },
      ],
      ...(host === undefined ? {} : { runtimeSettings: settings(host) }),
    });
    expect(result.estimatedTokens).toBeLessThanOrEqual(host ?? 2000);
  });

  it.each([
    { recorded: 500000, expected: 320000 },
    { recorded: 64000, expected: 64000 },
    { recorded: 500000, host: 96000, expected: 96000 },
    { recorded: 500000, cap: 200000, expected: 200000 },
  ])("deferred maintenance preserves precedence ($recorded/$host/$cap)", async ({ recorded, host, cap, expected }) => {
    const engine = createEngineWithConfig({ defaultTokenBudget: 320000, maxAssemblyTokenBudget: cap });
    await seedStoredMessage(engine, { sessionId, sessionKey, message: { role: "user", content: "Evidence" } });
    const conversation = (await engine.getConversationStore().getConversationForSession({ sessionId, sessionKey }))!;
    await engine.getCompactionMaintenanceStore().requestProactiveCompactionDebt({ conversationId: conversation.conversationId, reason: "threshold", tokenBudget: recorded, currentTokenCount: 160000 });
    const execute = vi.spyOn(engine as unknown as { executePendingCompactionCore: (params: unknown) => Promise<unknown> }, "executePendingCompactionCore")
      .mockResolvedValue({ ok: true, compacted: false, reason: "below current threshold" });
    await engine.maintain({ sessionId, sessionKey, sessionFile: "", runtimeContext: { allowDeferredCompactionExecution: true }, ...(host === undefined ? {} : { runtimeSettings: settings(host) }) });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ tokenBudget: expected }));
  });
});
