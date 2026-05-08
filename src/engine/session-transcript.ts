import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createInterface } from "node:readline";

import type { ContextEngine } from "../openclaw-bridge.js";
import { toStoredMessage } from "./message-normalization.js";

type AgentMessage = Parameters<ContextEngine["ingest"]>[0]["message"];

type BootstrapTokenConfig = {
  bootstrapMaxTokens: number;
  leafChunkTokens: number;
};

function isBootstrapMessage(value: unknown): value is AgentMessage {
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
    return isBootstrapMessage(entry.message) ? entry.message : null;
  }
  return null;
}

function extractBootstrapMessageCandidate(value: unknown): AgentMessage | null {
  return extractCanonicalBootstrapMessage(value);
}

function parseBootstrapJsonl(raw: string, options?: {
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

/**
 * Resolve the first-time bootstrap token budget.
 *
 * When unset, bootstrap keeps a modest suffix of the parent session rather than
 * inheriting the full raw history into a brand-new conversation.
 */
export function resolveBootstrapMaxTokens(config: BootstrapTokenConfig): number {
  if (
    typeof config.bootstrapMaxTokens === "number" &&
    Number.isFinite(config.bootstrapMaxTokens) &&
    config.bootstrapMaxTokens > 0
  ) {
    return Math.floor(config.bootstrapMaxTokens);
  }

  const leafChunkTokens =
    typeof config.leafChunkTokens === "number" &&
    Number.isFinite(config.leafChunkTokens) &&
    config.leafChunkTokens > 0
      ? Math.floor(config.leafChunkTokens)
      : 20_000;
  return Math.max(6000, Math.floor(leafChunkTokens * 0.3));
}

/**
 * Keep only the newest bootstrap messages that fit within the token budget.
 *
 * The newest message is always preserved so a fork never starts empty when the
 * parent transcript has any recoverable content at all.
 */
export function trimBootstrapMessagesToBudget(messages: AgentMessage[], maxTokens: number): AgentMessage[] {
  if (messages.length === 0) {
    return [];
  }

  const safeMaxTokens = Number.isFinite(maxTokens) ? Math.floor(maxTokens) : 0;
  if (safeMaxTokens <= 0) {
    return [messages[messages.length - 1]!];
  }

  const kept: AgentMessage[] = [];
  let totalTokens = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    const tokenCount = toStoredMessage(message).tokenCount;
    if (kept.length > 0 && totalTokens + tokenCount > safeMaxTokens) {
      break;
    }
    kept.push(message);
    totalTokens += tokenCount;
  }

  // If a single oversized tail message exceeds the budget, return empty
  // rather than silently bypassing the budget cap. An empty bootstrap is
  // safer than an exploding one.
  if (kept.length === 1 && totalTokens > safeMaxTokens) {
    return [];
  }

  kept.reverse();
  return kept;
}

async function readFileSegment(sessionFile: string, offset: number): Promise<string | null> {
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

export function readBootstrapMessageFromJsonLine(line: string | null): AgentMessage | null {
  if (!line) {
    return null;
  }
  try {
    return extractBootstrapMessageCandidate(JSON.parse(line));
  } catch {
    return null;
  }
}
