import { describe, it, expect } from "vitest";
import { getMcpToolDefinitions } from "../../src/mcp/server.js";

describe("MCP tool definitions", () => {
  it("exposes exactly 4 tools", () => {
    const tools = getMcpToolDefinitions();
    expect(tools).toHaveLength(4);
    expect(tools.map((t: any) => t.name).sort()).toEqual(["lcm_describe", "lcm_expand", "lcm_grep", "lcm_search"]);
  });

  it("each tool has name, description, inputSchema", () => {
    for (const tool of getMcpToolDefinitions()) {
      expect(tool).toHaveProperty("name");
      expect(tool).toHaveProperty("description");
      expect(tool).toHaveProperty("inputSchema");
      expect(tool.inputSchema.type).toBe("object");
    }
  });

  it("lcm_grep description mentions conversation history", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_grep");
    expect(tool!.description).toContain("conversation history");
  });

  it("lcm_search description mentions episodic", () => {
    const tool = getMcpToolDefinitions().find((t: any) => t.name === "lcm_search");
    expect(tool!.description).toContain("episodic");
  });
});
