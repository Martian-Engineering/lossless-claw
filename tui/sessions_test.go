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

func TestLoadSessionBatchResolvesTopicSessionFiles(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	path := filepath.Join(dir, "telegram-runtime-topic-8.jsonl")
	content := `{"type":"message","id":"1","message":{"role":"user","content":"hello topic"}}` + "\n"
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
		CREATE TABLE summaries (
			summary_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL
		);
		CREATE TABLE large_files (
			file_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL
		);
		INSERT INTO conversations (conversation_id, session_id, session_key) VALUES
			(11, 'telegram-runtime', 'telegram-runtime-topic-7'),
			(12, 'telegram-runtime', 'telegram-runtime-topic-8');
		INSERT INTO summaries (summary_id, conversation_id) VALUES
			('sum-topic-7-a', 11),
			('sum-topic-7-b', 11),
			('sum-topic-8-a', 12);
		INSERT INTO large_files (file_id, conversation_id) VALUES
			('file-topic-7-a', 11),
			('file-topic-8-a', 12),
			('file-topic-8-b', 12);
	`); err != nil {
		t.Fatalf("seed topic conversations: %v", err)
	}

	files := []sessionFileEntry{
		{
			filename:  "telegram-runtime-topic-8.jsonl",
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
	if sessions[0].conversationID != 12 {
		t.Fatalf("expected topic conversation id 12, got %d", sessions[0].conversationID)
	}
	if sessions[0].sessionKey != "telegram-runtime-topic-8" {
		t.Fatalf("expected session key %q, got %q", "telegram-runtime-topic-8", sessions[0].sessionKey)
	}
	if sessions[0].summaryCount != 1 {
		t.Fatalf("expected summary count 1, got %d", sessions[0].summaryCount)
	}
	if sessions[0].fileCount != 2 {
		t.Fatalf("expected file count 2, got %d", sessions[0].fileCount)
	}
}

func TestDiscoverSessionFilesDedupesCanonicalSessionIDAndPrefersTopicTranscript(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
	agentDir := filepath.Join(dir, "main")
	sessionsDir := filepath.Join(agentDir, "sessions")
	if err := os.MkdirAll(sessionsDir, 0o755); err != nil {
		t.Fatalf("create sessions dir: %v", err)
	}

	const canonicalID = "fd9b66a7-ebbf-4a7b-8415-b5d366379cd2"
	barePath := filepath.Join(sessionsDir, canonicalID+".jsonl")
	topicPath := filepath.Join(sessionsDir, canonicalID+"-topic-47.jsonl")
	bareContent := `{"type":"session","id":"` + canonicalID + `"}` + "\n" +
		`{"type":"message","id":"1","message":{"role":"user","content":"bare"}}` + "\n"
	topicContent := `{"type":"session","id":"` + canonicalID + `"}` + "\n" +
		`{"type":"message","id":"1","message":{"role":"user","content":"topic"}}` + "\n"
	if err := os.WriteFile(barePath, []byte(bareContent), 0o644); err != nil {
		t.Fatalf("write bare session file: %v", err)
	}
	if err := os.WriteFile(topicPath, []byte(topicContent), 0o644); err != nil {
		t.Fatalf("write topic session file: %v", err)
	}
	now := time.Now()
	if err := os.Chtimes(barePath, now, now); err != nil {
		t.Fatalf("set bare mtime: %v", err)
	}
	if err := os.Chtimes(topicPath, now.Add(-time.Hour), now.Add(-time.Hour)); err != nil {
		t.Fatalf("set topic mtime: %v", err)
	}

	files, err := discoverSessionFiles(agentEntry{name: "main", path: agentDir})
	if err != nil {
		t.Fatalf("discover session files: %v", err)
	}
	if len(files) != 1 {
		t.Fatalf("expected 1 deduped session file, got %d", len(files))
	}
	if files[0].filename != canonicalID+"-topic-47.jsonl" {
		t.Fatalf("expected topic transcript to win, got %q", files[0].filename)
	}
}

func TestLookupConversationIDResolvesTopicSessionFiles(t *testing.T) {
	t.Parallel()

	dir := t.TempDir()
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
			(21, 'telegram-runtime', 'telegram-runtime-topic-7'),
			(22, 'telegram-runtime', 'telegram-runtime-topic-8');
	`); err != nil {
		t.Fatalf("seed conversations: %v", err)
	}

	conversationID, err := lookupConversationID(db, "telegram-runtime-topic-8")
	if err != nil {
		t.Fatalf("lookup conversation id: %v", err)
	}
	if conversationID != 22 {
		t.Fatalf("expected topic conversation id 22, got %d", conversationID)
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
