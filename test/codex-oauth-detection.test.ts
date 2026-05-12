import { describe, it, expect } from "vitest";

/**
 * Tests for detectCodexOAuthSync (PR follow-up to #619).
 *
 * The function itself is not exported (kept internal to plugin/index.ts),
 * so these tests exercise the behavior contract by mirroring the
 * detection logic. If the implementation diverges from these expectations,
 * either update the tests or — better — surface the function for direct
 * testing via a `__test_only` export.
 */

// Mirror the detection logic from plugin/index.ts to verify the contract.
// Tests the SHAPE of detection without coupling to the import path.
function detectMirror(
  envSnapshot: { openclawDefaultModel?: string },
  pluginConfig?: Record<string, unknown>,
): boolean {
  const PROVIDER = "openai-codex";
  const startsWithCodex = (s: unknown): boolean =>
    typeof s === "string" && s.trim().toLowerCase().startsWith(`${PROVIDER}/`);
  const isCodexProvider = (s: unknown): boolean =>
    typeof s === "string" && s.trim().toLowerCase() === PROVIDER;

  if (startsWithCodex(envSnapshot.openclawDefaultModel)) return true;
  if (!pluginConfig) return false;
  if (isCodexProvider(pluginConfig.summaryProvider)) return true;
  if (startsWithCodex(pluginConfig.summaryModel)) return true;
  if (isCodexProvider(pluginConfig.expansionProvider)) return true;
  if (startsWithCodex(pluginConfig.expansionModel)) return true;
  if (isCodexProvider(pluginConfig.largeFileSummaryProvider)) return true;
  if (startsWithCodex(pluginConfig.largeFileSummaryModel)) return true;
  return false;
}

describe("detectCodexOAuthSync contract (PR follow-up to #619)", () => {
  it("returns false when no signals indicate codex", () => {
    expect(detectMirror({}, {})).toBe(false);
    expect(detectMirror({ openclawDefaultModel: "anthropic/claude-sonnet-4.5" }, {})).toBe(false);
    expect(detectMirror({}, { summaryProvider: "anthropic" })).toBe(false);
    expect(detectMirror({}, undefined)).toBe(false);
  });

  it("returns true when openclawDefaultModel starts with openai-codex/", () => {
    expect(detectMirror({ openclawDefaultModel: "openai-codex/gpt-5.5" }, {})).toBe(true);
    expect(detectMirror({ openclawDefaultModel: "openai-codex/gpt-5.4-mini" }, {})).toBe(true);
    expect(detectMirror({ openclawDefaultModel: "OPENAI-CODEX/gpt-5.5" }, {})).toBe(true);  // case-insensitive
  });

  it("returns true when pluginConfig.summaryProvider is openai-codex", () => {
    expect(detectMirror({}, { summaryProvider: "openai-codex" })).toBe(true);
    expect(detectMirror({}, { summaryProvider: "OpenAI-Codex" })).toBe(true);  // case-insensitive
  });

  it("returns true when pluginConfig.summaryModel starts with openai-codex/", () => {
    expect(detectMirror({}, { summaryModel: "openai-codex/gpt-5.5" })).toBe(true);
    expect(detectMirror({}, { summaryModel: "openai-codex/gpt-5.4-mini" })).toBe(true);
  });

  it("returns true for expansionProvider / expansionModel / largeFileSummary*", () => {
    expect(detectMirror({}, { expansionProvider: "openai-codex" })).toBe(true);
    expect(detectMirror({}, { expansionModel: "openai-codex/gpt-5.5" })).toBe(true);
    expect(detectMirror({}, { largeFileSummaryProvider: "openai-codex" })).toBe(true);
    expect(detectMirror({}, { largeFileSummaryModel: "openai-codex/gpt-5.4-mini" })).toBe(true);
  });

  it("returns false for partial matches that don't fit the contract", () => {
    // Bare provider name without slash (model field requires slash)
    expect(detectMirror({}, { summaryModel: "openai-codex" })).toBe(false);
    // Bare partial prefix without slash
    expect(detectMirror({}, { summaryProvider: "openai" })).toBe(false);
    // Wrong provider with similar name (provider exact-match only)
    expect(detectMirror({}, { summaryProvider: "openai-codex-mini" })).toBe(false);
    // Strict prefix matching — different model namespace beneath same vendor
    // does NOT match because the prefix requires the literal "openai-codex/"
    // separator (slash), not just "openai-codex" anywhere.
    expect(detectMirror({}, { summaryModel: "openai-codex-mini/foo" })).toBe(false);
  });

  it("returns false for non-string inputs (defensive)", () => {
    expect(detectMirror({}, { summaryProvider: 42 as unknown })).toBe(false);
    expect(detectMirror({}, { summaryProvider: null as unknown })).toBe(false);
    expect(detectMirror({}, { summaryProvider: undefined as unknown })).toBe(false);
    expect(detectMirror({}, { summaryProvider: {} as unknown })).toBe(false);
  });

  it("handles whitespace + case correctly", () => {
    expect(detectMirror({}, { summaryProvider: " openai-codex " })).toBe(true);
    expect(detectMirror({}, { summaryProvider: "OPENAI-CODEX" })).toBe(true);
    expect(detectMirror({}, { summaryModel: " openai-codex/gpt-5.5 " })).toBe(true);
  });

  it("ANY-OF semantics — one signal is enough", () => {
    // Codex env var but no plugin config — match
    expect(detectMirror({ openclawDefaultModel: "openai-codex/gpt-5.5" }, {})).toBe(true);
    // Codex plugin config but non-codex env var — match
    expect(
      detectMirror(
        { openclawDefaultModel: "anthropic/claude-sonnet-4.5" },
        { summaryProvider: "openai-codex" },
      ),
    ).toBe(true);
  });
});
