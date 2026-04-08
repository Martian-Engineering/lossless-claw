import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveLcmConfig } from "../src/db/config.js";

describe("vitest sandbox", () => {
  it("forces the default LCM database into the test HOME", () => {
    expect(process.env.HOME).toBeTruthy();

    const config = resolveLcmConfig(process.env, {});
    expect(config.databasePath).toBe(join(process.env.HOME!, ".openclaw", "lcm.db"));
  });
});
