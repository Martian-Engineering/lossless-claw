import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ToolCallInputMap } from "./tool-pairing.js";
import { safeString } from "./value-utils.js";

export const MAX_LIVE_READ_RECOVERY_BYTES = 8 * 1024 * 1024;

const READ_CAPPED_RE = /\[Read output capped at/i;
const READ_TRUNCATED_RE = /\[Truncated:/;

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
  const toolInput = params.toolCallInputMap.get(params.callId);
  const readPath = toolInput?.input && safeString(toolInput.input.path);
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
}): { content: string; toolName: string } {
  const toolName =
    (params.callId && params.toolCallInputMap?.get(params.callId)?.name) || params.toolName;
  const content =
    toolName === "read"
      ? recoverLiveReadToolContent({
          callId: params.callId,
          extractedText: params.extractedText,
          toolCallInputMap: params.toolCallInputMap,
        })
      : params.extractedText;
  return { content, toolName };
}
