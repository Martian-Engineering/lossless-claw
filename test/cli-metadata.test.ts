import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import plugin from "../cli-metadata.js";

describe("lossless-claw cli metadata entry", () => {
  it("registers the external restore command surface", async () => {
    const registerCli = vi.fn();
    const api = {
      id: "lossless-claw",
      name: "Lossless Context Management",
      registerCli,
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
      },
    } as unknown as OpenClawPluginApi;

    plugin.register(api);

    const register = registerCli.mock.calls[0]?.[0];
    const program = new Command();

    expect(registerCli).toHaveBeenCalledTimes(1);
    await register({
      program,
      config: {
        plugins: {
          entries: {
            "lossless-claw": {
              config: {
                dbPath: "/tmp/lossless-cli-metadata.db",
              },
            },
          },
        },
      },
      logger: api.logger,
      workspaceDir: "/tmp/openclaw",
    });

    const losslessCommand = program.commands.find((command) => command.name() === "lossless");
    const restoreCommand = losslessCommand?.commands.find((command) => command.name() === "restore");

    expect(losslessCommand?.description()).toContain("maintenance commands outside the running gateway");
    expect(restoreCommand?.description()).toContain("restore one safely with gateway orchestration");
  });
});
