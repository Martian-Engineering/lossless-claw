import { Type } from "@sinclair/typebox";
import type { LcmConfig } from "./db/config.js";
import type { RetrievalEngine, ExpandResult, GrepResult } from "./retrieval.js";

// ── Types ────────────────────────────────────────────────────────────────────

export type ExpansionRequest = {
  /** Summary IDs to expand */
  summaryIds: string[];
  /** Max traversal depth per summary (default: 3) */
  maxDepth?: number;
  /** Max tokens across the entire expansion (default: config.maxExpandTokens) */
  tokenCap?: number;
  /** Whether to include raw source messages at leaf level */
  includeMessages?: boolean;
  /** Conversation ID scope */
  conversationId: number;
};

export type ExpansionResult = {
  /** Expanded summaries with their children/messages */
  expansions: Array<{
    summaryId: string;
    children: Array<{
      summaryId: string;
      kind: string;
      snippet: string;
      tokenCount: number;
    }>;
    messages: Array<{
      messageId: number;
      role: string;
      snippet: string;
      tokenCount: number;
    }>;
  }>;
  /** Cited IDs for follow-up traversal */
  citedIds: string[];
  /** Total tokens in the result */
  totalTokens: number;
  /** Whether any expansion was truncated */
  truncated: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────────

const SNIPPET_MAX_CHARS = 200;

/** Truncate content to a short snippet for display. */
function truncateSnippet(content: string, maxChars: number = SNIPPET_MAX_CHARS): string {
  if (content.length <= maxChars) {
    return content;
  }
  return content.slice(0, maxChars) + "...";
}

/**
 * Resolve the effective expansion token cap by applying a configured default
 * and an explicit upper bound.
 */
export function resolveExpansionTokenCap(input: {
  requestedTokenCap?: number;
  maxExpandTokens: number;
}): number {
  const maxExpandTokens = Math.max(1, Math.trunc(input.maxExpandTokens));
  const requestedTokenCap = input.requestedTokenCap;
  if (typeof requestedTokenCap !== "number" || !Number.isFinite(requestedTokenCap)) {
    return maxExpandTokens;
  }
  return Math.min(Math.max(1, Math.trunc(requestedTokenCap)), maxExpandTokens);
}

/**
 * Convert a single RetrievalEngine.expand() result into the ExpansionResult
 * entry format, truncating content to short snippets.
 */
function toExpansionEntry(
  summaryId: string,
  raw: ExpandResult,
): ExpansionResult["expansions"][number] {
  return {
    summaryId,
    children: raw.children.map((c) => ({
      summaryId: c.summaryId,
      kind: c.kind,
      snippet: truncateSnippet(c.content),
      tokenCount: c.tokenCount,
    })),
    messages: raw.messages.map((m) => ({
      messageId: m.messageId,
      role: m.role,
      snippet: truncateSnippet(m.content),
      tokenCount: m.tokenCount,
    })),
  };
}

/** Collect all referenced summary IDs from an expansion entry. */
function collectCitedIds(entry: ExpansionResult["expansions"][number]): string[] {
  const ids: string[] = [entry.summaryId];
  for (const child of entry.children) {
    ids.push(child.summaryId);
  }
  return ids;
}

// ── ExpansionOrchestrator ────────────────────────────────────────────────────

export class ExpansionOrchestrator {
  constructor(private retrieval: RetrievalEngine) {}

  /**
   * Expand each summary ID using the RetrievalEngine, collecting results and
   * enforcing a global token cap across all expansions.
   */
  async expand(request: ExpansionRequest): Promise<ExpansionResult> {
    const maxDepth = request.maxDepth ?? 3;
    const tokenCap = request.tokenCap ?? Infinity;
    const includeMessages = request.includeMessages ?? false;

    const result: ExpansionResult = {
      expansions: [],
      citedIds: [],
      totalTokens: 0,
      truncated: false,
    };

    const citedSet = new Set<string>();

    for (const summaryId of request.summaryIds) {
      if (result.truncated) {
        break;
      }

      // Calculate remaining budget for this expansion
      const remainingBudget = tokenCap - result.totalTokens;
      if (remainingBudget <= 0) {
        result.truncated = true;
        break;
      }

      const raw = await this.retrieval.expand({
        summaryId,
        depth: maxDepth,
        includeMessages,
        tokenCap: remainingBudget,
      });

      const entry = toExpansionEntry(summaryId, raw);
      result.expansions.push(entry);
      result.totalTokens += raw.estimatedTokens;

      // Track cited IDs
      for (const id of collectCitedIds(entry)) {
        citedSet.add(id);
      }

      if (raw.truncated) {
        result.truncated = true;
      }
    }

    result.citedIds = [...citedSet];
    return result;
  }

  /**
   * Convenience method: grep for matching summaries, then expand the top results.
   * Combines the routing pass (grep) with the deep expansion pass.
   */
  async describeAndExpand(input: {
    query: string;
    mode: "regex" | "full_text";
    conversationId?: number;
    maxDepth?: number;
    tokenCap?: number;
  }): Promise<ExpansionResult> {
    const grepResult: GrepResult = await this.retrieval.grep({
      query: input.query,
      mode: input.mode,
      scope: "summaries",
      conversationId: input.conversationId,
    });

    const summaryIds = grepResult.summaries
      .toSorted((a, b) => {
        const recencyDelta = b.createdAt.getTime() - a.createdAt.getTime();
        if (recencyDelta !== 0) {
          return recencyDelta;
        }
        const aRank = a.rank ?? Number.POSITIVE_INFINITY;
        const bRank = b.rank ?? Number.POSITIVE_INFINITY;
        return aRank - bRank;
      })
      .map((s) => s.summaryId);
    if (summaryIds.length === 0) {
      return {
        expansions: [],
        citedIds: [],
        totalTokens: 0,
        truncated: false,
      };
    }

    return this.expand({
      summaryIds,
      maxDepth: input.maxDepth,
      tokenCap: input.tokenCap,
      includeMessages: false,
      conversationId: input.conversationId ?? 0,
    });
  }
}

// ── Distill for subagent ─────────────────────────────────────────────────────

/**
 * Format an ExpansionResult into a compact text payload suitable for passing
 * to a subagent or returning to the main agent.
 */
export function distillForSubagent(result: ExpansionResult): string {
  const lines: string[] = [];

  lines.push(
    `## Expansion Results (${result.expansions.length} summaries, ${result.totalTokens} total tokens)`,
  );
  lines.push("");

  for (const entry of result.expansions) {
    // Determine kind from children presence: if it has children it was a condensed node
    const kind = entry.children.length > 0 ? "condensed" : "leaf";
    const tokenSum =
      entry.children.reduce((sum, c) => sum + c.tokenCount, 0) +
      entry.messages.reduce((sum, m) => sum + m.tokenCount, 0);

    lines.push(`### ${entry.summaryId} (${kind}, ${tokenSum} tokens)`);

    if (entry.children.length > 0) {
      lines.push(`Children: ${entry.children.map((c) => c.summaryId).join(", ")}`);
    }

    if (entry.messages.length > 0) {
      const msgParts = entry.messages.map(
        (m) => `msg#${m.messageId} (${m.role}, ${m.tokenCount} tokens)`,
      );
      lines.push(`Messages: ${msgParts.join(", ")}`);
    }

    // Show a snippet for children that have content
    for (const child of entry.children) {
      if (child.snippet) {
        lines.push(`[Snippet: ${truncateSnippet(child.snippet)}]`);
        break; // Only show one snippet per entry to keep it compact
      }
    }

    lines.push("");
  }

  if (result.citedIds.length > 0) {
    lines.push(`Cited IDs for follow-up: ${result.citedIds.join(", ")}`);
  }

  lines.push(`[Truncated: ${result.truncated ? "yes" : "no"}]`);

  return lines.join("\n");
}

// ── Tool definition ──────────────────────────────────────────────────────────

const LcmExpansionSchema = Type.Object({
  summaryIds: Type.Optional(
    Type.Array(Type.String(), {
      description: "Summary IDs to expand (e.g. sum_abc123). Required if query is not provided.",
    }),
  ),
  query: Type.Optional(
    Type.String({
      description:
        "Text query to grep for matching summaries before expanding. " +
        "If provided, summaryIds is ignored and the top grep results are expanded instead.",
    }),
  ),
  maxDepth: Type.Optional(
    Type.Number({
      description: "Max traversal depth per summary (default: 3).",
      minimum: 1,
      maximum: 10,
    }),
  ),
  tokenCap: Type.Optional(
    Type.Number({
      description: "Max tokens across the entire expansion result.",
      minimum: 1,
    }),
  ),
  includeMessages: Type.Optional(
    Type.Boolean({
      description: "Whether to include raw source messages at leaf level (default: false).",
    }),
  ),
});

/**
 * Build a tool definition object for LCM expansion that can be registered as
 * an agent tool. Follows the pattern used in `src/agents/tools/`.
 *
 * Requires an already-initialised ExpansionOrchestrator and an LcmConfig
 * (for the default tokenCap).
 */
export function buildExpansionToolDefinition(options: {
  orchestrator: ExpansionOrchestrator;
  config: LcmConfig;
  conversationId: number;
}) {
  const { orchestrator, config, conversationId } = options;

  return {
    name: "lcm_expand",
    description:
      "Expand compacted conversation summaries from LCM (Lossless Context Management). " +
      "Traverses the summary DAG to retrieve children and source messages. " +
      "Use this to drill into previously-compacted context when you need detail " +
      "that was summarised away. Returns a compact text payload with cited IDs for follow-up.",
    parameters: LcmExpansionSchema,
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }> => {
      const summaryIds = params.summaryIds as string[] | undefined;
      const query = typeof params.query === "string" ? params.query.trim() : undefined;
      const maxDepth =
        typeof params.maxDepth === "number" ? Math.trunc(params.maxDepth) : undefined;
      const requestedTokenCap =
        typeof params.tokenCap === "number" ? Math.trunc(params.tokenCap) : undefined;
      const tokenCap = resolveExpansionTokenCap({
        requestedTokenCap,
        maxExpandTokens: config.maxExpandTokens,
      });
      const includeMessages =
        typeof params.includeMessages === "boolean" ? params.includeMessages : false;

      let result: ExpansionResult;

      if (query) {
        // Grep-first path: find summaries matching the query, then expand
        result = await orchestrator.describeAndExpand({
          query,
          mode: "full_text",
          conversationId,
          maxDepth,
          tokenCap,
        });
      } else if (summaryIds && summaryIds.length > 0) {
        // Direct expansion of specific summary IDs
        result = await orchestrator.expand({
          summaryIds,
          maxDepth,
          tokenCap,
          includeMessages,
          conversationId,
        });
      } else {
        const text = "Error: either summaryIds or query must be provided.";
        return {
          content: [{ type: "text", text }],
          details: { error: text },
        };
      }

      const distilled = distillForSubagent(result);
      return {
        content: [{ type: "text", text: distilled }],
        details: {
          expansionCount: result.expansions.length,
          citedIds: result.citedIds,
          totalTokens: result.totalTokens,
          truncated: result.truncated,
        },
      };
    },
  };
}
