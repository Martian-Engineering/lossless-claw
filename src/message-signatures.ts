/**
 * Canonical message identity/signature builders used for dedup, replay detection, and assembly protection.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { buildMessageParts, toStoredMessage, type StoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { canonicalizeOpenClawInboundMetadataIdentityContent } from "./openclaw-inbound-metadata.js";
import type { CreateMessagePartInput } from "./store/conversation-store.js";
import { extractToolResultIdForPairing } from "./tool-pairing.js";
import { extractBootstrapMessageCandidate } from "./transcript.js";
import { createHash } from "node:crypto";

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
  return JSON.stringify({
    kind: "canonical-tool-text",
    role: stored.role,
    content: fallbackContent,
    toolCallId: part.toolCallId ?? extractToolResultIdForPairing(message) ?? null,
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
  if (part.partType !== "tool" || part.toolInput != null) {
    return undefined;
  }
  // Effective text must be empty: the fallback sentinel " " or an output
  // column holding only whitespace — never a real payload.
  if (!isEffectivelyEmptyToolResultPart(part, fallbackContent)) {
    return undefined;
  }
  if (!isToolResultShapedPart(part)) {
    return undefined;
  }
  const toolCallId = part.toolCallId ?? extractToolResultIdForPairing(message) ?? null;
  if (!toolCallId) {
    // Identity-less results cannot be canonicalized without collision risk:
    // two distinct id-less results would otherwise map to the same key and
    // one side could be silently swallowed by coverage dedup.
    return undefined;
  }
  // toolName is intentionally omitted from the key: the same logical result
  // may appear with a top-level toolName (DB round-trip) or without one
  // (live transcript block only), and toolCallId is the unique pairing
  // identity — two results with the same toolCallId ARE the same result.
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
