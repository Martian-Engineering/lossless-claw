import type { SummaryKind } from "./store/summary-store.js";

export type PendingSummaryPlannerItemType = "message" | "summary";

export type PendingSummaryPlannerSnapshotItem = {
  ordinal: number;
  itemType: PendingSummaryPlannerItemType;
  tokenCount: number;
  sourceFingerprint: string;
  messageId?: number;
  summaryId?: string;
  depth?: number;
};

export type PendingSummaryPlannerNode = {
  nodeId: string;
  canonicalSummaryId?: string | null;
  kind: SummaryKind;
  depth: number;
  ordinalStart: number;
  ordinalEnd: number;
  tokenCount: number;
  sourceFingerprints: string[];
  sourceMessageIds: number[];
  childNodeIds: string[];
  childSummaryIds: string[];
  childLinks?: Array<{ childNodeId?: string; childSummaryId?: string }>;
};

export type PlanPendingLeafNodesInput = {
  items: PendingSummaryPlannerSnapshotItem[];
  freshTailCount: number;
  freshTailMaxTokens?: number;
  leafChunkTokens: number;
  nodeIdPrefix: string;
};

export type PlanPendingCondensedNodesInput = {
  nodes: PendingSummaryPlannerNode[];
  condensedMinFanout: number;
  condensedMinSourceTokens: number;
  condensedChunkTokens: number;
  nodeIdPrefix: string;
};

export type SelectPendingPublishFrontierInput = {
  nodes: PendingSummaryPlannerNode[];
  startOrdinal: number;
  endOrdinal: number;
};

export type SelectPendingPublishCoverageTargetInput = {
  nodes: PendingSummaryPlannerNode[];
  startOrdinal: number;
  endOrdinal: number;
};

export type PendingPublishCoverageTarget = {
  endOrdinal: number;
  frontier: PendingSummaryPlannerNode[];
};

function normalizePositiveInteger(value: number, fallback: number): number {
  if (Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  return fallback;
}

function normalizeNonNegativeInteger(value: number): number {
  if (Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 0;
}

function sortItemsByOrdinal(
  items: PendingSummaryPlannerSnapshotItem[],
): PendingSummaryPlannerSnapshotItem[] {
  return [...items].sort((a, b) => a.ordinal - b.ordinal);
}

function makeLeafNodeId(prefix: string, startOrdinal: number, endOrdinal: number): string {
  return `${prefix}-leaf-${startOrdinal}-${endOrdinal}`;
}

function makeCondensedNodeId(
  prefix: string,
  depth: number,
  startOrdinal: number,
  endOrdinal: number,
): string {
  return `${prefix}-condensed-d${depth}-${startOrdinal}-${endOrdinal}`;
}

/**
 * Return the ordinal where protected fresh tail context begins.
 *
 * Items with ordinal greater than or equal to the returned value should not be
 * planned into pending summaries.
 */
export function resolvePendingFreshTailOrdinal(input: {
  items: PendingSummaryPlannerSnapshotItem[];
  freshTailCount: number;
  freshTailMaxTokens?: number;
}): number {
  const freshTailCount = normalizeNonNegativeInteger(input.freshTailCount);
  if (freshTailCount <= 0) {
    return Infinity;
  }

  const freshTailMaxTokens =
    typeof input.freshTailMaxTokens === "number" && Number.isFinite(input.freshTailMaxTokens)
      ? Math.max(0, Math.floor(input.freshTailMaxTokens))
      : undefined;
  const messageItems = sortItemsByOrdinal(input.items).filter((item) => item.itemType === "message");
  let protectedCount = 0;
  let protectedTokens = 0;
  let tailStartOrdinal = Infinity;

  for (let index = messageItems.length - 1; index >= 0; index--) {
    if (protectedCount >= freshTailCount) {
      break;
    }

    const item = messageItems[index];
    if (!item) {
      continue;
    }

    const tokenCount = normalizeNonNegativeInteger(item.tokenCount);
    const exceedsTokenCap =
      protectedCount > 0 &&
      typeof freshTailMaxTokens === "number" &&
      protectedTokens + tokenCount > freshTailMaxTokens;
    if (exceedsTokenCap) {
      break;
    }

    protectedCount += 1;
    protectedTokens += tokenCount;
    tailStartOrdinal = item.ordinal;
  }

  return tailStartOrdinal;
}

/**
 * Plan pending leaf nodes over every raw-message run outside the fresh tail.
 */
export function planPendingLeafNodes(
  input: PlanPendingLeafNodesInput,
): PendingSummaryPlannerNode[] {
  const items = sortItemsByOrdinal(input.items);
  const freshTailOrdinal = resolvePendingFreshTailOrdinal(input);
  const chunkTokenBudget = normalizePositiveInteger(input.leafChunkTokens, 1);
  const nodes: PendingSummaryPlannerNode[] = [];
  let chunk: PendingSummaryPlannerSnapshotItem[] = [];
  let chunkTokens = 0;

  const resetChunk = () => {
    chunk = [];
    chunkTokens = 0;
  };

  const flushChunk = () => {
    if (chunk.length === 0) {
      return;
    }
    if (chunkTokens < chunkTokenBudget) {
      resetChunk();
      return;
    }
    const ordinalStart = chunk[0]?.ordinal ?? 0;
    const ordinalEnd = chunk[chunk.length - 1]?.ordinal ?? ordinalStart;
    nodes.push({
      nodeId: makeLeafNodeId(input.nodeIdPrefix, ordinalStart, ordinalEnd),
      canonicalSummaryId: null,
      kind: "leaf",
      depth: 0,
      ordinalStart,
      ordinalEnd,
      tokenCount: chunkTokens,
      sourceFingerprints: chunk.map((item) => item.sourceFingerprint),
      sourceMessageIds: chunk
        .map((item) => item.messageId)
        .filter((messageId): messageId is number => typeof messageId === "number"),
      childNodeIds: [],
      childSummaryIds: [],
    });
    resetChunk();
  };

  for (const item of items) {
    if (item.ordinal >= freshTailOrdinal) {
      break;
    }
    if (item.itemType !== "message") {
      flushChunk();
      continue;
    }

    const tokenCount = normalizeNonNegativeInteger(item.tokenCount);
    chunk.push(item);
    chunkTokens += tokenCount;
    if (chunkTokens >= chunkTokenBudget) {
      flushChunk();
    }
  }

  flushChunk();
  if (nodes.length === 0) {
    return nodes;
  }

  // Eligible work after a canonical summary can otherwise become permanently
  // unreachable when a smaller raw run sits before it. Add only the undersized
  // message ranges needed to bridge the prefix through the last eligible leaf;
  // an undersized trailing suffix remains raw.
  const lastEligibleOrdinal = Math.max(...nodes.map((node) => node.ordinalEnd));
  const bridgeNodes: PendingSummaryPlannerNode[] = [];
  let bridge: PendingSummaryPlannerSnapshotItem[] = [];
  let bridgeTokens = 0;
  const flushBridge = () => {
    if (bridge.length === 0) {
      return;
    }
    const ordinalStart = bridge[0]!.ordinal;
    const ordinalEnd = bridge[bridge.length - 1]!.ordinal;
    bridgeNodes.push({
      nodeId: makeLeafNodeId(input.nodeIdPrefix, ordinalStart, ordinalEnd),
      canonicalSummaryId: null,
      kind: "leaf",
      depth: 0,
      ordinalStart,
      ordinalEnd,
      tokenCount: bridgeTokens,
      sourceFingerprints: bridge.map((item) => item.sourceFingerprint),
      sourceMessageIds: bridge
        .map((item) => item.messageId)
        .filter((messageId): messageId is number => typeof messageId === "number"),
      childNodeIds: [],
      childSummaryIds: [],
    });
    bridge = [];
    bridgeTokens = 0;
  };

  for (const item of items) {
    if (item.ordinal > lastEligibleOrdinal) {
      break;
    }
    const covered = nodes.some(
      (node) => item.ordinal >= node.ordinalStart && item.ordinal <= node.ordinalEnd,
    );
    if (item.itemType !== "message" || covered) {
      flushBridge();
      continue;
    }
    bridge.push(item);
    bridgeTokens += normalizeNonNegativeInteger(item.tokenCount);
  }
  flushBridge();

  return [...nodes, ...bridgeNodes].sort(compareNodesForPlanning);
}

/**
 * Layer cap for condensation planning. Real DAGs stay in single digits; the
 * cap only exists so no policy input can spin the layering loop forever.
 */
const MAX_CONDENSED_PLANNING_LAYERS = 32;

/**
 * Plan hidden condensed parent nodes over adjacent same-depth pending nodes.
 */
export function planPendingCondensedNodes(
  input: PlanPendingCondensedNodesInput,
): PendingSummaryPlannerNode[] {
  // A fanout of 1 would let a single node condense into itself at depth+1 on
  // every layer pass, so the effective minimum is always at least 2.
  const minFanout = Math.max(2, normalizePositiveInteger(input.condensedMinFanout, 2));
  const minSourceTokens = normalizeNonNegativeInteger(input.condensedMinSourceTokens);
  const chunkTokenBudget = normalizePositiveInteger(input.condensedChunkTokens, 1);
  const planned: PendingSummaryPlannerNode[] = [];
  let candidates = [...input.nodes].sort(compareNodesForPlanning);

  for (let layer = 0; layer < MAX_CONDENSED_PLANNING_LAYERS; layer++) {
    const nextLayer = planOneCondensedLayer({
      nodes: candidates,
      minFanout,
      minSourceTokens,
      chunkTokenBudget,
      nodeIdPrefix: input.nodeIdPrefix,
    });
    if (nextLayer.length === 0) {
      break;
    }
    planned.push(...nextLayer);
    candidates = [...candidates, ...nextLayer].sort(compareNodesForPlanning);
  }

  return planned;
}

function compareNodesForPlanning(
  first: PendingSummaryPlannerNode,
  second: PendingSummaryPlannerNode,
): number {
  return (
    first.depth - second.depth ||
    first.ordinalStart - second.ordinalStart ||
    first.ordinalEnd - second.ordinalEnd ||
    first.nodeId.localeCompare(second.nodeId)
  );
}

function planOneCondensedLayer(input: {
  nodes: PendingSummaryPlannerNode[];
  minFanout: number;
  minSourceTokens: number;
  chunkTokenBudget: number;
  nodeIdPrefix: string;
}): PendingSummaryPlannerNode[] {
  const result: PendingSummaryPlannerNode[] = [];
  const depths = Array.from(new Set(input.nodes.map((node) => node.depth))).sort((a, b) => a - b);

  for (const depth of depths) {
    const nodesAtDepth = input.nodes.filter((node) => node.depth === depth).sort(compareNodesForPlanning);
    let group: PendingSummaryPlannerNode[] = [];
    let groupTokens = 0;

    const flushGroup = () => {
      if (group.length >= input.minFanout && groupTokens >= input.minSourceTokens) {
        result.push(createCondensedParent(input.nodeIdPrefix, depth + 1, group, groupTokens));
      }
      group = [];
      groupTokens = 0;
    };

    for (const node of nodesAtDepth) {
      const expectedStart = group.length === 0 ? node.ordinalStart : group[group.length - 1]!.ordinalEnd + 1;
      const startsNextInterval = node.ordinalStart === expectedStart;
      const fitsTokenBudget = group.length === 0 || groupTokens + node.tokenCount <= input.chunkTokenBudget;
      if (!startsNextInterval || !fitsTokenBudget) {
        flushGroup();
      }

      group.push(node);
      groupTokens += normalizeNonNegativeInteger(node.tokenCount);
      if (groupTokens >= input.chunkTokenBudget) {
        flushGroup();
      }
    }

    flushGroup();
  }

  return result.filter(
    (node) =>
      !input.nodes.some(
        (existing) =>
          existing.depth === node.depth &&
          existing.ordinalStart === node.ordinalStart &&
          existing.ordinalEnd === node.ordinalEnd,
      ),
  );
}

function createCondensedParent(
  nodeIdPrefix: string,
  depth: number,
  children: PendingSummaryPlannerNode[],
  tokenCount: number,
): PendingSummaryPlannerNode {
  const ordinalStart = children[0]?.ordinalStart ?? 0;
  const ordinalEnd = children[children.length - 1]?.ordinalEnd ?? ordinalStart;
  return {
    nodeId: makeCondensedNodeId(nodeIdPrefix, depth, ordinalStart, ordinalEnd),
    canonicalSummaryId: null,
    kind: "condensed",
    depth,
    ordinalStart,
    ordinalEnd,
    tokenCount,
    sourceFingerprints: children.flatMap((child) => child.sourceFingerprints),
    sourceMessageIds: children.flatMap((child) => child.sourceMessageIds),
    childNodeIds: children
      .filter((child) => typeof child.canonicalSummaryId !== "string")
      .map((child) => child.nodeId),
    childSummaryIds: children
      .map((child) => child.canonicalSummaryId)
      .filter((summaryId): summaryId is string => typeof summaryId === "string"),
    childLinks: children.map((child) =>
      typeof child.canonicalSummaryId === "string"
        ? { childSummaryId: child.canonicalSummaryId }
        : { childNodeId: child.nodeId },
    ),
  };
}

/** Select the highest-depth nodes covering the longest contiguous publish prefix. */
export function selectPendingPublishCoverageTarget(
  input: SelectPendingPublishCoverageTargetInput,
): PendingPublishCoverageTarget | null {
  const startOrdinal = normalizeNonNegativeInteger(input.startOrdinal);
  const endOrdinal = normalizeNonNegativeInteger(input.endOrdinal);
  if (endOrdinal < startOrdinal) {
    return null;
  }

  const frontier: PendingSummaryPlannerNode[] = [];
  let cursor = startOrdinal;
  while (cursor <= endOrdinal) {
    const candidate = input.nodes
      .filter(
        (node) =>
          node.ordinalStart === cursor &&
          node.ordinalEnd <= endOrdinal &&
          node.ordinalEnd >= node.ordinalStart,
      )
      .sort(
        (first, second) =>
          second.depth - first.depth ||
          second.ordinalEnd - first.ordinalEnd ||
          first.nodeId.localeCompare(second.nodeId),
      )[0];

    if (!candidate) {
      break;
    }

    frontier.push(candidate);
    cursor = candidate.ordinalEnd + 1;
  }

  if (frontier.length === 0) {
    return null;
  }
  return { endOrdinal: cursor - 1, frontier };
}

/**
 * Select the highest-depth nodes that exactly cover a contiguous publish prefix.
 */
export function selectPendingPublishFrontier(
  input: SelectPendingPublishFrontierInput,
): PendingSummaryPlannerNode[] | null {
  const target = selectPendingPublishCoverageTarget(input);
  if (!target) {
    return null;
  }
  return target.endOrdinal === normalizeNonNegativeInteger(input.endOrdinal)
    ? target.frontier
    : null;
}
