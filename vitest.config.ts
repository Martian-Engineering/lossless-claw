import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const testHome = mkdtempSync(join(tmpdir(), "lossless-claw-vitest-home-"));
const testOpenClawDir = join(testHome, ".openclaw");
const testDbPath = join(testOpenClawDir, "lcm.db");
// Keep plugin file logs out of the production /tmp/openclaw rolling log.
const testLogFile = join(testHome, "logs", "lossless-claw-test.log");

mkdirSync(testOpenClawDir, { recursive: true });

export default defineConfig({
  test: {
    dir: "test",
    include: ["**/*.test.ts"],
    exclude: ["**/.worktrees/**"],
    env: {
      HOME: testHome,
      LCM_LOG_FILE: testLogFile,
    },
  },
});
