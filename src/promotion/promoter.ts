import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

type StoreWithDedup = (text: string, tags: string[], meta: Record<string, unknown>) => Promise<unknown>;

export type PromotionParams = {
  text: string;
  tags: string[];
  projectId: string;
  projectPath: string;
  depth: number;
  sessionId: string;
  confidence: number;
  collection: string;
  _storeWithDedup?: StoreWithDedup; // injectable for tests
};

function loadStoreWithDedup(collection: string): StoreWithDedup {
  const require = createRequire(import.meta.url);
  const store = require(join(homedir(), ".local", "lib", "qdrant-store.js"));
  return (text: string, tags: string[], meta: Record<string, unknown>) =>
    store.storeWithDedup(collection, text, tags, meta);
}

export async function promoteSummary(params: PromotionParams): Promise<void> {
  const store = params._storeWithDedup ?? loadStoreWithDedup(params.collection);
  await store(params.text, params.tags, {
    projectId: params.projectId,
    projectPath: params.projectPath,
    depth: params.depth,
    sessionId: params.sessionId,
    timestamp: new Date().toISOString(),
    source: "compaction",
    confidence: params.confidence,
  });
}
