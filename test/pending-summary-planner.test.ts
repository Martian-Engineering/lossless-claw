import { describe, expect, it } from "vitest";
import {
  planPendingCondensedNodes,
  planPendingLeafNodes,
  resolvePendingFreshTailOrdinal,
  selectPendingPublishCoverageTarget,
  selectPendingPublishFrontier,
  type PendingSummaryPlannerNode,
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
  it("keeps the newest user-led suffix outside pending leaf plans", () => {
    const items = [
      { ...message(0, 10, 5), role: "user" },
      { ...message(1, 11, 5), role: "assistant" },
      { ...message(2, 12, 5), role: "user" },
      { ...message(3, 13, 50), role: "assistant" },
    ] satisfies Array<PendingSummaryPlannerSnapshotItem & { role: "user" | "assistant" }>;

    const nodes = planPendingLeafNodes({
      items,
      freshTailCount: 1,
      freshTailMaxTokens: 10,
      leafChunkTokens: 5,
      nodeIdPrefix: "leaf",
    });

    expect(nodes.map((node) => [node.ordinalStart, node.ordinalEnd])).toEqual([
      [0, 0],
      [1, 1],
    ]);
  });

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
      ["leaf-leaf-0-1", 0, 1],
      ["leaf-leaf-3-4", 3, 4],
    ]);
    expect(nodes.map((node) => node.sourceMessageIds)).toEqual([[10, 11], [12, 13]]);
  });

  it("does not plan an under-threshold compactable prefix as a leaf", () => {
    const nodes = planPendingLeafNodes({
      items: [
        message(0, 10, 334),
        ...Array.from({ length: 128 }, (_, index) => message(index + 1, 11 + index, 1)),
      ],
      freshTailCount: 128,
      leafChunkTokens: 20_000,
      nodeIdPrefix: "leaf",
    });

    expect(nodes).toEqual([]);
  });

  it("does not plan an under-threshold trailing leaf after an eligible chunk", () => {
    const nodes = planPendingLeafNodes({
      items: [message(0, 10, 6), message(1, 11, 6), message(2, 12, 3)],
      freshTailCount: 0,
      leafChunkTokens: 10,
      nodeIdPrefix: "leaf",
    });

    expect(nodes.map((node) => [node.nodeId, node.ordinalStart, node.ordinalEnd])).toEqual([
      ["leaf-leaf-0-1", 0, 1],
    ]);
    expect(nodes.map((node) => node.sourceMessageIds)).toEqual([[10, 11]]);
  });

  it("plans under-threshold bridge runs before later eligible work", () => {
    const nodes = planPendingLeafNodes({
      items: [
        summary(0, "sum_prefix", 0, 3),
        message(1, 10, 3),
        summary(2, "sum_middle", 0, 3),
        message(3, 11, 6),
        message(4, 12, 6),
        message(5, 13, 2),
      ],
      freshTailCount: 1,
      leafChunkTokens: 10,
      nodeIdPrefix: "leaf",
    });

    expect(nodes.map((node) => [node.nodeId, node.ordinalStart, node.ordinalEnd])).toEqual([
      ["leaf-leaf-1-1", 1, 1],
      ["leaf-leaf-3-4", 3, 4],
    ]);
    expect(nodes.map((node) => node.sourceMessageIds)).toEqual([[10], [11, 12]]);
  });

  it("plans condensed parents over adjacent same-depth nodes", () => {
    const leafNodes = planPendingLeafNodes({
      items: [message(0, 10, 5), message(1, 11, 5), message(2, 12, 5)],
      freshTailCount: 0,
      leafChunkTokens: 5,
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

  it("clamps a misconfigured fanout of one instead of looping forever", () => {
    const leafNodes = planPendingLeafNodes({
      items: [message(0, 10, 60)],
      freshTailCount: 0,
      leafChunkTokens: 60,
      nodeIdPrefix: "leaf",
    });

    // With fanout 1 unclamped, this single node would condense into itself at
    // depth+1 on every layer pass and the planner would never terminate.
    const condensedNodes = planPendingCondensedNodes({
      nodes: leafNodes,
      condensedMinFanout: 1,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 200,
      nodeIdPrefix: "condensed",
    });

    expect(condensedNodes).toEqual([]);
  });

  it("stops layering at the planning cap under adversarial policy inputs", () => {
    // Two adjacent nodes per layer would normally terminate quickly; the cap
    // is a backstop, so just assert planning terminates and stays bounded for
    // a wide input set with permissive policy values.
    const manyLeaves = planPendingLeafNodes({
      items: Array.from({ length: 64 }, (_, index) => message(index, 100 + index, 10)),
      freshTailCount: 0,
      leafChunkTokens: 10,
      nodeIdPrefix: "leaf",
    });

    const condensedNodes = planPendingCondensedNodes({
      nodes: manyLeaves,
      condensedMinFanout: 2,
      condensedMinSourceTokens: 0,
      condensedChunkTokens: 10_000,
      nodeIdPrefix: "condensed",
    });

    expect(condensedNodes.length).toBeGreaterThan(0);
    expect(condensedNodes.length).toBeLessThan(200);
    expect(Math.max(...condensedNodes.map((node) => node.depth))).toBeLessThanOrEqual(32);
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
      childLinks: [{ childSummaryId: "sum_active_a" }, { childNodeId: "pending-leaf-b" }],
    });
  });

  it("does not duplicate canonical grandchildren in higher condensed layers", () => {
    const pendingChild: PendingSummaryPlannerNode = {
      nodeId: "pending-condensed-a",
      canonicalSummaryId: null,
      kind: "condensed",
      depth: 1,
      ordinalStart: 0,
      ordinalEnd: 1,
      tokenCount: 10,
      sourceFingerprints: ["summary:sum_active_a", "message:11"],
      sourceMessageIds: [11],
      childNodeIds: ["pending-leaf-b"],
      childSummaryIds: ["sum_active_a"],
    };
    const canonicalSibling: PendingSummaryPlannerNode = {
      nodeId: "active-summary-c",
      canonicalSummaryId: "sum_active_c",
      kind: "condensed",
      depth: 1,
      ordinalStart: 2,
      ordinalEnd: 2,
      tokenCount: 5,
      sourceFingerprints: ["summary:sum_active_c"],
      sourceMessageIds: [],
      childNodeIds: [],
      childSummaryIds: [],
    };

    const condensedNodes = planPendingCondensedNodes({
      nodes: [pendingChild, canonicalSibling],
      condensedMinFanout: 2,
      condensedMinSourceTokens: 1,
      condensedChunkTokens: 20,
      nodeIdPrefix: "condensed",
    });

    expect(condensedNodes[0]).toMatchObject({
      childNodeIds: ["pending-condensed-a"],
      childSummaryIds: ["sum_active_c"],
      childLinks: [{ childNodeId: "pending-condensed-a" }, { childSummaryId: "sum_active_c" }],
    });
  });

  it("selects the highest ready frontier that exactly covers a prefix", () => {
    const leafNodes = planPendingLeafNodes({
      items: [message(0, 10, 5), message(1, 11, 5), message(2, 12, 5)],
      freshTailCount: 0,
      leafChunkTokens: 5,
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

  it("prefers longer lower-level coverage over a deeper node that leaves a gap", () => {
    const [leaf] = planPendingLeafNodes({
      items: [message(0, 10, 5)], freshTailCount: 0, leafChunkTokens: 5, nodeIdPrefix: "leaf",
    });
    const wide = { ...leaf!, nodeId: "wide", ordinalEnd: 3 };
    const deep = { ...leaf!, nodeId: "deep", depth: 1, ordinalEnd: 1 };
    expect(selectPendingPublishFrontier({ nodes: [deep, wide], startOrdinal: 0, endOrdinal: 4 }))
      .toEqual([wide]);
    expect(selectPendingPublishFrontier({ nodes: [wide], startOrdinal: 1, endOrdinal: 4 })).toBeNull();
  });

  it("selects the longest publishable prefix when later ordinals are uncovered", () => {
    const leafNodes = planPendingLeafNodes({
      items: [message(0, 10, 5), message(1, 11, 5), message(2, 12, 3)],
      freshTailCount: 0,
      leafChunkTokens: 5,
      nodeIdPrefix: "leaf",
    });

    const target = selectPendingPublishCoverageTarget({
      nodes: leafNodes,
      startOrdinal: 0,
      endOrdinal: 2,
    });
    expect(target?.endOrdinal).toBe(1);
    expect(target?.frontier.map((node) => node.nodeId)).toEqual([
      "leaf-leaf-0-0",
      "leaf-leaf-1-1",
    ]);
    expect(
      selectPendingPublishFrontier({
        nodes: leafNodes,
        startOrdinal: 0,
        endOrdinal: 2,
      }),
    ).toEqual(target?.frontier);
  });
});

function withRole(
  item: PendingSummaryPlannerSnapshotItem,
  role: NonNullable<PendingSummaryPlannerSnapshotItem["role"]>,
): PendingSummaryPlannerSnapshotItem {
  return { ...item, role };
}

describe("pending summary planner tool-group boundaries", () => {
  it("does not end a leaf node between an assistant call and its results", () => {
    const nodes = planPendingLeafNodes({
      items: [
        withRole(message(0, 10, 5), "user"),
        withRole(message(1, 11, 5), "assistant"),
        withRole(message(2, 12, 5), "tool"),
        withRole(message(3, 13, 5), "tool"),
        withRole(message(4, 14, 5), "user"),
        withRole(message(5, 15, 5), "assistant"),
      ],
      freshTailCount: 1,
      leafChunkTokens: 10,
      nodeIdPrefix: "leaf",
    });

    expect(nodes.map((node) => [node.ordinalStart, node.ordinalEnd])).toEqual([[0, 3]]);
  });

  it("leaves out a call whose result is in the fresh tail", () => {
    const nodes = planPendingLeafNodes({
      items: [
        withRole(message(0, 10, 5), "user"),
        withRole(message(1, 11, 5), "assistant"),
        withRole(message(2, 12, 5), "assistant"),
        withRole(message(3, 13, 5), "tool"),
        withRole(message(4, 14, 5), "user"),
      ],
      freshTailCount: 2,
      leafChunkTokens: 15,
      nodeIdPrefix: "leaf",
    });

    expect(nodes).toEqual([]);
  });

  it("looks past the extension range for results of its last call", () => {
    const nodes = planPendingLeafNodes({
      items: [withRole(message(0, 10, 5), "user"), withRole(message(1, 11, 5), "assistant")],
      followingItems: [withRole(message(2, 12, 5), "tool")],
      freshTailCount: 0,
      leafChunkTokens: 10,
      nodeIdPrefix: "leaf",
    });

    expect(nodes).toEqual([]);
  });

  it("plans the same leaf nodes as before for sequences without tool messages", () => {
    const random = mulberry32(861);
    const roles = ["user", "assistant", "system"] as const;
    for (let sample = 0; sample < 40; sample++) {
      const items: PendingSummaryPlannerSnapshotItem[] = [];
      const length = 5 + Math.floor(random() * 20);
      for (let ordinal = 0; ordinal < length; ordinal++) {
        const tokens = 1 + Math.floor(random() * 30);
        items.push(
          random() < 0.15
            ? summary(ordinal, `sum_${ordinal}`, 0, tokens)
            : withRole(message(ordinal, 100 + ordinal, tokens), roles[Math.floor(random() * 3)]!),
        );
      }
      const input = {
        items,
        freshTailCount: Math.floor(random() * 6),
        freshTailMaxTokens: random() < 0.3 ? Math.floor(random() * 60) : undefined,
        leafChunkTokens: 5 + Math.floor(random() * 60),
        nodeIdPrefix: "leaf",
      };
      expect(planPendingLeafNodes(input), `sample ${sample}`).toEqual(referencePlanPendingLeafNodes(input));
    }
  });
});

/** Deterministic PRNG so the generated sequences are reproducible. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let next = Math.imul(state ^ (state >>> 15), 1 | state);
    next = (next + Math.imul(next ^ (next >>> 7), 61 | next)) ^ next;
    return ((next ^ (next >>> 14)) >>> 0) / 4294967296;
  };
}

/** Reference copy of planPendingLeafNodes at 51c3c90b, before tool-group boundaries. */
function referencePlanPendingLeafNodes(
  input: Parameters<typeof planPendingLeafNodes>[0],
): PendingSummaryPlannerNode[] {
  const items = [...input.items].sort((a, b) => a.ordinal - b.ordinal);
  const freshTailOrdinal = resolvePendingFreshTailOrdinal(input);
  const budget = Math.floor(input.leafChunkTokens);
  const tokensOf = (item: PendingSummaryPlannerSnapshotItem) => Math.max(0, Math.floor(item.tokenCount));
  const toNode = (run: PendingSummaryPlannerSnapshotItem[], tokenCount: number): PendingSummaryPlannerNode => ({
    nodeId: `${input.nodeIdPrefix}-leaf-${run[0]!.ordinal}-${run.at(-1)!.ordinal}`,
    canonicalSummaryId: null,
    kind: "leaf",
    depth: 0,
    ordinalStart: run[0]!.ordinal,
    ordinalEnd: run.at(-1)!.ordinal,
    tokenCount,
    sourceFingerprints: run.map((item) => item.sourceFingerprint),
    sourceMessageIds: run
      .map((item) => item.messageId)
      .filter((messageId): messageId is number => typeof messageId === "number"),
    childNodeIds: [],
    childSummaryIds: [],
  });
  const nodes: PendingSummaryPlannerNode[] = [];
  let chunk: PendingSummaryPlannerSnapshotItem[] = [];
  let chunkTokens = 0;
  const flush = () => {
    if (chunk.length > 0 && chunkTokens >= budget) nodes.push(toNode(chunk, chunkTokens));
    chunk = [];
    chunkTokens = 0;
  };
  for (const item of items) {
    if (item.ordinal >= freshTailOrdinal) break;
    if (item.itemType !== "message") {
      flush();
      continue;
    }
    chunk.push(item);
    chunkTokens += tokensOf(item);
    if (chunkTokens >= budget) flush();
  }
  flush();
  if (nodes.length === 0) return nodes;
  const lastEligibleOrdinal = Math.max(...nodes.map((node) => node.ordinalEnd));
  const bridgeNodes: PendingSummaryPlannerNode[] = [];
  let bridge: PendingSummaryPlannerSnapshotItem[] = [];
  let bridgeTokens = 0;
  const flushBridge = () => {
    if (bridge.length > 0) bridgeNodes.push(toNode(bridge, bridgeTokens));
    bridge = [];
    bridgeTokens = 0;
  };
  for (const item of items) {
    if (item.ordinal > lastEligibleOrdinal) break;
    const covered = nodes.some((node) => item.ordinal >= node.ordinalStart && item.ordinal <= node.ordinalEnd);
    if (item.itemType !== "message" || covered) {
      flushBridge();
      continue;
    }
    bridge.push(item);
    bridgeTokens += tokensOf(item);
  }
  flushBridge();
  return [...nodes, ...bridgeNodes].sort(
    (a, b) =>
      a.depth - b.depth ||
      a.ordinalStart - b.ordinalStart ||
      a.ordinalEnd - b.ordinalEnd ||
      a.nodeId.localeCompare(b.nodeId),
  );
}
