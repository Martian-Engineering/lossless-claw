/**
 * Static model pricing table for compaction cost estimation.
 * Rates are USD per million tokens ($/MTok) as of April 2026.
 * These are estimates for reporting — not for billing.
 */

type ModelPricing = { input: number; output: number };

const MODEL_PRICING: Array<[prefix: string, pricing: ModelPricing]> = [
  // Anthropic
  ["claude-opus-4", { input: 5.00, output: 25.00 }],
  ["claude-sonnet-4", { input: 3.00, output: 15.00 }],
  ["claude-haiku-4", { input: 1.00, output: 5.00 }],
  // OpenAI
  ["gpt-4o-mini", { input: 0.15, output: 0.60 }],
  ["gpt-4.1-mini", { input: 0.40, output: 1.60 }],
  ["gpt-4o", { input: 2.50, output: 10.00 }],
  ["gpt-5.4-mini", { input: 0.75, output: 4.50 }],
  // Google
  ["gemini-2.5-flash", { input: 0.30, output: 2.50 }],
  ["gemini-2.5-pro", { input: 1.25, output: 10.00 }],
  // Others
  ["mistral-small", { input: 0.15, output: 0.60 }],
  ["deepseek-v3", { input: 0.28, output: 0.42 }],
];

/** Default rate when model is unknown — Sonnet-class as a conservative middle estimate. */
const UNKNOWN_MODEL_PRICING: ModelPricing = { input: 3.00, output: 15.00 };

/** Default main-model input price ($/MTok) for savings estimation. Sonnet-class. */
export const DEFAULT_MAIN_MODEL_INPUT_PRICE = 3.00;

/** Conservative estimate of how many future turns benefit from each token saved. */
export const BENEFIT_TURNS = 5;

function findPricing(model: string | undefined): { pricing: ModelPricing; matched: boolean } {
  if (!model) return { pricing: UNKNOWN_MODEL_PRICING, matched: false };
  const lower = model.toLowerCase();
  for (const [prefix, pricing] of MODEL_PRICING) {
    if (lower.startsWith(prefix) || lower.includes(prefix)) {
      return { pricing, matched: true };
    }
  }
  return { pricing: UNKNOWN_MODEL_PRICING, matched: false };
}

export function estimateModelCost(
  model: string | undefined,
  inputTokens: number,
  outputTokens: number,
): { inputCost: number; outputCost: number; totalCost: number; matched: boolean } {
  const { pricing, matched } = findPricing(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return { inputCost, outputCost, totalCost: inputCost + outputCost, matched };
}

export function estimateSavings(
  tokensSaved: number,
  mainModelInputPrice: number = DEFAULT_MAIN_MODEL_INPUT_PRICE,
  benefitTurns: number = BENEFIT_TURNS,
): number {
  return (tokensSaved / 1_000_000) * mainModelInputPrice * benefitTurns;
}

export function formatCurrency(amount: number): string {
  if (Math.abs(amount) < 0.005) return "$0.00";
  return `$${amount.toFixed(2)}`;
}
