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
 * or 0 when no reset precedes any visible entry.
 *
 * Gaps are visited newest first; for each gap the chain of non-message parents
 * is followed until it reaches the previous visible message, an unknown event,
 * or a reset. The first reset found is the latest one on the active path.
 */
export function resolvePostResetStartIndex(
  entries: readonly VisibleEntrySkeleton[],
  nonMessageEvents: ReadonlyMap<string, NonMessageTranscriptEvent>,
): number {
  const gaps = findVisibleGapIndexes(entries);
  for (let gapIndex = gaps.length - 1; gapIndex >= 0; gapIndex -= 1) {
    const index = gaps[gapIndex]!;
    const previousEntryId = index === 0 ? null : entries[index - 1]!.entryId;
    let node = entries[index]!.parentId;
    // Walk the run of non-message events between two visible messages.
    for (let steps = 0; node && node !== previousEntryId && steps < MAX_NON_MESSAGE_CHAIN; steps += 1) {
      const event = nonMessageEvents.get(node);
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

/**
 * Scan the raw transcript once and collect every non-message event. Returns
 * null when the raw stream cannot be read completely; callers must then treat
 * the reset boundary as unknown.
 */
export async function collectNonMessageTranscriptEvents(params: {
  read: RawDeltaReader;
  target: SessionTranscriptReadTarget;
  yieldToEventLoop: () => Promise<void>;
}): Promise<Map<string, NonMessageTranscriptEvent> | null> {
  for (let attempt = 0; attempt <= MAX_RAW_SCAN_RESTARTS; attempt += 1) {
    const events = new Map<string, NonMessageTranscriptEvent>();
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
        return events;
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
      }
      cursor = result.cursor;
      maxBytes = RAW_PAGE_MAX_BYTES;
      if (!result.hasMore) {
        return events;
      }
      await params.yieldToEventLoop();
    }
    if (!restart) {
      break;
    }
  }
  return null;
}
