import { describe, expect, it, vi } from "vitest";
import { resolveLcmConfig } from "../src/db/config.js";
import { __focusBriefTesting, runDelegatedFocusBrief } from "../src/focus-briefs.js";
import type { ActiveFocusSummaryRecord } from "../src/store/focus-brief-store.js";
import type { LcmDependencies } from "../src/types.js";

function createDeps(
  callGateway: LcmDependencies["callGateway"],
  configInput: Record<string, unknown> = {},
): LcmDependencies {
  return {
    config: resolveLcmConfig({}, { dbPath: ":memory:", ...configInput }),
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

function evidenceReply(): string {
  return JSON.stringify({
    evidenceMarkdown: [
      "## Evidence Dossier",
      "- summary_focus_a contains alpha review state.",
      "## Relevant Recent Context",
      "- The newest alpha review summary is summary_focus_a.",
    ].join("\n"),
    citedSummaryIds: ["summary_focus_a"],
    expandedSummaryIds: ["summary_focus_a"],
    irrelevantSummaryIds: [],
    expansionPrompts: [{ prompt: "Recover alpha review details.", summaryIds: ["summary_focus_a"] }],
    confidenceNotes: ["Expanded summary_focus_a."],
    truncated: false,
  });
}

describe("focus brief generation", () => {
  it("builds an evidence prompt that requires direct delegated recall tools", () => {
    const prompt = __focusBriefTesting.buildFocusEvidenceTask({
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
    expect(prompt).toContain("Target brief length for the later synthesis turn: 7200-12000 tokens");
    expect(prompt).toContain("This is not the final brief");
    expect(prompt).toContain("Prefer dense, specific working memory");
    expect(prompt).toContain("Relevant Recent Context");
    expect(prompt).toContain("newest summaries that pertain to the focus prompt");
    expect(prompt).toContain("summary_focus_a");
    expect(prompt).toContain('"evidenceMarkdown"');
  });

  it("builds a synthesis prompt from the evidence dossier", () => {
    const prompt = __focusBriefTesting.buildFocusSynthesisTask({
      focusPrompt: "alpha review",
      evidenceMarkdown: "## Evidence Dossier\n- summary_focus_a has alpha details.",
      targetTokens: 12_000,
    });

    expect(prompt).toContain("Synthesize the final Lossless focus context brief");
    expect(prompt).toContain("Target brief length: 7200-12000 tokens");
    expect(prompt).toContain("Relevant Recent Context");
    expect(prompt).toContain('"briefMarkdown"');
    expect(prompt).toContain("summary_focus_a has alpha details");
  });

  it("targets a much larger brief than the active summary token total", () => {
    expect(__focusBriefTesting.resolveFocusTargetTokens(1200)).toBe(12_000);
    expect(__focusBriefTesting.resolveFocusTargetTokens(3000)).toBe(12_000);
    expect(__focusBriefTesting.resolveFocusMinimumTokens(12_000)).toBe(7200);
  });

  it("derives a timeout for 12k focus briefs", () => {
    expect(
      __focusBriefTesting.resolveFocusDelegationTimeoutMs({
        configuredTimeoutMs: 120_000,
        targetTokens: 12_000,
      }),
    ).toBe(600_000);
    expect(
      __focusBriefTesting.resolveFocusDelegationTimeoutMs({
        configuredTimeoutMs: 300_000,
        targetTokens: 12_000,
      }),
    ).toBe(600_000);
    expect(
      __focusBriefTesting.resolveFocusDelegationTimeoutMs({
        configuredTimeoutMs: 660_000,
        targetTokens: 12_000,
      }),
    ).toBe(660_000);
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

  it("parses evidence JSON replies from the delegated subagent", () => {
    const parsed = __focusBriefTesting.parseFocusEvidenceReply(evidenceReply());

    expect(parsed).toMatchObject({
      evidenceMarkdown: expect.stringContaining("summary_focus_a"),
      citedSummaryIds: ["summary_focus_a"],
      expandedSummaryIds: ["summary_focus_a"],
      truncated: false,
    });
    expect(parsed.expansionPrompts).toEqual([
      { prompt: "Recover alpha review details.", summaryIds: ["summary_focus_a"] },
    ]);
  });

  it("uses the configured summary model for focus subagent turns", async () => {
    const agentParams: Array<Record<string, unknown>> = [];
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        agentParams.push(request.params ?? {});
        return { runId: `focus-run-${agentParams.length}` };
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
              content:
                sessionReads === 1
                  ? evidenceReply()
                  : JSON.stringify({
                      briefMarkdown: longBrief(),
                      citedSummaryIds: ["summary_focus_a"],
                      expandedSummaryIds: ["summary_focus_a"],
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
      deps: createDeps(callGateway as LcmDependencies["callGateway"], {
        summaryProvider: "openai",
        summaryModel: "gpt-5.5",
        expansionProvider: "openrouter",
        expansionModel: "anthropic/claude-haiku-4-5",
      }),
      requesterSessionKey: "agent:main:telegram:direct:origin",
      conversationId: 42,
      focusPrompt: "alpha review",
      summaries: activeSummaries,
    });

    expect(result.status).toBe("ok");
    expect(agentParams).toHaveLength(2);
    for (const params of agentParams) {
      expect(params.provider).toBe("openai");
      expect(params.model).toBe("gpt-5.5");
    }
  });

  it("does not override the conversation model when no summary model is configured", async () => {
    const agentParams: Array<Record<string, unknown>> = [];
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        agentParams.push(request.params ?? {});
        return { runId: `focus-run-${agentParams.length}` };
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
              content:
                sessionReads === 1
                  ? evidenceReply()
                  : JSON.stringify({
                      briefMarkdown: longBrief(),
                      citedSummaryIds: ["summary_focus_a"],
                      expandedSummaryIds: ["summary_focus_a"],
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
      deps: createDeps(callGateway as LcmDependencies["callGateway"], {
        summaryProvider: "openai",
        expansionProvider: "openrouter",
        expansionModel: "anthropic/claude-haiku-4-5",
      }),
      requesterSessionKey: "agent:main:telegram:direct:origin",
      conversationId: 42,
      focusPrompt: "alpha review",
      summaries: activeSummaries,
    });

    expect(result.status).toBe("ok");
    expect(agentParams).toHaveLength(2);
    for (const params of agentParams) {
      expect(params).not.toHaveProperty("provider");
      expect(params).not.toHaveProperty("model");
    }
  });

  it("spawns evidence and synthesis turns, waits, reads, and cleans up a focus subagent", async () => {
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        expect(request.params?.sessionKey).toMatch(/^agent:main:subagent:/);
        expect(request.params?.lane).toBe("subagent");
        expect(String(request.params?.message)).toContain("alpha review");
        return { runId: `focus-run-${callGateway.mock.calls.filter((call) => call[0].method === "agent").length}` };
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
              content:
                sessionReads === 1
                  ? evidenceReply()
                  : JSON.stringify({
                      briefMarkdown: longBrief(),
                      citedSummaryIds: ["summary_focus_a"],
                      expandedSummaryIds: ["summary_focus_a"],
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
      runId: "focus-run-2",
      citedSummaryIds: ["summary_focus_a"],
      truncated: false,
    });
    expect(result.briefMarkdown).toContain("Alpha detail");
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
    expect(callGateway.mock.calls.at(-1)?.[0].params).toMatchObject({
      key: result.childSessionKey,
      deleteTranscript: false,
    });
  });

  it("keeps a generated focus brief usable when the first brief is too short", async () => {
    let agentRuns = 0;
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        agentRuns += 1;
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
                ...(sessionReads === 1
                  ? {
                      evidenceMarkdown: "## Evidence Dossier\n- summary_focus_a has alpha details.",
                      citedSummaryIds: ["summary_focus_a"],
                      expandedSummaryIds: ["summary_focus_a"],
                      irrelevantSummaryIds: [],
                      expansionPrompts: [],
                      confidenceNotes: ["direct context"],
                      truncated: false,
                    }
                  : {
                      briefMarkdown: "## Focused Narrative\nToo short.",
                      citedSummaryIds: ["summary_focus_a"],
                      expandedSummaryIds: ["summary_focus_a"],
                      irrelevantSummaryIds: [],
                      expansionPrompts: [],
                      confidenceNotes: ["direct context"],
                      truncated: false,
                    }),
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
    expect(result.briefMarkdown).toContain("Too short.");
    expect(result.expandedSummaryIds).toEqual(["summary_focus_a"]);
    expect(result.tokenCount).toBeLessThan(7200);
    expect(result.warning).toBe("Focus brief is shorter than the requested 7200-token minimum.");
    expect(JSON.parse(result.rawResultJson ?? "{}")).toMatchObject({
      warning: "Focus brief is shorter than the requested 7200-token minimum.",
    });
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

  it("fails immediately when focus subagent launch returns no run id", async () => {
    const callGateway = vi.fn(async (request: { method: string }) => {
      if (request.method === "agent") {
        return { error: { message: "subagent launch failed" } };
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

    expect(result.status).toBe("error");
    expect(result.runId).toBe("");
    expect(result.error).toBe("subagent launch failed");
    expect(callGateway.mock.calls.map((call) => call[0].method)).toEqual([
      "agent",
      "sessions.delete",
    ]);
  });

  it("preserves evidence-phase truncation in persisted result JSON", async () => {
    let sessionReads = 0;
    const callGateway = vi.fn(async (request: { method: string; params?: Record<string, unknown> }) => {
      if (request.method === "agent") {
        return { runId: `focus-run-${callGateway.mock.calls.filter((call) => call[0].method === "agent").length}` };
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
              content:
                sessionReads === 1
                  ? JSON.stringify({
                      evidenceMarkdown: "## Evidence Dossier\n- summary_focus_a has alpha details.",
                      citedSummaryIds: ["summary_focus_a"],
                      expandedSummaryIds: ["summary_focus_a"],
                      irrelevantSummaryIds: [],
                      expansionPrompts: [],
                      confidenceNotes: ["evidence was truncated"],
                      truncated: true,
                    })
                  : JSON.stringify({
                      briefMarkdown: longBrief(),
                      citedSummaryIds: ["summary_focus_a"],
                      expandedSummaryIds: ["summary_focus_a"],
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
    expect(result.truncated).toBe(true);
    expect(JSON.parse(result.rawResultJson ?? "{}")).toMatchObject({
      truncated: true,
    });
  });
});
