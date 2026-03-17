import type { DaemonConfig } from "../config.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { promoteSummary } from "../../promotion/promoter.js";

export function createStoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { text, tags = [], metadata = {} } = input;

    if (!text) {
      sendJson(res, 400, { error: "text is required" });
      return;
    }

    try {
      await promoteSummary({
        text,
        tags,
        projectId: metadata.projectId ?? "manual",
        projectPath: metadata.projectPath ?? "",
        depth: metadata.depth ?? 0,
        sessionId: metadata.sessionId ?? "manual",
        confidence: 1.0,
        collection: config.cipher.collection,
      });
      sendJson(res, 200, { stored: true });
    } catch (err) {
      sendJson(res, 500, { error: err instanceof Error ? err.message : "store failed" });
    }
  };
}
