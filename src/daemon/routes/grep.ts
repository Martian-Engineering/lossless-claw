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

export function createGrepHandler(_config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, scope, sessionId, since, cwd } = input;

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    if (!cwd) {
      sendJson(res, 200, { matches: [] });
      return;
    }

    try {
      const dbPath = projectDbPath(cwd);
      if (!existsSync(dbPath)) {
        sendJson(res, 200, { matches: [] });
        return;
      }
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const summStore = new SummaryStore(db);
      const engine = new RetrievalEngine(convStore, summStore);
      const result = await engine.grep({ query, scope: scope ?? "all", sessionId, since });
      db.close();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { matches: [] });
    }
  };
}
