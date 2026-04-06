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

type SummaryResolutionCandidate = {
  levelName: string;
  modelRef: string;
  providerHint?: string;
  hasExplicitProvider: boolean;
  useLegacyAuthProfile: boolean;
};

type ResolvedSummaryCandidate = SummaryResolutionCandidate & {
  provider: string;
  model: string;
};

function buildSummarizerBreakerKey(params: {
  candidate: ResolvedSummaryCandidate;
  legacyAuthProfileId?: string;
}): string {
  const authProfileId = params.candidate.useLegacyAuthProfile
    ? (params.legacyAuthProfileId ?? "-")
    : "-";
  return `provider:${params.candidate.provider};model:${params.candidate.model};authProfile:${authProfileId}`;
}

type SummaryMode = "normal" | "aggressive";

const DEFAULT_LEAF_TARGET_TOKENS = 2400;
const DEFAULT_CONDENSED_TARGET_TOKENS = 2000;
const LCM_SUMMARIZER_SYSTEM_PROMPT =
  "You are a context-compaction summarization engine. Follow user instructions exactly and return plain text summary content only.";
const DIAGNOSTIC_MAX_DEPTH = 4;
const DIAGNOSTIC_MAX_ARRAY_ITEMS = 8;
const DIAGNOSTIC_MAX_OBJECT_KEYS = 16;
const DIAGNOSTIC_MAX_CHARS = 1200;
const DIAGNOSTIC_SENSITIVE_KEY_PATTERN =
  /(api[-_]?key|authorization|token|secret|password|cookie|set-cookie|private[-_]?key|bearer)/i;
const AUTH_ERROR_TEXT_PATTERN =
  /\b401\b|unauthorized|unauthorised|invalid[_ -]?token|invalid[_ -]?api[_ -]?key|authentication failed|authorization failed|missing scope|insufficient scope|model\.request\b/i;
const AUTH_ERROR_STATUS_KEYS = ["status", "statusCode", "status_code"] as const;
const AUTH_ERROR_NESTED_KEYS = ["error", "response", "cause", "details", "data", "body"] as const;
const AUTH_ERROR_TOP_LEVEL_KEYS = [
  "error",
  "errorMessage",
  "status",
  "statusCode",
  "status_code",
  "code",
  "details",
  "cause",
  "data",
  "body",
] as const;

type ProviderAuthFailure = {
  statusCode?: number;
  message?: string;
  missingModelRequestScope: boolean;
};

/**
 * Signals that the summarizer hit a provider-auth failure and callers should
 * avoid treating the result like an empty summary.
 */
export class LcmProviderAuthError extends Error {
  readonly provider: string;
  readonly model: string;
  readonly failure: ProviderAuthFailure;

  constructor(params: {
    provider: string;
    model: string;
    failure: ProviderAuthFailure;
  }) {
    super(buildProviderAuthWarning(params));
    this.name = "LcmProviderAuthError";
    this.provider = params.provider;
    this.model = params.model;
    this.failure = params.failure;
  }
}

/**
 * Default timeout for a single summarizer LLM call.  Long enough for large
 * context windows on slower providers, short enough to prevent the gateway
 * event loop from starving when a provider hangs.
 */
const DEFAULT_SUMMARIZER_TIMEOUT_MS = 60_000;

/** Error used to distinguish summarizer timeouts from provider failures. */
class SummarizerTimeoutError extends Error {
  constructor(ms: number, label: string) {
    super(`[lcm] summarizer timeout after ${ms}ms (${label})`);
    this.name = "SummarizerTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SummarizerTimeoutError(ms, label)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

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

/** Treat provider reasoning/thinking payloads as diagnostics, not summary text. */
function isReasoningLikeType(type: unknown): boolean {
  if (typeof type !== "string") {
    return false;
  }
  const normalized = type.trim().toLowerCase();
  return normalized.includes("reasoning") || normalized.includes("thinking");
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

  if (isReasoningLikeType(value.type)) {
    return;
  }

  for (const key of ["text", "output_text"]) {
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

/** Truncate long diagnostic text values to keep logs bounded and readable. */
function truncateDiagnosticText(value: string, maxChars = DIAGNOSTIC_MAX_CHARS): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, maxChars)}...[truncated:${value.length - maxChars} chars]`;
}

/** Build a JSON-safe, redacted, depth-limited clone for diagnostic logging. */
function sanitizeForDiagnostics(value: unknown, depth = 0): unknown {
  if (depth >= DIAGNOSTIC_MAX_DEPTH) {
    return "[max-depth]";
  }
  if (typeof value === "string") {
    return truncateDiagnosticText(value);
  }
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return value;
  }
  if (value === undefined) {
    return "[undefined]";
  }
  if (typeof value === "function") {
    return "[function]";
  }
  if (typeof value === "symbol") {
    return "[symbol]";
  }
  if (Array.isArray(value)) {
    const head = value
      .slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS)
      .map((entry) => sanitizeForDiagnostics(entry, depth + 1));
    if (value.length > DIAGNOSTIC_MAX_ARRAY_ITEMS) {
      head.push(`[+${value.length - DIAGNOSTIC_MAX_ARRAY_ITEMS} more items]`);
    }
    return head;
  }
  if (!isRecord(value)) {
    return String(value);
  }

  const out: Record<string, unknown> = {};
  const entries = Object.entries(value);
  for (const [key, entry] of entries.slice(0, DIAGNOSTIC_MAX_OBJECT_KEYS)) {
    out[key] = DIAGNOSTIC_SENSITIVE_KEY_PATTERN.test(key)
      ? "[redacted]"
      : sanitizeForDiagnostics(entry, depth + 1);
  }
  if (entries.length > DIAGNOSTIC_MAX_OBJECT_KEYS) {
    out.__truncated_keys__ = entries.length - DIAGNOSTIC_MAX_OBJECT_KEYS;
  }
  return out;
}

/** Encode diagnostic payloads in a compact JSON string with safety guards. */
function formatDiagnosticPayload(value: unknown): string {
  try {
    const json = JSON.stringify(sanitizeForDiagnostics(value));
    if (!json) {
      return "\"\"";
    }
    return truncateDiagnosticText(json);
  } catch {
    return "\"[unserializable]\"";
  }
}

function collectAuthFailureText(value: unknown, out: string[], depth = 0): void {
  if (depth >= 4) {
    return;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) {
      out.push(trimmed);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS)) {
      collectAuthFailureText(entry, out, depth + 1);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  for (const entry of Object.values(value).slice(0, DIAGNOSTIC_MAX_OBJECT_KEYS)) {
    collectAuthFailureText(entry, out, depth + 1);
  }
}

function extractAuthFailureStatusCode(value: unknown, depth = 0): number | undefined {
  if (depth >= 4 || !isRecord(value)) {
    return undefined;
  }

  for (const key of AUTH_ERROR_STATUS_KEYS) {
    const candidate = value[key];
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return Math.trunc(candidate);
    }
    if (typeof candidate === "string") {
      const parsed = Number.parseInt(candidate, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }

  for (const key of AUTH_ERROR_NESTED_KEYS) {
    const nested = value[key];
    const statusCode = extractAuthFailureStatusCode(nested, depth + 1);
    if (statusCode !== undefined) {
      return statusCode;
    }
  }

  return undefined;
}

function hasTopLevelAuthInspectionKeys(value: Record<string, unknown>): boolean {
  return AUTH_ERROR_TOP_LEVEL_KEYS.some((key) => key in value);
}

function looksLikeThrownError(value: Record<string, unknown>): boolean {
  return (
    (typeof value.name === "string" && /\berror\b/i.test(value.name)) ||
    "stack" in value ||
    (typeof value.message === "string" &&
      !("content" in value) &&
      !("response" in value) &&
      !("output" in value))
  );
}

function pickAuthInspectionValue(value: unknown): unknown {
  if (!isRecord(value)) {
    return value;
  }
  if (isRecord(value.error) && value.error.kind === "provider_auth") {
    return value.error;
  }

  const subset: Record<string, unknown> = {};
  const hasTopLevelAuthKeys = hasTopLevelAuthInspectionKeys(value);
  const errorLike = value instanceof Error || looksLikeThrownError(value);

  for (const key of AUTH_ERROR_TOP_LEVEL_KEYS) {
    if (key in value) {
      subset[key] = value[key];
    }
  }

  // Only inspect top-level message payloads when the envelope already looks
  // error-shaped. Successful summary responses also use `message`.
  if ((hasTopLevelAuthKeys || errorLike) && "message" in value) {
    subset.message = value.message;
  }

  // `response` can carry either an error payload or successful summary text.
  // Include it only when the surrounding or nested shape already looks like an
  // error envelope.
  if ("response" in value) {
    const response = value.response;
    if (
      hasTopLevelAuthKeys ||
      (isRecord(response) && hasTopLevelAuthInspectionKeys(response)) ||
      (isRecord(response) && looksLikeThrownError(response))
    ) {
      subset.response = response;
    }
  }

  return Object.keys(subset).length > 0 ? subset : {};
}

/** @internal Exported for testing only. */
export function extractProviderAuthFailure(
  value: unknown,
  opts?: { requireStructuralSignal?: boolean },
): ProviderAuthFailure | undefined {
  const inspectValue = pickAuthInspectionValue(value);
  const statusCode = extractAuthFailureStatusCode(inspectValue);
  const textParts: string[] = [];
  collectAuthFailureText(inspectValue, textParts);
  const normalizedMessage = textParts.join(" ").replace(/\s+/g, " ").trim();
  const missingModelRequestScope = /\bmodel\.request\b/i.test(normalizedMessage);
  const hasScopeSignal =
    missingModelRequestScope || /\b(missing|insufficient)\s+scope\b/i.test(normalizedMessage);

  // When requireStructuralSignal is set (e.g. checking a successful API response
  // rather than a caught error), only detect auth failures that have a concrete
  // structural indicator (HTTP 401 status code or an explicit provider_auth error
  // kind).  Plain text matches in the response body are NOT sufficient — the LLM
  // summary content may legitimately discuss auth errors without being one.
  const hasExplicitErrorKind =
    isRecord(value) && isRecord((value as Record<string, unknown>).error) &&
    ((value as Record<string, unknown>).error as Record<string, unknown>).kind === "provider_auth";

  if (opts?.requireStructuralSignal) {
    if (statusCode !== 401 && !hasExplicitErrorKind) {
      return undefined;
    }
  } else if (statusCode !== 401 && !hasScopeSignal && !AUTH_ERROR_TEXT_PATTERN.test(normalizedMessage)) {
    return undefined;
  }

  return {
    ...(statusCode !== undefined ? { statusCode } : {}),
    ...(normalizedMessage ? { message: truncateDiagnosticText(normalizedMessage, 240) } : {}),
    missingModelRequestScope,
  };
}

function buildProviderAuthWarning(params: {
  provider: string;
  model: string;
  failure: ProviderAuthFailure;
}): string {
  const detailParts: string[] = [];
  if (params.failure.statusCode === 401) {
    detailParts.push("401");
  }
  if (params.failure.missingModelRequestScope) {
    detailParts.push("missing model.request scope");
  }
  const detail =
    detailParts.length > 0
      ? `provider auth error (${detailParts.join(" / ")})`
      : "provider auth error";
  const messageSuffix =
    params.failure.message && !params.failure.missingModelRequestScope
      ? ` Detail: ${params.failure.message}`
      : "";
  return `[lcm] compaction failed: ${detail}. Check that the configured summaryProvider has valid API credentials. Current: ${params.provider}/${params.model}${messageSuffix}`;
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

  // Envelope-shape diagnostics for empty-block incidents.
  const topLevelKeys = Object.keys(result).slice(0, 24);
  if (topLevelKeys.length > 0) {
    parts.push(`keys=${topLevelKeys.join(",")}`);
  }
  if ("content" in result) {
    const contentVal = result.content;
    if (Array.isArray(contentVal)) {
      parts.push(`content_kind=array`);
      parts.push(`content_len=${contentVal.length}`);
    } else if (contentVal === null) {
      parts.push(`content_kind=null`);
    } else {
      parts.push(`content_kind=${typeof contentVal}`);
    }
    parts.push(`content_preview=${formatDiagnosticPayload(contentVal)}`);
  } else {
    parts.push("content_kind=missing");
  }

  // Preview common non-content payload envelopes used by provider SDKs.
  const envelopePayload: Record<string, unknown> = {};
  for (const key of ["summary", "output", "message", "response"]) {
    if (key in result) {
      envelopePayload[key] = result[key];
    }
  }
  if (Object.keys(envelopePayload).length > 0) {
    parts.push(`payload_preview=${formatDiagnosticPayload(envelopePayload)}`);
  }

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
  if (typeof result.provider === "string" && result.provider.trim()) {
    parts.push(`resp_provider=${result.provider.trim()}`);
  }
  if (typeof result.status === "string" && result.status.trim()) {
    parts.push(`status=${result.status.trim()}`);
  }
  if (isRecord(result.incomplete_details) && typeof result.incomplete_details.reason === "string") {
    const reason = result.incomplete_details.reason.trim();
    if (reason) {
      parts.push(`incomplete_reason=${reason}`);
    }
  }
  for (const key of [
    "request_provider",
    "request_model",
    "request_api",
    "request_reasoning",
    "request_has_system",
    "request_temperature",
    "request_temperature_sent",
  ]) {
    const val = result[key];
    if (typeof val === "string" && val.trim()) {
      parts.push(`${key}=${val.trim()}`);
    }
  }

  // Usage counters — safe numeric diagnostics.
  if (isRecord(result.usage)) {
    const u = result.usage;
    const tokens: string[] = [];
    for (const k of [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "input",
      "output",
      "cacheRead",
      "cacheWrite",
    ]) {
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
      : typeof result.stopReason === "string"
        ? result.stopReason
      : typeof result.stop_reason === "string"
        ? result.stop_reason
        : undefined;
  if (finishReason) {
    parts.push(`finish=${finishReason}`);
  }

  // Provider-level error payloads (most useful when finish=error and content is empty).
  const errorMessage = result.errorMessage;
  if (typeof errorMessage === "string" && errorMessage.trim()) {
    parts.push(`error_message=${truncateDiagnosticText(errorMessage.trim(), 400)}`);
  }
  const errorPayload = result.error;
  if (errorPayload !== undefined) {
    parts.push(`error_preview=${formatDiagnosticPayload(errorPayload)}`);
  }

  return parts.join("; ");
}

/** Collect retry-worthy "incomplete" signals from Responses-style envelopes/items. */
function collectIncompleteResponseSignals(
  value: unknown,
  out: Set<string>,
  label = "response",
  depth = 0,
): void {
  if (depth >= DIAGNOSTIC_MAX_DEPTH) {
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, DIAGNOSTIC_MAX_ARRAY_ITEMS).forEach((entry, index) => {
      collectIncompleteResponseSignals(entry, out, `${label}[${index}]`, depth + 1);
    });
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  if (typeof value.status === "string" && value.status.trim().toLowerCase() === "incomplete") {
    out.add(`${label}.status=incomplete`);
  }
  if (isRecord(value.incomplete_details) && typeof value.incomplete_details.reason === "string") {
    const reason = value.incomplete_details.reason.trim();
    if (reason) {
      out.add(`${label}.reason=${reason}`);
    }
  }

  for (const key of ["content", "output", "message", "response", "items"] as const) {
    if (key in value) {
      collectIncompleteResponseSignals(value[key], out, `${label}.${key}`, depth + 1);
    }
  }
}

/** Extract retry-worthy incomplete-response diagnostics for provider envelopes/items. */
function extractIncompleteResponseSignals(value: unknown): string[] {
  const signals = new Set<string>();
  collectIncompleteResponseSignals(value, signals);
  return [...signals].sort((a, b) => a.localeCompare(b));
}

/**
 * Resolve a practical target token count for leaf and condensed summaries.
 * Aggressive leaf mode intentionally aims lower so compaction converges faster.
 */
function resolveTargetTokens(params: {
  inputTokens: number;
  mode: SummaryMode;
  isCondensed: boolean;
  leafTargetTokens: number;
  condensedTargetTokens: number;
}): number {
  if (params.isCondensed) {
    return Math.max(512, params.condensedTargetTokens);
  }

  const { inputTokens, mode } = params;
  const leafTargetTokens = Math.max(192, params.leafTargetTokens);
  if (mode === "aggressive") {
    const aggressiveCap = Math.max(96, Math.min(leafTargetTokens, Math.floor(leafTargetTokens * 0.55)));
    return Math.max(96, Math.min(aggressiveCap, Math.floor(inputTokens * 0.2)));
  }
  return Math.max(192, Math.min(leafTargetTokens, Math.floor(inputTokens * 0.35)));
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

/** Normalize model refs from string or `{ primary }` config shapes. */
function readModelRef(value: unknown): string {
  if (typeof value === "string") {
    return value.trim();
  }
  const primary = (value as { primary?: unknown } | undefined)?.primary;
  return typeof primary === "string" ? primary.trim() : "";
}

/** Avoid retrying the same resolved provider/model pair across fallback levels. */
function dedupeResolvedCandidates(
  candidates: ResolvedSummaryCandidate[],
): ResolvedSummaryCandidate[] {
  const seen = new Set<string>();
  const ordered: ResolvedSummaryCandidate[] = [];
  for (const candidate of candidates) {
    const key = `${candidate.provider}\u0000${candidate.model}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    ordered.push(candidate);
  }
  return ordered;
}

/** Resolve ordered summarizer candidates from env, plugin config, defaults, and session hints. */
function resolveSummaryCandidates(params: {
  deps: LcmDependencies;
  legacyParams: LcmSummarizerLegacyParams;
}): ResolvedSummaryCandidate[] {
  const providerHint =
    typeof params.legacyParams.provider === "string" ? params.legacyParams.provider.trim() : "";
  const modelHint =
    typeof params.legacyParams.model === "string" ? params.legacyParams.model.trim() : "";
  const runtimeConfig =
    params.legacyParams.config && typeof params.legacyParams.config === "object"
      ? (params.legacyParams.config as {
          agents?: {
            defaults?: {
              model?: unknown;
              compaction?: {
                model?: unknown;
              };
            };
          };
          plugins?: {
            entries?: {
              [key: string]: {
                config?: { summaryModel?: unknown; summaryProvider?: unknown };
              };
            };
          };
        })
      : undefined;
  const nestedPluginConfig = runtimeConfig?.plugins?.entries?.["lossless-claw"]?.config;

  const resolutionCandidates: SummaryResolutionCandidate[] = [
    {
      levelName: "environment variables",
      modelRef: process.env.LCM_SUMMARY_MODEL?.trim() ?? "",
      providerHint:
        process.env.LCM_SUMMARY_PROVIDER?.trim() ||
        (providerHint || undefined),
      hasExplicitProvider: Boolean(process.env.LCM_SUMMARY_PROVIDER?.trim()),
      useLegacyAuthProfile: false,
    },
    {
      levelName: "plugin config (lossless-claw)",
      modelRef: readModelRef(nestedPluginConfig?.summaryModel),
      providerHint:
        (typeof nestedPluginConfig?.summaryProvider === "string"
          ? nestedPluginConfig.summaryProvider.trim()
          : "") || (providerHint || undefined),
      hasExplicitProvider: Boolean(
        typeof nestedPluginConfig?.summaryProvider === "string" &&
          nestedPluginConfig.summaryProvider.trim(),
      ),
      useLegacyAuthProfile: false,
    },
    {
      levelName: "OpenClaw agents.defaults.compaction.model",
      modelRef: readModelRef(runtimeConfig?.agents?.defaults?.compaction?.model),
      providerHint: undefined,
      hasExplicitProvider: false,
      useLegacyAuthProfile: false,
    },
    {
      levelName: "OpenClaw agents.defaults.model",
      modelRef: readModelRef(runtimeConfig?.agents?.defaults?.model),
      providerHint: undefined,
      hasExplicitProvider: false,
      useLegacyAuthProfile: false,
    },
    {
      levelName: "legacy runtime/session model",
      modelRef: modelHint,
      providerHint: providerHint || undefined,
      hasExplicitProvider: Boolean(providerHint),
      useLegacyAuthProfile: true,
    },
  ];

  // Append explicit fallback providers from config.
  for (const fb of params.deps.config.fallbackProviders ?? []) {
    resolutionCandidates.push({
      levelName: `explicit fallback (${fb.provider}/${fb.model})`,
      modelRef: `${fb.provider}/${fb.model}`,
      providerHint: fb.provider,
      hasExplicitProvider: true,
      useLegacyAuthProfile: false,
    });
  }

  const resolvedCandidates: ResolvedSummaryCandidate[] = [];
  for (const candidate of resolutionCandidates) {
    if (!candidate.modelRef) {
      continue;
    }
    if (!candidate.modelRef.includes("/") && !candidate.hasExplicitProvider) {
      params.deps.log.warn(
        `[lcm] summaryModel "${candidate.modelRef}" at "${candidate.levelName}" has no summaryProvider or provider prefix. Will attempt resolution without provider.`,
      );
    }
    try {
      const resolved = params.deps.resolveModel(candidate.modelRef, candidate.providerHint);
      if (resolved.provider && resolved.model) {
        resolvedCandidates.push({
          ...candidate,
          provider: resolved.provider,
          model: resolved.model,
        });
      }
    } catch (err) {
      console.error(
        `[lcm] createLcmSummarize: resolveModel FAILED at ${candidate.levelName}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return dedupeResolvedCandidates(resolvedCandidates);
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
}): Promise<{ fn: LcmSummarizeFn; model: string; breakerKey: string } | undefined> {
  const resolvedCandidates = resolveSummaryCandidates(params);
  if (resolvedCandidates.length === 0) {
    console.error("[lcm] createLcmSummarize: no summary model candidates resolved");
    return undefined;
  }

  const legacyAuthProfileId =
    typeof params.legacyParams.authProfileId === "string" &&
    params.legacyParams.authProfileId.trim()
      ? params.legacyParams.authProfileId.trim()
      : undefined;
  const agentDir =
    typeof params.legacyParams.agentDir === "string" && params.legacyParams.agentDir.trim()
      ? params.legacyParams.agentDir.trim()
      : undefined;

  const condensedTargetTokens =
    Number.isFinite(params.deps.config.condensedTargetTokens) &&
    params.deps.config.condensedTargetTokens > 0
      ? params.deps.config.condensedTargetTokens
      : DEFAULT_CONDENSED_TARGET_TOKENS;
  const leafTargetTokens =
    Number.isFinite(params.deps.config.leafTargetTokens) &&
    params.deps.config.leafTargetTokens > 0
      ? params.deps.config.leafTargetTokens
      : DEFAULT_LEAF_TARGET_TOKENS;

  const summarizerTimeoutMs =
    Number.isFinite(params.deps.config.summaryTimeoutMs) && params.deps.config.summaryTimeoutMs > 0
      ? params.deps.config.summaryTimeoutMs
      : DEFAULT_SUMMARIZER_TIMEOUT_MS;

  const fn: LcmSummarizeFn = async (
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
      leafTargetTokens,
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

    let lastAuthError: LcmProviderAuthError | undefined;

    for (let index = 0; index < resolvedCandidates.length; index += 1) {
      const candidate = resolvedCandidates[index]!;
      const provider = candidate.provider;
      const model = candidate.model;
      const nextCandidate = index < resolvedCandidates.length - 1 ? resolvedCandidates[index + 1]! : undefined;
      const authProfileId = candidate.useLegacyAuthProfile ? legacyAuthProfileId : undefined;
      const providerApi = resolveProviderApiFromLegacyConfig(params.legacyParams.config, provider);
      const lookupOptions = {
        profileId: authProfileId,
        agentDir,
        runtimeConfig: params.legacyParams.config,
      };

      const runSummarizerCall = async (
        requestApiKey: string | undefined,
        label: string,
        reasoning?: string,
      ) =>
        withTimeout(params.deps.complete({
          provider,
          model,
          apiKey: requestApiKey,
          providerApi,
          authProfileId,
          agentDir,
          runtimeConfig: params.legacyParams.config,
          system: LCM_SUMMARIZER_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: prompt,
            },
          ],
          maxTokens: targetTokens,
          ...(reasoning ? { reasoning } : {}),
        }), summarizerTimeoutMs, label);

      const retryWithoutModelAuth = async (
        failure: ProviderAuthFailure,
        reasoning?: string,
      ): Promise<Awaited<ReturnType<typeof params.deps.complete>>> => {
        const initialAuthError = new LcmProviderAuthError({ provider, model, failure });
        const runtimeManagedAuth = params.deps.isRuntimeManagedAuthProvider?.(provider, providerApi) === true;
        if (runtimeManagedAuth) {
          throw initialAuthError;
        }
        console.warn(initialAuthError.message);
        console.warn(
          `[lcm] summarizer auth retry: retrying ${provider}/${model} without runtime.modelAuth credentials.`,
        );

        const directApiKey = await params.deps.getApiKey(provider, model, {
          ...lookupOptions,
          skipModelAuth: true,
        });
        if (!directApiKey) {
          console.warn(
            `[lcm] summarizer auth retry unavailable: no direct credentials found for ${provider}/${model}.`,
          );
          throw initialAuthError;
        }

        try {
          const directResult = await runSummarizerCall(directApiKey, "auth-retry", reasoning);
          // Use requireStructuralSignal on the retry success path too — the
          // summary text may legitimately contain auth-error phrases.
          const directFailure = extractProviderAuthFailure(directResult, {
            requireStructuralSignal: true,
          });
          if (directFailure) {
            const retryAuthError = new LcmProviderAuthError({
              provider,
              model,
              failure: directFailure,
            });
            console.warn(retryAuthError.message);
            throw retryAuthError;
          }
          console.warn(
            `[lcm] summarizer auth retry succeeded; provider=${provider}; model=${model}; source=direct-credentials`,
          );
          return directResult;
        } catch (directErr) {
          if (directErr instanceof LcmProviderAuthError) {
            throw directErr;
          }
          // Catch path: real errors carry structural signals (HTTP 401, error.kind),
          // so requireStructuralSignal is safe here too.
          const directFailure = extractProviderAuthFailure(directErr, {
            requireStructuralSignal: true,
          });
          if (directFailure) {
            const retryAuthError = new LcmProviderAuthError({
              provider,
              model,
              failure: directFailure,
            });
            console.warn(retryAuthError.message);
            throw retryAuthError;
          }
          throw directErr;
        }
      };

      const attemptSummarizerCall = async (
        label: string,
        reasoning?: string,
      ): Promise<Awaited<ReturnType<typeof params.deps.complete>>> => {
        const apiKey = await params.deps.getApiKey(provider, model, lookupOptions);
        try {
          const result = await runSummarizerCall(apiKey, label, reasoning);
          // Use requireStructuralSignal so that LLM summary text containing
          // auth-related words (e.g. "provider auth error") is NOT mistaken
          // for an actual API auth failure.
          const authFailure = extractProviderAuthFailure(result, {
            requireStructuralSignal: true,
          });
          if (!authFailure) {
            return result;
          }
          return retryWithoutModelAuth(authFailure, reasoning);
        } catch (err) {
          const authFailure = extractProviderAuthFailure(err);
          if (!authFailure) {
            throw err;
          }
          return retryWithoutModelAuth(authFailure, reasoning);
        }
      };

      let result: Awaited<ReturnType<typeof params.deps.complete>>;
      try {
        result = await attemptSummarizerCall("initial");
      } catch (err) {
        if (err instanceof LcmProviderAuthError) {
          lastAuthError = err;
          if (nextCandidate) {
            console.error(
              `[lcm] PROVIDER FALLBACK: ${provider}/${model} auth failed → trying ${nextCandidate.provider}/${nextCandidate.model}`,
            );
            const backoffMs = Math.min(500 * Math.pow(2, index), 8000);
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
          throw lastAuthError;
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        const isTimeout = errMsg.includes("summarizer timeout");
        console.error(
          `[lcm] summarizer ${isTimeout ? "timed out" : "failed"}; provider=${provider}; model=${model}; timeout=${summarizerTimeoutMs}ms; error=${errMsg}`,
        );
        if (nextCandidate) {
          console.error(
            `[lcm] PROVIDER FALLBACK: ${provider}/${model} ${isTimeout ? "timed out" : "failed"} → trying ${nextCandidate.provider}/${nextCandidate.model}`,
          );
          const backoffMs = Math.min(500 * Math.pow(2, index), 8000);
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        if (err instanceof SummarizerTimeoutError) {
          console.error(
            `[lcm] summarizer timed out; provider=${provider}; model=${model}; source=fallback`,
          );
          return buildDeterministicFallbackSummary(text, targetTokens);
        }
        return "";
      }

      const normalized = normalizeCompletionSummary(result.content);
      let summary = normalized.summary;
      let summarySource: "content" | "envelope" | "retry" | "fallback" = "content";

      // --- Empty-summary hardening: envelope → retry → deterministic fallback ---
      if (!summary) {
        // Envelope-aware extraction: some providers place summary text in
        // top-level response fields (output, message, response) rather than
        // inside the content array.  Re-run normalization against the full
        // response envelope before spending an API call on a retry.
        const envelopeNormalized = normalizeCompletionSummary(result);
        if (envelopeNormalized.summary) {
          summary = envelopeNormalized.summary;
          summarySource = "envelope";
          console.error(
            `[lcm] recovered summary from response envelope; provider=${provider}; model=${model}; ` +
              `block_types=${formatBlockTypes(envelopeNormalized.blockTypes)}; source=envelope`,
          );
        }
      }

      const incompleteSignals = extractIncompleteResponseSignals(result);
      const initialSummary = summary;
      const shouldRetryIncompleteSummary = summary.length > 0 && incompleteSignals.length > 0;

      if (!summary || shouldRetryIncompleteSummary) {
        const responseDiag = extractResponseDiagnostics(result);
        const diagParts = [
          shouldRetryIncompleteSummary
            ? `[lcm] incomplete summary response on first attempt`
            : `[lcm] empty normalized summary on first attempt`,
          `provider=${provider}`,
          `model=${model}`,
          `block_types=${formatBlockTypes(normalized.blockTypes)}`,
          `response_blocks=${result.content.length}`,
        ];
        if (incompleteSignals.length > 0) {
          diagParts.push(`incomplete=${incompleteSignals.join(",")}`);
        }
        if (responseDiag) {
          diagParts.push(responseDiag);
        }
        console.error(`${diagParts.join("; ")}; retrying with conservative settings`);

        // Single retry with conservative parameters: low temperature and low
        // reasoning budget to coax a textual response from providers that
        // sometimes return reasoning-only or empty blocks on the first pass.
        try {
          const retryResult = await attemptSummarizerCall("retry", "low");
          const retryNormalized = normalizeCompletionSummary(retryResult.content);
          const retryEnvelopeNormalized = retryNormalized.summary
            ? retryNormalized
            : normalizeCompletionSummary(retryResult);
          summary = retryEnvelopeNormalized.summary;

          if (summary) {
            summarySource = "retry";
            console.error(
              `[lcm] retry succeeded; provider=${provider}; model=${model}; ` +
                `block_types=${formatBlockTypes(retryEnvelopeNormalized.blockTypes)}; source=retry`,
            );
          } else {
            const retryDiag = extractResponseDiagnostics(retryResult);
            const retryParts = [
              `[lcm] retry also returned empty summary`,
              `provider=${provider}`,
              `model=${model}`,
              `block_types=${formatBlockTypes(retryEnvelopeNormalized.blockTypes)}`,
              `response_blocks=${retryResult.content.length}`,
            ];
            if (retryDiag) {
              retryParts.push(retryDiag);
            }
            if (nextCandidate) {
              console.warn(
                `${retryParts.join("; ")}; retrying with ${nextCandidate.provider}/${nextCandidate.model}`,
              );
              continue;
            }
            console.error(`${retryParts.join("; ")}; falling back to truncation`);
            summary = initialSummary;
          }
        } catch (retryErr) {
          if (retryErr instanceof LcmProviderAuthError) {
            lastAuthError = retryErr;
            if (nextCandidate) {
              console.error(
                `[lcm] PROVIDER FALLBACK: ${provider}/${model} auth failed on retry → trying ${nextCandidate.provider}/${nextCandidate.model}`,
              );
              const backoffMs = Math.min(500 * Math.pow(2, index), 8000);
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            throw lastAuthError;
          }
          // Retry is best-effort; log and proceed to deterministic fallback.
          const retryErrMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          const isRetryTimeout = retryErrMsg.includes("summarizer timeout");
          if (nextCandidate) {
            console.warn(
              `[lcm] retry ${isRetryTimeout ? "timed out" : "failed"}; provider=${provider}; model=${model}; timeout=${summarizerTimeoutMs}ms; error=${retryErrMsg}; retrying with ${nextCandidate.provider}/${nextCandidate.model}`,
            );
            continue;
          }
          console.warn(
            `[lcm] retry ${isRetryTimeout ? "timed out" : "failed"}; provider=${provider}; model=${model}; timeout=${summarizerTimeoutMs}ms; error=${retryErrMsg}; falling back to truncation`,
          );
          summary = initialSummary;
        }
      }

      if (!summary) {
        summarySource = "fallback";
        console.error(
          `[lcm] all extraction attempts exhausted; provider=${provider}; model=${model}; source=fallback`,
        );
        return buildDeterministicFallbackSummary(text, targetTokens);
      }

      if (summarySource !== "content") {
        console.error(
          `[lcm] summary resolved via non-content path; provider=${provider}; model=${model}; source=${summarySource}`,
        );
      }

      return summary;
    }

    console.error(
      `[lcm] ALL PROVIDERS EXHAUSTED: ${resolvedCandidates.length} candidate(s) tried, none succeeded. Compaction falling back to deterministic truncation. Check provider keys and quotas.`,
    );
    if (lastAuthError) {
      throw lastAuthError;
    }
    return "";
  };

  return {
    fn,
    model: resolvedCandidates[0]!.model,
    breakerKey: buildSummarizerBreakerKey({
      candidate: resolvedCandidates[0]!,
      legacyAuthProfileId,
    }),
  };
}
