/**
 * Tool-wiring smoke invariant.
 *
 * # Why this exists
 *
 * Wave-12 audit (W2A1 P0 #2) found that `lcm_synthesize_around` had
 * silently dropped off the `runWithTokenGate` accounting bus —
 * registration in `src/plugin/index.ts` didn't pass `getRuntimeContext`,
 * AND the tool factory itself didn't wrap its inner with the gate. The
 * `needs-compact-gate.ts` docstring's "Tools that use this" list said
 * synthesize_around was wrapped, but no test pinned the docstring
 * against reality. Tests for synthesize-around all instantiated the
 * tool factory directly, bypassing the wrapper layer entirely.
 *
 * This file makes the docstring a test: each agent tool that should
 * use the gate MUST call `runWithTokenGate(`; each documented-exempt
 * tool MUST NOT. A future refactor that drops the wrap (or adds a new
 * tool without wrapping) breaks this immediately.
 *
 * # When this test fails
 *
 *   - "should wrap" tool no longer calls runWithTokenGate → wire it
 *     back in or update the exemption list (with reasoning).
 *   - "should NOT wrap" tool now calls runWithTokenGate → either was
 *     a deliberate addition (move to wrapped list) or accidental
 *     (remove the call).
 *
 * # Implementation note
 *
 * Static-text inspection (readFileSync + regex) is the cheapest reliable
 * check: instantiating each tool requires a full plugin context. The
 * regex tolerates whitespace/newlines around the call.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(__dirname, "..");

/**
 * Per `src/plugin/needs-compact-gate.ts` docstring "Tools that use this":
 * every active tool that emits user-facing content via the agent surface
 * SHOULD wrap its inner with runWithTokenGate so:
 *   1. evaluateNeedsCompactGate fires before the call (refusal path)
 *   2. tapResultForTokenAccounting fires after (accumulator path)
 */
const TOOLS_THAT_SHOULD_WRAP: Array<{ file: string; tool: string }> = [
  { file: "src/tools/lcm-grep-tool.ts", tool: "lcm_grep" },
  { file: "src/tools/lcm-describe-tool.ts", tool: "lcm_describe" },
  { file: "src/tools/lcm-synthesize-around-tool.ts", tool: "lcm_synthesize_around" },
  { file: "src/tools/lcm-expand-query-tool.ts", tool: "lcm_expand_query" },
  { file: "src/tools/lcm-get-entity-tool.ts", tool: "lcm_get_entity" },
  { file: "src/tools/lcm-search-entities-tool.ts", tool: "lcm_search_entities" },
];

/**
 * Documented exemptions in needs-compact-gate.ts "Skipped" section.
 * Each exemption has a load-bearing reason — if you remove a tool from
 * this list you must EITHER wrap it OR justify the removal.
 */
const TOOLS_THAT_SHOULD_NOT_WRAP: Array<{
  file: string;
  tool: string;
  reason: string;
}> = [
  {
    file: "src/tools/lcm-compact-tool.ts",
    tool: "lcm_compact",
    reason: "status response ~150 tokens; on success CLEARS the cache via noteSuccessfulCompact",
  },
  {
    file: "src/tools/lcm-expand-tool.ts",
    tool: "lcm_expand",
    reason: "sub-agent only; has its own grant ledger via expansion-auth",
  },
];

function readSource(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

const RUN_WITH_TOKEN_GATE_PATTERN = /\brunWithTokenGate\s*\(/;

describe("tool-wiring smoke — runWithTokenGate coverage matches docstring", () => {
  for (const { file, tool } of TOOLS_THAT_SHOULD_WRAP) {
    it(`${tool} (${file}) calls runWithTokenGate`, () => {
      const src = readSource(file);
      // Behavioral: the tool's factory body must invoke the gate. If a
      // refactor drops the wrap, the tool silently stops gating + tapping
      // — exactly the synthesize-around bug we shipped without noticing.
      expect(
        RUN_WITH_TOKEN_GATE_PATTERN.test(src),
        `Expected ${tool} (${file}) to call runWithTokenGate. ` +
          `If this tool is deliberately exempt, move it to ` +
          `TOOLS_THAT_SHOULD_NOT_WRAP with a reason and update ` +
          `the docstring at src/plugin/needs-compact-gate.ts.`,
      ).toBe(true);
    });
  }

  for (const { file, tool, reason } of TOOLS_THAT_SHOULD_NOT_WRAP) {
    it(`${tool} (${file}) is exempt — ${reason}`, () => {
      const src = readSource(file);
      expect(
        RUN_WITH_TOKEN_GATE_PATTERN.test(src),
        `Expected ${tool} (${file}) to be exempt from runWithTokenGate ` +
          `(${reason}). If the exemption no longer holds, move to ` +
          `TOOLS_THAT_SHOULD_WRAP and wire the wrapper.`,
      ).toBe(false);
    });
  }
});

describe("tool-wiring smoke — registration in plugin/index.ts passes getRuntimeContext", () => {
  /**
   * Wave-12 W2A1 P0 #2 second half: even when a tool's factory wraps
   * with runWithTokenGate, the registration site in plugin/index.ts
   * must pass `getRuntimeContext: () => getTokenStateRuntimeContext(...)`
   * — without it the wrapper bypasses the gate (no telemetry → returns
   * null per evaluateNeedsCompactGate's defensive bypass) AND skips the
   * tap (currentTokenCount stays undefined). This test pins the wiring.
   */
  const REGISTRATION_PATTERN_BY_TOOL: Record<string, RegExp> = {
    // Each pattern matches the registerTool block AND ensures
    // getRuntimeContext is wired. Multi-line tolerant.
    lcm_grep:
      /createLcmGrepTool\s*\(\s*\{[\s\S]*?getRuntimeContext\s*:\s*\(\s*\)\s*=>\s*getTokenStateRuntimeContext/,
    lcm_describe:
      /createLcmDescribeTool\s*\(\s*\{[\s\S]*?getRuntimeContext\s*:\s*\(\s*\)\s*=>\s*getTokenStateRuntimeContext/,
    lcm_synthesize_around:
      /createLcmSynthesizeAroundTool\s*\(\s*\{[\s\S]*?getRuntimeContext\s*:\s*\(\s*\)\s*=>\s*getTokenStateRuntimeContext/,
    lcm_expand_query:
      /createLcmExpandQueryTool\s*\(\s*\{[\s\S]*?getRuntimeContext\s*:\s*\(\s*\)\s*=>\s*getTokenStateRuntimeContext/,
    lcm_get_entity:
      /createLcmGetEntityTool\s*\(\s*\{[\s\S]*?getRuntimeContext\s*:\s*\(\s*\)\s*=>\s*getTokenStateRuntimeContext/,
    lcm_search_entities:
      /createLcmSearchEntitiesTool\s*\(\s*\{[\s\S]*?getRuntimeContext\s*:\s*\(\s*\)\s*=>\s*getTokenStateRuntimeContext/,
  };

  const pluginSrc = readSource("src/plugin/index.ts");

  for (const [tool, pattern] of Object.entries(REGISTRATION_PATTERN_BY_TOOL)) {
    it(`${tool} registration in plugin/index.ts wires getRuntimeContext`, () => {
      expect(
        pattern.test(pluginSrc),
        `Expected ${tool}'s registerTool block in src/plugin/index.ts ` +
          `to pass getRuntimeContext: () => getTokenStateRuntimeContext(...). ` +
          `Without it the runWithTokenGate wrapper bypasses telemetry ` +
          `(needsCompact gate becomes a no-op + accumulator stays empty).`,
      ).toBe(true);
    });
  }
});
