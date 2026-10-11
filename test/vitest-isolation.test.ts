import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveLcmConfig } from "../src/db/config.js";

describe("vitest sandbox", () => {
  it("forces the default LCM database into the test HOME", () => {
    expect(process.env.HOME).toBeTruthy();

    const config = resolveLcmConfig(process.env, {});
    expect(config.databasePath).toBe(join(process.env.HOME!, ".openclaw", "lcm.db"));
  });

  it("keeps the independent plugin log out of the production /tmp/openclaw log", () => {
    const config = resolveLcmConfig(process.env, {});
    expect(config.independentLogFile.file).toBe(
      join(process.env.HOME!, "logs", "lossless-claw-test.log"),
    );
  });
});
