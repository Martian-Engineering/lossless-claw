import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve as resolvePath, sep as pathSep } from "node:path";
import type {
  ConversationStore,
  MessageRecord,
  MessageSearchResult,
} from "./store/conversation-store.js";
import type {
  SummaryStore,
  SummaryRecord,
  SummarySearchResult,
  LargeFileRecord,
} from "./store/summary-store.js";
import type { SearchSort } from "./store/full-text-sort.js";
import { estimateTokens } from "./estimate-tokens.js";

// ── Public interfaces ────────────────────────────────────────────────────────

export interface DescribeResult {
  id: string;
  type: "summary" | "file";
  /** Summary-specific fields */
  summary?: {
    conversationId: number;
    kind: "leaf" | "condensed";
    content: string;
    depth: number;
    tokenCount: number;
    descendantCount: number;
    descendantTokenCount: number;
    sourceMessageTokenCount: number;
    fileIds: string[];
    parentIds: string[];
    childIds: string[];
    messageIds: number[];
    earliestAt: Date | null;
    latestAt: Date | null;
    subtree: Array<{
      summaryId: string;
      parentSummaryId: string | null;
      depthFromRoot: number;
      kind: "leaf" | "condensed";
      depth: number;
      tokenCount: number;
      descendantCount: number;
      descendantTokenCount: number;
      sourceMessageTokenCount: number;
      earliestAt: Date | null;
      latestAt: Date | null;
      childCount: number;
      path: string;
    }>;
    createdAt: Date;
  };
  /** File-specific fields */
  file?: {
    conversationId: number;
    fileName: string | null;
    mimeType: string | null;
    byteSize: number | null;
    storageUri: string;
    explorationSummary: string | null;
    createdAt: Date;
    /**
     * v4.2 §B — actual file content read from `storageUri` when the
     * caller requests `expandFile=true` AND the file is on disk AND
     * the byte count is under the budget cap. Null when the file is
     * absent (orphan), too large to inline, or not requested. The
     * tool layer surfaces a `truncated`/`hint` field separately.
     */
    content?: string | null;
    contentTruncated?: boolean;
  };
}

export interface GrepInput {
  query: string;
  mode: "regex" | "full_text";
  scope: "messages" | "summaries" | "both";
  conversationId?: number;
  conversationIds?: number[];
  since?: Date;
  before?: Date;
  limit?: number;
  /** Sort order for results. Default "recency" (newest first).
   *  "relevance" sorts by FTS5 BM25 rank (full_text mode only).
   *  "hybrid" blends relevance with recency. */
  sort?: SearchSort;
}

export interface GrepResult {
  messages: MessageSearchResult[];
  summaries: SummarySearchResult[];
  totalMatches: number;
}

export interface ExpandInput {
  summaryId: string;
  /** Max traversal depth (default 1) */
  depth?: number;
  /** Include raw source messages at leaf level */
  includeMessages?: boolean;
  /** Max tokens to return before truncating */
  tokenCap?: number;
}

export interface ExpandResult {
  /** Child summaries found */
  children: Array<{
    summaryId: string;
    kind: "leaf" | "condensed";
    content: string;
    tokenCount: number;
  }>;
  /** Source messages (only if includeMessages=true and hitting leaf summaries) */
  messages: Array<{
    messageId: number;
    role: string;
    content: string;
    tokenCount: number;
  }>;
  /** Total estimated tokens in result */
  estimatedTokens: number;
  /** Whether result was truncated due to tokenCap */
  truncated: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────────


// ── RetrievalEngine ──────────────────────────────────────────────────────────

export class RetrievalEngine {
  constructor(
    private conversationStore: ConversationStore,
    private summaryStore: SummaryStore,
  ) {}

  // ── describe ─────────────────────────────────────────────────────────────

  /**
   * Describe an LCM item by ID.
   *
   * - IDs starting with "sum_" are looked up as summaries (with lineage).
   * - IDs starting with "file_" are looked up as large files.
   * - Returns null if the item is not found.
   */
  async describe(
    id: string,
    options?: { expandFile?: boolean; expandFileMaxBytes?: number; largeFilesDir?: string },
  ): Promise<DescribeResult | null> {
    if (id.startsWith("sum_")) {
      return this.describeSummary(id);
    }
    if (id.startsWith("file_")) {
      return this.describeFile(id, options);
    }
    return null;
  }

  private async describeSummary(id: string): Promise<DescribeResult | null> {
    const summary = await this.summaryStore.getSummary(id);
    if (!summary) {
      return null;
    }

    // Fetch lineage in parallel
    const [parents, children, messageIds, subtree] = await Promise.all([
      this.summaryStore.getSummaryParents(id),
      this.summaryStore.getSummaryChildren(id),
      this.summaryStore.getSummaryMessages(id),
      this.summaryStore.getSummarySubtree(id),
    ]);

    return {
      id,
      type: "summary",
      summary: {
        conversationId: summary.conversationId,
        kind: summary.kind,
        content: summary.content,
        depth: summary.depth,
        tokenCount: summary.tokenCount,
        descendantCount: summary.descendantCount,
        descendantTokenCount: summary.descendantTokenCount,
        sourceMessageTokenCount: summary.sourceMessageTokenCount,
        fileIds: summary.fileIds,
        parentIds: parents.map((p) => p.summaryId),
        childIds: children.map((c) => c.summaryId),
        messageIds,
        earliestAt: summary.earliestAt,
        latestAt: summary.latestAt,
        subtree: subtree.map((node) => ({
          summaryId: node.summaryId,
          parentSummaryId: node.parentSummaryId,
          depthFromRoot: node.depthFromRoot,
          kind: node.kind,
          depth: node.depth,
          tokenCount: node.tokenCount,
          descendantCount: node.descendantCount,
          descendantTokenCount: node.descendantTokenCount,
          sourceMessageTokenCount: node.sourceMessageTokenCount,
          earliestAt: node.earliestAt,
          latestAt: node.latestAt,
          childCount: node.childCount,
          path: node.path,
        })),
        createdAt: summary.createdAt,
      },
    };
  }

  private async describeFile(
    id: string,
    options?: { expandFile?: boolean; expandFileMaxBytes?: number; largeFilesDir?: string },
  ): Promise<DescribeResult | null> {
    const file = await this.summaryStore.getLargeFile(id);
    if (!file) {
      return null;
    }

    // v4.2 §B — when caller requests expandFile, read the actual file
    // bytes from disk. Bounds:
    //   1. Path validation: storageUri MUST resolve under the runtime's
    //      configured `largeFilesDir` to prevent traversal via a poisoned
    //      `large_files.storage_uri` row.
    //   2. Existence check: orphaned files (DB row points at a missing
    //      file) return null content with `contentTruncated: false` —
    //      caller can decide how to render the gap.
    //   3. Size cap: default 32 KB (~8K tokens) so a single drilldown
    //      can't blow out the agent's context. Override via
    //      `expandFileMaxBytes`. Files over the cap return the head
    //      portion + `contentTruncated: true`.
    let content: string | null = null;
    let contentTruncated = false;
    // Wave-3 P3 fix: refuse expansion when largeFilesDir is unset in
    // production. Test mocks pass it explicitly; production goes through
    // configView.largeFilesDir which is always populated post-resolver.
    if (options?.expandFile === true && file.storageUri && options.largeFilesDir) {
      try {
        const maxBytes = Math.max(1024, Math.min(
          options.expandFileMaxBytes ?? 32_768,
          512_000, // hard cap: 500 KB regardless of caller request
        ));
        // Path validation v2 (Wave-3 P1):
        //   1. realpathSync resolves symlinks. lexical resolvePath did
        //      NOT — a symlink at <storageDir>/file_x.txt -> /etc/passwd
        //      would have passed the prefix check.
        //   2. Compare with `path.sep` separator (not hardcoded "/")
        //      so the check works on Windows too (P1 portability).
        //   3. Single openSync + fstatSync closes the TOCTOU window
        //      (P2). All subsequent ops use the file descriptor, not
        //      the path.
        const safeRoot = realpathSync(resolvePath(options.largeFilesDir));
        const realTarget = realpathSync(resolvePath(file.storageUri));
        const safeRootOk =
          realTarget === safeRoot || realTarget.startsWith(safeRoot + pathSep);
        if (safeRootOk) {
          const fd = openSync(realTarget, "r");
          try {
            const stat = fstatSync(fd);
            if (stat.size <= maxBytes) {
              content = readFileSync(fd, "utf8");
            } else {
              // Read just the head. Wave-3 P1 fix: scan back from the
              // cap to the last UTF-8 codepoint boundary so we don't
              // emit U+FFFD mojibake from a split multi-byte sequence.
              const buf = Buffer.alloc(maxBytes);
              readSync(fd, buf, 0, maxBytes, 0);
              let safeEnd = maxBytes;
              while (safeEnd > 0) {
                const b = buf[safeEnd - 1];
                if ((b & 0x80) === 0) break;             // ASCII
                if ((b & 0xc0) === 0xc0) { safeEnd -= 1; break; } // start byte
                safeEnd -= 1;                             // continuation
                if (maxBytes - safeEnd > 4) break;        // bounded
              }
              content = buf.subarray(0, safeEnd).toString("utf8");
              contentTruncated = true;
            }
          } finally {
            try { closeSync(fd); } catch { /* fd already closed */ }
          }
        }
      } catch {
        // Disk read failed (file missing on disk after orphaning, perm
        // denied, realpath rejected). Fall back to metadata-only.
        content = null;
      }
    }
    if (options?.expandFile === true && content == null) {
      // v4.2 migrated rows keep the original payload in `messages.content`
      // while adding `messages.large_content = file_xxx`. If the backing
      // file is missing or its path no longer validates, recover the
      // payload from the message row so drilldown remains lossless.
      const migratedMessage = await this.conversationStore.getMessageByLargeContent(id);
      if (migratedMessage && typeof migratedMessage.content === "string") {
        content = migratedMessage.content;
        contentTruncated = false;
      }
    }

    return {
      id,
      type: "file",
      file: {
        conversationId: file.conversationId,
        fileName: file.fileName,
        mimeType: file.mimeType,
        byteSize: file.byteSize,
        storageUri: file.storageUri,
        explorationSummary: file.explorationSummary,
        createdAt: file.createdAt,
        ...(content !== null ? { content, contentTruncated } : {}),
      },
    };
  }

  // ── grep ─────────────────────────────────────────────────────────────────

  /**
   * Search compacted history using regex or full-text search.
   *
   * Depending on `scope`, searches messages, summaries, or both (in parallel).
   */
  async grep(input: GrepInput): Promise<GrepResult> {
    const { query, mode, scope, conversationId, conversationIds, since, before, limit, sort } = input;

    const searchInput = { query, mode, conversationId, conversationIds, since, before, limit, sort };

    let messages: MessageSearchResult[] = [];
    let summaries: SummarySearchResult[] = [];

    if (scope === "messages") {
      messages = await this.conversationStore.searchMessages(searchInput);
    } else if (scope === "summaries") {
      summaries = await this.summaryStore.searchSummaries(searchInput);
    } else {
      // scope === "both" — run in parallel
      [messages, summaries] = await Promise.all([
        this.conversationStore.searchMessages(searchInput),
        this.summaryStore.searchSummaries(searchInput),
      ]);
    }

    return {
      messages,
      summaries,
      totalMatches: messages.length + summaries.length,
    };
  }

  // ── expand ───────────────────────────────────────────────────────────────

  /**
   * Expand a summary to its children and/or source messages.
   *
   * - Condensed summaries: returns child summaries, recursing up to `depth`.
   * - Leaf summaries with `includeMessages`: fetches the source messages.
   * - Respects `tokenCap` and sets `truncated` when the cap is exceeded.
   */
  async expand(input: ExpandInput): Promise<ExpandResult> {
    const depth = input.depth ?? 1;
    const includeMessages = input.includeMessages ?? false;
    const tokenCap = input.tokenCap ?? Infinity;

    const result: ExpandResult = {
      children: [],
      messages: [],
      estimatedTokens: 0,
      truncated: false,
    };

    await this.expandRecursive(input.summaryId, depth, includeMessages, tokenCap, result);

    return result;
  }

  private async expandRecursive(
    summaryId: string,
    depth: number,
    includeMessages: boolean,
    tokenCap: number,
    result: ExpandResult,
  ): Promise<void> {
    if (depth <= 0) {
      return;
    }
    if (result.truncated) {
      return;
    }

    const summary = await this.summaryStore.getSummary(summaryId);
    if (!summary) {
      return;
    }

    if (summary.kind === "condensed") {
      // IMPORTANT: a condensed summary is linked to the summaries that were
      // compacted into it via summary_parents(summary_id, parent_summary_id).
      // For expansion/replay we need to walk those source summaries, not newer
      // summaries that may later derive from this node.
      const children = await this.summaryStore.getSummaryParents(summaryId);

      for (const child of children) {
        if (result.truncated) {
          break;
        }

        // Check if adding this child would exceed the token cap
        if (result.estimatedTokens + child.tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.children.push({
          summaryId: child.summaryId,
          kind: child.kind,
          content: child.content,
          tokenCount: child.tokenCount,
        });
        result.estimatedTokens += child.tokenCount;

        // Recurse into children if depth allows
        if (depth > 1) {
          await this.expandRecursive(child.summaryId, depth - 1, includeMessages, tokenCap, result);
        }
      }
    } else if (summary.kind === "leaf" && includeMessages) {
      // Leaf summary — fetch source messages
      const messageIds = await this.summaryStore.getSummaryMessages(summaryId);

      for (const msgId of messageIds) {
        if (result.truncated) {
          break;
        }

        const msg = await this.conversationStore.getMessageById(msgId);
        if (!msg) {
          continue;
        }

        const tokenCount = msg.tokenCount || estimateTokens(msg.content);

        if (result.estimatedTokens + tokenCount > tokenCap) {
          result.truncated = true;
          break;
        }

        result.messages.push({
          messageId: msg.messageId,
          role: msg.role,
          content: msg.content,
          tokenCount,
        });
        result.estimatedTokens += tokenCount;
      }
    }
  }
}
