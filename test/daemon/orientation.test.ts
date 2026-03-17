import { describe, it, expect } from "vitest";
import { buildOrientationPrompt } from "../../src/daemon/orientation.js";

describe("buildOrientationPrompt", () => {
  it("contains memory-orientation tag", () => {
    const p = buildOrientationPrompt();
    expect(p).toContain("<memory-orientation>");
    expect(p).toContain("</memory-orientation>");
  });
  it("mentions all four tools", () => {
    const p = buildOrientationPrompt();
    expect(p).toContain("lcm_grep");
    expect(p).toContain("lcm_expand");
    expect(p).toContain("lcm_describe");
    expect(p).toContain("lcm_search");
  });
  it("instructs not to store directly", () => {
    const p = buildOrientationPrompt();
    expect(p).toContain("Do not store directly");
  });
});
