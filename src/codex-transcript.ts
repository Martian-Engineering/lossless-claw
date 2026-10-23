import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentMessage } from "./openclaw-bridge.js";
import { appendTextValue, toStoredMessageIdentity } from "./message-content.js";

type JsonRecord = Record<string, unknown>;

export type CodexTranscriptMessage = {
  message: AgentMessage;
  sourceId: string;
  threadId: string;
  line: number;
  lineHash: string;
  sourceRecord: JsonRecord;
  sessionMeta?: JsonRecord;
};

export type CodexTranscript = {
  threadId: string;
  sessionMeta: JsonRecord;
  messages: CodexTranscriptMessage[];
  sourceHash: string;
  sourceSize: number;
  sourceMtimeMs: number;
  warnings: string[];
};

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sourceId(threadId: string, line: number, lineHash: string): string {
  return `codex:${encodeURIComponent(threadId)}:${line}:${lineHash}`;
}

function timestampMs(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function canonicalMessage(
  payload: JsonRecord,
  envelope: JsonRecord,
): AgentMessage | null {
  if (payload.type !== "message") {
    return null;
  }
  const role = payload.role;
  if (role !== "user" && role !== "assistant" && role !== "system") {
    return null;
  }
  if (!("content" in payload)) {
    return null;
  }
  const content = Array.isArray(payload.content)
    ? payload.content.map((block) => {
        if (!isRecord(block) || (block.type !== "input_text" && block.type !== "output_text")) {
          return block;
        }
        // Normalize text blocks for native transcript-tail matching.
        return { ...block, type: "text", codexOriginalType: block.type };
      })
    : payload.content;
  return {
    role,
    content,
    timestamp: timestampMs(payload.timestamp, envelope.timestamp),
  };
}

function canonicalToolMessage(payload: JsonRecord, envelope: JsonRecord): AgentMessage | null {
  const timestamp = timestampMs(envelope.timestamp);
  if (payload.type === "function_call") {
    return {
      role: "assistant",
      content: [payload],
      timestamp,
    };
  }
  if (payload.type === "function_call_output") {
    return {
      role: "toolResult",
      content: [payload],
      timestamp,
    };
  }
  return null;
}

function eventMessage(payload: JsonRecord, envelope: JsonRecord): AgentMessage | null {
  if ((payload.type !== "user_message" && payload.type !== "agent_message") || typeof payload.message !== "string") {
    return null;
  }
  return {
    role: payload.type === "user_message" ? "user" : "assistant",
    content: payload.message,
    timestamp: timestampMs(envelope.timestamp),
  };
}

function unsupportedMessageContent(value: unknown): string {
  const chunks: string[] = [];
  if (isRecord(value)) {
    for (const key of ["summary", "text", "message", "content", "output", "result", "transcript", "reasoning"]) {
      appendTextValue(value[key], chunks);
      if (chunks.length > 0) {
        return chunks.join("\n");
      }
    }
  }
  return JSON.stringify(value);
}

function appendUniqueWarning(warnings: string[], warning: string): void {
  if (!warnings.includes(warning)) {
    warnings.push(warning);
  }
}

/**
 * Read a Codex rollout as JSONL while hashing the original byte stream. The
 * importer intentionally has no record or byte cap: the whole available
 * transcript is retained and a concurrent rewrite is rejected before commit.
 */
export async function readCodexTranscript(file: string): Promise<CodexTranscript> {
  const before = await stat(file);
  if (!before.isFile()) {
    throw new Error("Codex source is not a regular file.");
  }
  const stream = createReadStream(file);
  const digest = createHash("sha256");
  let finalByte: number | null = null;
  stream.on("data", (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    digest.update(bytes);
    if (bytes.length > 0) {
      finalByte = bytes[bytes.length - 1] ?? finalByte;
    }
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const parsed: Array<{ line: number; hash: string; record: JsonRecord }> = [];
  let line = 0;
  try {
    for await (const rawLine of lines) {
      line += 1;
      if (rawLine.trim() === "") {
        throw new Error(`Malformed Codex source at line ${line}: blank JSONL records are not accepted.`);
      }
      let value: unknown;
      try {
        value = JSON.parse(rawLine);
      } catch {
        throw new Error(`Malformed Codex source at line ${line}: invalid JSON.`);
      }
      if (!isRecord(value) || typeof value.type !== "string") {
        throw new Error(`Malformed Codex source at line ${line}: expected a record with a type.`);
      }
      parsed.push({ line, hash: sha256(rawLine), record: value });
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (finalByte !== 10) {
    throw new Error("Malformed Codex source: the final JSONL record is incomplete (missing newline).");
  }
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Codex source changed while it was being read.");
  }
  const first = parsed[0];
  if (!first || first.record.type !== "session_meta" || !isRecord(first.record.payload)) {
    throw new Error("Malformed Codex source: the first record must be session_meta.");
  }
  const sessionMeta = first.record.payload;
  if (typeof sessionMeta.id !== "string" || sessionMeta.id.trim() === "") {
    throw new Error("Malformed Codex source: session_meta.payload.id is missing.");
  }
  const threadId = sessionMeta.id;
  const warnings: string[] = [];
  if (
    sessionMeta.history_mode === "paginated" ||
    isRecord(sessionMeta.history_base) ||
    (typeof sessionMeta.forked_from_id === "string" && sessionMeta.forked_from_id.length > 0)
  ) {
    warnings.push(
      "Codex rollout is paginated or forked; only this available file was imported. Inherited source history was not resolved.",
    );
  }

  const canonical: CodexTranscriptMessage[] = [];
  const mirrorCandidates: Array<{
    role: string;
    content: string;
    line: number;
    timestamp: number | undefined;
    consumed: boolean;
  }> = [];
  const events: Array<{ item: typeof parsed[number]; payload: JsonRecord }> = [];
  const eventFallback: CodexTranscriptMessage[] = [];
  const unsupported: CodexTranscriptMessage[] = [];
  const canonicalRoles = new Set<string>();
  for (const item of parsed.slice(1)) {
    const envelope = item.record;
    if (envelope.type === "response_item") {
      if (!isRecord(envelope.payload) || typeof envelope.payload.type !== "string") {
        throw new Error(`Malformed Codex source at line ${item.line}: response_item payload is invalid.`);
      }
      const payload = envelope.payload;
      const message = canonicalMessage(payload, envelope) ?? canonicalToolMessage(payload, envelope);
      if (message) {
        const canonicalRecord: CodexTranscriptMessage = {
          message,
          sourceId: sourceId(threadId, item.line, item.hash),
          threadId,
          line: item.line,
          lineHash: item.hash,
          sourceRecord: envelope,
        };
        canonical.push(canonicalRecord);
        canonicalRoles.add(message.role === "toolResult" ? "tool" : message.role);
        const canonicalText = toStoredMessageIdentity(message).content;
        if ((message.role === "user" || message.role === "assistant") && canonicalText.trim()) {
          mirrorCandidates.push({
            role: message.role,
            content: canonicalText,
            line: item.line,
            timestamp: typeof message.timestamp === "number" ? message.timestamp : undefined,
            consumed: false,
          });
        }
      } else {
        appendUniqueWarning(warnings, `Unsupported Codex response_item type "${payload.type}" was preserved as source metadata.`);
        unsupported.push({
          message: {
            role: "assistant",
            content: unsupportedMessageContent(payload),
            timestamp: timestampMs(envelope.timestamp),
          },
          sourceId: sourceId(threadId, item.line, item.hash),
          threadId,
          line: item.line,
          lineHash: item.hash,
          sourceRecord: envelope,
        });
      }
      continue;
    }
    if (envelope.type === "event_msg") {
      if (!isRecord(envelope.payload) || typeof envelope.payload.type !== "string") {
        throw new Error(`Malformed Codex source at line ${item.line}: event_msg payload is invalid.`);
      }
      events.push({ item, payload: envelope.payload });
      continue;
    }
    if (envelope.type === "session_meta") {
      throw new Error(`Malformed Codex source at line ${item.line}: session_meta may appear only once at the start.`);
    }
    appendUniqueWarning(warnings, `Unsupported Codex source record type "${envelope.type}" at line ${item.line} was preserved as source metadata.`);
    unsupported.push({
      message: {
        role: "assistant",
        content: unsupportedMessageContent(envelope),
        timestamp: timestampMs(envelope.timestamp),
      },
      sourceId: sourceId(threadId, item.line, item.hash),
      threadId,
      line: item.line,
      lineHash: item.hash,
      sourceRecord: envelope,
    });
  }

  const turnBoundaryLines = events.flatMap(({ item, payload }) =>
    payload.type === "task_started" || payload.type === "turn_started" ||
      payload.type === "task_complete" || payload.type === "turn_complete"
      ? [item.line]
      : [],
  );

  for (const { item, payload } of events) {
    const envelope = item.record;
    const event = eventMessage(payload, envelope);
    if (event) {
      const eventRole = event.role;
      const eventText = toStoredMessageIdentity(event).content;
      const eventTimestamp = typeof event.timestamp === "number" ? event.timestamp : undefined;
      const mirror = mirrorCandidates
        .filter((candidate) =>
          !candidate.consumed && candidate.line < item.line &&
          candidate.role === eventRole && candidate.content === eventText &&
          candidate.timestamp !== undefined && eventTimestamp !== undefined &&
          Math.abs(candidate.timestamp - eventTimestamp) <= 5_000 &&
          !turnBoundaryLines.some((boundary) =>
            boundary > Math.min(candidate.line, item.line) && boundary < Math.max(candidate.line, item.line),
          ),
        )
        .map((candidate) => ({
          candidate,
          lineDistance: Math.abs(candidate.line - item.line),
          timeDistance: Math.abs(eventTimestamp! - candidate.timestamp!),
        }))
        .sort((left, right) =>
          left.timeDistance - right.timeDistance || left.lineDistance - right.lineDistance,
        )[0];
      const mirrored = Boolean(mirror);
      if (mirrored && mirror) {
        mirror.candidate.consumed = true;
      }
      if (!mirrored) {
        if (canonicalRoles.has(eventRole)) {
          appendUniqueWarning(
            warnings,
            `A Codex event_msg ${eventRole} record could not be proven to mirror a canonical response_item and was preserved separately.`,
          );
        }
        eventFallback.push({
          message: event,
          sourceId: sourceId(threadId, item.line, item.hash),
          threadId,
          line: item.line,
          lineHash: item.hash,
          sourceRecord: envelope,
        });

      }
    } else if (
      payload.type !== "task_started" &&
      payload.type !== "turn_started" &&
      payload.type !== "task_complete" &&
      payload.type !== "turn_complete" &&
      payload.type !== "thread_settings_applied"
    ) {
      appendUniqueWarning(warnings, `Unsupported Codex event_msg type "${payload.type}" was preserved as source metadata.`);
      unsupported.push({
        message: {
          role: "assistant",
          content: unsupportedMessageContent(payload),
          timestamp: timestampMs(envelope.timestamp),
        },
        sourceId: sourceId(threadId, item.line, item.hash),
        threadId,
        line: item.line,
        lineHash: item.hash,
        sourceRecord: envelope,
      });
    }
  }

  // Only suppress events mirrored by an earlier canonical record. Later
  // canonical records retain their content and cannot change accepted pairings.
  const messages = [...canonical, ...eventFallback, ...unsupported]
    .sort((left, right) => left.line - right.line);
  if (messages.length === 0) {
    throw new Error("Codex source contains no importable conversation records.");
  }
  const firstMessage = messages[0];
  if (firstMessage) {
    firstMessage.sessionMeta = sessionMeta;
  }

  return {
    threadId,
    sessionMeta,
    messages,
    sourceHash: digest.digest("hex"),
    sourceSize: after.size,
    sourceMtimeMs: after.mtimeMs,
    warnings,
  };
}

export async function hashCodexSource(file: string): Promise<{ hash: string; size: number; mtimeMs: number }> {
  const before = await stat(file);
  if (!before.isFile()) {
    throw new Error("Codex source is not a regular file.");
  }
  const hash = createHash("sha256");
  const stream = createReadStream(file);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Codex source changed while it was being checked.");
  }
  return { hash: hash.digest("hex"), size: after.size, mtimeMs: after.mtimeMs };
}

export async function hashCodexSourcePrefix(file: string, byteLength: number): Promise<string | null> {
  if (!Number.isSafeInteger(byteLength) || byteLength <= 0) {
    throw new Error("Codex source prefix length must be a positive safe integer.");
  }
  const before = await stat(file);
  if (!before.isFile() || before.size < byteLength) {
    return null;
  }
  const hash = createHash("sha256");
  const stream = createReadStream(file, { start: 0, end: byteLength - 1 });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  const after = await stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("Codex source changed while its accepted prefix was checked.");
  }
  return hash.digest("hex");
}
