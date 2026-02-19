import { resolveLcmConfig } from "./db/config.js";
import type { LcmDependencies } from "./types.js";

export type LcmSummarizeOptions = {
  previousSummary?: string;
  isCondensed?: boolean;
};

export type LcmSummarizeFn = (
  text: string,
  aggressive?: boolean,
  options?: LcmSummarizeOptions,
) => Promise<string>;

export type LcmSummarizerLegacyParams = {
  provider?: unknown;
  model?: unknown;
  config?: unknown;
  agentDir?: unknown;
  authProfileId?: unknown;
};

type SummaryMode = "normal" | "aggressive";

const DEFAULT_CONDENSED_TARGET_TOKENS = 2000;

/** Normalize provider ids for stable config/profile lookup. */
function normalizeProviderId(provider: string): string {
  return provider.trim().toLowerCase();
}

/**
 * Resolve provider API override from legacy OpenClaw config.
 *
 * When model ids are custom/forward-compat, this hint allows deps.complete to
 * construct a valid pi-ai Model object even if getModel(provider, model) misses.
 */
function resolveProviderApiFromLegacyConfig(
  config: unknown,
  provider: string,
): string | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }
  const providers = (config as { models?: { providers?: Record<string, unknown> } }).models
    ?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }

  const direct = providers[provider];
  if (direct && typeof direct === "object") {
    const api = (direct as { api?: unknown }).api;
    if (typeof api === "string" && api.trim()) {
      return api.trim();
    }
  }

  const normalizedProvider = normalizeProviderId(provider);
  for (const [entryProvider, value] of Object.entries(providers)) {
    if (normalizeProviderId(entryProvider) !== normalizedProvider) {
      continue;
    }
    if (!value || typeof value !== "object") {
      continue;
    }
    const api = (value as { api?: unknown }).api;
    if (typeof api === "string" && api.trim()) {
      return api.trim();
    }
  }
  return undefined;
}

/** Approximate token estimate used for target-sizing prompts. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Narrows completion response blocks to plain text blocks. */
function isTextBlock(block: unknown): block is { type: string; text: string } {
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return false;
  }
  const record = block as { type?: unknown; text?: unknown };
  return record.type === "text" && typeof record.text === "string";
}

/**
 * Resolve a practical target token count for leaf and condensed summaries.
 * Aggressive leaf mode intentionally aims lower so compaction converges faster.
 */
function resolveTargetTokens(params: {
  inputTokens: number;
  mode: SummaryMode;
  isCondensed: boolean;
  condensedTargetTokens: number;
}): number {
  if (params.isCondensed) {
    return Math.max(512, params.condensedTargetTokens);
  }

  const { inputTokens, mode } = params;
  if (mode === "aggressive") {
    return Math.max(96, Math.min(640, Math.floor(inputTokens * 0.2)));
  }
  return Math.max(192, Math.min(1200, Math.floor(inputTokens * 0.35)));
}

/**
 * Build a leaf (segment) summarization prompt.
 *
 * Normal leaf mode preserves details; aggressive leaf mode keeps only the
 * highest-value facts needed for follow-up turns.
 */
function buildLeafSummaryPrompt(params: {
  text: string;
  mode: SummaryMode;
  targetTokens: number;
  previousSummary?: string;
  customInstructions?: string;
}): string {
  const { text, mode, targetTokens, previousSummary, customInstructions } = params;
  const previousContext = previousSummary?.trim() || "(none)";

  const policy =
    mode === "aggressive"
      ? [
          "Aggressive summary policy:",
          "- Keep only durable facts and current task state.",
          "- Remove examples, repetition, and low-value narrative details.",
          "- Preserve explicit TODOs, blockers, decisions, and constraints.",
        ].join("\n")
      : [
          "Normal summary policy:",
          "- Preserve key decisions, rationale, constraints, and active tasks.",
          "- Keep essential technical details needed to continue work safely.",
          "- Remove obvious repetition and conversational filler.",
        ].join("\n");

  const instructionBlock = customInstructions?.trim()
    ? `Operator instructions:\n${customInstructions.trim()}`
    : "Operator instructions: (none)";

  return [
    "You summarize a SEGMENT of an OpenClaw conversation for future model turns.",
    "Treat this as incremental memory compaction input, not a full-conversation summary.",
    policy,
    instructionBlock,
    [
      "Output requirements:",
      "- Plain text only.",
      "- No preamble, headings, or markdown formatting.",
      "- Keep it concise while preserving required details.",
      "- Track file operations (created, modified, deleted, renamed) with file paths and current status.",
      '- If no file operations appear, include exactly: "Files: none".',
      `- Target length: about ${targetTokens} tokens or less.`,
    ].join("\n"),
    `<previous_context>\n${previousContext}\n</previous_context>`,
    `<conversation_segment>\n${text}\n</conversation_segment>`,
  ].join("\n\n");
}

/**
 * Build a condensed summarization prompt with Pi-style structured sections.
 */
function buildCondensedSummaryPrompt(params: {
  text: string;
  targetTokens: number;
  previousSummary?: string;
  customInstructions?: string;
}): string {
  const { text, targetTokens, previousSummary, customInstructions } = params;
  const previousContext = previousSummary?.trim() || "(none)";
  const instructionBlock = customInstructions?.trim()
    ? `Operator instructions:\n${customInstructions.trim()}`
    : "Operator instructions: (none)";

  return [
    "You produce a Pi-inspired condensed OpenClaw memory summary for long-context handoff.",
    "Capture only durable facts that matter for future execution and safe continuation.",
    instructionBlock,
    [
      "Output requirements:",
      "- Use plain text.",
      "- Use these exact section headings in this exact order:",
      "Goals & Context",
      "Key Decisions",
      "Progress",
      "Constraints",
      "Critical Details",
      "Files",
      "- Under Files, list file operations (created, modified, deleted, renamed) with path and current status.",
      "- If no file operations are present, set Files to: none.",
      `- Target length: about ${targetTokens} tokens.`,
    ].join("\n"),
    `<previous_context>\n${previousContext}\n</previous_context>`,
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join("\n\n");
}

/**
 * Deterministic fallback summary when model output is empty.
 *
 * Keeps compaction progress monotonic instead of throwing and aborting the
 * whole compaction pass.
 */
function buildDeterministicFallbackSummary(text: string, targetTokens: number): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const maxChars = Math.max(256, targetTokens * 4);
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  return `${trimmed.slice(0, maxChars)}\n[LCM fallback summary; truncated for context management]`;
}

/**
 * Builds a model-backed LCM summarize callback from runtime legacy params.
 *
 * Returns `undefined` when model/provider context is unavailable so callers can
 * choose a fallback summarizer.
 */
export async function createLcmSummarizeFromLegacyParams(params: {
  deps: LcmDependencies;
  legacyParams: LcmSummarizerLegacyParams;
  customInstructions?: string;
}): Promise<LcmSummarizeFn | undefined> {
  const providerHint =
    typeof params.legacyParams.provider === "string" ? params.legacyParams.provider.trim() : "";
  const modelHint =
    typeof params.legacyParams.model === "string" ? params.legacyParams.model.trim() : "";
  const modelRef = modelHint || undefined;
  console.error(`[lcm] createLcmSummarize: providerHint="${providerHint}", modelHint="${modelHint}", modelRef="${modelRef}"`);

  let resolved: { provider: string; model: string };
  try {
    resolved = params.deps.resolveModel(modelRef);
    console.error(`[lcm] createLcmSummarize: resolved model=${resolved.model}, provider=${resolved.provider}`);
  } catch (err) {
    console.error(`[lcm] createLcmSummarize: resolveModel FAILED:`, err instanceof Error ? err.message : err);
    return undefined;
  }

  const provider = providerHint || resolved.provider;
  const model = resolved.model;
  if (!provider || !model) {
    console.error(`[lcm] createLcmSummarize: empty provider="${provider}" or model="${model}"`);
    return undefined;
  }
  const authProfileId =
    typeof params.legacyParams.authProfileId === "string" &&
    params.legacyParams.authProfileId.trim()
      ? params.legacyParams.authProfileId.trim()
      : undefined;
  const agentDir =
    typeof params.legacyParams.agentDir === "string" && params.legacyParams.agentDir.trim()
      ? params.legacyParams.agentDir.trim()
      : undefined;
  const providerApi = resolveProviderApiFromLegacyConfig(params.legacyParams.config, provider);

  const apiKey = params.deps.getApiKey(provider, model);

  const runtimeLcmConfig = resolveLcmConfig();
  const condensedTargetTokens =
    Number.isFinite(runtimeLcmConfig.condensedTargetTokens) &&
    runtimeLcmConfig.condensedTargetTokens > 0
      ? runtimeLcmConfig.condensedTargetTokens
      : DEFAULT_CONDENSED_TARGET_TOKENS;

  return async (
    text: string,
    aggressive?: boolean,
    options?: LcmSummarizeOptions,
  ): Promise<string> => {
    if (!text.trim()) {
      return "";
    }

    const mode: SummaryMode = aggressive ? "aggressive" : "normal";
    const isCondensed = options?.isCondensed === true;
    const targetTokens = resolveTargetTokens({
      inputTokens: estimateTokens(text),
      mode,
      isCondensed,
      condensedTargetTokens,
    });
    const prompt = isCondensed
      ? buildCondensedSummaryPrompt({
          text,
          targetTokens,
          previousSummary: options?.previousSummary,
          customInstructions: params.customInstructions,
        })
      : buildLeafSummaryPrompt({
          text,
          mode,
          targetTokens,
          previousSummary: options?.previousSummary,
          customInstructions: params.customInstructions,
        });

    const result = await params.deps.complete({
      provider,
      model,
      apiKey,
      providerApi,
      authProfileId,
      agentDir,
      runtimeConfig: params.legacyParams.config,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      maxTokens: targetTokens,
      temperature: aggressive ? 0.1 : 0.2,
    });

    const summary = result.content
      .filter(isTextBlock)
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join("\n")
      .trim();

    if (!summary) {
      console.error(`[lcm] summarize got empty content from LLM (${result.content.length} blocks, types: ${result.content.map(b => b.type).join(",")}), falling back to truncation`);
      return buildDeterministicFallbackSummary(text, targetTokens);
    }

    return summary;
  };
}
