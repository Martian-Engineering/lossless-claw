/**
 * Shared mock-store fixtures for the LCM integration suites (split from the
 * former monolithic test/lcm-integration.test.ts): in-memory ConversationStore
 * and SummaryStore doubles, ingest/wiring helpers, and summarizer deps.
 */
import { vi } from "vitest";
import type { ConversationStore, MessagePartRecord, MessageRecord, MessageRole } from "../src/store/conversation-store.js";
import type {
  SummaryRecord,
  SummaryStore,
  ContextItemRecord,
  SummaryKind,
  LargeFileRecord,
} from "../src/store/summary-store.js";
import { ContextAssembler } from "../src/assembler.js";
import { CompactionEngine, type CompactionConfig } from "../src/compaction.js";
import { RetrievalEngine } from "../src/retrieval.js";
import { createLcmSummarizeFromLegacyParams, LcmProviderAuthError } from "../src/summarize.js";
import { detectDoctorMarker } from "../src/plugin/lcm-doctor-shared.js";
import type { LcmDependencies } from "../src/types.js";

// ── Mock Store Factories ─────────────────────────────────────────────────────

export function createMockConversationStore() {
  const conversations: any[] = [];
  const messages: MessageRecord[] = [];
  const messageParts: MessagePartRecord[] = [];
  let nextConvId = 1;
  let nextMsgId = 1;
  let nextPartId = 1;

  return {
    withTransaction: vi.fn(async <T>(operation: () => Promise<T> | T): Promise<T> => {
      return await operation();
    }),
    createConversation: vi.fn(async (input: { sessionId: string; title?: string; sessionKey?: string }) => {
      const conv = {
        conversationId: nextConvId++,
        sessionId: input.sessionId,
        sessionKey: input.sessionKey,
        title: input.title ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      conversations.push(conv);
      return conv;
    }),
    getConversation: vi.fn(
      async (id: number) => conversations.find((c) => c.conversationId === id) ?? null,
    ),
    getConversationBySessionId: vi.fn(
      async (sid: string) => conversations.find((c) => c.sessionId === sid) ?? null,
    ),
    getOrCreateConversation: vi.fn(
      async (sid: string, titleOrOpts?: string | { title?: string; sessionKey?: string }) => {
        const opts = typeof titleOrOpts === "string" ? { title: titleOrOpts } : titleOrOpts ?? {};
        if (opts.sessionKey) {
          const byKey = conversations.find((c) => c.sessionKey === opts.sessionKey);
          if (byKey) {
            if (byKey.sessionId !== sid) {
              byKey.sessionId = sid;
            }
            return byKey;
          }
        }
        const existing = conversations.find((c) => c.sessionId === sid);
        if (existing) {
          if (opts.sessionKey && !existing.sessionKey) {
            existing.sessionKey = opts.sessionKey;
          }
          return existing;
        }
        const conv = {
          conversationId: nextConvId++,
          sessionId: sid,
          sessionKey: opts.sessionKey,
          title: opts.title ?? null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        conversations.push(conv);
        return conv;
      },
    ),
    createMessage: vi.fn(
      async (input: {
        conversationId: number;
        seq: number;
        role: MessageRole;
        content: string;
        tokenCount: number;
      }) => {
        const msg: MessageRecord = {
          messageId: nextMsgId++,
          conversationId: input.conversationId,
          seq: input.seq,
          role: input.role,
          content: input.content,
          tokenCount: input.tokenCount,
          createdAt: new Date(),
          largeContent: null,
        };
        messages.push(msg);
        return msg;
      },
    ),
    createMessageParts: vi.fn(
      async (
        messageId: number,
        parts: Array<{
          sessionId: string;
          partType: MessagePartRecord["partType"];
          ordinal: number;
          textContent?: string | null;
          toolCallId?: string | null;
          toolName?: string | null;
          toolInput?: string | null;
          toolOutput?: string | null;
          metadata?: string | null;
        }>,
      ) => {
        for (const part of parts) {
          messageParts.push({
            partId: `part-${nextPartId++}`,
            messageId,
            sessionId: part.sessionId,
            partType: part.partType,
            ordinal: part.ordinal,
            textContent: part.textContent ?? null,
            toolCallId: part.toolCallId ?? null,
            toolName: part.toolName ?? null,
            toolInput: part.toolInput ?? null,
            toolOutput: part.toolOutput ?? null,
            metadata: part.metadata ?? null,
          });
        }
      },
    ),
    getMessages: vi.fn(async (convId: number, opts?: { afterSeq?: number; limit?: number }) => {
      let filtered = messages.filter((m) => m.conversationId === convId);
      if (opts?.afterSeq != null) {
        filtered = filtered.filter((m) => m.seq > opts.afterSeq!);
      }
      filtered.sort((a, b) => a.seq - b.seq);
      if (opts?.limit) {
        filtered = filtered.slice(0, opts.limit);
      }
      return filtered;
    }),
    getMessageById: vi.fn(async (id: number) => messages.find((m) => m.messageId === id) ?? null),
    getMessageParts: vi.fn(async (messageId: number) =>
      messageParts
        .filter((part) => part.messageId === messageId)
        .sort((a, b) => a.ordinal - b.ordinal),
    ),
    getMessageCount: vi.fn(
      async (convId: number) => messages.filter((m) => m.conversationId === convId).length,
    ),
    getMaxSeq: vi.fn(async (convId: number) => {
      const convMsgs = messages.filter((m) => m.conversationId === convId);
      return convMsgs.length > 0 ? Math.max(...convMsgs.map((m) => m.seq)) : 0;
    }),
    searchMessages: vi.fn(
      async (input: {
        query: string;
        mode: string;
        conversationId?: number;
        since?: Date;
        before?: Date;
        limit?: number;
      }) => {
        const limit = input.limit ?? 50;
        let filtered = messages;
        if (input.conversationId != null) {
          filtered = filtered.filter((m) => m.conversationId === input.conversationId);
        }
        if (input.since) {
          filtered = filtered.filter((m) => m.createdAt >= input.since!);
        }
        if (input.before) {
          filtered = filtered.filter((m) => m.createdAt < input.before!);
        }
        // Simple in-memory search: check if content includes the query string
        filtered = filtered.filter((m) => m.content.includes(input.query));
        return filtered
          .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((m) => ({
            messageId: m.messageId,
            conversationId: m.conversationId,
            role: m.role,
            snippet: m.content.slice(0, 100),
            createdAt: m.createdAt,
            rank: 0,
          }));
      },
    ),
    // Expose internals for assertions
    _conversations: conversations,
    _messages: messages,
    _messageParts: messageParts,
  };
}

export function createMockSummaryStore() {
  const summaries: SummaryRecord[] = [];
  const contextItems: ContextItemRecord[] = [];
  const summaryMessages: Array<{ summaryId: string; messageId: number; ordinal: number }> = [];
  const summaryParents: Array<{
    summaryId: string;
    parentSummaryId: string;
    ordinal: number;
  }> = [];
  const largeFiles: LargeFileRecord[] = [];

  const store = {
    withTransaction: vi.fn(async <T>(operation: () => Promise<T> | T): Promise<T> => {
      return await operation();
    }),

    // ── Context items ───────────────────────────────────────────────────

    getContextItems: vi.fn(async (conversationId: number): Promise<ContextItemRecord[]> => {
      return contextItems
        .filter((ci) => ci.conversationId === conversationId)
        .toSorted((a, b) => a.ordinal - b.ordinal);
    }),

    getDistinctDepthsInContext: vi.fn(
      async (
        conversationId: number,
        options?: {
          maxOrdinalExclusive?: number;
        },
      ): Promise<number[]> => {
        const ordinalBound = options?.maxOrdinalExclusive;
        const summaryIds = contextItems
          .filter((ci) => {
            if (ci.conversationId !== conversationId || ci.itemType !== "summary") {
              return false;
            }
            if (typeof ordinalBound === "number" && ci.ordinal >= ordinalBound) {
              return false;
            }
            return typeof ci.summaryId === "string";
          })
          .map((ci) => ci.summaryId as string);
        const distinctDepths = new Set<number>();
        for (const summaryId of summaryIds) {
          const summary = summaries.find((candidate) => candidate.summaryId === summaryId);
          if (!summary) {
            continue;
          }
          distinctDepths.add(summary.depth);
        }
        return [...distinctDepths].toSorted((a, b) => a - b);
      },
    ),

    appendContextMessage: vi.fn(
      async (conversationId: number, messageId: number): Promise<void> => {
        const existing = contextItems.filter((ci) => ci.conversationId === conversationId);
        const maxOrdinal = existing.length > 0 ? Math.max(...existing.map((ci) => ci.ordinal)) : -1;
        contextItems.push({
          conversationId,
          ordinal: maxOrdinal + 1,
          itemType: "message",
          messageId,
          summaryId: null,
          createdAt: new Date(),
        });
      },
    ),

    appendContextSummary: vi.fn(
      async (conversationId: number, summaryId: string): Promise<void> => {
        const existing = contextItems.filter((ci) => ci.conversationId === conversationId);
        const maxOrdinal = existing.length > 0 ? Math.max(...existing.map((ci) => ci.ordinal)) : -1;
        contextItems.push({
          conversationId,
          ordinal: maxOrdinal + 1,
          itemType: "summary",
          messageId: null,
          summaryId,
          createdAt: new Date(),
        });
      },
    ),

    replaceContextRangeWithSummary: vi.fn(
      async (input: {
        conversationId: number;
        startOrdinal: number;
        endOrdinal: number;
        summaryId: string;
      }): Promise<void> => {
        const { conversationId, startOrdinal, endOrdinal, summaryId } = input;

        // Remove items in the range [startOrdinal, endOrdinal]
        const toRemoveIndices: number[] = [];
        for (let i = contextItems.length - 1; i >= 0; i--) {
          const ci = contextItems[i];
          if (
            ci.conversationId === conversationId &&
            ci.ordinal >= startOrdinal &&
            ci.ordinal <= endOrdinal
          ) {
            toRemoveIndices.push(i);
          }
        }
        // Remove in reverse order so indices remain valid
        for (const idx of toRemoveIndices) {
          contextItems.splice(idx, 1);
        }

        // Insert replacement summary item at startOrdinal
        contextItems.push({
          conversationId,
          ordinal: startOrdinal,
          itemType: "summary",
          messageId: null,
          summaryId,
          createdAt: new Date(),
        });

        // Resequence: sort by ordinal then reassign dense ordinals 0..n-1
        const convItems = contextItems
          .filter((ci) => ci.conversationId === conversationId)
          .toSorted((a, b) => a.ordinal - b.ordinal);

        // Remove all conversation items, re-add with new ordinals
        for (let i = contextItems.length - 1; i >= 0; i--) {
          if (contextItems[i].conversationId === conversationId) {
            contextItems.splice(i, 1);
          }
        }
        for (let i = 0; i < convItems.length; i++) {
          convItems[i].ordinal = i;
          contextItems.push(convItems[i]);
        }
      },
    ),

    getContextTokenCount: vi.fn(async (conversationId: number): Promise<number> => {
      const items = contextItems.filter((ci) => ci.conversationId === conversationId);
      let total = 0;
      for (const item of items) {
        if (item.itemType === "message" && item.messageId != null) {
          // Look up the message's tokenCount from the conversation store
          // We need access to messages, but since the mock stores are created separately,
          // we store a reference to the message token counts here via a lookup helper
          const msgTokenCount = store._getMessageTokenCount(item.messageId);
          total += msgTokenCount;
        } else if (item.itemType === "summary" && item.summaryId != null) {
          const summary = summaries.find((s) => s.summaryId === item.summaryId);
          if (summary) {
            total += summary.tokenCount;
          }
        }
      }
      return total;
    }),

    // ── Summary CRUD ────────────────────────────────────────────────────

    insertSummary: vi.fn(
      async (input: {
        summaryId: string;
        conversationId: number;
        kind: SummaryKind;
        depth?: number;
        content: string;
        tokenCount: number;
        fileIds?: string[];
        earliestAt?: Date;
        latestAt?: Date;
        descendantCount?: number;
        descendantTokenCount?: number;
        sourceMessageTokenCount?: number;
        model?: string;
      }): Promise<SummaryRecord> => {
        const summary: SummaryRecord = {
          summaryId: input.summaryId,
          conversationId: input.conversationId,
          kind: input.kind,
          depth: input.depth ?? (input.kind === "leaf" ? 0 : 1),
          content: input.content,
          tokenCount: input.tokenCount,
          fileIds: input.fileIds ?? [],
          earliestAt: input.earliestAt ?? null,
          latestAt: input.latestAt ?? null,
          descendantCount: input.descendantCount ?? 0,
          descendantTokenCount: input.descendantTokenCount ?? 0,
          sourceMessageTokenCount: input.sourceMessageTokenCount ?? 0,
          model: input.model ?? "",
          createdAt: new Date(),
        };
        summaries.push(summary);
        return summary;
      },
    ),

    getSummary: vi.fn(async (summaryId: string): Promise<SummaryRecord | null> => {
      return summaries.find((s) => s.summaryId === summaryId) ?? null;
    }),

    getSummariesByConversation: vi.fn(async (conversationId: number): Promise<SummaryRecord[]> => {
      return summaries
        .filter((s) => s.conversationId === conversationId)
        .toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    }),

    // ── Lineage ─────────────────────────────────────────────────────────

    linkSummaryToMessages: vi.fn(async (summaryId: string, messageIds: number[]): Promise<void> => {
      for (let i = 0; i < messageIds.length; i++) {
        summaryMessages.push({
          summaryId,
          messageId: messageIds[i],
          ordinal: i,
        });
      }
    }),

    linkSummaryToParents: vi.fn(
      async (summaryId: string, parentSummaryIds: string[]): Promise<void> => {
        for (let i = 0; i < parentSummaryIds.length; i++) {
          summaryParents.push({
            summaryId,
            parentSummaryId: parentSummaryIds[i],
            ordinal: i,
          });
        }
      },
    ),

    getSummaryMessages: vi.fn(async (summaryId: string): Promise<number[]> => {
      return summaryMessages
        .filter((sm) => sm.summaryId === summaryId)
        .toSorted((a, b) => a.ordinal - b.ordinal)
        .map((sm) => sm.messageId);
    }),

    getSummaryParents: vi.fn(async (summaryId: string): Promise<SummaryRecord[]> => {
      const parentIds = new Set(
        summaryParents
          .filter((sp) => sp.summaryId === summaryId)
          .toSorted((a, b) => a.ordinal - b.ordinal)
          .map((sp) => sp.parentSummaryId),
      );
      return summaries.filter((s) => parentIds.has(s.summaryId));
    }),

    getSummaryChildren: vi.fn(async (parentSummaryId: string): Promise<SummaryRecord[]> => {
      const childIds = new Set(
        summaryParents
          .filter((sp) => sp.parentSummaryId === parentSummaryId)
          .toSorted((a, b) => a.ordinal - b.ordinal)
          .map((sp) => sp.summaryId),
      );
      return summaries.filter((s) => childIds.has(s.summaryId));
    }),

    getSummarySubtree: vi.fn(async (rootSummaryId: string) => {
      const root = summaries.find((summary) => summary.summaryId === rootSummaryId);
      if (!root) {
        return [];
      }
      const output: Array<
        SummaryRecord & {
          depthFromRoot: number;
          parentSummaryId: string | null;
          path: string;
          childCount: number;
        }
      > = [];
      const queue: Array<{
        summaryId: string;
        parentSummaryId: string | null;
        depthFromRoot: number;
        path: string;
      }> = [{ summaryId: rootSummaryId, parentSummaryId: null, depthFromRoot: 0, path: "" }];
      const seen = new Set<string>();
      while (queue.length > 0) {
        const current = queue.shift();
        if (!current || seen.has(current.summaryId)) {
          continue;
        }
        seen.add(current.summaryId);
        const summary = summaries.find((candidate) => candidate.summaryId === current.summaryId);
        if (!summary) {
          continue;
        }
        const children = summaryParents
          .filter((edge) => edge.parentSummaryId === current.summaryId)
          .toSorted((a, b) => a.ordinal - b.ordinal);
        output.push({
          ...summary,
          depthFromRoot: current.depthFromRoot,
          parentSummaryId: current.parentSummaryId,
          path: current.path,
          childCount: children.length,
        });
        for (const child of children) {
          queue.push({
            summaryId: child.summaryId,
            parentSummaryId: current.summaryId,
            depthFromRoot: current.depthFromRoot + 1,
            path:
              current.path === ""
                ? `${String(child.ordinal).padStart(4, "0")}`
                : `${current.path}.${String(child.ordinal).padStart(4, "0")}`,
          });
        }
      }
      return output;
    }),

    // ── Search ──────────────────────────────────────────────────────────

    searchSummaries: vi.fn(
      async (input: {
        query: string;
        mode: string;
        conversationId?: number;
        since?: Date;
        before?: Date;
        limit?: number;
      }) => {
        const limit = input.limit ?? 50;
        let filtered = summaries;
        if (input.conversationId != null) {
          filtered = filtered.filter((s) => s.conversationId === input.conversationId);
        }
        if (input.since) {
          filtered = filtered.filter((s) => s.createdAt >= input.since!);
        }
        if (input.before) {
          filtered = filtered.filter((s) => s.createdAt < input.before!);
        }
        // Simple in-memory search
        filtered = filtered.filter((s) => s.content.includes(input.query));
        return filtered
          .toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
          .slice(0, limit)
          .map((s) => ({
            summaryId: s.summaryId,
            conversationId: s.conversationId,
            kind: s.kind,
            snippet: s.content.slice(0, 100),
            createdAt: s.createdAt,
            rank: 0,
          }));
      },
    ),

    // ── Large files ─────────────────────────────────────────────────────

    getLargeFile: vi.fn(async (fileId: string): Promise<LargeFileRecord | null> => {
      return largeFiles.find((f) => f.fileId === fileId) ?? null;
    }),

    insertLargeFile: vi.fn(async (input: any): Promise<LargeFileRecord> => {
      const file: LargeFileRecord = {
        fileId: input.fileId,
        conversationId: input.conversationId,
        fileName: input.fileName ?? null,
        mimeType: input.mimeType ?? null,
        byteSize: input.byteSize ?? null,
        lineCount: input.lineCount ?? null,
        storageUri: input.storageUri,
        explorationSummary: input.explorationSummary ?? null,
        createdAt: new Date(),
      };
      largeFiles.push(file);
      return file;
    }),

    getLargeFilesByConversation: vi.fn(
      async (conversationId: number): Promise<LargeFileRecord[]> => {
        return largeFiles.filter((f) => f.conversationId === conversationId);
      },
    ),

    // ── Internal helpers for the mock ────────────────────────────────────

    /** Callback used by getContextTokenCount to look up message tokens. */
    _getMessageTokenCount: (_messageId: number): number => 0,

    // Expose internals for assertions
    _summaries: summaries,
    _contextItems: contextItems,
    _summaryMessages: summaryMessages,
    _summaryParents: summaryParents,
    _largeFiles: largeFiles,
  };

  return store;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Rough token estimate matching the one used in the production code. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const rec = block as { text?: unknown };
      return typeof rec.text === "string" ? rec.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

export const CONV_ID = 1;

/**
 * Ingest N messages into the mock stores, simulating what LcmContextEngine.ingest does:
 * 1. createMessage in the conversation store
 * 2. appendContextMessage in the summary store
 *
 * Returns the created MessageRecords.
 */
export async function ingestMessages(
  convStore: ReturnType<typeof createMockConversationStore>,
  sumStore: ReturnType<typeof createMockSummaryStore>,
  count: number,
  opts?: {
    conversationId?: number;
    contentFn?: (i: number) => string;
    roleFn?: (i: number) => MessageRole;
    tokenCountFn?: (i: number, content: string) => number;
  },
): Promise<MessageRecord[]> {
  const conversationId = opts?.conversationId ?? CONV_ID;
  const records: MessageRecord[] = [];
  const existingConversation = await convStore.getConversation(conversationId);
  if (!existingConversation) {
    await convStore.createConversation({
      sessionId: `session-${conversationId}`,
    });
  }

  for (let i = 0; i < count; i++) {
    const content = opts?.contentFn ? opts.contentFn(i) : `Message ${i}`;
    const role: MessageRole = opts?.roleFn ? opts.roleFn(i) : i % 2 === 0 ? "user" : "assistant";
    const tokenCount = opts?.tokenCountFn ? opts.tokenCountFn(i, content) : estimateTokens(content);

    const msg = await convStore.createMessage({
      conversationId,
      seq: i + 1,
      role,
      content,
      tokenCount,
    });

    await sumStore.appendContextMessage(conversationId, msg.messageId);
    records.push(msg);
  }

  return records;
}

/**
 * Wire up the summary store's getContextTokenCount so it can look up
 * message token counts from the conversation store.
 */
export function wireStores(
  convStore: ReturnType<typeof createMockConversationStore>,
  sumStore: ReturnType<typeof createMockSummaryStore>,
) {
  sumStore._getMessageTokenCount = (messageId: number): number => {
    const msg = convStore._messages.find((m) => m.messageId === messageId);
    return msg?.tokenCount ?? 0;
  };
}

// ── Default compaction config ────────────────────────────────────────────────

export const defaultCompactionConfig: CompactionConfig = {
  contextThreshold: 0.75,
  freshTailCount: 4,
  leafMinFanout: 8,
  condensedMinFanout: 4,
  condensedMinFanoutHard: 2,
  incrementalMaxDepth: 0,
  leafTargetTokens: 600,
  condensedTargetTokens: 900,
  maxRounds: 10,
  summaryMaxOverageFactor: 3,
};

export function makeSummarizeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
  return {
    config: {
      enabled: true,
      databasePath: ":memory:",
      ignoreSessionPatterns: [],
      statelessSessionPatterns: [],
      skipStatelessSessions: true,
      contextThreshold: 0.75,
      freshTailCount: 8,
      newSessionRetainDepth: 2,
      leafMinFanout: 8,
      condensedMinFanout: 4,
      condensedMinFanoutHard: 2,
      incrementalMaxDepth: 0,
      leafChunkTokens: 20_000,
      leafTargetTokens: 600,
      condensedTargetTokens: 900,
      maxExpandTokens: 120,
      largeFileTokenThreshold: 25_000,
      summaryProvider: "",
      summaryModel: "",
      largeFileSummaryProvider: "",
      largeFileSummaryModel: "",
      timezone: "UTC",
      pruneHeartbeatOk: false,
      transcriptGcEnabled: false,
      proactiveThresholdCompactionMode: "deferred",
      autoRotateSessionFiles: {
        enabled: true,
        createBackups: false,
        sizeBytes: 2 * 1024 * 1024,
        startup: "rotate",
        runtime: "rotate",
      },
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(async () => ({
      content: [{ type: "text", text: "summary output" }],
    })),
    callGateway: vi.fn(async () => ({})),
    resolveModel: vi.fn(() => ({
      provider: "anthropic",
      model: "claude-opus-4-5",
    })),
    parseAgentSessionKey: vi.fn(() => null),
    isSubagentSessionKey: vi.fn(() => false),
    normalizeAgentId: vi.fn(() => "main"),
    buildSubagentSystemPrompt: vi.fn(() => ""),
    readLatestAssistantReply: vi.fn(() => undefined),
    resolveAgentDir: vi.fn(() => "/tmp/openclaw-agent"),
    resolveSessionIdFromSessionKey: vi.fn(async () => undefined),
    agentLaneSubagent: "subagent",
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  } as LcmDependencies;
}

// ═════════════════════════════════════════════════════════════════════════════
// Test Suite: Ingest -> Assemble
// ═════════════════════════════════════════════════════════════════════════════

