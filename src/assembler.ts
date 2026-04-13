import type { ContextEngine } from "openclaw/plugin-sdk";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import type {
  ConversationStore,
  MessagePartRecord,
  MessageRole,
} from "./store/conversation-store.js";
import type { SummaryStore, ContextItemRecord, SummaryRecord } from "./store/summary-store.js";
import { estimateTokens } from "./estimate-tokens.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

const TOOL_CALL_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "tool-use",
  "functionCall",
  "function_call",
]);

// ── Public types ─────────────────────────────────────────────────────────────

export interface AssembleContextInput {
  conversationId: number;
  tokenBudget: number;
  /** Number of most recent raw turns to always include (default: 8) */
  freshTailCount?: number;
  /** Optional token cap for the protected fresh tail; newest message is always preserved. */
  freshTailMaxTokens?: number;
  /** Optional user query for relevance-based eviction scoring (BM25-lite). When absent or unsearchable, falls back to chronological eviction. */
  prompt?: string;
}

export interface AssembleContextResult {
  /** Ordered messages ready for the model */
  messages: AgentMessage[];
  /** Total estimated tokens */
  estimatedTokens: number;
  /** Optional dynamic system prompt guidance derived from DAG state */
  systemPromptAddition?: string;
  /** Stats about what was assembled */
  stats: {
    rawMessageCount: number;
    summaryCount: number;
    totalContextItems: number;
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────


type SummaryPromptSignal = Pick<SummaryRecord, "kind" | "depth" | "descendantCount">;

/**
 * Build dynamic prompt guidance for compacted session context.
 *
 * Guidance is emitted only when summaries are present in assembled context.
 * Static recall policy lives in the plugin prompt hook so this addition
 * remains session-specific and reflects only the current compaction state.
 */
function buildSystemPromptAddition(summarySignals: SummaryPromptSignal[]): string | undefined {
  if (summarySignals.length === 0) {
    return undefined;
  }

  const maxDepth = summarySignals.reduce((deepest, signal) => Math.max(deepest, signal.depth), 0);
  const condensedCount = summarySignals.filter((signal) => signal.kind === "condensed").length;
  const heavilyCompacted = maxDepth >= 2 || condensedCount >= 2;

  const sections: string[] = [];

  // Dynamic compaction reminder — always present when summaries exist.
  sections.push(
    "## Compacted Conversation Context",
    "",
    "Summaries above are compressed context, not full detail.",
    "",
    "Treat summaries as compressed recall cues rather than proof of exact wording or exact values.",
    "",
    "If a summary includes an \"Expand for details about:\" footer, use it as a cue to expand before asserting specifics.",
  );

  // Precision/evidence rules — always present but stronger when heavily compacted.
  if (heavilyCompacted) {
    sections.push(
      "",
      "**Deeply compacted context: expand before asserting specifics.**",
      "",
      "Before answering with exact commands, SHAs, paths, timestamps, config values, or causal chains, expand for the missing detail.",
      "",
      "Default recall flow for precision work:",
      "1) `lcm_grep` to locate relevant summary/message IDs",
      "2) `lcm_expand_query` with a focused prompt",
      "3) Answer directly from the retrieved evidence",
      "",
      "Keep raw summary IDs in tool context for follow-up; do not include them in the user-facing answer unless the user asks for sources or IDs.",
      "",
      "`lcm_grep` tips: prefer `mode: \"full_text\"` for keyword/topic lookup, quote exact multi-word phrases, use `sort: \"relevance\"` for older-topic retrieval, and use `sort: \"hybrid\"` when recency should still influence ranking.",
      "`lcm_expand_query(query: ...)` uses the same FTS5 full-text search rules as `lcm_grep`: terms are ANDed by default, so extra query words narrow results. Keep `query` to 1-3 distinctive terms or a quoted phrase, and put the natural-language question in `prompt`.",
      "",
      "**Uncertainty checklist (run before answering):**",
      "- Am I making an exact factual claim from a compressed or condensed summary?",
      "- Could compaction have omitted a crucial detail?",
      "- Would I need an expansion step if the user asks for proof or the exact text?",
      "- Should I state uncertainty instead of asserting specifics until I expand?",
      "",
      "If yes to any item, expand first or explicitly say that you need to expand.",
      "",
      "Do not guess exact commands, SHAs, file paths, timestamps, config values, or causal claims from condensed summaries. Expand first or explicitly say that you need to expand.",
    );
  } else {
    sections.push(
      "",
      "For exact commands, SHAs, paths, timestamps, config values, or causal chains, expand for details before answering.",
      "State uncertainty instead of guessing from compressed summaries.",
    );
  }

  return sections.join("\n");
}

/**
 * Map a DB message role to an AgentMessage role.
 *
 *   user      -> user
 *   assistant -> assistant
 *   system    -> user       (system prompts presented as user messages)
 *   tool      -> assistant  (tool results are part of assistant turns)
 */
function parseJson(value: string | null): unknown {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function getOriginalRole(parts: MessagePartRecord[]): string | null {
  for (const part of parts) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const role = (decoded as { originalRole?: unknown }).originalRole;
    if (typeof role === "string" && role.length > 0) {
      return role;
    }
  }
  return null;
}

function getPartMetadata(part: MessagePartRecord): {
  originalRole?: string;
  rawType?: string;
  raw?: unknown;
} {
  const decoded = parseJson(part.metadata);
  if (!decoded || typeof decoded !== "object") {
    return {};
  }

  const record = decoded as {
    originalRole?: unknown;
    rawType?: unknown;
    raw?: unknown;
  };
  return {
    originalRole:
      typeof record.originalRole === "string" && record.originalRole.length > 0
        ? record.originalRole
        : undefined,
    rawType:
      typeof record.rawType === "string" && record.rawType.length > 0
        ? record.rawType
        : undefined,
    raw: record.raw,
  };
}

function parseStoredValue(value: string | null): unknown {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = parseJson(value);
  return parsed !== undefined ? parsed : value;
}

function reasoningBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type = rawType === "thinking" ? "thinking" : "reasoning";
  if (typeof part.textContent === "string" && part.textContent.length > 0) {
    return type === "thinking"
      ? { type, thinking: part.textContent }
      : { type, text: part.textContent };
  }
  return { type };
}

/**
 * Detect if a raw block is an OpenClaw-normalised OpenAI reasoning item.
 * OpenClaw converts OpenAI `{type:"reasoning", id:"rs_…", encrypted_content:"…"}`
 * into `{type:"thinking", thinking:"", thinkingSignature:"{…}"}`.
 * When we reassemble for the OpenAI provider we need the original back.
 */
function tryRestoreOpenAIReasoning(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.type !== "thinking") return null;
  const sig = raw.thinkingSignature;
  if (typeof sig !== "string" || !sig.startsWith("{")) return null;
  try {
    const parsed = JSON.parse(sig) as Record<string, unknown>;
    if (parsed.type === "reasoning" && typeof parsed.id === "string") {
      return parsed;
    }
  } catch {
    // not valid JSON — leave as-is
  }
  return null;
}

/** @internal Exported for testing only. */
export function toolCallBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type =
    rawType === "function_call" ||
    rawType === "functionCall" ||
    rawType === "tool_use" ||
    rawType === "tool-use" ||
    rawType === "toolUse" ||
    rawType === "toolCall"
      ? rawType
      : "toolCall";
  const input = parseStoredValue(part.toolInput);
  const block: Record<string, unknown> = { type };

  if (type === "function_call") {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      block.call_id = part.toolCallId;
    }
    if (typeof part.toolName === "string" && part.toolName.length > 0) {
      block.name = part.toolName;
    }
    if (input !== undefined) {
      block.arguments = input;
    }
    return block;
  }

  // Always set id — downstream providers (e.g. Anthropic) call
  // normalizeToolCallId(block.id) which crashes on undefined.
  block.id =
    typeof part.toolCallId === "string" && part.toolCallId.length > 0
      ? part.toolCallId
      : `toolu_lcm_${part.partId ?? "unknown"}`;
  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
  }

  if (input !== undefined) {
    // toolCall and functionCall use "arguments" (consumed by OpenAI/xAI Chat
    // Completions extractToolCalls and Responses API paths in OpenClaw).
    // tool_use and variants use "input" (Anthropic native format).
    if (type === "functionCall" || type === "toolCall") {
      block.arguments = input;
    } else {
      block.input = input;
    }
  }
  return block;
}

/** @internal Exported for testing only. */
export function toolResultBlockFromPart(
  part: MessagePartRecord,
  rawType?: string,
  raw?: Record<string, unknown>,
): unknown {
  if (
    raw &&
    typeof raw.text === "string" &&
    raw.output === undefined &&
    raw.content === undefined &&
    (part.toolOutput == null || part.toolOutput === "") &&
    (part.textContent == null || part.textContent === raw.text)
  ) {
    return {
      type: "text",
      text: raw.text,
    };
  }

  const type =
    rawType === "function_call_output" || rawType === "toolResult" || rawType === "tool_result"
      ? rawType
      : "tool_result";
  const output = parseStoredValue(part.toolOutput);
  const block: Record<string, unknown> = { type };

  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
  }

  if (output !== undefined) {
    block.output = output;
  } else if (typeof part.textContent === "string") {
    block.output = part.textContent;
  } else if (raw && raw.output !== undefined) {
    block.output = raw.output;
  } else if (raw && raw.content !== undefined) {
    block.content = raw.content;
  } else {
    block.output = "";
  }

  if (raw && typeof raw.is_error === "boolean") {
    block.is_error = raw.is_error;
  } else if (raw && typeof raw.isError === "boolean") {
    block.isError = raw.isError;
  }

  if (type === "function_call_output") {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      block.call_id = part.toolCallId;
    }
    return block;
  }

  if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
    block.tool_use_id = part.toolCallId;
  }
  return block;
}

function toRuntimeRole(
  dbRole: MessageRole,
  parts: MessagePartRecord[],
): "user" | "assistant" | "toolResult" {
  const originalRole = getOriginalRole(parts);
  if (originalRole === "toolResult") {
    return "toolResult";
  }
  if (originalRole === "assistant") {
    return "assistant";
  }
  if (originalRole === "user") {
    return "user";
  }
  if (originalRole === "system") {
    // Runtime system prompts are managed via setSystemPrompt(), not message history.
    return "user";
  }

  if (dbRole === "tool") {
    return "toolResult";
  }
  if (dbRole === "assistant") {
    return "assistant";
  }
  return "user"; // user | system
}

/** @internal Exported for testing only. */
export function blockFromPart(part: MessagePartRecord): unknown {
  const metadata = getPartMetadata(part);
  if (metadata.raw && typeof metadata.raw === "object") {
    // If this is an OpenClaw-normalised OpenAI reasoning block, restore the original
    // OpenAI format so the Responses API gets the {type:"reasoning", id:"rs_…"} it expects.
    const restored = tryRestoreOpenAIReasoning(metadata.raw as Record<string, unknown>);
    if (restored) return restored;

    // Don't return raw for tool call/result blocks — they need to go through
    // toolCallBlockFromPart/toolResultBlockFromPart which properly normalize
    // arguments (stringify if object) and format for the target provider.
    // Returning raw here causes arguments to be passed as a JS object instead
    // of a JSON string, which breaks xAI/OpenAI Chat Completions API (422).
    const rawType = (metadata.raw as Record<string, unknown>).type as string | undefined;
    const isToolBlock =
      rawType === "toolCall" ||
      rawType === "tool_use" ||
      rawType === "tool-use" ||
      rawType === "toolUse" ||
      rawType === "functionCall" ||
      rawType === "function_call" ||
      rawType === "function_call_output" ||
      rawType === "toolResult" ||
      rawType === "tool_result";
    if (!isToolBlock) {
      return metadata.raw;
    }

    // When tool blocks are routed through toolCallBlockFromPart (below) instead
    // of returning raw directly, the function reads part.toolCallId / part.toolName
    // from the DB columns.  For rows stored as part_type='text' those columns are
    // often NULL — the values only live inside metadata.raw.  Backfill them here
    // so the reconstructed block keeps the original id/name.
    const rawRecord = metadata.raw as Record<string, unknown>;
    const rawToolCallId =
      typeof rawRecord.id === "string" && rawRecord.id.length > 0
        ? rawRecord.id
        : typeof rawRecord.call_id === "string" && rawRecord.call_id.length > 0
          ? rawRecord.call_id
          : undefined;
    if (rawToolCallId) {
      if (typeof part.toolCallId !== "string" || part.toolCallId.length === 0) {
        part.toolCallId = rawToolCallId;
      }
    }
    if (typeof rawRecord.name === "string" && rawRecord.name.length > 0) {
      if (typeof part.toolName !== "string" || part.toolName.length === 0) {
        part.toolName = rawRecord.name;
      }
    }
    // Backfill toolInput from raw arguments/input so toolCallBlockFromPart
    // can reconstruct the full block.
    if (part.toolInput == null || part.toolInput === "") {
      const rawArgs = rawRecord.arguments ?? rawRecord.input;
      if (rawArgs !== undefined) {
        part.toolInput = typeof rawArgs === "string" ? rawArgs : JSON.stringify(rawArgs);
      }
    }
  }

  if (part.partType === "reasoning") {
    return reasoningBlockFromPart(part, metadata.rawType);
  }
  if (part.partType === "tool") {
    if (metadata.originalRole === "toolResult" || metadata.rawType === "function_call_output") {
      return toolResultBlockFromPart(
        part,
        metadata.rawType,
        metadata.raw && typeof metadata.raw === "object"
          ? (metadata.raw as Record<string, unknown>)
          : undefined,
      );
    }
    return toolCallBlockFromPart(part, metadata.rawType);
  }
  if (
    metadata.rawType === "function_call" ||
    metadata.rawType === "functionCall" ||
    metadata.rawType === "tool_use" ||
    metadata.rawType === "tool-use" ||
    metadata.rawType === "toolUse" ||
    metadata.rawType === "toolCall"
  ) {
    return toolCallBlockFromPart(part, metadata.rawType);
  }
  if (
    metadata.rawType === "function_call_output" ||
    metadata.rawType === "tool_result" ||
    metadata.rawType === "toolResult"
  ) {
    return toolResultBlockFromPart(
      part,
      metadata.rawType,
      metadata.raw && typeof metadata.raw === "object"
        ? (metadata.raw as Record<string, unknown>)
        : undefined,
    );
  }
  if (part.partType === "text") {
    return { type: "text", text: part.textContent ?? "" };
  }

  if (typeof part.textContent === "string" && part.textContent.length > 0) {
    return { type: "text", text: part.textContent };
  }

  const decodedFallback = parseJson(part.metadata);
  if (decodedFallback && typeof decodedFallback === "object") {
    return {
      type: "text",
      text: JSON.stringify(decodedFallback),
    };
  }
  return { type: "text", text: "" };
}

/** @internal Exported for transcript-maintenance reconstruction. */
export function contentFromParts(
  parts: MessagePartRecord[],
  role: "user" | "assistant" | "toolResult",
  fallbackContent: string,
): unknown {
  if (parts.length === 0) {
    if (role === "assistant") {
      return fallbackContent ? [{ type: "text", text: fallbackContent }] : [];
    }
    if (role === "toolResult") {
      return [{ type: "text", text: fallbackContent }];
    }
    return fallbackContent;
  }

  const blocks = parts.map(blockFromPart);
  if (
    role === "user" &&
    blocks.length === 1 &&
    blocks[0] &&
    typeof blocks[0] === "object" &&
    (blocks[0] as { type?: unknown }).type === "text" &&
    typeof (blocks[0] as { text?: unknown }).text === "string"
  ) {
    return (blocks[0] as { text: string }).text;
  }
  return blocks;
}

/** @internal Exported for transcript-maintenance reconstruction. */
export function pickToolCallId(parts: MessagePartRecord[]): string | undefined {
  for (const part of parts) {
    if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
      return part.toolCallId;
    }
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataToolCallId = (decoded as { toolCallId?: unknown }).toolCallId;
    if (typeof metadataToolCallId === "string" && metadataToolCallId.length > 0) {
      return metadataToolCallId;
    }
    const raw = (decoded as { raw?: unknown }).raw;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const maybe = (raw as { toolCallId?: unknown; tool_call_id?: unknown }).toolCallId;
    if (typeof maybe === "string" && maybe.length > 0) {
      return maybe;
    }
    const maybeSnake = (raw as { tool_call_id?: unknown }).tool_call_id;
    if (typeof maybeSnake === "string" && maybeSnake.length > 0) {
      return maybeSnake;
    }
  }
  return undefined;
}

/** @internal Exported for transcript-maintenance reconstruction. */
export function pickToolName(parts: MessagePartRecord[]): string | undefined {
  for (const part of parts) {
    if (typeof part.toolName === "string" && part.toolName.length > 0) {
      return part.toolName;
    }
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataToolName = (decoded as { toolName?: unknown }).toolName;
    if (typeof metadataToolName === "string" && metadataToolName.length > 0) {
      return metadataToolName;
    }
    const raw = (decoded as { raw?: unknown }).raw;
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const maybe = (raw as { name?: unknown }).name;
    if (typeof maybe === "string" && maybe.length > 0) {
      return maybe;
    }
    const maybeCamel = (raw as { toolName?: unknown }).toolName;
    if (typeof maybeCamel === "string" && maybeCamel.length > 0) {
      return maybeCamel;
    }
  }
  return undefined;
}

/** @internal Exported for transcript-maintenance reconstruction. */
export function pickToolIsError(parts: MessagePartRecord[]): boolean | undefined {
  for (const part of parts) {
    const decoded = parseJson(part.metadata);
    if (!decoded || typeof decoded !== "object") {
      continue;
    }
    const metadataIsError = (decoded as { isError?: unknown }).isError;
    if (typeof metadataIsError === "boolean") {
      return metadataIsError;
    }
  }
  return undefined;
}

function extractToolCallId(block: { id?: unknown; call_id?: unknown }): string | null {
  if (typeof block.id === "string" && block.id.length > 0) {
    return block.id;
  }
  if (typeof block.call_id === "string" && block.call_id.length > 0) {
    return block.call_id;
  }
  return null;
}

function extractToolCallIdsFromAssistant(message: AgentMessage): string[] {
  if (message?.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  const ids: string[] = [];
  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as { type?: unknown; id?: unknown; call_id?: unknown };
    if (typeof record.type !== "string" || !TOOL_CALL_TYPES.has(record.type)) {
      continue;
    }
    const id = extractToolCallId(record);
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function extractToolResultIdFromMessage(message: AgentMessage): string | null {
  if (!message || typeof message !== "object") {
    return null;
  }
  if (typeof message.toolCallId === "string" && message.toolCallId.length > 0) {
    return message.toolCallId;
  }
  if (typeof message.toolUseId === "string" && message.toolUseId.length > 0) {
    return message.toolUseId;
  }
  return null;
}

function collectAssistantToolCallIds(items: ResolvedItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    for (const id of extractToolCallIdsFromAssistant(item.message)) {
      ids.add(id);
    }
  }
  return ids;
}

function normalizeFreshTailTokenCap(freshTailMaxTokens?: number): number | undefined {
  if (
    typeof freshTailMaxTokens === "number" &&
    Number.isFinite(freshTailMaxTokens) &&
    freshTailMaxTokens >= 0
  ) {
    return Math.floor(freshTailMaxTokens);
  }
  return undefined;
}

function mergeFreshTailWithMatchingToolResults(
  freshTail: ResolvedItem[],
  matchingToolResults: ResolvedItem[],
  freshTailMaxTokens?: number,
): { items: ResolvedItem[]; promotedOrdinals: Set<number> } {
  if (matchingToolResults.length === 0) {
    return { items: freshTail, promotedOrdinals: new Set<number>() };
  }

  const resultsById = new Map<string, ResolvedItem[]>();
  for (const item of matchingToolResults) {
    const toolResultId = extractToolResultIdFromMessage(item.message);
    if (!toolResultId) {
      continue;
    }
    const existing = resultsById.get(toolResultId);
    if (existing) {
      existing.push(item);
    } else {
      resultsById.set(toolResultId, [item]);
    }
  }

  const merged: ResolvedItem[] = [];
  const promotedOrdinals = new Set<number>();
  const tokenCap = normalizeFreshTailTokenCap(freshTailMaxTokens);
  let mergedTokens = freshTail.reduce((sum, item) => sum + item.tokens, 0);

  for (const item of freshTail) {
    merged.push(item);

    const toolCallIds = extractToolCallIdsFromAssistant(item.message);
    if (toolCallIds.length === 0) {
      continue;
    }

    for (const toolCallId of toolCallIds) {
      const matches = resultsById.get(toolCallId);
      if (!matches) {
        continue;
      }
      for (const match of matches) {
        if (promotedOrdinals.has(match.ordinal)) {
          continue;
        }
        if (
          typeof tokenCap === "number" &&
          mergedTokens + match.tokens > tokenCap
        ) {
          continue;
        }
        merged.push(match);
        promotedOrdinals.add(match.ordinal);
        mergedTokens += match.tokens;
      }
    }
  }

  if (typeof tokenCap !== "number") {
    for (const item of matchingToolResults) {
      if (!promotedOrdinals.has(item.ordinal)) {
        merged.push(item);
      }
    }
  }

  return { items: merged, promotedOrdinals };
}

function filterNonFreshAssistantToolCalls(
  items: ResolvedItem[],
  freshTailOrdinals: Set<number>,
  preserveFreshTailToolCalls = true,
): AgentMessage[] {
  const availableToolResultIds = new Set<string>();
  for (const item of items) {
    const toolResultId = extractToolResultIdFromMessage(item.message);
    if (toolResultId) {
      availableToolResultIds.add(toolResultId);
    }
  }

  const filteredMessages: AgentMessage[] = [];
  for (const item of items) {
    if (
      item.message?.role !== "assistant" ||
      (preserveFreshTailToolCalls && freshTailOrdinals.has(item.ordinal))
    ) {
      filteredMessages.push(item.message);
      continue;
    }

    if (!Array.isArray(item.message.content)) {
      filteredMessages.push(item.message);
      continue;
    }

    let removedAny = false;
    const content = item.message.content.filter((block) => {
      if (!block || typeof block !== "object") {
        return true;
      }
      const record = block as { type?: unknown; id?: unknown; call_id?: unknown };
      if (typeof record.type !== "string" || !TOOL_CALL_TYPES.has(record.type)) {
        return true;
      }
      const toolCallId = extractToolCallId(record);
      if (!toolCallId || availableToolResultIds.has(toolCallId)) {
        return true;
      }
      removedAny = true;
      return false;
    });

    if (content.length === 0) {
      continue;
    }
    if (!removedAny) {
      filteredMessages.push(item.message);
      continue;
    }
    filteredMessages.push({
      ...item.message,
      content: content as typeof item.message.content,
    } as AgentMessage);
  }
  return filteredMessages;
}

/** Format a Date for XML attributes in the agent's timezone. */
function formatDateForAttribute(date: Date, timezone?: string): string {
  const tz = timezone ?? "UTC";
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
    const p = Object.fromEntries(
      fmt.formatToParts(date).map((part) => [part.type, part.value]),
    );
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
  } catch {
    return date.toISOString();
  }
}

/**
 * Format a summary record into the XML payload string the model sees.
 */
async function formatSummaryContent(
  summary: SummaryRecord,
  summaryStore: SummaryStore,
  timezone?: string,
): Promise<string> {
  const attributes = [
    `id="${summary.summaryId}"`,
    `kind="${summary.kind}"`,
    `depth="${summary.depth}"`,
    `descendant_count="${summary.descendantCount}"`,
  ];
  if (summary.earliestAt) {
    attributes.push(`earliest_at="${formatDateForAttribute(summary.earliestAt, timezone)}"`);
  }
  if (summary.latestAt) {
    attributes.push(`latest_at="${formatDateForAttribute(summary.latestAt, timezone)}"`);
  }

  const lines: string[] = [];
  lines.push(`<summary ${attributes.join(" ")}>`); 

  // For condensed summaries, include parent references.
  if (summary.kind === "condensed") {
    const parents = await summaryStore.getSummaryParents(summary.summaryId);
    if (parents.length > 0) {
      lines.push("  <parents>");
      for (const parent of parents) {
        lines.push(`    <summary_ref id="${parent.summaryId}" />`);
      }
      lines.push("  </parents>");
    }
  }

  lines.push("  <content>");
  lines.push(summary.content);
  lines.push("  </content>");
  lines.push("</summary>");
  return lines.join("\n");
}

// ── Resolved context item (after fetching underlying message/summary) ────────

interface ResolvedItem {
  /** Original ordinal from context_items table */
  ordinal: number;
  /** The AgentMessage ready for the model */
  message: AgentMessage;
  /** Estimated token count for this item */
  tokens: number;
  /** Whether this came from a raw message (vs. a summary) */
  isMessage: boolean;
  /** Pre-extracted plain text used for relevance scoring */
  text: string;
  /** Summary metadata used for dynamic system prompt guidance */
  summarySignal?: SummaryPromptSignal;
}

function resolveFreshTailOrdinal(
  resolved: ResolvedItem[],
  freshTailCount: number,
  freshTailMaxTokens?: number,
): number {
  if (!Number.isFinite(freshTailCount) || freshTailCount <= 0) {
    return Infinity;
  }

  const rawMessages = resolved.filter((item) => item.isMessage);
  if (rawMessages.length === 0) {
    return Infinity;
  }

  const tokenCap =
    typeof freshTailMaxTokens === "number" &&
    Number.isFinite(freshTailMaxTokens) &&
    freshTailMaxTokens >= 0
      ? Math.floor(freshTailMaxTokens)
      : undefined;

  let protectedCount = 0;
  let protectedTokens = 0;
  let tailStartOrdinal = Infinity;

  for (let idx = rawMessages.length - 1; idx >= 0; idx--) {
    if (protectedCount >= freshTailCount) {
      break;
    }

    const item = rawMessages[idx];
    if (!item) {
      continue;
    }

    const wouldExceedBudget =
      protectedCount > 0 &&
      typeof tokenCap === "number" &&
      protectedTokens + item.tokens > tokenCap;
    if (wouldExceedBudget) {
      break;
    }

    tailStartOrdinal = item.ordinal;
    protectedCount++;
    protectedTokens += item.tokens;
  }

  return tailStartOrdinal;
}

// ── BM25-lite relevance scorer ────────────────────────────────────────────────

/** @internal Exported for testing only. Tokenize text into lowercase alphanumeric terms. */
export function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1);
}

/**
 * @internal Exported for testing only.
 * Score an item's text against a prompt using BM25-lite (term-frequency overlap).
 * Higher scores indicate stronger keyword overlap. Returns 0 when either input is empty.
 */
export function scoreRelevance(itemText: string, prompt: string): number {
  const promptTerms = tokenizeText(prompt);
  if (promptTerms.length === 0) return 0;

  const itemTerms = tokenizeText(itemText);
  if (itemTerms.length === 0) return 0;

  // Build term-frequency map for the item
  const freq = new Map<string, number>();
  for (const term of itemTerms) {
    freq.set(term, (freq.get(term) ?? 0) + 1);
  }

  // Sum TF contribution for each unique prompt term
  const seen = new Set<string>();
  let score = 0;
  for (const term of promptTerms) {
    if (seen.has(term)) continue;
    seen.add(term);
    const tf = freq.get(term) ?? 0;
    if (tf > 0) {
      // Normalised TF: tf / itemLength (BM25-lite saturation skipped for simplicity)
      score += tf / itemTerms.length;
    }
  }
  return score;
}

/** Return true when a prompt contains at least one searchable term. */
function hasSearchablePrompt(prompt?: string): prompt is string {
  return typeof prompt === "string" && tokenizeText(prompt).length > 0;
}

// ── ContextAssembler ─────────────────────────────────────────────────────────

export class ContextAssembler {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private timezone?: string,
  ) {}

  /**
   * Build model context under a token budget.
   *
   * 1. Fetch all context items for the conversation (ordered by ordinal).
   * 2. Resolve each item into an AgentMessage (fetching the underlying
   *    message or summary record).
   * 3. Protect the "fresh tail" (last N raw messages, optionally token-capped)
   *    from truncation.
   * 4. If over budget, drop oldest non-fresh items until we fit.
   * 5. Return the final ordered messages in chronological order.
   */
  async assemble(input: AssembleContextInput): Promise<AssembleContextResult> {
    const { conversationId, tokenBudget } = input;
    const freshTailCount = input.freshTailCount ?? 8;

    // Step 1: Get all context items ordered by ordinal
    const contextItems = await this.summaryStore.getContextItems(conversationId);

    if (contextItems.length === 0) {
      return {
        messages: [],
        estimatedTokens: 0,
        stats: { rawMessageCount: 0, summaryCount: 0, totalContextItems: 0 },
      };
    }

    // Step 2: Resolve each context item into a ResolvedItem
    const resolved = await this.resolveItems(contextItems);

    // Count stats from the full (pre-truncation) set
    let rawMessageCount = 0;
    let summaryCount = 0;
    const summarySignals: SummaryPromptSignal[] = [];
    for (const item of resolved) {
      if (item.isMessage) {
        rawMessageCount++;
      } else {
        summaryCount++;
        if (item.summarySignal) {
          summarySignals.push(item.summarySignal);
        }
      }
    }

    const systemPromptAddition = buildSystemPromptAddition(summarySignals);

    // Step 3: Split into evictable prefix and protected fresh tail
    const freshTailOrdinal = resolveFreshTailOrdinal(
      resolved,
      freshTailCount,
      input.freshTailMaxTokens,
    );
    const baseFreshTail = resolved.filter((item) => item.ordinal >= freshTailOrdinal);
    const initialEvictable = resolved.filter((item) => item.ordinal < freshTailOrdinal);
    const freshTailOrdinals = new Set(baseFreshTail.map((item) => item.ordinal));
    const tailToolCallIds = collectAssistantToolCallIds(baseFreshTail);
    const tailPairToolResults = initialEvictable.filter((item) => {
      const toolResultId = extractToolResultIdFromMessage(item.message);
      return toolResultId !== null && tailToolCallIds.has(toolResultId);
    });
    const mergedFreshTail = mergeFreshTailWithMatchingToolResults(
      baseFreshTail,
      tailPairToolResults,
      input.freshTailMaxTokens,
    );
    const evictable = initialEvictable.filter(
      (item) => !mergedFreshTail.promotedOrdinals.has(item.ordinal),
    );
    const freshTail = mergedFreshTail.items;

    // Step 4: Budget-aware selection
    // First, compute the token cost of the fresh tail (always included).
    let tailTokens = 0;
    for (const item of freshTail) {
      tailTokens += item.tokens;
    }

    // Fill remaining budget from evictable items, oldest first.
    // If the fresh tail alone exceeds the budget we still include it
    // (we never drop fresh items), but we skip all evictable items.
    const remainingBudget = Math.max(0, tokenBudget - tailTokens);
    const selected: ResolvedItem[] = [];
    let evictableTokens = 0;

    // Walk evictable items from oldest to newest. We want to keep as many
    // older items as the budget allows; once we exceed the budget we start
    // dropping the *oldest* items. To achieve this we first compute the
    // total, then trim from the front.
    const evictableTotalTokens = evictable.reduce((sum, it) => sum + it.tokens, 0);

    if (evictableTotalTokens <= remainingBudget) {
      // Everything fits
      selected.push(...evictable);
      evictableTokens = evictableTotalTokens;
    } else if (hasSearchablePrompt(input.prompt)) {
      // Prompt-aware eviction: score each evictable item by relevance to the
      // prompt, then greedily fill budget from highest-scoring items down.
      // Re-sort selected items by ordinal to restore chronological order.
      const scored = evictable.map((item, idx) => ({
        item,
        score: scoreRelevance(item.text, input.prompt),
        idx, // original index — higher = more recent, used as tiebreaker
      }));
      // Sort: highest relevance first; most recent (higher idx) breaks ties
      scored.sort((a, b) => b.score - a.score || b.idx - a.idx);

      const kept: ResolvedItem[] = [];
      let accum = 0;
      for (const { item } of scored) {
        if (accum + item.tokens <= remainingBudget) {
          kept.push(item);
          accum += item.tokens;
        }
      }
      // Restore chronological order by ordinal before appending freshTail
      kept.sort((a, b) => a.ordinal - b.ordinal);
      selected.push(...kept);
      evictableTokens = accum;
    } else {
      // Chronological eviction (default): drop oldest items until we fit.
      // Walk from the END of evictable (newest first) accumulating tokens,
      // then reverse to restore chronological order.
      const kept: ResolvedItem[] = [];
      let accum = 0;
      for (let i = evictable.length - 1; i >= 0; i--) {
        const item = evictable[i];
        if (accum + item.tokens <= remainingBudget) {
          kept.push(item);
          accum += item.tokens;
        } else {
          // Once an item doesn't fit we stop — all older items are also dropped
          break;
        }
      }
      kept.reverse();
      selected.push(...kept);
      evictableTokens = accum;
    }

    // Append fresh tail after the evictable prefix
    selected.push(...freshTail);

    const estimatedTokens = evictableTokens + tailTokens;

    // Normalize assistant string content to array blocks (some providers return
    // content as a plain string; Anthropic expects content block arrays).
    const rawMessages = filterNonFreshAssistantToolCalls(
      selected,
      freshTailOrdinals,
      normalizeFreshTailTokenCap(input.freshTailMaxTokens) === undefined,
    );
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      if (msg?.role === "assistant" && typeof msg.content === "string") {
        rawMessages[i] = {
          ...msg,
          content: [{ type: "text", text: msg.content }] as unknown as typeof msg.content,
        } as typeof msg;
      }
    }

    // Filter out assistant messages with empty content — these can occur when
    // tool-use-only turns are stored with content="" and zero message_parts,
    // or when filterNonFreshAssistantToolCalls strips all tool_use blocks.
    // Anthropic (and other providers) reject empty content arrays/strings.
    const cleaned = rawMessages.filter(
      (m) =>
        !(
          m?.role === "assistant" &&
          (Array.isArray(m.content) ? m.content.length === 0 : !m.content)
        ),
    );
    return {
      messages: sanitizeToolUseResultPairing(cleaned) as AgentMessage[],
      estimatedTokens,
      systemPromptAddition,
      stats: {
        rawMessageCount,
        summaryCount,
        totalContextItems: resolved.length,
      },
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /**
   * Resolve a list of context items into ResolvedItems by fetching the
   * underlying message or summary record for each.
   *
   * Items that cannot be resolved (e.g. deleted message) are silently skipped.
   */
  private async resolveItems(contextItems: ContextItemRecord[]): Promise<ResolvedItem[]> {
    const resolved: ResolvedItem[] = [];

    for (const item of contextItems) {
      const result = await this.resolveItem(item);
      if (result) {
        resolved.push(result);
      }
    }

    return resolved;
  }

  /**
   * Resolve a single context item.
   */
  private async resolveItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    if (item.itemType === "message" && item.messageId != null) {
      return this.resolveMessageItem(item);
    }

    if (item.itemType === "summary" && item.summaryId != null) {
      return this.resolveSummaryItem(item);
    }

    // Malformed item — skip
    return null;
  }

  /**
   * Resolve a context item that references a raw message.
   */
  private async resolveMessageItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const msg = await this.conversationStore.getMessageById(item.messageId!);
    if (!msg) {
      return null;
    }

    const parts = await this.conversationStore.getMessageParts(msg.messageId);

    // Skip empty assistant messages left by error/aborted responses.
    // These waste context tokens and can confuse models that reject
    // consecutive empty assistant turns.  Only skip when both the stored
    // content text AND the message_parts table are empty — assistant
    // messages that contain tool calls have empty text content but
    // non-empty parts and must be preserved.
    if (msg.role === "assistant" && !msg.content.trim() && parts.length === 0) {
      return null;
    }
    const roleFromStore = toRuntimeRole(msg.role, parts);
    const isToolResult = roleFromStore === "toolResult";
    const toolCallId = isToolResult ? pickToolCallId(parts) : undefined;
    const toolName = isToolResult ? (pickToolName(parts) ?? "unknown") : undefined;
    const toolIsError = isToolResult ? pickToolIsError(parts) : undefined;
    // Tool results without a call id cannot be serialized for Anthropic-compatible APIs.
    // This happens for legacy/bootstrap rows that have role=tool but no message_parts.
    // Preserve the text by degrading to assistant content instead of emitting invalid toolResult.
    const role: "user" | "assistant" | "toolResult" =
      isToolResult && !toolCallId ? "assistant" : roleFromStore;
    const content = contentFromParts(parts, role, msg.content);
    const contentText =
      typeof content === "string" ? content : (JSON.stringify(content) ?? msg.content);
    const tokenCount = estimateTokens(contentText);

    // Cast: these are reconstructed from DB storage, not live agent messages,
    // so they won't carry the full AgentMessage metadata (timestamp, usage, etc.)
    return {
      ordinal: item.ordinal,
      message:
        role === "assistant"
          ? ({
              role,
              content,
              usage: {
                input: 0,
                output: tokenCount,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: tokenCount,
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                  total: 0,
                },
              },
            } as AgentMessage)
          : ({
              role,
              content,
              ...(toolCallId ? { toolCallId } : {}),
              ...(toolName ? { toolName } : {}),
              ...(role === "toolResult" && toolIsError !== undefined ? { isError: toolIsError } : {}),
            } as AgentMessage),
      tokens: tokenCount,
      isMessage: true,
      text: contentText,
    };
  }

  /**
   * Resolve a context item that references a summary.
   * Summaries are presented as user messages with a structured XML wrapper.
   */
  private async resolveSummaryItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const summary = await this.summaryStore.getSummary(item.summaryId!);
    if (!summary) {
      return null;
    }

    const content = await formatSummaryContent(summary, this.summaryStore, this.timezone);
    const tokens = estimateTokens(content);

    // Cast: summaries are synthetic user messages without full AgentMessage metadata
    return {
      ordinal: item.ordinal,
      message: { role: "user" as const, content } as AgentMessage,
      tokens,
      isMessage: false,
      text: summary.content,
      summarySignal: {
        kind: summary.kind,
        depth: summary.depth,
        descendantCount: summary.descendantCount,
      },
    };
  }
}
