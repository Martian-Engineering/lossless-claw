import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const requiredOpenClawVersion = "2026.7.2-beta.2";

describe("package OpenClaw compatibility metadata", () => {
  it("declares the SQLite transcript runtime minimum OpenClaw version without an upper bound", () => {
    expect(packageJson.peerDependencies.openclaw).toBe(`>=${requiredOpenClawVersion}`);
    expect(packageJson.openclaw.compat.pluginApi).toBe(`>=${requiredOpenClawVersion}`);
    expect(packageJson.openclaw.compat.minGatewayVersion).toBe(requiredOpenClawVersion);
    expect(packageJson.openclaw.compat.tested).toEqual([requiredOpenClawVersion]);
    expect(packageJson.openclaw.build.openclawVersion).toBe(requiredOpenClawVersion);
  });

  it("documents the same SQLite transcript runtime minimum in user-facing docs", () => {
    const readProjectFile = (path: string) =>
      readFileSync(join(process.cwd(), path), "utf8");

    expect(readProjectFile("README.md")).toContain(
      `requires OpenClaw \`${requiredOpenClawVersion}\` or newer`,
    );
    expect(readProjectFile("docs/configuration.md")).toContain(
      `requires OpenClaw \`${requiredOpenClawVersion}\` or newer`,
    );
    expect(readProjectFile("docs/architecture.md")).toContain(
      "host-provided visible transcript projection",
    );
    expect(readProjectFile("docs/tui.md")).toContain("Shows runtime sessions");
  });

  it("publishes the TypeScript lcm executable", () => {
    expect(packageJson.bin).toEqual({
      lcm: "dist/cli.js",
      "lossless-claw-migrate-sessions": "dist/migrate-sessions.js",
    });
    expect(packageJson.scripts.build).toContain("build:cli");
    expect(packageJson.scripts.build).toContain("build:migrate-sessions");
  });
});
