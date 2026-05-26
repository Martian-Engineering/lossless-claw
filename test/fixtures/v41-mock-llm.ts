/**
 * Deterministic mock LLM provider for synthesis-quality testing.
 *
 * # Why this exists
 *
 * Synthesis quality (Type-A scenarios in THE_FIVE_QUESTIONS.md) was the
 * single un-tested gap after Wave-10 closed all other antipattern classes.
 * Real-LLM tests are non-deterministic + cost money + need network. Mock
 * tests can verify:
 *
 *   1. The dispatch pipeline calls the LLM with correctly-rendered prompts
 *      (placeholder substitution, model selection, pass routing)
 *   2. Output handling (parse, validate, audit-row writes, cache write)
 *   3. Adversarial response handling — fabricated citations, malformed
 *      JSON, prompt-injection attempts in the LLM output, etc. Real LLMs
 *      RARELY return broken output, so adversarial parsing tests need
 *      mocks to be reliable.
 *
 * # Scope
 *
 * QA-only. Never imported from production code. Lives in test/fixtures/
 * to make that visible. Implements the `LlmCall` interface from
 * `src/synthesis/dispatch.ts`.
 *
 * # Determinism
 *
 * All mock responses are pure functions of the input prompt. Identical
 * prompts produce identical outputs. Fingerprint = sha256 of the prompt;
 * we hash to a small space and pick from a fixture-keyed response table.
 *
 * # Adversarial fixtures
 *
 * Mock can be configured to return:
 *
 *   - "good": realistic synthesis with proper citations
 *   - "fabricated_citations": output that cites sum_xxx IDs not in source
 *   - "malformed_json": parser-breaking output for verify-fidelity pass
 *   - "hallucinated_content": output containing claims not in source
 *   - "empty": empty string (LLM returned nothing)
 *   - "throw": simulate LLM call failure
 *   - "rate_limit": simulate Voyage 429
 *   - "verify_OK": for verify-fidelity prompts, return clean OK response
 *   - "verify_HALLUCINATION": for verify-fidelity prompts, flag a hallucination
 *   - "verify_UNSUPPORTED": for verify-fidelity prompts, flag unsupported claim
 *
 * Tests pick one based on what they want to verify.
 */

import type { LlmCall, LlmCallArgs, LlmCallResult } from "../../src/synthesis/dispatch.js";

export type MockResponseShape =
  | "good"
  | "fabricated_citations"
  | "malformed_json"
  | "hallucinated_content"
  | "empty"
  | "throw"
  | "rate_limit"
  | "verify_OK"
  | "verify_HALLUCINATION"
  | "verify_UNSUPPORTED";

export interface MockLlmOptions {
  /** Default response for any prompt. */
  defaultShape?: MockResponseShape;
  /**
   * Override the default for prompts matching a substring. Allows tests
   * to mix response shapes per pass-kind without complex routing.
   * Evaluated in order; first matching wins.
   */
  perPromptOverrides?: Array<{
    promptContains: string;
    shape: MockResponseShape;
  }>;
  /** Fixed latency to return (default 50ms). */
  latencyMs?: number;
  /** Fixed cost to return (default 0). */
  costCents?: number;
  /**
   * Captured calls — tests can inspect to verify dispatch routed
   * correctly. Pushed in order; one entry per call.
   */
  captured?: LlmCallArgs[];
}

export class MockLlmRateLimitError extends Error {
  readonly kind = "rate_limit" as const;
  constructor(message = "Voyage rate-limit (429)") {
    super(message);
    this.name = "MockLlmRateLimitError";
  }
}

export class MockLlmFailureError extends Error {
  readonly kind = "llm_failure" as const;
  constructor(message = "Mock LLM throw (test fixture)") {
    super(message);
    this.name = "MockLlmFailureError";
  }
}

/**
 * Build a deterministic mock LlmCall.
 */
export function makeMockLlm(options: MockLlmOptions = {}): LlmCall {
  const defaultShape = options.defaultShape ?? "good";
  const overrides = options.perPromptOverrides ?? [];
  const latencyMs = options.latencyMs ?? 50;
  const costCents = options.costCents ?? 0;
  const captured = options.captured ?? [];

  return async (args: LlmCallArgs): Promise<LlmCallResult> => {
    captured.push(args);
    // Pick the response shape: per-prompt override > default.
    let shape: MockResponseShape = defaultShape;
    for (const ov of overrides) {
      if (args.prompt.includes(ov.promptContains)) {
        shape = ov.shape;
        break;
      }
    }

    if (shape === "throw") {
      throw new MockLlmFailureError(
        `Mock LLM throw (passKind=${args.passKind}, model=${args.model})`,
      );
    }
    if (shape === "rate_limit") {
      throw new MockLlmRateLimitError();
    }

    const output = renderMockResponse(shape, args);
    return {
      output,
      latencyMs,
      costCents,
      actualModel: args.model,
    };
  };
}

/**
 * Pure function: prompt + shape → output text.
 */
export function renderMockResponse(
  shape: MockResponseShape,
  args: LlmCallArgs,
): string {
  // Try to extract source IDs from the rendered prompt — most synthesis
  // templates include a "Source: sum_xxx" or "<source-id>sum_xxx</source-id>"
  // marker the LLM is supposed to cite. We use these to construct
  // realistic citations or to fabricate IDs that look plausible but
  // aren't actually present.
  const sourceIds = extractSourceIds(args.prompt);
  const sampleId = sourceIds[0] ?? "sum_unknown";
  const fabricatedId = "sum_fabricated_999"; // never present in fixtures

  switch (shape) {
    case "good": {
      // Realistic-looking synthesis. Cites the first source ID.
      if (args.passKind === "best_of_n_judge") {
        // Judge returns "Winner: N" format.
        return "Winner: 0\n\nReasoning: candidate 0 covers the temporal scope most fully and cites all 3 source leaves [sum_a, sum_b, sum_c].";
      }
      return `[mock-good] Synthesis covering ${sourceIds.length} source(s). Key points:\n- Decision X recorded [${sampleId}]\n- Action Y completed [${sampleId}]\n- No contradictions across sources.`;
    }
    case "fabricated_citations": {
      // Cites an ID that doesn't appear in source_text — should be
      // caught by Wave-4/6/8 citation validation.
      return `[mock-fab] Synthesis citing fabricated ID [${fabricatedId}] — this should be rejected by validation.`;
    }
    case "malformed_json": {
      // Verify-fidelity pass expects either "OK" or "UNSUPPORTED: ..."
      // — return malformed JSON to test parser robustness.
      return `{"verdict": "OK"`; // truncated JSON
    }
    case "hallucinated_content": {
      // Synthesis introduces claims not present in source.
      return `[mock-hallu] Eva announced the Mars colony plan and the team agreed to ship by Q1 2027. (None of this appears in source.) [${sampleId}]`;
    }
    case "empty": {
      return "";
    }
    case "verify_OK": {
      // Verify-fidelity pass returns "OK" when the draft is fidelity-clean.
      return "OK\n\nNo unsupported claims detected.";
    }
    case "verify_HALLUCINATION": {
      // Verify-fidelity pass flags a hallucination.
      return "HALLUCINATION: The draft mentions a Mars colony plan that is not in the source leaves.";
    }
    case "verify_UNSUPPORTED": {
      return "UNSUPPORTED: The draft claims Eva approved X but the source leaves don't show this approval.";
    }
    case "throw":
    case "rate_limit": {
      // Already handled above; unreachable.
      return "";
    }
  }
}

function extractSourceIds(prompt: string): string[] {
  // Match `sum_xxx` patterns that appear bracketed or in source markers.
  // Be lenient: any `sum_<alnum_>{1,40}` token in the prompt is a candidate.
  const matches = prompt.match(/sum_[a-zA-Z0-9_]{1,40}/g) ?? [];
  return [...new Set(matches)];
}
