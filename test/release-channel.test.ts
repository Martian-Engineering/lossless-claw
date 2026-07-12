import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../scripts/release-channel.mjs", import.meta.url),
);

function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}

function runWithInput(input: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    input,
  });
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

describe("release rollback CLI", () => {
  it.each([
    ["0.14.0-beta.0", "0.13.2"],
    ["0.14.0", "0.13.2"],
    ["0.14.1-beta.0", "0.14.0"],
  ])("accepts rollback %s -> %s", (candidate, rollback) => {
    const result = run("--assert-rollback", candidate, rollback);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
  });

  it.each([
    ["0.14.0-beta.0", "0.14.0"],
    ["0.14.0", "0.14.0"],
    ["0.14.0", "0.14.0-beta.0"],
    ["banana", "0.13.2"],
  ])("rejects rollback %s -> %s", (candidate, rollback) => {
    const result = run("--assert-rollback", candidate, rollback);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `Rollback version ${rollback} must be a stable version older than ${candidate}`,
    );
  });
});

describe("release rollback metadata CLI", () => {
  const validChangelog = `# Package

## 0.14.0-beta.0

<!-- release-rollback-version: 0.13.2 -->

Beta notes.

## 0.13.2

Stable notes.
`;

  it("reads the exact release section rollback", () => {
    const result = runWithInput(
      validChangelog,
      "--read-rollback",
      "0.14.0-beta.0",
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("0.13.2\n");
  });

  it.each([
    ["missing", validChangelog.replace("<!-- release-rollback-version: 0.13.2 -->\n\n", "")],
    [
      "duplicate",
      validChangelog.replace(
        "<!-- release-rollback-version: 0.13.2 -->",
        "<!-- release-rollback-version: 0.13.2 -->\n<!-- release-rollback-version: 0.13.1 -->",
      ),
    ],
    [
      "wrong section",
      validChangelog.replace(
        "<!-- release-rollback-version: 0.13.2 -->\n\nBeta notes.",
        "Beta notes.",
      ).replace("Stable notes.", "<!-- release-rollback-version: 0.13.2 -->\n\nStable notes."),
    ],
  ])("rejects %s rollback metadata", (_name, changelog) => {
    const result = runWithInput(
      changelog,
      "--read-rollback",
      "0.14.0-beta.0",
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Expected exactly one valid rollback marker for 0.14.0-beta.0",
    );
  });
});
