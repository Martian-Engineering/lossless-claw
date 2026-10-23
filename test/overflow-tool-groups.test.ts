import { describe, expect, it } from "vitest";
import {
  resolveRecoveryTailMaxTokens,
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
  describe("default recovery tail token cap", () => {
    // 64 stored messages: one user, 31 exec call/result pairs, one closing reply.
    const execHeavyTurn = () => {
      const rows = [row(0, "user")];
      for (let index = 0; index < 31; index++) {
        const call = row(2 * index + 1, "assistant", [`exec_${index}`]);
        const result = row(2 * index + 2, "tool", [`exec_${index}`]);
        call.message!.tokenCount = 400;
        result.message!.tokenCount = 5_800;
        rows.push(call, result);
      }
      rows.push(row(63, "assistant"));
      return rows;
    };
    const target = 189_000;

    it("selects groups when an unconfigured count-only tail exceeds the target", () => {
      const rows = execHeavyTurn();
      expect(rows).toHaveLength(64);
      const total = rows.reduce((sum, r) => sum + r.message!.tokenCount, 0);
      expect(total).toBeGreaterThan(target);
      expect(selectOverflowToolGroup(rows, 64)).toEqual([]);

      const cap = resolveRecoveryTailMaxTokens(undefined, target);
      expect(cap).toBe(47_250);
      const selected = selectOverflowToolGroup(rows, 64, cap);
      expect(selected.length).toBeGreaterThan(0);
      expect(selected[0]!.ordinal).toBe(1);
      // Selection ends on a complete group and leaves at most the cap in raw tail.
      const lastSelected = selected.at(-1)!.ordinal;
      expect(rows[lastSelected]!.message!.role).toBe("tool");
      const tailTokens = rows
        .filter((r) => r.item.ordinal > lastSelected)
        .reduce((sum, r) => sum + r.message!.tokenCount, 0);
      expect(tailTokens).toBeLessThanOrEqual(cap!);
    });

    it("prefers an explicit freshTailMaxTokens and ignores unusable targets", () => {
      expect(resolveRecoveryTailMaxTokens(12_000, 189_000)).toBe(12_000);
      expect(resolveRecoveryTailMaxTokens(undefined, 0)).toBeUndefined();
      expect(resolveRecoveryTailMaxTokens(undefined, Infinity)).toBeUndefined();
    });
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
