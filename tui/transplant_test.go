package main

import (
	"context"
	"database/sql"
	"testing"
)

func TestApplyTransplantDeepCopiesMessages(t *testing.T) {
	db, err := sql.Open("sqlite", "file::memory:?cache=shared")
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = ON`); err != nil {
		t.Fatalf("enable foreign keys: %v", err)
	}

	mustExec(t, db, `
		CREATE TABLE conversations (
			conversation_id INTEGER PRIMARY KEY,
			session_id TEXT NOT NULL
		);
		CREATE TABLE summaries (
			summary_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			content TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			file_ids TEXT,
			depth INTEGER NOT NULL
		);
		CREATE TABLE summary_parents (
			summary_id TEXT NOT NULL,
			parent_summary_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL
		);
		CREATE TABLE messages (
			message_id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE (conversation_id, seq)
		);
		CREATE TABLE summary_messages (
			summary_id TEXT NOT NULL,
			message_id INTEGER NOT NULL,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (summary_id, message_id)
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
			is_ignored INTEGER,
			is_synthetic INTEGER,
			tool_call_id TEXT,
			tool_name TEXT,
			tool_status TEXT,
			tool_input TEXT,
			tool_output TEXT,
			tool_error TEXT,
			tool_title TEXT,
			patch_hash TEXT,
			patch_files TEXT,
			file_mime TEXT,
			file_name TEXT,
			file_url TEXT,
			subtask_prompt TEXT,
			subtask_desc TEXT,
			subtask_agent TEXT,
			step_reason TEXT,
			step_cost REAL,
			step_tokens_in INTEGER,
			step_tokens_out INTEGER,
			snapshot_hash TEXT,
			compaction_auto INTEGER,
			metadata TEXT,
			UNIQUE (message_id, ordinal)
		);
		CREATE VIRTUAL TABLE messages_fts USING fts5(content);
	`)

	mustExec(t, db, `
		INSERT INTO conversations (conversation_id, session_id) VALUES
		(1, 'source-session'),
		(2, 'target-session');
	`)
	mustExec(t, db, `
		INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at) VALUES
		(101, 1, 0, 'user', 'source one', 10, '2026-01-01T00:00:00Z'),
		(102, 1, 1, 'assistant', 'source two', 12, '2026-01-01T00:01:00Z'),
		(201, 2, 0, 'user', 'target existing', 7, '2026-01-02T00:00:00Z');
	`)
	mustExec(t, db, `
		INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content) VALUES
		('11111111-1111-4111-8111-111111111111', 101, 'source-session', 'text', 0, 'part A0'),
		('11111111-1111-4111-8111-111111111112', 101, 'source-session', 'text', 1, 'part A1'),
		('22222222-2222-4222-8222-222222222222', 102, 'source-session', 'text', 0, 'part B0');
	`)
	mustExec(t, db, `
		INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, created_at, file_ids, depth) VALUES
		('sum_src_a', 1, 'leaf', 'leaf a', 40, '2026-01-01T00:05:00Z', '', 0),
		('sum_src_b', 1, 'leaf', 'leaf b', 30, '2026-01-01T00:06:00Z', '', 0);
	`)
	mustExec(t, db, `
		INSERT INTO summary_messages (summary_id, message_id, ordinal) VALUES
		('sum_src_a', 101, 0),
		('sum_src_a', 102, 1),
		('sum_src_b', 101, 0);
	`)
	mustExec(t, db, `
		INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id) VALUES
		(1, 0, 'summary', NULL, 'sum_src_a'),
		(1, 1, 'summary', NULL, 'sum_src_b'),
		(2, 0, 'message', 201, NULL);
	`)

	plan, err := buildTransplantPlan(ctx, db, 1, 2)
	if err != nil {
		t.Fatalf("build transplant plan: %v", err)
	}
	if _, err := applyTransplant(ctx, db, plan); err != nil {
		t.Fatalf("apply transplant: %v", err)
	}

	assertCount(t, db, `
		SELECT COUNT(*)
		FROM summary_messages sm
		JOIN summaries s ON s.summary_id = sm.summary_id
		JOIN messages m ON m.message_id = sm.message_id
		WHERE s.conversation_id = 2
		  AND m.conversation_id = 2
	`, 3)
	assertCount(t, db, `
		SELECT COUNT(*)
		FROM summary_messages sm
		JOIN summaries s ON s.summary_id = sm.summary_id
		JOIN messages m ON m.message_id = sm.message_id
		WHERE s.conversation_id = 2
		  AND m.conversation_id != 2
	`, 0)
	assertCount(t, db, `
		SELECT COUNT(*)
		FROM messages
		WHERE conversation_id = 2
		  AND content IN ('source one', 'source two')
	`, 2)
	assertCount(t, db, `
		SELECT COUNT(*)
		FROM message_parts mp
		JOIN messages m ON m.message_id = mp.message_id
		WHERE m.conversation_id = 2
		  AND m.content IN ('source one', 'source two')
	`, 3)
	assertCount(t, db, `
		SELECT COUNT(*)
		FROM message_parts mp
		JOIN messages m ON m.message_id = mp.message_id
		WHERE m.conversation_id = 2
		  AND m.content IN ('source one', 'source two')
		  AND mp.session_id = 'target-session'
	`, 3)
	assertCount(t, db, `
		SELECT COUNT(*)
		FROM messages_fts f
		JOIN messages m ON m.message_id = f.rowid
		WHERE m.conversation_id = 2
		  AND m.content IN ('source one', 'source two')
	`, 2)
}

func mustExec(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	if _, err := db.Exec(query); err != nil {
		t.Fatalf("exec query failed: %v\nquery:\n%s", err, query)
	}
}

func assertCount(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(query).Scan(&got); err != nil {
		t.Fatalf("query count failed: %v\nquery:\n%s", err, query)
	}
	if got != want {
		t.Fatalf("count mismatch: got=%d want=%d\nquery:\n%s", got, want, query)
	}
}
