import type { SessionEntry } from "./session-transcript.js";

export type PendingToolResultRewrite = {
  offloadId: number;
  toolCallId: string;
  toolName: string;
  messageTimestamp: number;
};

export type MatchedToolResultRewrite = {
  offloadId: number;
  entryId: string;
};

function getToolResultIdentity(entry: SessionEntry): {
  entryId: string;
  toolCallId: string;
  toolName?: string;
  messageTimestamp?: number;
} | null {
  if (entry.type !== "message") {
    return null;
  }
  const message = entry.message as Record<string, unknown>;
  if (message.role !== "toolResult") {
    return null;
  }

  const toolCallId =
    typeof message.toolCallId === "string"
      ? message.toolCallId
      : typeof message.tool_call_id === "string"
        ? message.tool_call_id
        : undefined;
  if (!toolCallId) {
    return null;
  }

  return {
    entryId: entry.id,
    toolCallId,
    toolName:
      typeof message.toolName === "string"
        ? message.toolName
        : typeof message.tool_name === "string"
          ? message.tool_name
          : undefined,
    messageTimestamp:
      typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
        ? Math.floor(message.timestamp)
        : undefined,
  };
}

export function matchPendingToolResultRewrites(params: {
  activeBranchEntries: SessionEntry[];
  pending: PendingToolResultRewrite[];
}): MatchedToolResultRewrite[] {
  const remaining = params.activeBranchEntries
    .map(getToolResultIdentity)
    .filter((entry): entry is NonNullable<typeof entry> => !!entry);

  const matches: MatchedToolResultRewrite[] = [];

  for (const candidate of params.pending) {
    const exactIndex = remaining.findIndex((entry) =>
      entry.toolCallId === candidate.toolCallId
      && entry.toolName === candidate.toolName
      && entry.messageTimestamp === candidate.messageTimestamp,
    );
    const toolNameIndex = remaining.findIndex((entry) =>
      entry.toolCallId === candidate.toolCallId
      && entry.toolName === candidate.toolName,
    );
    const fallbackIndex = remaining.findIndex((entry) => entry.toolCallId === candidate.toolCallId);
    const index = exactIndex >= 0 ? exactIndex : toolNameIndex >= 0 ? toolNameIndex : fallbackIndex;
    if (index < 0) {
      continue;
    }

    const [entry] = remaining.splice(index, 1);
    matches.push({
      offloadId: candidate.offloadId,
      entryId: entry.entryId,
    });
  }

  return matches;
}
