package main

import (
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

func TestRenderSessionsShowsEstimatedTokens(t *testing.T) {
	t.Parallel()

	m := model{
		height:        10,
		sessionCursor: 0,
		sessions: []sessionEntry{
			{
				filename:        "session-1.jsonl",
				updatedAt:       time.Unix(1700000000, 0),
				messageCount:    2,
				estimatedTokens: 123,
			},
		},
	}

	rendered := m.renderSessions()
	if !strings.Contains(rendered, "est:123t") {
		t.Fatalf("expected estimated token label in rendered sessions, got: %q", rendered)
	}
}
