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
  stop_reason?: string;
  isError?: boolean;
  timestamp?: number;
};

type ToolCallLike = {
  id: string;
  name?: string;
};

type WarnLogger = { warn: (message: string) => void };
type ToolUseDropReason = "duplicate" | "terminal";
type DroppedToolUse = ToolCallLike & { reason: ToolUseDropReason };

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

function extractToolCallId(block: {
  id?: unknown;
  call_id?: unknown;
}): string | null {
  if (typeof block.id === "string" && block.id) {
    return block.id;
  }
  if (typeof block.call_id === "string" && block.call_id) {
    return block.call_id;
  }
  return null;
}

function normalizeAssistantReasoningBlocks<T extends AgentMessageLike>(
  message: T
): T {
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
    const rec = block as {
      type?: unknown;
      id?: unknown;
      call_id?: unknown;
      name?: unknown;
    };
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

function getTerminalStopReason(msg: AgentMessageLike): "error" | "aborted" | null {
  const stopReason =
    typeof msg.stopReason === "string"
      ? msg.stopReason
      : typeof msg.stop_reason === "string"
        ? msg.stop_reason
        : undefined;
  return stopReason === "error" || stopReason === "aborted" ? stopReason : null;
}

function isThinkingLikeBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    ["thinking", "redacted_thinking", "reasoning"].includes(
      String((block as { type?: unknown }).type ?? "")
    )
  );
}

function isBlankTextBlock(block: unknown): boolean {
  return (
    !!block &&
    typeof block === "object" &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string" &&
    !(block as { text: string }).text.trim()
  );
}

function isEmptyAfterToolUseDrop(content: unknown): boolean {
  if (!Array.isArray(content)) {
    return false;
  }
  return (
    content.length === 0 ||
    content.every((block) => isThinkingLikeBlock(block) || isBlankTextBlock(block))
  );
}

/**
 * Fingerprint one tool_use block for occurrence-scoped duplicate detection.
 * Model-authored ids (Kimi K3 `name:N`) legitimately recur across turns; two
 * tool_use blocks share an EVENT only when id AND payload match (the store
 * double-write case). Same id with different arguments is a new occurrence.
 */
function fingerprintToolUseBlock(block: unknown): string {
  try {
    return JSON.stringify(block);
  } catch {
    return String(block);
  }
}

/**
 * Remove duplicate assistant `tool_use` blocks during assembly.
 *
 * The Anthropic Messages API rejects a turn containing two assistant tool_use
 * blocks that share an id. Duplicate-ingest can place the same tool_use id on
 * more than one assistant message. This filters tool_use blocks whose id AND
 * payload fingerprint were already emitted (keep-first), while preserving
 * every other block (text, distinct tool calls) — including a legitimate
 * reuse of a recurrent model-authored id with different arguments.
 *
 * - `pendingToolUses` maps each id to the block fingerprints of its calls
 *   that are still awaiting a result. Identity is (id, fingerprint) of a
 *   pending call, never the bare id — recurrent `name:N` ids (Kimi K3)
 *   recur across turns as distinct events, and a fingerprint is retired as
 *   soon as its call pairs, so even identical repeats survive once paired.
 * - record:false leaves surviving fingerprints out of the seen map. Used for
 *   error/aborted turns, which are non-pairable and must not "claim" an id
 *   that a later valid turn legitimately reuses.
 * - dropAll:true strips every tool_use block regardless of the seen map. Also
 *   used for error/aborted turns, whose tool_use blocks may be incomplete.
 */
/** Registered (kept) fingerprints per tool-call id from one filter pass. */
export type KeptToolUseFingerprints = Map<string, string[]>;

function filterAssistantToolUseBlocks<T extends AgentMessageLike>(
  msg: T,
  pendingToolUses: Map<string, Set<string>>,
  consumedToolUses: Map<string, Set<string>>,
  options: { dropAll?: boolean; record?: boolean; consumedReuses?: ReadonlySet<string> } = {}
): { message: T; dropped: DroppedToolUse[]; keptFingerprints: KeptToolUseFingerprints } {
  const { dropAll = false, record = true, consumedReuses } = options;
  const keptFingerprints: KeptToolUseFingerprints = new Map();
  // One assistant turn may NEVER emit two tool-call blocks with the same id
  // (strict providers reject same-id calls within a turn). Recurrent ids are
  // only reusable across turns — collapse same-id repeats here keep-first,
  // regardless of argument fingerprints.
  const keptIdsInThisMessage = new Set<string>();
  const content = msg.content;
  if (!Array.isArray(content)) {
    return { message: msg, dropped: [], keptFingerprints };
  }
  const dropped: DroppedToolUse[] = [];
  const kept: unknown[] = [];
  for (const block of content) {
    if (block && typeof block === "object") {
      const rec = block as {
        type?: unknown;
        id?: unknown;
        call_id?: unknown;
        name?: unknown;
      };
      const id = extractToolCallId(rec);
      const isToolUse =
        !!id && typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type);
      if (isToolUse && id) {
        if (keptIdsInThisMessage.has(id) && !dropAll) {
          dropped.push({
            id,
            name: typeof rec.name === "string" ? rec.name : undefined,
            reason: "duplicate",
          });
          continue;
        }
        const fingerprint = fingerprintToolUseBlock(block);
        // A byte-identical repeat of a STILL-PENDING call is a store
        // double-write (keep-first drop). A repeat of an already-paired
        // (consumed) call is a legitimate fresh occurrence — e.g. `pwd` run
        // twice with the same recurrent id — UNLESS there is no pairable
        // later result for it, in which case it collapses as the double-write
        // remnant. The caller precomputes which consumed ids have a pairable
        // later result (consumedReuses).
        if (
          dropAll ||
          pendingToolUses.get(id)?.has(fingerprint) ||
          (consumedToolUses.get(id)?.has(fingerprint) && !consumedReuses?.has(id))
        ) {
          dropped.push({
            id,
            name: typeof rec.name === "string" ? rec.name : undefined,
            reason: dropAll ? "terminal" : "duplicate",
          });
          continue;
        }
        const keptList = keptFingerprints.get(id);
        keptIdsInThisMessage.add(id);
        if (keptList) {
          keptList.push(fingerprint);
        } else {
          keptFingerprints.set(id, [fingerprint]);
        }
        if (record) {
          const fingerprints = pendingToolUses.get(id);
          if (fingerprints) {
            fingerprints.add(fingerprint);
          } else {
            pendingToolUses.set(id, new Set([fingerprint]));
          }
        }
      }
    }
    kept.push(block);
  }
  if (dropped.length === 0) {
    return { message: msg, dropped, keptFingerprints };
  }
  return { message: { ...msg, content: kept } as T, dropped, keptFingerprints };
}


/** Deep-copy the seen-fingerprint registry for preview passes so speculative
 * registrations never leak into the real pairing state. */
function copyToolUseFingerprints(
  source: Map<string, Set<string>>,
): Map<string, Set<string>> {
  const copy = new Map<string, Set<string>>();
  for (const [id, fingerprints] of source) {
    copy.set(id, new Set(fingerprints));
  }
  return copy;
}

// -- Repair logic (from session-transcript-repair.ts) --

const MISSING_TOOL_RESULT_TEXT =
  "[lossless-claw] missing tool result in session history; inserted synthetic error result for transcript repair.";

function isSyntheticMissingToolResult(message: AgentMessageLike): boolean {
  if (message.isError !== true || !Array.isArray(message.content)) {
    return false;
  }
  return message.content.some(
    (block) =>
      !!block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      (block as { text?: unknown }).text === MISSING_TOOL_RESULT_TEXT,
  );
}

/** Prefer a candidate only when no result exists or it replaces a synthetic repair. */
function shouldUseCandidateToolResult(
  existing: AgentMessageLike | undefined,
  candidate: AgentMessageLike,
): boolean {
  return (
    !existing ||
    (isSyntheticMissingToolResult(existing) && !isSyntheticMissingToolResult(candidate))
  );
}

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
        text: MISSING_TOOL_RESULT_TEXT,
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
 * - Drops duplicate toolResults (an id emitted while no identical call is
 *   awaiting its result)
 * - Drops orphaned toolResults with no matching tool call
 *
 * Pairing is OCCURRENCE-SCOPED, never global-id. Tool-call ids are authored by
 * the model and recur across turns (Kimi K3 `name:N` counters), so an id is
 * treated as a duplicate only while an identical earlier call still awaits its
 * result; each paired id becomes reusable again immediately.
 */
export function sanitizeToolUseResultPairing<T extends AgentMessageLike>(
  messages: T[],
  log?: WarnLogger
): T[] {
  const out: T[] = [];
  // Occurrence-scoped pairing state. Tool-call ids are authored by the model
  // and recur across turns (Kimi K3 `name:N` counters), so duplication is
  // (id, payload-fingerprint) of a PENDING (result-not-yet-paired) call,
  // never a conversation-global id: a legitimate reuse — including a repeat
  // with identical arguments after the first was paired — is a new
  // occurrence and survives; a byte-identical repeat while the first still
  // awaits its result is a store double-write and drops keep-first.
  const pendingToolUses = new Map<string, Set<string>>();
  // Fingerprints of calls whose occurrence already completed (paired or
  // synthesized). A repeat of a consumed fingerprint is a fresh occurrence
  // only when a pairable result still exists for it later in the transcript;
  // otherwise it is a store double-write remnant of the completed event.
  const consumedToolUses = new Map<string, Set<string>>();
  // Per id, the out-indexes of every emitted result, in emission order. A
  // later real result may replace the LATEST synthetic placeholder for its id
  // (backfill repair); positions of earlier real results stay frozen.
  const emittedResultPositions = new Map<string, number[]>();
  const movedToolResultIndexes = new Set<number>();
  let droppedDuplicateCount = 0;
  let droppedDuplicateAssistantToolUseCount = 0;
  let droppedTerminalAssistantToolUseCount = 0;
  let droppedOrphanCount = 0;
  let moved = false;
  let changed = false;

  const recordAssistantToolUseDrops = (dropped: DroppedToolUse[]) => {
    for (const drop of dropped) {
      if (drop.reason === "terminal") {
        droppedTerminalAssistantToolUseCount += 1;
      } else {
        droppedDuplicateAssistantToolUseCount += 1;
      }
    }
  };

  const replaceLatestSyntheticResult = (id: string, candidate: T): boolean => {
    const positions = emittedResultPositions.get(id);
    if (!positions || positions.length === 0) {
      return false;
    }
    const latestIndex = positions[positions.length - 1] as number;
    const existing = out[latestIndex];
    if (existing && shouldUseCandidateToolResult(existing, candidate)) {
      out[latestIndex] = candidate;
      return true;
    }
    return false;
  };

  const pushToolResult = (msg: T) => {
    const id = extractToolResultId(msg);
    if (id) {
      const positions = emittedResultPositions.get(id);
      if (positions) {
        positions.push(out.length);
      } else {
        emittedResultPositions.set(id, [out.length]);
      }
    }
    out.push(msg);
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i];
    if (movedToolResultIndexes.has(i)) {
      continue;
    }
    if (!msg || typeof msg !== "object") {
      out.push(msg);
      continue;
    }

    const role = msg.role;
    if (role !== "assistant") {
      if (role !== "toolResult") {
        out.push(msg);
      } else {
        const orphanId = extractToolResultId(msg);
        // A late real result may still upgrade the latest synthetic
        // placeholder emitted earlier for its id (backfill repair).
        if (orphanId && replaceLatestSyntheticResult(orphanId, msg)) {
          changed = true;
          continue;
        }
        droppedOrphanCount += 1;
        changed = true;
      }
      continue;
    }

    const normalizedAssistant = normalizeAssistantReasoningBlocks(msg);
    if (normalizedAssistant !== msg) {
      changed = true;
    }

    // Drop duplicate assistant tool_use blocks (keep-first). Two assistant
    // tool_use blocks sharing an id cause the Anthropic API to reject the turn;
    // a duplicate is only a block identical to one still awaiting its result.
    const terminal = getTerminalStopReason(normalizedAssistant) !== null;
    const consumedReuses = new Set<string>();
    if (!terminal) {
      const msgBlocks = Array.isArray(normalizedAssistant.content)
        ? (normalizedAssistant.content as unknown[])
        : [];
      for (const block of msgBlocks) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const rec = block as { type?: unknown; id?: unknown; call_id?: unknown };
        const id = extractToolCallId(rec);
        if (!id || typeof rec.type !== "string" || !TOOL_CALL_TYPES.has(rec.type)) {
          continue;
        }
        const fingerprint = fingerprintToolUseBlock(block);
        if (!consumedToolUses.get(id)?.has(fingerprint)) {
          continue;
        }
        for (let ahead = i + 1; ahead < messages.length; ahead += 1) {
          if (movedToolResultIndexes.has(ahead)) {
            continue;
          }
          const nextResult = messages[ahead];
          if (
            nextResult &&
            typeof nextResult === "object" &&
            nextResult.role === "toolResult" &&
            extractToolResultId(nextResult) === id
          ) {
            consumedReuses.add(id);
            break;
          }
        }
      }
    }
    const deduped = filterAssistantToolUseBlocks(
      normalizedAssistant,
      pendingToolUses,
      consumedToolUses,
      // Error/aborted turns are non-pairable: strip their tool_use blocks and
      // do not let them claim an id a later valid turn may legitimately reuse.
      terminal ? { dropAll: true, record: false } : { consumedReuses }
    );
    const assistantMsg = deduped.message;
    const keptFingerprints = deduped.keptFingerprints;
    if (deduped.dropped.length > 0) {
      changed = true;
      recordAssistantToolUseDrops(deduped.dropped);
      if (isEmptyAfterToolUseDrop(assistantMsg.content)) {
        // Nothing left after removing duplicate tool_use blocks; drop the message.
        continue;
      }
    }

    // Skip tool call extraction for aborted or errored assistant messages.
    // When stopReason is "error" or "aborted", the tool_use blocks may be incomplete
    // and should not have synthetic tool_results created.
    if (terminal) {
      out.push(assistantMsg);
      continue;
    }

    const toolCalls = extractToolCallsFromAssistant(assistantMsg);
    if (toolCalls.length === 0) {
      out.push(assistantMsg);
      continue;
    }

    const toolCallIds = new Set(toolCalls.map((t) => t.id));

    const spanResultsById = new Map<string, T>();
    const remainder: T[] = [];

    // Ids the breaking assistant turn survives with: results beyond that
    // turn for these ids belong to the newer occurrence, not this span.
    const boundaryClaimedIds = new Set<string>();
    let j = i + 1;
    for (; j < messages.length; j += 1) {
      const next = messages[j];
      if (movedToolResultIndexes.has(j)) {
        continue;
      }
      if (!next || typeof next !== "object") {
        remainder.push(next);
        continue;
      }

      const nextRole = next.role;
      if (nextRole === "assistant") {
        const normalizedNext = normalizeAssistantReasoningBlocks(next);
        const nextTerminal = getTerminalStopReason(normalizedNext) !== null;
        const preview = filterAssistantToolUseBlocks(
          normalizedNext,
          copyToolUseFingerprints(pendingToolUses),
          copyToolUseFingerprints(consumedToolUses),
          nextTerminal ? { dropAll: true, record: false } : {}
        );
        const nextToolCalls = nextTerminal
          ? []
          : extractToolCallsFromAssistant(preview.message);
        if (nextToolCalls.length > 0) {
          for (const call of nextToolCalls) {
            if (toolCallIds.has(call.id)) {
              boundaryClaimedIds.add(call.id);
            }
          }
          if (preview.dropped.length > 0) {
            const lookaheadToolUses = copyToolUseFingerprints(pendingToolUses);
            for (const block of Array.isArray(preview.message.content)
              ? (preview.message.content as unknown[])
              : []) {
              if (!block || typeof block !== "object") {
                continue;
              }
              const rec = block as { type?: unknown; id?: unknown; call_id?: unknown };
              const id = extractToolCallId(rec);
              if (id && typeof rec.type === "string" && TOOL_CALL_TYPES.has(rec.type)) {
                const fingerprint = fingerprintToolUseBlock(block);
                const fingerprints = lookaheadToolUses.get(id);
                if (fingerprints) {
                  fingerprints.add(fingerprint);
                } else {
                  lookaheadToolUses.set(id, new Set([fingerprint]));
                }
              }
            }
            // The next assistant may mix stale duplicate calls from this span
            // with new calls. Keep that assistant for its own pass, but look
            // past it for delayed results that still belong to the current span.
            for (let k = j + 1; k < messages.length; k += 1) {
              if (movedToolResultIndexes.has(k)) {
                continue;
              }
              const candidate = messages[k];
              if (!candidate || typeof candidate !== "object") {
                continue;
              }
              if (candidate.role === "assistant") {
                const normalizedCandidate = normalizeAssistantReasoningBlocks(candidate);
                const candidateTerminal =
                  getTerminalStopReason(normalizedCandidate) !== null;
                const candidatePreview = filterAssistantToolUseBlocks(
                  normalizedCandidate,
                  copyToolUseFingerprints(lookaheadToolUses),
                  copyToolUseFingerprints(consumedToolUses),
                  candidateTerminal ? { dropAll: true, record: false } : {}
                );
                const candidateToolCalls = candidateTerminal
                  ? []
                  : extractToolCallsFromAssistant(candidatePreview.message);
                if (candidateToolCalls.length > 0) {
                  break;
                }
                continue;
              }
              if (candidate.role !== "toolResult") {
                continue;
              }
              const id = extractToolResultId(candidate);
              // The breaking assistant turn already survives with this id —
              // any result for it beyond that turn belongs to the newer
              // occurrence, never to this span.
              if (!id || !toolCallIds.has(id) || boundaryClaimedIds.has(id)) {
                continue;
              }
              const existing = spanResultsById.get(id);
              if (shouldUseCandidateToolResult(existing, candidate)) {
                spanResultsById.set(id, candidate);
              }
              if (existing) {
                // Not selected for THIS span: leave the index un-moved so the
                // result can still pair a later occurrence of its id (a
                // recurrent-id reuse), it is only a duplicate for this call.
                droppedDuplicateCount += 1;
                changed = true;
                continue;
              }
              movedToolResultIndexes.add(k);
              moved = true;
              changed = true;
            }
          }
          break;
        }
        if (preview.dropped.length > 0 && !nextTerminal) {
          // Assistant whose dropped duplicate ids all belong to this span AND
          // already have a collected in-span result: defer the WHOLE assistant
          // (text and all) to its own main pass — after this span's pair
          // retires the fingerprints its repeated call may legitimately
          // survive as a new occurrence (`pwd` twice). Must not depend on the
          // message emptying: a text-bearing identical repeat otherwise lost
          // its second call/result pair entirely. Single-result transcripts
          // fall through to the swallow path below (keep-first store-dup).
          const droppedIdsDeferred = preview.dropped.every(
            (drop) => toolCallIds.has(drop.id) && spanResultsById.has(drop.id),
          );
          if (droppedIdsDeferred) {
            break;
          }
        }
        if (preview.dropped.length > 0) {
          changed = true;
          recordAssistantToolUseDrops(preview.dropped);
          if (isEmptyAfterToolUseDrop(preview.message.content)) {
            continue;
          }
        }
        remainder.push(preview.message as T);
        continue;
      }

      if (nextRole === "toolResult") {
        const id = extractToolResultId(next);
        if (id && toolCallIds.has(id)) {
          const existing = spanResultsById.get(id);
          if (shouldUseCandidateToolResult(existing, next)) {
            spanResultsById.set(id, next);
          }
          if (existing) {
            droppedDuplicateCount += 1;
            changed = true;
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

    const laterResultsById = new Map<string, { message: T; index: number }>();
    for (let k = j + 1; k < messages.length; k += 1) {
      if (movedToolResultIndexes.has(k)) {
        continue;
      }
      const candidate = messages[k];
      if (!candidate || typeof candidate !== "object") {
        continue;
      }
      if (candidate.role === "assistant") {
        // Results cannot cross an occurrence boundary: the next assistant turn
        // that SURVIVES with a same-id call starts a new pending occurrence of
        // that id, and any result beyond it belongs to the newer occurrence.
        // Without this bound `[call X(a), call X(b), result X]` would let the
        // first call steal the second call's result and synthesize a false
        // missing-result error for the second.
        const normalizedCandidate = normalizeAssistantReasoningBlocks(candidate as T);
        const boundaryPreview = filterAssistantToolUseBlocks(
          normalizedCandidate,
          copyToolUseFingerprints(pendingToolUses),
          copyToolUseFingerprints(consumedToolUses),
          getTerminalStopReason(normalizedCandidate) !== null
            ? { dropAll: true, record: false }
            : {}
        );
        const survivesBoundaryId = extractToolCallsFromAssistant(boundaryPreview.message).some(
          (call) => toolCallIds.has(call.id),
        );
        if (survivesBoundaryId) {
          break;
        }
        continue;
      }
      if (candidate.role !== "toolResult") {
        continue;
      }
      const id = extractToolResultId(candidate);
      if (!id || !toolCallIds.has(id) || boundaryClaimedIds.has(id)) {
        continue;
      }
      const existing = laterResultsById.get(id);
      // Occurrence-ordered pairing: the NEAREST later result pairs this call;
      // keep-first unless it upgrades a synthetic placeholder.
      if (!existing || shouldUseCandidateToolResult(existing.message, candidate)) {
        laterResultsById.set(id, { message: candidate, index: k });
      }
    }

    out.push(assistantMsg);

    if (spanResultsById.size > 0 && remainder.length > 0) {
      moved = true;
      changed = true;
    }

    const emittedCallIds = new Set<string>();
    for (const call of toolCalls) {
      // One result per id per assistant turn, even if the turn carries
      // multiple same-id blocks; pairing is by id, so a second same-id call
      // here stays pending for a genuinely later result.
      if (emittedCallIds.has(call.id)) {
        continue;
      }
      emittedCallIds.add(call.id);
      let existing = spanResultsById.get(call.id);
      const later = laterResultsById.get(call.id);
      if (later && shouldUseCandidateToolResult(existing, later.message)) {
        existing = later.message;
        movedToolResultIndexes.add(later.index);
        moved = true;
        changed = true;
      }
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
    // Occurrence completed (paired or synthesized): retire only the
    // fingerprints THIS assistant registered for the emitted ids, so an
    // identical later turn is a fresh occurrence while still-pending
    // identical repeats from before the pair remain dedup candidates.
    for (const id of emittedCallIds) {
      const fingerprints = pendingToolUses.get(id);
      for (const fingerprint of keptFingerprints.get(id) ?? []) {
        fingerprints?.delete(fingerprint);
        const consumed = consumedToolUses.get(id);
        if (consumed) {
          consumed.add(fingerprint);
        } else {
          consumedToolUses.set(id, new Set([fingerprint]));
        }
      }
      if (fingerprints && fingerprints.size === 0) {
        pendingToolUses.delete(id);
      }
    }

    for (const rem of remainder) {
      out.push(rem);
    }
    i = j - 1;
  }

  if (droppedDuplicateAssistantToolUseCount > 0 && log) {
    log.warn(
      `[lossless-claw] sanitizeToolUseResultPairing dropped ${droppedDuplicateAssistantToolUseCount} duplicate assistant tool_use block(s)`
    );
  }
  if (droppedTerminalAssistantToolUseCount > 0 && log) {
    log.warn(
      `[lossless-claw] sanitizeToolUseResultPairing stripped ${droppedTerminalAssistantToolUseCount} non-pairable terminal assistant tool_use block(s)`
    );
  }

  const changedOrMoved = changed || moved;
  return changedOrMoved ? out : messages;
}
