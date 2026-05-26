import { describe, expect, it } from "vitest";
import { parseEntityExtractionResponse } from "../src/extraction/entity-extractor-llm.js";

describe("entity-extractor-llm — parseEntityExtractionResponse", () => {
  it("parses pure JSON array", () => {
    const r = parseEntityExtractionResponse(
      `[{"surface":"PR #71676","entityType":"pr_number"},{"surface":"R-23","entityType":"agent_id"}]`,
    );
    expect(r).toEqual([
      { surface: "PR #71676", entityType: "pr_number" },
      { surface: "R-23", entityType: "agent_id" },
    ]);
  });

  it("strips markdown code fence", () => {
    const r = parseEntityExtractionResponse(
      "```json\n" +
        `[{"surface":"x","entityType":"y"}]\n` +
        "```",
    );
    expect(r).toEqual([{ surface: "x", entityType: "y" }]);
  });

  it("handles markdown fence without language tag", () => {
    const r = parseEntityExtractionResponse(
      "```\n" + `[{"surface":"x","entityType":"y"}]\n` + "```",
    );
    expect(r).toHaveLength(1);
  });

  it("extracts JSON from prose-wrapped response", () => {
    const r = parseEntityExtractionResponse(
      `Sure, here are the entities:\n[{"surface":"foo","entityType":"bar"}]\nLet me know if you need more.`,
    );
    expect(r).toEqual([{ surface: "foo", entityType: "bar" }]);
  });

  it("returns [] for non-JSON output", () => {
    expect(parseEntityExtractionResponse("I cannot extract entities from this.")).toEqual([]);
    expect(parseEntityExtractionResponse("")).toEqual([]);
    expect(parseEntityExtractionResponse(null as unknown as string)).toEqual([]);
  });

  it("returns [] for non-array JSON", () => {
    expect(parseEntityExtractionResponse(`{"surface":"x","entityType":"y"}`)).toEqual([]);
  });

  it("drops entries missing surface or entityType", () => {
    const r = parseEntityExtractionResponse(
      `[{"surface":"valid","entityType":"good"},{"surface":"missing-type"},{"entityType":"missing-surface"}]`,
    );
    expect(r).toEqual([{ surface: "valid", entityType: "good" }]);
  });

  it("normalizes entityType to snake_case", () => {
    const r = parseEntityExtractionResponse(
      `[{"surface":"x","entityType":"PR Number"},{"surface":"y","entityType":"agent-id"},{"surface":"z","entityType":"FILE PATH"}]`,
    );
    expect(r).toEqual([
      { surface: "x", entityType: "pr_number" },
      { surface: "y", entityType: "agent_id" },
      { surface: "z", entityType: "file_path" },
    ]);
  });

  it("preserves optional canonicalText when present", () => {
    const r = parseEntityExtractionResponse(
      `[{"surface":"PR-71676","entityType":"pr_number","canonicalText":"PR #71676"}]`,
    );
    expect(r[0].canonicalText).toBe("PR #71676");
  });

  it("drops entries where entityType normalizes to empty", () => {
    const r = parseEntityExtractionResponse(
      `[{"surface":"x","entityType":"!!!"},{"surface":"y","entityType":"good"}]`,
    );
    expect(r).toEqual([{ surface: "y", entityType: "good" }]);
  });

  it("trims whitespace from surface + entityType", () => {
    const r = parseEntityExtractionResponse(
      `[{"surface":"  spaced  ","entityType":"  also_spaced  "}]`,
    );
    expect(r).toEqual([{ surface: "spaced", entityType: "also_spaced" }]);
  });
});
