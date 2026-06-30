import type { ContextEngine } from "./openclaw-bridge.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

/**
 * Envelope metadata for one transcript JSONL entry. OpenClaw writes each
 * message line as `{type:"message", id, parentId, timestamp, message}`; the
 * `id` is the stable per-entry identity that makes transcript imports
 * idempotent. All fields are null for transcripts that lack envelopes
 * (JSON-array session files, bare `{role, content}` lines).
 */
export type TranscriptEntryMeta = {
  entryId: string | null;
  parentId: string | null;
  timestamp: string | null;
};

/**
 * Symbol-keyed so the metadata survives object spread but stays invisible to
 * JSON serialization and message-content identity hashing.
 */
const TRANSCRIPT_ENTRY_META = Symbol.for("lossless-claw.transcriptEntryMeta");

export function attachTranscriptEntryMeta(
  message: AgentMessage,
  meta: TranscriptEntryMeta,
): AgentMessage {
  (message as unknown as Record<symbol, TranscriptEntryMeta>)[TRANSCRIPT_ENTRY_META] = meta;
  return message;
}

export function getTranscriptEntryMeta(message: AgentMessage): TranscriptEntryMeta | null {
  const meta = (message as unknown as Record<symbol, TranscriptEntryMeta | undefined>)[
    TRANSCRIPT_ENTRY_META
  ];
  return meta ?? null;
}

export function getTranscriptEntryId(message: AgentMessage): string | null {
  return getTranscriptEntryMeta(message)?.entryId ?? null;
}

export function resolveTranscriptMessageCreatedAt(message: AgentMessage): Date | string | undefined {
  const raw = message as unknown as Record<string, unknown>;
  const value = raw.timestamp ?? raw.createdAt ?? raw.created_at;
  if (typeof value === "number") {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) ? parsed : undefined;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : undefined;
  }
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  return getTranscriptEntryMeta(message)?.timestamp ?? undefined;
}

/**
 * The full-precision INNER source timestamp of a transcript message
 * (message.timestamp / createdAt / created_at) as resolveTranscriptMessageCreatedAt
 * reads it, BEFORE the store truncates it to a whole second. Returned as a
 * number of epoch milliseconds when parseable, else the trimmed string, else
 * null. The per-entry envelope timestamp is intentionally NOT used as a
 * fallback: OpenClaw re-stamps it fresh on every re-append, so it cannot
 * identify a frozen source event. Used only for replay-twin detection, which
 * must fail open when no inner timestamp is present.
 */
export function resolveTranscriptMessageInnerTimestamp(message: AgentMessage): number | string | null {
  const raw = message as unknown as Record<string, unknown>;
  const value = raw.timestamp ?? raw.createdAt ?? raw.created_at;
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.getTime() : null;
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return null;
}

function normalizeEnvelopeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
