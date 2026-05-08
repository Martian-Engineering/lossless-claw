import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { runLcmMigrations } from "../src/db/migration.js";
import { createLcmDescribeTool } from "../src/tools/lcm-describe-tool.js";
import type { LcmDependencies } from "../src/types.js";

function parseAgentSessionKey(sessionKey: string): { agentId: string; suffix: string } | null {
  const trimmed = sessionKey.trim();
  if (!trimmed.startsWith("agent:")) return null;
  const parts = trimmed.split(":");
  if (parts.length < 3) return null;
  return { agentId: parts[1] ?? "main", suffix: parts.slice(2).join(":") };
}

function makeDeps(overrides?: Partial<LcmDependencies>): LcmDependencies {
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
      maxExpandTokens: 4000,
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
        sizeBytes: 2 * 1024 * 1024,
        startup: "rotate",
        runtime: "rotate",
      },
      summaryMaxOverageFactor: 3,
    },
    complete: vi.fn(),
    callGateway: vi.fn(async () => ({})),
    resolveModel: () => ({ provider: "anthropic", model: "claude-opus-4-5" }),
    getApiKey: async () => undefined,
    requireApiKey: async () => "",
    parseAgentSessionKey,
    isSubagentSessionKey: (sessionKey: string) => sessionKey.includes(":subagent:"),
    normalizeAgentId: (id?: string) => (id?.trim() ? id : "main"),
    buildSubagentSystemPrompt: () => "subagent prompt",
    readLatestAssistantReply: () => undefined,
    ...overrides,
  } as LcmDependencies;
}

function setupDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  runLcmMigrations(db, { fts5Available: false, seedDefaultPrompts: false });
  db.prepare(`INSERT INTO conversations (session_id, session_key) VALUES ('s1', 'agent:main:main')`).run();
  return db;
}

function insertSummary(
  db: DatabaseSync,
  args: {
    summaryId: string;
    kind?: "leaf" | "condensed";
    content: string;
    tokenCount?: number;
    suppressedAt?: string | null;
    sessionKey?: string;
  },
): void {
  db.prepare(
    `INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, session_key, suppressed_at)
     VALUES (?, 1, ?, ?, ?, ?, ?)`,
  ).run(
    args.summaryId,
    args.kind ?? "leaf",
    args.content,
    args.tokenCount ?? Math.ceil(args.content.length / 4),
    args.sessionKey ?? "agent:main:main",
    args.suppressedAt ?? null,
  );
}

let _parentOrdinal = 0;
function insertParent(
  db: DatabaseSync,
  parentSummaryId: string,
  childSummaryId: string,
): void {
  db.prepare(
    `INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal) VALUES (?, ?, ?)`,
  ).run(childSummaryId, parentSummaryId, _parentOrdinal++);
}

function insertMessage(
  db: DatabaseSync,
  args: {
    messageId: number;
    content: string;
    role?: string;
    suppressedAt?: string | null;
    createdAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at, suppressed_at, identity_hash)
     VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    args.messageId,
    args.messageId,
    args.role ?? "user",
    args.content,
    Math.ceil(args.content.length / 4),
    args.createdAt ?? new Date().toISOString(),
    args.suppressedAt ?? null,
    `hash_${args.messageId}`,
  );
}

function linkSummaryMessage(
  db: DatabaseSync,
  summaryId: string,
  messageId: number,
  ordinal = 0,
): void {
  db.prepare(
    `INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES (?, ?, ?)`,
  ).run(summaryId, messageId, ordinal);
}

function buildLcmEngine(db: DatabaseSync, timezone = "UTC") {
  return {
    info: { id: "lcm", name: "LCM", version: "0.0.0" },
    timezone,
    getDb: () => db,
    getRetrieval: () => ({
      grep: vi.fn(),
      expand: vi.fn(),
      describe: async (id: string) => {
        // Minimal describe shim that returns enough to exercise the tool's
        // expansion flag handling. Real RetrievalEngine.describe builds a
        // full subtree manifest; we shortcut to just the immediate row.
        const row = db
          .prepare(
            `SELECT summary_id, conversation_id, session_key, kind, depth, content, token_count, source_message_token_count, descendant_count, descendant_token_count, earliest_at, latest_at, created_at
               FROM summaries WHERE summary_id = ? AND suppressed_at IS NULL`,
          )
          .get(id) as
          | {
              summary_id: string;
              conversation_id: number;
              session_key: string;
              kind: string;
              depth: number;
              content: string;
              token_count: number;
              source_message_token_count: number;
              descendant_count: number;
              descendant_token_count: number;
              earliest_at: string | null;
              latest_at: string | null;
              created_at: string;
            }
          | undefined;
        if (!row) return null;
        const childRows = db
          .prepare(
            `SELECT summary_id FROM summary_parents WHERE parent_summary_id = ?`,
          )
          .all(id) as Array<{ summary_id: string }>;
        return {
          type: "summary" as const,
          summary: {
            summaryId: row.summary_id,
            conversationId: row.conversation_id,
            sessionKey: row.session_key,
            kind: row.kind as "leaf" | "condensed",
            depth: row.depth,
            content: row.content,
            tokenCount: row.token_count,
            sourceMessageTokenCount: row.source_message_token_count,
            descendantCount: row.descendant_count,
            descendantTokenCount: row.descendant_token_count,
            earliestAt: row.earliest_at,
            latestAt: row.latest_at,
            createdAt: row.created_at,
            parentIds: [],
            childIds: childRows.map((r) => r.summary_id),
            subtree: [],
          },
        };
      },
    }),
    getConversationStore: () => ({
      getConversationBySessionId: vi.fn(),
      getConversationBySessionKey: vi.fn(),
      getConversationFamilyIds: vi.fn(async () => [1]),
    }),
  };
}

describe("createLcmDescribeTool — expandChildren flag", () => {
  it("returns first-hop child summaries inline when expandChildren=true", async () => {
    const db = setupDb();
    insertSummary(db, { summaryId: "sum_parent", kind: "condensed", content: "parent summary content" });
    insertSummary(db, { summaryId: "sum_child_a", content: "First child content with race-condition fix details" });
    insertSummary(db, { summaryId: "sum_child_b", content: "Second child content with another concrete topic" });
    insertParent(db, "sum_parent", "sum_child_a");
    insertParent(db, "sum_parent", "sum_child_b");

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      id: "sum_parent",
      conversationId: 1,
      expandChildren: true,
    });
    const text = (r.content[0] as { text: string }).text;
    // Format updated 2026-05-06: now uses colon prefix and explicit status
    // (P4 harness fix — silent empty results were ambiguous).
    expect(text).toContain("expanded children: 2/2");
    expect(text).toContain("First child content with race-condition fix details");
    expect(text).toContain("Second child content with another concrete topic");

    const details = r.details as {
      expansion: { children: Array<{ summaryId: string }>; childrenStatus?: string };
    };
    expect(details.expansion.children).toHaveLength(2);
    expect(details.expansion.childrenStatus).toBe("ok");

    db.close();
  });

  it("filters suppressed children", async () => {
    const db = setupDb();
    insertSummary(db, { summaryId: "sum_parent", kind: "condensed", content: "parent" });
    insertSummary(db, { summaryId: "sum_visible", content: "visible child content" });
    insertSummary(db, {
      summaryId: "sum_suppressed",
      content: "suppressed child content",
      suppressedAt: new Date().toISOString(),
    });
    insertParent(db, "sum_parent", "sum_visible");
    insertParent(db, "sum_parent", "sum_suppressed");

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      id: "sum_parent",
      conversationId: 1,
      expandChildren: true,
    });
    const details = r.details as { expansion: { children: Array<{ summaryId: string }> } };
    expect(details.expansion.children).toHaveLength(1);
    expect(details.expansion.children[0]!.summaryId).toBe("sum_visible");

    db.close();
  });

  it("respects expandChildrenLimit (capped at 50)", async () => {
    // Cap raised 20 → 50 on 2026-05-06 (P5 harness fix). The 5-default
    // was too low for typical 100-msg leaves; new defaults are
    // expandChildrenLimit=20, max=50.
    const db = setupDb();
    insertSummary(db, { summaryId: "sum_parent", kind: "condensed", content: "parent" });
    for (let i = 1; i <= 60; i++) {
      insertSummary(db, { summaryId: `sum_c${i}`, content: `child ${i}` });
      insertParent(db, "sum_parent", `sum_c${i}`);
    }

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      id: "sum_parent",
      conversationId: 1,
      expandChildren: true,
      expandChildrenLimit: 100, // user asks for 100; tool caps at 50
    });
    const details = r.details as {
      expansion: { children: unknown[]; childrenStatus?: string };
    };
    expect(details.expansion.children.length).toBeLessThanOrEqual(50);
    expect(details.expansion.childrenStatus).toBe("capped");

    db.close();
  });

  it("does NOT expand when expandChildren is omitted (default false)", async () => {
    const db = setupDb();
    insertSummary(db, { summaryId: "sum_parent", kind: "condensed", content: "parent" });
    insertSummary(db, { summaryId: "sum_child", content: "child content" });
    insertParent(db, "sum_parent", "sum_child");

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", { id: "sum_parent", conversationId: 1 });
    const details = r.details as { expansion?: { children: unknown[] } };
    // expansion key should not exist or children should be empty
    expect(details.expansion?.children ?? []).toHaveLength(0);
    const text = (r.content[0] as { text: string }).text;
    expect(text).not.toContain("expanded children");

    db.close();
  });
});

describe("createLcmDescribeTool — expandMessages flag", () => {
  it("returns first-hop source messages inline for leaf summaries when expandMessages=true", async () => {
    const db = setupDb();
    insertSummary(db, { summaryId: "sum_leaf", content: "leaf summary text" });
    insertMessage(db, { messageId: 100, content: "First raw message verbatim", role: "user" });
    insertMessage(db, { messageId: 101, content: "Second raw message verbatim", role: "assistant" });
    linkSummaryMessage(db, "sum_leaf", 100, 0);
    linkSummaryMessage(db, "sum_leaf", 101, 1);

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      id: "sum_leaf",
      conversationId: 1,
      expandMessages: true,
    });
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("expanded source messages");
    expect(text).toContain("First raw message verbatim");
    expect(text).toContain("Second raw message verbatim");

    const details = r.details as { expansion: { messages: Array<{ messageId: number }> } };
    expect(details.expansion.messages).toHaveLength(2);

    db.close();
  });

  it("filters suppressed messages", async () => {
    const db = setupDb();
    insertSummary(db, { summaryId: "sum_leaf", content: "leaf" });
    insertMessage(db, { messageId: 100, content: "visible message" });
    insertMessage(db, {
      messageId: 101,
      content: "suppressed message",
      suppressedAt: new Date().toISOString(),
    });
    linkSummaryMessage(db, "sum_leaf", 100, 0);
    linkSummaryMessage(db, "sum_leaf", 101, 1);

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      id: "sum_leaf",
      conversationId: 1,
      expandMessages: true,
    });
    const details = r.details as { expansion: { messages: Array<{ messageId: number }> } };
    expect(details.expansion.messages).toHaveLength(1);
    expect(details.expansion.messages[0]!.messageId).toBe(100);

    db.close();
  });

  it("does NOT expand messages for condensed summaries", async () => {
    const db = setupDb();
    insertSummary(db, {
      summaryId: "sum_condensed",
      kind: "condensed",
      content: "condensed text",
    });
    insertMessage(db, { messageId: 100, content: "raw message" });
    linkSummaryMessage(db, "sum_condensed", 100, 0);

    const tool = createLcmDescribeTool({
      deps: makeDeps(),
      lcm: buildLcmEngine(db) as never,
      sessionKey: "agent:main:main",
    });
    const r = await tool.execute("c", {
      id: "sum_condensed",
      conversationId: 1,
      expandMessages: true,
    });
    const details = r.details as { expansion: { messages: unknown[] } };
    expect(details.expansion.messages).toHaveLength(0);

    db.close();
  });
});
