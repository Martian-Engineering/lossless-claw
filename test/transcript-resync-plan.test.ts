import { describe, expect, it } from "vitest";
import type { ContentMatchCandidate } from "../src/store/transcript-cursor-store.js";
import {
  findVisibleGapIndexes,
  resolvePostResetStartIndex,
  type NonMessageTranscriptEvent,
} from "../src/transcript-reset-boundary.js";
import {
  budgetStartIndex,
  contentMatchKey,
  findHistoryGaps,
  planResync,
  SuffixContentMatcher,
  type ScannedVisibleEntry,
} from "../src/transcript-resync-plan.js";

function entry(entryId: string, extra: Partial<ScannedVisibleEntry> = {}): ScannedVisibleEntry {
  return { entryId, parentId: null, seq: 0, tokens: 0, ...extra };
}

function row(
  messageId: number,
  seq: number,
  transcriptEntryId: string | null,
  identityHash = `h${messageId}`,
  extra: Partial<ContentMatchCandidate> = {},
): ContentMatchCandidate {
  return { messageId, seq, identityHash, transcriptEntryId, toolCallIds: [], hasContent: true, ...extra };
}

/** Candidate for a tool-call-only assistant row: empty text, calls kept in parts. */
function toolCallOnlyRow(messageId: number, seq: number, toolCallIds: string[]): ContentMatchCandidate {
  return row(messageId, seq, null, "empty-assistant", { toolCallIds, hasContent: false });
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

describe("findHistoryGaps", () => {
  /** Visible entries a..f with seq = position + 1; every unknown entry is storable unless listed. */
  function visible(ineligible: string[] = []): ScannedVisibleEntry[] {
    return ["a", "b", "c", "d", "e", "f"].map((id, index) =>
      entry(id, { seq: index + 1, gapEligible: !ineligible.includes(id) }),
    );
  }

  it("reports a run of storable unknown entries between adjacent stored rows", () => {
    const entries = visible();
    const plan = planResync(entries, new Map([["a", row(10, 1, "a")], ["e", row(11, 2, "e")]]));
    expect(findHistoryGaps(entries, plan.knownRows, () => 0)).toEqual([
      {
        firstEntryId: "b",
        lastEntryId: "d",
        firstVisibleSeq: 2,
        lastVisibleSeq: 4,
        entryCount: 3,
        prevMessageId: 10,
        nextMessageId: 11,
      },
    ]);
  });

  it("counts only entries the storage policy would have kept", () => {
    const entries = visible(["b", "d"]);
    const plan = planResync(entries, new Map([["a", row(10, 1, "a")], ["e", row(11, 2, "e")]]));
    expect(findHistoryGaps(entries, plan.knownRows, () => 0)).toMatchObject([
      { firstEntryId: "c", lastEntryId: "c", entryCount: 1 },
    ]);
    const allSkipped = visible(["b", "c", "d"]);
    expect(findHistoryGaps(allSkipped, plan.knownRows, () => 0)).toEqual([]);
  });

  it("does not report a run when stored rows sit between the neighbors", () => {
    const entries = visible();
    const plan = planResync(entries, new Map([["a", row(10, 1, "a")], ["e", row(11, 5, "e")]]));
    const asked: Array<[number, number]> = [];
    const gaps = findHistoryGaps(entries, plan.knownRows, (low, high) => {
      asked.push([low, high]);
      return 3;
    });
    expect(gaps).toEqual([]);
    expect(asked).toEqual([[1, 5]]);
  });

  it("ignores neighbors stored out of order and history before the first known entry", () => {
    const entries = visible();
    const outOfOrder = planResync(entries, new Map([["c", row(10, 9, "c")], ["f", row(11, 2, "f")]]));
    expect(findHistoryGaps(entries, outOfOrder.knownRows, () => 0)).toEqual([]);
    const lateStart = planResync(entries, new Map([["d", row(10, 1, "d")]]));
    expect(findHistoryGaps(entries, lateStart.knownRows, () => 0)).toEqual([]);
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
  it("pairs tool-call-only rows by their tool-call ids, never by the shared empty-content hash", () => {
    const matcher = new SuffixContentMatcher([toolCallOnlyRow(1, 10, ["call-new-1"]), toolCallOnlyRow(2, 20, ["call-new-2"])]);
    const key = (ids: string[]) => contentMatchKey({ identityHash: "empty-assistant", toolCallIds: ids, hasContent: false })!;
    // An older entry from a hole carries different calls and must not take a newer row.
    expect(matcher.claim(key(["call-hole-1"]))).toBeNull();
    expect(matcher.claim(key(["call-new-1"]))?.messageId).toBe(1);
    expect(matcher.claim(key(["call-new-2"]))?.messageId).toBe(2);
    expect(matcher.multiCandidateClaims).toBe(0);
  });

  it("never offers rows with neither text nor tool-call ids", () => {
    const matcher = new SuffixContentMatcher([row(1, 10, null, "empty", { hasContent: false })]);
    expect(matcher.isEmpty).toBe(true);
  });
});

describe("contentMatchKey", () => {
  it("is the identity hash alone for text-only messages", () => {
    expect(contentMatchKey({ identityHash: "h", toolCallIds: [], hasContent: true })).toBe("h");
  });

  it("adds sorted, de-duplicated tool-call ids", () => {
    expect(contentMatchKey({ identityHash: "h", toolCallIds: ["b", "a", "b"], hasContent: false })).toBe(
      contentMatchKey({ identityHash: "h", toolCallIds: ["a", "b"], hasContent: true }),
    );
    expect(contentMatchKey({ identityHash: "h", toolCallIds: ["a"], hasContent: false })).not.toBe(
      contentMatchKey({ identityHash: "h", toolCallIds: ["b"], hasContent: false }),
    );
  });

  it("is null when nothing distinguishes the message", () => {
    expect(contentMatchKey({ identityHash: "h", toolCallIds: [], hasContent: false })).toBeNull();
    expect(contentMatchKey({ identityHash: null, toolCallIds: ["a"], hasContent: true })).toBeNull();
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
    expect(resolvePostResetStartIndex(visible, { nonMessageEvents: events, tip: { id: "m4", parentId: "m3", type: "message" } })).toBe(2);
  });

  it("returns 0 when no reset sits on the visible path", () => {
    const events = new Map<string, NonMessageTranscriptEvent>([
      ["hdr", { type: "model_change", parentId: null }],
      ["model", { type: "model_change", parentId: "m2" }],
    ]);
    expect(resolvePostResetStartIndex(visible, { nonMessageEvents: events, tip: { id: "m4", parentId: "m3", type: "message" } })).toBe(0);
  });

  it("returns an empty window when a reset trails the last visible message (#1244)", () => {
    // Live shape right after /reset: the next turn bootstraps before its user message is visible.
    const beforeReset = [
      { entryId: "u-1", parentId: null },
      { entryId: "749c6a81", parentId: "u-1" },
    ];
    const events = new Map<string, NonMessageTranscriptEvent>([
      ["e0f0ebc7", { type: "reset", parentId: "749c6a81" }],
      ["85a10b6a", { type: "model_change", parentId: "e0f0ebc7" }],
      ["ab154112", { type: "thinking_level_change", parentId: "85a10b6a" }],
    ]);
    const tip = { id: "ab154112", parentId: "85a10b6a", type: "thinking_level_change" };
    expect(resolvePostResetStartIndex(beforeReset, { nonMessageEvents: events, tip })).toBe(2);

    const afterFirstMessage = [...beforeReset, { entryId: "4dcd79b0", parentId: "ab154112" }];
    expect(
      resolvePostResetStartIndex(afterFirstMessage, {
        nonMessageEvents: events,
        tip: { id: "4dcd79b0", parentId: "ab154112", type: "message" },
      }),
    ).toBe(2);
  });

  it("ignores trailing control events without a reset", () => {
    const events = new Map<string, NonMessageTranscriptEvent>([
      ["model", { type: "model_change", parentId: "m4" }],
    ]);
    expect(
      resolvePostResetStartIndex(visible, {
        nonMessageEvents: new Map([...events, ["hdr", { type: "model_change", parentId: null }]]),
        tip: { id: "model", parentId: "m4", type: "model_change" },
      }),
    ).toBe(0);
  });
});
