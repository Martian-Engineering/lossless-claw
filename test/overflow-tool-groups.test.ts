import { describe, expect, it } from "vitest";
import {
  selectOverflowToolGroup,
  type OverflowContextItem,
} from "../src/overflow-tool-groups.js";

/** Create a planner fixture containing only the stored fields the selector reads. */
function row(
  ordinal: number,
  role: string,
  ids: Array<string | null> = []
): OverflowContextItem {
  return {
    item: { ordinal, itemType: "message", messageId: ordinal + 1 },
    message: { role, tokenCount: 100 },
    parts: ids.map((toolCallId) => ({
      partType: role === "tool" ? "text" : "tool",
      toolCallId,
    })),
  } as OverflowContextItem;
}

/** Protect the last complete pair while selecting older groups. */
function select(rows: OverflowContextItem[], cap = 1000) {
  return selectOverflowToolGroup(rows, 2, undefined, undefined, cap).map(
    (item) => item.ordinal
  );
}
const tail = [row(10, "assistant", ["tail"]), row(11, "tool", ["tail"])];

describe("forced recovery tool groups", () => {
  it("keeps a multi-call assistant and all its results together across the leaf cap", () => {
    expect(
      select(
        [
          row(0, "user"),
          row(1, "assistant", ["a", "b"]),
          row(2, "tool", ["a"]),
          row(3, "tool", ["b"]),
          ...tail,
        ],
        100
      )
    ).toEqual([1, 2, 3]);
  });
  it("does not split a group when the recent tail begins inside its results", () => {
    expect(
      select([
        row(0, "user"),
        row(1, "assistant", ["a", "b"]),
        row(2, "tool", ["a"]),
        row(3, "tool", ["b"]),
      ])
    ).toEqual([]);
  });
  it("stops before an unresolved group even if later calls completed", () => {
    expect(
      select([
        row(0, "user"),
        row(1, "assistant", ["missing"]),
        row(2, "assistant", ["a"]),
        row(3, "tool", ["a"]),
        ...tail,
      ])
    ).toEqual([]);
  });
  it.each([
    [row(1, "assistant", [null]), row(2, "tool", ["a"])],
    [row(1, "tool", ["a"]), row(2, "assistant")],
    [row(1, "assistant", ["a"]), row(2, "tool", ["wrong"])],
    [row(1, "assistant", ["a"]), row(2, "tool", ["a"]), row(3, "tool", ["a"])],
    [row(1, "assistant", ["tail"]), row(2, "tool", ["tail"])],
  ])("preserves ambiguous or orphaned tool records %#", (...rows) => {
    expect(select([row(0, "user"), ...rows, ...tail])).toEqual([]);
  });
  it("does not absorb intervening text into a summary range", () => {
    expect(
      select([
        row(0, "user"),
        row(1, "assistant", ["a"]),
        row(2, "tool", ["a"]),
        row(3, "assistant"),
        row(4, "assistant", ["b"]),
        row(5, "tool", ["b"]),
        ...tail,
      ])
    ).toEqual([1, 2]);
  });
  it("selects only groups following the most recent user", () => {
    expect(
      select([
        row(0, "user"),
        row(1, "assistant", ["a"]),
        row(2, "tool", ["a"]),
        row(3, "user"),
        ...tail,
      ])
    ).toEqual([]);
  });
});
