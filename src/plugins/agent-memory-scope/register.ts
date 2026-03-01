import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import type { LcmContextEngine } from "../../engine.js";

/**
 * Register the alias context engine id used by the OpenClaw integration branch.
 */
export function registerAgentMemoryScopeContextEngine(api: OpenClawPluginApi, lcm: LcmContextEngine): void {
  api.registerContextEngine("agent-memory-scope", () => lcm);
}
