import { afterEach, describe, expect, it, vi } from "vitest";
import { createLcmSummarizeFromLegacyParams } from "../src/summarize.js";
import type { LcmDependencies } from "../src/types.js";

// Mirrors a live failure: the first call returns empty content (the host
// swallowed a dropped connection), and the host then refuses the immediate
// retry because one failure put the auth profile into a 30s cooldown.
const COOLDOWN_REFUSAL = {
  content: [],
  stopReason: "error",
  errorMessage:
    'Plugin LLM completion failed: Auth lookup failed for provider "openai": Auth profile "openai:default" is temporarily unavailable for openai/gpt-5.6-luna.',
};

function makeDeps(complete: LcmDependencies["complete"]): LcmDependencies {
  return {
    config: {
      summaryProvider: "",
      summaryModel: "",
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      summaryMaxOverageFactor: 3,
    },
    complete,
    resolveModel: vi.fn(() => ({ provider: "openai", model: "gpt-5.6-luna" })),
    resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as LcmDependencies;
}

async function makeSummarize(deps: LcmDependencies) {
  const result = await createLcmSummarizeFromLegacyParams({
    deps,
    legacyParams: { provider: "openai", model: "gpt-5.6-luna" },
  });
  return result!.fn;
}

function cooldownThenRecover() {
  let call = 0;
  return vi.fn(async () => {
    call += 1;
    if (call === 1) return { content: [] };
    if (call === 2) return COOLDOWN_REFUSAL;
    return { content: [{ type: "text", text: "Real summary after cooldown." }] };
  }) as unknown as LcmDependencies["complete"];
}

describe("provider error on the last candidate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("waits for a host cooldown to clear before one more attempt", async () => {
    const complete = cooldownThenRecover();
    const summarize = await makeSummarize(makeDeps(complete));

    vi.useFakeTimers();
    const pending = summarize("A".repeat(8_000), false, {
      abortSignal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    // Still inside the cooldown: no third call yet.
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);

    expect(await pending).toBe("Real summary after cooldown.");
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(3);
  });

  it("stops waiting and falls back at once when the host aborts", async () => {
    const complete = cooldownThenRecover();
    const deps = makeDeps(complete);
    const summarize = await makeSummarize(deps);
    const controller = new AbortController();

    vi.useFakeTimers();
    const pending = summarize("A".repeat(8_000), false, { abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(1_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const summary = await pending;

    expect(summary).toContain("[LCM fallback summary; truncated for context management]");
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait when a fallback candidate is configured", async () => {
    const complete = vi.fn(async ({ model }: { model?: string }) =>
      model === "gpt-5.6-luna"
        ? COOLDOWN_REFUSAL
        : { content: [{ type: "text", text: "Fallback model summary." }] },
    ) as unknown as LcmDependencies["complete"];
    const deps = makeDeps(complete);
    deps.config = {
      ...deps.config,
      fallbackProviders: [{ provider: "openai", model: "gpt-6-luna" }],
    } as typeof deps.config;
    deps.resolveModel = vi.fn((ref?: string) =>
      ref === "openai/gpt-6-luna"
        ? { provider: "openai", model: "gpt-6-luna" }
        : { provider: "openai", model: "gpt-5.6-luna" },
    ) as typeof deps.resolveModel;
    const summarize = await makeSummarize(deps);

    vi.useFakeTimers();
    const pending = summarize("A".repeat(8_000), false, {
      abortSignal: new AbortController().signal,
    });
    // Only the existing short fallback backoff, never the cooldown wait.
    await vi.advanceTimersByTimeAsync(1_000);

    expect(await pending).toBe("Fallback model summary.");
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
  });

  it("does not wait when the caller passed no abortSignal", async () => {
    // Foreground callers (for example assemble-time pressure relief) hold the
    // session queue and cannot be cancelled, so they keep failing fast.
    const complete = cooldownThenRecover();
    const summarize = await makeSummarize(makeDeps(complete));

    vi.useFakeTimers();
    const pending = summarize("A".repeat(8_000), false);
    await vi.advanceTimersByTimeAsync(0);
    const summary = await pending;

    expect(summary).toContain("[LCM fallback summary; truncated for context management]");
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not wait when the signal is already aborted", async () => {
    const complete = cooldownThenRecover();
    const summarize = await makeSummarize(makeDeps(complete));
    const controller = new AbortController();
    controller.abort();

    vi.useFakeTimers();
    const pending = summarize("A".repeat(8_000), false, { abortSignal: controller.signal });
    await vi.advanceTimersByTimeAsync(0);

    expect(await pending).toContain("[LCM fallback summary; truncated for context management]");
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(2);
  });

  it("waits at most once per summary", async () => {
    // initial: provider error -> wait -> empty content -> empty-summary retry:
    // provider error again. The second error must not wait again.
    let call = 0;
    const complete = vi.fn(async () => {
      call += 1;
      return call === 2 ? { content: [] } : COOLDOWN_REFUSAL;
    }) as unknown as LcmDependencies["complete"];
    const summarize = await makeSummarize(makeDeps(complete));

    vi.useFakeTimers();
    const pending = summarize("A".repeat(8_000), false, {
      abortSignal: new AbortController().signal,
    });
    await vi.advanceTimersByTimeAsync(35_000);
    const summary = await pending;

    expect(summary).toContain("[LCM fallback summary; truncated for context management]");
    expect(vi.mocked(complete)).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });
});
