package main

import (
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestLoadSessionBatchIncludesEstimatedTokens(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "session-1.jsonl")
	content := `{"type":"message","id":"1","message":{"role":"user","content":"hello"}}` + "\n" +
		`{"type":"message","id":"2","message":{"role":"assistant","content":"world"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write session file: %v", err)
	}

	files := []sessionFileEntry{
		{
			filename:  "session-1.jsonl",
			path:      path,
			updatedAt: time.Unix(1700000000, 0),
			byteSize:  int64(len(content)),
		},
	}

	sessions, _, err := loadSessionBatch(files, 0, 1, filepath.Join(dir, "missing.db"))
	if err != nil {
		t.Fatalf("load session batch: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].estimatedTokens != len(content)/4 {
		t.Fatalf("expected estimated tokens %d, got %d", len(content)/4, sessions[0].estimatedTokens)
	}
}

func TestLoadSessionBatchIncludesConversationMetadata(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "session-1.jsonl")
	content := `{"type":"message","id":"1","message":{"role":"user","content":"hello"}}` + "\n"
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatalf("write session file: %v", err)
	}

	dbPath := filepath.Join(dir, "lcm.db")
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
		INSERT INTO conversations (conversation_id, session_id, session_key) VALUES
			(1, 'session-1', 'agent:main:old'),
			(2, 'session-1', 'agent:main:latest');
	`); err != nil {
		t.Fatalf("seed conversations: %v", err)
	}

	files := []sessionFileEntry{
		{
			filename:  "session-1.jsonl",
			path:      path,
			updatedAt: time.Unix(1700000000, 0),
			byteSize:  int64(len(content)),
		},
	}

	sessions, _, err := loadSessionBatch(files, 0, 1, dbPath)
	if err != nil {
		t.Fatalf("load session batch: %v", err)
	}
	if len(sessions) != 1 {
		t.Fatalf("expected 1 session, got %d", len(sessions))
	}
	if sessions[0].conversationID != 2 {
		t.Fatalf("expected latest conversation id 2, got %d", sessions[0].conversationID)
	}
	if sessions[0].sessionKey != "agent:main:latest" {
		t.Fatalf("expected session key %q, got %q", "agent:main:latest", sessions[0].sessionKey)
	}
}

func TestEstimateTokenCountFromBytes(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name     string
		bytes    int64
		expected int
	}{
		{"zero", 0, 0},
		{"negative", -1, 0},
		{"small", 100, 25},
		{"large", 240_000_000, 60_000_000},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := estimateTokenCountFromBytes(tc.bytes)
			if got != tc.expected {
				t.Errorf("estimateTokenCountFromBytes(%d) = %d, want %d", tc.bytes, got, tc.expected)
			}
		})
	}
}

func TestRenderSessionsShowsSessionKeyAndEstimatedTokens(t *testing.T) {
	t.Parallel()

	m := model{
		width:         160,
		height:        10,
		sessionCursor: 0,
		sessions: []sessionEntry{
			{
				id:              "session-1",
				sessionKey:      "agent:main:main",
				filename:        "session-1.jsonl",
				updatedAt:       time.Unix(1700000000, 0),
				messageCount:    2,
				estimatedTokens: 123,
			},
		},
	}

	rendered := m.renderSessions()
	if !strings.Contains(rendered, "session-1") {
		t.Fatalf("expected session id in rendered sessions, got: %q", rendered)
	}
	if !strings.Contains(rendered, "key:agent:main:main") {
		t.Fatalf("expected session key in rendered sessions, got: %q", rendered)
	}
	if !strings.Contains(rendered, "est:123t") {
		t.Fatalf("expected estimated token label in rendered sessions, got: %q", rendered)
	}
}

func TestRenderSessionsAlignsColumns(t *testing.T) {
	t.Parallel()

	m := model{
		width:         180,
		height:        10,
		sessionCursor: -1,
		sessions: []sessionEntry{
			{
				id:              "short",
				sessionKey:      "agent:main:main",
				updatedAt:       time.Unix(1700000000, 0),
				messageCount:    2,
				estimatedTokens: 123,
				conversationID:  42,
				summaryCount:    3,
				fileCount:       1,
			},
			{
				id:              "much-longer-session-id",
				sessionKey:      "agent:main:subagent:abcdef1234567890",
				updatedAt:       time.Unix(1700001000, 0),
				messageCount:    25,
				estimatedTokens: 4567,
				conversationID:  314,
				summaryCount:    12,
				fileCount:       8,
			},
		},
	}

	lines := strings.Split(m.renderSessions(), "\n")
	if len(lines) != 2 {
		t.Fatalf("expected 2 rendered lines, got %d", len(lines))
	}

	msgs0 := strings.Index(lines[0], "msgs:")
	msgs1 := strings.Index(lines[1], "msgs:")
	if msgs0 <= 0 || msgs1 <= 0 || msgs0 != msgs1 {
		t.Fatalf("expected msgs column to align, got %d and %d\n%s\n%s", msgs0, msgs1, lines[0], lines[1])
	}

	est0 := strings.Index(lines[0], "est:")
	est1 := strings.Index(lines[1], "est:")
	if est0 <= 0 || est1 <= 0 || est0 != est1 {
		t.Fatalf("expected est column to align, got %d and %d\n%s\n%s", est0, est1, lines[0], lines[1])
	}

	conv0 := strings.Index(lines[0], "conv_id:")
	conv1 := strings.Index(lines[1], "conv_id:")
	if conv0 <= 0 || conv1 <= 0 || conv0 != conv1 {
		t.Fatalf("expected conv_id column to align, got %d and %d\n%s\n%s", conv0, conv1, lines[0], lines[1])
	}
}

func TestRenderHeaderShowsSessionKeyInConversationView(t *testing.T) {
	t.Parallel()

	m := model{
		screen:        screenConversation,
		sessionCursor: 0,
		sessions: []sessionEntry{
			{
				id:             "session-1",
				sessionKey:     "agent:main:main",
				conversationID: 42,
			},
		},
	}

	rendered := m.renderHeader()
	if !strings.Contains(rendered, "session:session-1") {
		t.Fatalf("expected session id in conversation header, got: %q", rendered)
	}
	if !strings.Contains(rendered, "key:agent:main:main") {
		t.Fatalf("expected session key in conversation header, got: %q", rendered)
	}
	if !strings.Contains(rendered, "conv_id:42") {
		t.Fatalf("expected conversation id in conversation header, got: %q", rendered)
	}
}
