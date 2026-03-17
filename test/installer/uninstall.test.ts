import { describe, it, expect } from "vitest";
import { removeClaudeSettings } from "../../installer/uninstall.js";

describe("removeClaudeSettings", () => {
  it("removes lossless-claude hooks and mcpServer", () => {
    const r = removeClaudeSettings({
      hooks: {
        PreCompact: [{ type: "command", command: "other" }, { type: "command", command: "lossless-claude compact" }],
        SessionStart: [{ type: "command", command: "lossless-claude restore" }],
      },
      mcpServers: { "lossless-claude": {}, "other": {} },
    });
    expect(r.hooks.PreCompact).toHaveLength(1);
    expect(r.hooks.PreCompact[0].command).toBe("other");
    expect(r.hooks.SessionStart).toHaveLength(0);
    expect(r.mcpServers["lossless-claude"]).toBeUndefined();
    expect(r.mcpServers["other"]).toBeDefined();
  });
});
