import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { RetrievalEngine } from "../../retrieval.js";

export function createDescribeHandler(_config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { nodeId, cwd } = input;

    if (!nodeId) {
      sendJson(res, 400, { error: "nodeId is required" });
      return;
    }

    if (!cwd || !existsSync(projectDbPath(cwd))) {
      sendJson(res, 200, { node: null });
      return;
    }

    try {
      const dbPath = projectDbPath(cwd);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const engine = new RetrievalEngine(convStore, summStore);
      const result = await engine.describe(nodeId);
      db.close();
      sendJson(res, 200, { node: result });
    } catch (err) {
      sendJson(res, 200, { node: null, error: err instanceof Error ? err.message : "describe failed" });
    }
  };
}
