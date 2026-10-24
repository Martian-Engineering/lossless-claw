import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ToolCallInputMap } from "./tool-pairing.js";
import { safeString } from "./value-utils.js";

export const MAX_LIVE_READ_RECOVERY_BYTES = 8 * 1024 * 1024;

const READ_CAPPED_RE = /\[Read output capped at/i;
const READ_TRUNCATED_RE = /\[Truncated:/;

const INSTRUCTION_FILE_NAMES = new Set([
  "agents.md",
  "agents.override.md",
  "claude.md",
  "skill.md",
]);

/** Return true for instruction-bearing files that must remain source-addressable. */
export function isInstructionFilePath(filePath: string): boolean {
  const fileName = filePath.trim().split(/[\\/]/).filter(Boolean).pop()?.toLowerCase();
  return fileName != null && INSTRUCTION_FILE_NAMES.has(fileName);
}

/** Build a compact, injection-safe continuation hint for an instruction file read. */
export function formatInstructionFileContinuation(filePath: string): string {
  return [
    "[LCM Instruction File]",
    `Source path (JSON): ${JSON.stringify(filePath)}`,
    "Continue with the read tool using this exact source path and bounded offset/limit ranges.",
    "Do not use lcm_describe for this source file.",
  ].join("\n");
}

function resolveReadPath(params: {
  callId?: string;
  toolCallInputMap?: ToolCallInputMap;
}): string | undefined {
  if (!params.callId || !params.toolCallInputMap) {
    return undefined;
  }
  const toolInput = params.toolCallInputMap.get(params.callId);
  return toolInput?.input && safeString(toolInput.input.path);
}

/** Return true when OpenClaw's read tool clearly reported truncated output. */
export function isReadToolTruncated(text: string): boolean {
  return READ_CAPPED_RE.test(text) || READ_TRUNCATED_RE.test(text);
}

/** Best-effort live recovery for current-turn read results that were capped by the host tool. */
export function recoverLiveReadToolContent(params: {
  callId?: string;
  extractedText: string;
  toolCallInputMap?: ToolCallInputMap;
}): string {
  if (!params.callId || !params.toolCallInputMap || !isReadToolTruncated(params.extractedText)) {
    return params.extractedText;
  }
  const readPath = resolveReadPath(params);
  if (readPath && isInstructionFilePath(readPath)) {
    return params.extractedText;
  }
  if (!readPath || !isAbsolute(readPath)) {
    return params.extractedText;
  }
  let fd: number | undefined;
  try {
    fd = openSync(readPath, "r");
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > MAX_LIVE_READ_RECOVERY_BYTES) {
      return params.extractedText;
    }
    return readFileSync(fd, "utf8");
  } catch {
    return params.extractedText;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}

/** Resolve the live tool label and externalized payload for one oversized tool result. */
export function resolveLiveToolResultExternalization(params: {
  toolName: string;
  callId?: string;
  extractedText: string;
  toolCallInputMap?: ToolCallInputMap;
}): { content: string; toolName: string; instructionFilePath?: string } {
  const toolName =
    (params.callId && params.toolCallInputMap?.get(params.callId)?.name) || params.toolName;
  const readPath = toolName === "read" ? resolveReadPath(params) : undefined;
  const instructionFilePath =
    readPath && isAbsolute(readPath) && isInstructionFilePath(readPath)
      ? readPath
      : undefined;
  const content = instructionFilePath
    ? isReadToolTruncated(params.extractedText)
      ? `${params.extractedText}\n\n${formatInstructionFileContinuation(instructionFilePath)}`
      : params.extractedText
    : toolName === "read"
      ? recoverLiveReadToolContent({
          callId: params.callId,
          extractedText: params.extractedText,
          toolCallInputMap: params.toolCallInputMap,
        })
      : params.extractedText;
  return { content, toolName, instructionFilePath };
}
