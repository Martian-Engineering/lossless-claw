/**
 * Pure planning helpers for cursor resync: bulk id reconciliation, rewrite
 * restamps, in-order suffix content matching, and the fresh-start budget.
 * No IO and no logging, so every decision is unit-testable.
 */
import type { StoredTranscriptRow } from "./store/transcript-cursor-store.js";

/** Payload-free facts about one visible entry gathered during the scan pass. */
export type ScannedVisibleEntry = {
  entryId: string;
  parentId: string | null;
  seq: number;
  supersedesEntryId?: string;
  /** Storage token estimate; 0 for entries LCM does not persist. */
  tokens: number;
};

/** Result of reconciling the visible id set against stored ids. */
export type ResyncPlan = {
  /** Visible index -> stored row to restamp with that entry's id. */
  restamps: Map<number, StoredTranscriptRow>;
  /** Last visible index whose id is stored (or restamped); -1 when none. */
  lastKnownIndex: number;
  /** Conversation seq of the row anchoring the last known index; null when unanchored. */
  anchorRowSeq: number | null;
  /** Unknown visible entries before the anchor that resync leaves unimported. */
  unimportedBeforeAnchor: number;
};

const MAX_SUPERSEDES_CHAIN = 64;

/**
 * Follow host `supersedesEntryId` links from one entry to a stored row whose id
 * has left the visible projection. Only rows not yet claimed qualify.
 */
export function resolveSupersededRow(params: {
  entryId: string;
  supersedesById: ReadonlyMap<string, string>;
  stored: ReadonlyMap<string, StoredTranscriptRow>;
  visibleIds: ReadonlySet<string>;
  claimedMessageIds: ReadonlySet<number>;
}): StoredTranscriptRow | null {
  let predecessor = params.supersedesById.get(params.entryId);
  for (let steps = 0; predecessor && steps < MAX_SUPERSEDES_CHAIN; steps += 1) {
    const row = params.stored.get(predecessor);
    if (row && !params.visibleIds.has(predecessor) && !params.claimedMessageIds.has(row.messageId)) {
      return row;
    }
    predecessor = params.supersedesById.get(predecessor);
  }
  return null;
}

/**
 * Reconcile scanned visible ids against the stored id map in one pass.
 *
 * Known ids anchor the conversation; entries carrying a supersedes link to a
 * stored, no-longer-visible id are planned as restamps and also count as
 * known. Unknown entries before the last known index are never imported:
 * appending them would place history out of order, and they are storage
 * policy skips, pre-start history, or legacy unstamped rows.
 */
export function planResync(
  entries: readonly ScannedVisibleEntry[],
  stored: ReadonlyMap<string, StoredTranscriptRow>,
): ResyncPlan {
  const visibleIds = new Set(entries.map((entry) => entry.entryId));
  const supersedesById = new Map<string, string>();
  for (const entry of entries) {
    if (entry.supersedesEntryId) {
      supersedesById.set(entry.entryId, entry.supersedesEntryId);
    }
  }

  const restamps = new Map<number, StoredTranscriptRow>();
  const claimed = new Set<number>();
  let lastKnownIndex = -1;
  let anchorRowSeq: number | null = null;
  const knownIndexes: number[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const direct = stored.get(entry.entryId);
    const row =
      direct ??
      resolveSupersededRow({
        entryId: entry.entryId,
        supersedesById,
        stored,
        visibleIds,
        claimedMessageIds: claimed,
      });
    if (!row) {
      continue;
    }
    if (!direct) {
      restamps.set(index, row);
      claimed.add(row.messageId);
    }
    knownIndexes.push(index);
    lastKnownIndex = index;
    anchorRowSeq = row.seq;
  }

  // Count unknown entries that sit between the first and last known entry.
  let unimportedBeforeAnchor = 0;
  if (knownIndexes.length > 0) {
    const known = new Set(knownIndexes);
    for (let index = knownIndexes[0]!; index < lastKnownIndex; index += 1) {
      if (!known.has(index)) {
        unimportedBeforeAnchor += 1;
      }
    }
  }
  return { restamps, lastKnownIndex, anchorRowSeq, unimportedBeforeAnchor };
}

/**
 * Return the first index of the newest suffix of `entries[from..]` whose
 * persisted tokens fit `budgetTokens`, mirroring `trimBootstrapMessagesToBudget`:
 * the newest persisted entry is always kept unless it alone exceeds the budget,
 * in which case nothing is imported (returns `entries.length`).
 */
export function budgetStartIndex(
  entries: readonly ScannedVisibleEntry[],
  from: number,
  budgetTokens: number,
): number {
  const budget = Number.isFinite(budgetTokens) ? Math.max(0, Math.floor(budgetTokens)) : 0;
  let total = 0;
  let kept = 0;
  let start = entries.length;
  for (let index = entries.length - 1; index >= from; index -= 1) {
    const tokens = entries[index]!.tokens;
    if (tokens <= 0) {
      // Entries LCM does not persist consume no budget.
      continue;
    }
    if (kept > 0 && total + tokens > budget) {
      break;
    }
    total += tokens;
    kept += 1;
    start = index;
  }
  if (kept === 1 && total > budget) {
    return entries.length;
  }
  return kept === 0 ? entries.length : start;
}

/**
 * In-order content matcher for rewritten suffixes. Candidate rows are stored
 * rows after the anchor whose ids left the projection (or were never
 * stamped). Each claim takes the earliest unclaimed row with the same identity
 * hash that follows the previous claim, so a copy-on-write re-append maps
 * back onto the original rows in order.
 */
export class SuffixContentMatcher {
  private readonly byHash = new Map<string, StoredTranscriptRow[]>();
  private readonly pointers = new Map<string, number>();
  private lastClaimedSeq = Number.NEGATIVE_INFINITY;
  /** Claims made while more than one in-order candidate shared the hash. */
  multiCandidateClaims = 0;

  constructor(rows: readonly StoredTranscriptRow[]) {
    const ordered = [...rows].sort((left, right) => left.seq - right.seq);
    for (const row of ordered) {
      if (!row.identityHash) {
        continue;
      }
      const group = this.byHash.get(row.identityHash) ?? [];
      group.push(row);
      this.byHash.set(row.identityHash, group);
    }
  }

  /** True when no candidate rows exist. */
  get isEmpty(): boolean {
    return this.byHash.size === 0;
  }

  /** Claim the next in-order row for `identityHash`, or null when none remains. */
  claim(identityHash: string): StoredTranscriptRow | null {
    const group = this.byHash.get(identityHash);
    if (!group) {
      return null;
    }
    let pointer = this.pointers.get(identityHash) ?? 0;
    while (pointer < group.length && group[pointer]!.seq <= this.lastClaimedSeq) {
      pointer += 1;
    }
    if (pointer >= group.length) {
      this.pointers.set(identityHash, pointer);
      return null;
    }
    if (group.length - pointer > 1) {
      this.multiCandidateClaims += 1;
    }
    const row = group[pointer]!;
    this.pointers.set(identityHash, pointer + 1);
    this.lastClaimedSeq = row.seq;
    return row;
  }
}
