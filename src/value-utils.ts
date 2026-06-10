/**
 * Small generic value/format helpers shared by the engine and its extracted modules.
 *
 * Extracted from engine.ts (Phase 1 of the engine decomposition).
 */
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";

export function getErrorCode(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  const { code } = error as NodeJS.ErrnoException;
  return typeof code === "string" ? code : undefined;
}

export function isMissingFileError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

export function normalizeSessionFilePathForComparison(filePath: string): string {
  const trimmed = filePath.trim();
  return trimmed ? resolvePath(trimmed) : "";
}

export function toJson(value: unknown): string {
  const encoded = JSON.stringify(value);
  return typeof encoded === "string" ? encoded : "";
}

export function hashSerializedMessages(messages: string[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex").slice(0, 16);
}

export function safeString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function formatDurationMs(durationMs: number): string {
  return `${durationMs}ms`;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function safeBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
