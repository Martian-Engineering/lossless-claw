export const lcmGrepTool = {
  name: "lcm_grep",
  description: "Search conversation history by keyword or regex across raw messages and summaries. Use when recalling what was said, decided, or done in a past session.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: { type: "string", description: "Keyword, phrase, or regex to search" },
      scope: { type: "string", enum: ["messages", "summaries", "all"], default: "all" },
      sessionId: { type: "string", description: "Filter to a specific session" },
      since: { type: "string", description: "ISO datetime lower bound" },
    },
    required: ["query"],
  },
};
