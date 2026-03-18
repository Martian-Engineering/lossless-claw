import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type DaemonConfig = {
  version: number;
  daemon: { port: number; socketPath: string; logLevel: string; logMaxSizeMB: number; logRetentionDays: number };
  compaction: {
    leafTokens: number; maxDepth: number;
    promotionThresholds: { minDepth: number; compressionRatio: number; keywords: Record<string, string[]>; architecturePatterns: string[] };
  };
  restoration: { recentSummaries: number; semanticTopK: number; semanticThreshold: number };
  llm: { provider: "anthropic" | "openai"; model: string; apiKey: string; baseURL: string };
  cipher: { configPath: string; collection: string };
};

const DEFAULTS: DaemonConfig = {
  version: 1,
  daemon: { port: 3737, socketPath: join(homedir(), ".lossless-claude", "daemon.sock"), logLevel: "info", logMaxSizeMB: 10, logRetentionDays: 7 },
  compaction: {
    leafTokens: 1000, maxDepth: 5,
    promotionThresholds: {
      minDepth: 2, compressionRatio: 0.3,
      keywords: { decision: ["decided", "agreed", "will use", "going with", "chosen"], fix: ["fixed", "root cause", "workaround", "resolved"] },
      architecturePatterns: ["src/[\\w/]+\\.ts", "[A-Z][a-zA-Z]+(Engine|Store|Service|Manager|Handler|Client)", "interface [A-Z]", "class [A-Z]"],
    },
  },
  restoration: { recentSummaries: 3, semanticTopK: 5, semanticThreshold: 0.35 },
  llm: { provider: "anthropic", model: "claude-haiku-4-5-20251001", apiKey: "", baseURL: "" },
  cipher: { configPath: join(homedir(), ".cipher", "cipher.yml"), collection: "lossless_memory" },
};

function deepMerge(target: any, source: any): any {
  if (!source || typeof source !== "object") return target;
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] !== undefined) {
      result[key] = (typeof source[key] === "object" && !Array.isArray(source[key]) && typeof target[key] === "object")
        ? deepMerge(target[key], source[key]) : source[key];
    }
  }
  return result;
}

export function loadDaemonConfig(configPath: string, overrides?: any, env?: Record<string, string | undefined>): DaemonConfig {
  const e = env ?? process.env;
  let fileConfig: any = {};
  try { fileConfig = JSON.parse(readFileSync(configPath, "utf-8")); } catch {}
  const merged = deepMerge(structuredClone(DEFAULTS), deepMerge(fileConfig, overrides));
  if (merged.llm.apiKey) merged.llm.apiKey = merged.llm.apiKey.replace(/\$\{(\w+)\}/g, (_: string, k: string) => e[k] ?? "");
  if (!merged.llm.apiKey && merged.llm.provider === "anthropic" && e.ANTHROPIC_API_KEY) {
    merged.llm.apiKey = e.ANTHROPIC_API_KEY;
  }
  return merged;
}
