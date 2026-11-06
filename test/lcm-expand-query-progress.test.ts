import { describe, expect, it } from "vitest";
import { ExpandQueryProgress } from "../src/tools/lcm-expand-query-progress.js";

function result(id: number, totalTokens: number, text = "evidence") {
  return { role: "toolResult", toolCallId: String(id), content: [{ type: "text", text: JSON.stringify({ expansionCount: 1, totalTokens, text }) }] };
}

describe("ExpandQueryProgress", () => {
  it("does not mistake empty content blocks for source evidence", () => {
    const progress = new ExpandQueryProgress();
    expect(progress.observe([1, 2, 3].map((id) => ({ role: "toolResult", toolCallId: String(id), content: [] })))).toBe("no_progress");
    expect(progress.evidence).toEqual([]);
  });

  it("does not mistake a zero-token subtree manifest for an empty describe result", () => {
    const progress = new ExpandQueryProgress();
    for (let i = 0; i < 4; i++) {
      expect(progress.observe([{ role: "toolResult", toolCallId: String(i), content: [{ type: "text", text: JSON.stringify({
        id: `sum_${i}`, type: "summary", summary: { content: `fact ${i}`, tokenCount: 100 }, manifest: { totalTokens: 0 },
      }) }] }])).toBeUndefined();
    }
    expect(progress.evidence).toHaveLength(4);
  });

  it("stops three zero-source Code Mode results and retains earlier evidence", () => {
    const progress = new ExpandQueryProgress();
    progress.observe([result(0, 3916, "original fact")]);
    expect(progress.observe([result(1, 0)])).toBeUndefined();
    expect(progress.observe([result(2, 0)])).toBeUndefined();
    expect(progress.observe([result(3, 0)])).toBe("no_progress");
    expect(progress.evidence.join()).toContain("original fact");
    expect(progress.evidence).toHaveLength(1);
  });

  it("does not count the same snapshot again", () => {
    const progress = new ExpandQueryProgress();
    const messages = [result(1, 0)];
    for (let i = 0; i < 10; i++) expect(progress.observe(messages)).toBeUndefined();
  });

  it("allows healthy multi-step retrieval and resets the no-progress streak", () => {
    const progress = new ExpandQueryProgress();
    for (let i = 0; i < 12; i++) {
      expect(progress.observe([result(i * 2, 0)])).toBeUndefined();
      expect(progress.observe([result(i * 2 + 1, 10, `new fact ${i}`)])).toBeUndefined();
    }
    expect(progress.evidence).toHaveLength(12);
  });

  it.each([71, 87])("bounds a %i-round navigator even when each tool result is different", (rounds) => {
    const progress = new ExpandQueryProgress();
    let stoppedAt = 0;
    for (let i = 0; i < rounds; i++) {
      const stopped = progress.observe([
        { role: "assistant", content: [{ type: "toolCall", id: String(i), name: "exec" }] },
        result(i, 10, `new metadata ${i}`),
      ]);
      if (stopped) { stoppedAt = i + 1; expect(stopped).toBe("tool_limit"); break; }
    }
    expect(stoppedAt).toBeGreaterThan(0);
    expect(stoppedAt).toBeLessThan(rounds);
  });

  it("bounds evidence while preserving the first source instead of the empty tail", () => {
    const progress = new ExpandQueryProgress();
    progress.observe([result(0, 10, "first source")]);
    progress.observe([result(1, 10, "x".repeat(100_000))]);
    expect(progress.evidence.join()).toContain("first source");
    expect(progress.evidence.join("").length).toBeLessThanOrEqual(32_000);
  });
});
