import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function removeClaudeSettings(existing: any): any {
  const settings = JSON.parse(JSON.stringify(existing));
  settings.hooks = settings.hooks ?? {};
  settings.mcpServers = settings.mcpServers ?? {};

  const LC_COMMANDS = new Set(["lossless-claude compact", "lossless-claude restore"]);
  for (const event of Object.keys(settings.hooks)) {
    settings.hooks[event] = settings.hooks[event].filter((h: any) => !LC_COMMANDS.has(h.command));
  }
  delete settings.mcpServers["lossless-claude"];
  return settings;
}

export async function uninstall(): Promise<void> {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (existsSync(settingsPath)) {
    try {
      const existing = JSON.parse(readFileSync(settingsPath, "utf-8"));
      writeFileSync(settingsPath, JSON.stringify(removeClaudeSettings(existing), null, 2));
      console.log(`Removed lossless-claude from ${settingsPath}`);
    } catch {}
  }
  console.log("lossless-claude uninstalled.");
}
