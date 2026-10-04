// Lane split (Step 1) — lane tagging infrastructure with zero behavior change.
// Covers structural classification, per-lane distribution logging, ingest
// tagging, and re-ingest idempotency. Assembly behavior is intentionally not
// touched in this step.
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import {
  classifyMessageLane,
  formatAssembledComposition,
  formatLaneDistribution,
  formatPartTypeDistribution,
  summarizeAssembledComposition,
  summarizeLaneDistribution,
  summarizePartTypeDistribution,
} from "../src/lane-split.js";
import {
  cleanupEngineTestState,
  createEngine,
  createEngineWithDeps,
  createEngineWithDepsOverridesAndDb,
  makeMessage,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

/** Minimal helper: a tool-result message with a provider-minted tool-call id. */
function toolResultMessage(toolCallId: string, content: string): AgentMessage {
  return { role: "toolResult", toolCallId, content } as AgentMessage;
}

async function readLanes(engine: ReturnType<typeof createEngine>, sessionId: string) {
  const store = engine.getConversationStore();
  const conversation = await store.getConversationBySessionId(sessionId);
  expect(conversation).not.toBeNull();
  const messages = await store.getMessages(conversation!.conversationId);
  return messages.map((message) => message.lane);
}

describe("classifyMessageLane", () => {
  it("tags tool results as longtext", () => {
    expect(classifyMessageLane({ role: "tool", content: "x" })).toBe("longtext");
    expect(classifyMessageLane({ role: "toolResult", content: "x" })).toBe("longtext");
    expect(classifyMessageLane({ role: "assistant", type: "toolResult", content: "x" })).toBe(
      "longtext",
    );
  });

  it("tags user, assistant, and system messages as conversation", () => {
    expect(classifyMessageLane(makeMessage({ role: "user", content: "hi" }))).toBe(
      "conversation",
    );
    expect(classifyMessageLane(makeMessage({ role: "assistant", content: "hi" }))).toBe(
      "conversation",
    );
    expect(classifyMessageLane(makeMessage({ role: "system", content: "sys" }))).toBe(
      "conversation",
    );
  });
});

describe("summarizeLaneDistribution", () => {
  it("counts and token-sums per lane, flooring fractional estimates", () => {
    const distribution = summarizeLaneDistribution([
      { lane: "conversation", tokenCount: 10 },
      { lane: "conversation", tokenCount: 5.9 },
      { lane: "longtext", tokenCount: 100 },
    ]);
    expect(distribution).toEqual({
      conversation: { count: 2, tokens: 15 },
      longtext: { count: 1, tokens: 100 },
    });
    expect(formatLaneDistribution(distribution)).toBe(
      "conversation=2/15tok longtext=1/100tok",
    );
  });
});

describe("ingest lane tagging", () => {
  it("persists longtext for tool results and conversation for everything else", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();

    await engine.ingest({ sessionId, message: makeMessage({ role: "user", content: "hello" }) });
    await engine.ingest({
      sessionId,
      message: makeMessage({ role: "assistant", content: "world" }),
    });
    await engine.ingest({
      sessionId,
      message: toolResultMessage("call_lanetag0000001", "tool output"),
    });

    expect(await readLanes(engine, sessionId)).toEqual([
      "conversation",
      "conversation",
      "longtext",
    ]);
  });

  it("is idempotent for a re-ingested tool result", async () => {
    const engine = createEngine();
    const sessionId = randomUUID();
    const message = toolResultMessage("call_laneidem000001", "same output");

    expect(await engine.ingest({ sessionId, message })).toEqual({ ingested: true });
    expect(await engine.ingest({ sessionId, message: { ...message } })).toEqual({
      ingested: false,
    });

    expect(await readLanes(engine, sessionId)).toEqual(["longtext"]);
  });
});

describe("lane split logging is opt-in and non-mutating", () => {
  it("only emits lane debug lines when laneSplitEnabled is true, and stores identical rows", async () => {
    const offLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const onLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
    const off = createEngineWithDeps({}, { log: offLog });
    const on = createEngineWithDeps({ laneSplitEnabled: true }, { log: onLog });

    const sessionId = randomUUID();
    const message = toolResultMessage("call_lanelog0000001", "log payload");

    await off.ingest({ sessionId, message: makeMessage({ role: "user", content: "hi" }) });
    await off.ingest({ sessionId, message });
    await on.ingest({ sessionId, message: makeMessage({ role: "user", content: "hi" }) });
    await on.ingest({ sessionId, message });

    const offDebug = offLog.debug.mock.calls.map((call) => String(call[0]));
    const onDebug = onLog.debug.mock.calls.map((call) => String(call[0]));

    expect(offDebug.some((line) => line.includes("lane-split"))).toBe(false);
    expect(onDebug.some((line) => line.includes("lane-split ingest"))).toBe(true);

    const offStore = off.getConversationStore();
    const onStore = on.getConversationStore();
    const offConversation = await offStore.getConversationBySessionId(sessionId);
    const onConversation = await onStore.getConversationBySessionId(sessionId);
    const project = (messages: Array<{ role: string; content: string; lane: string }>) =>
      messages.map(({ role, content, lane }) => ({ role, content, lane }));

    expect(
      project(await onStore.getMessages(onConversation!.conversationId)),
    ).toEqual(project(await offStore.getMessages(offConversation!.conversationId)));
  });

  it("exposes the lane column as NOT NULL with a conversation default", async () => {
    const { engine, db } = createEngineWithDepsOverridesAndDb({});
    await engine.ingest({
      sessionId: randomUUID(),
      message: makeMessage({ role: "user", content: "schema check" }),
    });

    const columns = db.prepare("PRAGMA table_info(messages)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>;
    const lane = columns.find((column) => column.name === "lane");
    expect(lane).toBeDefined();
    expect(lane!.notnull).toBe(1);
    expect(lane!.dflt_value).toBe("'conversation'");
  });
});

describe("summarizePartTypeDistribution", () => {
  it("counts parts by part_type, not by role", () => {
    const distribution = summarizePartTypeDistribution(["text", "text", "reasoning", "tool"]);
    expect(distribution).toEqual({ text: 2, reasoning: 1, tool: 1 });
    expect(formatPartTypeDistribution(distribution)).toBe(
      "reasoning:1,text:2,tool:1",
    );
  });

  it("buckets empty part types under 'unknown'", () => {
    expect(summarizePartTypeDistribution(["", "text"])).toEqual({ unknown: 1, text: 1 });
  });
});

describe("summarizeAssembledComposition", () => {
  it("buckets emitted blocks by block type and counts serialized chars", () => {
    const reasoningBlock = { type: "reasoning", text: "abcd" };
    const toolBlock = { type: "toolCall", name: "read", arguments: "{}" };
    const composition = summarizeAssembledComposition([
      { role: "assistant", content: [reasoningBlock, toolBlock, { type: "text", text: "hi" }] },
      { role: "user", content: "plain string" },
    ]);

    expect(composition.messages).toBe(2);
    expect(composition.blocks).toBe(4);
    expect(composition.buckets.reasoning.blocks).toBe(1);
    expect(composition.buckets.reasoning.chars).toBe(JSON.stringify(reasoningBlock).length);
    expect(composition.buckets.tool.blocks).toBe(1);
    expect(composition.buckets.text.blocks).toBe(2);
    expect(composition.buckets.text.chars).toBe(
      JSON.stringify({ type: "text", text: "hi" }).length + "plain string".length,
    );
    expect(composition.buckets.other.blocks).toBe(0);
  });

  it("buckets tool-RESULT messages (role=tool, type=text blocks) as tool, not text", () => {
    const resultBlock = { type: "text", text: "file contents..." };
    const composition = summarizeAssembledComposition([
      { role: "tool", content: [resultBlock] },
      { role: "toolResult", content: "raw string result" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ]);

    // Regression guard: tool results must not be swallowed by the "text"
    // bucket. Measured 2026-10-03 — a type-only bucket reported tool-heavy
    // sessions as ~15% tool when they are actually 80-85%.
    expect(composition.buckets.tool.blocks).toBe(2);
    expect(composition.buckets.tool.chars).toBe(
      JSON.stringify(resultBlock).length + "raw string result".length,
    );
    expect(composition.buckets.text.blocks).toBe(1);
    expect(composition.buckets.text.chars).toBe(
      JSON.stringify({ type: "text", text: "ok" }).length,
    );
  });

  it("renders a stable single line with per-bucket character shares", () => {
    const line = formatAssembledComposition(
      summarizeAssembledComposition([{ role: "assistant", content: [{ type: "thinking", thinking: "x" }] }]),
    );
    expect(line).toContain("messages=1 blocks=1");
    expect(line).toContain("reasoning=1/");
    expect(line).toContain("(100.0%)");
  });
});
