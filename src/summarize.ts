import { completeSimple, type TextContent } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveOpenClawAgentDir } from "../../agents/agent-paths.js";
import { getApiKeyForModel, requireApiKey } from "../../agents/model-auth.js";
import { resolveModel } from "../../agents/pi-embedded-runner/model.js";
import { resolveLcmConfig } from "./db/config.js";

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

const SUMMARY_TIMEOUT_MS = 45_000;
const DEFAULT_CONDENSED_TARGET_TOKENS = 2000;

/** Approximate token estimate used for target-sizing prompts. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Narrows pi-ai response blocks to plain text content blocks. */
function isTextContentBlock(block: { type: string }): block is TextContent {
  return block.type === "text";
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
  legacyParams: LcmSummarizerLegacyParams;
  customInstructions?: string;
}): Promise<LcmSummarizeFn | undefined> {
  const provider =
    typeof params.legacyParams.provider === "string" ? params.legacyParams.provider.trim() : "";
  const model =
    typeof params.legacyParams.model === "string" ? params.legacyParams.model.trim() : "";

  if (!provider || !model) {
    return undefined;
  }

  const agentDir =
    typeof params.legacyParams.agentDir === "string"
      ? params.legacyParams.agentDir
      : resolveOpenClawAgentDir();
  const cfg = params.legacyParams.config as OpenClawConfig | undefined;

  const resolved = resolveModel(provider, model, agentDir, cfg);
  if (!resolved.model) {
    return undefined;
  }

  const resolvedModel = resolved.model;

  const authProfileId =
    typeof params.legacyParams.authProfileId === "string"
      ? params.legacyParams.authProfileId
      : undefined;

  const auth = await getApiKeyForModel({
    model: resolvedModel,
    cfg,
    profileId: authProfileId,
    agentDir,
  });

  let apiKey: string | undefined;
  if (resolvedModel.provider === "github-copilot") {
    const { resolveCopilotApiToken } = await import("../../providers/github-copilot-token.js");
    const githubToken = requireApiKey(auth, resolvedModel.provider);
    const copilotToken = await resolveCopilotApiToken({ githubToken });
    apiKey = copilotToken.token;
  } else if (auth.mode !== "aws-sdk") {
    apiKey = requireApiKey(auth, resolvedModel.provider);
  }

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

    const controller = new AbortController();
    const timeout = setTimeout(controller.abort.bind(controller), SUMMARY_TIMEOUT_MS);

    try {
      const result = await completeSimple(
        resolvedModel,
        {
          messages: [
            {
              role: "user",
              content: prompt,
              timestamp: Date.now(),
            },
          ],
        },
        {
          apiKey,
          maxTokens: targetTokens,
          temperature: aggressive ? 0.1 : 0.2,
          signal: controller.signal,
        },
      );

      const summary = result.content
        .filter(isTextContentBlock)
        .map((block) => block.text.trim())
        .filter(Boolean)
        .join("\n")
        .trim();

      if (!summary) {
        return buildDeterministicFallbackSummary(text, targetTokens);
      }

      return summary;
    } finally {
      clearTimeout(timeout);
    }
  };
}
