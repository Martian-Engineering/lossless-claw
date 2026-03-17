import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DaemonClient } from "../daemon/client.js";
import { lcmGrepTool } from "./tools/lcm-grep.js";
import { lcmExpandTool } from "./tools/lcm-expand.js";
import { lcmDescribeTool } from "./tools/lcm-describe.js";
import { lcmSearchTool } from "./tools/lcm-search.js";

const TOOLS = [lcmGrepTool, lcmExpandTool, lcmDescribeTool, lcmSearchTool];

const TOOL_ROUTES: Record<string, string> = {
  lcm_grep: "/grep",
  lcm_expand: "/expand",
  lcm_describe: "/describe",
  lcm_search: "/search",
};

export function getMcpToolDefinitions() { return TOOLS; }

export async function startMcpServer(): Promise<void> {
  const client = new DaemonClient("http://127.0.0.1:3737");
  const server = new Server({ name: "lossless-claude", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const route = TOOL_ROUTES[req.params.name];
    if (!route) throw new Error(`Unknown tool: ${req.params.name}`);
    const result = await client.post(route, { ...req.params.arguments, cwd: process.env.PWD ?? process.cwd() });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
