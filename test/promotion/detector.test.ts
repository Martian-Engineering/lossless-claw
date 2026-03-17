import { describe, it, expect } from "vitest";
import { shouldPromote } from "../../src/promotion/detector.js";
import { loadDaemonConfig } from "../../src/daemon/config.js";

const thresholds = loadDaemonConfig("/x").compaction.promotionThresholds;

describe("shouldPromote", () => {
  it("promotes on decision keyword", () => {
    const r = shouldPromote({ content: "We decided to use PostgreSQL", depth: 0, tokenCount: 100, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
    expect(r.tags).toContain("decision");
  });

  it("promotes on high depth (>= minDepth)", () => {
    const r = shouldPromote({ content: "Routine update", depth: 2, tokenCount: 100, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
  });

  it("promotes on high compression (< 0.3 ratio)", () => {
    const r = shouldPromote({ content: "Brief", depth: 0, tokenCount: 50, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true); // 50/500 = 0.1
  });

  it("does not promote low-signal shallow summary", () => {
    const r = shouldPromote({ content: "Let me check that", depth: 0, tokenCount: 450, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(false);
  });

  it("promotes on architecture pattern match", () => {
    const r = shouldPromote({ content: "The ConversationStore class in src/store/conversation-store.ts handles CRUD", depth: 0, tokenCount: 200, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
    expect(r.tags).toContain("architecture");
  });

  it("promotes on fix keyword", () => {
    const r = shouldPromote({ content: "Fixed the root cause of the race condition", depth: 0, tokenCount: 100, sourceMessageTokenCount: 500 }, thresholds);
    expect(r.promote).toBe(true);
    expect(r.tags).toContain("fix");
  });
});
