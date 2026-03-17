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

export function createRecentHandler(_config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { cwd, limit = 5 } = input;

    if (!cwd) {
      sendJson(res, 200, { summaries: [] });
      return;
    }

    try {
      const dbPath = projectDbPath(cwd);
      if (!existsSync(dbPath)) {
        sendJson(res, 200, { summaries: [] });
        return;
      }
      mkdirSync(dirname(dbPath), { recursive: true });
      const db = new DatabaseSync(dbPath);
      runLcmMigrations(db);
      const convStore = new ConversationStore(db);
      const rows = db.prepare(
        `SELECT s.summary_id, s.content, s.depth, s.token_count, s.created_at
         FROM summaries s
         ORDER BY s.created_at DESC LIMIT ?`
      ).all(limit) as Array<Record<string, unknown>>;
      db.close();
      sendJson(res, 200, { summaries: rows });
    } catch {
      sendJson(res, 200, { summaries: [] });
    }
  };
}
