import { describe, it, expect, vi, afterEach } from "vitest";
import { removeClaudeSettings, teardownDaemonService, type TeardownDeps } from "../../installer/uninstall.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0) {
  return vi.fn().mockReturnValue({ status, stdout: "", stderr: "", pid: 1, output: [], signal: null });
}

function makeDeps(existsResult = true, overrides: Partial<TeardownDeps> = {}): TeardownDeps & {
  spawnSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
  rmSync: ReturnType<typeof vi.fn>;
} {
  return {
    spawnSync: makeSpawn(),
    existsSync: vi.fn().mockReturnValue(existsResult),
    rmSync: vi.fn(),
    ...overrides,
  };
}

// ─── removeClaudeSettings ───────────────────────────────────────────────────

describe("removeClaudeSettings", () => {
  it("removes lossless-claude hooks and mcpServer", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          { matcher: "", hooks: [{ type: "command", command: "other" }] },
          { matcher: "", hooks: [{ type: "command", command: "lossless-claude compact" }] },
        ],
        SessionStart: [
          { matcher: "", hooks: [{ type: "command", command: "lossless-claude restore" }] },
        ],
      },
      mcpServers: { "lossless-claude": {}, "other": {} },
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].hooks[0].command).toBe("other");
    expect(r.hooks.SessionStart).toHaveLength(0);
    expect(r.mcpServers["lossless-claude"]).toBeUndefined();
    expect(r.mcpServers["other"]).toBeDefined();
  });

  it("removes entry when any sub-hook matches a lossless-claude command", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [
          {
            matcher: "",
            hooks: [
              { type: "command", command: "something-else" },
              { type: "command", command: "lossless-claude compact" },
            ],
          },
        ],
      },
      mcpServers: {},
    });
    expect(r.hooks.PreCompact).toHaveLength(0);
  });
});

// ─── teardownDaemonService ──────────────────────────────────────────────────

describe("teardownDaemonService", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("on macOS calls launchctl unload and removes plist when plist exists", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const deps = makeDeps(true);
    teardownDaemonService(deps);

    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes("launchctl unload"))).toBe(true);
    expect(deps.rmSync).toHaveBeenCalledWith(
      expect.stringContaining("com.lossless-claude.daemon.plist")
    );
  });

  it("on macOS warns when plist does not exist", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const deps = makeDeps(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("plist not found"));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(deps.rmSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("on Linux calls systemctl stop, disable, daemon-reload and removes unit file", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const deps = makeDeps(true);
    teardownDaemonService(deps);

    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes("systemctl --user stop lossless-claude"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("systemctl --user disable lossless-claude"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("systemctl --user daemon-reload"))).toBe(true);
    expect(deps.rmSync).toHaveBeenCalledWith(
      expect.stringContaining("lossless-claude.service")
    );
  });

  it("on Linux warns when unit file does not exist but still runs systemctl commands", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const deps = makeDeps(false);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unit file not found"));
    expect(deps.rmSync).not.toHaveBeenCalled();
    const cmds = deps.spawnSync.mock.calls.map((c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`);
    expect(cmds.some((c: string) => c.includes("systemctl --user stop lossless-claude"))).toBe(true);
    warnSpy.mockRestore();
  });

  it("on unsupported platform warns and skips", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const deps = makeDeps();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    teardownDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported platform"));
    expect(deps.spawnSync).not.toHaveBeenCalled();
    expect(deps.rmSync).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
