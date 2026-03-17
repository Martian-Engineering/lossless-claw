import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export function removeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = settings.hooks ?? {};
  settings.mcpServers = settings.mcpServers ?? {};

  const LC_COMMANDS = new Set(["lossless-claude compact", "lossless-claude restore"]);
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event].filter(
      (entry: any) => !(Array.isArray(entry.hooks) && entry.hooks.some((h: any) => LC_COMMANDS.has(h.command)))
    );
  }
  delete settings.mcpServers["lossless-claude"];
  return settings;
}

export interface TeardownDeps {
  spawnSync: (cmd: string, args: string[], opts?: any) => SpawnSyncReturns<string>;
  existsSync: (path: string) => boolean;
  rmSync: (path: string) => void;
}

const defaultDeps: TeardownDeps = { spawnSync: spawnSync as any, existsSync, rmSync };

export function teardownDaemonService(deps: TeardownDeps = defaultDeps): void {
  const platform = process.platform;

  if (platform === "darwin") {
    const plistPath = join(
      homedir(),
      "Library",
      "LaunchAgents",
      "com.lossless-claude.daemon.plist"
    );
    if (deps.existsSync(plistPath)) {
      console.log("Stopping daemon service (launchd)...");
      deps.spawnSync("launchctl", ["unload", plistPath], { stdio: "inherit" });
      deps.rmSync(plistPath);
      console.log(`Removed ${plistPath}`);
    } else {
      console.warn("Warning: launchd plist not found, skipping unload.");
    }
  } else if (platform === "linux") {
    const unitPath = join(
      homedir(),
      ".config",
      "systemd",
      "user",
      "lossless-claude.service"
    );
    console.log("Stopping daemon service (systemd)...");
    deps.spawnSync("systemctl", ["--user", "stop", "lossless-claude"], { stdio: "inherit" });
    deps.spawnSync("systemctl", ["--user", "disable", "lossless-claude"], { stdio: "inherit" });
    if (deps.existsSync(unitPath)) {
      deps.rmSync(unitPath);
      console.log(`Removed ${unitPath}`);
    } else {
      console.warn("Warning: systemd unit file not found, skipping removal.");
    }
    deps.spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
  } else {
    console.warn(`Warning: Unsupported platform "${platform}". Skipping daemon service teardown.`);
  }
}

export async function uninstall(): Promise<void> {
  // 1. Stop and remove the daemon service
  teardownDaemonService();

  // 2. Remove lossless-claude entries from ~/.claude/settings.json
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      writeFileSync(settingsPath, JSON.stringify(removeClaudeSettings(existing), null, 2));
      console.log(`Removed lossless-claude from ${settingsPath}`);
    } catch (err) {
      console.warn(`Warning: could not update ${settingsPath}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log("lossless-claude uninstalled.");
}
