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
import { ExpansionOrchestrator } from "../../expansion.js";

export function createExpandHandler(_config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { nodeId, depth = 1, cwd } = input;

    if (!nodeId) {
      sendJson(res, 400, { error: "nodeId is required" });
      return;
    }

    if (!cwd || !existsSync(projectDbPath(cwd))) {
      sendJson(res, 200, { expanded: null, error: "project not found" });
      return;
    }

    try {
      const dbPath = projectDbPath(cwd);
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const retrieval = new RetrievalEngine(convStore, summStore);
      const orchestrator = new ExpansionOrchestrator(retrieval);
      const result = await orchestrator.expand({ summaryIds: [nodeId], depth });
      db.close();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { expanded: null, error: err instanceof Error ? err.message : "expansion failed" });
    }
  };
}
