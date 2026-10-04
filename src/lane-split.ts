import { isToolResultMessage } from "./estimate-tokens.js";

/**
 * Lane split (Step 1) — the two lanes a message can belong to.
 *
 * `conversation` is the default: every message the assembler would have
 * handled before lane splitting existed. `longtext` tags high-volume,
 * machine-generated payloads (tool results) so a later step can budget the
 * two lanes independently. Step 1 only records the tag — assembly behavior
 * is unchanged.
 */
export type MessageLane = "conversation" | "longtext";

/**
 * Structural lane classification. Deliberately model-free: lane is a
 * property of the content shape, not of any summarizer judgment.
 *
 * Rule (spec §2, rule A): tool-result messages are longtext; everything else
 * is conversation. Step 1 does not split user/assistant messages into
 * intent/body segments — those stay entirely in the conversation lane.
 */
export function classifyMessageLane(message: unknown): MessageLane {
  return isToolResultMessage(message) ? "longtext" : "conversation";
}

export type LaneDistributionEntry = {
  lane: MessageLane;
  tokenCount: number;
};

export type LaneDistribution = {
  conversation: { count: number; tokens: number };
  longtext: { count: number; tokens: number };
};

/** Aggregate count + token estimate per lane for observability logging. */
export function summarizeLaneDistribution(
  entries: readonly LaneDistributionEntry[],
): LaneDistribution {
  const distribution: LaneDistribution = {
    conversation: { count: 0, tokens: 0 },
    longtext: { count: 0, tokens: 0 },
  };
  for (const entry of entries) {
    const bucket = distribution[entry.lane];
    bucket.count += 1;
    bucket.tokens += Math.max(0, Math.floor(entry.tokenCount));
  }
  return distribution;
}

/** Stable, single-line rendering for debug logs. */
export function formatLaneDistribution(distribution: LaneDistribution): string {
  return (
    `conversation=${distribution.conversation.count}/${distribution.conversation.tokens}tok ` +
    `longtext=${distribution.longtext.count}/${distribution.longtext.tokens}tok`
  );
}

// ── Step 1 observability helpers ────────────────────────────────────────────
//
// A single message can carry text, reasoning and tool parts at once, so a
// role-level count alone cannot express what is stored. But bucketing by block
// type alone is WORSE: tool RESULTS arrive as role="tool" carrying type="text"
// blocks, so a type-only bucket silently swallows them into "text".
// Measured 2026-10-03: tool-heavy sessions are 80-85% tool by chars, yet a
// type-only bucketing reported them as ~15%. Always decide by role first.

export type PartTypeDistribution = Record<string, number>;

/** Count parts by `part_type` for one ingested message. */
export function summarizePartTypeDistribution(
  partTypes: readonly string[],
): PartTypeDistribution {
  const distribution: PartTypeDistribution = {};
  for (const partType of partTypes) {
    const key = partType && partType.length > 0 ? partType : "unknown";
    distribution[key] = (distribution[key] ?? 0) + 1;
  }
  return distribution;
}

/** Stable, single-line rendering for debug logs (sorted for diffability). */
export function formatPartTypeDistribution(distribution: PartTypeDistribution): string {
  return Object.keys(distribution)
    .sort()
    .map((partType) => `${partType}:${distribution[partType]}`)
    .join(",");
}

export type AssembledBucket = "reasoning" | "tool" | "text" | "other";

export type AssembledBucketStats = { blocks: number; chars: number };

export type AssembledComposition = {
  messages: number;
  blocks: number;
  buckets: Record<AssembledBucket, AssembledBucketStats>;
};

const REASONING_BLOCK_TYPES = new Set(["reasoning", "thinking", "redacted_thinking"]);

const TOOL_BLOCK_TYPES = new Set([
  "toolCall",
  "toolUse",
  "tool_use",
  "tool-use",
  "functionCall",
  "function_call",
  "toolResult",
  "tool_result",
  "function_call_output",
  "functionCallOutput",
]);

function assembledBucketOf(type: unknown): AssembledBucket {
  if (typeof type !== "string") return "other";
  if (REASONING_BLOCK_TYPES.has(type)) return "reasoning";
  if (TOOL_BLOCK_TYPES.has(type)) return "tool";
  if (type === "text") return "text";
  return "other";
}

function serializedBlockLength(block: unknown): number {
  try {
    const text = JSON.stringify(block);
    return typeof text === "string" ? text.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Summarize what the assembler is about to emit, bucketed by ROLE first and
 * block `type` second (reasoning / tool / text / other). Role-first matters:
 * tool-result messages (`role="tool"`) carry `type="text"` blocks, so a
 * type-only bucket mislabels them as ordinary text. This is deliberately
 * separate from the storage-side lane tag.
 */
export function summarizeAssembledComposition(
  messages: readonly unknown[],
): AssembledComposition {
  const composition: AssembledComposition = {
    messages: messages.length,
    blocks: 0,
    buckets: {
      reasoning: { blocks: 0, chars: 0 },
      tool: { blocks: 0, chars: 0 },
      text: { blocks: 0, chars: 0 },
      other: { blocks: 0, chars: 0 },
    },
  };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const isToolMessage = isToolResultMessage(message);
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      const stringBucket: AssembledBucket = isToolMessage ? "tool" : "text";
      composition.blocks += 1;
      composition.buckets[stringBucket].blocks += 1;
      composition.buckets[stringBucket].chars += content.length;
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      const bucket: AssembledBucket = isToolMessage
        ? "tool"
        : assembledBucketOf(
            block && typeof block === "object"
              ? (block as { type?: unknown }).type
              : undefined,
          );
      composition.blocks += 1;
      composition.buckets[bucket].blocks += 1;
      composition.buckets[bucket].chars += serializedBlockLength(block);
    }
  }
  return composition;
}

/** Stable, single-line rendering for debug logs. */
export function formatAssembledComposition(composition: AssembledComposition): string {
  const { reasoning, tool, text, other } = composition.buckets;
  const total = reasoning.chars + tool.chars + text.chars + other.chars;
  const share = (part: number) => (total === 0 ? "0.0%" : `${((part / total) * 100).toFixed(1)}%`);
  return (
    `messages=${composition.messages} blocks=${composition.blocks} chars=${total} ` +
    `reasoning=${reasoning.blocks}/${reasoning.chars}(${share(reasoning.chars)}) ` +
    `tool=${tool.blocks}/${tool.chars}(${share(tool.chars)}) ` +
    `text=${text.blocks}/${text.chars}(${share(text.chars)})`
  );
}

// ── Step 2 — lane-aware budget selection ─────────────────────────────────────
//
// Step 2 gives the two lanes independent budgets, but asymmetric policy:
//
//   conversation lane C — protected as a whole. It keeps everything, except
//     when C alone exceeds an ABSOLUTE token cap (the backstop), in which case
//     the OLDEST C items are dropped until it fits.
//   longtext lane L — absorbs all budget pressure. The NEWEST contiguous
//     suffix of L that fits the remaining budget is kept; older L items are
//     evicted first.
//
// Neither lane is ever reordered: trimming always drops a contiguous oldest
// prefix, which preserves append order (and therefore the prompt cache). This
// is a pure function so the policy can be tested without a database.

/**
 * Default absolute token cap for the conversation lane.
 *
 * The conversation lane is otherwise retained as a whole, so this cap is the
 * only thing that may trim it — a backstop against one lane monopolising the
 * window. 65536 ≈ half of a 128K context window: ordinary sessions stay well
 * below it, while a runaway conversation lane can never exceed half the window.
 */
export const DEFAULT_CONVERSATION_LANE_TOKEN_CAP = 65_536;

export type LaneSplitSelection = {
  /** Kept flags for the conversation lane, in input order (oldest → newest). */
  conversationKept: boolean[];
  /** Kept flags for the longtext lane, in input order (oldest → newest). */
  longtextKept: boolean[];
  /** Tokens retained from the conversation lane. */
  conversationTokens: number;
  /** Tokens retained from the longtext lane. */
  longtextTokens: number;
  /** True when the conversation cap forced at least one C item to be dropped. */
  conversationTrimmed: boolean;
  /** True when the budget forced at least one L item to be dropped. */
  longtextTrimmed: boolean;
  /** The absolute conversation cap that was applied. */
  conversationTokenCap: number;
  /** Budget available to the evictable pool (after protected items). */
  remainingBudget: number;
};

/** Coerce an arbitrary token estimate to a finite, non-negative integer. */
function laneTokens(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/**
 * Keep the newest contiguous suffix of `tokens` that fits `budget`, returned
 * as kept flags. Mirrors the assembler's chronological eviction exactly: walk
 * from the newest end, stop at the first item that would overflow, and drop
 * everything older. Never reorders within the lane.
 */
function keepNewestSuffixWithin(tokens: readonly number[], budget: number): boolean[] {
  const kept = new Array<boolean>(tokens.length).fill(false);
  let accumulated = 0;
  for (let i = tokens.length - 1; i >= 0; i--) {
    const tokenCount = laneTokens(tokens[i]);
    if (accumulated + tokenCount > budget) break;
    accumulated += tokenCount;
    kept[i] = true;
  }
  return kept;
}

/** Sum a lane's token estimates. */
function sumLaneTokens(tokens: readonly number[]): number {
  return tokens.reduce((sum, value) => sum + laneTokens(value), 0);
}

/**
 * Apply the Step 2 lane budgets to a single evictable pool.
 *
 * `conversationTokens` and `longtextTokens` are the per-item token estimates
 * of the two lanes, in append order (oldest → newest). Returns which items
 * survive; the caller re-assembles them in the original order.
 */
export function selectLanesWithinBudget(
  conversationTokens: readonly number[],
  longtextTokens: readonly number[],
  remainingBudget: number,
  conversationTokenCap: number = DEFAULT_CONVERSATION_LANE_TOKEN_CAP,
): LaneSplitSelection {
  const budget = laneTokens(remainingBudget);
  const requestedCap = Math.max(
    1,
    laneTokens(conversationTokenCap) || DEFAULT_CONVERSATION_LANE_TOKEN_CAP,
  );
  // The conversation cap must never exceed the remaining budget. Otherwise a
  // protected conversation lane bigger than the budget is emitted in full and
  // the assembled context overshoots its budget (measured 2026-10-03: an
  // 8000-token budget produced ~23k tokens of output, ~3x over). Clamping here
  // keeps the budget a hard ceiling; with cap <= budget (the production
  // configuration) behaviour is unchanged.
  // An unusable budget (NaN / non-finite) must not collapse the cap to zero —
  // fall back to the requested cap, matching this function's existing
  // tolerance for invalid inputs.
  const cap = Number.isFinite(remainingBudget)
    ? Math.min(requestedCap, budget)
    : requestedCap;

  const conversationTotal = sumLaneTokens(conversationTokens);
  // Conversation lane is kept whole; only the absolute cap may trim it.
  const conversationKept =
    conversationTotal <= cap
      ? new Array<boolean>(conversationTokens.length).fill(true)
      : keepNewestSuffixWithin(conversationTokens, cap);
  const conversationKeptTokens = conversationKept.reduce(
    (sum, keep, index) => sum + (keep ? laneTokens(conversationTokens[index]) : 0),
    0,
  );

  // Longtext lane absorbs everything else: whatever budget remains after the
  // (capped) conversation lane, newest-first, dropping the oldest overflow.
  const longtextBudget = Math.max(0, budget - conversationKeptTokens);
  const longtextKept = keepNewestSuffixWithin(longtextTokens, longtextBudget);
  const longtextKeptTokens = longtextKept.reduce(
    (sum, keep, index) => sum + (keep ? laneTokens(longtextTokens[index]) : 0),
    0,
  );

  return {
    conversationKept,
    longtextKept,
    conversationTokens: conversationKeptTokens,
    longtextTokens: longtextKeptTokens,
    conversationTrimmed: conversationKept.some((keep) => !keep),
    longtextTrimmed: longtextKept.some((keep) => !keep),
    conversationTokenCap: cap,
    remainingBudget: budget,
  };
}

// ── Step 3 — reasoning yields first inside the conversation lane ─────────────
//
// Step 2 protects the conversation lane as a whole. But a large share of that
// lane can be model-internal reasoning — process, not information. Measured
// 2026-10-03 on a coding session (fresh tail 6, budget 8000, lane split on):
// reasoning was 57.1% of the emitted prompt while real text was only 27.2%.
// Victor's goal is "remember more of what is useful, not everything", so the
// priority inside the lane is: text (highest) > reasoning (lowest).
//
// Step 3 adds exactly one thing: when the conversation lane is under cap
// pressure, its reasoning blocks are dropped BEFORE any whole message is.
// A message may lose its reasoning while keeping its text. The lane budgets
// themselves (Step 2) are untouched, and the "inline" mode reproduces Step 2
// byte-for-byte (reasoning simply counts as ordinary conversation tokens).

export type ReasoningTrimMode = "inline" | "lowest";

/** Per conversation-lane item: how its token estimate splits across the two
 *  sub-buckets. `reasoningTokens` is the part that Step 3 may sacrifice;
 *  `textTokens` is the "human" content that always outranks it. */
export type ConversationItemTokenSplit = {
  reasoningTokens: number;
  textTokens: number;
};

export type LaneSplitSelectionWithReasoning = LaneSplitSelection & {
  /** Per conversation item, in input order: its reasoning blocks were dropped. */
  reasoningDropped: boolean[];
  /** Conversation-lane tokens retained from reasoning blocks. */
  reasoningTokens: number;
  /** Conversation-lane tokens retained from non-reasoning ("text") content. */
  conversationTextTokens: number;
  /** True when reasoning content was dropped to relieve cap pressure. */
  reasoningTrimmed: boolean;
};

/**
 * Step 3 selection: Step 2's two-lane budgets plus a within-lane reasoning
 * priority. `inline` delegates to `selectLanesWithinBudget` unchanged;
 * `lowest` sheds reasoning (oldest-first, whole-item) before dropping any
 * whole conversation message.
 *
 * Determinism/caching: both lanes are still trimmed only as a contiguous
 * oldest prefix, and items are never reordered. Reasoning is dropped from the
 * OLDEST items first, mirroring chronological eviction, so the newest suffix
 * (the part that matters for the prompt cache) is the last thing to change.
 */
export function selectLanesWithinBudgetWithReasoning(
  conversationItems: readonly ConversationItemTokenSplit[],
  longtextTokens: readonly number[],
  remainingBudget: number,
  conversationTokenCap: number = DEFAULT_CONVERSATION_LANE_TOKEN_CAP,
  reasoningMode: ReasoningTrimMode = "inline",
): LaneSplitSelectionWithReasoning {
  const reasoningTokens = conversationItems.map((item) => laneTokens(item.reasoningTokens));
  const itemTotals = conversationItems.map(
    (item, index) => reasoningTokens[index] + Math.max(0, laneTokens(item.textTokens)),
  );

  const flat = selectLanesWithinBudget(
    itemTotals,
    longtextTokens,
    remainingBudget,
    conversationTokenCap,
  );

  const reasoningDropped = new Array<boolean>(conversationItems.length).fill(false);
  if (reasoningMode === "lowest") {
    const cap = flat.conversationTokenCap;
    const total = itemTotals.reduce((sum, value) => sum + value, 0);
    let overflow = total - cap;
    // Sacrifice whole-item reasoning oldest-first until the overflow is
    // covered. Only reasoning of an item is ever dropped here as a unit; the
    // message's text is left for the suffix walk below, which is the only
    // thing that may drop a whole message.
    for (let index = 0; index < conversationItems.length && overflow > 0; index++) {
      const part = reasoningTokens[index];
      if (part <= 0) continue;
      reasoningDropped[index] = true;
      overflow -= part;
    }
  }

  const effectiveTotals = itemTotals.map(
    (total, index) => total - (reasoningDropped[index] ? reasoningTokens[index] : 0),
  );
  const conversationKept = keepNewestSuffixWithin(effectiveTotals, flat.conversationTokenCap);

  let keptReasoningTokens = 0;
  let keptTextTokens = 0;
  conversationKept.forEach((keep, index) => {
    if (!keep) return;
    const retainedReasoning = reasoningDropped[index] ? 0 : reasoningTokens[index];
    keptReasoningTokens += retainedReasoning;
    keptTextTokens += effectiveTotals[index] - retainedReasoning;
  });

  const longtextBudget = Math.max(0, flat.remainingBudget - (keptReasoningTokens + keptTextTokens));
  const longtextKept = keepNewestSuffixWithin(longtextTokens, longtextBudget);
  const longtextKeptTokens = longtextKept.reduce(
    (sum, keep, index) => sum + (keep ? laneTokens(longtextTokens[index]) : 0),
    0,
  );

  return {
    conversationKept,
    longtextKept,
    conversationTokens: keptReasoningTokens + keptTextTokens,
    longtextTokens: longtextKeptTokens,
    conversationTrimmed: conversationKept.some((keep) => !keep),
    longtextTrimmed: longtextKept.some((keep) => !keep),
    conversationTokenCap: flat.conversationTokenCap,
    remainingBudget: flat.remainingBudget,
    reasoningDropped,
    reasoningTokens: keptReasoningTokens,
    conversationTextTokens: keptTextTokens,
    reasoningTrimmed: reasoningDropped.some(Boolean),
  };
}


