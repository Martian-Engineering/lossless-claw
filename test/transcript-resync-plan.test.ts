import { describe, expect, it } from "vitest";
import type { StoredTranscriptRow } from "../src/store/transcript-cursor-store.js";
import {
  findVisibleGapIndexes,
  resolvePostResetStartIndex,
  type NonMessageTranscriptEvent,
} from "../src/transcript-reset-boundary.js";
import {
  budgetStartIndex,
  planResync,
  SuffixContentMatcher,
  type ScannedVisibleEntry,
} from "../src/transcript-resync-plan.js";

function entry(entryId: string, extra: Partial<ScannedVisibleEntry> = {}): ScannedVisibleEntry {
  return { entryId, parentId: null, seq: 0, tokens: 0, ...extra };
}

function row(messageId: number, seq: number, transcriptEntryId: string | null, identityHash = `h${messageId}`): StoredTranscriptRow {
  return { messageId, seq, identityHash, transcriptEntryId };
}

describe("planResync", () => {
  it("anchors on the last stored id and counts unknown holes before it", () => {
    const stored = new Map([
      ["a", row(1, 1, "a")],
      ["c", row(2, 2, "c")],
    ]);
    const plan = planResync([entry("a"), entry("b"), entry("c"), entry("d")], stored);
    expect(plan.lastKnownIndex).toBe(2);
    expect(plan.anchorRowSeq).toBe(2);
    expect(plan.unimportedBeforeAnchor).toBe(1);
    expect(plan.restamps.size).toBe(0);
  });

  it("follows supersedes chains to a stored id that left the projection", () => {
    const stored = new Map([["old", row(7, 3, "old")]]);
    const plan = planResync(
      [entry("x"), entry("mid", { supersedesEntryId: "old" }), entry("new", { supersedesEntryId: "gone" })],
      stored,
    );
    expect([...plan.restamps.entries()]).toEqual([[1, row(7, 3, "old")]]);
    expect(plan.lastKnownIndex).toBe(1);
  });

  it("does not restamp onto an id that is still visible", () => {
    const stored = new Map([["a", row(1, 1, "a")]]);
    const plan = planResync([entry("a"), entry("b", { supersedesEntryId: "a" })], stored);
    expect(plan.restamps.size).toBe(0);
    expect(plan.lastKnownIndex).toBe(0);
  });

  it("reports no anchor when nothing is stored", () => {
    expect(planResync([entry("a")], new Map())).toMatchObject({ lastKnownIndex: -1, anchorRowSeq: null });
  });
});

describe("budgetStartIndex", () => {
  const entries = [10, 0, 10, 10].map((tokens, index) => entry(`e${index}`, { tokens }));

  it("keeps the newest persisted suffix that fits", () => {
    expect(budgetStartIndex(entries, 0, 20)).toBe(2);
    expect(budgetStartIndex(entries, 0, 100)).toBe(0);
    expect(budgetStartIndex(entries, 3, 100)).toBe(3);
  });

  it("imports nothing when the newest persisted entry alone exceeds the budget", () => {
    expect(budgetStartIndex([entry("big", { tokens: 50 })], 0, 10)).toBe(1);
  });
});

describe("SuffixContentMatcher", () => {
  it("claims identical content in stored order", () => {
    const matcher = new SuffixContentMatcher([row(3, 30, null, "x"), row(1, 10, "old-1", "x"), row(2, 20, "old-2", "y")]);
    expect(matcher.claim("x")?.messageId).toBe(1);
    expect(matcher.multiCandidateClaims).toBe(1);
    expect(matcher.claim("y")?.messageId).toBe(2);
    expect(matcher.claim("x")?.messageId).toBe(3);
    expect(matcher.claim("x")).toBeNull();
  });

  it("never claims a row that precedes the previous claim", () => {
    const matcher = new SuffixContentMatcher([row(1, 10, null, "x"), row(2, 20, null, "y")]);
    expect(matcher.claim("y")?.messageId).toBe(2);
    expect(matcher.claim("x")).toBeNull();
  });
});

describe("reset boundary", () => {
  const visible = [
    { entryId: "m1", parentId: "hdr" },
    { entryId: "m2", parentId: "m1" },
    { entryId: "m3", parentId: "model" },
    { entryId: "m4", parentId: "m3" },
  ];

  it("finds gaps where the parent is not the previous visible message", () => {
    expect(findVisibleGapIndexes(visible)).toEqual([0, 2]);
  });

  it("starts after the latest reset reached through non-message parents", () => {
    const events = new Map<string, NonMessageTranscriptEvent>([
      ["hdr", { type: "model_change", parentId: null }],
      ["reset-1", { type: "reset", parentId: "m2" }],
      ["model", { type: "model_change", parentId: "reset-1" }],
    ]);
    expect(resolvePostResetStartIndex(visible, events)).toBe(2);
  });

  it("returns 0 when no reset sits on the visible path", () => {
    const events = new Map<string, NonMessageTranscriptEvent>([
      ["hdr", { type: "model_change", parentId: null }],
      ["model", { type: "model_change", parentId: "m2" }],
    ]);
    expect(resolvePostResetStartIndex(visible, events)).toBe(0);
  });
});
