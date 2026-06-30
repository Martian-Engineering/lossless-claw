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

function normalizeEnvelopeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
