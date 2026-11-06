import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const testHome = mkdtempSync(join(tmpdir(), "lossless-claw-vitest-home-"));
const testOpenClawDir = join(testHome, ".openclaw");
const testDbPath = join(testOpenClawDir, "lcm.db");
// Keep plugin file logs out of the production /tmp/openclaw rolling log.
const testLogFile = join(testHome, "logs", "lossless-claw-test.log");

mkdirSync(testOpenClawDir, { recursive: true });

export default defineConfig({
  test: {
    // The pinned host predates this optional public SDK subpath. Registration
    // tests supply its exports; keep the fixture separate from the old SDK.
    alias: {
      "openclaw/plugin-sdk/context-engine-transcript-runtime": fileURLToPath(
        new URL("./test/fixtures/context-engine-transcript-runtime.ts", import.meta.url),
      ),
    },
    dir: "test",
    include: ["**/*.test.ts"],
    exclude: ["**/.worktrees/**"],
    env: {
      HOME: testHome,
      LCM_LOG_FILE: testLogFile,
    },
  },
});
