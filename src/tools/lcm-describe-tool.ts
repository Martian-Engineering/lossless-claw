import { Type } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import type { LcmContextEngine } from "../../plugins/lcm/engine.js";
import type { AnyAgentTool } from "./common.js";
import { ensureContextEnginesInitialized } from "../../context-engine/init.js";
import { resolveContextEngine } from "../../context-engine/registry.js";
import { jsonResult } from "./common.js";
import { resolveLcmConversationScope } from "./lcm-conversation-scope.js";

const LcmDescribeSchema = Type.Object({
  id: Type.String({
    description: "The LCM ID to look up. Use sum_xxx for summaries, file_xxx for files.",
  }),
  conversationId: Type.Optional(
    Type.Number({
      description:
        "Conversation ID to scope describe lookups to. If omitted, uses the current session conversation.",
    }),
  ),
  allConversations: Type.Optional(
    Type.Boolean({
      description:
        "Set true to explicitly allow lookups across all conversations. Ignored when conversationId is provided.",
    }),
  ),
});

export function createLcmDescribeTool(options?: {
  config?: OpenClawConfig;
  sessionId?: string;
}): AnyAgentTool {
  return {
    name: "lcm_describe",
    label: "LCM Describe",
    description:
      "Look up metadata and content for an LCM item by ID. " +
      "Use this to inspect summaries (sum_xxx) or stored files (file_xxx) " +
      "from compacted conversation history. Returns summary content, lineage, " +
      "token counts, and file exploration results.",
    parameters: LcmDescribeSchema,
    async execute(_toolCallId, params) {
      ensureContextEnginesInitialized();
      const engine = await resolveContextEngine(options?.config);

      if (engine.info.id !== "lcm") {
        return jsonResult({
          error: "lcm_describe requires the LCM context engine to be active.",
        });
      }

      const lcm = engine as LcmContextEngine;
      const retrieval = lcm.getRetrieval();
      const p = params as Record<string, unknown>;
      const id = (p.id as string).trim();
      const conversationScope = await resolveLcmConversationScope({
        lcm,
        sessionId: options?.sessionId,
        params: p,
      });
      if (!conversationScope.allConversations && conversationScope.conversationId == null) {
        return jsonResult({
          error:
            "No LCM conversation found for this session. Provide conversationId or set allConversations=true.",
        });
      }

      const result = await retrieval.describe(id);

      if (!result) {
        return jsonResult({
          error: `Not found: ${id}`,
          hint: "Check the ID format (sum_xxx for summaries, file_xxx for files).",
        });
      }
      if (conversationScope.conversationId != null) {
        const itemConversationId =
          result.type === "summary" ? result.summary?.conversationId : result.file?.conversationId;
        if (itemConversationId != null && itemConversationId !== conversationScope.conversationId) {
          return jsonResult({
            error: `Not found in conversation ${conversationScope.conversationId}: ${id}`,
            hint: "Use allConversations=true for cross-conversation lookup.",
          });
        }
      }

      if (result.type === "summary" && result.summary) {
        const s = result.summary;
        const lines: string[] = [];
        lines.push(`## LCM Summary: ${id}`);
        lines.push("");
        lines.push(`**Conversation:** ${s.conversationId}`);
        lines.push(`**Kind:** ${s.kind}`);
        lines.push(`**Tokens:** ~${s.tokenCount.toLocaleString()}`);
        lines.push(`**Created:** ${s.createdAt.toISOString()}`);
        if (s.parentIds.length > 0) {
          lines.push(`**Parents:** ${s.parentIds.join(", ")}`);
        }
        if (s.childIds.length > 0) {
          lines.push(`**Children:** ${s.childIds.join(", ")}`);
        }
        if (s.messageIds.length > 0) {
          lines.push(`**Messages:** ${s.messageIds.length} linked`);
        }
        if (s.fileIds.length > 0) {
          lines.push(`**Files:** ${s.fileIds.join(", ")}`);
        }
        lines.push("");
        lines.push("## Content");
        lines.push("");
        lines.push(s.content);

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      }

      if (result.type === "file" && result.file) {
        const f = result.file;
        const lines: string[] = [];
        lines.push(`## LCM File: ${id}`);
        lines.push("");
        lines.push(`**Conversation:** ${f.conversationId}`);
        lines.push(`**Name:** ${f.fileName ?? "(no name)"}`);
        lines.push(`**Type:** ${f.mimeType ?? "unknown"}`);
        if (f.byteSize != null) {
          lines.push(`**Size:** ${f.byteSize.toLocaleString()} bytes`);
        }
        lines.push(`**Created:** ${f.createdAt.toISOString()}`);
        if (f.explorationSummary) {
          lines.push("");
          lines.push("## Exploration Summary");
          lines.push("");
          lines.push(f.explorationSummary);
        } else {
          lines.push("");
          lines.push("*No exploration summary available.*");
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: result,
        };
      }

      return jsonResult(result);
    },
  };
}
