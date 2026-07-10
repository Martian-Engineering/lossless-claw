import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigValue,
  readConfigView,
  setConfigValue,
} from "../src/cli/config-file.js";

let directory: string;
let configPath: string;

function writeConfig(value: unknown): string {
  const content = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(configPath, content, { mode: 0o600 });
  return content;
}

function backupFiles(): string[] {
  return readdirSync(directory).filter((name) => name.includes(".lcm-backup-"));
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lcm-cli-config-"));
  configPath = join(directory, "openclaw.json");
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("readConfigView", () => {
  it("returns only raw and effective Lossless config without unrelated secrets", () => {
    writeConfig({
      gateway: { auth: { token: "unrelated-super-secret" } },
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
            config: { contextThreshold: 0.7, freshTailCount: 10 },
          },
        },
      },
    });

    const view = readConfigView(configPath, {
      HOME: directory,
      LCM_FRESH_TAIL_COUNT: "12",
    });

    expect(view.raw).toEqual({ contextThreshold: 0.7, freshTailCount: 10 });
    expect(view.effective).toMatchObject({ contextThreshold: 0.7, freshTailCount: 12 });
    expect(view.environmentOverrides).toEqual(["LCM_FRESH_TAIL_COUNT"]);
    expect(JSON.stringify(view)).not.toContain("unrelated-super-secret");
  });

  it("reports raw and effective values separately", () => {
    writeConfig({
      plugins: { entries: { "lossless-claw": { config: { freshTailCount: 10 } } } },
    });
    const view = readConfigView(configPath, { HOME: directory, LCM_FRESH_TAIL_COUNT: "12" });

    expect(getConfigValue(view, "freshTailCount")).toEqual({
      path: "freshTailCount",
      isSet: true,
      rawValue: 10,
      effectiveValue: 12,
    });
  });

  it("reports runtime-invalid existing config as a config validation failure", () => {
    writeConfig({
      plugins: {
        entries: {
          "lossless-claw": {
            config: {
              contextThresholdOverrides: [{
                match: { modelContextWindowMin: 100, modelContextWindowMax: 10 },
                contextThreshold: 0.5,
              }],
            },
          },
        },
      },
    });

    expect(() => readConfigView(configPath, {})).toThrowError(
      expect.objectContaining({ code: "CONFIG_VALIDATION_FAILED", exitCode: 4 }),
    );
  });
});

describe("setConfigValue", () => {
  it("changes only the targeted key with a mode-preserving backup and atomic replacement", () => {
    const original = writeConfig({
      gateway: { mode: "local" },
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
            config: { freshTailCount: 10, contextThreshold: 0.7 },
          },
        },
      },
    });
    chmodSync(configPath, 0o600);

    const result = setConfigValue(configPath, "freshTailCount", "24", {
      now: () => new Date("2026-07-10T12:34:56.789Z"),
    });

    expect(result).toEqual({
      path: "freshTailCount",
      oldValue: 10,
      newValue: 24,
      configPath,
      backupPath: `${configPath}.lcm-backup-20260710T123456789Z`,
    });
    expect(readFileSync(result.backupPath, "utf8")).toBe(original);
    expect(lstatSync(configPath).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(configPath, "utf8"))).toEqual({
      gateway: { mode: "local" },
      plugins: {
        entries: {
          "lossless-claw": {
            enabled: true,
            config: { freshTailCount: 24, contextThreshold: 0.7 },
          },
        },
      },
    });
  });

  it("supports validated nested config paths", () => {
    writeConfig({ plugins: { entries: { "lossless-claw": { config: {} } } } });

    setConfigValue(configPath, "autoRotateSessionFiles.enabled", "false");

    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.plugins.entries["lossless-claw"].config).toEqual({
      autoRotateSessionFiles: { enabled: false },
    });
  });

  it.each([
    ["unknown config path", "notARealSetting", "true"],
    ["schema-invalid value", "contextThreshold", "2"],
  ])("leaves the file and backup set unchanged for an %s", (_label, path, value) => {
    const original = writeConfig({
      plugins: {
        entries: { "lossless-claw": { config: { contextThreshold: 0.7 } } },
      },
    });

    expect(() => setConfigValue(configPath, path, value)).toThrowError(
      expect.objectContaining({ code: "CONFIG_VALIDATION_FAILED", exitCode: 4 }),
    );
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(backupFiles()).toEqual([]);
  });

  it("rejects config values that violate runtime cross-field constraints", () => {
    const original = writeConfig({
      plugins: { entries: { "lossless-claw": { config: {} } } },
    });
    const invalidOverrides = JSON.stringify([{
      match: { modelContextWindowMin: 100, modelContextWindowMax: 10 },
      contextThreshold: 0.5,
    }]);

    expect(() => setConfigValue(configPath, "contextThresholdOverrides", invalidOverrides))
      .toThrowError(expect.objectContaining({ code: "CONFIG_VALIDATION_FAILED", exitCode: 4 }));
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(backupFiles()).toEqual([]);
  });

  it("refuses JSON5 and include forms before creating a backup", () => {
    writeFileSync(configPath, "{ // comment\n plugins: {}\n}\n", { mode: 0o600 });
    expect(() => setConfigValue(configPath, "freshTailCount", "20")).toThrowError(
      expect.objectContaining({ code: "CONFIG_PARSE_FAILED", exitCode: 4 }),
    );
    expect(backupFiles()).toEqual([]);

    writeConfig({ $include: "./base.json", plugins: {} });
    expect(() => setConfigValue(configPath, "freshTailCount", "20")).toThrowError(
      expect.objectContaining({ code: "CONFIG_INCLUDE_UNSUPPORTED", exitCode: 4 }),
    );
    expect(backupFiles()).toEqual([]);
  });

  it("refuses symlink config files", () => {
    const realPath = join(directory, "real.json");
    writeFileSync(realPath, "{}\n", { mode: 0o600 });
    symlinkSync(realPath, configPath);

    expect(() => setConfigValue(configPath, "freshTailCount", "20")).toThrowError(
      expect.objectContaining({ code: "CONFIG_SYMLINK_UNSUPPORTED", exitCode: 4 }),
    );
    expect(backupFiles()).toEqual([]);
  });
});
