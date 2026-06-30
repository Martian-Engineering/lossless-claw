/**
 * Budget clamping and degraded/fork-bounded fallback assembly results.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { trimBootstrapMessagesToBudget } from "./bootstrap-budget.js";
import { estimateSerializedMessageTokens, estimateSerializedMessagesTokens } from "./estimate-tokens.js";
import { resolveForkBoundedLiveSuffix, stripTrailingAssistantPrefill } from "./live-coverage.js";
import { toStoredMessage } from "./message-content.js";
import type { AgentMessage, AssembleResult } from "./openclaw-bridge.js";
import type { ConversationCompactionMaintenanceRecord } from "./store/compaction-maintenance-store.js";
import { estimateAgentMessageTokens, normalizeNonNegativeInteger, toRuntimeRoleForTokenEstimate } from "./token-accounting.js";

/**
 * Suffix-trim live messages for prompt bounding, measured by serialized
 * (model-boundary) token estimate.
 *
 * Unlike `trimBootstrapMessagesToBudget` (which selects what to *persist*
 * during bootstrap and stays on stored-content counts), this bounds what is
 * *sent to the model*, so it must count structured tool payloads that the
 * stored-content estimate omits.
 */
export function trimMessagesToBudget(messages: AgentMessage[], tokenBudget: number): AgentMessage[] {
  const safeMaxTokens = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0;
  if (messages.length === 0) {
    return [];
  }
  if (safeMaxTokens <= 0) {
    return stripTrailingAssistantPrefill([messages[messages.length - 1]!]);
  }
  const kept: AgentMessage[] = [];
  let totalTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const tokenCount = estimateSerializedMessageTokens(message);
    if (kept.length > 0 && totalTokens + tokenCount > safeMaxTokens) {
      break;
    }
    kept.push(message);
    totalTokens += tokenCount;
  }
  // A single oversized tail message exceeding the budget returns empty,
  // matching the bootstrap trim contract callers already handle.
  if (kept.length === 1 && totalTokens > safeMaxTokens) {
    return [];
  }
  kept.reverse();
  return stripTrailingAssistantPrefill(kept);
}

/**
 * Safety ratio applied to the assembly token budget when clamping final
 * output by serialized (model-boundary) estimate. Leaves headroom for the
 * host's reserve tokens and renderer overhead beyond our approximation.
 */
export const SERIALIZED_OUTPUT_CLAMP_SAFETY_RATIO = 0.9;

/**
 * Final budget clamp on assembled output, measured by serialized
 * (model-boundary) token estimate rather than stored-content counts.
 *
 * Assembly budgets enforced on stored token counts can diverge from the
 * real prompt when live message objects carry structured payloads that
 * stored content omits (e.g. transcripts imported from a previous harness).
 * This clamp keeps the newest suffix that fits, drops leading tool results
 * orphaned by eviction, and re-seats the most recent user turn if eviction
 * removed every user message.
 */
export function clampMessagesToSerializedBudget(params: {
  messages: AgentMessage[];
  tokenBudget: number;
}): {
  messages: AgentMessage[];
  serializedTokens: number;
  serializedTokensBefore: number;
  clamped: boolean;
  evictedMessages: number;
  overBudget: boolean;
} {
  // Trigger once the serialized estimate crosses the safety target, not only
  // the hard budget. The host renderer adds prompt and message-boundary
  // pressure that this plugin can only approximate, so near-budget assemblies
  // must leave explicit headroom before OpenClaw performs its final precheck.
  const triggerTokens = Math.max(1, Math.floor(params.tokenBudget));
  const targetTokens = Math.max(
    1,
    Math.floor(params.tokenBudget * SERIALIZED_OUTPUT_CLAMP_SAFETY_RATIO),
  );
  const serializedTokensBefore = estimateSerializedMessagesTokens(params.messages);
  if (serializedTokensBefore <= targetTokens || params.messages.length === 0) {
    return {
      messages: params.messages,
      serializedTokens: serializedTokensBefore,
      serializedTokensBefore,
      clamped: false,
      evictedMessages: 0,
      overBudget: serializedTokensBefore > triggerTokens,
    };
  }

  // Keep the newest suffix that fits the target (always at least one message).
  const kept: AgentMessage[] = [];
  let keptTokens = 0;
  for (let index = params.messages.length - 1; index >= 0; index -= 1) {
    const message = params.messages[index]!;
    const tokenCount = estimateSerializedMessageTokens(message);
    if (kept.length > 0 && keptTokens + tokenCount > targetTokens) {
      break;
    }
    kept.push(message);
    keptTokens += tokenCount;
  }
  kept.reverse();

  // Eviction may have removed the assistant tool_use partner of leading
  // tool results; drop those orphans rather than ship unpaired results.
  while (kept.length > 1 && toRuntimeRoleForTokenEstimate(kept[0]!.role) === "toolResult") {
    keptTokens -= estimateSerializedMessageTokens(kept[0]!);
    kept.shift();
  }

  // The provider rejects contexts with no user turn; re-seat the most
  // recent evicted user message if the suffix lost every one of them.
  if (!kept.some((message) => toRuntimeRoleForTokenEstimate(message.role) === "user")) {
    for (let index = params.messages.length - kept.length - 1; index >= 0; index -= 1) {
      const candidate = params.messages[index]!;
      if (toRuntimeRoleForTokenEstimate(candidate.role) === "user") {
        kept.unshift(candidate);
        keptTokens += estimateSerializedMessageTokens(candidate);
        break;
      }
    }
  }

  // If stripping the assistant tail would empty the result (a transcript
  // with no user turns at all), keep the unstripped suffix instead; the
  // estimate must describe whichever set is actually returned.
  const stripped = stripTrailingAssistantPrefill(kept);
  const finalMessages = stripped.length > 0 ? stripped : kept;
  const serializedTokens =
    finalMessages.length === kept.length
      ? keptTokens
      : estimateSerializedMessagesTokens(finalMessages);
  return {
    messages: finalMessages,
    serializedTokens,
    serializedTokensBefore,
    clamped: true,
    evictedMessages: params.messages.length - finalMessages.length,
    overBudget: serializedTokens > targetTokens,
  };
}

export function isProtectedLeadingLiveContextMessage(message: AgentMessage): boolean {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  return role === "system" || role === "developer";
}

export function buildDegradedLiveAssembleResult(params: {
  liveMessages: AgentMessage[];
  tokenBudget: number;
}): AssembleResult {
  const withoutAssistantPrefill = stripTrailingAssistantPrefill(params.liveMessages.slice());
  const protectedPrefix: AgentMessage[] = [];
  while (
    protectedPrefix.length < withoutAssistantPrefill.length &&
    isProtectedLeadingLiveContextMessage(withoutAssistantPrefill[protectedPrefix.length]!)
  ) {
    protectedPrefix.push(withoutAssistantPrefill[protectedPrefix.length]!);
  }
  const liveTail = withoutAssistantPrefill.slice(protectedPrefix.length);
  const remainingBudget = Math.max(
    0,
    Math.floor(params.tokenBudget) - estimateAgentMessageTokens(protectedPrefix),
  );
  let liveTailMessages = trimMessagesToBudget(liveTail, remainingBudget);
  if (liveTailMessages.length === 0 && liveTail.length > 0) {
    liveTailMessages = [liveTail[liveTail.length - 1]!];
  }
  const messages = [...protectedPrefix, ...liveTailMessages];
  return {
    messages,
    estimatedTokens: estimateAgentMessageTokens(messages),
  };
}

export function resolveDeferredAssemblyPressure(params: {
  liveContextTokens: number;
  maintenance: ConversationCompactionMaintenanceRecord | null;
}): {
  observedContextTokens: number;
  projectedTokenCount: number | null;
  pressureTokenCount: number;
} {
  const recordedContextTokens = normalizeNonNegativeInteger(
    params.maintenance?.currentTokenCount,
  );
  const recordedProjectedTokens = normalizeNonNegativeInteger(
    params.maintenance?.projectedTokenCount,
  );
  const observedContextTokens = Math.max(
    params.liveContextTokens,
    recordedContextTokens ?? 0,
  );
  const pressureTokenCount = Math.max(
    observedContextTokens,
    recordedProjectedTokens ?? 0,
  );
  return {
    observedContextTokens,
    projectedTokenCount: recordedProjectedTokens ?? null,
    pressureTokenCount,
  };
}

export function buildForkBoundedLiveFallback(params: {
  liveMessages: AgentMessage[];
  forkSourceMessageCount: number;
  tokenBudget: number;
  bootstrapMaxTokens: number;
}): AssembleResult {
  const suffix = resolveForkBoundedLiveSuffix({
    assembledMessages: [],
    liveMessages: params.liveMessages,
    forkSourceMessageCount: params.forkSourceMessageCount,
  });
  const candidateMessages = suffix.length > 0 ? suffix : params.liveMessages;
  const boundedMessages = trimMessagesToBudget(
    candidateMessages,
    Math.min(params.tokenBudget, params.bootstrapMaxTokens),
  );
  return {
    messages: boundedMessages,
    estimatedTokens: estimateAgentMessageTokens(boundedMessages),
  };
}

export function appendForkBoundedLiveSuffixWithinBudget(params: {
  assembledMessages: AgentMessage[];
  assembledEstimatedTokens: number;
  liveMessages: AgentMessage[];
  forkSourceMessageCount: number;
  tokenBudget: number;
}): {
  messages: AgentMessage[];
  estimatedTokens: number;
  appendedMessages: number;
  appendedTokens: number;
  evictedMessages: number;
  evictedTokens: number;
  overBudget: boolean;
  protectedIndexes: Set<number>;
} {
  const suffix = stripTrailingAssistantPrefill(
    resolveForkBoundedLiveSuffix({
      assembledMessages: params.assembledMessages,
      liveMessages: params.liveMessages,
      forkSourceMessageCount: params.forkSourceMessageCount,
    }),
  );
  if (suffix.length === 0) {
    return {
      messages: params.assembledMessages,
      estimatedTokens: params.assembledEstimatedTokens,
      appendedMessages: 0,
      appendedTokens: 0,
      evictedMessages: 0,
      evictedTokens: 0,
      overBudget: params.assembledEstimatedTokens > params.tokenBudget,
      protectedIndexes: new Set(),
    };
  }

  let retained = params.assembledMessages.slice();
  let retainedSuffix = suffix.slice();
  let evictedMessages = 0;
  let evictedTokens = 0;
  let output = [...retained, ...retainedSuffix];
  let estimatedTokens = estimateAgentMessageTokens(output);

  while (retained.length > 0 && estimatedTokens > params.tokenBudget) {
    const removed = retained.shift() as AgentMessage;
    evictedMessages += 1;
    evictedTokens += toStoredMessage(removed).tokenCount;
    output = [...retained, ...retainedSuffix];
    estimatedTokens = estimateAgentMessageTokens(output);
  }

  while (retainedSuffix.length > 0 && estimatedTokens > params.tokenBudget) {
    const removed = retainedSuffix.shift() as AgentMessage;
    evictedMessages += 1;
    evictedTokens += toStoredMessage(removed).tokenCount;
    output = [...retained, ...retainedSuffix];
    estimatedTokens = estimateAgentMessageTokens(output);
  }

  const protectedIndexes = new Set<number>();
  const suffixStartIndex = output.length - retainedSuffix.length;
  for (let index = suffixStartIndex; index < output.length; index += 1) {
    protectedIndexes.add(index);
  }

  return {
    messages: output,
    estimatedTokens,
    appendedMessages: retainedSuffix.length,
    appendedTokens: estimateAgentMessageTokens(retainedSuffix),
    evictedMessages,
    evictedTokens,
    overBudget: estimatedTokens > params.tokenBudget,
    protectedIndexes,
  };
}
