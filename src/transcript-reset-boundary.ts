/**
 * Locate the latest same-session `/reset` boundary on the visible transcript
 * path.
 *
 * OpenClaw appends `/new` and `/reset` as an in-log `reset` event in the same
 * session. The visible-message delta returns only `message` events and its
 * initial cursor starts at active message position 0, so pre-reset history is
 * returned too. The boundary is recovered from the raw event stream: each
 * visible entry's `parentId` is the previous active event, so walking back
 * through non-message raw events from a "gap" (an entry whose parent is not
 * the previous visible message) finds any reset event on the active path.
 * A reset can also trail the last visible message, which is the normal shape
 * right after `/reset`: the next turn bootstraps before its user message is
 * visible. Walking back from the raw tip to the last visible entry finds it.
 */
import type {
  SessionTranscriptRawDeltaParams,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptReadTarget,
} from "./types.js";

/** Payload-free view of one visible entry. */
export type VisibleEntrySkeleton = {
  entryId: string;
  parentId: string | null;
};

/** Navigation facts for one raw non-message transcript event. */
export type NonMessageTranscriptEvent = {
  type: string;
  parentId: string | null;
};

/** Raw facts the boundary walk needs: non-message events plus the raw tip. */
export type RawTranscriptNavigation = {
  nonMessageEvents: Map<string, NonMessageTranscriptEvent>;
  /** Id and parent of the last raw event, when the stream is non-empty. */
  tip: { id: string; parentId: string | null; type: string } | null;
};

type RawDeltaReader = (
  params: SessionTranscriptRawDeltaParams,
) => Promise<SessionTranscriptRawDeltaResult>;

const RAW_PAGE_MAX_BYTES = 8 * 1024 * 1024;
const RAW_PAGE_MAX_EVENTS = 10_000;
const RAW_PAGE_HARD_MAX_BYTES = 64 * 1024 * 1024;
const MAX_RAW_SCAN_RESTARTS = 3;
const MAX_NON_MESSAGE_CHAIN = 10_000;

/** Return visible indexes whose parent is not the previous visible message. */
export function findVisibleGapIndexes(entries: readonly VisibleEntrySkeleton[]): number[] {
  const gaps: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const expectedParent = index === 0 ? null : entries[index - 1]!.entryId;
    if (entries[index]!.parentId !== expectedParent) {
      gaps.push(index);
    }
  }
  return gaps;
}

/**
 * Return the index of the first visible entry after the latest on-path reset,
 * `entries.length` when a reset trails the last visible entry (an empty
 * post-reset window), or 0 when no reset precedes any visible entry.
 *
 * The trailing chain from the raw tip back to the last visible entry is
 * checked first; then gaps are visited newest first, following each chain of
 * non-message parents until it reaches the previous visible message, an
 * unknown event, or a reset. The first reset found is the latest one on the
 * active path.
 */
export function resolvePostResetStartIndex(
  entries: readonly VisibleEntrySkeleton[],
  navigation: RawTranscriptNavigation,
): number {
  const lastEntryId = entries.at(-1)?.entryId ?? null;
  if (navigation.tip && navigation.tip.id !== lastEntryId) {
    // Walk the run of non-message events after the last visible message.
    let event: NonMessageTranscriptEvent | undefined =
      navigation.tip.type === "message"
        ? undefined
        : { type: navigation.tip.type, parentId: navigation.tip.parentId };
    for (let steps = 0; event && steps < MAX_NON_MESSAGE_CHAIN; steps += 1) {
      if (event.type === "reset") {
        return entries.length;
      }
      if (!event.parentId || event.parentId === lastEntryId) {
        break;
      }
      event = navigation.nonMessageEvents.get(event.parentId);
    }
  }
  const gaps = findVisibleGapIndexes(entries);
  for (let gapIndex = gaps.length - 1; gapIndex >= 0; gapIndex -= 1) {
    const index = gaps[gapIndex]!;
    const previousEntryId = index === 0 ? null : entries[index - 1]!.entryId;
    let node = entries[index]!.parentId;
    // Walk the run of non-message events between two visible messages.
    for (let steps = 0; node && node !== previousEntryId && steps < MAX_NON_MESSAGE_CHAIN; steps += 1) {
      const event = navigation.nonMessageEvents.get(node);
      if (!event) {
        break;
      }
      if (event.type === "reset") {
        return index;
      }
      node = event.parentId;
    }
  }
  return 0;
}

/** Narrow one raw transcript event to the fields the boundary walk needs. */
function readNonMessageEvent(
  event: unknown,
): { id: string; value: NonMessageTranscriptEvent } | null {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as { id?: unknown; parentId?: unknown; type?: unknown };
  if (typeof record.id !== "string" || typeof record.type !== "string" || record.type === "message") {
    return null;
  }
  return {
    id: record.id,
    value: {
      type: record.type,
      parentId: typeof record.parentId === "string" ? record.parentId : null,
    },
  };
}

/** Id, parent and type of one raw event, when it carries an id. */
function readEventTip(event: unknown): RawTranscriptNavigation["tip"] {
  if (!event || typeof event !== "object") {
    return null;
  }
  const record = event as { id?: unknown; parentId?: unknown; type?: unknown };
  if (typeof record.id !== "string" || typeof record.type !== "string") {
    return null;
  }
  return {
    id: record.id,
    parentId: typeof record.parentId === "string" ? record.parentId : null,
    type: record.type,
  };
}

/**
 * Scan the raw transcript once and collect every non-message event plus the
 * raw tip. Returns null when the raw stream cannot be read completely; callers
 * must then treat the reset boundary as unknown.
 */
export async function collectRawTranscriptNavigation(params: {
  read: RawDeltaReader;
  target: SessionTranscriptReadTarget;
  yieldToEventLoop: () => Promise<void>;
}): Promise<RawTranscriptNavigation | null> {
  for (let attempt = 0; attempt <= MAX_RAW_SCAN_RESTARTS; attempt += 1) {
    const events = new Map<string, NonMessageTranscriptEvent>();
    let tip: RawTranscriptNavigation["tip"] = null;
    let cursor: string | undefined;
    let maxBytes = RAW_PAGE_MAX_BYTES;
    let restart = false;
    // Page through the raw stream; a generation change restarts the scan.
    for (;;) {
      const result = await params.read({
        ...params.target,
        ...(cursor !== undefined ? { cursor } : {}),
        maxBytes,
        maxEvents: RAW_PAGE_MAX_EVENTS,
      });
      if (result.kind === "missing") {
        return { nonMessageEvents: events, tip };
      }
      if (result.kind === "reset") {
        restart = true;
        break;
      }
      if (result.events.length === 0 && result.hasMore) {
        // One event exceeds the page budget; grow the budget up to the host cap.
        const required = result.requiredBytes ?? maxBytes * 2;
        if (required > RAW_PAGE_HARD_MAX_BYTES) {
          return null;
        }
        maxBytes = Math.max(maxBytes, required);
        continue;
      }
      for (const row of result.events) {
        const parsed = readNonMessageEvent(row.event);
        if (parsed) {
          events.set(parsed.id, parsed.value);
        }
        tip = readEventTip(row.event) ?? tip;
      }
      cursor = result.cursor;
      maxBytes = RAW_PAGE_MAX_BYTES;
      if (!result.hasMore) {
        return { nonMessageEvents: events, tip };
      }
      await params.yieldToEventLoop();
    }
    if (!restart) {
      break;
    }
  }
  return null;
}
