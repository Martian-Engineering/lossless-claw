/**
 * Budget clamping and degraded/fork-bounded fallback assembly results.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { trimBootstrapMessagesToBudget } from "./bootstrap-budget.js";
import { estimateSerializedMessageTokens, estimateSerializedMessagesTokens } from "./estimate-tokens.js";
import { resolveForkBoundedLiveSuffix, stripTrailingAssistantPrefill } from "./live-coverage.js";
import { toStoredMessage } from "./message-content.js";
import type {
  AgentMessage,
  AssembleResult,
  ContextEngineProjection,
} from "./openclaw-bridge.js";
import type { ConversationCompactionMaintenanceRecord } from "./store/compaction-maintenance-store.js";
import { estimateAgentMessageTokens, normalizeNonNegativeInteger, toRuntimeRoleForTokenEstimate } from "./token-accounting.js";
import {
  buildToolPairIndexesByAssembledIndex,
  extractAssistantToolCallIdsForPairing,
  extractToolResultIdForPairing,
} from "./tool-pairing.js";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";

/** Recognize tool exchange rows without interpreting ordinary assistant text. */
function isToolExchangeMessage(message: AgentMessage): boolean {
  return message.role === "tool" || message.role === "toolResult" ||
    extractAssistantToolCallIdsForPairing(message).length > 0;
}

/** Omit an incomplete leading tool turn from the prompt without changing stored history. */
function omitLeadingOrphanedToolTurn(messages: AgentMessage[]): AgentMessage[] {
  const firstUserIndex = messages.findIndex((message) => message.role === "user");
  // With no user boundary, the host may own an in-flight initiating turn.
  // A later provider-visible user boundary proves the exchange is historical.
  if (firstUserIndex < 0) {
    return messages;
  }
  const prefix = messages.slice(0, firstUserIndex);
  const hasToolExchange = prefix.some(isToolExchangeMessage);
  if (!hasToolExchange) {
    return messages;
  }

  // A later user cannot initiate an earlier call. Preserve host framing and
  // begin at the next user boundary; never invent a replacement initiating turn.
  const omittedCallIds = new Set(prefix.flatMap(extractAssistantToolCallIdsForPairing));
  const retainedCallIds = new Set<string>();
  const suffix = messages.slice(firstUserIndex).filter((message) => {
    for (const id of extractAssistantToolCallIdsForPairing(message)) {
      retainedCallIds.add(id);
    }
    // A displaced result of an omitted call must not survive past the boundary.
    // A new retained call with that ID owns its own result.
    const resultId = extractToolResultIdForPairing(message);
    return !resultId || !omittedCallIds.has(resultId) || retainedCallIds.has(resultId);
  });
  return [
    ...prefix.filter(isProtectedLeadingLiveContextMessage),
    ...suffix,
  ];
}

/**
 * Expand a retained suffix to a provider-valid turn without replaying the
 * entire live transcript. Tool calls and results are one eviction unit; when
 * the suffix begins inside such a unit, recover every matching partner and a
 * preceding user message before repairing provider ordering.
 */
function buildProviderValidSuffix(params: {
  messages: AgentMessage[];
  retainedStartIndex: number;
  preserveSubstantiveAssistantTail?: boolean;
}): AgentMessage[] {
  if (params.messages.length === 0 || params.retainedStartIndex >= params.messages.length) {
    return [];
  }

  const retainedIndexes = new Set<number>();
  const safeStartIndex = Math.max(0, params.retainedStartIndex);
  for (let index = safeStartIndex; index < params.messages.length; index += 1) {
    retainedIndexes.add(index);
  }

  const toolPairIndexes = buildToolPairIndexesByAssembledIndex(params.messages);
  for (const index of [...retainedIndexes]) {
    for (const relatedIndex of toolPairIndexes.get(index) ?? [index]) {
      retainedIndexes.add(relatedIndex);
    }
  }

  const earliestRetainedIndex = Math.min(...retainedIndexes);
  // A later user does not anchor the leading retained tool exchange. Recover
  // the earlier initiating user without changing ordinary text-only eviction.
  const retainedBeforeFirstUser: AgentMessage[] = [];
  let hasUserMessage = false;
  for (const index of [...retainedIndexes].sort((left, right) => left - right)) {
    const message = params.messages[index]!;
    if (toRuntimeRoleForTokenEstimate(message.role) === "user") {
      hasUserMessage = true;
      break;
    }
    retainedBeforeFirstUser.push(message);
  }
  const startsWithToolExchange = retainedBeforeFirstUser.some(isToolExchangeMessage);
  if (!hasUserMessage || startsWithToolExchange) {
    for (let index = earliestRetainedIndex - 1; index >= 0; index -= 1) {
      if (toRuntimeRoleForTokenEstimate(params.messages[index]!.role) === "user") {
        retainedIndexes.add(index);
        break;
      }
    }
  }

  // System/developer framing belongs to the whole prompt, not an evicted turn.
  for (let index = 0; index < safeStartIndex; index += 1) {
    if (!isProtectedLeadingLiveContextMessage(params.messages[index]!)) {
      break;
    }
    retainedIndexes.add(index);
  }

  const retainedMessages = [...retainedIndexes]
    .sort((left, right) => left - right)
    .map((index) => {
      const message = params.messages[index]!;
      if (message.role !== "tool" && message.role !== "toolResult") {
        return message;
      }
      // Pairing repair consumes the runtime toolResult role and top-level ID.
      // Normalize a copy so the host-owned live transcript stays unchanged.
      const toolCallId = extractToolResultIdForPairing(message);
      return {
        ...message,
        role: "toolResult",
        ...(toolCallId ? { toolCallId } : {}),
      } as AgentMessage;
    });
  // Apply the caller's prefill policy before repair can synthesize results.
  // Keep the legacy assistant-only fallback when stripping would empty it.
  const stripped = stripTrailingAssistantPrefill(retainedMessages, params);
  const repairMessages =
    stripped.length > 0 || params.preserveSubstantiveAssistantTail === true
      ? stripped
      : retainedMessages;
  // Prompt-separate hosts repair the final adopted assistant turn, which may
  // contain a pending call. Earlier calls still need local pairing repair
  // when a subsequent assistant turn follows them.
  const repairEndIndex =
    repairMessages[repairMessages.length - 1]?.role === "assistant"
      ? repairMessages.length - 1
      : repairMessages.length;
  return omitLeadingOrphanedToolTurn([
    ...sanitizeToolUseResultPairing(repairMessages.slice(0, repairEndIndex)),
    ...repairMessages.slice(repairEndIndex),
  ] as AgentMessage[]);
}

/**
 * Suffix-trim live messages for prompt bounding, measured by serialized
 * (model-boundary) token estimate.
 *
 * Unlike `trimBootstrapMessagesToBudget` (which selects what to *persist*
 * during bootstrap and stays on stored-content counts), this bounds what is
 * *sent to the model*, so it must count structured tool payloads that the
 * stored-content estimate omits.
 */
export function trimMessagesToBudget(
  messages: AgentMessage[],
  tokenBudget: number,
  options: { preserveSubstantiveAssistantTail?: boolean } = {},
): AgentMessage[] {
  const safeMaxTokens = Number.isFinite(tokenBudget) ? Math.max(0, Math.floor(tokenBudget)) : 0;
  if (messages.length === 0) {
    return [];
  }
  if (safeMaxTokens <= 0) {
    return stripTrailingAssistantPrefill([messages[messages.length - 1]!], options);
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
  return stripTrailingAssistantPrefill(kept, options);
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
 * This clamp keeps the newest suffix that fits, expands retained tool calls
 * and results to complete pairing units, and re-seats their initiating user
 * turn. Incomplete leading tool turns are omitted even below budget. A single atomic turn can still
 * exceed the target; returning it intact is safer than emitting an invalid
 * partial tool exchange.
 */
export function clampMessagesToSerializedBudget(params: {
  messages: AgentMessage[];
  tokenBudget: number;
  preserveSubstantiveAssistantTail?: boolean;
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
  const messages = omitLeadingOrphanedToolTurn(params.messages);
  const serializedTokens = messages === params.messages
    ? serializedTokensBefore
    : estimateSerializedMessagesTokens(messages);
  if (serializedTokens <= targetTokens || messages.length === 0) {
    return {
      messages,
      serializedTokens,
      serializedTokensBefore,
      clamped: messages.length !== params.messages.length,
      evictedMessages: params.messages.length - messages.length,
      overBudget: serializedTokens > triggerTokens,
    };
  }

  // Keep the newest suffix that fits the target (always at least one message),
  // then recover any tool-pair partners displaced by the budget boundary.
  const kept: AgentMessage[] = [];
  let keptTokens = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const tokenCount = estimateSerializedMessageTokens(message);
    if (kept.length > 0 && keptTokens + tokenCount > targetTokens) {
      break;
    }
    kept.push(message);
    keptTokens += tokenCount;
  }
  kept.reverse();
  const providerValidKept = buildProviderValidSuffix({
    messages,
    retainedStartIndex: messages.length - kept.length,
    preserveSubstantiveAssistantTail: params.preserveSubstantiveAssistantTail,
  });
  keptTokens = estimateSerializedMessagesTokens(providerValidKept);

  // Historically an assistant-only suffix was retained when stripping would
  // empty the result. Prompt-separate hosts must still return an empty array
  // for blank or reasoning-only tails: restoring those tails would reintroduce
  // invalid assistant prefill content after the preservation policy rejected it.
  const stripped = stripTrailingAssistantPrefill(providerValidKept, {
    preserveSubstantiveAssistantTail: params.preserveSubstantiveAssistantTail,
  });
  const finalMessages =
    stripped.length > 0 || params.preserveSubstantiveAssistantTail === true
      ? stripped
      : providerValidKept;
  const finalSerializedTokens =
    finalMessages.length === providerValidKept.length
      ? keptTokens
      : estimateSerializedMessagesTokens(finalMessages);
  return {
    messages: finalMessages,
    serializedTokens: finalSerializedTokens,
    serializedTokensBefore,
    clamped: true,
    evictedMessages: Math.max(0, params.messages.length - finalMessages.length),
    overBudget: finalSerializedTokens > targetTokens,
  };
}

export function isProtectedLeadingLiveContextMessage(message: AgentMessage): boolean {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  return role === "system" || role === "developer";
}

export function buildDegradedLiveAssembleResult(params: {
  liveMessages: AgentMessage[];
  tokenBudget: number;
  preserveSubstantiveAssistantTail?: boolean;
  contextProjection: ContextEngineProjection;
}): AssembleResult {
  const prefillOptions = {
    preserveSubstantiveAssistantTail: params.preserveSubstantiveAssistantTail,
  };
  const withoutAssistantPrefill = stripTrailingAssistantPrefill(
    params.liveMessages,
    prefillOptions,
  );
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
  let liveTailMessages = trimMessagesToBudget(liveTail, remainingBudget, prefillOptions);
  if (liveTailMessages.length === 0 && liveTail.length > 0) {
    liveTailMessages = [liveTail[liveTail.length - 1]!];
  }
  liveTailMessages = buildProviderValidSuffix({
    messages: liveTail,
    retainedStartIndex: liveTail.length - liveTailMessages.length,
    preserveSubstantiveAssistantTail: params.preserveSubstantiveAssistantTail,
  });
  const messages = [...protectedPrefix, ...liveTailMessages];
  return {
    messages,
    estimatedTokens: estimateAgentMessageTokens(messages),
    promptAuthority: "preassembly_may_overflow",
    contextProjection: params.contextProjection,
  };
}

/**
 * Resolve deferred compaction pressure from the canonical stored projection.
 *
 * Debt-time current and projected counts remain diagnostic because compaction
 * can make them stale. Only the current `context_items` total decides whether
 * another assemble-time drain could reduce the model context.
 */
export function resolveDeferredAssemblyPressure(params: {
  storedContextTokens: number;
  maintenance: ConversationCompactionMaintenanceRecord | null;
}): {
  storedContextTokens: number;
  projectedTokenCount: number | null;
  pressureTokenCount: number;
} {
  const recordedProjectedTokens = normalizeNonNegativeInteger(
    params.maintenance?.projectedTokenCount,
  );
  return {
    storedContextTokens: params.storedContextTokens,
    projectedTokenCount: recordedProjectedTokens ?? null,
    pressureTokenCount: params.storedContextTokens,
  };
}

export function buildForkBoundedLiveFallback(params: {
  liveMessages: AgentMessage[];
  forkSourceMessageCount: number;
  tokenBudget: number;
  bootstrapMaxTokens: number;
  preserveSubstantiveAssistantTail?: boolean;
}): AssembleResult {
  const suffix = resolveForkBoundedLiveSuffix({
    assembledMessages: [],
    liveMessages: params.liveMessages,
    forkSourceMessageCount: params.forkSourceMessageCount,
  });
  const candidateMessages = suffix.length > 0 ? suffix : params.liveMessages;
  const boundedMessages = omitLeadingOrphanedToolTurn(trimMessagesToBudget(
    candidateMessages,
    Math.min(params.tokenBudget, params.bootstrapMaxTokens),
    { preserveSubstantiveAssistantTail: params.preserveSubstantiveAssistantTail },
  ));
  return {
    messages: boundedMessages,
    estimatedTokens: estimateAgentMessageTokens(boundedMessages),
  };
}

/** Return the log level for fork-bounded live suffix append pressure. */
export function forkBoundedLiveSuffixAppendLogLevel(append: {
  evictedMessages: number;
  overBudget: boolean;
}): "warn" | "debug" {
  return append.overBudget || append.evictedMessages > 0 ? "warn" : "debug";
}

export function appendForkBoundedLiveSuffixWithinBudget(params: {
  assembledMessages: AgentMessage[];
  assembledEstimatedTokens: number;
  liveMessages: AgentMessage[];
  forkSourceMessageCount: number;
  tokenBudget: number;
  preserveSubstantiveAssistantTail?: boolean;
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
    { preserveSubstantiveAssistantTail: params.preserveSubstantiveAssistantTail },
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
