import { describe, expect, it, vi } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import { __focusBriefTesting, runDelegatedFocusBrief } from "../src/focus-briefs.js";
import type { ActiveFocusSummaryRecord } from "../src/store/focus-brief-store.js";
import type { LcmDependencies } from "../src/types.js";

function createDeps(callGateway: LcmDependencies["callGateway"]): LcmDependencies {
  return {
    config: resolveLcmConfig({}, { dbPath: ":memory:" }),
    complete: vi.fn(),
    callGateway,
    resolveModel: () => ({ provider: "test", model: "test-model" }),
    parseAgentSessionKey: (key: string) => {
      const match = /^agent:([^:]+):(.*)$/.exec(key);
      return match ? { agentId: match[1] ?? "main", suffix: match[2] ?? "" } : null;
    },
    isSubagentSessionKey: (key: string) => key.includes(":subagent:"),
    normalizeAgentId: (id?: string) => id?.trim() || "main",
    buildSubagentSystemPrompt: ({ taskSummary }) => `system: ${taskSummary ?? ""}`,
    readLatestAssistantReply: (messages: unknown[]) => {
      const latest = messages.at(-1) as { content?: unknown } | undefined;
      return typeof latest?.content === "string" ? latest.content : undefined;
    },
    resolveAgentDir: () => "/tmp",
    resolveSessionIdFromSessionKey: async () => undefined,
    resolveSessionTranscriptFile: async () => undefined,
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as LcmDependencies;
}

const activeSummaries: ActiveFocusSummaryRecord[] = [
  {
    ordinal: 0,
    summaryId: "summary_focus_a",
    kind: "condensed",
    depth: 1,
    tokenCount: 1200,
    createdAt: "2026-05-16T00:00:00.000Z",
    latestAt: "2026-05-16T00:01:00.000Z",
    content: "Focused alpha work, source decisions, and pending review state.",
  },
];

function longBrief(label = "Alpha detail"): string {
  return `## Focused Narrative\n${`${label}. `.repeat(8_000)}`;
}

describe("focus brief generation", () => {
  it("builds a prompt that requires direct delegated recall tools", () => {
    const prompt = __focusBriefTesting.buildFocusBriefTask({
      focusPrompt: "alpha review",
      conversationId: 42,
      summaries: activeSummaries,
      targetTokens: 12_000,
      requestId: "request-one",
      originSessionKey: "agent:main:telegram:direct:origin",
    });

    expect(prompt).toContain("Use lcm_grep");
    expect(prompt).toContain("Use lcm_describe");
    expect(prompt).toContain("Use lcm_expand directly");
    expect(prompt).toContain("do NOT call lcm_expand_query");
    expect(prompt).toContain("Target brief length: 7200-12000 tokens");
    expect(prompt).toContain("This is not a concise summary");
    expect(prompt).toContain("Use the available budget aggressively");
    expect(prompt).toContain("summary_focus_a");
    expect(prompt).toContain('"briefMarkdown"');
  });

  it("targets a much larger brief than the active summary token total", () => {
    expect(__focusBriefTesting.resolveFocusTargetTokens(1200)).toBe(12_000);
    expect(__focusBriefTesting.resolveFocusTargetTokens(3000)).toBe(30_000);
    expect(__focusBriefTesting.resolveFocusMinimumTokens(12_000)).toBe(7200);
  });

  it("parses fenced JSON replies from the delegated subagent", () => {
    const parsed = __focusBriefTesting.parseFocusBriefReply(
      [
        "```json",
        JSON.stringify({
          briefMarkdown: "## Focused Narrative\nAlpha",
          citedSummaryIds: ["summary_focus_a", "summary_focus_a", ""],
          expandedSummaryIds: ["summary_leaf"],
          irrelevantSummaryIds: [42, "summary_other"],
          expansionPrompts: [{ prompt: "Recover alpha details.", summaryIds: ["summary_focus_a"] }],
          confidenceNotes: ["expanded summary_leaf"],
          truncated: true,
        }),
        "```",
      ].join("\n"),
    );

    expect(parsed).toMatchObject({
      briefMarkdown: "## Focused Narrative\nAlpha",
      citedSummaryIds: ["summary_focus_a"],
      expandedSummaryIds: ["summary_leaf"],
      irrelevantSummaryIds: ["summary_other"],
      truncated: true,
    });
    expect(parsed.expansionPrompts).toEqual([
      { prompt: "Recover alpha details.", summaryIds: ["summary_focus_a"] },
    ]);
  });

  it("spawns, waits, reads, and cleans up a focus subagent", async () => {
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        expect(request.params?.sessionKey).toMatch(/^agent:main:subagent:/);
        expect(request.params?.lane).toBe("subagent");
        expect(String(request.params?.message)).toContain("alpha review");
        return { runId: "focus-run-ok" };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        return {
          messages: [
            {
              role: "assistant",
              content: JSON.stringify({
                briefMarkdown: longBrief(),
                citedSummaryIds: ["summary_focus_a"],
                expandedSummaryIds: [],
                irrelevantSummaryIds: [],
                expansionPrompts: [],
                confidenceNotes: ["direct context"],
                truncated: false,
              }),
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      throw new Error(`unexpected gateway method ${request.method}`);
    });

    const result = await runDelegatedFocusBrief({
      deps: createDeps(callGateway as LcmDependencies["callGateway"]),
      requesterSessionKey: "agent:main:telegram:direct:origin",
      conversationId: 42,
      focusPrompt: "alpha review",
      summaries: activeSummaries,
    });

    expect(result).toMatchObject({
      status: "ok",
      runId: "focus-run-ok",
      citedSummaryIds: ["summary_focus_a"],
      truncated: false,
    });
    expect(result.briefMarkdown).toContain("Alpha detail");
    expect(result.tokenCount).toBeGreaterThanOrEqual(7200);
    expect(callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "agent",
      "agent.wait",
      "sessions.get",
      "sessions.delete",
    ]);
  });

  it("retries in the same child session when the first brief is too short", async () => {
    let agentRuns = 0;
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        agentRuns += 1;
        if (agentRuns === 2) {
          expect(String(request.params?.message)).toContain("previous focus brief was too short");
          expect(String(request.params?.message)).toContain("Required minimum length: 7200 tokens");
        }
        return { runId: `focus-run-${agentRuns}` };
      }
      if (request.method === "agent.wait") {
        return { status: "ok" };
      }
      if (request.method === "sessions.get") {
        sessionReads += 1;
        return {
          messages: [
            {
              role: "assistant",
              content: JSON.stringify({
                briefMarkdown:
                  sessionReads === 1
                    ? "## Focused Narrative\nToo short."
                    : longBrief("Expanded alpha detail"),
                citedSummaryIds: ["summary_focus_a"],
                expandedSummaryIds: sessionReads === 1 ? [] : ["summary_focus_a"],
                irrelevantSummaryIds: [],
                expansionPrompts: [],
                confidenceNotes: ["direct context"],
                truncated: false,
              }),
            },
          ],
        };
      }
      if (request.method === "sessions.delete") {
        return { ok: true };
      }
      throw new Error(`unexpected gateway method ${request.method}`);
    });

    const result = await runDelegatedFocusBrief({
      deps: createDeps(callGateway as LcmDependencies["callGateway"]),
      requesterSessionKey: "agent:main:telegram:direct:origin",
      conversationId: 42,
      focusPrompt: "alpha review",
      summaries: activeSummaries,
    });

    expect(result.status).toBe("ok");
    expect(result.runId).toBe("focus-run-2");
    expect(result.briefMarkdown).toContain("Expanded alpha detail");
    expect(result.expandedSummaryIds).toEqual(["summary_focus_a"]);
    expect(result.tokenCount).toBeGreaterThanOrEqual(7200);
    expect(callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "agent",
      "agent.wait",
      "sessions.get",
      "agent",
      "agent.wait",
      "sessions.get",
      "sessions.delete",
    ]);
  });
});
