import { describe, it, expect, vi } from "vitest";
import { promoteSummary } from "../../src/promotion/promoter.js";

describe("promoteSummary", () => {
  it("calls storeWithDedup with correct payload", async () => {
    const mockStore = vi.fn().mockResolvedValue({ action: "ADD" });
    await promoteSummary({
      text: "We decided to use React",
      tags: ["decision"],
      projectId: "abc123",
      projectPath: "/Users/pedro/project",
      depth: 1,
      sessionId: "sess-1",
      confidence: 0.8,
      collection: "lossless_memory",
      _storeWithDedup: mockStore,
    });
    expect(mockStore).toHaveBeenCalledOnce();
    const [text, tags, meta] = mockStore.mock.calls[0];
    expect(text).toBe("We decided to use React");
    expect(tags).toContain("decision");
    expect(meta.projectId).toBe("abc123");
    expect(meta.source).toBe("compaction");
    expect(meta.confidence).toBe(0.8);
  });
});
