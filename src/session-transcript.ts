import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { readFileSync } from "node:fs";

export interface SessionHeaderEntry {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface SessionMessageEntry {
  type: "message";
  id: string;
  parentId: string | null;
  timestamp: string;
  message: AgentMessage;
}

export interface SessionGenericEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

export type SessionEntry = SessionMessageEntry | SessionGenericEntry;
export type FileEntry = SessionHeaderEntry | SessionEntry;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isSessionHeaderEntry(value: unknown): value is SessionHeaderEntry {
  if (!isRecord(value)) {
    return false;
  }
  return (
    value.type === "session"
    && typeof value.id === "string"
    && typeof value.timestamp === "string"
    && typeof value.cwd === "string"
  );
}

function isAgentMessage(value: unknown): value is AgentMessage {
  if (!isRecord(value) || typeof value.role !== "string") {
    return false;
  }
  return "content" in value || ("command" in value && "output" in value);
}

function coerceSessionEntry(value: unknown): SessionEntry | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === "session") {
    return null;
  }
  if (typeof value.type !== "string") {
    return null;
  }
  if (typeof value.id !== "string") {
    return null;
  }
  if (!(typeof value.parentId === "string" || value.parentId === null)) {
    return null;
  }
  if (typeof value.timestamp !== "string") {
    return null;
  }
  return value as SessionEntry;
}

function wrapLegacyMessages(messages: AgentMessage[]): SessionMessageEntry[] {
  let previousId: string | null = null;
  return messages.map((message, index) => {
    const id = `legacy_${index.toString(16).padStart(8, "0")}`;
    const timestamp =
      "timestamp" in message && typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : new Date(0).toISOString();
    const entry: SessionMessageEntry = {
      type: "message",
      id,
      parentId: previousId,
      timestamp,
      message,
    };
    previousId = id;
    return entry;
  });
}

function parseArrayEntries(value: unknown[]): FileEntry[] {
  const entries: FileEntry[] = [];
  const legacyMessages: AgentMessage[] = [];

  for (const item of value) {
    if (isSessionHeaderEntry(item)) {
      entries.push(item);
      continue;
    }
    const entry = coerceSessionEntry(item);
    if (entry) {
      entries.push(entry);
      continue;
    }
    if (isAgentMessage(item)) {
      legacyMessages.push(item);
    }
  }

  if (entries.length > 0) {
    return entries;
  }
  if (legacyMessages.length > 0) {
    return wrapLegacyMessages(legacyMessages);
  }
  return [];
}

function parseJsonlEntries(raw: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const legacyMessages: AgentMessage[] = [];

  for (const line of raw.split(/\r?\n/)) {
    const item = line.trim();
    if (!item) {
      continue;
    }
    try {
      const parsed = JSON.parse(item);
      if (isSessionHeaderEntry(parsed)) {
        entries.push(parsed);
        continue;
      }
      const entry = coerceSessionEntry(parsed);
      if (entry) {
        entries.push(entry);
        continue;
      }
      if (isAgentMessage(parsed)) {
        legacyMessages.push(parsed);
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  if (entries.length > 0) {
    return entries;
  }
  if (legacyMessages.length > 0) {
    return wrapLegacyMessages(legacyMessages);
  }
  return [];
}

export function parseSessionEntries(raw: string): FileEntry[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (!Array.isArray(parsed)) {
        return [];
      }
      return parseArrayEntries(parsed);
    } catch {
      return [];
    }
  }

  return parseJsonlEntries(raw);
}

export function readSessionEntries(sessionFile: string): FileEntry[] {
  try {
    return parseSessionEntries(readFileSync(sessionFile, "utf8"));
  } catch {
    return [];
  }
}

export function selectActiveBranchEntries(entries: FileEntry[]): SessionEntry[] {
  const sessionEntries = entries.filter((entry): entry is SessionEntry => entry.type !== "session");
  if (sessionEntries.length === 0) {
    return [];
  }

  const byId = new Map<string, SessionEntry>();
  for (const entry of sessionEntries) {
    byId.set(entry.id, entry);
  }

  let current: SessionEntry | undefined = sessionEntries[sessionEntries.length - 1];
  const path: SessionEntry[] = [];
  const visited = new Set<string>();

  while (current && !visited.has(current.id)) {
    path.unshift(current);
    visited.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  return path;
}

export function extractActiveBranchMessages(entries: SessionEntry[]): AgentMessage[] {
  return entries.flatMap((entry) => {
    if (entry.type !== "message") {
      return [];
    }
    return isAgentMessage(entry.message) ? [entry.message] : [];
  });
}
