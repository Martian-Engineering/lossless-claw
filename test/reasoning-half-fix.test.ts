import { describe, expect, it, vi } from "vitest";

import { extractMeaningfulMessageText } from "../src/compaction.js";
import {
  createLcmSummarizeFromLegacyParams,
  type LcmSummarizeFn,
} from "../src/summarize.js";
import type { LcmDependencies } from "../src/types.js";

// ---------------------------------------------------------------------------
// PR-4 (#564) — completing the reasoning half-fix from #503.
//
// Three sub-fixes are exercised here:
//   B2 — `extractMeaningfulMessageText` is now applied at every summarizer
//        entry point (leaf, condensed, prior-summary context).  The unit
//        suite below confirms it strips the structured reasoning shapes
//        observed in the wild from #471 / #542 / #547.
//   B1 — When a provider returns reasoning-shaped text as the summary body,
//        the summarize path now detects the leak, drops the summary, and
//        defers to the existing retry → deterministic-fallback chain
//        instead of persisting reasoning text verbatim as a summary.
// ---------------------------------------------------------------------------

describe("extractMeaningfulMessageText (B2: shared sanitizer)", () => {
  it("returns plain prose unchanged", () => {
    expect(extractMeaningfulMessageText("User asked about deploys.")).toBe(
      "User asked about deploys.",
    );
  });

  it("strips a single thinking block from a structured content array", () => {
    const content = JSON.stringify([
      { type: "thinking", thinking: "Let me plan the answer first." },
      { type: "text", text: "User confirmed the deploy went out." },
    ]);

    expect(extractMeaningfulMessageText(content)).toBe(
      "User confirmed the deploy went out.",
    );
  });

  it("strips reasoning blocks from the structured content array", () => {
    const content = JSON.stringify([
      { type: "reasoning", text: "Internal reasoning that must not leak." },
      { type: "text", text: "Answer: ship the patch." },
    ]);

    expect(extractMeaningfulMessageText(content)).toBe("Answer: ship the patch.");
  });

  it("strips redacted_thinking blocks (Anthropic encrypted reasoning shape)", () => {
    const content = JSON.stringify([
      {
        type: "redacted_thinking",
        data: "ENCRYPTED:abc123==",
      },
      { type: "text", text: "Customer wants weekly digest." },
    ]);

    expect(extractMeaningfulMessageText(content)).toBe(
      "Customer wants weekly digest.",
    );
  });

  it("returns empty when content is only thinking blocks", () => {
    const content = JSON.stringify([
      { type: "thinking", thinking: "Plan first." },
      { type: "reasoning", text: "More planning." },
    ]);

    expect(extractMeaningfulMessageText(content)).toBe("");
  });

  it("strips reasoning when nested inside a message wrapper", () => {
    // Shape mirrors the legacy assistant rows referenced in #564 where a
    // pre-#503 client wrote the entire message envelope into the content
    // column instead of just the text payload.
    const content = JSON.stringify({
      message: {
        content: [
          { type: "thinking", thinking: "Should I cite the doc?" },
          { type: "text", text: "Yes — see runbook §3." },
        ],
      },
    });

    expect(extractMeaningfulMessageText(content)).toBe("Yes — see runbook §3.");
  });

  it("does not apply structured handling to non-JSON strings", () => {
    expect(
      extractMeaningfulMessageText("Just a plain log line about reasoning."),
    ).toBe("Just a plain log line about reasoning.");
  });
});

// ---------------------------------------------------------------------------
// B1 — Output-side reasoning-leak guardrail.
//
// Reasoning-capable summary models (vLLM+Qwen3 per #471, Kimi K2.6 per #542)
// have been observed to emit reasoning text that survives the per-block
// type filter — typically wrapped in `<think>…</think>` tags.  The new
// guardrail detects those shapes and forces the empty-summary path so the
// retry / deterministic fallback runs instead of silently persisting the
// reasoning string as the summary body.
// ---------------------------------------------------------------------------

async function createSummarizeFn(
  params: Parameters<typeof createLcmSummarizeFromLegacyParams>[0],
): Promise<LcmSummarizeFn | undefined> {
  const result = await createLcmSummarizeFromLegacyParams(params);
  return result?.fn;
}

function makeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "fallback" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({
      provider: "openrouter",
      model: "qwen/qwen3-235b",
    })),
    getApiKey: vi.fn(async () => "test-api-key"),
    requireApiKey: vi.fn(async () => "test-api-key"),
    parseAgentSessionKey: vi.fn(() => null),
    isSubagentSessionKey: vi.fn(() => false),
    normalizeAgentId: vi.fn(() => "main"),
    buildSubagentSystemPrompt: vi.fn(() => ""),
    readLatestAssistantReply: vi.fn(() => undefined),
    resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
    resolveSessionIdFromSessionKey: vi.fn(async () => undefined),
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  } as LcmDependencies;
}

function getDepsLogText(deps: LcmDependencies): string {
  const calls = [
    ...(deps.log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    ...(deps.log.error as unknown as { mock: { calls: unknown[][] } }).mock.calls,
    ...(deps.log.info as unknown as { mock: { calls: unknown[][] } }).mock.calls,
  ];
  return calls.flatMap((call) => call.map((entry) => String(entry))).join(" ");
}

describe("createLcmSummarizeFromLegacyParams (B1: reasoning-leak guardrail)", () => {
  it("drops a <think>-wrapped summary and retries instead of persisting it", async () => {
    let callCount = 0;
    const deps = makeDeps({
      complete: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          // Initial call: provider leaks reasoning as the summary body.
          return {
            content: [
              {
                type: "text",
                text: "<think>The user wants a digest of the conversation.</think>",
              },
            ],
          };
        }
        // Retry: provider returns a clean summary.
        return {
          content: [{ type: "text", text: "Recovered clean summary." }],
        };
      }),
    });

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: { provider: "openrouter", model: "qwen/qwen3-235b" },
    });
    const summary = await summarize!("Source text to summarize.", false);

    expect(summary).toBe("Recovered clean summary.");
    expect(callCount).toBe(2);
    const diagnostics = getDepsLogText(deps);
    expect(diagnostics).toContain("dropped reasoning-shaped summary on first attempt");
  });

  it("falls back to deterministic truncation when retry also returns reasoning text", async () => {
    let callCount = 0;
    const deps = makeDeps({
      complete: vi.fn(async () => {
        callCount += 1;
        return {
          content: [
            {
              type: "text",
              // Both passes leak reasoning — guardrail must engage on retry too.
              text: callCount === 1
                ? "<think>plan first</think>"
                : "<thinking>retry plan</thinking>",
            },
          ],
        };
      }),
    });

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: { provider: "openrouter", model: "qwen/qwen3-235b" },
    });
    const summary = await summarize!("D".repeat(4_000), false);

    // Must NOT silently persist the reasoning text as the summary body.
    expect(summary).not.toContain("<think>");
    expect(summary).not.toContain("<thinking>");
    expect(summary).not.toContain("plan first");
    expect(summary).toContain("[LCM fallback summary; truncated for context management]");

    expect(callCount).toBe(2);
    const diagnostics = getDepsLogText(deps);
    expect(diagnostics).toContain("dropped reasoning-shaped summary on first attempt");
    expect(diagnostics).toContain("dropped reasoning-shaped summary on retry");
  });

  it("treats a [thinking]-prefixed summary as a reasoning leak", async () => {
    let callCount = 0;
    const deps = makeDeps({
      complete: vi.fn(async () => {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: [{ type: "text", text: "[thinking] Analyse the source then answer." }],
          };
        }
        return {
          content: [{ type: "text", text: "Clean summary on retry." }],
        };
      }),
    });

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: { provider: "openrouter", model: "qwen/qwen3-235b" },
    });
    const summary = await summarize!("Source text.", false);

    expect(summary).toBe("Clean summary on retry.");
    expect(callCount).toBe(2);
  });

  it("does not drop a clean summary that merely mentions the word 'reasoning'", async () => {
    const deps = makeDeps({
      complete: vi.fn(async () => ({
        content: [
          {
            type: "text",
            text: "User asked about reasoning models and how thinking budgets work.",
          },
        ],
      })),
    });

    const summarize = await createSummarizeFn({
      deps,
      legacyParams: { provider: "openrouter", model: "qwen/qwen3-235b" },
    });
    const summary = await summarize!("Source text.", false);

    expect(summary).toBe(
      "User asked about reasoning models and how thinking budgets work.",
    );
    expect(deps.complete).toHaveBeenCalledTimes(1);
  });
});
