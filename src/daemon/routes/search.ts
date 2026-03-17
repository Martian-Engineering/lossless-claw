import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectDbPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { RetrievalEngine } from "../../retrieval.js";

export function createSearchHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { query, limit = 5, layers, cwd } = input;
    const activeLayers: string[] = layers ?? ["episodic", "semantic"];

    if (!query) {
      sendJson(res, 400, { error: "query is required" });
      return;
    }

    let episodic: unknown[] = [];
    let semantic: unknown[] = [];

    // Episodic: FTS5 search from SQLite
    if (activeLayers.includes("episodic") && cwd) {
      try {
        const dbPath = projectDbPath(cwd);
        if (existsSync(dbPath)) {
          mkdirSync(dirname(dbPath), { recursive: true });
          const db = new DatabaseSync(dbPath);
          runLcmMigrations(db);
          const convStore = new ConversationStore(db);
          const summStore = new SummaryStore(db);
          const engine = new RetrievalEngine(convStore, summStore);
          const result = await engine.grep({ query, scope: "all" });
          episodic = result.matches.slice(0, limit);
          db.close();
        }
      } catch { /* non-fatal */ }
    }

    // Semantic: Qdrant search
    if (activeLayers.includes("semantic")) {
      try {
        const require = createRequire(import.meta.url);
        const store = require(join(homedir(), ".local", "lib", "qdrant-store.js"));
        const results = await store.search(query, config.cipher.collection, limit, config.restoration.semanticThreshold);
        semantic = results;
      } catch { /* non-fatal — Qdrant may not be running */ }
    }

    sendJson(res, 200, { episodic, semantic });
  };
}
