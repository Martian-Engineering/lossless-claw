import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("lcm-read packaging", () => {
  it("exposes lcm-read via package bin mapping", () => {
    const packageJsonPath = resolve(process.cwd(), "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: Record<string, string>;
    };

    expect(packageJson.bin?.["lcm-read"]).toBe("dist/src/cli/lcm-read.js");
  });
});
