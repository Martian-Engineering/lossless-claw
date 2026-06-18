/**
 * Canonical message identity/signature builders used for dedup, replay detection, and assembly protection.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { buildMessageParts, toStoredMessage, type StoredMessage } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import {
  canonicalizeOpenClawInboundMetadataIdentityContent,
  extractOpenClawInboundBody,
} from "./openclaw-inbound-metadata.js";
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
  // In-memory identity for dedup / replay detection / after-turn alignment.
  // OpenClaw delivers each channel turn in two forms - the live model-facing
  // copy decorated with injected untrusted-metadata blocks, and the bare
  // transcript copy - which are the SAME logical message and must align so the
  // covered-frontier dedup does not persist a duplicate row (issue #912).
  // Strip the inbound decoration for user content before forming the identity.
  // This is NOT the persisted identity hash (buildMessageIdentityHash /
  // canonicalizeOpenClawInboundMetadataIdentityContent / #901); the chat-aware
  // persisted identity is unchanged, so #901 cross-chat distinction holds.
  // extractOpenClawInboundBody is a no-op for already-bare content and for
  // non-user roles, so only the decorated user copy is affected.
  return `${role}\u0000${extractOpenClawInboundBody(role, content)}`;
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
