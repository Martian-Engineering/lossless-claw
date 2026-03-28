import { describe, it, expect } from "vitest";
import manifest from "../openclaw.plugin.json" with { type: "json" };
import { resolveLcmConfig } from "../src/db/config.js";

describe("customInstructions config", () => {
  it("defaults customInstructions to empty string", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.customInstructions).toBe("");
  });

  it("reads customInstructions from plugin config", () => {
    const config = resolveLcmConfig({}, {
      customInstructions: "Write as a neutral documenter. Use third person.",
    });
    expect(config.customInstructions).toBe("Write as a neutral documenter. Use third person.");
  });

  it("env var overrides plugin config for customInstructions", () => {
    const config = resolveLcmConfig(
      { LCM_CUSTOM_INSTRUCTIONS: "env instructions" } as NodeJS.ProcessEnv,
      { customInstructions: "plugin instructions" },
    );
    expect(config.customInstructions).toBe("env instructions");
  });

  it("trims whitespace from env var customInstructions", () => {
    const config = resolveLcmConfig(
      { LCM_CUSTOM_INSTRUCTIONS: "  trimmed  " } as NodeJS.ProcessEnv,
      {},
    );
    expect(config.customInstructions).toBe("trimmed");
  });

  it("trims whitespace from plugin config customInstructions", () => {
    const config = resolveLcmConfig({}, {
      customInstructions: "  trimmed  ",
    });
    expect(config.customInstructions).toBe("trimmed");
  });

  it("falls through to default when plugin config value is empty string", () => {
    const config = resolveLcmConfig({}, {
      customInstructions: "   ",
    });
    expect(config.customInstructions).toBe("");
  });

  it("ignores non-string plugin config values", () => {
    const config = resolveLcmConfig({}, {
      customInstructions: 42,
    });
    expect(config.customInstructions).toBe("");
  });

  it("ships a manifest with customInstructions in schema", () => {
    expect(manifest.configSchema.properties.customInstructions).toEqual({ type: "string" });
  });
});
