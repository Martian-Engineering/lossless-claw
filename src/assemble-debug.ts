/**
 * Debug formatting for assembled-prefix change logging and overflow diagnostics.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import type { AssemblyOverflowDiagnostics } from "./assembler.js";
import { extractStructuredText } from "./message-content.js";
import type { AgentMessage } from "./openclaw-bridge.js";
import { extractTranscriptToolCallId } from "./replay-metadata.js";
import { asRecord, hashSerializedMessages, safeString, toJson } from "./value-utils.js";
import { createHash } from "node:crypto";
import { join } from "node:path";

export type AssemblePrefixSnapshot = {
  serializedMessages: string[];
  messageSummaries: string[];
  fullHash: string;
};

export type BootstrapImportObservation = {
  importedMessages: number;
  reason: string | null;
  forkBounded: boolean;
  observedAt: Date;
};

export function normalizeDebugTextSnippet(value: string, maxLength: number = 48): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) {
    return collapsed;
  }
  return `${collapsed.slice(0, Math.max(0, maxLength - 3))}...`;
}

export function summarizeMessageContentShape(content: unknown): string {
  if (Array.isArray(content)) {
    const blockTypes = content
      .map((item) => {
        const record = asRecord(item);
        if (record) {
          return safeString(record.type) ?? "object";
        }
        return typeof item;
      })
      .slice(0, 4);
    const typeSummary = blockTypes.length > 0 ? blockTypes.join(",") : "empty";
    return `blocks=${content.length}:${typeSummary}`;
  }
  if (typeof content === "string") {
    return "content=text";
  }
  if (content == null) {
    return "content=empty";
  }
  if (typeof content === "object") {
    return "content=object";
  }
  return `content=${typeof content}`;
}

export function summarizeMessageForPrefixDebug(message: AgentMessage): string {
  const serialized = JSON.stringify(message);
  const topLevel = message as Record<string, unknown>;
  const role = safeString(topLevel.role) ?? "unknown";
  const summaryParts = [role, summarizeMessageContentShape(topLevel.content)];
  const toolCallId = extractTranscriptToolCallId(message);
  if (toolCallId) {
    summaryParts.push(`tool=${toolCallId}`);
  }
  const toolName =
    safeString(topLevel.toolName) ??
    safeString(topLevel.tool_name) ??
    (Array.isArray(topLevel.content)
      ? topLevel.content
          .map((item) => asRecord(item))
          .map((record) => safeString(record?.name))
          .find((name) => typeof name === "string")
      : undefined);
  if (toolName) {
    summaryParts.push(`name=${toolName}`);
  }
  const text = extractStructuredText(topLevel.content);
  if (typeof text === "string" && text.trim().length > 0) {
    summaryParts.push(`text=${toJson(normalizeDebugTextSnippet(text))}`);
  }
  summaryParts.push(
    `hash=${createHash("sha256").update(serialized).digest("hex").slice(0, 8)}`,
  );
  return summaryParts.join("|");
}

export function describeAssembledPrefixChange(
  previous: AssemblePrefixSnapshot | undefined,
  messages: AgentMessage[],
): {
  currentSnapshot: AssemblePrefixSnapshot;
  previousCount: number;
  commonPrefixCount: number;
  commonPrefixHash: string;
  previousWasPrefix: boolean;
  firstDivergenceIndex: number;
  previousDivergenceMessage: string;
  currentDivergenceMessage: string;
} {
  const serializedMessages = messages.map((message) => JSON.stringify(message));
  const messageSummaries = messages.map((message) => summarizeMessageForPrefixDebug(message));
  const currentSnapshot = {
    serializedMessages,
    messageSummaries,
    fullHash: hashSerializedMessages(serializedMessages),
  };

  if (!previous) {
    return {
      currentSnapshot,
      previousCount: 0,
      commonPrefixCount: 0,
      commonPrefixHash: hashSerializedMessages([]),
      previousWasPrefix: true,
      firstDivergenceIndex: -1,
      previousDivergenceMessage: "none",
      currentDivergenceMessage: "none",
    };
  }

  const limit = Math.min(previous.serializedMessages.length, serializedMessages.length);
  let commonPrefixCount = 0;
  while (
    commonPrefixCount < limit &&
    previous.serializedMessages[commonPrefixCount] === serializedMessages[commonPrefixCount]
  ) {
    commonPrefixCount++;
  }

  const previousWasPrefix = commonPrefixCount === previous.serializedMessages.length;
  return {
    currentSnapshot,
    previousCount: previous.serializedMessages.length,
    commonPrefixCount,
    commonPrefixHash: hashSerializedMessages(serializedMessages.slice(0, commonPrefixCount)),
    previousWasPrefix,
    firstDivergenceIndex: previousWasPrefix ? -1 : commonPrefixCount,
    previousDivergenceMessage: previousWasPrefix
      ? "none"
      : (previous.messageSummaries[commonPrefixCount] ?? "(end)"),
    currentDivergenceMessage: previousWasPrefix
      ? "none"
      : (currentSnapshot.messageSummaries[commonPrefixCount] ?? "(end)"),
  };
}

export function shouldLogOverflowDiagnostics(params: {
  diagnostics: AssemblyOverflowDiagnostics;
  assembledTokens: number;
  storedContextTokens: number;
}): boolean {
  const budget = Math.max(1, params.diagnostics.tokenBudget);
  return (
    params.diagnostics.totalContextTokens > budget ||
    params.assembledTokens >= Math.floor(budget * 0.9) ||
    params.storedContextTokens >= Math.floor(budget * 0.9) ||
    params.diagnostics.duplicateRefClusters.length > 0 ||
    params.diagnostics.duplicateMessageClusters.length > 0
  );
}

export function formatOverflowDiagnosticsForLog(params: {
  diagnostics: AssemblyOverflowDiagnostics;
  recentBootstrapImport?: BootstrapImportObservation;
}): string {
  const recent = params.recentBootstrapImport;
  return JSON.stringify({
    ...params.diagnostics,
    recentBootstrapImportCount: recent?.importedMessages ?? null,
    recentBootstrapImportReason: recent?.reason ?? null,
  });
}
