import type { ContextEngine } from "openclaw/plugin-sdk";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import type {
  ConversationStore,
  MessagePartRecord,
  MessageRole,
} from "./store/conversation-store.js";
import type { SummaryStore, ContextItemRecord, SummaryRecord, PointerRecord, ScratchpadRecord } from "./store/summary-store.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

// ── Public types ─────────────────────────────────────────────────────────────

export interface AssembleContextInput {
  conversationId: number;
  tokenBudget: number;
  /** Number of most recent raw turns to always include (default: 8) */
  freshTailCount?: number;
  /** Fraction of token budget above which a warning is injected (0.0-1.0, default 0.7). */
  budgetWarningThreshold?: number;
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

/** Simple token estimate: ~4 chars per token, same as VoltCode's Token.estimate */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

type SummaryPromptSignal = Pick<SummaryRecord, "kind" | "depth" | "descendantCount">;

/**
 * Build LCM usage guidance for the runtime system prompt.
 *
 * Guidance is emitted only when summaries are present in assembled context.
 * Depth-aware: minimal for shallow compaction, full guidance for deep trees.
 */
function buildSystemPromptAddition(summarySignals: SummaryPromptSignal[]): string | undefined {
  if (summarySignals.length === 0) {
    return undefined;
  }

  const maxDepth = summarySignals.reduce((deepest, signal) => Math.max(deepest, signal.depth), 0);
  const condensedCount = summarySignals.filter((signal) => signal.kind === "condensed").length;
  const heavilyCompacted = maxDepth >= 2 || condensedCount >= 2;

  const sections: string[] = [];

  // Core recall workflow — always present when summaries exist
  sections.push(
    "## LCM Recall",
    "",
    "Summaries above are compressed context — maps to details, not the details themselves.",
    "",
    "**Recall priority:** LCM tools first, then qmd (for Granola/Limitless/pre-LCM data), then memory_search as last resort.",
    "",
    "**Tool escalation:**",
    "1. `lcm_grep` — search by regex or full-text across messages and summaries",
    "2. `lcm_describe` — inspect a specific summary (cheap, no sub-agent)",
    "3. `lcm_expand_query` — deep recall: spawns bounded sub-agent, expands DAG, returns answer with cited summary IDs (~120s, don't ration it)",
    "",
    "**`lcm_expand_query` usage** — two patterns (always requires `prompt`):",
    "- With IDs: `lcm_expand_query(summaryIds: [\"sum_xxx\"], prompt: \"What config changes were discussed?\")`",
    "- With search: `lcm_expand_query(query: \"database migration\", prompt: \"What strategy was decided?\")`",
    "- Optional: `maxTokens` (default 2000), `conversationId`, `allConversations: true`",
    "",
    "**Summaries include \"Expand for details about:\" footers** listing compressed specifics. Use `lcm_expand_query` with that summary's ID to retrieve them.",
  );

  // Precision/evidence rules — always present but stronger when heavily compacted
  if (heavilyCompacted) {
    sections.push(
      "",
      "**\u26a0 Deeply compacted context — expand before asserting specifics.**",
      "",
      "Default recall flow for precision work:",
      "1) `lcm_grep` to locate relevant summary/message IDs",
      "2) `lcm_expand_query` with a focused prompt",
      "3) Answer with citations to summary IDs used",
      "",
      "**Uncertainty checklist (run before answering):**",
      "- Am I making exact factual claims from a condensed summary?",
      "- Could compaction have omitted a crucial detail?",
      "- Would this answer fail if the user asks for proof?",
      "",
      "If yes to any \u2192 expand first.",
      "",
      "**Do not guess** exact commands, SHAs, file paths, timestamps, config values, or causal claims from condensed summaries. Expand first or state that you need to expand.",
    );
  } else {
    sections.push(
      "",
      "**For precision/evidence questions** (exact commands, SHAs, paths, timestamps, config values, root-cause chains): expand before answering.",
      "Do not guess from condensed summaries — expand first or state uncertainty.",
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

function toolCallBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
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

  if (typeof part.toolCallId === "string" && part.toolCallId.length > 0) {
    block.id = part.toolCallId;
  }
  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
  }

  if (input !== undefined) {
    if (type === "functionCall") {
      block.arguments = input;
    } else {
      block.input = input;
    }
  }
  return block;
}

function toolResultBlockFromPart(part: MessagePartRecord, rawType?: string): unknown {
  const type =
    rawType === "function_call_output" || rawType === "toolResult" || rawType === "tool_result"
      ? rawType
      : "tool_result";
  const output = parseStoredValue(part.toolOutput) ?? part.textContent ?? "";
  const block: Record<string, unknown> = { type, output };

  if (typeof part.toolName === "string" && part.toolName.length > 0) {
    block.name = part.toolName;
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

function blockFromPart(part: MessagePartRecord): unknown {
  const metadata = getPartMetadata(part);
  if (metadata.raw && typeof metadata.raw === "object") {
    // If this is an OpenClaw-normalised OpenAI reasoning block, restore the original
    // OpenAI format so the Responses API gets the {type:"reasoning", id:"rs_…"} it expects.
    const restored = tryRestoreOpenAIReasoning(metadata.raw as Record<string, unknown>);
    if (restored) return restored;
    return metadata.raw;
  }

  if (part.partType === "reasoning") {
    return reasoningBlockFromPart(part, metadata.rawType);
  }
  if (part.partType === "tool") {
    if (metadata.originalRole === "toolResult" || metadata.rawType === "function_call_output") {
      return toolResultBlockFromPart(part, metadata.rawType);
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
    return toolResultBlockFromPart(part, metadata.rawType);
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

function contentFromParts(
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

function pickToolCallId(parts: MessagePartRecord[]): string | undefined {
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

function pickToolName(parts: MessagePartRecord[]): string | undefined {
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

function pickToolIsError(parts: MessagePartRecord[]): boolean | undefined {
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
    `tokens="${summary.tokenCount}"`,
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

/**
 * Format a pointer record into the XML payload string the model sees.
 */
function formatPointerContent(pointer: PointerRecord, timezone?: string): string {
  const created = formatDateForAttribute(pointer.createdAt, timezone);
  const tagAttr = pointer.tags && pointer.tags.length > 0 ? ` tags="${pointer.tags.join(",")}"` : "";
  const statusAttr = pointer.status && pointer.status !== "active" ? ` status="${pointer.status}"` : "";
  const lines: string[] = [];
  lines.push(`<collapsed id="${pointer.pointerId}" tokens_saved="${pointer.tokensSaved}" created="${created}"${tagAttr}${statusAttr}>`);
  lines.push(`  ${pointer.label}${pointer.reason ? ` (collapsed: ${pointer.reason})` : ""}`);
  if (pointer.data) {
    lines.push(`  [has stored data — available on expand]`);
  }
  lines.push(`  → lcm_expand_active(pointerId: "${pointer.pointerId}") to restore`);
  lines.push(`</collapsed>`);
  return lines.join("\n");
}

/**
 * Format a scratchpad record into the XML payload string the model sees.
 */
function formatScratchpadContent(scratchpad: ScratchpadRecord, timezone?: string): string {
  const updated = formatDateForAttribute(scratchpad.updatedAt, timezone);
  const lines: string[] = [];
  lines.push(`<scratchpad updated="${updated}">`);
  lines.push(scratchpad.content);
  lines.push(`</scratchpad>`);
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
  /** Summary metadata used for dynamic system prompt guidance */
  summarySignal?: SummaryPromptSignal;
}

// ── Context Ref Map ──────────────────────────────────────────────────────────

/** Format an ordinal as a 3-char zero-padded hex ref: §001, §00a, §03f */
function ordinalToRef(ordinal: number): string {
  return "§" + ordinal.toString(16).padStart(3, "0");
}

/** Parse a §XXX ref back to an ordinal number. Returns NaN on failure. */
export function parseRef(ref: string): number {
  const hex = ref.startsWith("§") ? ref.slice(1) : ref;
  return parseInt(hex, 16);
}

/**
 * Determine the type abbreviation and preview for a single context item.
 */
function refMapEntry(
  ordinal: number,
  contextItem: ContextItemRecord,
  resolved: ResolvedItem,
): string {
  const ref = ordinalToRef(ordinal);
  const itemType = contextItem.itemType;

  if (itemType === "scratchpad") {
    return `${ref} pad(${resolved.tokens})`;
  }

  if (itemType === "pointer") {
    // Extract label from pointer content
    const content = typeof resolved.message.content === "string" ? resolved.message.content : "";
    const labelMatch = content.match(/^\s*<collapsed[^>]*>\s*\n\s*(.+?)(?:\s*\(collapsed:|\s*\n)/);
    const label = labelMatch ? labelMatch[1].trim() : "collapsed";
    const preview = label.length > 30 ? label.slice(0, 27) + "..." : label;
    return `${ref} ptr(${resolved.tokens}) "${preview}"`;
  }

  if (itemType === "summary") {
    const content = typeof resolved.message.content === "string" ? resolved.message.content : "";
    // Extract content between <content> tags
    const contentMatch = content.match(/<content>\s*([\s\S]*?)\s*<\/content>/);
    const summaryText = contentMatch ? contentMatch[1].trim() : content;
    const preview = summaryText.length > 30 ? summaryText.slice(0, 27) + "..." : summaryText;
    return `${ref} sum(${resolved.tokens}) "${preview}"`;
  }

  // message type — determine role
  const role = resolved.message.role;

  if (role === "user") {
    const content = typeof resolved.message.content === "string"
      ? resolved.message.content
      : "";
    const preview = content.length > 30 ? content.slice(0, 27) + "..." : content;
    return `${ref} user(${resolved.tokens}) "${preview}"`;
  }

  if (role === "assistant") {
    // Check if content contains tool calls
    const content = resolved.message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object") {
          const blockType = (block as { type?: string }).type ?? "";
          if (
            blockType === "tool_use" ||
            blockType === "tool-use" ||
            blockType === "toolUse" ||
            blockType === "toolCall" ||
            blockType === "function_call" ||
            blockType === "functionCall"
          ) {
            const toolName = (block as { name?: string }).name ?? "unknown";
            return `${ref} asst(${resolved.tokens}) [tool:${toolName}]`;
          }
        }
      }
    }
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? (content.find((b: unknown) => b && typeof b === "object" && (b as { type?: string }).type === "text") as { text?: string } | undefined)?.text ?? ""
        : "";
    const preview = text.length > 30 ? text.slice(0, 27) + "..." : text;
    return `${ref} asst(${resolved.tokens}) "${preview}"`;
  }

  // toolResult role — show token count
  return `${ref} tool(${resolved.tokens})`;
}

/**
 * Build a compact context ref map string.
 * Exported so other modules (e.g. collapse tool) can generate a refreshed map.
 */
export function buildContextRefMap(
  resolvedItems: ResolvedItem[],
  contextItems: ContextItemRecord[],
): string {
  if (resolvedItems.length === 0) {
    return "";
  }

  // Build a lookup from ordinal → contextItem
  const contextByOrdinal = new Map<number, ContextItemRecord>();
  for (const ci of contextItems) {
    contextByOrdinal.set(ci.ordinal, ci);
  }

  // Generate entries
  const entries: string[] = [];

  const items = resolvedItems.map((ri) => {
    const ci = contextByOrdinal.get(ri.ordinal);
    return { resolved: ri, context: ci };
  }).filter((x) => x.context != null) as { resolved: ResolvedItem; context: ContextItemRecord }[];

  // Adaptive display limits based on context size
  let headCount: number;
  let tailCount: number;
  let showAll: boolean;

  if (items.length <= 25) {
    showAll = true;
    headCount = 0;
    tailCount = 0;
  } else if (items.length <= 50) {
    showAll = false;
    headCount = 18;
    tailCount = 7;
  } else if (items.length <= 100) {
    showAll = false;
    headCount = 25;
    tailCount = 10;
  } else {
    showAll = false;
    headCount = 30;
    tailCount = 12;
  }

  if (showAll) {
    for (const { resolved, context } of items) {
      entries.push(refMapEntry(resolved.ordinal, context, resolved));
    }
  } else {
    // Show first headCount, ellipsis, last tailCount
    for (let i = 0; i < headCount; i++) {
      const { resolved, context } = items[i];
      entries.push(refMapEntry(resolved.ordinal, context, resolved));
    }
    entries.push(`... +${items.length - headCount - tailCount} more ...`);
    for (let i = items.length - tailCount; i < items.length; i++) {
      const { resolved, context } = items[i];
      entries.push(refMapEntry(resolved.ordinal, context, resolved));
    }
  }

  // Join with " | " and wrap at ~120 chars
  const lines: string[] = [];
  let currentLine = "";
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const sep = currentLine.length > 0 ? " | " : "";
    if (currentLine.length > 0 && currentLine.length + sep.length + entry.length > 120) {
      lines.push(currentLine);
      currentLine = entry;
    } else {
      currentLine += sep + entry;
    }
  }
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return "## Context Refs\n" + lines.join("\n");
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
   * 3. Protect the "fresh tail" (last N items) from truncation.
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

    const summaryGuidance = buildSystemPromptAddition(summarySignals);

    // Build context ref map (always generated)
    const contextRefMap = buildContextRefMap(resolved, contextItems);

    // Combine summary guidance and context ref map
    let systemPromptAddition: string | undefined;
    if (summaryGuidance && contextRefMap) {
      systemPromptAddition = summaryGuidance + "\n\n" + contextRefMap;
    } else if (summaryGuidance) {
      systemPromptAddition = summaryGuidance;
    } else if (contextRefMap) {
      systemPromptAddition = contextRefMap;
    }

    // Step 3: Extract scratchpad items — they go just before the fresh tail
    // regardless of their original position.
    const scratchpadItems: ResolvedItem[] = [];
    const nonScratchpad: ResolvedItem[] = [];
    for (const item of resolved) {
      // Identify scratchpad items by checking the context item type
      const contextItem = contextItems.find((ci) => ci.ordinal === item.ordinal);
      if (contextItem?.itemType === "scratchpad") {
        scratchpadItems.push(item);
      } else {
        nonScratchpad.push(item);
      }
    }

    // Split into evictable prefix and protected fresh tail
    const tailStart = Math.max(0, nonScratchpad.length - freshTailCount);
    const freshTail = nonScratchpad.slice(tailStart);
    const evictable = nonScratchpad.slice(0, tailStart);

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
    } else {
      // Need to drop oldest items until we fit.
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

    // Append scratchpad items just before fresh tail (high-attention zone)
    selected.push(...scratchpadItems);

    // Append fresh tail after the scratchpad
    selected.push(...freshTail);

    const estimatedTokens = evictableTokens + tailTokens;

    // Context budget line: always show usage, with warning if over threshold
    if (tokenBudget > 0) {
      const usageRatio = estimatedTokens / tokenBudget;
      const warningThreshold = input.budgetWarningThreshold ?? 0.7;
      const pct = Math.round(usageRatio * 100);
      const usedK = (estimatedTokens / 1000).toFixed(1);
      const totalK = (tokenBudget / 1000).toFixed(1);

      let budgetLine = `\nContext budget: ~${usedK}k/${totalK}k tokens (${pct}%).`;
      if (usageRatio >= warningThreshold) {
        // Escalating awareness: every 10% over threshold gets a clearer signal
        const stepsOver = Math.floor((usageRatio - warningThreshold) / 0.10);
        if (stepsOver <= 0) {
          budgetLine += ` ⚠️ Budget pressure — consider collapsing stale items.`;
        } else if (stepsOver === 1) {
          budgetLine += ` ⚠️⚠️ Context growing — run lcm_tidy or collapse large items soon.`;
        } else if (stepsOver === 2) {
          budgetLine += ` ⚠️⚠️⚠️ High context usage — tidy now to avoid compaction. Run: lcm_tidy(keepRecentTurns: 3)`;
        } else {
          budgetLine += ` 🚨 Critical context usage (${pct}%) — auto-compaction imminent. Run lcm_tidy immediately.`;
        }

        // Find the 5 largest items in selected (non-fresh-tail, non-scratchpad)
        const evictableWithTokens = selected
          .filter((_, idx) => idx < selected.length - freshTail.length - scratchpadItems.length)
          .map(item => ({ ordinal: item.ordinal, tokens: item.tokens, type: item.isMessage ? 'message' : (item.summarySignal ? 'summary' : 'pointer') }))
          .sort((a, b) => b.tokens - a.tokens)
          .slice(0, 5);

        if (evictableWithTokens.length > 0) {
          budgetLine += `\nLargest collapsible:`;
          for (const item of evictableWithTokens) {
            budgetLine += `\n- §${item.ordinal.toString(16).padStart(3, '0')} (${item.type}): ~${item.tokens} tokens`;
          }
        }
      }

      systemPromptAddition = systemPromptAddition
        ? systemPromptAddition + '\n' + budgetLine
        : budgetLine;
    }

    // Normalize assistant string content to array blocks (some providers return
    // content as a plain string; Anthropic expects content block arrays).
    const rawMessages = selected.map((item) => item.message);
    for (let i = 0; i < rawMessages.length; i++) {
      const msg = rawMessages[i];
      if (msg?.role === "assistant" && typeof msg.content === "string") {
        rawMessages[i] = {
          ...msg,
          content: [{ type: "text", text: msg.content }] as unknown as typeof msg.content,
        } as typeof msg;
      }
    }

    return {
      messages: sanitizeToolUseResultPairing(rawMessages) as AgentMessage[],
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

    if (item.itemType === "pointer" && item.pointerId != null) {
      return this.resolvePointerItem(item);
    }

    if (item.itemType === "scratchpad") {
      return this.resolveScratchpadItem(item);
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
    const tokenCount = msg.tokenCount > 0 ? msg.tokenCount : estimateTokens(contentText);

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
      summarySignal: {
        kind: summary.kind,
        depth: summary.depth,
        descendantCount: summary.descendantCount,
      },
    };
  }

  /**
   * Resolve a context item that references a collapsed pointer.
   * Pointers render as minimal user messages.
   */
  private async resolvePointerItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const pointer = await this.summaryStore.getPointer(item.pointerId!);
    if (!pointer) {
      return null;
    }

    const content = formatPointerContent(pointer, this.timezone);
    const tokens = estimateTokens(content);

    return {
      ordinal: item.ordinal,
      message: { role: "user" as const, content } as AgentMessage,
      tokens,
      isMessage: false,
    };
  }

  /**
   * Resolve a scratchpad context item.
   * The scratchpad renders as a user message with clear boundaries.
   */
  private async resolveScratchpadItem(item: ContextItemRecord): Promise<ResolvedItem | null> {
    const scratchpad = await this.summaryStore.getScratchpad(item.conversationId);
    if (!scratchpad || !scratchpad.content.trim()) {
      return null;
    }

    const content = formatScratchpadContent(scratchpad, this.timezone);
    const tokens = estimateTokens(content);

    return {
      ordinal: item.ordinal,
      message: { role: "user" as const, content } as AgentMessage,
      tokens,
      isMessage: false,
    };
  }

  /**
   * Build a context ref map for a conversation's current context items.
   * Used by tools (e.g. collapse) to show a refreshed map after mutations.
   */
  async buildRefMap(conversationId: number): Promise<string> {
    const contextItems = await this.summaryStore.getContextItems(conversationId);
    if (contextItems.length === 0) {
      return "";
    }
    const resolved = await this.resolveItems(contextItems);
    return buildContextRefMap(resolved, contextItems);
  }
}
