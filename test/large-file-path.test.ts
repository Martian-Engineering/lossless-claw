import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveExposableLargeFilePath } from "../src/large-file-path.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveExposableLargeFilePath", () => {
  it("returns the canonical path for a regular file beneath the configured root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-path-root-"));
    tempDirs.push(root);
    const nested = join(root, "42");
    mkdirSync(nested);
    const file = join(nested, "file_abc123.txt");
    writeFileSync(file, "large tool output", "utf8");

    await expect(resolveExposableLargeFilePath(root, file)).resolves.toBe(file);
  });

  it("rejects files outside the configured root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-path-root-"));
    const outside = mkdtempSync(join(tmpdir(), "lcm-path-outside-"));
    tempDirs.push(root, outside);
    const file = join(outside, "file_abc123.txt");
    writeFileSync(file, "outside", "utf8");

    await expect(resolveExposableLargeFilePath(root, file)).resolves.toBeUndefined();
  });

  it("rejects missing paths and directories", async () => {
    const root = mkdtempSync(join(tmpdir(), "lcm-path-root-"));
    tempDirs.push(root);

    await expect(
      resolveExposableLargeFilePath(root, join(root, "missing.txt")),
    ).resolves.toBeUndefined();
    await expect(resolveExposableLargeFilePath(root, root)).resolves.toBeUndefined();
  });
});
