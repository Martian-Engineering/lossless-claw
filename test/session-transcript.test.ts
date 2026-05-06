import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  extractActiveBranchMessages,
  parseSessionEntries,
  selectActiveBranchEntries,
} from "../src/session-transcript.js";

function makeMessage(role: AgentMessage["role"], content: unknown, timestamp: number): AgentMessage {
  return {
    role,
    content,
    timestamp,
  } as AgentMessage;
}

describe("session-transcript active branch parsing", () => {
  it("returns only the active branch from a branched transcript", () => {
    const raw = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess_1",
        timestamp: "2026-04-04T00:00:00.000Z",
        cwd: "/tmp/workspace",
      }),
      JSON.stringify({
        type: "message",
        id: "a1",
        parentId: null,
        timestamp: "2026-04-04T00:00:01.000Z",
        message: makeMessage("user", "root user", 1),
      }),
      JSON.stringify({
        type: "message",
        id: "a2",
        parentId: "a1",
        timestamp: "2026-04-04T00:00:02.000Z",
        message: makeMessage("assistant", "abandoned assistant", 2),
      }),
      JSON.stringify({
        type: "message",
        id: "a3",
        parentId: "a2",
        timestamp: "2026-04-04T00:00:03.000Z",
        message: makeMessage("user", "abandoned user", 3),
      }),
      JSON.stringify({
        type: "message",
        id: "b2",
        parentId: "a1",
        timestamp: "2026-04-04T00:00:04.000Z",
        message: makeMessage("assistant", "active assistant", 4),
      }),
    ].join("\n");

    const entries = parseSessionEntries(raw);
    const branch = selectActiveBranchEntries(entries);
    const messages = extractActiveBranchMessages(branch);

    expect(branch.map((entry) => entry.id)).toEqual(["a1", "b2"]);
    expect(messages.map((message) => ("content" in message ? message.content : null))).toEqual([
      "root user",
      "active assistant",
    ]);
  });

  it("ignores duplicate session headers", () => {
    const raw = [
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess_dup",
        timestamp: "2026-04-04T00:00:00.000Z",
        cwd: "/tmp/workspace",
      }),
      JSON.stringify({
        type: "session",
        version: 3,
        id: "sess_dup",
        timestamp: "2026-04-04T00:00:00.000Z",
        cwd: "/tmp/workspace",
      }),
      JSON.stringify({
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-04-04T00:00:01.000Z",
        message: makeMessage("user", "hello", 1),
      }),
      JSON.stringify({
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-04-04T00:00:02.000Z",
        message: makeMessage("assistant", "world", 2),
      }),
    ].join("\n");

    const entries = parseSessionEntries(raw);
    const branch = selectActiveBranchEntries(entries);

    expect(entries.filter((entry) => entry.type === "session")).toHaveLength(2);
    expect(branch.map((entry) => entry.id)).toEqual(["m1", "m2"]);
  });

  it("keeps the reachable orphan suffix when the latest entry points to a missing parent", () => {
    const raw = [
      JSON.stringify({
        type: "message",
        id: "broken_leaf",
        parentId: "missing_parent",
        timestamp: "2026-04-04T00:00:01.000Z",
        message: makeMessage("assistant", "orphan leaf", 1),
      }),
    ].join("\n");

    const entries = parseSessionEntries(raw);
    const branch = selectActiveBranchEntries(entries);
    const messages = extractActiveBranchMessages(branch);

    expect(branch.map((entry) => entry.id)).toEqual(["broken_leaf"]);
    expect(messages).toHaveLength(1);
    expect("content" in messages[0] ? messages[0].content : null).toBe("orphan leaf");
  });

  it("wraps legacy JSON arrays of messages into a linear synthetic branch", () => {
    const raw = JSON.stringify([
      makeMessage("user", "legacy one", 1),
      makeMessage("assistant", "legacy two", 2),
    ]);

    const entries = parseSessionEntries(raw);
    const branch = selectActiveBranchEntries(entries);
    const messages = extractActiveBranchMessages(branch);

    expect(branch).toHaveLength(2);
    expect(branch[0]?.parentId).toBeNull();
    expect(branch[1]?.parentId).toBe(branch[0]?.id);
    expect(messages.map((message) => ("content" in message ? message.content : null))).toEqual([
      "legacy one",
      "legacy two",
    ]);
  });
});
