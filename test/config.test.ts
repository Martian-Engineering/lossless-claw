import { describe, it, expect } from "vitest";
import { resolveLcmConfig, type LcmConfig } from "../src/db/config.js";
import { createTestConfig } from "./helpers/tokenizer.js";

describe("useTokenizer config", () => {
  it("defaults to false", () => {
    const config = resolveLcmConfig({}, {});
    expect(config.useTokenizer).toBe(false);
  });

  it("respects LCM_USE_PRECISE_TOKENIZER env", () => {
    const config = resolveLcmConfig(
      { LCM_USE_PRECISE_TOKENIZER: "true" } as NodeJS.ProcessEnv,
      {}
    );
    expect(config.useTokenizer).toBe(true);
  });

  it("respects plugin config", () => {
    const config = resolveLcmConfig({}, { useTokenizer: true });
    expect(config.useTokenizer).toBe(true);
  });

  it("env takes precedence over plugin config", () => {
    const config = resolveLcmConfig(
      { LCM_USE_PRECISE_TOKENIZER: "false" } as NodeJS.ProcessEnv,
      { useTokenizer: true }
    );
    expect(config.useTokenizer).toBe(false);
  });

  it("createTestConfig helper works correctly", () => {
    const config = createTestConfig();
    expect(config.useTokenizer).toBe(false);
    
    const configWithTokenizer = createTestConfig({ useTokenizer: true });
    expect(configWithTokenizer.useTokenizer).toBe(true);
  });
});
