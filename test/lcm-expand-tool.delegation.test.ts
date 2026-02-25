import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetDelegatedExpansionGrantsForTests } from "../src/expansion-auth.js";
import {
  getExpansionDelegationTelemetrySnapshotForTests,
  resetExpansionDelegationGuardForTests,
  stampDelegatedExpansionContext,
} from "../src/tools/lcm-expansion-recursion-guard.js";
import { runDelegatedExpansionLoop } from "../src/tools/lcm-expand-tool.delegation.js";
import type { LcmDependencies } from "../src/types.js";

const callGatewayMock = vi.fn();

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) {
    return null;
  }
  const parts = trimmed.split(":");
  if (parts.length < 3) {
    return null;
  }
  return {
    agentId: parts[1] ?? "main",
    suffix: parts.slice(2).join(":"),
  };
}

function readLatestAssistantReply(messages: unknown[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") {
      continue;
    }
    if (typeof message.content === "string") {
      return message.content;
    }
    if (!Array.isArray(message.content)) {
      continue;
    }
    const text = message.content
      .map((entry) => {
        const block = entry as { type?: unknown; text?: unknown };
        return block.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return undefined;
}

function makeDeps() {
  const logInfo = vi.fn();
  const logWarn = vi.fn();
  const deps: Pick<
    LcmDependencies,
    | "callGateway"
    | "parseAgentSessionKey"
    | "normalizeAgentId"
    | "buildSubagentSystemPrompt"
    | "readLatestAssistantReply"
    | "agentLaneSubagent"
    | "log"
  > = {
    callGateway: (params: { method: string; params?: Record<string, unknown> }) =>
      callGatewayMock(params),
    parseAgentSessionKey,
    normalizeAgentId: (id?: string) => id?.trim() || "main",
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply,
    agentLaneSubagent: "subagent",
    log: {
      info: logInfo,
      warn: logWarn,
      error: vi.fn(),
      debug: vi.fn(),
    },
  };
  return { deps, logInfo, logWarn };
}

describe("runDelegatedExpansionLoop recursion guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    callGatewayMock.mockReset();
    resetDelegatedExpansionGrantsForTests();
    resetExpansionDelegationGuardForTests();
  });

  it("runs delegated expansion when not in delegated context", async () => {
    const { deps } = makeDeps();
    let lastAgentMessage = "";
    callGatewayMock.mockImplementation(async (opts: unknown) => {
      const request = opts as { method?: string; params?: Record<string, unknown> };
      if (request.method === "agent") {
        lastAgentMessage = String(request.params?.message ?? "");
        return { runId: "run-pass-1" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    summary: "Expansion succeeded.",
                    citedIds: ["sum_a"],
                    followUpSummaryIds: [],
                    totalTokens: 33,
                    truncated: false,
                  }),
                },
              ],
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      return {};
    });

    const result = await runDelegatedExpansionLoop({
      deps,
      requesterSessionKey: "agent:main:main",
      conversationId: 7,
      summaryIds: ["sum_a"],
      includeMessages: false,
    });

    expect(result.status).toBe("ok");
    expect(result.citedIds).toEqual(["sum_a"]);
    expect(lastAgentMessage).toContain("requestId");
    expect(lastAgentMessage).toContain("DO NOT call `lcm_expand_query` from this delegated session.");
    expect(lastAgentMessage).toContain("use `lcm_expand` directly");
    expect(getExpansionDelegationTelemetrySnapshotForTests()).toMatchObject({
      start: 1,
      block: 0,
      timeout: 0,
      success: 1,
    });
  });

  it("blocks delegated expansion helper re-entry at depth cap", async () => {
    const { deps } = makeDeps();
    stampDelegatedExpansionContext({
      sessionKey: "agent:main:subagent:blocked",
      requestId: "req-loop",
      expansionDepth: 1,
      originSessionKey: "agent:main:main",
      stampedBy: "test",
    });

    const result = await runDelegatedExpansionLoop({
      deps,
      requesterSessionKey: "agent:main:subagent:blocked",
      conversationId: 7,
      summaryIds: ["sum_a"],
      includeMessages: false,
      requestId: "req-loop",
    });

    expect(result.status).toBe("error");
    expect(result.error).toContain("EXPANSION_RECURSION_BLOCKED");
    expect(result.error).toContain(
      "Recovery: In delegated sub-agent sessions, call `lcm_expand` directly",
    );
    expect(result.error).toContain("Do NOT call `lcm_expand_query` from delegated context.");
    expect(callGatewayMock).not.toHaveBeenCalled();
    expect(getExpansionDelegationTelemetrySnapshotForTests()).toMatchObject({
      start: 1,
      block: 1,
      timeout: 0,
      success: 0,
    });
  });
});
