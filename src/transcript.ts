import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
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

/** Load recoverable messages from a JSON/JSONL session file without full-file reads for JSONL. */
export async function readLeafPathMessages(sessionFile: string): Promise<AgentMessage[]> {
  try {
    let sawNonWhitespace = false;
    let jsonArrayMode = false;
    let jsonArrayBuffer = "";
    const messages: AgentMessage[] = [];
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

      const parsed = parseBootstrapJsonl(line);
      if (parsed.messages.length > 0) {
        messages.push(...parsed.messages);
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

    return messages;
  } catch {
    return [];
  }
}

export async function readSessionParentSessionReference(sessionFile: string): Promise<string | null> {
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
          const parsed = JSON.parse(trimmed) as { type?: unknown; parentSession?: unknown };
          if (parsed.type !== "session" || typeof parsed.parentSession !== "string") {
            return null;
          }
          const parentSession = parsed.parentSession.trim();
          return parentSession.length > 0 ? parentSession : null;
        } catch {
          return null;
        }
      }
    } finally {
      lines.close();
      stream.destroy();
    }
  } catch {
    return null;
  }
  return null;
}

export async function readFileSegment(sessionFile: string, offset: number): Promise<string | null> {
  let fh: FileHandle | null = null;
  try {
    fh = await open(sessionFile, "r");
    const stats = await fh.stat();
    const safeOffset = Math.max(0, Math.min(Math.floor(offset), stats.size));
    const length = stats.size - safeOffset;
    if (length <= 0) {
      return "";
    }
    const buffer = Buffer.alloc(length);
    await fh.read(buffer, 0, length, safeOffset);
    return buffer.toString("utf8");
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export async function readLastJsonlEntryBeforeOffset(
  sessionFile: string,
  offset: number,
  messageOnly = false,
  matcher?: (message: AgentMessage) => boolean,
): Promise<string | null> {
  const chunkSize = 16_384;
  const safeOffset = Math.max(0, Math.floor(offset));
  if (safeOffset <= 0) {
    return null;
  }

  let fh: FileHandle | null = null;
  try {
    fh = await open(sessionFile, "r");
    let cursor = safeOffset;
    let carry = "";
    while (true) {
      const trimmedEnd = carry.replace(/\s+$/u, "");
      if (trimmedEnd) {
        const newlineIndex = Math.max(trimmedEnd.lastIndexOf("\n"), trimmedEnd.lastIndexOf("\r"));
        if (newlineIndex >= 0) {
          const candidate = trimmedEnd.slice(newlineIndex + 1).trim();
          if (candidate) {
            if (messageOnly) {
              let matchedMessage: AgentMessage | null = null;
              try {
                matchedMessage = extractBootstrapMessageCandidate(JSON.parse(candidate));
              } catch { /* not valid JSON, skip */ }
              if (!matchedMessage || (matcher && !matcher(matchedMessage))) {
                carry = trimmedEnd.slice(0, newlineIndex);
                continue;
              }
            }
            return candidate;
          }
          carry = trimmedEnd.slice(0, newlineIndex);
          continue;
        }
      }

      // No more newlines in current carry — need more data from earlier in the file.
      if (cursor <= 0) {
        // Reached start-of-file: whatever is left is the first line.
        const firstLine = trimmedEnd.trim() || null;
        if (!firstLine) return null;
        if (messageOnly) {
          let matchedMessage: AgentMessage | null = null;
          try {
            matchedMessage = extractBootstrapMessageCandidate(JSON.parse(firstLine));
          } catch { /* not valid JSON */ }
          if (!matchedMessage || (matcher && !matcher(matchedMessage))) return null;
        }
        return firstLine;
      }

      const start = Math.max(0, cursor - chunkSize);
      const length = cursor - start;
      const buffer = Buffer.alloc(length);
      await fh.read(buffer, 0, length, start);
      carry = buffer.toString("utf8") + carry;
      cursor = start;
    }
  } catch {
    return null;
  } finally {
    await fh?.close();
  }
}

export async function readAppendedLeafPathMessages(params: {
  sessionFile: string;
  offset: number;
}): Promise<{ messages: AgentMessage[]; canUseAppendOnly: boolean; sawNonWhitespace: boolean }> {
  const raw = await readFileSegment(params.sessionFile, params.offset);
  if (raw == null) {
    return { messages: [], canUseAppendOnly: false, sawNonWhitespace: false };
  }

  const trimmed = raw.trim();
  if (!trimmed) {
    return { messages: [], canUseAppendOnly: true, sawNonWhitespace: false };
  }

  if (trimmed.startsWith("[")) {
    return { messages: [], canUseAppendOnly: false, sawNonWhitespace: true };
  }

  const parsed = parseBootstrapJsonl(raw, { strict: true });
  if (parsed.hadMalformedLine) {
    return { messages: [], canUseAppendOnly: false, sawNonWhitespace: parsed.sawNonWhitespace };
  }

  return {
    messages: parsed.messages,
    canUseAppendOnly: true,
    sawNonWhitespace: parsed.sawNonWhitespace,
  };
}
