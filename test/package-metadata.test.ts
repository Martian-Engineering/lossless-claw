import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import packageJson from "../package.json" with { type: "json" };

const requiredOpenClawVersion = "2026.9.2";
const groupedSettingsOpenClawVersion = "2026.9.5";

describe("package OpenClaw compatibility metadata", () => {
  it("declares the native session-panel minimum OpenClaw version without an upper bound", () => {
    expect(packageJson.peerDependencies.openclaw).toBe(`>=${requiredOpenClawVersion}`);
    expect(packageJson.openclaw.compat.pluginApi).toBe(`>=${requiredOpenClawVersion}`);
    expect(packageJson.openclaw.compat.minGatewayVersion).toBe(requiredOpenClawVersion);
    expect(packageJson.openclaw.compat.tested).toEqual([
      "2026.9.4",
      groupedSettingsOpenClawVersion,
    ]);
    expect(packageJson.peerDependenciesMeta.openclaw.optional).toBe(true);
    expect(packageJson.openclaw.build.openclawVersion).toBe("2026.9.4");
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

  it("documents grouped settings as optional without raising the runtime minimum", () => {
    for (const path of ["docs/configuration.md", "skills/lossless-claw/references/config.md"]) {
      const content = readFileSync(join(process.cwd(), path), "utf8");
      expect(content).toContain(
        `Grouped settings require OpenClaw \`${groupedSettingsOpenClawVersion}\` or newer`,
      );
      expect(content).toContain("flat settings form");
      expect(content).toContain(`\`${requiredOpenClawVersion}\``);
    }
  });

  it("keeps 1.0 package commands on the npm stable channel", () => {
    const stableChannelDocuments = [
      "README.md",
      "docs/configuration.md",
      "skills/lossless-claw/references/session-lifecycle.md",
    ];

    for (const path of stableChannelDocuments) {
      const content = readFileSync(join(process.cwd(), path), "utf8");
      expect(content).toContain("@martian-engineering/lossless-claw@latest");
      expect(content).not.toContain("@martian-engineering/lossless-claw@beta");
    }
  });

  it("documents the OpenClaw conversation-hook trust grant", () => {
    const readProjectFile = (path: string) =>
      readFileSync(join(process.cwd(), path), "utf8");

    for (const path of [
      "README.md",
      "docs/configuration.md",
      "skills/lossless-claw/references/config.md",
    ]) {
      expect(readProjectFile(path)).toContain('"allowConversationAccess": true');
    }
    expect(readProjectFile("README.md")).toContain("before_prompt_build");
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
