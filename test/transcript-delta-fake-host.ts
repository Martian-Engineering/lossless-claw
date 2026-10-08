/**
 * In-memory stand-in for OpenClaw's SQLite transcript delta readers.
 *
 * It models the result shapes of `readSessionTranscriptVisibleMessageDelta`
 * and `readSessionTranscriptRawDelta` (page / reset reasons / unavailable /
 * missing, opaque cursors, byte and count bounds, the current-turn fence) over
 * a single active path of events. Copy-on-write rewrites re-issue ids and
 * rotate the generation exactly like the host's suffix rewrites.
 */
import type { AgentMessage } from "../src/openclaw-bridge.js";
import type {
  SessionTranscriptRawDeltaParams,
  SessionTranscriptRawDeltaResult,
  SessionTranscriptVisibleMessageDeltaParams,
  SessionTranscriptVisibleMessageDeltaResult,
  VisibleSessionTranscriptMessageEntry,
} from "../src/types.js";

type MessageEvent = {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
  supersedesEntryId?: string;
};
type ControlEvent = { type: string; id: string; parentId: string | null; timestamp: string };
type TranscriptEvent = MessageEvent | ControlEvent;

type VisibleCursor = { g: string; s: string; pos: number; id: string | null };
type RawCursor = { g: string; s: string; idx: number };

/** Mirrors OpenClaw's error class name, which the engine matches on. */
export class SessionTranscriptReadFenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionTranscriptReadFenceError";
  }
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decode<T>(value: string): T | null {
  try {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export class FakeTranscriptHost {
  readonly sessionId: string;
  generation = "gen-1";
  /** Active path, in order. Abandoned events are kept only in `raw`. */
  path: TranscriptEvent[] = [];
  /** Raw append log, including events that left the active path. */
  raw: TranscriptEvent[] = [];
  unavailable = false;
  missing = false;
  /** Current-turn fence: visible reads stop before this message position. */
  fencePosition: number | null = null;
  visibleReads = 0;
  visibleEntriesReturned = 0;
  rawReads = 0;
  private nextId = 1;
  private clock = Date.parse("2026-10-08T12:00:00.000Z");

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  private mint(prefix: string): string {
    const id = `${prefix}-${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }

  private push(event: TranscriptEvent): void {
    this.path.push(event);
    this.raw.push(event);
  }

  /** Append one message on the active path; returns its entry id. */
  append(message: AgentMessage, options?: { supersedesEntryId?: string }): string {
    const id = this.mint("e");
    this.push({
      type: "message",
      id,
      parentId: this.path.at(-1)?.id ?? null,
      timestamp: this.tick(),
      message,
      ...(options?.supersedesEntryId ? { supersedesEntryId: options.supersedesEntryId } : {}),
    });
    return id;
  }

  /** Append a non-message control event such as `reset` or `model_change`. */
  appendControl(type: string): string {
    const id = this.mint(type);
    this.push({ type, id, parentId: this.path.at(-1)?.id ?? null, timestamp: this.tick() });
    return id;
  }

  /** Message entries currently on the active path. */
  visibleMessages(): MessageEvent[] {
    return this.path.filter((event): event is MessageEvent => event.type === "message");
  }

  /** Message position of an entry id on the active path, or -1. */
  positionOf(entryId: string): number {
    return this.visibleMessages().findIndex((event) => event.id === entryId);
  }

  /** Change one message payload in place without changing its id; rotates the generation. */
  rewriteInPlace(entryId: string, message: AgentMessage): void {
    const event = this.visibleMessages().find((candidate) => candidate.id === entryId);
    if (!event) {
      throw new Error(`unknown entry ${entryId}`);
    }
    event.message = message;
    this.rotate();
  }

  /**
   * Copy-on-write rewrite from one message: the suffix is re-appended under
   * new ids (optionally declaring `supersedesEntryId`) and the generation rotates.
   */
  rewriteSuffixFrom(
    entryId: string,
    options: { declareSupersedes: boolean; replace?: (message: AgentMessage) => AgentMessage },
  ): Map<string, string> {
    const index = this.path.findIndex((event) => event.id === entryId);
    if (index < 0) {
      throw new Error(`unknown entry ${entryId}`);
    }
    const suffix = this.path.slice(index);
    this.path = this.path.slice(0, index);
    const mapping = new Map<string, string>();
    for (const event of suffix) {
      if (event.type === "message") {
        const message = event as MessageEvent;
        const newId = this.append(
          options.replace && message.id === entryId ? options.replace(message.message) : message.message,
          options.declareSupersedes ? { supersedesEntryId: message.id } : undefined,
        );
        mapping.set(message.id, newId);
      } else {
        mapping.set(event.id, this.appendControl(event.type));
      }
    }
    this.rotate();
    return mapping;
  }

  rotate(): void {
    this.generation = `gen-${Number(this.generation.slice(4)) + 1}`;
  }

  private visibleEntry(event: MessageEvent, position: number): VisibleSessionTranscriptMessageEntry {
    const pathIndex = this.path.indexOf(event);
    return {
      entryId: event.id,
      parentId: pathIndex > 0 ? this.path[pathIndex - 1]!.id : null,
      seq: position + 1,
      message: event.message,
      role: event.message.role,
      createdAt: event.timestamp,
      ...(event.supersedesEntryId ? { supersedesEntryId: event.supersedesEntryId } : {}),
    };
  }

  /** Visible-message delta with the host's cursor, reset, fence, and bound semantics. */
  readVisibleDelta = async (
    params: SessionTranscriptVisibleMessageDeltaParams,
  ): Promise<SessionTranscriptVisibleMessageDeltaResult> => {
    this.visibleReads += 1;
    if (this.unavailable) {
      return { kind: "unavailable", reason: "projection_rebuilding" };
    }
    if (this.missing) {
      return { kind: "missing" };
    }
    const initial: VisibleCursor = { g: this.generation, s: params.sessionId, pos: -1, id: null };
    const reset = (
      reason: Extract<SessionTranscriptVisibleMessageDeltaResult, { kind: "reset" }>["reason"],
    ): SessionTranscriptVisibleMessageDeltaResult => ({ kind: "reset", cursor: encode(initial), reason });
    const cursor = params.cursor === undefined ? initial : decode<VisibleCursor>(params.cursor);
    if (!cursor) {
      return reset("invalid_cursor");
    }
    if (cursor.s !== params.sessionId) {
      return reset("scope_mismatch");
    }
    if (cursor.g !== this.generation) {
      return reset("generation_mismatch");
    }
    const messages = this.visibleMessages();
    if (this.fencePosition !== null && cursor.pos >= this.fencePosition) {
      throw new SessionTranscriptReadFenceError(
        "Transcript read cursor has crossed the current-turn admission fence",
      );
    }
    if (cursor.id !== null) {
      const position = messages.findIndex((event) => event.id === cursor.id);
      if (position < 0) {
        return reset("anchor_missing");
      }
      if (position !== cursor.pos) {
        return reset("anchor_moved");
      }
    }
    const end = this.fencePosition ?? messages.length;
    const maxMessages = params.maxMessages ?? 1000;
    const maxBytes = params.maxBytes ?? 1_000_000;
    const entries: VisibleSessionTranscriptMessageEntry[] = [];
    let bytes = 0;
    let position = cursor.pos + 1;
    let requiredBytes: number | undefined;
    for (; position < end; position += 1) {
      const size = JSON.stringify(messages[position]).length + 1;
      if (entries.length >= maxMessages || bytes + size > maxBytes) {
        if (entries.length === 0) {
          requiredBytes = size;
        }
        break;
      }
      bytes += size;
      entries.push(this.visibleEntry(messages[position]!, position));
    }
    this.visibleEntriesReturned += entries.length;
    const last = entries.at(-1);
    const next: VisibleCursor = last
      ? { ...cursor, pos: last.seq - 1, id: last.entryId }
      : cursor;
    return {
      kind: "page",
      cursor: encode(next),
      entries,
      hasMore: position < end,
      ...(requiredBytes !== undefined ? { requiredBytes } : {}),
      serializedBytes: bytes,
    };
  };

  /** Raw delta over the append log (all event types, including abandoned ones). */
  readRawDelta = async (params: SessionTranscriptRawDeltaParams): Promise<SessionTranscriptRawDeltaResult> => {
    this.rawReads += 1;
    if (this.missing) {
      return { kind: "missing" };
    }
    const initial: RawCursor = { g: this.generation, s: params.sessionId, idx: -1 };
    const cursor = params.cursor === undefined ? initial : decode<RawCursor>(params.cursor);
    if (!cursor) {
      return { kind: "reset", cursor: encode(initial), reason: "invalid_cursor" };
    }
    if (cursor.g !== this.generation) {
      return { kind: "reset", cursor: encode(initial), reason: "generation_mismatch" };
    }
    const maxEvents = params.maxEvents ?? 1000;
    const start = cursor.idx + 1;
    const events = this.raw.slice(start, start + maxEvents).map((event, offset) => ({
      event: structuredClone(event),
      seq: start + offset,
    }));
    const lastIdx = start + events.length - 1;
    return {
      kind: "page",
      cursor: encode({ ...cursor, idx: events.length > 0 ? lastIdx : cursor.idx }),
      events,
      hasMore: lastIdx + 1 < this.raw.length,
      serializedBytes: 0,
    };
  };

  /** Full visible read, as `readVisibleSessionTranscriptMessageEntries` returns it. */
  readVisibleEntries = async (): Promise<VisibleSessionTranscriptMessageEntry[]> =>
    this.visibleMessages().map((event, position) => this.visibleEntry(event, position));
}
