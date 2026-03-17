import type { DaemonConfig } from "../daemon/config.js";

type Thresholds = DaemonConfig["compaction"]["promotionThresholds"];

export type PromotionInput = {
  content: string;
  depth: number;
  tokenCount: number;
  sourceMessageTokenCount: number;
};

export type PromotionResult = {
  promote: boolean;
  tags: string[];
  confidence: number;
};

export function shouldPromote(input: PromotionInput, thresholds: Thresholds): PromotionResult {
  const tags: string[] = [];
  const { content, depth, tokenCount, sourceMessageTokenCount } = input;
  const lower = content.toLowerCase();

  // Keyword signals
  for (const [category, keywords] of Object.entries(thresholds.keywords)) {
    if (keywords.some((kw) => lower.includes(kw.toLowerCase()))) tags.push(category);
  }

  // Architecture pattern signals
  for (const pattern of thresholds.architecturePatterns) {
    if (new RegExp(pattern).test(content)) { tags.push("architecture"); break; }
  }

  // Depth signal
  if (depth >= thresholds.minDepth) tags.push("depth");

  // Compression ratio signal
  if (sourceMessageTokenCount > 0 && tokenCount / sourceMessageTokenCount < thresholds.compressionRatio) {
    tags.push("compressed");
  }

  const signals = new Set(tags);
  return {
    promote: signals.size > 0,
    tags: [...signals],
    confidence: Math.min(signals.size / 4, 1),
  };
}
