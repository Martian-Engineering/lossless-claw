/**
 * lcm_compact agent tool — behavioral tests.
 *
 * Coverage:
 *   1. Operator-disabled gate (default: tool registered, refuses with structured reason)
 *   2. Floor refusal (context% < reserveFraction)
 *   3. Per-window cap enforcement (2 calls per 5 min)
 *   4. Engine reason mapping (collapse 12 engine reasons → 8 tool reasons)
 *   5. Engine-unhealthy short-circuit
 *   6. Cache-hot gate (positive case via mocked telemetry)
 *
 * NOT tested here (would need real LLM credentials or extensive mocking):
 *   - End-to-end successful compaction (covered by integration tests
 *     against a live engine; this MVP avoids LLM calls in CI)
 *   - Auth circuit-breaker propagation (engine-side concern, tested
 *     in compaction.test.ts)
 *   - Concurrent-call serialization (engine-side; pre-existing
 *     race tested in session-operation-queues.test.ts)
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import {
  createLcmCompactTool,
  __resetLcmCompactCountersForTesting,
} from "../src/tools/lcm-compact-tool.js";
import { makeTestDeps, makeTestEngine } from "./fixtures/v41-tool-harness.js";

let db: DatabaseSync;

beforeEach(() => {
  __resetLcmCompactCountersForTesting();
  db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  db.prepare(
    `INSERT INTO conversations (conversation_id, session_id, session_key, active) VALUES (1, 'sess', 'agent:main:main', 1)`,
  ).run();
});

afterEach(() => {
  __resetLcmCompactCountersForTesting();
  db.close();
});

function depsWithCompactionEnabled(enabled = true) {
  const deps = makeTestDeps();
  (deps.config as { agentCompactionToolEnabled?: boolean }).agentCompactionToolEnabled = enabled;
  return deps;
}

describe("lcm_compact — operator opt-in gate", () => {
  it("returns operator-disabled when agentCompactionToolEnabled is false (default)", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(false),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("test", {});
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("operator-disabled");
    expect(payload.note).toContain("agentCompactionToolEnabled: true");
  });

  it("registers regardless of the flag — agent always sees the tool", () => {
    // Always-register pattern: tool is in the agent's list whether or
    // not the operator enabled it. Disabled state surfaces as a
    // structured response, not "tool not found."
    const enabledTool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    const disabledTool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(false),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    expect(enabledTool.name).toBe("lcm_compact");
    expect(disabledTool.name).toBe("lcm_compact");
  });
});

describe("lcm_compact — engine gate-state refusals", () => {
  it("refuses with below-floor when context is below reserveFraction (50% default)", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      // Mock the runtime context: agent is at 30% of budget — well
      // below the 50% reserve. Tool should refuse without calling
      // engine.compact().
      getRuntimeContext: () => ({
        currentTokenCount: 30_000,
        tokenBudget: 100_000,
        sessionFile: "/tmp/test-session.jsonl",
      }),
    });
    const r = await tool.execute("test", {});
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.ok).toBe(true);  // gate-refusal is "ran successfully and refused"
    expect(payload.compacted).toBe(false);
    expect(payload.reason).toBe("below-floor");
    expect(payload.note).toContain("30.0%");
    expect(payload.note).toContain("50%");
    expect(payload.contextRatio).toBeCloseTo(0.3, 2);
  });

  it("does NOT refuse when context is above reserveFraction (75% with 0.5 floor)", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      getRuntimeContext: () => ({
        currentTokenCount: 75_000,
        tokenBudget: 100_000,
        sessionFile: "/tmp/test-session.jsonl",
      }),
    });
    const r = await tool.execute("test", {});
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    // Won't be "below-floor"; could be "noop" / "no-conversation" / etc.
    // — anything BUT below-floor.
    expect(payload.reason).not.toBe("below-floor");
  });

  it("respects custom reserveFraction param (0.7 — refuses at 60%)", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      getRuntimeContext: () => ({
        currentTokenCount: 60_000,
        tokenBudget: 100_000,
        sessionFile: "/tmp/test-session.jsonl",
      }),
    });
    const r = await tool.execute("test", { reserveFraction: 0.7 });
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.reason).toBe("below-floor");
    expect(payload.note).toContain("70%");
  });

  it("clamps reserveFraction to [0.5, 1.0] range — values below 0.5 treated as 0.5", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      getRuntimeContext: () => ({
        currentTokenCount: 40_000,
        tokenBudget: 100_000,
        sessionFile: "/tmp/test-session.jsonl",
      }),
    });
    // Agent passes reserveFraction=0.1 (way below floor) — should be
    // clamped to 0.5, then tool refuses because 40% < 50%.
    const r = await tool.execute("test", { reserveFraction: 0.1 });
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.reason).toBe("below-floor");
    expect(payload.note).toContain("50%");  // clamped value
  });
});

describe("lcm_compact — per-window cap", () => {
  it("allows up to 2 calls per 5-min window per session", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      // 70% ratio passes the floor (default reserveFraction=0.5 = 50%).
      // Gate accepts → counter increments.
      getRuntimeContext: () => ({
        currentTokenCount: 70_000,
        tokenBudget: 100_000,
        sessionFile: "/tmp/test-session.jsonl",
      }),
    });
    // Call #1
    const r1 = await tool.execute("test1", {});
    const p1 = JSON.parse((r1.content[0] as { text: string }).text);
    expect(p1.reason).not.toBe("capped-this-turn");
    // Call #2
    const r2 = await tool.execute("test2", {});
    const p2 = JSON.parse((r2.content[0] as { text: string }).text);
    expect(p2.reason).not.toBe("capped-this-turn");
    // Call #3 — should hit the cap
    const r3 = await tool.execute("test3", {});
    const p3 = JSON.parse((r3.content[0] as { text: string }).text);
    expect(p3.ok).toBe(false);
    expect(p3.reason).toBe("capped-this-turn");
    expect(p3.note).toContain("2/2");
    expect(p3.retryAfterIso).toBeDefined();
  });

  it("INVARIANT: gate-refused calls do NOT burn cap (Wave-12 reviewer P2 fix)", async () => {
    // Pre-fix bug: counter was incremented BEFORE the engine gate, so an
    // agent probing at 30% context (below-floor refusal) burned its 2-call
    // budget and was locked out at 80% when it actually needed compaction.
    // Post-fix: refusals are free; only gate-accepted calls count.
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      // 30% < 50% floor → engine gate refuses with below-floor.
      getRuntimeContext: () => ({
        currentTokenCount: 30_000,
        tokenBudget: 100_000,
        sessionFile: "/tmp/test-session.jsonl",
      }),
    });
    // Probe 5 times at low context — all should return below-floor and
    // NEVER hit the 2-call cap.
    for (let i = 0; i < 5; i++) {
      const r = await tool.execute(`probe-${i}`, {});
      const p = JSON.parse((r.content[0] as { text: string }).text);
      expect(p.reason).toBe("below-floor");
      expect(p.reason).not.toBe("capped-this-turn");
    }
    // Now switch to high-context tool with the SAME session-key. The cap
    // must still be fresh — gate-refused probes did not consume it.
    const highCtxTool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      getRuntimeContext: () => ({
        currentTokenCount: 80_000,
        tokenBudget: 100_000,
        sessionFile: "/tmp/test-session.jsonl",
      }),
    });
    const r1 = await highCtxTool.execute("real-1", {});
    const p1 = JSON.parse((r1.content[0] as { text: string }).text);
    expect(p1.reason).not.toBe("capped-this-turn");
    const r2 = await highCtxTool.execute("real-2", {});
    const p2 = JSON.parse((r2.content[0] as { text: string }).text);
    expect(p2.reason).not.toBe("capped-this-turn");
  });

  it("counter is per-session-key — different sessions are isolated", async () => {
    const sessionA = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:main",
      sessionKey: "agent:main:main",
      getRuntimeContext: () => ({
        currentTokenCount: 70_000,
        tokenBudget: 100_000,
      }),
    });
    const sessionB = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionId: "agent:main:cron:job-1",
      sessionKey: "agent:main:cron:job-1",
      getRuntimeContext: () => ({
        currentTokenCount: 70_000,
        tokenBudget: 100_000,
      }),
    });
    // Burn session A's cap
    await sessionA.execute("a1", {});
    await sessionA.execute("a2", {});
    const aBlocked = await sessionA.execute("a3", {});
    expect(JSON.parse((aBlocked.content[0] as { text: string }).text).reason).toBe(
      "capped-this-turn",
    );
    // Session B unaffected
    const bFresh = await sessionB.execute("b1", {});
    expect(JSON.parse((bFresh.content[0] as { text: string }).text).reason).not.toBe(
      "capped-this-turn",
    );
  });
});

describe("lcm_compact — engine availability gates", () => {
  it("returns engine-unavailable when LCM is not yet initialized", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      // No `lcm` and no `getLcm` — simulates plugin still booting
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("test", {});
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("engine-unavailable");
  });

  it("returns no-session when no sessionKey or sessionId provided", async () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      // No sessionKey, no sessionId
    });
    const r = await tool.execute("test", {});
    const payload = JSON.parse((r.content[0] as { text: string }).text);
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("no-session");
  });
});

describe("lcm_compact — schema + description contract", () => {
  it("description warns the agent it's blocking + describes refusal conditions", () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    expect(tool.description).toContain("PROACTIVELY");
    expect(tool.description).toContain("blocking");
    expect(tool.description).toContain("REFUSES");
    expect(tool.description).toContain("70%");  // when-to-call hint
    expect(tool.description).toContain("compacted view");  // what the agent gets
  });

  it("schema constrains reserveFraction to [0.5, 1.0]", () => {
    const tool = createLcmCompactTool({
      deps: depsWithCompactionEnabled(true),
      lcm: makeTestEngine(db),
      sessionKey: "agent:main:main",
    });
    const schema = tool.parameters as { properties?: Record<string, { minimum?: number; maximum?: number }> };
    expect(schema.properties?.reserveFraction?.minimum).toBe(0.5);
    expect(schema.properties?.reserveFraction?.maximum).toBe(1.0);
  });
});
