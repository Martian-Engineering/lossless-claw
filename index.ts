/**
 * @martian-engineering/open-lcm — Lossless Context Management plugin for OpenClaw
 *
 * DAG-based conversation summarization with incremental compaction,
 * full-text search, and sub-agent expansion.
 */
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { resolveLcmConfig } from "./src/db/config.js";

const lcmPlugin = {
  id: "lcm",
  name: "Lossless Context Management",
  description:
    "DAG-based conversation summarization with incremental compaction, full-text search, and sub-agent expansion",

  configSchema: {
    parse(value: unknown) {
      // Merge plugin config with env vars — env vars take precedence for backward compat
      const raw =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {};
      const enabled = typeof raw.enabled === "boolean" ? raw.enabled : undefined;
      const config = resolveLcmConfig(process.env);
      if (enabled !== undefined) {
        config.enabled = enabled;
      }
      return config;
    },
  },

  register(api: OpenClawPluginApi) {
    const config = resolveLcmConfig(process.env);

    // TODO: Wire up LcmDependencies from api and register context engine
    // api.registerContextEngine("lcm", () => createLcmContextEngine(deps));

    // TODO: Register tools
    // api.registerTool(createLcmGrepTool(deps));
    // api.registerTool(createLcmDescribeTool(deps));
    // api.registerTool(createLcmExpandTool(deps));
    // api.registerTool(createLcmExpandQueryTool(deps));

    api.logger.info(
      `[lcm] Plugin loaded (enabled=${config.enabled}, db=${config.databasePath}, threshold=${config.contextThreshold})`,
    );
  },
};

export default lcmPlugin;
