import { describe, expect, it } from "vitest";
import { userInfo } from "node:os";
import { join } from "node:path";
import { resolveLcmConfig, resolveOpenclawStateDir } from "../src/db/config.js";
import { isLiveStateDatabaseUnderTest } from "../src/db/connection.js";

describe("vitest sandbox", () => {
  it("forces the default LCM database into the test HOME", () => {
    expect(process.env.HOME).toBeTruthy();

    const config = resolveLcmConfig(process.env, {});
    expect(config.databasePath).toBe(join(process.env.HOME!, ".openclaw", "lcm.db"));
  });

  it("overrides an inherited OPENCLAW_STATE_DIR with the test state dir", () => {
    const testStateDir = join(process.env.HOME!, ".openclaw");
    expect(process.env.OPENCLAW_STATE_DIR).toBe(testStateDir);
    expect(resolveOpenclawStateDir(process.env)).toBe(testStateDir);
  });

  it("drops inherited database and large-file path overrides", () => {
    expect(process.env.LCM_DATABASE_PATH).toBeUndefined();
    expect(process.env.LCM_LARGE_FILES_DIR).toBeUndefined();

    const config = resolveLcmConfig(process.env, {});
    expect(config.largeFilesDir).toBe(join(process.env.HOME!, ".openclaw", "lcm-files"));
  });

  it("keeps the independent plugin log out of the production /tmp/openclaw log", () => {
    const config = resolveLcmConfig(process.env, {});
    expect(config.independentLogFile.file).toBe(
      join(process.env.HOME!, "logs", "lossless-claw-test.log"),
    );
  });
});

describe("live state database guard", () => {
  const liveDbPath = join(userInfo().homedir, ".openclaw", "lcm.db");

  it("flags databases in the real ~/.openclaw state dir under vitest", () => {
    expect(isLiveStateDatabaseUnderTest(liveDbPath)).toBe(true);
    expect(isLiveStateDatabaseUnderTest(`  ${liveDbPath}  `)).toBe(true);
  });

  it("allows test, nested, in-memory and non-vitest paths", () => {
    expect(isLiveStateDatabaseUnderTest(join(process.env.HOME!, ".openclaw", "lcm.db"))).toBe(false);
    expect(
      isLiveStateDatabaseUnderTest(join(userInfo().homedir, ".openclaw", "worktrees", "x", "lcm.db")),
    ).toBe(false);
    expect(isLiveStateDatabaseUnderTest(":memory:")).toBe(false);
    expect(isLiveStateDatabaseUnderTest(liveDbPath, {})).toBe(false);
  });
});
