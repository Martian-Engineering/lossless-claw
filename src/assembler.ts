import type { ContextEngine } from "openclaw/plugin-sdk";
import { sanitizeToolUseResultPairing } from "./transcript-repair.js";
import type {
  ConversationStore,
  MessagePartRecord,
  MessageRole,
} from "./store/conversation-store.js";
import type { SummaryStore, ContextItemRecord, SummaryRecord } from "./store/summary-store.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

// ── Public types ─────────────────────────────────────────────────────────────

export interface AssembleContextInput {
  conversationId: number;
  tokenBudget: number;
  /** Number of most recent raw turns to always include (default: 8) */
  freshTailCount?: number;
}

export interface AssembleContextResult {
  /** Ordered messages ready for the model */
  messages: AgentMessage[];
  /** Total estimated tokens */
  estimatedTokens: number;
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
  const decoded = parseJson(part.metadata);
  if (decoded && typeof decoded === "object") {
    const raw = (decoded as { raw?: unknown }).raw;
    if (raw && typeof raw === "object") {
      return raw;
    }
  }

  if (part.partType === "text" || part.partType === "reasoning") {
    return { type: "text", text: part.textContent ?? "" };
  }
  if (part.partType === "tool") {
    const toolOutput = parseJson(part.toolOutput);
    if (toolOutput !== undefined) {
      return toolOutput;
    }
    if (typeof part.textContent === "string") {
      return { type: "text", text: part.textContent };
    }
    return { type: "text", text: part.toolOutput ?? part.toolInput ?? "" };
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

function toSafeCdata(value: string): string {
  return value.replaceAll("]]>", "]]]]><![CDATA[>");
}

/**
 * Format a summary record into the XML payload string the model sees.
 */
async function formatSummaryContent(
  summary: SummaryRecord,
  summaryStore: SummaryStore,
): Promise<string> {
  const attributes = [
    `id="${summary.summaryId}"`,
    `kind="${summary.kind}"`,
    `depth="${summary.depth}"`,
    `descendant_count="${summary.descendantCount}"`,
  ];
  if (summary.earliestAt) {
    attributes.push(`earliest_at="${summary.earliestAt.toISOString()}"`);
  }
  if (summary.latestAt) {
    attributes.push(`latest_at="${summary.latestAt.toISOString()}"`);
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

  lines.push("  <content><![CDATA[");
  lines.push(toSafeCdata(summary.content));
  lines.push("]]></content>");
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
}

// ── ContextAssembler ─────────────────────────────────────────────────────────

export class ContextAssembler {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
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
    for (const item of resolved) {
      if (item.isMessage) {
        rawMessageCount++;
      } else {
        summaryCount++;
      }
    }

    // Step 3: Split into evictable prefix and protected fresh tail
    const tailStart = Math.max(0, resolved.length - freshTailCount);
    const freshTail = resolved.slice(tailStart);
    const evictable = resolved.slice(0, tailStart);

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

    // Append fresh tail after the evictable prefix
    selected.push(...freshTail);

    const estimatedTokens = evictableTokens + tailTokens;

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
    const roleFromStore = toRuntimeRole(msg.role, parts);
    const toolCallId = roleFromStore === "toolResult" ? pickToolCallId(parts) : undefined;
    // Tool results without a call id cannot be serialized for Anthropic-compatible APIs.
    // This happens for legacy/bootstrap rows that have role=tool but no message_parts.
    // Preserve the text by degrading to assistant content instead of emitting invalid toolResult.
    const role: "user" | "assistant" | "toolResult" =
      roleFromStore === "toolResult" && !toolCallId ? "assistant" : roleFromStore;
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

    const content = await formatSummaryContent(summary, this.summaryStore);
    const tokens = estimateTokens(content);

    // Cast: summaries are synthetic user messages without full AgentMessage metadata
    return {
      ordinal: item.ordinal,
      message: { role: "user" as const, content } as AgentMessage,
      tokens,
      isMessage: false,
    };
  }
}
