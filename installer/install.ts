import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

const LC_HOOK_COMPACT_CMD = "lossless-claude compact";
const LC_HOOK_RESTORE_CMD = "lossless-claude restore";
const LC_MCP = { command: "lossless-claude", args: ["mcp"] };

function makeHookEntry(command: string): { matcher: string; hooks: { type: string; command: string }[] } {
  return { matcher: "", hooks: [{ type: "command", command }] };
}

function hasHookCommand(entries: any[], command: string): boolean {
  return entries.some((entry: any) =>
    Array.isArray(entry.hooks) && entry.hooks.some((h: any) => h.command === command)
  );
}

export function mergeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = settings.hooks ?? {};
  settings.mcpServers = settings.mcpServers ?? {};

  // Merge PreCompact
  settings.hooks.PreCompact = settings.hooks.PreCompact ?? [];
  if (!hasHookCommand(settings.hooks.PreCompact, LC_HOOK_COMPACT_CMD)) {
    settings.hooks.PreCompact.push(makeHookEntry(LC_HOOK_COMPACT_CMD));
  }

  // Merge SessionStart
  settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
  if (!hasHookCommand(settings.hooks.SessionStart, LC_HOOK_RESTORE_CMD)) {
    settings.hooks.SessionStart.push(makeHookEntry(LC_HOOK_RESTORE_CMD));
  }

  // Add MCP server
  settings.mcpServers["lossless-claude"] = LC_MCP;

  return settings;
}

export interface ServiceDeps {
  spawnSync: (cmd: string, args: string[], opts?: any) => SpawnSyncReturns<string>;
  readFileSync: (path: string, encoding: string) => string;
  writeFileSync: (path: string, data: string) => void;
  mkdirSync: (path: string, opts?: any) => void;
  existsSync: (path: string) => boolean;
}

const defaultDeps: ServiceDeps = { spawnSync: spawnSync as any, readFileSync, writeFileSync, mkdirSync, existsSync };

export function resolveBinaryPath(deps: Pick<ServiceDeps, "spawnSync" | "existsSync"> = defaultDeps): string {
  const result = deps.spawnSync("sh", ["-c", "command -v lossless-claude"], { encoding: "utf-8" });
  if (result.status === 0 && typeof result.stdout === "string" && result.stdout.trim()) {
    return result.stdout.trim();
  }

  const fallbacks = [
    join(homedir(), ".npm-global", "bin", "lossless-claude"),
    "/usr/local/bin/lossless-claude",
    "/opt/homebrew/bin/lossless-claude",
  ];
  for (const p of fallbacks) {
    if (deps.existsSync(p)) return p;
  }

  return "lossless-claude";
}

export function buildLaunchdPlist(binaryPath: string, logPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.lossless-claude.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${binaryPath}</string>
    <string>daemon</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

export function buildSystemdUnit(binaryPath: string): string {
  return `[Unit]
Description=lossless-claude daemon
After=network.target

[Service]
ExecStart=${binaryPath} daemon start
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

export function setupDaemonService(deps: ServiceDeps = defaultDeps): void {
  const platform = process.platform;
  const binaryPath = resolveBinaryPath(deps);

  if (platform === "darwin") {
    console.log("Setting up daemon service (launchd)...");

    const plistDir = join(homedir(), "Library", "LaunchAgents");
    const plistPath = join(plistDir, "com.lossless-claude.daemon.plist");
    const logPath = join(homedir(), ".lossless-claude", "daemon.log");

    deps.mkdirSync(plistDir, { recursive: true });
    deps.writeFileSync(plistPath, buildLaunchdPlist(binaryPath, logPath));

    // Unload first (idempotent — ignore errors if not loaded)
    deps.spawnSync("launchctl", ["unload", plistPath], { stdio: "inherit" });
    // Load and start
    const load = deps.spawnSync("launchctl", ["load", plistPath], { stdio: "inherit" });
    if (load.status !== 0) {
      console.warn(`Warning: launchctl load exited with status ${load.status}`);
    }

    console.log("Daemon service registered and started.");
  } else if (platform === "linux") {
    console.log("Setting up daemon service (systemd)...");

    const unitDir = join(homedir(), ".config", "systemd", "user");
    const unitPath = join(unitDir, "lossless-claude.service");

    deps.mkdirSync(unitDir, { recursive: true });
    deps.writeFileSync(unitPath, buildSystemdUnit(binaryPath));

    deps.spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    const enable = deps.spawnSync("systemctl", ["--user", "enable", "lossless-claude"], { stdio: "inherit" });
    if (enable.status !== 0) {
      console.warn(`Warning: systemctl enable exited with status ${enable.status}`);
    }
    const start = deps.spawnSync("systemctl", ["--user", "start", "lossless-claude"], { stdio: "inherit" });
    if (start.status !== 0) {
      console.warn(`Warning: systemctl start exited with status ${start.status}`);
    }

    console.log("Daemon service registered and started.");
  } else {
    console.warn(`Warning: Unsupported platform "${platform}". Skipping daemon service setup.`);
    console.log("Run: lossless-claude daemon start");
  }
}

export async function install(deps: ServiceDeps = defaultDeps): Promise<void> {
  // Step 0: infrastructure setup (backend, models, Qdrant, cipher.yml)
  const setupScript = join(dirname(fileURLToPath(import.meta.url)), "setup.sh");
  const setupResult = deps.spawnSync("bash", [setupScript], { stdio: "inherit", env: process.env });
  if (setupResult.status !== 0) {
    console.warn(`Warning: setup.sh exited with code ${setupResult.status} — continuing`);
  }

  const lcDir = join(homedir(), ".lossless-claude");
  deps.mkdirSync(lcDir, { recursive: true });

  // 1. Check cipher config
  const cipherConfig = join(homedir(), ".cipher", "cipher.yml");
  if (!deps.existsSync(cipherConfig)) {
    console.warn("Warning: ~/.cipher/cipher.yml not found — semantic search will be unavailable until setup completes");
  }

  // 2. Check ANTHROPIC_API_KEY
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn("Warning: ANTHROPIC_API_KEY is not set. The daemon will need it at runtime — export it in your shell profile.");
  }

  // 3. Create config.json if not present
  const configPath = join(lcDir, "config.json");
  if (!deps.existsSync(configPath)) {
    const { loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    // Never persist the API key to disk — the daemon reads it from env at runtime
    defaults.llm.apiKey = "";
    deps.writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    console.log(`Created ${configPath}`);
  }

  // 4. Merge ~/.claude/settings.json
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let existing: any = {};
  if (deps.existsSync(settingsPath)) {
    try { existing = JSON.parse(deps.readFileSync(settingsPath, "utf-8")); } catch {}
  }
  const merged = mergeClaudeSettings(existing);
  deps.mkdirSync(join(homedir(), ".claude"), { recursive: true });
  deps.writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  console.log(`Updated ${settingsPath}`);

  // 5. Set up and start the persistent daemon service
  setupDaemonService(deps);

  console.log(`\nlossless-claude installed successfully!`);
}

// Re-export rmSync so uninstall.ts can share the pattern
export { rmSync };
