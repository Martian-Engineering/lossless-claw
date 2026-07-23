import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openReadOnlyDatabase } from "../src/cli/database.js";
import {
  getConversationDiagnostics,
  getGlobalStatus,
  listConversations,
  resolveConversation,
} from "../src/cli/queries.js";
import { runLcmMigrations } from "../src/db/migration.js";

let directory: string;
let databasePath: string;

function seedFixture(): void {
  const db = new DatabaseSync(databasePath);
  runLcmMigrations(db, { fts5Available: false });

  db.exec(`
    INSERT INTO conversations (
      conversation_id, session_id, session_key, active, archived_at, title,
      bootstrapped_at, created_at, updated_at
    ) VALUES
      (1, 'session-old', 'agent:main:shared', 0, '2026-07-03T00:00:00.000Z', 'Old',
       NULL, '2026-07-01T00:00:00.000Z', '2026-07-10T00:00:00.000Z'),
      (2, 'session-live', 'agent:main:shared', 1, NULL, 'Live',
       '2026-07-02T01:00:00.000Z', '2026-07-02T00:00:00.000Z', '2026-07-10T00:00:00.000Z'),
      (3, 'session-other', 'agent:main:other', 1, NULL, 'Other',
       NULL, '2026-07-03T00:00:00.000Z', '2026-07-10T00:00:00.000Z');

    INSERT INTO messages (
      message_id, conversation_id, seq, role, content, token_count, created_at
    ) VALUES
      (10, 2, 1, 'user', 'first message', 100, '2026-07-02T02:00:00.000Z'),
      (11, 2, 2, 'assistant', 'second message', 50, '2026-07-02T03:00:00.000Z'),
      (12, 3, 1, 'user', 'other message', 20, '2026-07-03T02:00:00.000Z');

    INSERT INTO summaries (
      summary_id, conversation_id, kind, depth, content, token_count,
      earliest_at, latest_at, descendant_count, descendant_token_count,
      source_message_token_count, created_at, file_ids, model
    ) VALUES
      ('sum-leaf', 2, 'leaf', 0, 'leaf summary', 30,
       '2026-07-02T02:00:00.000Z', '2026-07-02T02:00:00.000Z', 1, 100, 150,
       '2026-07-02T04:00:00.000Z', '[]', 'summary-model'),
      ('sum-root', 2, 'condensed', 1, 'root summary', 10,
       '2026-07-02T02:00:00.000Z', '2026-07-02T03:00:00.000Z', 2, 150, 0,
       '2026-07-02T05:00:00.000Z', '[]', 'summary-model');

    INSERT INTO summary_messages (summary_id, message_id, ordinal)
      VALUES ('sum-leaf', 10, 0);
    INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
      VALUES ('sum-root', 'sum-leaf', 0);
    INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
      VALUES (2, 0, 'summary', 'sum-root');
    INSERT INTO context_items (conversation_id, ordinal, item_type, message_id)
      VALUES (2, 1, 'message', 11);

    INSERT INTO conversation_compaction_telemetry (
      conversation_id, last_observed_cache_read, last_observed_cache_write,
      last_observed_prompt_token_count, cache_state, retention, provider, model, updated_at
    ) VALUES (2, 40, 4, 600, 'cold', 'short', 'provider-a', 'model-a',
      '2026-07-02T06:00:00.000Z');

    INSERT INTO conversation_compaction_maintenance (
      conversation_id, pending, requested_at, reason, running,
      token_budget, current_token_count, projected_token_count,
      raw_tokens_outside_tail, context_threshold, context_threshold_source,
      last_failure_summary, updated_at
    ) VALUES (2, 1, '2026-07-02T06:00:00.000Z', 'threshold', 0,
      1000, 600, 650, 150, 0.75, 'default', 'previous failure',
      '2026-07-02T06:00:00.000Z');

    INSERT INTO focus_briefs (
      brief_id, conversation_id, session_key, prompt, content, status,
      token_count, target_tokens, source_context_hash, created_at, updated_at
    ) VALUES ('brief-active', 2, 'agent:main:shared', 'focus prompt', 'focus content',
      'active', 20, 40, 'focus-hash', '2026-07-02T07:00:00.000Z',
      '2026-07-02T07:00:00.000Z');

    INSERT INTO large_files (
      file_id, conversation_id, file_name, mime_type, byte_size, storage_uri,
      exploration_summary, created_at
    ) VALUES ('file-1', 2, 'notes.txt', 'text/plain', 1024, '/files/notes.txt',
      'file summary', '2026-07-02T08:00:00.000Z');
  `);
  db.close();
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "lcm-cli-conversations-"));
  databasePath = join(directory, "lcm.db");
  seedFixture();
});

afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});

describe("getGlobalStatus", () => {
  it("reports deterministic database-wide counts and token totals", () => {
    const db = openReadOnlyDatabase(databasePath);
    const status = getGlobalStatus(db);
    db.close();

    expect(status).toMatchObject({
      conversations: { total: 3, active: 2 },
      messages: {
        count: 3,
        tokens: 170,
        earliestAt: "2026-07-02T02:00:00.000Z",
        latestAt: "2026-07-03T02:00:00.000Z",
      },
      summaries: {
        count: 2,
        tokens: 40,
        sourceMessageTokens: 150,
        earliestAt: "2026-07-02T02:00:00.000Z",
        latestAt: "2026-07-02T03:00:00.000Z",
      },
      context: { items: 2, tokens: 60 },
      maintenance: { pending: 1, running: 0, failed: 1 },
    });
    expect(status.summaries.byDepth).toEqual([
      { kind: "leaf", depth: 0, count: 1, tokens: 30 },
      { kind: "condensed", depth: 1, count: 1, tokens: 10 },
    ]);
  });
});

describe("conversation selection and pagination", () => {
  it("prefers the active conversation for a reused session key", () => {
    const db = openReadOnlyDatabase(databasePath);
    const selected = resolveConversation(db, {
      kind: "sessionKey",
      value: "agent:main:shared",
    });
    db.close();
    expect(selected).toMatchObject({ conversationId: 2, sessionId: "session-live", active: true });
  });

  it("keyset-paginates equal timestamps without gaps or duplicates", () => {
    const db = openReadOnlyDatabase(databasePath);
    const first = listConversations(db, { limit: 2, freshTailCount: 1 });
    const second = listConversations(db, {
      limit: 2,
      freshTailCount: 1,
      cursor: first.pagination.nextCursor ?? undefined,
    });
    db.close();

    expect(first.items.map((item) => item.conversationId)).toEqual([3, 2]);
    expect(first.pagination).toMatchObject({ returned: 2, hasMore: true });
    expect(second.items.map((item) => item.conversationId)).toEqual([1]);
    expect(second.pagination).toMatchObject({ returned: 1, hasMore: false, nextCursor: null });
    expect(first.items[1]).toMatchObject({
      messageCount: 2,
      messageTokens: 150,
      summaryCount: 2,
      summaryTokens: 40,
      contextItems: 2,
      contextTokens: 60,
      freshTailMessages: 1,
      freshTailTokens: 50,
      maxSummaryDepth: 1,
    });
  });
});

describe("getConversationDiagnostics", () => {
  it("returns compaction, focus, file, context, and depth diagnostics", () => {
    const db = openReadOnlyDatabase(databasePath);
    const diagnostics = getConversationDiagnostics(
      db,
      { kind: "conversationId", value: 2 },
      { freshTailCount: 1 },
    );
    db.close();

    expect(diagnostics.conversation).toMatchObject({
      conversationId: 2,
      freshTailMessages: 1,
      freshTailTokens: 50,
    });
    expect(diagnostics.summaryDepths).toEqual([
      { kind: "leaf", depth: 0, count: 1, tokens: 30 },
      { kind: "condensed", depth: 1, count: 1, tokens: 10 },
    ]);
    expect(diagnostics.context).toEqual([
      { itemType: "summary", count: 1, tokens: 10 },
      { itemType: "message", count: 1, tokens: 50 },
    ]);
    expect(diagnostics.telemetry).toMatchObject({ cacheState: "cold", provider: "provider-a" });
    expect(diagnostics.maintenance).toMatchObject({
      pending: true,
      running: false,
      currentTokenCount: 600,
      lastFailureSummary: "previous failure",
    });
    expect(diagnostics.bootstrap).toBeNull();
    expect(diagnostics.focusBriefs).toMatchObject({
      count: 1,
      activeBrief: { briefId: "brief-active", tokenCount: 20 },
    });
    expect(diagnostics.largeFiles).toEqual({
      count: 1,
      bytes: 1024,
      latestAt: "2026-07-02T08:00:00.000Z",
    });
  });
});
