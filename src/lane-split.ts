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
