/**
 * Canonical message identity/signature builders used for dedup, replay detection, and assembly protection.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { buildMessageParts, toStoredMessage, type StoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { canonicalizeOpenClawInboundMetadataIdentityContent } from "./openclaw-inbound-metadata.js";
import { isProviderUniqueToolCallId } from "./stable-event-key.js";
import type { CreateMessagePartInput } from "./store/conversation-store.js";
import { extractToolResultIdForPairing } from "./tool-pairing.js";
import { extractBootstrapMessageCandidate } from "./transcript.js";
import { createHash, randomUUID } from "node:crypto";

export function createBootstrapEntryHash(message: StoredMessage | null): string | null {
  if (!message) {
    return null;
  }
  const content = canonicalizeOpenClawInboundMetadataIdentityContent(
    message.role,
    message.content,
  );
  return createHash("sha256")
    .update(JSON.stringify({ role: message.role, content }))
    .digest("hex");
}

export function readBootstrapMessageFromJsonLine(line: string | null): AgentMessage | null {
  if (!line) {
    return null;
  }
  try {
    return extractBootstrapMessageCandidate(JSON.parse(line));
  } catch {
    return null;
  }
}

export function messageIdentity(role: string, content: string): string {
  return `${role}\u0000${content}`;
}

export function isBootstrapReplayCandidateMessage(message: AgentMessage): boolean {
  const role = toStoredMessage(message).role;
  return role === "assistant" || role === "tool";
}

export function createLosslessMessageSignature(message: AgentMessage): string {
  const stored = toStoredMessage(message);
  const parts = buildMessageParts({
    sessionId: "lossless-message-signature",
    message,
    fallbackContent: stored.content,
  });

  return JSON.stringify({
    role: stored.role,
    content: stored.content,
    parts: parts.map((part) => ({
      partType: part.partType,
      ordinal: part.ordinal,
      textContent: part.textContent ?? null,
      toolCallId: part.toolCallId ?? null,
      toolName: part.toolName ?? null,
      toolInput: part.toolInput ?? null,
      toolOutput: part.toolOutput ?? null,
      metadata: part.metadata ?? null,
    })),
  });
}

export function hashAgentMessageForAssemblyProtection(message: AgentMessage): string {
  return createHash("sha256").update(JSON.stringify([message])).digest("hex").slice(0, 16);
}

export function messagesHaveSameLosslessSignature(left: AgentMessage, right: AgentMessage): boolean {
  return createLosslessMessageSignature(left) === createLosslessMessageSignature(right);
}

export function createLiveCoverageSignature(message: AgentMessage): string {
  const stored = toStoredMessage(message);
  if (
    (stored.role === "user" || stored.role === "system" || stored.role === "assistant") &&
    stored.content.length > 0 &&
    isCanonicalTextOnlyMessage(message, stored.content)
  ) {
    return JSON.stringify({
      kind: "canonical-text",
      role: stored.role,
      content: stored.content,
    });
  }
  const canonicalToolTextSignature = createCanonicalToolTextCoverageSignature(
    message,
    stored.content,
  );
  if (canonicalToolTextSignature) {
    return canonicalToolTextSignature;
  }
  const canonicalEmptyToolResultSignature = createCanonicalEmptyToolResultCoverageSignature(
    message,
    stored.content,
  );
  if (canonicalEmptyToolResultSignature) {
    return canonicalEmptyToolResultSignature;
  }
  if (stored.role === "tool") {
    const pairingId = extractToolResultIdForPairing(message);
    if (pairingId && !isProviderUniqueToolCallId(pairingId)) {
      // Recurrent model-authored ids: the lossless signature contains no
      // occurrence identity, so two distinct events with identical content
      // ("(no output)") sign equal and a coverage consumer can elide a REAL
      // newer occurrence against an older assembled one. Without provenance
      // there is no in-message occurrence discriminator, so refuse to let
      // these events anchor coverage at all: double-emit is recoverable by
      // repair-time dedup; a sliced-away live event is not (P3).
      return JSON.stringify({
        kind: "recurrent-tool-event",
        toolCallId: pairingId,
        nonce: randomUUID(),
      });
    }
  }
  return createLosslessMessageSignature(message);
}

export function normalizeToolNameForCoverage(toolName: string | null | undefined): string | null {
  // The assembler fills missing tool names with "unknown" on rehydration.
  // Treat null/undefined/""/"unknown" as equivalent for coverage matching
  // so live and assembled tool-result signatures still match.
  if (!toolName || toolName === "unknown") {
    return null;
  }
  return toolName;
}

export function createCanonicalToolTextCoverageSignature(
  message: AgentMessage,
  fallbackContent: string,
): string | undefined {
  const stored = toStoredMessage(message);
  if (stored.role !== "tool" || fallbackContent.length === 0) {
    return undefined;
  }
  const parts = buildMessageParts({
    sessionId: "live-tool-coverage-signature",
    message,
    fallbackContent,
  });
  if (parts.length !== 1) {
    return undefined;
  }
  const part = parts[0] as CreateMessagePartInput;
  if (
    part.partType !== "text" ||
    (part.textContent ?? "") !== fallbackContent ||
    part.toolInput != null ||
    part.toolOutput != null
  ) {
    return undefined;
  }
  const toolCallId = part.toolCallId ?? extractToolResultIdForPairing(message) ?? null;
  if (toolCallId && !isProviderUniqueToolCallId(toolCallId)) {
    // Model-authored recurrent ids (Kimi K3 `name:N`) are not event-unique:
    // equal content + equal id across DISTINCT events would collapse their
    // coverage signatures and let an older occurrence prove coverage of a
    // newer one. Fall back to the full lossless signature instead.
    return undefined;
  }
  return JSON.stringify({
    kind: "canonical-tool-text",
    role: stored.role,
    content: fallbackContent,
    toolCallId,
    toolName: normalizeToolNameForCoverage(part.toolName),
  });
}

/**
 * Canonical coverage identity for a tool-result message whose effective text
 * is EMPTY. The empty-content ingest fallback (issue #992) persists a single
 * identity-carrying "tool" part for `{content: [], details: …}` shapes, and
 * assembly rehydrates that part into a `{type:"tool_result", output:" "}`
 * block — the same logical result then appears under three raw shapes (live
 * empty content, live single tool_result block, assembled block), each of
 * which would otherwise hash to a different lossless parts-JSON and be
 * double-emitted side by side by live-coverage dedup. Canonicalize all three
 * onto the same key: (role, toolCallId) — toolName is intentionally omitted
 * because it may be present on the DB round-trip representation and absent
 * on the live transcript block, while toolCallId is the unique pairing identity.
 */
export function createCanonicalEmptyToolResultCoverageSignature(
  message: AgentMessage,
  fallbackContent: string,
): string | undefined {
  const stored = toStoredMessage(message);
  if (stored.role !== "tool") {
    return undefined;
  }
  const parts = buildMessageParts({
    sessionId: "live-empty-tool-coverage-signature",
    message,
    fallbackContent,
  });
  if (parts.length !== 1) {
    return undefined;
  }
  const part = parts[0] as CreateMessagePartInput;
  // Two rehydrations of the same logical empty result are valid: the legacy
  // "tool" part (pre-#1054-round-2 DB rows, plus single-tool_result-block
  // live shapes) and the provider-facing plain text part the empty-content
  // fallback now assembles into. Reject anything else.
  if (part.toolInput != null) {
    return undefined;
  }
  const toolCallId = part.toolCallId ?? extractToolResultIdForPairing(message) ?? null;
  if (part.partType === "text") {
    // Whitespace-only text on a tool-result message: the text-block
    // rehydration of the empty-content fallback (#992). After a DB round-trip
    // the reconstructed part may carry metadata.originalRole:"toolResult"
    // with rawType:"text" (no longer tool-shaped), so gate on the message
    // role + whitespace content instead of tool-part shape.
    if ((part.textContent ?? "").trim() !== "") {
      return undefined;
    }
    if (stored.role !== "tool" && stored.role !== "toolResult") {
      return undefined;
    }
    if (!toolCallId) {
      return undefined;
    }
  } else if (part.partType === "tool") {
    // Effective text must be empty: the fallback sentinel " " or an output
    // column holding only whitespace — never a real payload.
    if (!isEffectivelyEmptyToolResultPart(part, fallbackContent)) {
      return undefined;
    }
    if (!isToolResultShapedPart(part)) {
      return undefined;
    }
  } else {
    return undefined;
  }
  if (!toolCallId) {
    // Identity-less results cannot be canonicalized without collision risk:
    // two distinct id-less results would otherwise map to the same key and
    // one side could be silently swallowed by coverage dedup.
    return undefined;
  }
  if (!isProviderUniqueToolCallId(toolCallId)) {
    // Model-authored ids (Kimi K3 `name:N` counters) recur across turns, so
    // (role, toolCallId) does NOT identify an event: an id-less content match
    // here would let coverage consumers (e.g. resolveForkBoundedLiveSuffix)
    // treat an OLDER occurrence as proof a NEWER occurrence is covered and
    // slice real events out of the request. Restrict the canonical shortcut
    // to provider-unique ids; everything else keeps the full lossless
    // signature, preferring a possible double-emit over a silent suppression.
    return undefined;
  }
  // toolName is intentionally omitted from the key: the same logical result
  // may appear with a top-level toolName (DB round-trip) or without one
  // (live transcript block only), and a provider-unique toolCallId is then
  // an event-unique pairing identity — two results with the same provider-
  // unique toolCallId ARE the same event.
  return JSON.stringify({
    kind: "canonical-empty-tool-result",
    role: stored.role,
    toolCallId,
  });
}

function isEffectivelyEmptyToolResultPart(
  part: CreateMessagePartInput,
  fallbackContent: string,
): boolean {
  if (fallbackContent.trim() !== "") {
    return false;
  }
  const textContentEmpty = (part.textContent ?? "").trim() === "";
  if (!textContentEmpty) {
    return false;
  }
  const toolOutput = part.toolOutput;
  if (toolOutput != null) {
    // toolOutput may be a JSON-quoted string (e.g. '" "').
    try {
      const parsed: unknown = JSON.parse(toolOutput);
      if (typeof parsed === "string") {
        if (parsed.trim() !== "") {
          return false;
        }
      } else {
        // Non-string toolOutput means there is a real payload.
        return false;
      }
    } catch {
      if (toolOutput.trim() !== "") {
        return false;
      }
    }
  }
  // Check metadata.raw for a content-bearing tool_result block. A part with
  // null textContent and null toolOutput may still carry a real payload in
  // metadata.raw.content (e.g. {type:"tool_result", content:[{type:"text",
  // text:"real output"}]}). Declaring such a part "empty" would canonicalize
  // it by call ID alone and let coverage dedup suppress a richer live
  // representation.
  let metadata: Record<string, unknown> | null = null;
  try {
    metadata = part.metadata ? (JSON.parse(part.metadata) as Record<string, unknown>) : null;
  } catch {
    return true;
  }
  if (!metadata) {
    return true;
  }
  const raw = metadata.raw;
  if (!raw || typeof raw !== "object") {
    return true;
  }
  const rawRecord = raw as Record<string, unknown>;
  // Check raw.content and raw.output for any payload.
  if (rawRecord.content != null) {
    return false;
  }
  if (rawRecord.output != null && String(rawRecord.output).trim() !== "") {
    return false;
  }
  return true;
}

function isToolResultShapedPart(part: CreateMessagePartInput): boolean {
  let metadata: Record<string, unknown> | null = null;
  try {
    metadata = part.metadata ? (JSON.parse(part.metadata) as Record<string, unknown>) : null;
  } catch {
    return false;
  }
  if (!metadata || typeof metadata !== "object") {
    return false;
  }
  if (metadata.emptyContentFallback === true) {
    return true;
  }
  const originalRole = metadata.originalRole;
  if (originalRole !== "toolResult" && originalRole !== "tool") {
    return false;
  }
  const rawType = metadata.rawType;
  if (
    rawType === "tool_result" ||
    rawType === "toolResult" ||
    rawType === "function_call_output"
  ) {
    return true;
  }
  const raw = metadata.raw;
  if (raw && typeof raw === "object") {
    const rawBlockType = (raw as { type?: unknown }).type;
    if (
      rawBlockType === "tool_result" ||
      rawBlockType === "toolResult" ||
      rawBlockType === "function_call_output"
    ) {
      return true;
    }
  }
  return false;
}

export function isCanonicalTextOnlyMessage(message: AgentMessage, fallbackContent: string): boolean {
  const parts = buildMessageParts({
    sessionId: "live-coverage-signature",
    message,
    fallbackContent,
  });
  if (parts.length !== 1) {
    return false;
  }
  const part = parts[0] as CreateMessagePartInput;
  return (
    part.partType === "text" &&
    (part.textContent ?? "") === fallbackContent &&
    part.toolCallId == null &&
    part.toolName == null &&
    part.toolInput == null &&
    part.toolOutput == null
  );
}

export function messagesHaveSameLiveCoverageSignature(left: AgentMessage, right: AgentMessage): boolean {
  return createLiveCoverageSignature(left) === createLiveCoverageSignature(right);
}
