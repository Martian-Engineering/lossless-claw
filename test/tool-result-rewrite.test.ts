import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { selectActiveBranchEntries, type FileEntry } from "../src/session-transcript.js";
import { matchPendingToolResultRewrites } from "../src/tool-result-rewrite.js";

function makeMessageEntry(params: {
  id: string;
  parentId: string | null;
  message: AgentMessage;
}): FileEntry {
  return {
    type: "message",
    id: params.id,
    parentId: params.parentId,
    timestamp: "2026-04-04T00:00:00.000Z",
    message: params.message,
  };
}

describe("matchPendingToolResultRewrites", () => {
  it("matches pending offloads against active-branch tool results", () => {
    const entries: FileEntry[] = [
      {
        type: "session",
        version: 3,
        id: "sess_1",
        timestamp: "2026-04-04T00:00:00.000Z",
        cwd: "/tmp/workspace",
      },
      makeMessageEntry({
        id: "root_user",
        parentId: null,
        message: { role: "user", content: "root", timestamp: 1 } as AgentMessage,
      }),
      makeMessageEntry({
        id: "abandoned_tool_result",
        parentId: "root_user",
        message: {
          role: "toolResult",
          toolCallId: "call_abandoned",
          toolName: "exec",
          isError: false,
          timestamp: 2,
          content: "abandoned",
        } as AgentMessage,
      }),
      makeMessageEntry({
        id: "active_tool_call",
        parentId: "root_user",
        message: {
          role: "assistant",
          content: [{ type: "toolCall", id: "call_active", name: "exec", input: { cmd: "pwd" } }],
          timestamp: 3,
        } as AgentMessage,
      }),
      makeMessageEntry({
        id: "active_tool_result",
        parentId: "active_tool_call",
        message: {
          role: "toolResult",
          toolCallId: "call_active",
          toolName: "exec",
          isError: false,
          timestamp: 4,
          content: "active",
        } as AgentMessage,
      }),
    ];

    const activeBranchEntries = selectActiveBranchEntries(entries);
    const matches = matchPendingToolResultRewrites({
      activeBranchEntries,
      pending: [
        {
          offloadId: 11,
          toolCallId: "call_active",
          toolName: "exec",
          messageTimestamp: 4,
        },
      ],
    });

    expect(matches).toEqual([
      {
        offloadId: 11,
        entryId: "active_tool_result",
      },
    ]);
  });

  it("falls back to toolCallId when timestamp details are missing or drifted", () => {
    const entries: FileEntry[] = [
      makeMessageEntry({
        id: "tool_result_entry",
        parentId: null,
        message: {
          role: "toolResult",
          toolCallId: "call_fallback",
          toolName: "read",
          isError: false,
          timestamp: 100,
          content: "result",
        } as AgentMessage,
      }),
    ];

    const matches = matchPendingToolResultRewrites({
      activeBranchEntries: selectActiveBranchEntries(entries),
      pending: [
        {
          offloadId: 22,
          toolCallId: "call_fallback",
          toolName: "read",
          messageTimestamp: 999,
        },
      ],
    });

    expect(matches).toEqual([
      {
        offloadId: 22,
        entryId: "tool_result_entry",
      },
    ]);
  });
});
