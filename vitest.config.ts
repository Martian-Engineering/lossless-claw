import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

const testHome = mkdtempSync(join(tmpdir(), "lossless-claw-vitest-home-"));
const testOpenClawDir = join(testHome, ".openclaw");
const testDbPath = join(testOpenClawDir, "lcm.db");

mkdirSync(testOpenClawDir, { recursive: true });

export default defineConfig({
  test: {
    dir: "test",
    include: ["**/*.test.ts"],
    exclude: ["**/.worktrees/**"],
    env: {
      HOME: testHome,
    },
  },
});
