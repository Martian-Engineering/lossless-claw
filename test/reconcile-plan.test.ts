import { describe, expect, it } from "vitest";
import {
  resolveEpochRoute,
  selectEntryIdTail,
  transcriptImportCap,
} from "../src/reconcile-plan.js";

describe("transcriptImportCap", () => {
  it("is 20% of the existing conversation with a floor of 50", () => {
    expect(transcriptImportCap(0)).toBe(50);
    expect(transcriptImportCap(100)).toBe(50);
    expect(transcriptImportCap(249)).toBe(50);
    expect(transcriptImportCap(251)).toBe(50);
    expect(transcriptImportCap(500)).toBe(100);
    expect(transcriptImportCap(10_000)).toBe(2_000);
  });
});

describe("resolveEpochRoute", () => {
  it("declares a rollover only when both header ids are known and differ", () => {
    expect(
      resolveEpochRoute({ checkpointHeaderId: "h1", transcriptHeaderId: "h2" }),
    ).toBe("declared-rollover");
    expect(
      resolveEpochRoute({ checkpointHeaderId: "h1", transcriptHeaderId: "h1" }),
    ).toBe("same-epoch");
  });

  it("is undeclared when either side is missing", () => {
    expect(resolveEpochRoute({ checkpointHeaderId: null, transcriptHeaderId: "h2" })).toBe(
      "undeclared",
    );
    expect(resolveEpochRoute({ checkpointHeaderId: "h1", transcriptHeaderId: null })).toBe(
      "undeclared",
    );
    expect(
      resolveEpochRoute({ checkpointHeaderId: undefined, transcriptHeaderId: undefined }),
    ).toBe("undeclared");
  });
});

describe("selectEntryIdTail", () => {
  const ids = ["e1", "e2", "e3", "e4", "e5"];

  it("anchors on the checkpoint entry id and imports everything missing after it", () => {
    expect(
      selectEntryIdTail({
        entryIds: ids,
        existingEntryIds: new Set(["e4"]),
        lastProcessedEntryId: "e2",
      }),
    ).toEqual({ kind: "tail", anchorIndex: 1, missingIndexes: [2, 4] });
  });

  it("falls back to the newest persisted id when the checkpoint id is gone", () => {
    expect(
      selectEntryIdTail({
        entryIds: ids,
        existingEntryIds: new Set(["e1", "e3"]),
        lastProcessedEntryId: "stale-id",
      }),
    ).toEqual({ kind: "tail", anchorIndex: 2, missingIndexes: [3, 4] });
  });

  it("reports no id lineage when nothing is persisted and no checkpoint anchor matches", () => {
    expect(
      selectEntryIdTail({
        entryIds: ids,
        existingEntryIds: new Set(),
      }),
    ).toEqual({ kind: "no-id-lineage" });
  });

  it("reports at-tip when the anchor is the newest entry", () => {
    expect(
      selectEntryIdTail({
        entryIds: ids,
        existingEntryIds: new Set(),
        lastProcessedEntryId: "e5",
      }),
    ).toEqual({ kind: "at-tip", anchorIndex: 4 });
  });

  it("reports at-tip when every entry after the anchor is already persisted", () => {
    expect(
      selectEntryIdTail({
        entryIds: ids,
        existingEntryIds: new Set(["e3", "e4", "e5"]),
        lastProcessedEntryId: "e2",
      }),
    ).toEqual({ kind: "at-tip", anchorIndex: 1 });
  });

  it("never imports entries before the anchor (no mid-history gap filling)", () => {
    const selection = selectEntryIdTail({
      entryIds: ids,
      existingEntryIds: new Set(["e4"]),
    });
    // Anchor is the newest persisted id (e4); e1-e3 are missing but stay
    // untouched because appending them now would break seq ordering.
    expect(selection).toEqual({ kind: "tail", anchorIndex: 3, missingIndexes: [4] });
  });

  it("anchors on the last occurrence of a duplicated checkpoint id", () => {
    expect(
      selectEntryIdTail({
        entryIds: ["a", "b", "a", "c"],
        existingEntryIds: new Set(),
        lastProcessedEntryId: "a",
      }),
    ).toEqual({ kind: "tail", anchorIndex: 2, missingIndexes: [3] });
  });
});
