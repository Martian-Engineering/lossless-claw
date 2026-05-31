package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadContextItemsUsesMessagePartsForEmptyMessageContent(t *testing.T) {
	t.Parallel()

	dbPath := setupContextItemsTestDB(t)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		INSERT INTO conversations (conversation_id, session_id, session_key)
		VALUES (7, 'session-context', NULL);

		INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
		VALUES (101, 7, 1, 'assistant', '', 120, '2026-05-14 22:00:00');

		INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_name, tool_input)
		VALUES ('part-101', 101, 'session-context', 'tool', 0, 'supabase.execute_sql',
			'{"query":"select name from companies where status = ''active''"}');

		INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
		VALUES (7, 0, 'message', 101, NULL, '2026-05-14 22:00:00');
	`); err != nil {
		t.Fatalf("seed context item: %v", err)
	}

	items, err := loadContextItems(dbPath, "session-context")
	if err != nil {
		t.Fatalf("load context items: %v", err)
	}
	if len(items) != 1 {
		t.Fatalf("item count = %d, want 1", len(items))
	}

	got := items[0]
	if got.preview == "" {
		t.Fatalf("expected non-empty preview for structured message part")
	}
	if !strings.Contains(got.content, "select name from companies") {
		t.Fatalf("expected rehydrated tool input in content, got %q", got.content)
	}
	if !strings.Contains(got.preview, "Tool input") {
		t.Fatalf("expected labeled tool input in preview, got %q", got.preview)
	}
}

func TestLoadContextItemsAppliesActiveFocusOverlay(t *testing.T) {
	t.Parallel()

	dbPath := setupContextItemsTestDB(t)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		INSERT INTO conversations (conversation_id, session_id, session_key)
		VALUES (8, 'session-focus-context', NULL);

		INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
		VALUES
			(201, 8, 1, 'user', 'covered source one', 4, '2026-05-14 22:00:00'),
			(202, 8, 2, 'assistant', 'covered source two', 4, '2026-05-14 22:01:00'),
			(203, 8, 3, 'user', 'fresh source three', 4, '2026-05-14 22:02:00');

		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at, latest_at)
		VALUES
			('sum_covered_leaf', 8, 'leaf', 0, 'covered leaf summary', 10, '2026-05-14 22:03:00', '2026-05-14 22:00:00'),
			('sum_covered_parent', 8, 'condensed', 1, 'covered parent summary', 20, '2026-05-14 22:04:00', '2026-05-14 22:01:00'),
			('sum_fresh_leaf', 8, 'leaf', 0, 'fresh leaf summary', 30, '2026-05-14 22:05:00', '2026-05-14 22:02:00');

		INSERT INTO summary_messages (summary_id, message_id, ordinal)
		VALUES
			('sum_covered_leaf', 201, 0),
			('sum_fresh_leaf', 203, 0);

		INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
		VALUES ('sum_covered_parent', 'sum_covered_leaf', 0);

		INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
		VALUES
			(8, 0, 'summary', NULL, 'sum_covered_leaf', '2026-05-14 22:03:00'),
			(8, 1, 'summary', NULL, 'sum_covered_parent', '2026-05-14 22:04:00'),
			(8, 2, 'summary', NULL, 'sum_fresh_leaf', '2026-05-14 22:05:00'),
			(8, 3, 'message', 203, NULL, '2026-05-14 22:06:00');

		INSERT INTO focus_briefs (
			brief_id, conversation_id, prompt, content, status, token_count,
			target_tokens, covered_latest_at, covered_message_seq, source_context_hash, created_at
		)
		VALUES (
			'focus_active', 8, 'focus prompt', 'focused context brief', 'active', 5,
			12000, '2026-05-14 22:01:00', 2, 'hash', '2026-05-14 22:07:00'
		);
	`); err != nil {
		t.Fatalf("seed focused context items: %v", err)
	}

	items, err := loadContextItems(dbPath, "session-focus-context")
	if err != nil {
		t.Fatalf("load context items: %v", err)
	}
	if len(items) != 3 {
		t.Fatalf("item count = %d, want 3", len(items))
	}
	if items[0].itemType != "focus_brief" || items[0].focusBriefID != "focus_active" {
		t.Fatalf("first item = %#v, want active focus brief", items[0])
	}
	if !strings.Contains(items[0].content, "<focus_brief") {
		t.Fatalf("focus item should render assembler wrapper, got %q", items[0].content)
	}
	if items[1].summaryID != "sum_fresh_leaf" {
		t.Fatalf("second item summary = %q, want fresh summary", items[1].summaryID)
	}
	if items[2].messageID != 203 {
		t.Fatalf("third item message = %d, want fresh message", items[2].messageID)
	}
	for _, item := range items {
		if item.summaryID == "sum_covered_leaf" || item.summaryID == "sum_covered_parent" {
			t.Fatalf("covered summary %q should be masked by focus brief", item.summaryID)
		}
	}
}

func setupContextItemsTestDB(t *testing.T) string {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "lcm.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		CREATE TABLE conversations (
			conversation_id INTEGER PRIMARY KEY,
			session_id TEXT NOT NULL,
			session_key TEXT
		);
		CREATE TABLE messages (
			message_id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id INTEGER NOT NULL,
			seq INTEGER,
			role TEXT,
			content TEXT,
			token_count INTEGER,
			created_at TEXT
		);
		CREATE TABLE summaries (
			summary_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT,
			depth INTEGER,
			content TEXT,
			token_count INTEGER,
			created_at TEXT,
			latest_at TEXT
		);
		CREATE TABLE summary_messages (
			summary_id TEXT NOT NULL,
			message_id INTEGER NOT NULL,
			ordinal INTEGER
		);
		CREATE TABLE summary_parents (
			summary_id TEXT NOT NULL,
			parent_summary_id TEXT NOT NULL,
			ordinal INTEGER
		);
		CREATE TABLE context_items (
			conversation_id INTEGER NOT NULL,
			ordinal INTEGER NOT NULL,
			item_type TEXT NOT NULL,
			message_id INTEGER,
			summary_id TEXT,
			created_at TEXT
		);
		CREATE TABLE message_parts (
			part_id TEXT PRIMARY KEY,
			message_id INTEGER NOT NULL,
			session_id TEXT NOT NULL,
			part_type TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			text_content TEXT,
			tool_name TEXT,
			tool_input TEXT,
			tool_output TEXT,
			metadata TEXT
		);
		CREATE TABLE focus_briefs (
			brief_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			prompt TEXT NOT NULL,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			token_count INTEGER NOT NULL DEFAULT 0,
			target_tokens INTEGER NOT NULL DEFAULT 0,
			covered_latest_at TEXT,
			covered_message_seq INTEGER,
			source_context_hash TEXT NOT NULL DEFAULT '',
			raw_result_json TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);
	`); err != nil {
		t.Fatalf("create schema: %v", err)
	}
	return dbPath
}
