import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type PackageJson = {
  dependencies?: Record<string, string>;
};

type PackageLock = {
  packages?: {
    "": {
      dependencies?: Record<string, string>;
    };
  };
};

describe("package lock consistency", () => {
  it("includes every direct runtime dependency in the root lockfile entry", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as PackageJson;
    const lock = JSON.parse(
      readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
    ) as PackageLock;

    expect(lock.packages?.[""].dependencies).toMatchObject(pkg.dependencies ?? {});
  });
});
