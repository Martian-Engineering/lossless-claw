import { resolveLcmConfig } from "./db/config.js";
import type { LcmDependencies } from "./types.js";

export type LcmSummarizeOptions = {
  previousSummary?: string;
  isCondensed?: boolean;
  depth?: number;
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

/** Narrow unknown values to plain object records. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize text fragments from provider-specific block shapes.
 *
 * Deduplicates exact repeated fragments while preserving first-seen order so
 * providers that mirror output in multiple fields don't duplicate summaries.
 */
function normalizeTextFragments(chunks: string[]): string {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized.join("\n").trim();
}

/** Collect all nested `type` labels for diagnostics on normalization failures. */
function collectBlockTypes(value: unknown, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectBlockTypes(entry, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (typeof value.type === "string" && value.type.trim()) {
    out.add(value.type.trim());
  }
  for (const nested of Object.values(value)) {
    collectBlockTypes(nested, out);
  }
}

/** Collect text payloads from common provider response shapes. */
function collectTextLikeFields(value: unknown, out: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectTextLikeFields(entry, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const key of ["text", "output_text", "thinking"]) {
    appendTextValue(value[key], out);
  }
  for (const key of ["content", "summary", "output", "message", "response"]) {
    if (key in value) {
      collectTextLikeFields(value[key], out);
    }
  }
}

/** Append raw textual values and nested text wrappers (`value`, `text`). */
function appendTextValue(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      appendTextValue(entry, out);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (typeof value.value === "string") {
    out.push(value.value);
  }
  if (typeof value.text === "string") {
    out.push(value.text);
  }
}

/** Normalize provider completion content into a plain-text summary payload. */
function normalizeCompletionSummary(content: unknown): { summary: string; blockTypes: string[] } {
  const chunks: string[] = [];
  const blockTypeSet = new Set<string>();

  collectTextLikeFields(content, chunks);
  collectBlockTypes(content, blockTypeSet);

  const blockTypes = [...blockTypeSet].sort((a, b) => a.localeCompare(b));
  return {
    summary: normalizeTextFragments(chunks),
    blockTypes,
  };
}

/** Format normalized block types for concise diagnostics. */
function formatBlockTypes(blockTypes: string[]): string {
  if (blockTypes.length === 0) {
    return "(none)";
  }
  return blockTypes.join(",");
}

/**
 * Extract safe diagnostic metadata from a provider response envelope.
 *
 * Picks common metadata fields (request id, model echo, usage counters) without
 * leaking secrets like API keys or auth tokens. The result object from
 * `deps.complete` is typed narrowly but real provider responses carry extra
 * fields that are useful for debugging empty-summary incidents.
 */
function extractResponseDiagnostics(result: unknown): string {
  if (!isRecord(result)) {
    return "";
  }

  const parts: string[] = [];

  // Request / response id — present in most provider envelopes.
  for (const key of ["id", "request_id", "x-request-id"]) {
    const val = result[key];
    if (typeof val === "string" && val.trim()) {
      parts.push(`${key}=${val.trim()}`);
    }
  }

  // Model echo — useful when the provider selects a different checkpoint.
  if (typeof result.model === "string" && result.model.trim()) {
    parts.push(`resp_model=${result.model.trim()}`);
  }

  // Usage counters — safe numeric diagnostics.
  if (isRecord(result.usage)) {
    const u = result.usage;
    const tokens: string[] = [];
    for (const k of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
      if (typeof u[k] === "number") {
        tokens.push(`${k}=${u[k]}`);
      }
    }
    if (tokens.length > 0) {
      parts.push(tokens.join(","));
    }
  }

  // Finish reason — helps explain empty content.
  const finishReason =
    typeof result.finish_reason === "string"
      ? result.finish_reason
      : typeof result.stop_reason === "string"
        ? result.stop_reason
        : undefined;
  if (finishReason) {
    parts.push(`finish=${finishReason}`);
  }

  return parts.join("; ");
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
      '- End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
      `- Target length: about ${targetTokens} tokens or less.`,
    ].join("\n"),
    `<previous_context>\n${previousContext}\n</previous_context>`,
    `<conversation_segment>\n${text}\n</conversation_segment>`,
  ].join("\n\n");
}

function buildD1Prompt(params: {
  text: string;
  targetTokens: number;
  previousSummary?: string;
  customInstructions?: string;
}): string {
  const { text, targetTokens, previousSummary, customInstructions } = params;
  const instructionBlock = customInstructions?.trim()
    ? `Operator instructions:\n${customInstructions.trim()}`
    : "Operator instructions: (none)";
  const previousContext = previousSummary?.trim();
  const previousContextBlock = previousContext
    ? [
        "It already has this preceding summary as context. Do not repeat information",
        "that appears there unchanged. Focus on what is new, changed, or resolved:",
        "",
        `<previous_context>\n${previousContext}\n</previous_context>`,
      ].join("\n")
    : "Focus on what matters for continuation:";

  return [
    "You are compacting leaf-level conversation summaries into a single condensed memory node.",
    "You are preparing context for a fresh model instance that will continue this conversation.",
    instructionBlock,
    previousContextBlock,
    [
      "Preserve:",
      "- Decisions made and their rationale when rationale matters going forward.",
      "- Earlier decisions that were superseded, and what replaced them.",
      "- Completed tasks/topics with outcomes.",
      "- In-progress items with current state and what remains.",
      "- Blockers, open questions, and unresolved tensions.",
      "- Specific references (names, paths, URLs, identifiers) needed for continuation.",
      "",
      "Drop low-value detail:",
      "- Context that has not changed from previous_context.",
      "- Intermediate dead ends where the conclusion is already known.",
      "- Transient states that are already resolved.",
      "- Tool-internal mechanics and process scaffolding.",
      "",
      "Use plain text. No mandatory structure.",
      "Include a timeline with timestamps (hour or half-hour) for significant events.",
      "Present information chronologically and mark superseded decisions.",
      'End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
      `Target length: about ${targetTokens} tokens.`,
    ].join("\n"),
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join("\n\n");
}

function buildD2Prompt(params: {
  text: string;
  targetTokens: number;
  customInstructions?: string;
}): string {
  const { text, targetTokens, customInstructions } = params;
  const instructionBlock = customInstructions?.trim()
    ? `Operator instructions:\n${customInstructions.trim()}`
    : "Operator instructions: (none)";

  return [
    "You are condensing multiple session-level summaries into a higher-level memory node.",
    "A future model should understand trajectory, not per-session minutiae.",
    instructionBlock,
    [
      "Preserve:",
      "- Decisions still in effect and their rationale.",
      "- Decisions that evolved: what changed and why.",
      "- Completed work with outcomes.",
      "- Active constraints, limitations, and known issues.",
      "- Current state of in-progress work.",
      "",
      "Drop:",
      "- Session-local operational detail and process mechanics.",
      "- Identifiers that are no longer relevant.",
      "- Intermediate states superseded by later outcomes.",
      "",
      "Use plain text. Brief headers are fine if useful.",
      "Include a timeline with dates and approximate time of day for key milestones.",
      'End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
      `Target length: about ${targetTokens} tokens.`,
    ].join("\n"),
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join("\n\n");
}

function buildD3PlusPrompt(params: {
  text: string;
  targetTokens: number;
  customInstructions?: string;
}): string {
  const { text, targetTokens, customInstructions } = params;
  const instructionBlock = customInstructions?.trim()
    ? `Operator instructions:\n${customInstructions.trim()}`
    : "Operator instructions: (none)";

  return [
    "You are creating a high-level memory node from multiple phase-level summaries.",
    "This may persist for the rest of the conversation. Keep only durable context.",
    instructionBlock,
    [
      "Preserve:",
      "- Key decisions and rationale.",
      "- What was accomplished and current state.",
      "- Active constraints and hard limitations.",
      "- Important relationships between people, systems, or concepts.",
      "- Durable lessons learned.",
      "",
      "Drop:",
      "- Operational and process detail.",
      "- Method details unless the method itself was the decision.",
      "- Specific references unless essential for continuation.",
      "",
      "Use plain text. Be concise.",
      "Include a brief timeline with dates (or date ranges) for major milestones.",
      'End with exactly: "Expand for details about: <comma-separated list of what was dropped or compressed>".',
      `Target length: about ${targetTokens} tokens.`,
    ].join("\n"),
    `<conversation_to_condense>\n${text}\n</conversation_to_condense>`,
  ].join("\n\n");
}

/** Build a condensed prompt variant based on the output node depth. */
function buildCondensedSummaryPrompt(params: {
  text: string;
  targetTokens: number;
  depth: number;
  previousSummary?: string;
  customInstructions?: string;
}): string {
  if (params.depth <= 1) {
    return buildD1Prompt(params);
  }
  if (params.depth === 2) {
    return buildD2Prompt(params);
  }
  return buildD3PlusPrompt(params);
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

  let resolved: { provider: string; model: string };
  try {
    resolved = params.deps.resolveModel(modelRef, providerHint || undefined);
  } catch (err) {
    console.error(`[lcm] createLcmSummarize: resolveModel FAILED:`, err instanceof Error ? err.message : err);
    return undefined;
  }

  const { provider, model } = resolved;
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
          depth:
            typeof options?.depth === "number" && Number.isFinite(options.depth)
              ? Math.max(1, Math.floor(options.depth))
              : 1,
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

    const normalized = normalizeCompletionSummary(result.content);
    let summary = normalized.summary;

    // --- Empty-summary hardening: diagnostics → retry → deterministic fallback ---
    if (!summary) {
      const responseDiag = extractResponseDiagnostics(result);
      const diagParts = [
        `[lcm] empty normalized summary on first attempt`,
        `provider=${provider}`,
        `model=${model}`,
        `block_types=${formatBlockTypes(normalized.blockTypes)}`,
        `response_blocks=${result.content.length}`,
      ];
      if (responseDiag) {
        diagParts.push(responseDiag);
      }
      console.error(`${diagParts.join("; ")}; retrying with conservative settings`);

      // Single retry with conservative parameters: low temperature and low
      // reasoning budget to coax a textual response from providers that
      // sometimes return reasoning-only or empty blocks on the first pass.
      try {
        const retryResult = await params.deps.complete({
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
          temperature: 0.05,
          reasoning: "low",
        });

        const retryNormalized = normalizeCompletionSummary(retryResult.content);
        summary = retryNormalized.summary;

        if (summary) {
          console.error(
            `[lcm] retry succeeded; provider=${provider} model=${model}; ` +
              `block_types=${formatBlockTypes(retryNormalized.blockTypes)}`,
          );
        } else {
          const retryDiag = extractResponseDiagnostics(retryResult);
          const retryParts = [
            `[lcm] retry also returned empty summary`,
            `provider=${provider}`,
            `model=${model}`,
            `block_types=${formatBlockTypes(retryNormalized.blockTypes)}`,
            `response_blocks=${retryResult.content.length}`,
          ];
          if (retryDiag) {
            retryParts.push(retryDiag);
          }
          console.error(`${retryParts.join("; ")}; falling back to truncation`);
        }
      } catch (retryErr) {
        // Retry is best-effort; log and proceed to deterministic fallback.
        console.error(
          `[lcm] retry failed; provider=${provider} model=${model}; error=${
            retryErr instanceof Error ? retryErr.message : String(retryErr)
          }; falling back to truncation`,
        );
      }
    }

    if (!summary) {
      return buildDeterministicFallbackSummary(text, targetTokens);
    }

    return summary;
  };
}
