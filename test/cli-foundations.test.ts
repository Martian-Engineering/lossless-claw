import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeCursor,
  encodeCursor,
  parseCliArgs,
  parseTimeFilter,
} from "../src/cli/args.js";
import { openReadOnlyDatabase } from "../src/cli/database.js";
import { CliError, createErrorEnvelope, createSuccessEnvelope } from "../src/cli/output.js";
import { resolveCliPaths } from "../src/cli/paths.js";

const tempDirectories: string[] = [];

function makeTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lcm-cli-foundations-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("resolveCliPaths", () => {
  it("uses explicit paths before Lossless, OpenClaw, and plugin settings", () => {
    const paths = resolveCliPaths({
      env: {
        HOME: "/users/process",
        OPENCLAW_HOME: "/users/openclaw",
        OPENCLAW_STATE_DIR: "/state/openclaw",
        LCM_OPENCLAW_DIR: "/state/lossless",
        OPENCLAW_CONFIG_PATH: "/config/env.json",
        LCM_DATABASE_PATH: "/db/env.db",
      },
      overrides: {
        openclawDir: "/state/explicit",
        configPath: "/config/explicit.json",
        databasePath: "/db/explicit.db",
      },
      pluginConfig: {
        databasePath: "/db/plugin.db",
      },
      homedir: () => "/users/fallback",
    });

    expect(paths).toEqual({
      openclawDir: "/state/explicit",
      configPath: "/config/explicit.json",
      databasePath: "/db/explicit.db",
    });
  });

  it("supports the approved environment and plugin path precedence", () => {
    const pluginPaths = resolveCliPaths({
      env: {
        HOME: "/users/process",
        OPENCLAW_HOME: "/users/openclaw",
        OPENCLAW_STATE_DIR: "/state/openclaw",
        LCM_OPENCLAW_DIR: "/state/lossless",
      },
      pluginConfig: { databasePath: "/ignored.db", dbPath: "~/databases/lcm.db" },
      homedir: () => "/users/fallback",
    });
    expect(pluginPaths).toEqual({
      openclawDir: "/state/lossless",
      configPath: "/state/lossless/openclaw.json",
      databasePath: "/users/openclaw/databases/lcm.db",
    });

    const preferredKey = resolveCliPaths({
      env: { HOME: "/users/process", OPENCLAW_HOME: "/users/openclaw" },
      pluginConfig: { databasePath: "~/databases/preferred.db" },
      homedir: () => "/users/fallback",
    });
    expect(preferredKey.databasePath).toBe("/users/openclaw/databases/preferred.db");

    const defaults = resolveCliPaths({
      env: { HOME: "/users/process", OPENCLAW_HOME: "/users/openclaw" },
      homedir: () => "/users/fallback",
    });
    expect(defaults).toEqual({
      openclawDir: "/users/openclaw/.openclaw",
      configPath: "/users/openclaw/.openclaw/openclaw.json",
      databasePath: "/users/openclaw/.openclaw/lcm.db",
    });
  });
});

describe("parseCliArgs", () => {
  it("parses a scoped, paginated message-list command", () => {
    const parsed = parseCliArgs([
      "messages",
      "list",
      "--session-key",
      "agent:main:example",
      "--role",
      "user",
      "--role",
      "assistant",
      "--limit",
      "25",
      "--include-content",
      "--pretty",
    ]);

    expect(parsed.command).toEqual({ kind: "messages.list" });
    expect(parsed.selector).toEqual({ kind: "sessionKey", value: "agent:main:example" });
    expect(parsed.roles).toEqual(["user", "assistant"]);
    expect(parsed.limit).toBe(25);
    expect(parsed.includeContent).toBe(true);
    expect(parsed.pretty).toBe(true);
  });

  it("rejects ambiguous conversation selectors", () => {
    expect(() =>
      parseCliArgs([
        "conversations",
        "show",
        "--conversation-id",
        "42",
        "--session-key",
        "agent:main:example",
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_SELECTOR", exitCode: 2 }));
  });

  it("requires a selector for conversation-scoped commands", () => {
    expect(() => parseCliArgs(["messages", "tail"])).toThrowError(
      expect.objectContaining({ code: "MISSING_SELECTOR", exitCode: 2 }),
    );
  });

  it.each([
    ["conversations", "list", "unexpected"],
    ["conversations", "show", "unexpected", "--conversation-id", "1"],
    ["messages", "list", "unexpected", "--conversation-id", "1"],
    ["messages", "tail", "unexpected", "--conversation-id", "1"],
    ["summaries", "list", "unexpected"],
    ["config", "show", "unexpected"],
  ])("rejects extra positionals for fixed commands: %s %s", (...args) => {
    expect(() => parseCliArgs(args)).toThrowError(
      expect.objectContaining({ code: "INVALID_COMMAND", exitCode: 2 }),
    );
  });
});

describe("parseTimeFilter", () => {
  it("parses inclusive after and exclusive before timestamps", () => {
    const filter = parseTimeFilter({
      after: "2026-07-01T00:00:00Z",
      before: "2026-07-02T00:00:00Z",
    });
    expect(filter).toEqual({
      after: new Date("2026-07-01T00:00:00.000Z"),
      before: new Date("2026-07-02T00:00:00.000Z"),
    });
  });

  it("turns recency into one fixed lower bound", () => {
    const filter = parseTimeFilter(
      { recency: "6h" },
      new Date("2026-07-10T12:00:00.000Z"),
    );
    expect(filter).toEqual({ after: new Date("2026-07-10T06:00:00.000Z") });
  });

  it("rejects conflicting interval filters", () => {
    expect(() =>
      parseTimeFilter({
        between: "2026-07-01T00:00:00Z..2026-07-02T00:00:00Z",
        after: "2026-07-01T12:00:00Z",
      }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_TIME_FILTER", exitCode: 2 }));
  });

  it("rejects non-ISO timestamp text", () => {
    expect(() => parseTimeFilter({ after: "July 1, 2026" })).toThrowError(
      expect.objectContaining({ code: "INVALID_TIME_FILTER", exitCode: 2 }),
    );
  });
});

describe("opaque cursors", () => {
  it("round-trips a resource-scoped keyset cursor", () => {
    const encoded = encodeCursor("messages", "2026-07-10T12:00:00.000Z", 123);
    expect(decodeCursor(encoded, "messages")).toEqual({
      timestamp: "2026-07-10T12:00:00.000Z",
      id: 123,
    });
    expect(() => decodeCursor(encoded, "summaries")).toThrowError(
      expect.objectContaining({ code: "INVALID_CURSOR", exitCode: 2 }),
    );
  });
});

describe("CLI response envelopes", () => {
  it("creates stable success and error shapes", () => {
    expect(createSuccessEnvelope("status", { conversations: 2 }, { databasePath: "/lcm.db" }))
      .toEqual({
        ok: true,
        command: "status",
        data: { conversations: 2 },
        meta: { databasePath: "/lcm.db" },
      });

    const error = new CliError("DATABASE_NOT_FOUND", "LCM database not found.", 3, {
      databasePath: "/missing.db",
    });
    expect(createErrorEnvelope(error)).toEqual({
      ok: false,
      error: {
        code: "DATABASE_NOT_FOUND",
        message: "LCM database not found.",
        details: { databasePath: "/missing.db" },
      },
    });
  });
});

describe("openReadOnlyDatabase", () => {
  it("opens an existing database without allowing writes", () => {
    const directory = makeTempDirectory();
    const databasePath = join(directory, "lcm.db");
    const writable = new DatabaseSync(databasePath);
    writable.exec("CREATE TABLE example (value TEXT); INSERT INTO example VALUES ('stored')");
    writable.close();

    const readOnly = openReadOnlyDatabase(databasePath);
    expect(readOnly.prepare("SELECT value FROM example").get()).toEqual({ value: "stored" });
    expect(() => readOnly.exec("INSERT INTO example VALUES ('forbidden')")).toThrow(/readonly/i);
    readOnly.close();
  });

  it("does not create a missing database", () => {
    const databasePath = join(makeTempDirectory(), "missing", "lcm.db");
    expect(() => openReadOnlyDatabase(databasePath)).toThrowError(
      expect.objectContaining({ code: "DATABASE_NOT_FOUND", exitCode: 3 }),
    );
  });
});
