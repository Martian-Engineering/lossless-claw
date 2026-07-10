import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __testing, createIndependentLcmFileLogger } from "../src/lcm-file-log.js";

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lcm-file-log-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  __testing.resetOpenClawRedactor();
});

describe("createIndependentLcmFileLogger", () => {
  it("trusts only private same-owner existing OpenClaw temp dirs", () => {
    const stat = (mode: number, uid = 501, directory = true, symlink = false) =>
      ({
        mode,
        uid,
        isDirectory: () => directory,
        isSymbolicLink: () => symlink,
      }) as fs.Stats;

    expect(__testing.isTrustedExistingOpenClawTmpDir(stat(0o700), 501)).toBe(true);
    expect(__testing.isTrustedExistingOpenClawTmpDir(stat(0o755), 501)).toBe(false);
    expect(__testing.isTrustedExistingOpenClawTmpDir(stat(0o700, 502), 501)).toBe(false);
    expect(__testing.isTrustedExistingOpenClawTmpDir(stat(0o700, 501, true, true), 501)).toBe(false);
  });

  it("writes JSONL records to the configured lossless-owned file", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write("info", "[lcm] Plugin loaded");

    const line = fs.readFileSync(file, "utf8").trim();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(record.level).toBe("info");
    expect(record.plugin).toBe("lossless-claw");
    expect(record.message).toBe("[lcm] Plugin loaded");
    expect(typeof record.time).toBe("string");
  });

  it("rotates oversized active files through numbered suffixes", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 80,
    });

    logger?.write("info", "[lcm] first message with enough bytes to rotate next");
    logger?.write("warn", "[lcm] second message rotates the first file");

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "lossless-claw-test.1.log"))).toBe(true);
  });

  it("does not rotate non-regular configured log targets", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    fs.mkdirSync(file);
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1,
    });

    logger?.write("warn", "[lcm] should not move directory");

    expect(fs.lstatSync(file).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "lossless-claw-test.1.log"))).toBe(false);
  });

  it("does not treat fixed filenames as dated rolling paths", () => {
    const file = path.join(tempDir, "lossless-claw-production.log");
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write("info", "[lcm] fixed path");

    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(tempDir, "lossless-claw-2026-06-07.log"))).toBe(false);
  });

  it("keeps rolling log files for at least 3 days", () => {
    const oldFile = path.join(tempDir, "lossless-claw-2026-06-01.log");
    const recentFile = path.join(tempDir, "lossless-claw-2026-06-02.log");
    fs.writeFileSync(oldFile, "old\n");
    fs.writeFileSync(recentFile, "recent\n");
    const now = Date.now();
    const fourDaysAgo = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldFile, fourDaysAgo, fourDaysAgo);
    fs.utimesSync(recentFile, twoDaysAgo, twoDaysAgo);

    createIndependentLcmFileLogger({
      enabled: true,
      file: path.join(tempDir, "lossless-claw-2026-06-07.log"),
      maxFileBytes: 1024 * 1024,
    });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(recentFile)).toBe(true);
  });

  it("does not prune fixed lossless-claw log filenames", () => {
    const fixedFile = path.join(tempDir, "lossless-claw-incident.log");
    fs.writeFileSync(fixedFile, "incident\n");
    const fourDaysAgo = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
    fs.utimesSync(fixedFile, fourDaysAgo, fourDaysAgo);

    createIndependentLcmFileLogger({
      enabled: true,
      file: path.join(tempDir, "lossless-claw-2026-06-07.log"),
      maxFileBytes: 1024 * 1024,
    });

    expect(fs.existsSync(fixedFile)).toBe(true);
  });

  it("prunes stale rotated segments for dated rolling logs", () => {
    const oldSegment = path.join(tempDir, "lossless-claw-2026-06-01.1.log");
    const recentSegment = path.join(tempDir, "lossless-claw-2026-06-02.1.log");
    fs.writeFileSync(oldSegment, "old segment\n");
    fs.writeFileSync(recentSegment, "recent segment\n");
    const now = Date.now();
    const fourDaysAgo = new Date(now - 4 * 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldSegment, fourDaysAgo, fourDaysAgo);
    fs.utimesSync(recentSegment, twoDaysAgo, twoDaysAgo);

    createIndependentLcmFileLogger({
      enabled: true,
      file: path.join(tempDir, "lossless-claw-2026-06-07.log"),
      maxFileBytes: 1024 * 1024,
    });

    expect(fs.existsSync(oldSegment)).toBe(false);
    expect(fs.existsSync(recentSegment)).toBe(true);
  });

  it("redacts obvious secret-shaped text before writing", () => {
    __testing.setOpenClawRedactor(undefined);
    const file = path.join(tempDir, "lossless-claw-test.log");
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write("error", "[lcm] failed token=super-secret-token-value");

    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(record.message).toBe("[lcm] failed token=[REDACTED]");
  });

  it("redacts common host logger secret shapes before writing", () => {
    __testing.setOpenClawRedactor(undefined);
    const file = path.join(tempDir, "lossless-claw-test.log");
    const githubToken = "ghp_12345678901234567890";
    const githubPat = "github_pat_12345678901234567890";
    const awsKey = "AKIA1234567890ABCDEF";
    const jsonToken = "json-secret-token-value";
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write(
      "error",
      `[lcm] failed github=${githubToken} pat=${githubPat} aws=${awsKey} body={"token":"${jsonToken}"}`,
    );

    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(record.message).toContain("[REDACTED]");
    expect(record.message).not.toContain(githubToken);
    expect(record.message).not.toContain(githubPat);
    expect(record.message).not.toContain(awsKey);
    expect(record.message).not.toContain(jsonToken);
  });

  it("uses the OpenClaw redactor when the optional host dependency is available", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const redactSensitiveText = vi.fn(() => "[lcm] host redacted");
    __testing.setOpenClawRedactor(redactSensitiveText);
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write("error", "[lcm] failed token=super-secret-token-value");

    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(redactSensitiveText).toHaveBeenCalledWith(
      "[lcm] failed token=super-secret-token-value",
      undefined,
    );
    expect(record.message).toBe("[lcm] host redacted");
  });

  it("creates configured log files with owner-only permissions", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write("info", "[lcm] private file mode");

    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("makes existing configured log files owner-only before appending", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    fs.writeFileSync(file, "existing\n", { mode: 0o644 });
    const logger = createIndependentLcmFileLogger({
      enabled: true,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write("info", "[lcm] private append");

    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(file, "utf8")).toContain("[lcm] private append");
  });

  it("does not write when disabled", () => {
    const file = path.join(tempDir, "lossless-claw-test.log");
    const logger = createIndependentLcmFileLogger({
      enabled: false,
      file,
      maxFileBytes: 1024 * 1024,
    });

    logger?.write("info", "[lcm] ignored");

    expect(fs.existsSync(file)).toBe(false);
  });

  it("disables independent file logging when setup cannot create the log directory", () => {
    const parentAsFile = path.join(tempDir, "not-a-directory");
    fs.writeFileSync(parentAsFile, "occupied");

    expect(
      createIndependentLcmFileLogger({
        enabled: true,
        file: path.join(parentAsFile, "lossless-claw-test.log"),
        maxFileBytes: 1024 * 1024,
      }),
    ).toBeUndefined();
  });
});
