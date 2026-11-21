// Host-bound disclosure on automatic context assembly: derived history is
// assembled only while the host still authorizes the session's conversation.
import { afterEach, describe, expect, it } from "vitest";
import type { LcmDisclosureCapability } from "../src/disclosure.js";
import type { AgentMessage } from "../src/openclaw-bridge.js";
import { cleanupEngineTestState, createEngine } from "./helpers.js";

afterEach(cleanupEngineTestState);

const SESSION_ID = "disclosure-assemble-runtime";
const SESSION_KEY = "agent:main:telegram:direct:alice";

async function seed() {
  const engine = createEngine();
  for (const [role, content] of [
    ["user", "STORED-USER-TEXT earlier question"],
    ["assistant", "STORED-ASSISTANT-TEXT earlier answer"],
  ] as const) {
    await engine.ingest({
      sessionId: SESSION_ID,
      sessionKey: SESSION_KEY,
      message: { role, content } as AgentMessage,
    });
  }
  return engine;
}

function capability(decide: () => boolean): LcmDisclosureCapability {
  return {
    version: 1,
    requesterId: "person:alice",
    audienceId: "audience:dm-alice",
    authorizeConversations: (targets) => targets.map(() => decide()),
  };
}

const assembleParams = {
  sessionId: SESSION_ID,
  sessionKey: SESSION_KEY,
  messages: [] as AgentMessage[],
  tokenBudget: 10_000,
};

describe("assemble() under a host disclosure capability", () => {
  it("assembles stored history while the capability authorizes the conversation", async () => {
    const engine = await seed();
    const baseline = await engine.assemble(assembleParams);
    expect(JSON.stringify(baseline.messages)).toContain("STORED-USER-TEXT");

    const gated = await engine.assemble({
      ...assembleParams,
      runtimeContext: { hostDisclosure: capability(() => true) },
    });
    expect(JSON.stringify(gated.messages)).toContain("STORED-USER-TEXT");
  });

  it("omits stored history for a denied audience without deleting it", async () => {
    const engine = await seed();
    const denied = await engine.assemble({
      ...assembleParams,
      hostDisclosure: capability(() => false),
    });
    expect(JSON.stringify(denied.messages)).not.toContain("STORED-");

    // Lossless: the rows are still there for an authorized audience.
    const later = await engine.assemble(assembleParams);
    expect(JSON.stringify(later.messages)).toContain("STORED-USER-TEXT");
  });

  it("denies a malformed or throwing capability instead of falling open", async () => {
    const engine = await seed();
    for (const hostDisclosure of [
      {},
      { ...capability(() => true), requesterId: "" },
      { ...capability(() => true), authorizeConversations: () => { throw new Error("down"); } },
    ]) {
      const result = await engine.assemble({ ...assembleParams, hostDisclosure });
      expect(JSON.stringify(result.messages)).not.toContain("STORED-");
    }
  });

  it("does not release assembled context when authority is revoked during assembly", async () => {
    const engine = await seed();
    let calls = 0;
    const result = await engine.assemble({
      ...assembleParams,
      // First check (before assembly) passes; the release re-check denies.
      hostDisclosure: capability(() => ++calls === 1),
    });
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(result.messages)).not.toContain("STORED-");
  });
});
