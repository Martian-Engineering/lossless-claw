import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

describe("package OpenClaw compatibility metadata", () => {
  it("declares the memory supplement context-engine minimum OpenClaw version without an upper bound", () => {
    expect(packageJson.peerDependencies.openclaw).toBe(">=2026.5.28");
    expect(packageJson.openclaw.compat.pluginApi).toBe(">=2026.5.28");
    expect(packageJson.openclaw.compat.minGatewayVersion).toBe("2026.5.28");
    expect(packageJson.openclaw.compat.tested).toEqual(["2026.5.28"]);
    expect(packageJson.openclaw.build.openclawVersion).toBe("2026.5.28");
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
