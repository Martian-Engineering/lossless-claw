import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectId, projectDbPath } from "../project.js";
import { buildOrientationPrompt } from "../orientation.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { justCompactedMap, JUST_COMPACTED_TTL_MS } from "./compact.js";

export function createRestoreHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { session_id, cwd, source } = input;
    const orientation = buildOrientationPrompt();

    // Post-compaction detection
    const isPostCompact =
      source === "compact" ||
      (justCompactedMap.has(session_id) && Date.now() - justCompactedMap.get(session_id)! < JUST_COMPACTED_TTL_MS);

    if (isPostCompact) {
      sendJson(res, 200, { context: orientation });
      return;
    }

    let episodicContext = "";
    let semanticContext = "";

    // Episodic: query recent summaries from project SQLite DB
    try {
      const dbPath = projectDbPath(cwd);
      if (cwd && existsSync(dbPath)) {
        mkdirSync(dirname(dbPath), { recursive: true });
        const db = new DatabaseSync(dbPath);
        runLcmMigrations(db);
        const rows = db.prepare(
          `SELECT s.content FROM summaries s
           JOIN conversations c ON s.conversation_id = c.conversation_id
           WHERE c.session_id = ?
           ORDER BY s.depth DESC, s.created_at DESC
           LIMIT ?`,
        ).all(session_id, config.restoration.recentSummaries) as Array<{ content: string }>;

        if (rows.length > 0) {
          episodicContext = `<recent-session-context>\n${rows.map((r) => r.content).join("\n\n")}\n</recent-session-context>`;
        }
        db.close();
      }
    } catch { /* non-fatal */ }

    // Semantic: query Qdrant via qdrant-store.js
    try {
      const require = createRequire(import.meta.url);
      const store = require(join(homedir(), ".local", "lib", "qdrant-store.js"));
      const pid = projectId(cwd);
      const results = await store.search(
        `project context ${cwd}`,
        config.cipher.collection,
        config.restoration.semanticTopK,
        config.restoration.semanticThreshold,
      );
      const relevant = results.filter((r: any) => r.payload?.projectId === pid);
      if (relevant.length > 0) {
        semanticContext = `<project-knowledge>\n${relevant.map((r: any) => r.payload.text).join("\n\n")}\n</project-knowledge>`;
      }
    } catch { /* non-fatal — Qdrant may not be running */ }

    const context = [orientation, episodicContext, semanticContext].filter(Boolean).join("\n\n");
    sendJson(res, 200, { context });
  };
}
