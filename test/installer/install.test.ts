import { describe, it, expect, vi, afterEach } from "vitest";
import {
  mergeClaudeSettings,
  resolveBinaryPath,
  buildLaunchdPlist,
  buildSystemdUnit,
  setupDaemonService,
  install,
  type ServiceDeps,
} from "../../installer/install.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── helpers ────────────────────────────────────────────────────────────────

function makeSpawn(status = 0, stdout = "") {
  return vi.fn().mockReturnValue({ status, stdout, stderr: "", pid: 1, output: [], signal: null });
}

function makeDeps(overrides: Partial<ServiceDeps> = {}): ServiceDeps & {
  spawnSync: ReturnType<typeof vi.fn>;
  readFileSync: ReturnType<typeof vi.fn>;
  writeFileSync: ReturnType<typeof vi.fn>;
  mkdirSync: ReturnType<typeof vi.fn>;
  existsSync: ReturnType<typeof vi.fn>;
} {
  return {
    spawnSync: makeSpawn(),
    readFileSync: vi.fn().mockReturnValue("{}"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    existsSync: vi.fn().mockReturnValue(false),
    ...overrides,
  };
}

// ─── mergeClaudeSettings ────────────────────────────────────────────────────

describe("mergeClaudeSettings", () => {
  it("adds hooks and mcpServers to empty settings", () => {
    const r = mergeClaudeSettings({});
    expect(r.hooks.PreCompact[0].command).toBe("lossless-claude compact");
    expect(r.hooks.SessionStart[0].command).toBe("lossless-claude restore");
    expect(r.mcpServers["lossless-claude"]).toBeDefined();
  });

  it("preserves existing hooks", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ type: "command", command: "other" }] } });
    expect(r.hooks.PreCompact).toHaveLength(2);
    expect(r.hooks.PreCompact[0].command).toBe("other");
  });

  it("does not duplicate if already present", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ type: "command", command: "lossless-claude compact" }] } });
    expect(r.hooks.PreCompact).toHaveLength(1);
  });
});

// ─── resolveBinaryPath ──────────────────────────────────────────────────────

describe("resolveBinaryPath", () => {
  it("returns path from which when available", () => {
    const deps = {
      spawnSync: makeSpawn(0, "/usr/local/bin/lossless-claude\n"),
      existsSync: vi.fn().mockReturnValue(false),
    };
    expect(resolveBinaryPath(deps)).toBe("/usr/local/bin/lossless-claude");
  });

  it("falls back to ~/.npm-global/bin when which fails", () => {
    const npmGlobal = join(homedir(), ".npm-global", "bin", "lossless-claude");
    const deps = {
      spawnSync: makeSpawn(1, ""),
      existsSync: vi.fn().mockImplementation((p: string) => p === npmGlobal),
    };
    expect(resolveBinaryPath(deps)).toBe(npmGlobal);
  });

  it("returns bare binary name when nothing found", () => {
    const deps = {
      spawnSync: makeSpawn(1, ""),
      existsSync: vi.fn().mockReturnValue(false),
    };
    expect(resolveBinaryPath(deps)).toBe("lossless-claude");
  });
});

// ─── buildLaunchdPlist ──────────────────────────────────────────────────────

describe("buildLaunchdPlist", () => {
  it("includes binary path and log path", () => {
    const plist = buildLaunchdPlist("/usr/local/bin/lossless-claude", "/home/user/.lossless-claude/daemon.log");
    expect(plist).toContain("<string>/usr/local/bin/lossless-claude</string>");
    expect(plist).toContain("<string>/home/user/.lossless-claude/daemon.log</string>");
    expect(plist).toContain("<string>com.lossless-claude.daemon</string>");
    expect(plist).toContain("<string>daemon</string>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("<true/>");
  });
});

// ─── buildSystemdUnit ───────────────────────────────────────────────────────

describe("buildSystemdUnit", () => {
  it("includes binary path", () => {
    const unit = buildSystemdUnit("/usr/local/bin/lossless-claude");
    expect(unit).toContain("ExecStart=/usr/local/bin/lossless-claude daemon start");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
  });
});

// ─── setupDaemonService ─────────────────────────────────────────────────────

describe("setupDaemonService", () => {
  const originalPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, "platform", { value: originalPlatform, writable: true });
  });

  it("on macOS writes plist and calls launchctl unload+load", () => {
    Object.defineProperty(process, "platform", { value: "darwin", writable: true });
    const deps = makeDeps();
    setupDaemonService(deps);

    expect(deps.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("com.lossless-claude.daemon.plist"),
      expect.stringContaining("com.lossless-claude.daemon")
    );
    const cmds = (deps.spawnSync as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`
    );
    expect(cmds.some((c: string) => c.includes("launchctl unload"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("launchctl load"))).toBe(true);
  });

  it("on Linux writes unit file and calls systemctl enable+start", () => {
    Object.defineProperty(process, "platform", { value: "linux", writable: true });
    const deps = makeDeps();
    setupDaemonService(deps);

    expect(deps.writeFileSync).toHaveBeenCalledWith(
      expect.stringContaining("lossless-claude.service"),
      expect.stringContaining("ExecStart=")
    );
    const cmds = (deps.spawnSync as ReturnType<typeof vi.fn>).mock.calls.map(
      (c: any[]) => `${c[0]} ${(c[1] as string[]).join(" ")}`
    );
    expect(cmds.some((c: string) => c.includes("systemctl --user daemon-reload"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("systemctl --user enable lossless-claude"))).toBe(true);
    expect(cmds.some((c: string) => c.includes("systemctl --user start lossless-claude"))).toBe(true);
  });

  it("on unsupported platform warns and skips service writes and service commands", () => {
    Object.defineProperty(process, "platform", { value: "win32", writable: true });
    const deps = makeDeps();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    setupDaemonService(deps);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported platform"));
    expect(deps.writeFileSync).not.toHaveBeenCalled();
    // No launchctl or systemctl calls (only 'which' may be called for binary resolution)
    const serviceCmds = (deps.spawnSync as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: any[]) => c[0] === "launchctl" || c[0] === "systemctl"
    );
    expect(serviceCmds).toHaveLength(0);
    warnSpy.mockRestore();
  });
});

// ─── install ────────────────────────────────────────────────────────────────

describe("install", () => {
  it("accepts deps parameter and warns when cipher.yml is missing", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const deps = makeDeps({ existsSync: vi.fn().mockReturnValue(false) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(install(deps)).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("cipher.yml"));
    warnSpy.mockRestore();
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("invokes setup.sh as step 0 before other steps", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const spawnMock = makeSpawn(0);
    const deps = makeDeps({ spawnSync: spawnMock, existsSync: vi.fn().mockReturnValue(false) });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await install(deps);
    const firstCall = spawnMock.mock.calls[0];
    expect(firstCall[0]).toBe("bash");
    expect(firstCall[1][0]).toContain("setup.sh");
    warnSpy.mockRestore();
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });

  it("continues when setup.sh exits non-zero", async () => {
    const originalApiKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "test-key";
    const deps = makeDeps({
      spawnSync: makeSpawn(1),
      existsSync: vi.fn().mockReturnValue(false),
    });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(install(deps)).resolves.not.toThrow();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("setup.sh"));
    warnSpy.mockRestore();
    process.env.ANTHROPIC_API_KEY = originalApiKey;
  });
});
