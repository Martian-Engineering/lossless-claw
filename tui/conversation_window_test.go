package main

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestLoadLatestConversationWindowReturnsNewestInAscendingOrder(t *testing.T) {
	t.Parallel()

	dbPath := setupConversationWindowTestDB(t)
	seedConversationMessages(t, dbPath, 42, 7)

	page, err := loadLatestConversationWindow(dbPath, 42, 3)
	if err != nil {
		t.Fatalf("load latest window: %v", err)
	}
	assertMessageIDs(t, page.messages, []int64{5, 6, 7})
	if page.oldestMessageID != 5 || page.newestMessageID != 7 {
		t.Fatalf("unexpected page range: oldest=%d newest=%d", page.oldestMessageID, page.newestMessageID)
	}
	if !page.hasOlder {
		t.Fatalf("expected hasOlder=true for latest window")
	}
	if page.hasNewer {
		t.Fatalf("expected hasNewer=false for latest window")
	}
}

func TestConversationWindowPagingBoundaries(t *testing.T) {
	t.Parallel()

	dbPath := setupConversationWindowTestDB(t)
	seedConversationMessages(t, dbPath, 99, 7)

	older, err := loadConversationWindowBefore(dbPath, 99, 5, 3)
	if err != nil {
		t.Fatalf("load older window: %v", err)
	}
	assertMessageIDs(t, older.messages, []int64{2, 3, 4})
	if !older.hasOlder || !older.hasNewer {
		t.Fatalf("expected middle older window to have both directions: older=%t newer=%t", older.hasOlder, older.hasNewer)
	}

	oldest, err := loadConversationWindowBefore(dbPath, 99, 2, 3)
	if err != nil {
		t.Fatalf("load oldest boundary window: %v", err)
	}
	assertMessageIDs(t, oldest.messages, []int64{1})
	if oldest.hasOlder {
		t.Fatalf("expected hasOlder=false at oldest boundary")
	}
	if !oldest.hasNewer {
		t.Fatalf("expected hasNewer=true at oldest boundary")
	}

	newer, err := loadConversationWindowAfter(dbPath, 99, 4, 3)
	if err != nil {
		t.Fatalf("load newer window: %v", err)
	}
	assertMessageIDs(t, newer.messages, []int64{5, 6, 7})
	if !newer.hasOlder {
		t.Fatalf("expected hasOlder=true for newer window")
	}
	if newer.hasNewer {
		t.Fatalf("expected hasNewer=false at newest boundary")
	}
}

func setupConversationWindowTestDB(t *testing.T) string {
	t.Helper()

	dbPath := filepath.Join(t.TempDir(), "lcm.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	if _, err := db.Exec(`
		CREATE TABLE messages (
			message_id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id INTEGER NOT NULL,
			role TEXT,
			content TEXT,
			created_at TEXT
		)
	`); err != nil {
		t.Fatalf("create messages table: %v", err)
	}
	return dbPath
}

func seedConversationMessages(t *testing.T, dbPath string, conversationID int64, count int) {
	t.Helper()

	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	for i := 1; i <= count; i++ {
		if _, err := db.Exec(`
			INSERT INTO messages (conversation_id, role, content, created_at)
			VALUES (?, 'user', ?, ?)
		`, conversationID, "message", "2026-01-01T00:00:00Z"); err != nil {
			t.Fatalf("insert message %d: %v", i, err)
		}
	}
}

func assertMessageIDs(t *testing.T, messages []sessionMessage, expected []int64) {
	t.Helper()

	if len(messages) != len(expected) {
		t.Fatalf("message count mismatch: got=%d want=%d", len(messages), len(expected))
	}
	for idx, want := range expected {
		if messages[idx].messageID != want {
			t.Fatalf("message[%d].messageID = %d, want %d", idx, messages[idx].messageID, want)
		}
	}
}
