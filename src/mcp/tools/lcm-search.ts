export const lcmSearchTool = {
  name: "lcm_search",
  description: "Hybrid search across both episodic memory (SQLite FTS5) and semantic memory (Qdrant). Returns two separate ranked lists — episodic and semantic. Use when looking for project knowledge spanning multiple sessions.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Natural language search query" },
      limit: { type: "number", description: "Max results per layer (default: 5)" },
      layers: { type: "array", items: { type: "string", enum: ["episodic", "semantic"] }, description: "Which memory layers to search (default: both)" },
    },
    required: ["query"],
  },
};
