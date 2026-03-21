/**
 * LCM Repair Command
 *
 * Implements `lcm repair` — finds summaries with level='fallback' or truncation canaries
 * and re-summarizes them using the original prompts.
 *
 * Location: src/tools/lcm-repair-command.ts
 * Integration: Register in engine.ts registerTools() alongside other lcm_* commands
 *
 * Usage (via tool call):
 *   {
 *     name: "lcm_repair",
 *     input: {
 *       mode: "scan" | "repair",    // "scan" = dry-run, "repair" = commit
 *       conversationId?: number,    // repair specific conversation only
 *       maxSummaries?: number,      // limit repairs per run (default 10)
 *       verbose?: boolean           // include detailed logs
 *     }
 *   }
 */

import type { DatabaseSync } from "node:sqlite";
import type {
  ConversationStore,
  CreateMessagePartInput,
} from "../store/conversation-store.js";
import type { SummaryStore, SummaryRecord } from "../store/summary-store.js";
import type { LcmSummarizeFn } from "../summarize.js";
import { CompactionEngine, type CompactionConfig } from "../compaction.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface LcmRepairInput {
  mode: "scan" | "repair";
  conversationId?: number;
  maxSummaries?: number;
  verbose?: boolean;
}

export interface RepairSummaryEntry {
  summaryId: string;
  conversationId: number;
  kind: "leaf" | "condensed";
  depth: number;
  level: "fallback" | "normal" | "aggressive";
  contentLength: number;
  reason: "fallback-level" | "truncation-canary";
  children?: string[];
  parents?: string[];
}

export interface LcmRepairResult {
  mode: "scan" | "repair";
  conversationId?: number;
  foundCount: number;
  repairedCount: number;
  failedCount: number;
  skippedCount: number;
  entries: RepairSummaryEntry[];
  logs: string[];
  cascadeDepth: number;
}

// ── Constants ────────────────────────────────────────────────────────────────

const TRUNCATION_CANARY = "[Truncated from";
const FALLBACK_MAX_CHARS = 512 * 4; // matches compaction.ts constant

// ── Helpers ──────────────────────────────────────────────────────────────────

function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

function log(logs: string[], msg: string, verbose?: boolean) {
  if (verbose) {
    logs.push(msg);
  }
}

/**
 * Detect if content looks like a fallback truncation.
 * A "fallback" summary:
 *  - Contains "[Truncated from N tokens]" canary, OR
 *  - Is marked level='fallback' in the database, AND
 *  - Is suspiciously short (< 512 tokens) or ~4x the input ratio
 */
function isFallbackSummary(summary: SummaryRecord): boolean {
  if (summary.level === "fallback") {
    return true;
  }
  if (summary.content.includes(TRUNCATION_CANARY)) {
    return true;
  }
  // Heuristic: suspiciously compressed (< 512 tokens or ~1/10 of source)
  if (
    summary.tokenCount < 512 &&
    summary.sourceMessageTokenCount > 0 &&
    summary.tokenCount * 10 < summary.sourceMessageTokenCount
  ) {
    // Could be legitimate aggressive summary; require level or canary
    return false;
  }
  return false;
}

// ── LcmRepairEngine ──────────────────────────────────────────────────────────

export class LcmRepairEngine {
  constructor(
    private db: DatabaseSync,
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
    private compactionEngine: CompactionEngine,
    private compactionConfig: CompactionConfig,
  ) {}

  /**
   * Find all fallback-level summaries, optionally limited by conversation.
   */
  async findFallbackSummaries(
    conversationId?: number,
  ): Promise<RepairSummaryEntry[]> {
    const sql = conversationId
      ? `SELECT summary_id, conversation_id, kind, depth, level, content, token_count,
                source_message_token_count, descendant_count
         FROM summaries
         WHERE conversation_id = ? AND level = 'fallback'
         ORDER BY conversation_id ASC, created_at ASC`
      : `SELECT summary_id, conversation_id, kind, depth, level, content, token_count,
                source_message_token_count, descendant_count
         FROM summaries
         WHERE level = 'fallback'
         ORDER BY conversation_id ASC, created_at ASC`;

    const rows = conversationId
      ? (this.db.prepare(sql).all(conversationId) as any[])
      : (this.db.prepare(sql).all() as any[]);

    const entries: RepairSummaryEntry[] = [];
    for (const row of rows) {
      const summary = await this.summaryStore.getSummary(row.summary_id);
      if (!summary) continue;

      entries.push({
        summaryId: summary.summaryId,
        conversationId: summary.conversationId,
        kind: summary.kind,
        depth: summary.depth,
        level: summary.level as "fallback" | "normal" | "aggressive",
        contentLength: summary.content.length,
        reason: "fallback-level",
      });
    }

    return entries;
  }

  /**
   * Find summaries with truncation canary in content.
   */
  async findTruncationCanaries(
    conversationId?: number,
  ): Promise<RepairSummaryEntry[]> {
    const sql = conversationId
      ? `SELECT summary_id, conversation_id, kind, depth, level, content, token_count
         FROM summaries
         WHERE conversation_id = ? AND content LIKE ?
         ORDER BY conversation_id ASC, created_at ASC`
      : `SELECT summary_id, conversation_id, kind, depth, level, content, token_count
         FROM summaries
         WHERE content LIKE ?
         ORDER BY conversation_id ASC, created_at ASC`;

    const pattern = `%${TRUNCATION_CANARY}%`;
    const rows = conversationId
      ? (this.db.prepare(sql).all(conversationId, pattern) as any[])
      : (this.db.prepare(sql).all(pattern) as any[]);

    const entries: RepairSummaryEntry[] = [];
    const seenIds = new Set<string>();

    for (const row of rows) {
      if (seenIds.has(row.summary_id)) continue;
      seenIds.add(row.summary_id);

      const summary = await this.summaryStore.getSummary(row.summary_id);
      if (!summary) continue;

      entries.push({
        summaryId: summary.summaryId,
        conversationId: summary.conversationId,
        kind: summary.kind,
        depth: summary.depth,
        level: summary.level as "fallback" | "normal" | "aggressive",
        contentLength: summary.content.length,
        reason: "truncation-canary",
      });
    }

    return entries;
  }

  /**
   * Enrich entries with lineage info (children, parents).
   */
  async enrichLineage(entries: RepairSummaryEntry[]): Promise<void> {
    for (const entry of entries) {
      // Get children (summaries that have this one as parent)
      const children = await this.summaryStore.getSummaryChildren(entry.summaryId);
      entry.children = children.map((c) => c.summaryId);

      // Get parents
      const parents = await this.summaryStore.getSummaryParents(entry.summaryId);
      entry.parents = parents.map((p) => p.summaryId);
    }
  }

  /**
   * Re-summarize a leaf summary using its source messages.
   */
  async resummarizeLeaf(
    summaryId: string,
    summarizeFn: LcmSummarizeFn,
    logs: string[],
    verbose?: boolean,
  ): Promise<{ success: boolean; newContent?: string; error?: string }> {
    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary || summary.kind !== "leaf") {
      return { success: false, error: "Summary not found or not a leaf" };
    }

    // Get source messages
    const messageIds = await this.summaryStore.getSummaryMessages(summaryId);
    if (messageIds.length === 0) {
      return { success: false, error: "No source messages found" };
    }

    const messages: { content: string; createdAt: Date }[] = [];
    for (const msgId of messageIds) {
      const msg = await this.conversationStore.getMessageById(msgId);
      if (msg) {
        messages.push({ content: msg.content, createdAt: msg.createdAt });
      }
    }

    if (messages.length === 0) {
      return { success: false, error: "Could not fetch source messages" };
    }

    // Reconstruct the input text using the same format as in compaction.ts leafPass
    const concatenated = messages
      .map(
        (msg) =>
          `[${msg.createdAt.toISOString().split("T")[0]}]\n${msg.content}`,
      )
      .join("\n\n");

    log(
      logs,
      `  Leaf ${summaryId}: re-summarizing ${messages.length} messages (${estimateTokens(concatenated)} tokens)`,
      verbose,
    );

    try {
      // Use "aggressive" mode to reduce tokens more
      const newContent = await summarizeFn(concatenated, true, {
        isCondensed: false,
        previousSummary: undefined,
      });

      if (!newContent || newContent.trim().length === 0) {
        return { success: false, error: "Summarizer returned empty content" };
      }

      const newTokens = estimateTokens(newContent);
      const oldTokens = summary.tokenCount;
      log(
        logs,
        `    Success: ${oldTokens} tokens → ${newTokens} tokens`,
        verbose,
      );

      return { success: true, newContent };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(logs, `    Failed: ${errMsg}`, verbose);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Re-summarize a condensed summary using its parent summaries.
   */
  async resummarizeCondensed(
    summaryId: string,
    summarizeFn: LcmSummarizeFn,
    logs: string[],
    verbose?: boolean,
  ): Promise<{ success: boolean; newContent?: string; error?: string }> {
    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary || summary.kind !== "condensed") {
      return { success: false, error: "Summary not found or not condensed" };
    }

    // Get parent summaries
    const parents = await this.summaryStore.getSummaryParents(summaryId);
    if (parents.length === 0) {
      return { success: false, error: "No parent summaries found" };
    }

    // Reconstruct condensation input
    const concatenated = parents
      .map((parent) => {
        const tz = this.compactionConfig.timezone || "UTC";
        const earliestAt = parent.earliestAt || parent.createdAt;
        const latestAt = parent.latestAt || parent.createdAt;
        const header = `[${earliestAt.toISOString().split("T")[0]} - ${latestAt.toISOString().split("T")[0]}]`;
        return `${header}\n${parent.content}`;
      })
      .join("\n\n");

    log(
      logs,
      `  Condensed ${summaryId}: re-summarizing ${parents.length} parents (${estimateTokens(concatenated)} tokens)`,
      verbose,
    );

    try {
      const newContent = await summarizeFn(concatenated, true, {
        isCondensed: true,
        depth: summary.depth,
      });

      if (!newContent || newContent.trim().length === 0) {
        return { success: false, error: "Summarizer returned empty content" };
      }

      const newTokens = estimateTokens(newContent);
      const oldTokens = summary.tokenCount;
      log(
        logs,
        `    Success: ${oldTokens} tokens → ${newTokens} tokens`,
        verbose,
      );

      return { success: true, newContent };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(logs, `    Failed: ${errMsg}`, verbose);
      return { success: false, error: errMsg };
    }
  }

  /**
   * Main repair flow.
   */
  async repair(
    input: LcmRepairInput,
    summarizeFn: LcmSummarizeFn,
  ): Promise<LcmRepairResult> {
    const logs: string[] = [];
    const mode = input.mode || "scan";
    const maxSummaries = input.maxSummaries || 10;
    const verbose = input.verbose ?? false;

    log(
      logs,
      `LCM Repair: mode=${mode}, conversationId=${input.conversationId}, maxSummaries=${maxSummaries}`,
      verbose,
    );

    // Phase 1: find candidates
    const fallbackLevelEntries = await this.findFallbackSummaries(
      input.conversationId,
    );
    const truncationEntries = await this.findTruncationCanaries(
      input.conversationId,
    );

    // Deduplicate
    const entryMap = new Map<string, RepairSummaryEntry>();
    for (const entry of [...fallbackLevelEntries, ...truncationEntries]) {
      if (!entryMap.has(entry.summaryId)) {
        entryMap.set(entry.summaryId, entry);
      }
    }

    const allEntries = Array.from(entryMap.values());
    log(logs, `Found ${allEntries.length} candidates`, verbose);

    // Enrich with lineage
    await this.enrichLineage(allEntries);

    // Phase 2: repair (if not scan mode)
    let repairedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    const toRepair = allEntries.slice(0, maxSummaries);

    for (const entry of toRepair) {
      log(
        logs,
        `Processing ${entry.kind} summary ${entry.summaryId} (level=${entry.level}, reason=${entry.reason})`,
        verbose,
      );

      if (mode === "scan") {
        skippedCount++;
        continue;
      }

      // Repair based on kind
      const result =
        entry.kind === "leaf"
          ? await this.resummarizeLeaf(
              entry.summaryId,
              summarizeFn,
              logs,
              verbose,
            )
          : await this.resummarizeCondensed(
              entry.summaryId,
              summarizeFn,
              logs,
              verbose,
            );

      if (!result.success || !result.newContent) {
        failedCount++;
        log(logs, `  FAILED: ${result.error}`, verbose);
        continue;
      }

      // Persist the new summary
      try {
        await this.db.exec("BEGIN");
        const newTokens = estimateTokens(result.newContent);

        // Update the summary with new content
        this.db
          .prepare(
            `UPDATE summaries SET content = ?, token_count = ?, level = 'normal'
           WHERE summary_id = ?`,
          )
          .run(result.newContent, newTokens, entry.summaryId);

        // Log the repair as a compaction event
        const conversation = await this.conversationStore.getConversation(
          entry.conversationId,
        );
        if (conversation) {
          const seq = (await this.conversationStore.getMaxSeq(
            entry.conversationId,
          )) + 1;

          const msg = await this.conversationStore.createMessage({
            conversationId: entry.conversationId,
            seq,
            role: "system",
            content: `LCM repair: re-summarized ${entry.kind} summary ${entry.summaryId}`,
            tokenCount: estimateTokens(
              `LCM repair: re-summarized ${entry.kind} summary ${entry.summaryId}`,
            ),
          });

          const parts: CreateMessagePartInput[] = [
            {
              sessionId: conversation.sessionId,
              partType: "compaction",
              ordinal: 0,
              textContent: `LCM repair: re-summarized ${entry.kind} summary`,
              metadata: JSON.stringify({
                action: "repair",
                summaryId: entry.summaryId,
                summaryKind: entry.kind,
                summaryDepth: entry.depth,
                oldTokens: entry.contentLength / 4, // rough estimate
                newTokens: newTokens,
              }),
            },
          ];

          await this.conversationStore.createMessageParts(msg.messageId, parts);
        }

        await this.db.exec("COMMIT");
        repairedCount++;
        log(logs, `  REPAIRED: updated to level='normal'`, verbose);
      } catch (err) {
        await this.db.exec("ROLLBACK");
        failedCount++;
        log(
          logs,
          `  FAILED: ${err instanceof Error ? err.message : String(err)}`,
          verbose,
        );
      }
    }

    // Phase 3: cascade check for parent condensed summaries
    let cascadeDepth = 0;
    if (mode === "repair" && repairedCount > 0) {
      log(logs, `Checking for cascade repairs (leaf→condensed)`, verbose);
      // TODO: implement cascade by finding parents and checking if they need re-condensing
      cascadeDepth = 0; // placeholder
    }

    return {
      mode,
      conversationId: input.conversationId,
      foundCount: allEntries.length,
      repairedCount,
      failedCount,
      skippedCount,
      entries: allEntries.slice(0, maxSummaries),
      logs,
      cascadeDepth,
    };
  }
}

// ── Factory & Tool Export ───────────────────────────────────────────────────

import type { LcmDependencies } from "../types.js";

export interface CreateLcmRepairToolInput {
  deps: LcmDependencies;
  lcm: any; // LcmEngine
  sessionKey?: string;
}

export function createLcmRepairTool(input: CreateLcmRepairToolInput) {
  const { deps, lcm } = input;
  // Access engine internals through the `any`-typed lcm instance.
  // These are private fields on LcmContextEngine but we need direct
  // DB/store access for repair operations.
  const db = lcm.db;
  const conversationStore = lcm.conversationStore;
  const summaryStore = lcm.summaryStore;
  const compactionEngine = lcm.compaction;
  const compactionConfig = lcm.compaction?.config ?? { contextThreshold: 0.75, timezone: deps.config.timezone ?? "UTC" };

  return {
    name: "lcm_repair",
    description:
      "Scan for or repair fallback truncation summaries. Mode 'scan' = dry-run (count candidates), mode 'repair' = re-summarize and commit.",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: {
          type: "string",
          enum: ["scan", "repair"],
          description: "Whether to scan (dry-run) or repair (commit changes)",
        },
        conversationId: {
          type: "number",
          description: "Optional: limit repair to a specific conversation",
        },
        maxSummaries: {
          type: "number",
          description: "Maximum number of summaries to repair per run (default: 10)",
        },
        verbose: {
          type: "boolean",
          description: "Include detailed logs in result (default: false)",
        },
      },
      required: ["mode"],
    },
    invoke: async (input: unknown) => {
      // Type guard
      if (!input || typeof input !== "object") {
        throw new Error("lcm_repair: invalid input");
      }

      const params = input as {
        mode?: string;
        conversationId?: number;
        maxSummaries?: number;
        verbose?: boolean;
      };

      if (!params.mode || !["scan", "repair"].includes(params.mode)) {
        throw new Error("lcm_repair: mode must be 'scan' or 'repair'");
      }

      // Get the summarizer function
      const summarizeFn = await (lcm as any).resolveLcmSummarizer?.();
      if (!summarizeFn) {
        throw new Error("lcm_repair: could not initialize summarizer");
      }

      // Create repair engine
      const repairEngine = new LcmRepairEngine(
        db,
        conversationStore,
        summaryStore,
        compactionEngine,
        compactionConfig,
      );

      // Run repair
      try {
        const result = await repairEngine.repair(
          {
            mode: params.mode as "scan" | "repair",
            conversationId: params.conversationId,
            maxSummaries: params.maxSummaries,
            verbose: params.verbose,
          },
          summarizeFn,
        );

        return {
          content: [
            {
              type: "text",
              text: `LCM Repair: found=${result.foundCount}, repaired=${result.repairedCount}, failed=${result.failedCount}, skipped=${result.skippedCount}\n\n${result.logs.join("\n")}`,
            },
          ],
          details: result,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        deps.log.error(`LCM Repair failed: ${msg}`);
        throw err;
      }
    },
  };
}
