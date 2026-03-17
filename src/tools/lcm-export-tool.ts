import { Type } from "@sinclair/typebox";
import type { LcmDependencies } from "../types.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult } from "./common.js";
import { exportConversations, type ExportOptions } from "../export.js";

const LcmExportSchema = Type.Object({
  outputDir: Type.String({
    description: "Output directory for exported files (default: ./exports)",
    default: "./exports",
  }),
  peerId: Type.Optional(
    Type.String({
      description: "Filter by peer ID (e.g., user:ou_xxx, chat:xxx)",
    })
  ),
  chatType: Type.Optional(
    Type.String({
      description: "Filter by chat type: dm or group",
      enum: ["dm", "group"],
    })
  ),
  from: Type.Optional(
    Type.String({
      description: "Export messages from this date (ISO format: YYYY-MM-DD)",
    })
  ),
  to: Type.Optional(
    Type.String({
      description: "Export messages until this date (ISO format: YYYY-MM-DD)",
    })
  ),
});

export function createLcmExportTool(input: { deps: LcmDependencies }): AnyAgentTool {
  return {
    name: "lcm_export",
    label: "LCM Export",
    description:
      "Export conversations to markdown files organized by peer and date. " +
      "Creates files in dm/{peer}/YYYY-MM/YYYY-MM-DD.md and group/{name}/YYYY-MM/YYYY-MM-DD.md format. " +
      "Each message line format: [channel] time name: message",
    parameters: LcmExportSchema,
    async execute(args: Record<string, unknown>): Promise<string> {
      const db = input.deps.db;
      if (!db) {
        return jsonResult({ success: false, error: "LCM database not available" });
      }

      const options: ExportOptions = {
        outputDir: String(args.outputDir || "./exports"),
        peerId: args.peerId ? String(args.peerId) : undefined,
        chatType: args.chatType as "dm" | "group" | undefined,
        from: args.from ? new Date(String(args.from)) : undefined,
        to: args.to ? new Date(String(args.to)) : undefined,
      };

      try {
        const result = exportConversations(db, options);
        return jsonResult({
          success: true,
          messagesExported: result.messagesExported,
          filesWritten: result.filesWritten,
          outputDir: result.outputDir,
        });
      } catch (error) {
        return jsonResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
