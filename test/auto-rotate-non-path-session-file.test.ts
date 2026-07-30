/**
 * Auto-rotation must not warn-spam when the host passes an opaque
 * sessionFile locator instead of a transcript path.
 *
 * Live incident shape (OpenClaw with a SQLite-backed session store,
 * 2026-07-30): some maintenance paths pass the bare session key (e.g.
 * "agent:main:main" / "agent:main:main:heartbeat") or a
 * "sqlite:<agentId>:<sessionId>:<storePath>" marker as sessionFile. The
 * runtime auto-rotate guard stat()ed that value on every heartbeat, logging
 *   auto-rotate: phase=runtime action=warn reason=session-file-stat-failed
 *   error=ENOENT...
 * once per turn, forever, while the rotation guard silently did nothing.
 *
 * Policy under test: only the known opaque locator forms are skipped
 * (reason=session-file-not-rotatable) — the sqlite: marker prefix, and a
 * sessionFile equal to the session key or session id. Every other value,
 * absolute or relative, keeps the pre-existing behavior: stat,
 * below-threshold skip, and a warn when the stat genuinely fails.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanupEngineTestState,
  createEngineWithDeps,
  createEngineWithDepsOverrides,
  createSessionFilePath,
} from "./helpers.js";

afterEach(cleanupEngineTestState);

function createLogSpies() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

function loggedLines(mock: ReturnType<typeof vi.fn>): string[] {
  return mock.mock.calls.map((call) => String(call[0]));
}

describe("runtime auto-rotate with opaque sessionFile locators", () => {
  it("skips a bare session key without stat or warn", async () => {
    const log = createLogSpies();
    const engine = createEngineWithDepsOverrides({ log });

    await engine.maintain({
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionKey: "agent:main:main:heartbeat",
      sessionFile: "agent:main:main:heartbeat",
    });

    expect(
      loggedLines(log.warn).filter((line) => line.includes("session-file-stat-failed")),
    ).toEqual([]);
    const skips = loggedLines(log.info).filter(
      (line) =>
        line.includes("auto-rotate:") &&
        line.includes("action=skip") &&
        line.includes("reason=session-file-not-rotatable"),
    );
    expect(skips.length).toBe(1);
  });

  it("skips a bare session id without stat or warn", async () => {
    const log = createLogSpies();
    const engine = createEngineWithDepsOverrides({ log });

    await engine.maintain({
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionKey: "agent:main:main",
      sessionFile: "55555555-5555-4555-8555-555555555555",
    });

    expect(
      loggedLines(log.warn).filter((line) => line.includes("session-file-stat-failed")),
    ).toEqual([]);
    const skips = loggedLines(log.info).filter(
      (line) =>
        line.includes("auto-rotate:") &&
        line.includes("action=skip") &&
        line.includes("reason=session-file-not-rotatable"),
    );
    expect(skips.length).toBe(1);
  });

  it("skips a sqlite session-file marker without stat or warn", async () => {
    const log = createLogSpies();
    const engine = createEngineWithDepsOverrides({ log });

    await engine.maintain({
      sessionId: "22222222-2222-4222-8222-222222222222",
      sessionKey: "agent:main:main",
      sessionFile: "sqlite:main:22222222-2222-4222-8222-222222222222:/tmp/sessions.db",
    });

    expect(
      loggedLines(log.warn).filter((line) => line.includes("session-file-stat-failed")),
    ).toEqual([]);
    const skips = loggedLines(log.info).filter(
      (line) =>
        line.includes("auto-rotate:") &&
        line.includes("action=skip") &&
        line.includes("reason=session-file-not-rotatable"),
    );
    expect(skips.length).toBe(1);
  });

  it("still stats real absolute paths (below-threshold skip)", async () => {
    const log = createLogSpies();
    const engine = createEngineWithDepsOverrides({ log });
    const sessionFile = createSessionFilePath("small-session");
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session_info" })}\n`);

    await engine.maintain({
      sessionId: "33333333-3333-4333-8333-333333333333",
      sessionKey: "agent:main:telegram:direct:1",
      sessionFile,
    });

    const skips = loggedLines(log.info).filter(
      (line) =>
        line.includes("auto-rotate:") &&
        line.includes("action=skip") &&
        line.includes("reason=below-threshold"),
    );
    expect(skips.length).toBe(1);
  });

  it("still warns when a real absolute path fails to stat", async () => {
    const log = createLogSpies();
    const engine = createEngineWithDepsOverrides({ log });
    const missingFile = join(createSessionFilePath("missing-session"), "..", "does-not-exist.jsonl");

    await engine.maintain({
      sessionId: "44444444-4444-4444-8444-444444444444",
      sessionKey: "agent:main:telegram:direct:2",
      sessionFile: missingFile,
    });

    const warns = loggedLines(log.warn).filter(
      (line) =>
        line.includes("auto-rotate:") && line.includes("reason=session-file-stat-failed"),
    );
    expect(warns.length).toBe(1);
  });

  it("still stats relative paths that are not opaque locators (warn preserved)", async () => {
    const log = createLogSpies();
    const engine = createEngineWithDepsOverrides({ log });

    await engine.maintain({
      sessionId: "66666666-6666-4666-8666-666666666666",
      sessionKey: "agent:main:telegram:direct:3",
      sessionFile: "relative/does-not-exist.jsonl",
    });

    expect(
      loggedLines(log.info).filter((line) => line.includes("reason=session-file-not-rotatable")),
    ).toEqual([]);
    const warns = loggedLines(log.warn).filter(
      (line) =>
        line.includes("auto-rotate:") && line.includes("reason=session-file-stat-failed"),
    );
    expect(warns.length).toBe(1);
  });
});

describe("startup auto-rotate scan with opaque sessionFile locators", () => {
  it("quietly skips bare-key and sqlite-marker candidates", async () => {
    const log = createLogSpies();
    const listStartupSessionFileCandidates = vi.fn(async () => [
      {
        sessionId: "77777777-7777-4777-8777-777777777777",
        sessionKey: "agent:main:main",
        sessionFile: "agent:main:main",
      },
      {
        sessionId: "88888888-8888-4888-8888-888888888888",
        sessionKey: "agent:main:main:heartbeat",
        sessionFile: "sqlite:main:88888888-8888-4888-8888-888888888888:/tmp/sessions.db",
      },
    ]);
    const engine = createEngineWithDeps({}, { log, listStartupSessionFileCandidates });

    await engine.autoRotateManagedSessionFilesAtStartup();

    expect(
      loggedLines(log.warn).filter((line) => line.includes("auto-rotate:")),
    ).toEqual([]);
    const perCandidateLines = loggedLines(log.info).filter(
      (line) => line.includes("auto-rotate:") && line.includes("phase=startup") && !line.includes("action=summary"),
    );
    expect(perCandidateLines).toEqual([]);
    const summaryLine = loggedLines(log.info).find(
      (line) => line.includes("auto-rotate:") && line.includes("action=summary"),
    );
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toContain("scanned=2");
    expect(summaryLine).toContain("skipped=2");
    expect(summaryLine).toContain("warned=0");
    expect(summaryLine).toContain("rotated=0");
  });
});
