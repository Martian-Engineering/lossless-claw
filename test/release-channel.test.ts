import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const script = fileURLToPath(
  new URL("../scripts/release-channel.mjs", import.meta.url),
);

function classify(version: string) {
  return spawnSync(process.execPath, [script, version], { encoding: "utf8" });
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
