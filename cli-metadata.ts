import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { resolveLcmConfigWithDiagnostics } from "./src/db/config.js";
import { registerLcmCli } from "./src/plugin/lcm-cli.js";

export default definePluginEntry({
  id: "lossless-claw",
  name: "Lossless Context Management",
  description:
    "DAG-based conversation summarization with incremental compaction, full-text search, and sub-agent expansion",
  register(api) {
    api.registerCli(
      ({ program, config, logger }) => {
        const pluginConfig = config.plugins?.entries?.["lossless-claw"]?.config ?? {};
        registerLcmCli({
          program,
          config: resolveLcmConfigWithDiagnostics(process.env, pluginConfig).config,
          logger,
        });
      },
      {
        descriptors: [
          {
            name: "lossless",
            description: "Operate Lossless Claw maintenance commands outside the running gateway",
            hasSubcommands: true,
          },
        ],
      },
    );
  },
});
