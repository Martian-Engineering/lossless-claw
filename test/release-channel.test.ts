import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../scripts/release-channel.mjs", import.meta.url),
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function classify(version: string) {
  return run(version);
}

describe("release-channel CLI", () => {
  it("routes stable versions to latest", () => {
    const result = classify("0.13.2");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("npm_tag=latest\nprerelease=false\n");
  });

  it("routes beta versions to beta and GitHub prerelease", () => {
    const result = classify("0.14.0-beta.0");

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("npm_tag=beta\nprerelease=true\n");
  });

  it.each(["0.14.0-rc.0", "0.14.0-alpha.1", "banana", "1.2"])(
    "rejects unsupported version %s",
    (version) => {
      const result = classify(version);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`Unsupported release version: ${version}`);
    },
  );
});

describe("release ordering CLI", () => {
  it.each([
    ["0.14.0", "0.13.2"],
    ["0.14.0-beta.1", "0.14.0-beta.0"],
    ["1.0.0-beta.0", "0.99.9-beta.99"],
  ])("accepts newer candidate %s over %s", (candidate, current) => {
    const result = run("--assert-newer", candidate, current);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["0.13.2", "0.13.2"],
    ["0.13.1", "0.13.2"],
    ["0.14.0-beta.0", "0.14.0-beta.0"],
    ["0.14.0-beta.0", "0.14.0-beta.1"],
    ["0.14.0-beta.0", "0.13.2"],
  ])("rejects non-newer candidate %s over %s", (candidate, current) => {
    const result = run("--assert-newer", candidate, current);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Release version ${candidate} must be newer than ${current} on the same channel`,
    );
  });
});
