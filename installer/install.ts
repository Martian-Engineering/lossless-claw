import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const LC_HOOK_COMPACT = { type: "command", command: "lossless-claude compact" };
const LC_HOOK_RESTORE = { type: "command", command: "lossless-claude restore" };
const LC_MCP = { command: "lossless-claude", args: ["mcp"] };

export function mergeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = settings.hooks ?? {};
  settings.mcpServers = settings.mcpServers ?? {};

  // Merge PreCompact
  settings.hooks.PreCompact = settings.hooks.PreCompact ?? [];
  if (!settings.hooks.PreCompact.some((h: any) => h.command === LC_HOOK_COMPACT.command)) {
    settings.hooks.PreCompact.push(LC_HOOK_COMPACT);
  }

  // Merge SessionStart
  settings.hooks.SessionStart = settings.hooks.SessionStart ?? [];
  if (!settings.hooks.SessionStart.some((h: any) => h.command === LC_HOOK_RESTORE.command)) {
    settings.hooks.SessionStart.push(LC_HOOK_RESTORE);
  }

  // Add MCP server
  settings.mcpServers["lossless-claude"] = LC_MCP;

  return settings;
}

export async function install(): Promise<void> {
  const lcDir = join(homedir(), ".lossless-claude");
  mkdirSync(lcDir, { recursive: true });

  // 1. Check cipher config
  const cipherConfig = join(homedir(), ".cipher", "cipher.yml");
  if (!existsSync(cipherConfig)) {
    console.error(`ERROR: ~/.cipher/cipher.yml not found. Install Cipher first.`);
    process.exit(1);
  }

  // 2. Check ANTHROPIC_API_KEY
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(`ERROR: ANTHROPIC_API_KEY environment variable is not set.`);
    process.exit(1);
  }

  // 3. Create config.json if not present
  const configPath = join(lcDir, "config.json");
  if (!existsSync(configPath)) {
    const { loadDaemonConfig } = await import("../src/daemon/config.js");
    const defaults = loadDaemonConfig("/nonexistent");
    writeFileSync(configPath, JSON.stringify(defaults, null, 2));
    console.log(`Created ${configPath}`);
  }

  // 4. Merge ~/.claude/settings.json
  const settingsPath = join(homedir(), ".claude", "settings.json");
  let existing: any = {};
  if (existsSync(settingsPath)) {
    try { existing = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
  }
  const merged = mergeClaudeSettings(existing);
  mkdirSync(join(homedir(), ".claude"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(merged, null, 2));
  console.log(`Updated ${settingsPath}`);

  console.log(`\nlossless-claude installed successfully!`);
  console.log(`Run: lossless-claude daemon start`);
}
