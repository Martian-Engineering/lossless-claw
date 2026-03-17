import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DaemonConfig } from "../config.js";
import { projectId, projectDbPath, projectMetaPath } from "../project.js";
import { sendJson } from "../server.js";
import type { RouteHandler } from "../server.js";
import { runLcmMigrations } from "../../db/migration.js";
import { ConversationStore } from "../../store/conversation-store.js";
import { SummaryStore } from "../../store/summary-store.js";
import { CompactionEngine } from "../../compaction.js";
import { createAnthropicSummarizer } from "../../llm/anthropic.js";
import { shouldPromote } from "../../promotion/detector.js";
import { promoteSummary } from "../../promotion/promoter.js";

// In-memory justCompacted map (session_id -> timestamp)
export const justCompactedMap = new Map<string, number>();
export const JUST_COMPACTED_TTL_MS = 30_000;

export function createCompactHandler(config: DaemonConfig): RouteHandler {
  return async (_req, res, body) => {
    const input = JSON.parse(body || "{}");
    const { session_id, cwd, transcript_path } = input;

    if (!session_id || !cwd) {
      sendJson(res, 400, { error: "session_id and cwd are required" });
      return;
    }

    const dbPath = projectDbPath(cwd);
    mkdirSync(dirname(dbPath), { recursive: true });

    const db = new DatabaseSync(dbPath);
    runLcmMigrations(db);

    const conversationStore = new ConversationStore(db);
    const summaryStore = new SummaryStore(db);
    const conversation = await conversationStore.getOrCreateConversation(session_id);

    // Check if there's anything to compact
    const tokenCount = await summaryStore.getContextTokenCount(conversation.conversationId);

    if (tokenCount === 0) {
      db.close();
      sendJson(res, 200, { summary: "No messages to compact." });
      return;
    }

    const summarize = createAnthropicSummarizer(config.llm);
    const engine = new CompactionEngine(conversationStore, summaryStore, {
      contextThreshold: 0.75,
      freshTailCount: 8,
      leafMinFanout: 3,
      condensedMinFanout: 2,
      condensedMinFanoutHard: 1,
      incrementalMaxDepth: 0,
      leafTargetTokens: config.compaction.leafTokens,
      condensedTargetTokens: 900,
      maxRounds: 10,
    });

    const result = await engine.compact({
      conversationId: conversation.conversationId,
      tokenBudget: 200_000,
      summarize,
      force: true,
    });

    // Promote new summaries to Qdrant
    let promotedCount = 0;
    if (result.actionTaken && result.createdSummaryId) {
      try {
        const summaries = await summaryStore.getSummariesByConversation(conversation.conversationId);
        const newSummary = summaries.find((s) => s.summaryId === result.createdSummaryId);
        if (newSummary) {
          const pid = projectId(cwd);
          const promotionResult = shouldPromote(
            {
              content: newSummary.content,
              depth: newSummary.depth,
              tokenCount: newSummary.tokenCount,
              sourceMessageTokenCount: newSummary.sourceMessageTokenCount,
            },
            config.compaction.promotionThresholds,
          );
          if (promotionResult.promote) {
            await promoteSummary({
              text: newSummary.content,
              tags: promotionResult.tags,
              projectId: pid,
              projectPath: cwd,
              depth: newSummary.depth,
              sessionId: session_id,
              confidence: promotionResult.confidence,
              collection: config.cipher.collection,
            });
            promotedCount = 1;
          }
        }
      } catch { /* non-fatal — Qdrant may not be running */ }
    }

    // Update meta.json
    try {
      const metaPath = projectMetaPath(cwd);
      mkdirSync(dirname(metaPath), { recursive: true });
      let meta: Record<string, unknown> = {};
      if (existsSync(metaPath)) {
        meta = JSON.parse(readFileSync(metaPath, "utf-8"));
      }
      meta.lastCompact = new Date().toISOString();
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch { /* non-fatal */ }

    // Set justCompacted flag
    justCompactedMap.set(session_id, Date.now());

    db.close();

    const tokenDelta = result.tokensBefore - result.tokensAfter;
    const summaryMsg = result.actionTaken
      ? `Compacted ${result.tokensBefore} → ${result.tokensAfter} tokens (saved ${tokenDelta}). ${promotedCount} promoted to long-term memory.`
      : "No compaction needed.";

    sendJson(res, 200, { summary: summaryMsg });
  };
}
