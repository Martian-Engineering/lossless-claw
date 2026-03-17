import { describe, it, expect } from "vitest";
import { mergeClaudeSettings } from "../../installer/install.js";

describe("mergeClaudeSettings", () => {
  it("adds hooks and mcpServers to empty settings", () => {
    const r = mergeClaudeSettings({});
    expect(r.hooks.PreCompact[0].command).toBe("lossless-claude compact");
    expect(r.hooks.SessionStart[0].command).toBe("lossless-claude restore");
    expect(r.mcpServers["lossless-claude"]).toBeDefined();
  });

  it("preserves existing hooks", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ type: "command", command: "other" }] } });
    expect(r.hooks.PreCompact).toHaveLength(2);
    expect(r.hooks.PreCompact[0].command).toBe("other");
  });

  it("does not duplicate if already present", () => {
    const r = mergeClaudeSettings({ hooks: { PreCompact: [{ type: "command", command: "lossless-claude compact" }] } });
    expect(r.hooks.PreCompact).toHaveLength(1);
  });
});
