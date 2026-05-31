import { describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };

describe("package OpenClaw compatibility metadata", () => {
  it("declares the context-engine host requirements minimum OpenClaw version without an upper bound", () => {
    expect(packageJson.peerDependencies.openclaw).toBe(">=2026.5.22");
    expect(packageJson.openclaw.compat.pluginApi).toBe(">=2026.5.22");
    expect(packageJson.openclaw.compat.minGatewayVersion).toBe("2026.5.22");
    expect(packageJson.openclaw.compat.tested).toEqual(["2026.5.22"]);
    expect(packageJson.openclaw.build.openclawVersion).toBe("2026.5.22");
  });
});
