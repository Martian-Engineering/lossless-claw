import { describe, expect, it } from "vitest";
import {
  planPendingCondensedNodes,
  planPendingLeafNodes,
  selectPendingPublishFrontier,
  type PendingSummaryPlannerSnapshotItem,
} from "../src/pending-summary-planner.js";

function message(
  ordinal: number,
  messageId: number,
  tokenCount: number,
): PendingSummaryPlannerSnapshotItem {
  return {
    ordinal,
    itemType: "message",
    messageId,
    tokenCount,
    sourceFingerprint: `message:${messageId}`,
  };
}

function summary(
  ordinal: number,
  summaryId: string,
  depth: number,
  tokenCount: number,
): PendingSummaryPlannerSnapshotItem {
  return {
    ordinal,
    itemType: "summary",
    summaryId,
    depth,
    tokenCount,
    sourceFingerprint: `summary:${summaryId}`,
  };
}

describe("pending summary planner", () => {
  it("plans leaf chunks from raw message runs outside the fresh tail", () => {
    const nodes = planPendingLeafNodes({
      items: [
        message(0, 10, 5),
        message(1, 11, 5),
        summary(2, "sum_prior", 0, 3),
        message(3, 12, 5),
        message(4, 13, 5),
        message(5, 14, 5),
      ],
      freshTailCount: 1,
      leafChunkTokens: 8,
      nodeIdPrefix: "leaf",
    });

    expect(nodes.map((node) => [node.nodeId, node.ordinalStart, node.ordinalEnd])).toEqual([
      ["leaf-leaf-0-0", 0, 0],
      ["leaf-leaf-1-1", 1, 1],
      ["leaf-leaf-3-3", 3, 3],
      ["leaf-leaf-4-4", 4, 4],
    ]);
    expect(nodes.map((node) => node.sourceMessageIds)).toEqual([[10], [11], [12], [13]]);
  });

  it("plans condensed parents over adjacent same-depth nodes", () => {
    const leafNodes = planPendingLeafNodes({
      items: [message(0, 10, 5), message(1, 11, 5), message(2, 12, 5)],
      freshTailCount: 0,
      leafChunkTokens: 6,
      nodeIdPrefix: "leaf",
    });

    const condensedNodes = planPendingCondensedNodes({
      nodes: leafNodes,
      condensedMinFanout: 2,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 20,
      nodeIdPrefix: "condensed",
    });

    expect(condensedNodes).toHaveLength(1);
    expect(condensedNodes[0]).toMatchObject({
      nodeId: "condensed-condensed-d1-0-2",
      kind: "condensed",
      depth: 1,
      ordinalStart: 0,
      ordinalEnd: 2,
      childNodeIds: ["leaf-leaf-0-0", "leaf-leaf-1-1", "leaf-leaf-2-2"],
    });
  });

  it("tracks canonical child summary ids separately from pending child nodes", () => {
    const condensedNodes = planPendingCondensedNodes({
      nodes: [
        {
          nodeId: "active-summary-a",
          canonicalSummaryId: "sum_active_a",
          kind: "leaf",
          depth: 0,
          ordinalStart: 0,
          ordinalEnd: 0,
          tokenCount: 5,
          sourceFingerprints: ["summary:sum_active_a"],
          sourceMessageIds: [],
          childNodeIds: [],
          childSummaryIds: [],
        },
        {
          nodeId: "pending-leaf-b",
          canonicalSummaryId: null,
          kind: "leaf",
          depth: 0,
          ordinalStart: 1,
          ordinalEnd: 1,
          tokenCount: 5,
          sourceFingerprints: ["message:11"],
          sourceMessageIds: [11],
          childNodeIds: [],
          childSummaryIds: [],
        },
      ],
      condensedMinFanout: 2,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 20,
      nodeIdPrefix: "condensed",
    });

    expect(condensedNodes[0]).toMatchObject({
      childNodeIds: ["pending-leaf-b"],
      childSummaryIds: ["sum_active_a"],
    });
  });

  it("selects the highest ready frontier that exactly covers a prefix", () => {
    const leafNodes = planPendingLeafNodes({
      items: [message(0, 10, 5), message(1, 11, 5), message(2, 12, 5)],
      freshTailCount: 0,
      leafChunkTokens: 6,
      nodeIdPrefix: "leaf",
    });
    const condensedNodes = planPendingCondensedNodes({
      nodes: leafNodes.slice(0, 2),
      condensedMinFanout: 2,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 20,
      nodeIdPrefix: "condensed",
    });

    expect(
      selectPendingPublishFrontier({
        nodes: [...leafNodes, ...condensedNodes],
        startOrdinal: 0,
        endOrdinal: 2,
      })?.map((node) => node.nodeId),
    ).toEqual(["condensed-condensed-d1-0-1", "leaf-leaf-2-2"]);

    expect(
      selectPendingPublishFrontier({
        nodes: [...leafNodes, ...condensedNodes],
        startOrdinal: 0,
        endOrdinal: 1,
      })?.map((node) => node.nodeId),
    ).toEqual(["condensed-condensed-d1-0-1"]);
  });
});
