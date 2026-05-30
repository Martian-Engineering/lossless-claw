package main

import (
	"context"
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBuildLeafRewriteSourceUsesMessagePartsForEmptyMessageContent(t *testing.T) {
	t.Parallel()

	dbPath := setupRewriteSourceTestDB(t)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		INSERT INTO messages (message_id, role, content, created_at)
		VALUES
			(101, 'assistant', '', '2026-05-14 22:00:00'),
			(102, 'tool', '', '2026-05-14 22:00:01');

		INSERT INTO summary_messages (summary_id, message_id, ordinal)
		VALUES
			('sum_broken', 101, 0),
			('sum_broken', 102, 1);
	`); err != nil {
		t.Fatalf("seed messages: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_name, tool_input)
		VALUES ('part-101', 101, 'session-rewrite', 'tool', 0, 'supabase.execute_sql', ?)
	`, `{"query":"select name from companies where status = 'active'"}`); err != nil {
		t.Fatalf("seed assistant part: %v", err)
	}
	if _, err := db.Exec(`
		INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, tool_output)
		VALUES ('part-102', 102, 'session-rewrite', 'tool_result', 0, ?)
	`, `{"content":[{"type":"text","text":"Active company: Acme Robotics"}]}`); err != nil {
		t.Fatalf("seed tool part: %v", err)
	}

	source, err := buildLeafRewriteSource(context.Background(), db, "sum_broken", false, time.UTC)
	if err != nil {
		t.Fatalf("build leaf rewrite source: %v", err)
	}

	if source.itemCount != 2 {
		t.Fatalf("source item count = %d, want 2", source.itemCount)
	}
	if source.label != "messages" {
		t.Fatalf("source label = %q, want messages", source.label)
	}
	if !strings.Contains(source.text, "Tool input") {
		t.Fatalf("expected tool input label in rewrite source, got %q", source.text)
	}
	if !strings.Contains(source.text, "select name from companies") {
		t.Fatalf("expected tool input content in rewrite source, got %q", source.text)
	}
	if !strings.Contains(source.text, "Active company: Acme Robotics") {
		t.Fatalf("expected tool output content in rewrite source, got %q", source.text)
	}
	if strings.Contains(source.text, "(empty)") {
		t.Fatalf("rewrite source should not fall back to empty marker, got %q", source.text)
	}
}

func setupRewriteSourceTestDB(t *testing.T) string {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "lcm.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		CREATE TABLE messages (
			message_id INTEGER PRIMARY KEY,
			role TEXT,
			content TEXT,
			created_at TEXT
		);
		CREATE TABLE summary_messages (
			summary_id TEXT NOT NULL,
			message_id INTEGER NOT NULL,
			ordinal INTEGER NOT NULL
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
			tool_output TEXT
		);
	`); err != nil {
		t.Fatalf("create schema: %v", err)
	}

	return dbPath
}
