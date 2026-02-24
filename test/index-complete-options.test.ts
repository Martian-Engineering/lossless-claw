import { describe, expect, it } from "vitest";
import { buildCompleteSimpleOptions, shouldOmitTemperatureForApi } from "../index.js";

describe("buildCompleteSimpleOptions", () => {
  it("omits temperature for openai-codex-responses", () => {
    const options = buildCompleteSimpleOptions({
      api: "openai-codex-responses",
      apiKey: "k",
      maxTokens: 400,
      temperature: 0.2,
      reasoning: "low",
    });

    expect(shouldOmitTemperatureForApi("openai-codex-responses")).toBe(true);
    expect(options.temperature).toBeUndefined();
    expect(options.reasoning).toBe("low");
  });

  it("keeps temperature for non-codex APIs", () => {
    const options = buildCompleteSimpleOptions({
      api: "openai-responses",
      apiKey: "k",
      maxTokens: 400,
      temperature: 0.2,
      reasoning: undefined,
    });

    expect(shouldOmitTemperatureForApi("openai-responses")).toBe(false);
    expect(options.temperature).toBe(0.2);
    expect(options.reasoning).toBeUndefined();
  });
});
