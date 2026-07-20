/**
 * Engine-side token accounting on top of estimate-tokens: per-part content estimates and runtime usage extraction.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { estimateSerializedMessagesTokens, estimateTokens } from "./estimate-tokens.js";
import { isTextBlock } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { asRecord } from "./value-utils.js";

export function toRuntimeRoleForTokenEstimate(role: string): "user" | "assistant" | "toolResult" {
  if (role === "tool" || role === "toolResult") {
    return "toolResult";
  }
  if (role === "user" || role === "system") {
    return "user";
  }
  return "assistant";
}

/**
 * Estimate token usage for the content shape that the assembler will emit.
 *
 * LCM stores a plain-text fallback copy in messages.content, but message_parts
 * can rehydrate larger structured/raw blocks. This estimator mirrors the
 * rehydrated shape so compaction decisions use realistic token totals.
 */
export function estimateContentTokensForRole(params: {
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  fallbackContent: string;
}): number {
  const { role, content, fallbackContent } = params;

  if (typeof content === "string") {
    return estimateTokens(content);
  }

  if (Array.isArray(content)) {
    if (content.length === 0) {
      return estimateTokens(fallbackContent);
    }

    if (role === "user" && content.length === 1 && isTextBlock(content[0])) {
      return estimateTokens(content[0].text);
    }

    const serialized = JSON.stringify(content);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  if (content && typeof content === "object") {
    if (role === "user" && isTextBlock(content)) {
      return estimateTokens(content.text);
    }

    const serialized = JSON.stringify([content]);
    return estimateTokens(typeof serialized === "string" ? serialized : "");
  }

  return estimateTokens(fallbackContent);
}

export function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
}

export function firstRuntimeTokenCount(record: Record<string, unknown> | null, keys: string[]): number | undefined {
  if (!record) {
    return undefined;
  }
  for (const key of keys) {
    const count = normalizeNonNegativeInteger(record[key]);
    if (count !== undefined) {
      return count;
    }
  }
  return undefined;
}

/**
 * Extract the runtime prompt token count from OpenClaw runtimeContext.
 *
 * OpenClaw derives this as: input + cacheRead + cacheWrite from the
 * normalizeUsage() result.  The runtimeContext carries it three ways:
 *   1. runtimeContext.currentTokenCount  — direct value (preferred)
 *   2. runtimeContext.usage             — {input, cacheRead, cacheWrite, ...}
 *   3. runtimeContext.promptCache.lastCallUsage — same normalized shape
 *
 * normalizeUsage() maps provider-specific fields (prompt_tokens, input_tokens,
 * cache_read, etc.) to the canonical {input, cacheRead, cacheWrite} shape,
 * so the lastCallUsage passed to LCM is already provider-normalized.
 */
/**
 * Sum prompt tokens from a usage record.
 *
 * Supports two shapes:
 * - Normalized (OpenClaw internal): {input, cacheRead, cacheWrite}
 * - Raw provider: {prompt_tokens, ...}
 *
 * normalizeUsage() maps raw provider fields (prompt_tokens, cache_read, etc.)
 * to the canonical normalized shape before LCM receives runtimeContext.
 * We accept both shapes to be robust to direct test calls and future changes.
 */
export function sumPromptTokensFromUsageRecord(record: Record<string, unknown> | null): number | undefined {
  if (!record) {
    return undefined;
  }
  // Normalized shape: input + cacheRead + cacheWrite
  const input = normalizeNonNegativeInteger(record["input"]);
  const cacheRead = normalizeNonNegativeInteger(record["cacheRead"]);
  const cacheWrite = normalizeNonNegativeInteger(record["cacheWrite"]);
  if (input !== undefined || cacheRead !== undefined || cacheWrite !== undefined) {
    return (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
  }
  // Raw provider shape: prompt_tokens (already includes cache reads)
  const rawPromptTokens = normalizeNonNegativeInteger(
    record["prompt_tokens"] ?? record["promptTokens"] ?? record["input_tokens"] ?? record["inputTokens"],
  );
  if (rawPromptTokens !== undefined) {
    return rawPromptTokens;
  }
  return undefined;
}

export function extractRuntimePromptTokenCount(runtimeContext?: Record<string, unknown>): number | undefined {
  const ctx = asRecord(runtimeContext);
  if (!ctx) {
    return undefined;
  }

  // 1. Direct currentTokenCount (already derived by OpenClaw: input+cacheRead+cacheWrite)
  const direct = normalizeNonNegativeInteger(ctx["currentTokenCount"]);
  if (direct !== undefined) {
    return direct;
  }

  // 2. Sum from runtimeContext.usage (normalizeUsage output: {input, cacheRead, cacheWrite})
  const usageSum = sumPromptTokensFromUsageRecord(
    asRecord(ctx["usage"]) ?? asRecord(ctx["lastCallUsage"]) ?? null,
  );
  if (usageSum !== undefined && usageSum > 0) {
    return usageSum;
  }

  // 3. Sum from promptCache.lastCallUsage (same normalized shape)
  const promptCache = asRecord(ctx["promptCache"]);
  const promptCacheUsageSum = sumPromptTokensFromUsageRecord(
    asRecord(promptCache?.["lastCallUsage"]) ?? null,
  );
  if (promptCacheUsageSum !== undefined && promptCacheUsageSum > 0) {
    return promptCacheUsageSum;
  }

  return undefined;
}

/**
 * Estimate live message tokens for prompt-budget math.
 *
 * Serializes the full message structure (matching the model-boundary
 * renderer) instead of the stored-content token count, which omits
 * structured tool payloads and undercounts tool-heavy live messages.
 */
export function estimateAgentMessageTokens(messages: AgentMessage[]): number {
  return estimateSerializedMessagesTokens(messages);
}
