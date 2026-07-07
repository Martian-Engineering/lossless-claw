/**
 * Volatile live-input coverage matching: reconciles unsaved live messages against the assembled prefix at prompt time.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { contentFromParts } from "./assembler.js";
import { buildMessageParts, toStoredMessage, toSyntheticMessagePartRecord } from "./message-content.js";
import { createLiveCoverageSignature, hashAgentMessageForAssemblyProtection, messagesHaveSameLiveCoverageSignature } from "./message-signatures.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { stripLeadingOpenClawInboundTimestamp } from "./openclaw-inbound-metadata.js";
import { estimateAgentMessageTokens } from "./token-accounting.js";
import { buildToolPairIndexesByAssembledIndex, expandProtectedToolPairIndexes, expandToolPairLiveSortIndexes } from "./tool-pairing.js";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import { open } from "node:fs/promises";

export type RepairLogger = { warn: (message: string) => void };

export function normalizeSummaryOverlapText(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}

export function messageContentCoveredBySummary(params: {
  message: AgentMessage;
  summary: string;
}): boolean {
  const content = normalizeSummaryOverlapText(toStoredMessage(params.message).content);
  if (content.length < 24) {
    return false;
  }
  const summary = normalizeSummaryOverlapText(params.summary);
  if (!summary.includes(content)) {
    return false;
  }
  // Bare substring match is too loose: a 24+ char user instruction can
  // coincidentally appear inside a long narrative summary and get silently
  // dropped. Require one of:
  //   1. content appears at the very start or end of the summary, OR
  //   2. content appears inside a quoted block — double quotes ("..."),
  //      single quotes ('...'), or backticks (`...`). All three quote
  //      styles survive normalization and are emitted by the summarizer
  //      when it embeds verbatim user text.
  // Otherwise treat it as a coincidental collision and keep the message.
  if (summary.startsWith(content) || summary.endsWith(content)) {
    return true;
  }
  // Walk each quote-delimited span (cheap; summaries are bounded) and check
  // membership. Use double-quoted literals to match the rest of the file.
  for (const quoteChar of ["\"", "'", "`"]) {
    let cursor = 0;
    while (cursor < summary.length) {
      const open = summary.indexOf(quoteChar, cursor);
      if (open < 0) break;
      const close = summary.indexOf(quoteChar, open + 1);
      if (close < 0) {
        // Unmatched opening quote: don't break out of the entire scan —
        // a later well-formed quoted span may still contain the content.
        // Skip past this lone opener and continue.
        cursor = open + 1;
        continue;
      }
      const span = summary.slice(open + 1, close);
      if (span.includes(content)) {
        return true;
      }
      cursor = close + 1;
    }
  }
  return false;
}

export const INTER_SESSION_MESSAGE_MARKER = "[Inter-session message]";

export const INTERNAL_CONTEXT_BEGIN_MARKER = "<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>";

export const INTERNAL_CONTEXT_END_MARKER = "<<<END_OPENCLAW_INTERNAL_CONTEXT>>>";

export const INTERNAL_TASK_COMPLETION_EVENT_MARKER = "[Internal task completion event]";

export const FALLBACK_RETRY_PROMPT_MARKER =
  "[Retry after the previous model attempt failed or timed out]";

export const NORMALIZED_INTER_SESSION_MESSAGE_MARKER = normalizeSummaryOverlapText(INTER_SESSION_MESSAGE_MARKER);

export const NORMALIZED_INTERNAL_TASK_COMPLETION_EVENT_MARKER = normalizeSummaryOverlapText(
  INTERNAL_TASK_COMPLETION_EVENT_MARKER,
);

export function hasFallbackRetryPromptMarker(content: string): boolean {
  return content.split(/\r?\n/).some((line) => line.trim() === FALLBACK_RETRY_PROMPT_MARKER);
}

export function hasCompleteInternalContextBlock(content: string): boolean {
  const beginIndex = content.indexOf(INTERNAL_CONTEXT_BEGIN_MARKER);
  if (beginIndex < 0) {
    return false;
  }
  return (
    content.indexOf(
      INTERNAL_CONTEXT_END_MARKER,
      beginIndex + INTERNAL_CONTEXT_BEGIN_MARKER.length,
    ) >= 0
  );
}

export function isVolatileLiveInputContent(content: string): boolean {
  const trimmed = content.trimStart();
  if (hasFallbackRetryPromptMarker(trimmed)) {
    return true;
  }
  if (!hasCompleteInternalContextBlock(trimmed)) {
    return false;
  }
  const normalized = normalizeSummaryOverlapText(trimmed);
  if (normalized.startsWith(NORMALIZED_INTER_SESSION_MESSAGE_MARKER)) {
    return true;
  }
  return (
    trimmed.startsWith(INTERNAL_CONTEXT_BEGIN_MARKER) &&
    normalized.includes(NORMALIZED_INTERNAL_TASK_COMPLETION_EVENT_MARKER)
  );
}

export function stripTrailingAssistantPrefill(messages: AgentMessage[]): AgentMessage[] {
  const trimmed = messages.slice();
  while (trimmed.length > 0 && trimmed[trimmed.length - 1]?.role === "assistant") {
    trimmed.pop();
  }
  return trimmed;
}

export function isVolatileLiveInputMessage(message: AgentMessage): boolean {
  const stored = toStoredMessage(message);
  if (stored.role !== "user" && stored.role !== "system") {
    return false;
  }
  if (!stored.content.trim()) {
    return false;
  }
  return isVolatileLiveInputContent(stored.content);
}

export function normalizeLiveMessageForAssemblyReconciliation(message: AgentMessage): AgentMessage {
  const stored = toStoredMessage(message);
  if (stored.role !== "system" && stored.role !== "tool") {
    return message;
  }
  const runtimeRole = stored.role === "system" ? "user" : "toolResult";
  const parts =
    "content" in message
      ? buildMessageParts({
          sessionId: "live-reconciliation",
          message,
          fallbackContent: stored.content,
        }).map((part) => toSyntheticMessagePartRecord(part, 0))
      : [];
  const content = contentFromParts(parts, runtimeRole, stored.content);
  return {
    ...message,
    role: runtimeRole,
    content,
  } as AgentMessage;
}

export function countNonOverlappingOccurrences(params: {
  haystack: string;
  needle: string;
}): number {
  if (!params.needle) {
    return 0;
  }
  let count = 0;
  let cursor = 0;
  while (cursor <= params.haystack.length) {
    const found = params.haystack.indexOf(params.needle, cursor);
    if (found < 0) {
      break;
    }
    count++;
    cursor = found + params.needle.length;
  }
  return count;
}

export function liveInputCoverageCapacity(params: {
  assembledMessage: AgentMessage;
  liveMessage: AgentMessage;
  /**
   * When true, the live message is a volatile input that was never persisted to
   * DB. Summary substring coverage is insufficient for such messages because a
   * summary that contains similar text is summarizing a *past* turn — it does
   * not prove the current turn's volatile input is already represented.
   */
  isVolatileLiveInput?: boolean;
}): number {
  const assembled = toStoredMessage(params.assembledMessage);
  const live = toStoredMessage(params.liveMessage);
  if (messagesHaveSameLiveCoverageSignature(params.assembledMessage, params.liveMessage)) {
    return 1;
  }

  // Volatile live inputs are never persisted to DB. A summary containing
  // similar text covers a *past* occurrence, not the current live input.
  // Only exact assembled message matches (handled above) can cover a
  // volatile input — a historical summary paraphrase is insufficient.
  if (params.isVolatileLiveInput) {
    return 0;
  }

  // Substring coverage is only safe for LCM summary wrappers. Raw assembled
  // turns must match exactly, otherwise normalized near-matches can hide a
  // distinct volatile live input.
  if (!assembled.content.includes("<summary ") || !assembled.content.includes("</summary>")) {
    return 0;
  }

  const liveText = normalizeSummaryOverlapText(live.content);
  if (liveText.length < 24) {
    return 0;
  }
  const assembledText = normalizeSummaryOverlapText(assembled.content);
  return countNonOverlappingOccurrences({ haystack: assembledText, needle: liveText });
}

export function isSummaryWrapperContent(content: string): boolean {
  return content.includes("<summary ") && content.includes("</summary>");
}

export type VolatileLiveInputEntry = {
  message: AgentMessage;
  liveIndex: number;
};

export type VolatileLiveInputCandidate = VolatileLiveInputEntry & {
  liveText: string;
};

export type VolatileLiveInputCoverageSlot = {
  assembledIndex: number;
};

export type RetainedAssembledEntry = {
  message: AgentMessage;
  index: number;
};

export function materializeVolatileLiveInputEntries(entries: VolatileLiveInputEntry[]): AgentMessage[] {
  return entries
    .slice()
    .sort((a, b) => a.liveIndex - b.liveIndex)
    .map((entry) => entry.message);
}

export function resolveProtectedFreshTailAssembledIndexes(params: {
  assembledMessages: AgentMessage[];
  freshTailMessageHashes?: string[];
}): Set<number> {
  const protectedIndexes = new Set<number>();
  const usedIndexes = new Set<number>();
  for (const hash of params.freshTailMessageHashes ?? []) {
    for (let index = params.assembledMessages.length - 1; index >= 0; index--) {
      if (usedIndexes.has(index)) {
        continue;
      }
      const message = params.assembledMessages[index] as AgentMessage;
      if (hashAgentMessageForAssemblyProtection(message) === hash) {
        protectedIndexes.add(index);
        usedIndexes.add(index);
        break;
      }
    }
  }
  return protectedIndexes;
}

export function resolveExactAssembledLiveSortIndexes(params: {
  assembledMessages: AgentMessage[];
  liveMessages: AgentMessage[];
}): Map<number, number> {
  const liveSortIndexes = new Map<number, number>();
  const usedAssembledIndexes = new Set<number>();
  for (let liveIndex = params.liveMessages.length - 1; liveIndex >= 0; liveIndex--) {
    const liveMessage = params.liveMessages[liveIndex] as AgentMessage;
    for (
      let assembledIndex = params.assembledMessages.length - 1;
      assembledIndex >= 0;
      assembledIndex--
    ) {
      if (usedAssembledIndexes.has(assembledIndex)) {
        continue;
      }
      const assembledMessage = params.assembledMessages[assembledIndex] as AgentMessage;
      if (messagesHaveSameLiveCoverageSignature(assembledMessage, liveMessage)) {
        liveSortIndexes.set(assembledIndex, liveIndex);
        usedAssembledIndexes.add(assembledIndex);
        break;
      }
    }
  }
  return liveSortIndexes;
}

export function mergeCoveredVolatileLiveSortIndexes(params: {
  exactLiveSortIndexes: Map<number, number>;
  coveredEntriesByAssembledIndex: Map<number, VolatileLiveInputEntry[]>;
}): Map<number, number> {
  const liveSortIndexes = new Map(params.exactLiveSortIndexes);
  for (const [assembledIndex, entries] of params.coveredEntriesByAssembledIndex.entries()) {
    const coveredLiveIndex = Math.min(...entries.map((entry) => entry.liveIndex));
    const existingLiveIndex = liveSortIndexes.get(assembledIndex);
    if (existingLiveIndex === undefined || coveredLiveIndex < existingLiveIndex) {
      liveSortIndexes.set(assembledIndex, coveredLiveIndex);
    }
  }
  return liveSortIndexes;
}

export function buildVolatileLiveInputMergedOutput(params: {
  retained: RetainedAssembledEntry[];
  appendedEntries: VolatileLiveInputEntry[];
  liveSortIndexes: Map<number, number>;
  log?: RepairLogger;
}): AgentMessage[] {
  const output: AgentMessage[] = [];
  const appendedEntries = params.appendedEntries
    .slice()
    .sort((left, right) => left.liveIndex - right.liveIndex);
  let appendedCursor = 0;
  for (const retainedEntry of params.retained) {
    const retainedLiveIndex = params.liveSortIndexes.get(retainedEntry.index);
    if (retainedLiveIndex !== undefined) {
      while (
        appendedCursor < appendedEntries.length &&
        (appendedEntries[appendedCursor] as VolatileLiveInputEntry).liveIndex < retainedLiveIndex
      ) {
        output.push((appendedEntries[appendedCursor] as VolatileLiveInputEntry).message);
        appendedCursor++;
      }
    }
    output.push(retainedEntry.message);
  }
  while (appendedCursor < appendedEntries.length) {
    output.push((appendedEntries[appendedCursor] as VolatileLiveInputEntry).message);
    appendedCursor++;
  }
  return sanitizeToolUseResultPairing(output, params.log) as AgentMessage[];
}

export function matchVolatileLiveInputsToCoverageSlots(params: {
  assembledMessages: AgentMessage[];
  volatileLiveInputs: VolatileLiveInputCandidate[];
}): Map<number, number> {
  const entryIndexesByLiveText = new Map<string, number[]>();
  for (let entryIndex = 0; entryIndex < params.volatileLiveInputs.length; entryIndex++) {
    const entry = params.volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate;
    const entryIndexes = entryIndexesByLiveText.get(entry.liveText);
    if (entryIndexes) {
      entryIndexes.push(entryIndex);
    } else {
      entryIndexesByLiveText.set(entry.liveText, [entryIndex]);
    }
  }

  const slots: VolatileLiveInputCoverageSlot[] = [];
  const candidateSlotIndexesByEntryIndex = params.volatileLiveInputs.map(() => [] as number[]);
  const addCandidateSlots = (entryIndexes: number[], assembledIndex: number, slotCount: number) => {
    const slotIndexes: number[] = [];
    for (let slotOffset = 0; slotOffset < slotCount; slotOffset++) {
      slotIndexes.push(slots.length);
      slots.push({ assembledIndex });
    }
    for (const entryIndex of entryIndexes) {
      candidateSlotIndexesByEntryIndex[entryIndex]?.push(...slotIndexes);
    }
  };

  for (const [liveText, entryIndexes] of entryIndexesByLiveText.entries()) {
    for (let assembledIndex = 0; assembledIndex < params.assembledMessages.length; assembledIndex++) {
      const assembledMessage = params.assembledMessages[assembledIndex] as AgentMessage;
      const assembled = toStoredMessage(assembledMessage);
      if (!isSummaryWrapperContent(assembled.content)) {
        const exactEntryIndexes = entryIndexes.filter((entryIndex) =>
          messagesHaveSameLiveCoverageSignature(
            assembledMessage,
            (params.volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate).message,
          )
        );
        if (exactEntryIndexes.length > 0) {
          addCandidateSlots(exactEntryIndexes, assembledIndex, 1);
        }
        continue;
      }

      const representativeEntry = params.volatileLiveInputs[entryIndexes[0] as number] as VolatileLiveInputCandidate;
      const capacity = liveInputCoverageCapacity({
        assembledMessage,
        liveMessage: representativeEntry.message,
        isVolatileLiveInput: true,
      });
      if (capacity <= 0) {
        continue;
      }

      const entryIndexesBySignature = new Map<string, number[]>();
      for (const entryIndex of entryIndexes) {
        const entry = params.volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate;
        const signature = createLiveCoverageSignature(entry.message);
        const signatureEntryIndexes = entryIndexesBySignature.get(signature);
        if (signatureEntryIndexes) {
          signatureEntryIndexes.push(entryIndex);
        } else {
          entryIndexesBySignature.set(signature, [entryIndex]);
        }
      }

      let exactSlotCount = 0;
      for (const signatureEntryIndexes of entryIndexesBySignature.values()) {
        const firstEntry = params.volatileLiveInputs[signatureEntryIndexes[0] as number] as VolatileLiveInputCandidate;
        const liveContent = toStoredMessage(firstEntry.message).content;
        const exactCapacity = liveContent
          ? countNonOverlappingOccurrences({ haystack: assembled.content, needle: liveContent })
          : 0;
        const slotCount = Math.min(exactCapacity, signatureEntryIndexes.length);
        if (slotCount > 0) {
          addCandidateSlots(signatureEntryIndexes, assembledIndex, slotCount);
          exactSlotCount += slotCount;
        }
      }

      const genericSlotCount = Math.min(
        Math.max(0, capacity - exactSlotCount),
        Math.max(0, entryIndexes.length - exactSlotCount),
      );
      if (genericSlotCount > 0) {
        addCandidateSlots(entryIndexes, assembledIndex, genericSlotCount);
      }
    }
  }

  const slotToEntryIndex = new Map<number, number>();
  const tryAssignEntry = (entryIndex: number, visitedSlots: Set<number>): boolean => {
    const candidateSlotIndexes = candidateSlotIndexesByEntryIndex[entryIndex] ?? [];
    for (const slotIndex of candidateSlotIndexes) {
      if (visitedSlots.has(slotIndex)) {
        continue;
      }
      visitedSlots.add(slotIndex);
      const currentEntryIndex = slotToEntryIndex.get(slotIndex);
      if (
        currentEntryIndex === undefined ||
        tryAssignEntry(currentEntryIndex, visitedSlots)
      ) {
        slotToEntryIndex.set(slotIndex, entryIndex);
        return true;
      }
    }
    return false;
  };

  for (let entryIndex = 0; entryIndex < params.volatileLiveInputs.length; entryIndex++) {
    tryAssignEntry(entryIndex, new Set<number>());
  }

  const entryToAssembledIndex = new Map<number, number>();
  for (const [slotIndex, entryIndex] of slotToEntryIndex.entries()) {
    const slot = slots[slotIndex] as VolatileLiveInputCoverageSlot;
    entryToAssembledIndex.set(entryIndex, slot.assembledIndex);
  }
  return entryToAssembledIndex;
}

/**
 * Structural containment primitive: is the bare body the live content itself, or
 * its line-aligned trailing segment? This is the current-turn recognition used
 * by the append path — it carries NO knowledge of any plugin/decoration tag or
 * preamble shape. The bare body matches when, after stripping an optional single
 * leading channel timestamp from both sides:
 *   1. it equals the (trim-ended) live content, OR
 *   2. it is the final line of the live content (optionally with a per-line
 *      leading channel timestamp on that final line), OR
 *   3. (multi-line bare bodies) it is the trailing segment after a clean line
 *      boundary, optionally preceded by a single channel timestamp on the same
 *      final line.
 * The line boundary is the fail-closed guard: a coincidental mid-line substring
 * of the live content never matches, so distinct turns are never collapsed.
 */
export function liveContentContainsBareBody(params: {
  liveContent: string;
  bareContent: string;
}): boolean {
  const bareRaw = params.bareContent.trim();
  if (bareRaw.length === 0) {
    return false;
  }
  // Normalize a leading channel timestamp off the bare body so a bare row
  // persisted with OR without the "[... GMT ...]" prefix aligns identically.
  const bare = stripLeadingOpenClawInboundTimestamp(bareRaw).trim();
  if (bare.length === 0) {
    return false;
  }
  const liveTrimmed = params.liveContent.trimEnd();
  if (liveTrimmed === bareRaw || stripLeadingOpenClawInboundTimestamp(liveTrimmed) === bare) {
    return true;
  }
  // The bare body is the LAST user line(s) of the decorated live content. Match
  // the trailing segment after the final newline boundary, also allowing a
  // per-line leading timestamp on that trailing segment.
  const lastNewline = liveTrimmed.lastIndexOf("\n");
  if (lastNewline < 0) {
    return false;
  }
  const trailingLine = liveTrimmed.slice(lastNewline + 1);
  if (trailingLine === bareRaw || stripLeadingOpenClawInboundTimestamp(trailingLine) === bare) {
    return true;
  }
  // Multi-line bare bodies: require a clean line boundary before the bare body,
  // optionally with a leading timestamp immediately before it.
  if (liveTrimmed.endsWith(`\n${bareRaw}`)) {
    return true;
  }
  const timestampedSuffixIndex = liveTrimmed.length - bare.length;
  if (timestampedSuffixIndex > 0 && liveTrimmed.endsWith(bare)) {
    const before = liveTrimmed.slice(0, timestampedSuffixIndex);
    // The text immediately preceding the bare body must be a line boundary,
    // possibly followed by a single channel timestamp on the same final line.
    if (/\n[ \t]*$/.test(before)) {
      return true;
    }
    const lineStart = before.lastIndexOf("\n") + 1;
    const prefixOnFinalLine = before.slice(lineStart);
    if (
      prefixOnFinalLine.length > 0 &&
      stripLeadingOpenClawInboundTimestamp(prefixOnFinalLine).trim().length === 0
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Recognize whether `liveContent` is the bare body wrapped in RECOGNIZED
 * decoration (the decorated, model-facing face of the same turn as
 * `bareContent`), as opposed to an unrelated turn that merely ends with the
 * same trailing line. It must structurally contain the bare body (line-aligned
 * trailing segment) AND carry recognized decoration evidence:
 *   - the bare body appears as a CHANNEL-TIMESTAMP-prefixed trailing line (the
 *     channel always stamps the model-facing body), OR
 *   - the whole content reduces to the bare body once a single leading channel
 *     timestamp is stripped.
 * Metadata blocks are intentionally not trusted as decoration evidence here:
 * until OpenClaw provides a non-user-forgeable marker, a structured
 * "(untrusted metadata)" frame remains ordinary user-controlled text.
 * Arbitrary user text has none of the timestamp evidence, so it is never
 * collapsed, preventing silent data loss.
 */
export function liveContentIsRecognizedDecoratedBareBody(params: {
  liveContent: string;
  bareContent: string;
}): boolean {
  if (!liveContentContainsBareBody(params)) {
    return false;
  }
  const bareNoTimestamp = stripLeadingOpenClawInboundTimestamp(params.bareContent.trim()).trim();
  if (bareNoTimestamp.length === 0) {
    return false;
  }
  const liveTrimmed = params.liveContent.trimEnd();
  const liveLeadingTrimmed = liveTrimmed.trimStart();
  const liveWithoutTimestamp = stripLeadingOpenClawInboundTimestamp(liveLeadingTrimmed);
  if (
    liveWithoutTimestamp !== liveLeadingTrimmed &&
    liveWithoutTimestamp.trim() === bareNoTimestamp
  ) {
    return true;
  }
  const timestampedSuffixIndex = liveTrimmed.length - bareNoTimestamp.length;
  if (timestampedSuffixIndex > 0 && liveTrimmed.endsWith(bareNoTimestamp)) {
    const before = liveTrimmed.slice(0, timestampedSuffixIndex);
    const lineStart = before.lastIndexOf("\n") + 1;
    const prefixOnFinalLine = before.slice(lineStart);
    if (
      prefixOnFinalLine.length > 0 &&
      stripLeadingOpenClawInboundTimestamp(prefixOnFinalLine).trim().length === 0
    ) {
      return true;
    }
  }
  const lastNewline = liveTrimmed.lastIndexOf("\n");
  const trailingLine = lastNewline < 0 ? liveTrimmed : liveTrimmed.slice(lastNewline + 1);
  const trailingWithoutTimestamp = stripLeadingOpenClawInboundTimestamp(trailingLine);
  return (
    trailingWithoutTimestamp !== trailingLine &&
    trailingWithoutTimestamp.trim() === bareNoTimestamp
  );
}

/**
 * Recognize whether an assembled user row is a BARE copy of the live current
 * turn (its persisted face): it must be a line-aligned trailing segment of the
 * live content, strictly shorter than it, AND the live content must carry
 * recognized decoration (see liveContentIsRecognizedDecoratedBareBody). The
 * strictly-shorter guard distinguishes a bare/timestamped body row from the
 * decorated live copy itself (equal length, never collapsed); the decoration
 * gate prevents collapsing an unrelated turn that merely ends with the same
 * trailing line.
 */
function assembledRowIsStructuralBareCurrentTurn(params: {
  liveContent: string;
  assembledContent: string;
}): boolean {
  if (params.assembledContent === params.liveContent) {
    return false;
  }
  if (params.assembledContent.length >= params.liveContent.length) {
    return false;
  }
  return liveContentIsRecognizedDecoratedBareBody({
    liveContent: params.liveContent,
    bareContent: params.assembledContent,
  });
}

/**
 * The current turn is the LAST live user message. Recognize it as a volatile
 * live input — even when it carries no Telegram/Slack-style preamble and no
 * recognizable marker (e.g. the webchat memory-blocks-first shape) — whenever it
 * structurally CONTAINS a bare assembled user body (see liveContentContainsBare
 * Body). This is the plugin-agnostic generalization of isVolatileLiveInput
 * Message: instead of matching decoration shapes, it matches the invariant that
 * the live current turn is the decorated face of a bare store row. Fail-closed:
 * a last-user message that contains no bare assembled body is NOT recognized
 * here (so it is only treated as volatile if a marker/preamble gate already says
 * so).
 */
function resolveStructuralCurrentTurnLiveIndex(params: {
  assembledMessages: AgentMessage[];
  liveMessages: AgentMessage[];
}): number | null {
  for (let liveIndex = params.liveMessages.length - 1; liveIndex >= 0; liveIndex--) {
    const stored = toStoredMessage(params.liveMessages[liveIndex] as AgentMessage);
    if (stored.role !== "user") {
      continue;
    }
    if (!stored.content.trim()) {
      return null;
    }
    for (const assembledMessage of params.assembledMessages) {
      const assembledStored = toStoredMessage(assembledMessage);
      if (assembledStored.role !== "user") {
        continue;
      }
      if (
        assembledRowIsStructuralBareCurrentTurn({
          liveContent: stored.content,
          assembledContent: assembledStored.content,
        })
      ) {
        return liveIndex;
      }
    }
    // Only the single last user message is the current turn.
    return null;
  }
  return null;
}

export function collectUncoveredVolatileLiveInputs(params: {
  assembledMessages: AgentMessage[];
  liveMessages: AgentMessage[];
}): {
  entries: VolatileLiveInputEntry[];
  estimatedTokens: number;
  coveredEntriesByAssembledIndex: Map<number, VolatileLiveInputEntry[]>;
} {
  const structuralCurrentTurnLiveIndex = resolveStructuralCurrentTurnLiveIndex({
    assembledMessages: params.assembledMessages,
    liveMessages: params.liveMessages,
  });
  const volatileLiveInputs = params.liveMessages
    .map((message, liveIndex) => ({ message, liveIndex }))
    .filter(
      (entry) =>
        isVolatileLiveInputMessage(entry.message) ||
        entry.liveIndex === structuralCurrentTurnLiveIndex,
    )
    .map((entry) => ({
      ...entry,
      liveText: normalizeSummaryOverlapText(toStoredMessage(entry.message).content),
    }));
  const uncovered: VolatileLiveInputEntry[] = [];
  const coveredEntriesByAssembledIndex = new Map<number, VolatileLiveInputEntry[]>();
  const entryToAssembledIndex = matchVolatileLiveInputsToCoverageSlots({
    assembledMessages: params.assembledMessages,
    volatileLiveInputs,
  });

  for (let entryIndex = 0; entryIndex < volatileLiveInputs.length; entryIndex++) {
    const entry = volatileLiveInputs[entryIndex] as VolatileLiveInputCandidate;
    const assembledIndex = entryToAssembledIndex.get(entryIndex);
    if (assembledIndex !== undefined) {
      const coveredEntries = coveredEntriesByAssembledIndex.get(assembledIndex);
      if (coveredEntries) {
        coveredEntries.push(entry);
      } else {
        coveredEntriesByAssembledIndex.set(assembledIndex, [entry]);
      }
    } else {
      uncovered.push(entry);
    }
  }

  return {
    entries: uncovered,
    estimatedTokens: estimateAgentMessageTokens(materializeVolatileLiveInputEntries(uncovered)),
    coveredEntriesByAssembledIndex,
  };
}

export function appendUncoveredVolatileLiveInputsWithinBudget(params: {
  assembledMessages: AgentMessage[];
  assembledEstimatedTokens: number;
  liveMessages: AgentMessage[];
  protectedAssembledIndexes?: Set<number>;
  tokenBudget: number;
  log?: RepairLogger;
}): {
  messages: AgentMessage[];
  estimatedTokens: number;
  appendedMessages: number;
  appendedTokens: number;
  evictedMessages: number;
  evictedTokens: number;
  overBudget: boolean;
} {
  const liveMessages = params.liveMessages.map(normalizeLiveMessageForAssemblyReconciliation);
  const protectedAssembledIndexes = expandProtectedToolPairIndexes({
    assembledMessages: params.assembledMessages,
    protectedAssembledIndexes: params.protectedAssembledIndexes ?? new Set<number>(),
  });
  const uncovered = collectUncoveredVolatileLiveInputs({
    assembledMessages: params.assembledMessages,
    liveMessages,
  });
  if (uncovered.entries.length === 0) {
    return {
      messages: params.assembledMessages,
      estimatedTokens: params.assembledEstimatedTokens,
      appendedMessages: 0,
      appendedTokens: 0,
      evictedMessages: 0,
      evictedTokens: 0,
      overBudget: params.assembledEstimatedTokens > params.tokenBudget,
    };
  }

  let retained = params.assembledMessages.map((message, index) => ({ message, index }));
  let appendedEntries = uncovered.entries.slice();
  const toolPairIndexesByIndex = buildToolPairIndexesByAssembledIndex(params.assembledMessages);
  const exactLiveSortIndexes = resolveExactAssembledLiveSortIndexes({
    assembledMessages: params.assembledMessages,
    liveMessages,
  });
  const exactLiveProtectedIndexes = expandProtectedToolPairIndexes({
    assembledMessages: params.assembledMessages,
    protectedAssembledIndexes: new Set(exactLiveSortIndexes.keys()),
  });
  const liveSortIndexes = expandToolPairLiveSortIndexes({
    assembledMessages: params.assembledMessages,
    liveSortIndexes: mergeCoveredVolatileLiveSortIndexes({
      exactLiveSortIndexes,
      coveredEntriesByAssembledIndex: uncovered.coveredEntriesByAssembledIndex,
    }),
  });
  let evictedMessages = 0;
  let evictedTokens = 0;
  let output = buildVolatileLiveInputMergedOutput({
    retained,
    appendedEntries,
    liveSortIndexes,
  });
  let estimatedTokens = estimateAgentMessageTokens(output);

  while (retained.length > 0 && estimatedTokens > params.tokenBudget) {
    let bestCandidate:
      | {
          evictAssembledIndexes: Set<number>;
          output: AgentMessage[];
          estimatedTokens: number;
          appendedEntries: VolatileLiveInputEntry[];
        }
      | undefined;
    for (let evictIndex = 0; evictIndex < retained.length; evictIndex++) {
      const entry = retained[evictIndex] as RetainedAssembledEntry;
      const evictAssembledIndexes = toolPairIndexesByIndex.get(entry.index) ?? new Set([entry.index]);
      const candidateEvictsExactLiveTurn = Array.from(evictAssembledIndexes).some((index) =>
        exactLiveProtectedIndexes.has(index)
      );
      const candidateEvictsProtectedTurn = Array.from(evictAssembledIndexes).some((index) =>
        protectedAssembledIndexes.has(index)
      );
      if (candidateEvictsExactLiveTurn || candidateEvictsProtectedTurn) {
        continue;
      }
      const restoredCoveredEntries = Array.from(evictAssembledIndexes).flatMap(
        (index) => uncovered.coveredEntriesByAssembledIndex.get(index) ?? [],
      );
      const candidateRetained = retained.filter(
        (retainedEntry) => !evictAssembledIndexes.has(retainedEntry.index),
      );
      const candidateAppendedEntries =
        restoredCoveredEntries.length > 0
          ? [...appendedEntries, ...restoredCoveredEntries]
          : appendedEntries;
      const candidateOutput = buildVolatileLiveInputMergedOutput({
        retained: candidateRetained,
        appendedEntries: candidateAppendedEntries,
        liveSortIndexes,
      });
      const candidateEstimatedTokens = estimateAgentMessageTokens(candidateOutput);
      const candidateFits = candidateEstimatedTokens <= params.tokenBudget;
      const bestFits =
        bestCandidate !== undefined && bestCandidate.estimatedTokens <= params.tokenBudget;
      if (
        bestCandidate === undefined ||
        (candidateFits && !bestFits) ||
        (candidateFits &&
          bestFits &&
          candidateEstimatedTokens > bestCandidate.estimatedTokens) ||
        (!candidateFits &&
          !bestFits &&
          candidateEstimatedTokens < bestCandidate.estimatedTokens)
      ) {
        bestCandidate = {
          evictAssembledIndexes,
          output: candidateOutput,
          estimatedTokens: candidateEstimatedTokens,
          appendedEntries: candidateAppendedEntries,
        };
      }
    }
    if (!bestCandidate) {
      break;
    }
    const removedEntries = retained.filter((entry) =>
      bestCandidate.evictAssembledIndexes.has(entry.index),
    );
    retained = retained.filter((entry) => !bestCandidate.evictAssembledIndexes.has(entry.index));
    appendedEntries = bestCandidate.appendedEntries;
    for (const removed of removedEntries) {
      uncovered.coveredEntriesByAssembledIndex.delete(removed.index);
      evictedTokens += toStoredMessage(removed.message).tokenCount;
    }
    evictedMessages += removedEntries.length;
    output = bestCandidate.output;
    estimatedTokens = bestCandidate.estimatedTokens;
  }
  output = buildVolatileLiveInputMergedOutput({
    retained,
    appendedEntries,
    liveSortIndexes,
    log: params.log,
  });
  estimatedTokens = estimateAgentMessageTokens(output);
  const appendedMessages = materializeVolatileLiveInputEntries(appendedEntries);

  return {
    messages: output,
    estimatedTokens,
    appendedMessages: appendedMessages.length,
    appendedTokens: estimateAgentMessageTokens(appendedMessages),
    evictedMessages,
    evictedTokens,
    overBudget: estimatedTokens > params.tokenBudget,
  };
}

export function resolveForkBoundedLiveSuffix(params: {
  assembledMessages: AgentMessage[];
  liveMessages: AgentMessage[];
  forkSourceMessageCount: number;
}): AgentMessage[] {
  const liveMessages = params.liveMessages.map(normalizeLiveMessageForAssemblyReconciliation);
  const forkSourceMessageCount = Math.max(0, Math.floor(params.forkSourceMessageCount));
  const anchorSearchEnd =
    forkSourceMessageCount > 0
      ? Math.min(liveMessages.length, forkSourceMessageCount)
      : liveMessages.length;
  let anchorLiveIndex = -1;
  for (let liveIndex = anchorSearchEnd - 1; liveIndex >= 0; liveIndex--) {
    const liveMessage = liveMessages[liveIndex] as AgentMessage;
    for (
      let assembledIndex = params.assembledMessages.length - 1;
      assembledIndex >= 0;
      assembledIndex--
    ) {
      const assembledMessage = params.assembledMessages[assembledIndex] as AgentMessage;
      if (messagesHaveSameLiveCoverageSignature(assembledMessage, liveMessage)) {
        anchorLiveIndex = liveIndex;
        break;
      }
    }
    if (anchorLiveIndex >= 0) {
      break;
    }
  }

  if (anchorLiveIndex >= 0) {
    return liveMessages.slice(anchorLiveIndex + 1);
  }

  if (forkSourceMessageCount > 0 && liveMessages.length >= forkSourceMessageCount) {
    return liveMessages.slice(forkSourceMessageCount);
  }

  // If the host provides a short live snapshot rather than the copied fork
  // branch, keep that snapshot; it is no longer the raw parent prefix.
  if (forkSourceMessageCount > 0 && liveMessages.length < forkSourceMessageCount) {
    return liveMessages;
  }

  return [];
}
