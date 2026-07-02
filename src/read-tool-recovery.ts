import { existsSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ToolCallInputMap } from "./tool-pairing.js";
import { safeString } from "./value-utils.js";

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
  if (!readPath || !isAbsolute(readPath) || !existsSync(readPath)) {
    return params.extractedText;
  }
  try {
    return readFileSync(readPath, "utf8");
  } catch {
    return params.extractedText;
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
