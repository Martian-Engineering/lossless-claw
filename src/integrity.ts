import type { ConversationStore } from "./store/conversation-store.js";
import type {
  SummaryStore,
  SummaryRecord,
  ContextItemRecord,
} from "./store/summary-store.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export type IntegrityCheck = {
  name: string;
  status: "pass" | "fail" | "warn";
  message: string;
  details?: unknown;
};

export type IntegrityReport = {
  conversationId: number;
  checks: IntegrityCheck[];
  passCount: number;
  failCount: number;
  warnCount: number;
  scannedAt: Date;
};

export type LcmMetrics = {
  conversationId: number;
  contextTokens: number;
  messageCount: number;
  summaryCount: number;
  contextItemCount: number;
  leafSummaryCount: number;
  condensedSummaryCount: number;
  largeFileCount: number;
  collectedAt: Date;
};

// ── IntegrityChecker ──────────────────────────────────────────────────────────

export class IntegrityChecker {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
  ) {}

  /**
   * Run all integrity checks for a conversation and return a full report.
   * Each check runs independently -- a failure in one does not short-circuit
   * the remaining checks.
   */
  async scan(conversationId: number): Promise<IntegrityReport> {
    const checks: IntegrityCheck[] = [];

    // 1. conversation_exists
    checks.push(await this.checkConversationExists(conversationId));

    // If the conversation does not exist, the remaining checks will still
    // execute (operating on empty result sets) so the report is complete.

    // 2. context_items_contiguous
    checks.push(await this.checkContextItemsContiguous(conversationId));

    // 3. context_items_valid_refs
    checks.push(await this.checkContextItemsValidRefs(conversationId));

    // 4. summaries_have_lineage
    checks.push(await this.checkSummariesHaveLineage(conversationId));

    // 5. no_orphan_summaries
    checks.push(await this.checkNoOrphanSummaries(conversationId));

    // 6. context_token_consistency
    checks.push(await this.checkContextTokenConsistency(conversationId));

    // 7. message_seq_contiguous
    checks.push(await this.checkMessageSeqContiguous(conversationId));

    // 8. no_duplicate_context_refs
    checks.push(await this.checkNoDuplicateContextRefs(conversationId));

    const passCount = checks.filter((c) => c.status === "pass").length;
    const failCount = checks.filter((c) => c.status === "fail").length;
    const warnCount = checks.filter((c) => c.status === "warn").length;

    return {
      conversationId,
      checks,
      passCount,
      failCount,
      warnCount,
      scannedAt: new Date(),
    };
  }

  // ── Individual checks ───────────────────────────────────────────────────

  private async checkConversationExists(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const conversation =
      await this.conversationStore.getConversation(conversationId);
    if (conversation) {
      return {
        name: "conversation_exists",
        status: "pass",
        message: `Conversation ${conversationId} exists`,
      };
    }
    return {
      name: "conversation_exists",
      status: "fail",
      message: `Conversation ${conversationId} not found`,
    };
  }

  private async checkContextItemsContiguous(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const items = await this.summaryStore.getContextItems(conversationId);
    if (items.length === 0) {
      return {
        name: "context_items_contiguous",
        status: "pass",
        message: "No context items to check",
      };
    }

    const gaps: { expected: number; actual: number }[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].ordinal !== i) {
        gaps.push({ expected: i, actual: items[i].ordinal });
      }
    }

    if (gaps.length === 0) {
      return {
        name: "context_items_contiguous",
        status: "pass",
        message: `All ${items.length} context items have contiguous ordinals`,
      };
    }

    return {
      name: "context_items_contiguous",
      status: "fail",
      message: `Found ${gaps.length} ordinal gap(s) in context items`,
      details: { gaps },
    };
  }

  private async checkContextItemsValidRefs(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const items = await this.summaryStore.getContextItems(conversationId);
    const danglingRefs: {
      ordinal: number;
      itemType: string;
      refId: number | string;
    }[] = [];

    for (const item of items) {
      if (item.itemType === "message" && item.messageId != null) {
        const msg = await this.conversationStore.getMessageById(item.messageId);
        if (!msg) {
          danglingRefs.push({
            ordinal: item.ordinal,
            itemType: "message",
            refId: item.messageId,
          });
        }
      } else if (item.itemType === "summary" && item.summaryId != null) {
        const sum = await this.summaryStore.getSummary(item.summaryId);
        if (!sum) {
          danglingRefs.push({
            ordinal: item.ordinal,
            itemType: "summary",
            refId: item.summaryId,
          });
        }
      }
    }

    if (danglingRefs.length === 0) {
      return {
        name: "context_items_valid_refs",
        status: "pass",
        message: "All context item references are valid",
      };
    }

    return {
      name: "context_items_valid_refs",
      status: "fail",
      message: `Found ${danglingRefs.length} dangling reference(s) in context items`,
      details: { danglingRefs },
    };
  }

  private async checkSummariesHaveLineage(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const summaries =
      await this.summaryStore.getSummariesByConversation(conversationId);
    const missingLineage: { summaryId: string; kind: string; issue: string }[] =
      [];

    for (const summary of summaries) {
      if (summary.kind === "leaf") {
        // Leaf summaries must link to at least one message
        const messageIds = await this.summaryStore.getSummaryMessages(
          summary.summaryId,
        );
        if (messageIds.length === 0) {
          missingLineage.push({
            summaryId: summary.summaryId,
            kind: "leaf",
            issue: "no linked messages in summary_messages",
          });
        }
      } else if (summary.kind === "condensed") {
        // Condensed summaries must link to at least one parent summary
        const parents = await this.summaryStore.getSummaryParents(
          summary.summaryId,
        );
        if (parents.length === 0) {
          missingLineage.push({
            summaryId: summary.summaryId,
            kind: "condensed",
            issue: "no linked parents in summary_parents",
          });
        }
      }
    }

    if (missingLineage.length === 0) {
      return {
        name: "summaries_have_lineage",
        status: "pass",
        message: `All ${summaries.length} summaries have proper lineage`,
      };
    }

    return {
      name: "summaries_have_lineage",
      status: "fail",
      message: `Found ${missingLineage.length} summary/summaries missing lineage`,
      details: { missingLineage },
    };
  }

  private async checkNoOrphanSummaries(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const summaries =
      await this.summaryStore.getSummariesByConversation(conversationId);
    const contextItems =
      await this.summaryStore.getContextItems(conversationId);

    // Build set of summary IDs that appear in context_items
    const contextSummaryIds = new Set(
      contextItems
        .filter((ci) => ci.itemType === "summary" && ci.summaryId != null)
        .map((ci) => ci.summaryId as string),
    );

    // Build set of summary IDs that are parents of other summaries
    const parentSummaryIds = new Set<string>();
    for (const summary of summaries) {
      const children = await this.summaryStore.getSummaryChildren(
        summary.summaryId,
      );
      if (children.length > 0) {
        parentSummaryIds.add(summary.summaryId);
      }
    }

    // Orphans are summaries in neither set
    const orphans: string[] = [];
    for (const summary of summaries) {
      if (
        !contextSummaryIds.has(summary.summaryId) &&
        !parentSummaryIds.has(summary.summaryId)
      ) {
        orphans.push(summary.summaryId);
      }
    }

    if (orphans.length === 0) {
      return {
        name: "no_orphan_summaries",
        status: "pass",
        message: "No orphaned summaries found",
      };
    }

    return {
      name: "no_orphan_summaries",
      status: "warn",
      message: `Found ${orphans.length} orphaned summary/summaries disconnected from the DAG`,
      details: { orphanedSummaryIds: orphans },
    };
  }

  private async checkContextTokenConsistency(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const contextItems =
      await this.summaryStore.getContextItems(conversationId);

    // Manually sum token counts from referenced messages and summaries
    let manualSum = 0;
    for (const item of contextItems) {
      if (item.itemType === "message" && item.messageId != null) {
        const msg = await this.conversationStore.getMessageById(item.messageId);
        if (msg) {
          manualSum += msg.tokenCount;
        }
      } else if (item.itemType === "summary" && item.summaryId != null) {
        const sum = await this.summaryStore.getSummary(item.summaryId);
        if (sum) {
          manualSum += sum.tokenCount;
        }
      }
    }

    // Compare with the aggregate query
    const aggregateTotal =
      await this.summaryStore.getContextTokenCount(conversationId);

    if (manualSum === aggregateTotal) {
      return {
        name: "context_token_consistency",
        status: "pass",
        message: `Context token count is consistent (${aggregateTotal} tokens)`,
      };
    }

    return {
      name: "context_token_consistency",
      status: "fail",
      message: `Token count mismatch: item-level sum = ${manualSum}, aggregate query = ${aggregateTotal}`,
      details: { manualSum, aggregateTotal, difference: manualSum - aggregateTotal },
    };
  }

  private async checkMessageSeqContiguous(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const messages = await this.conversationStore.getMessages(conversationId);
    if (messages.length === 0) {
      return {
        name: "message_seq_contiguous",
        status: "pass",
        message: "No messages to check",
      };
    }

    const gaps: { expected: number; actual: number }[] = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].seq !== i) {
        gaps.push({ expected: i, actual: messages[i].seq });
      }
    }

    if (gaps.length === 0) {
      return {
        name: "message_seq_contiguous",
        status: "pass",
        message: `All ${messages.length} messages have contiguous seq values`,
      };
    }

    return {
      name: "message_seq_contiguous",
      status: "fail",
      message: `Found ${gaps.length} seq gap(s) in messages`,
      details: { gaps },
    };
  }

  private async checkNoDuplicateContextRefs(
    conversationId: number,
  ): Promise<IntegrityCheck> {
    const items = await this.summaryStore.getContextItems(conversationId);

    const seenMessageIds = new Map<number, number[]>();
    const seenSummaryIds = new Map<string, number[]>();
    const duplicates: {
      refType: string;
      refId: number | string;
      ordinals: number[];
    }[] = [];

    for (const item of items) {
      if (item.itemType === "message" && item.messageId != null) {
        const ordinals = seenMessageIds.get(item.messageId) ?? [];
        ordinals.push(item.ordinal);
        seenMessageIds.set(item.messageId, ordinals);
      } else if (item.itemType === "summary" && item.summaryId != null) {
        const ordinals = seenSummaryIds.get(item.summaryId) ?? [];
        ordinals.push(item.ordinal);
        seenSummaryIds.set(item.summaryId, ordinals);
      }
    }

    for (const [messageId, ordinals] of seenMessageIds) {
      if (ordinals.length > 1) {
        duplicates.push({ refType: "message", refId: messageId, ordinals });
      }
    }
    for (const [summaryId, ordinals] of seenSummaryIds) {
      if (ordinals.length > 1) {
        duplicates.push({ refType: "summary", refId: summaryId, ordinals });
      }
    }

    if (duplicates.length === 0) {
      return {
        name: "no_duplicate_context_refs",
        status: "pass",
        message: "No duplicate references in context items",
      };
    }

    return {
      name: "no_duplicate_context_refs",
      status: "fail",
      message: `Found ${duplicates.length} duplicate reference(s) in context items`,
      details: { duplicates },
    };
  }
}

// ── repairPlan ────────────────────────────────────────────────────────────────

/**
 * Generate human-readable repair suggestions for each failing or warning check
 * in an integrity report. Does not perform any actual repairs.
 */
export function repairPlan(report: IntegrityReport): string[] {
  const suggestions: string[] = [];

  for (const check of report.checks) {
    if (check.status === "pass") continue;

    switch (check.name) {
      case "conversation_exists":
        suggestions.push(
          `Create or restore conversation ${report.conversationId} in the conversations table`,
        );
        break;

      case "context_items_contiguous":
        suggestions.push(
          "Resequence context items to fix ordinal gaps",
        );
        break;

      case "context_items_valid_refs": {
        const details = check.details as {
          danglingRefs: { ordinal: number; itemType: string; refId: number | string }[];
        } | undefined;
        if (details?.danglingRefs) {
          for (const ref of details.danglingRefs) {
            suggestions.push(
              `Remove context item at ordinal ${ref.ordinal} referencing missing ${ref.itemType} ${ref.refId}`,
            );
          }
        } else {
          suggestions.push(
            "Remove context items with dangling references",
          );
        }
        break;
      }

      case "summaries_have_lineage": {
        const details = check.details as {
          missingLineage: { summaryId: string; kind: string; issue: string }[];
        } | undefined;
        if (details?.missingLineage) {
          for (const entry of details.missingLineage) {
            if (entry.kind === "leaf") {
              suggestions.push(
                `Add missing lineage for leaf summary ${entry.summaryId} (link to source messages via summary_messages)`,
              );
            } else {
              suggestions.push(
                `Add missing lineage for condensed summary ${entry.summaryId} (link to parent summaries via summary_parents)`,
              );
            }
          }
        } else {
          suggestions.push(
            "Add missing lineage links for summaries",
          );
        }
        break;
      }

      case "no_orphan_summaries": {
        const details = check.details as {
          orphanedSummaryIds: string[];
        } | undefined;
        if (details?.orphanedSummaryIds) {
          for (const id of details.orphanedSummaryIds) {
            suggestions.push(
              `Remove orphaned summary ${id} from summaries table`,
            );
          }
        } else {
          suggestions.push(
            "Remove orphaned summaries disconnected from the DAG",
          );
        }
        break;
      }

      case "context_token_consistency":
        suggestions.push(
          "Recompute context token count to reconcile mismatch between item-level sum and aggregate query",
        );
        break;

      case "message_seq_contiguous":
        suggestions.push(
          "Resequence message seq values to eliminate gaps (renumber starting from 0)",
        );
        break;

      case "no_duplicate_context_refs": {
        const details = check.details as {
          duplicates: { refType: string; refId: number | string; ordinals: number[] }[];
        } | undefined;
        if (details?.duplicates) {
          for (const dup of details.duplicates) {
            const keepOrdinal = dup.ordinals[0];
            const removeOrdinals = dup.ordinals.slice(1).join(", ");
            suggestions.push(
              `Deduplicate ${dup.refType} ${dup.refId}: keep ordinal ${keepOrdinal}, remove ordinals ${removeOrdinals}`,
            );
          }
        } else {
          suggestions.push(
            "Remove duplicate message_id or summary_id references from context items",
          );
        }
        break;
      }

      default:
        suggestions.push(`Address failing check: ${check.name} -- ${check.message}`);
        break;
    }
  }

  return suggestions;
}

// ── Observability ─────────────────────────────────────────────────────────────

/**
 * Collect LCM observability metrics for a conversation by querying the stores.
 */
export async function collectMetrics(
  conversationId: number,
  conversationStore: ConversationStore,
  summaryStore: SummaryStore,
): Promise<LcmMetrics> {
  const [
    contextTokens,
    messageCount,
    summaries,
    contextItems,
    largeFiles,
  ] = await Promise.all([
    summaryStore.getContextTokenCount(conversationId),
    conversationStore.getMessageCount(conversationId),
    summaryStore.getSummariesByConversation(conversationId),
    summaryStore.getContextItems(conversationId),
    summaryStore.getLargeFilesByConversation(conversationId),
  ]);

  const leafSummaryCount = summaries.filter((s) => s.kind === "leaf").length;
  const condensedSummaryCount = summaries.filter(
    (s) => s.kind === "condensed",
  ).length;

  return {
    conversationId,
    contextTokens,
    messageCount,
    summaryCount: summaries.length,
    contextItemCount: contextItems.length,
    leafSummaryCount,
    condensedSummaryCount,
    largeFileCount: largeFiles.length,
    collectedAt: new Date(),
  };
}
