import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
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

function extractEnvelopeMeta(entry: Record<string, unknown>): TranscriptEntryMeta {
  return {
    entryId: normalizeEnvelopeString(entry.id) ?? normalizeEnvelopeString(entry.uuid),
    parentId: normalizeEnvelopeString(entry.parentId) ?? normalizeEnvelopeString(entry.parentUuid),
    timestamp: normalizeEnvelopeString(entry.timestamp),
  };
}

export type TranscriptHeader = {
  /** Stable id from the leading `{type:"session", id}` line; null when absent. */
  sessionHeaderId: string | null;
  parentSession: string | null;
};

/** Read the leading session header from a historical transcript file. */
export async function readTranscriptHeader(sessionFile: string): Promise<TranscriptHeader> {
  const empty: TranscriptHeader = { sessionHeaderId: null, parentSession: null };
  try {
    const stream = createReadStream(sessionFile, { encoding: "utf8" });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });
    try {
      for await (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) {
          continue;
        }
        try {
          const parsed = JSON.parse(trimmed) as {
            type?: unknown;
            id?: unknown;
            parentSession?: unknown;
          };
          if (parsed.type !== "session") {
            return empty;
          }
          return {
            sessionHeaderId: normalizeEnvelopeString(parsed.id),
            parentSession: normalizeEnvelopeString(parsed.parentSession),
          };
        } catch {
          return empty;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  } catch {
    return empty;
  }
  return empty;
}

export function isBootstrapMessage(value: unknown): value is AgentMessage {
  if (!value || typeof value !== "object") {
    return false;
  }
  const msg = value as { role?: unknown; content?: unknown; command?: unknown; output?: unknown };
  if (typeof msg.role !== "string") {
    return false;
  }
  return "content" in msg || ("command" in msg && "output" in msg);
}

function extractCanonicalBootstrapMessage(value: unknown): AgentMessage | null {
  if (isBootstrapMessage(value)) {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const entry = value as { type?: unknown; message?: unknown };
  if ("message" in entry) {
    if (entry.type !== undefined && entry.type !== "message") {
      return null;
    }
    if (!isBootstrapMessage(entry.message)) {
      return null;
    }
    return attachTranscriptEntryMeta(
      entry.message,
      extractEnvelopeMeta(entry as Record<string, unknown>),
    );
  }
  return null;
}

export function extractBootstrapMessageCandidate(value: unknown): AgentMessage | null {
  return extractCanonicalBootstrapMessage(value);
}

export function parseBootstrapJsonl(raw: string, options?: {
  strict?: boolean;
}): { messages: AgentMessage[]; sawNonWhitespace: boolean; hadMalformedLine: boolean } {
  const messages: AgentMessage[] = [];
  const lines = raw.split(/\r?\n/);
  let sawNonWhitespace = false;
  let hadMalformedLine = false;
  for (const line of lines) {
    const item = line.trim();
    if (!item) {
      continue;
    }
    sawNonWhitespace = true;
    try {
      const parsed = JSON.parse(item);
      const candidate = extractBootstrapMessageCandidate(parsed);
      if (candidate) {
        messages.push(candidate);
        continue;
      }
    } catch {
      if (options?.strict) {
        hadMalformedLine = true;
      }
    }
  }
  return { messages, sawNonWhitespace, hadMalformedLine };
}

type TranscriptLineRecord = {
  entryId: string | null;
  parentId: string | null;
  message: AgentMessage | null;
};

type TranscriptTreeNode = {
  entryId: string | null;
  parentId: string | null;
};

function selectLeafPathRecords<T extends TranscriptTreeNode>(records: T[]): T[] | null {
  if (records.length === 0) {
    return null;
  }
  const byId = new Map<string, T>();
  for (const record of records) {
    if (!record.entryId) {
      return null;
    }
    byId.set(record.entryId, record);
  }
  const path: T[] = [];
  const visited = new Set<string>();
  let current: T | undefined = records[records.length - 1];
  while (current) {
    const currentId = current.entryId!;
    if (visited.has(currentId)) {
      return null;
    }
    visited.add(currentId);
    path.push(current);
    if (current.parentId === null) {
      break;
    }
    const parent = byId.get(current.parentId);
    if (!parent) {
      return null;
    }
    current = parent;
  }
  path.reverse();
  return path;
}

/** Load importable messages from a historical JSON/JSONL transcript file. */
export async function readLeafPathMessages(sessionFile: string): Promise<AgentMessage[]> {
  try {
    let sawNonWhitespace = false;
    let jsonArrayMode = false;
    let jsonArrayBuffer = "";
    const records: TranscriptLineRecord[] = [];
    const flattened: AgentMessage[] = [];
    const stream = createReadStream(sessionFile, { encoding: "utf8" });
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    for await (const line of lines) {
      if (!sawNonWhitespace) {
        const trimmed = line.trim();
        if (trimmed) {
          sawNonWhitespace = true;
          if (trimmed.startsWith("[")) {
            jsonArrayMode = true;
          }
        }
      }

      if (jsonArrayMode) {
        jsonArrayBuffer += `${line}\n`;
        continue;
      }

      const item = line.trim();
      if (!item) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(item);
      } catch {
        continue;
      }
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        (parsed as { type?: unknown }).type === "session"
      ) {
        continue;
      }
      const candidate = extractBootstrapMessageCandidate(parsed);
      if (candidate) {
        flattened.push(candidate);
      }
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        const meta = extractEnvelopeMeta(parsed as Record<string, unknown>);
        if (meta.entryId !== null || candidate) {
          records.push({ entryId: meta.entryId, parentId: meta.parentId, message: candidate });
        }
      }
    }

    if (jsonArrayMode) {
      const trimmed = jsonArrayBuffer.trim();
      if (!trimmed) {
        return [];
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) {
          return [];
        }
        return parsed.filter(isBootstrapMessage);
      } catch {
        return [];
      }
    }

    const leafPath = selectLeafPathRecords(records);
    if (leafPath) {
      return leafPath
        .map((record) => record.message)
        .filter((message): message is AgentMessage => message !== null);
    }
    return flattened;
  } catch {
    return [];
  }
}
