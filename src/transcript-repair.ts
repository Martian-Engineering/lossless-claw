/**
 * Tool use/result pairing repair for assembled context.
 *
 * Copied from openclaw core (src/agents/session-transcript-repair.ts +
 * src/agents/tool-call-id.ts) to avoid depending on unexported internals.
 * When the plugin SDK exports sanitizeToolUseResultPairing, this file can
 * be removed in favor of the SDK import.
 */

// -- Types (minimal, matching AgentMessage shape) --

type AgentMessageLike = {
  role: string;
  content?: unknown;
  toolCallId?: string;
  toolUseId?: string;
  toolName?: string;
  stopReason?: string;
  isError?: boolean;
  timestamp?: number;
};

type ToolCallLike = {
  id: string;
  name?: string;
};

// -- Extraction helpers (from tool-call-id.ts) --

const TOOL_CALL_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "tool-use",
  "functionCall",
  "function_call",
]);
const OPENAI_FUNCTION_CALL_TYPES = new Set(["functionCall", "function_call"]);

function extractToolCallId(block: { id?: unknown; call_id?: unknown }): string | null {
  if (typeof block.id === "string" && block.id) {
    return block.id;
  }
  if (typeof block.call_id === "string" && block.call_id) {
    return block.call_id;
  }
  return null;
}

function normalizeAssistantReasoningBlocks<T extends AgentMessageLike>(message: T): T {
  if (!Array.isArray(message.content)) {
    return message;
  }

  let sawToolCall = false;
  let reasoningAfterToolCall = false;
  let functionCallCount = 0;

  for (const block of message.content) {
    if (!block || typeof block !== "object") {
      return message;
    }

    const type = (block as { type?: unknown }).type;
    if (type === "reasoning" || type === "thinking") {
      if (sawToolCall) {
        reasoningAfterToolCall = true;
      }
      continue;
    }

    if (typeof type === "string" && TOOL_CALL_TYPES.has(type)) {
      sawToolCall = true;
      if (OPENAI_FUNCTION_CALL_TYPES.has(type)) {
        functionCallCount += 1;
      }
      continue;
    }

    return message;
  }

  // Only repair the specific OpenAI shape we need: a single function call that
  // has one or more reasoning blocks after it. Multi-call turns may use
  // interleaved reasoning intentionally, so leave them untouched.
  if (!reasoningAfterToolCall || functionCallCount !== 1) {
    return message;
  }

  const reasoning = message.content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return type === "reasoning" || type === "thinking";
  });
  const toolCalls = message.content.filter((block) => {
    const type = (block as { type?: unknown }).type;
    return typeof type === "string" && TOOL_CALL_TYPES.has(type);
  });

  return {
    ...message,
    content: [...reasoning, ...toolCalls],
  };
}

function extractToolCallsFromAssistant(msg: AgentMessageLike): ToolCallLike[] {
  const content = msg.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const toolCalls: ToolCallLike[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const rec = block as { type?: unknown; id?: unknown; call_id?: unknown; name?: unknown };
    const id = extractToolCallId(rec);
    if (!id) {
      continue;
    }
    if (typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
      toolCalls.push({
        id,
        name: typeof rec.name === "string" ? rec.name : undefined,
      });
    }
  }
  return toolCalls;
}

function extractToolResultId(msg: AgentMessageLike): string | null {
  if (typeof msg.toolCallId === "string" && msg.toolCallId) {
    return msg.toolCallId;
  }
  if (typeof msg.toolUseId === "string" && msg.toolUseId) {
    return msg.toolUseId;
  }
  return null;
}

// -- Repair logic (from session-transcript-repair.ts) --

function makeMissingToolResult(params: {
  toolCallId: string;
  toolName?: string;
}): AgentMessageLike {
  return {
    role: "toolResult",
    toolCallId: params.toolCallId,
    toolName: params.toolName ?? "unknown",
    content: [
      {
        type: "text",
        text: "[lossless-claw] missing tool result in session history; inserted synthetic error result for transcript repair.",
      },
    ],
    isError: true,
  };
}

/**
 * Repair tool use/result pairing in an assembled message transcript.
 *
 * Anthropic (and Cloud Code Assist) reject transcripts where assistant tool
 * calls are not immediately followed by matching tool results. This function:
 * - Moves matching toolResult messages directly after their assistant toolCall turn
 * - Inserts synthetic error toolResults for missing IDs
 * - Drops duplicate toolResults for the same ID
 * - Drops orphaned toolResults with no matching tool call
 */
export function sanitizeToolUseResultPairing<T extends AgentMessageLike>(messages: T[]): T[] {
  const out: T[] = [];
  const seenToolResultIds = new Set<string>();
  let droppedDuplicateCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = false;

  const pushToolResult = (msg: T) => {
    const id = extractToolResultId(msg);
    if (id && seenToolResultIds.has(id)) {
      droppedDuplicateCount += 1;
      changed = true;
      return;
    }
    if (id) {
      seenToolResultIds.add(id);
    }
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = msg.role;
    if (role !== "assistant") {
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const normalizedAssistant = normalizeAssistantReasoningBlocks(msg);
    if (normalizedAssistant !== msg) {
      changed = true;
    }

    // Skip tool call extraction for aborted or errored assistant messages.
    // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
    // and should not have synthetic tool_results created.
    const stopReason = normalizedAssistant.stopReason;
    if (stopReason === "error" || stopReason === "aborted") {
      out.push(normalizedAssistant as T);
      continue;
    }

    const toolCalls = extractToolCallsFromAssistant(normalizedAssistant);
    if (toolCalls.length === 0) {
      out.push(normalizedAssistant as T);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));

    const spanResultsById = new Map<string, T>();
    const remainder: T[] = [];

    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      const nextRole = next.role;
      if (nextRole === "assistant") {
        break;
      }

      if (nextRole === "toolResult") {
        const id = extractToolResultId(next);
        if (id && toolCallIds.has(id)) {
          if (seenToolResultIds.has(id)) {
            droppedDuplicateCount += 1;
            changed = true;
            continue;
          }
          if (!spanResultsById.has(id)) {
            spanResultsById.set(id, next);
          }
          continue;
        }
      }

      if (next.role !== "toolResult") {
        remainder.push(next);
      } else {
        droppedOrphanCount += 1;
        changed = true;
      }
    }

    out.push(normalizedAssistant as T);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }

    for (const call of toolCalls) {
      const existing = spanResultsById.get(call.id);
      if (existing) {
        pushToolResult(existing);
      } else {
        const missing = makeMissingToolResult({
          toolCallId: call.id,
          toolName: call.name,
        });
        changed = true;
        pushToolResult(missing as T);
      }
    }

    for (const rem of remainder) {
      out.push(rem);
    }
    i = j - 1;
  }

  const changedOrMoved = changed || moved;
  return changedOrMoved ? out : messages;
}
