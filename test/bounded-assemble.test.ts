/**
 * Regression tests for bounded assemble output (lossless-claw-30b.1).
 *
 * Incident: a session imported from a previous harness carried live tool
 * messages whose structured payloads were invisible to text-only token
 * estimates. assemble() returned a context the host's LLM-boundary
 * estimator measured at 415k tokens against a 272k budget, wedging the
 * session in a compact/overflow loop. These tests pin the new invariant:
 * assemble() output, measured by serialized estimate, never exceeds the
 * token budget — on the assembler path and on every live-fallback path.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LcmConfig } from "../src/db/config.js";
import { closeLcmConnection, createLcmDatabaseConnection } from "../src/db/connection.js";
import { LcmContextEngine } from "../src/engine.js";
import { estimateSerializedMessagesTokens } from "../src/estimate-tokens.js";
import {
  SERIALIZED_OUTPUT_CLAMP_SAFETY_RATIO,
  clampMessagesToSerializedBudget,
} from "../src/assemble-fallback.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type { LcmDependencies } from "../src/types.js";
import { createTestConfig as createSharedTestConfig, createTestDeps as createSharedTestDeps } from "./helpers.js";

const tempDirs: string[] = [];
const engines: LcmContextEngine[] = [];
const dbs: ReturnType<typeof createLcmDatabaseConnection>[] = [];

afterEach(() => {
  engines.splice(0);
  for (const db of dbs.splice(0)) {
    try {
      closeLcmConnection(db);
    } catch {
      // best-effort cleanup
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTestConfig(databasePath: string): LcmConfig {
  return createSharedTestConfig(databasePath, { freshTailCount: 4 });
}

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return null;
  }
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

function createTestDeps(config: LcmConfig): LcmDependencies {
  return createSharedTestDeps(config, {
    readLatestAssistantReply: () => undefined,
    resolveAgentDir: () => tmpdir(),
  });
}

function createEngine(): LcmContextEngine {
  const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-bounded-"));
  tempDirs.push(tempDir);
  const config = createTestConfig(join(tempDir, "lcm.db"));
  const db = createLcmDatabaseConnection(config.databasePath);
  dbs.push(db);
  const engine = new LcmContextEngine(createTestDeps(config), db);
  engines.push(engine);
  return engine;
}

/**
 * Codex-era style tool result: large payload duplicated across `content`
 * and `text` part fields plus mirrored identifiers. Text-only estimators
 * see a fraction of the serialized mass.
 */
function makeHeavyToolResultMessage(index: number, payloadChars: number): AgentMessage {
  const payload = `tool output ${index}: ${"data ".repeat(Math.ceil(payloadChars / 5))}`;
  return {
    role: "toolResult",
    toolCallId: `call_${index}`,
    toolName: "exec",
    content: [
      {
        type: "toolResult",
        id: `call_${index}`,
        toolCallId: `call_${index}`,
        toolUseId: `call_${index}`,
        tool_use_id: `call_${index}`,
        content: payload,
        text: payload,
      },
    ],
    timestamp: 1_781_035_270_000 + index,
  } as unknown as AgentMessage;
}

function makeUserMessage(index: number): AgentMessage {
  return {
    role: "user",
    content: `user turn ${index}`,
    timestamp: 1_781_035_270_000 + index,
  } as unknown as AgentMessage;
}

function makeHeavyLiveTranscript(pairs: number, payloadChars: number): AgentMessage[] {
  const messages: AgentMessage[] = [makeUserMessage(0)];
  for (let i = 1; i <= pairs; i += 1) {
    messages.push(makeHeavyToolResultMessage(i, payloadChars));
    if (i % 5 === 0) {
      messages.push(makeUserMessage(i));
    }
  }
  messages.push(makeUserMessage(pairs + 1));
  return messages;
}

describe("bounded assemble output", () => {
  it("clamps near-budget serialized output to leave host renderer headroom", () => {
    const messages = makeHeavyLiveTranscript(12, 4_000);
    const serializedTokens = estimateSerializedMessagesTokens(messages);
    const tokenBudget = Math.ceil(serializedTokens / 0.95);

    expect(serializedTokens).toBeLessThan(tokenBudget);
    expect(serializedTokens).toBeGreaterThan(
      Math.floor(tokenBudget * SERIALIZED_OUTPUT_CLAMP_SAFETY_RATIO),
    );

    const result = clampMessagesToSerializedBudget({ messages, tokenBudget });

    expect(result.clamped).toBe(true);
    expect(result.serializedTokens).toBeLessThanOrEqual(
      Math.floor(tokenBudget * SERIALIZED_OUTPUT_CLAMP_SAFETY_RATIO),
    );
    expect(result.evictedMessages).toBeGreaterThan(0);
    expect(result.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("bounds the live fallback when stored coverage trails a heavy live transcript", async () => {
    const engine = createEngine();
    const sessionId = "session-bounded-fallback";
    const sessionKey = "agent:main:telegram:group:test:topic:1";

    // Persist a couple of raw messages so the conversation exists but
    // coverage clearly trails the live transcript (no summaries).
    await engine.ingest({ sessionId, sessionKey, message: makeUserMessage(0) });
    await engine.ingest({ sessionId, sessionKey, message: makeUserMessage(1) });

    const tokenBudget = 8_000;
    const liveMessages = makeHeavyLiveTranscript(40, 4_000);
    const liveSerializedTokens = estimateSerializedMessagesTokens(liveMessages);
    expect(liveSerializedTokens).toBeGreaterThan(tokenBudget * 3);

    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.length).toBeLessThan(liveMessages.length);
    expect(estimateSerializedMessagesTokens(result.messages)).toBeLessThanOrEqual(tokenBudget);
    expect(result.estimatedTokens).toBeLessThanOrEqual(tokenBudget);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    // Output keeps the newest suffix: the final user turn must survive.
    expect(result.messages.some((m) => m.role === "user")).toBe(true);
    expect(result.messages[result.messages.length - 1]?.role).not.toBe("assistant");
  });

  it("clamps assembled output whose serialized size exceeds the budget", async () => {
    const engine = createEngine();
    const sessionId = "session-clamped-assembled";
    const sessionKey = "agent:main:telegram:group:test:topic:2";

    // Persist the full heavy transcript so assembly covers the live set.
    const liveMessages = makeHeavyLiveTranscript(30, 4_000);
    for (const message of liveMessages) {
      await engine.ingest({ sessionId, sessionKey, message });
    }

    const tokenBudget = 6_000;
    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: liveMessages,
      tokenBudget,
    });

    expect(result.messages.length).toBeGreaterThan(0);
    expect(estimateSerializedMessagesTokens(result.messages)).toBeLessThanOrEqual(tokenBudget);
    expect(result.estimatedTokens).toBeLessThanOrEqual(tokenBudget);
    expect(result.messages.some((m) => m.role === "user")).toBe(true);
  });

  it("does not clamp small contexts and reports a non-zero estimate", async () => {
    const engine = createEngine();
    const sessionId = "session-small-context";
    const sessionKey = "agent:main:telegram:group:test:topic:3";

    await engine.ingest({ sessionId, sessionKey, message: makeUserMessage(0) });

    const result = await engine.assemble({
      sessionId,
      sessionKey,
      messages: [makeUserMessage(0)],
      tokenBudget: 50_000,
    });

    expect(result.messages).toHaveLength(1);
    expect(result.estimatedTokens).toBeGreaterThan(0);
    expect(result.estimatedTokens).toBeLessThan(1_000);
  });

  it("passes ignored sessions through untouched", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "lossless-claw-bounded-"));
    tempDirs.push(tempDir);
    const config = {
      ...createTestConfig(join(tempDir, "lcm.db")),
      ignoreSessionPatterns: ["agent:*:cron:**"],
    };
    const db = createLcmDatabaseConnection(config.databasePath);
    dbs.push(db);
    const engine = new LcmContextEngine(createTestDeps(config), db);
    engines.push(engine);

    const liveMessages = makeHeavyLiveTranscript(20, 4_000);
    const result = await engine.assemble({
      sessionId: "session-ignored",
      sessionKey: "agent:main:cron:hourly",
      messages: liveMessages,
      tokenBudget: 1_000,
    });

    // Ignored sessions are not managed by LCM: no clamping, legacy shape.
    expect(result.messages.length).toBe(liveMessages.length);
    expect(result.estimatedTokens).toBe(0);
  });
});
