package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackfillImportCreatesConversationMessagesAndContext(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	input := backfillSessionInput{
		agent:       "agent-a",
		sessionID:   "session-import",
		title:       "Imported Session",
		messages:    makeBackfillMessages(6),
		sessionPath: "/tmp/session-import.jsonl",
	}

	result, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("apply backfill import: %v", err)
	}
	if !result.imported {
		t.Fatalf("expected import to run")
	}
	if result.messageCount != len(input.messages) {
		t.Fatalf("imported message count mismatch: got=%d want=%d", result.messageCount, len(input.messages))
	}

	assertCount(t, db, `SELECT COUNT(*) FROM conversations WHERE session_id = 'session-import'`, 1)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM messages WHERE conversation_id = ?`, len(input.messages), result.conversationID)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM context_items WHERE conversation_id = ? AND item_type = 'message'`, len(input.messages), result.conversationID)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM message_parts mp JOIN messages m ON m.message_id = mp.message_id WHERE m.conversation_id = ?`, len(input.messages), result.conversationID)
}

func TestBackfillDryRunMakesNoWrites(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	agent := "agent-dryrun"
	sessionID := "session-dryrun"
	agentSessions := filepath.Join(home, ".openclaw", "agents", agent, "sessions")
	if err := os.MkdirAll(agentSessions, 0o755); err != nil {
		t.Fatalf("create sessions dir: %v", err)
	}

	sessionPath := filepath.Join(agentSessions, sessionID+".jsonl")
	if err := os.WriteFile(sessionPath, []byte(backfillSessionJSONL(4)), 0o644); err != nil {
		t.Fatalf("write session jsonl: %v", err)
	}

	dbPath := filepath.Join(home, ".openclaw", "lcm.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	setupBackfillTestSchema(t, db)
	db.Close()

	if err := runBackfillCommand([]string{agent, sessionID, "--dry-run"}); err != nil {
		t.Fatalf("run backfill dry-run: %v", err)
	}

	db, err = sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("re-open db: %v", err)
	}
	defer db.Close()

	assertCount(t, db, `SELECT COUNT(*) FROM conversations`, 0)
	assertCount(t, db, `SELECT COUNT(*) FROM messages`, 0)
	assertCount(t, db, `SELECT COUNT(*) FROM summaries`, 0)
	assertCount(t, db, `SELECT COUNT(*) FROM context_items`, 0)
}

func TestBackfillCompactionBuildsHierarchy(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	input := backfillSessionInput{
		agent:       "agent-hierarchy",
		sessionID:   "session-hierarchy",
		title:       "Hierarchy",
		messages:    makeBackfillMessages(10),
		sessionPath: "/tmp/session-hierarchy.jsonl",
	}
	result, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("apply backfill import: %v", err)
	}

	summarizer := &stubBackfillSummarizer{}
	opts := backfillOptions{
		leafChunkTokens:      220,
		leafTargetTokens:     64,
		condensedTargetToken: 96,
		leafFanout:           2,
		condensedFanout:      2,
		hardFanout:           2,
		freshTailCount:       0,
	}
	stats, err := runBackfillCompaction(ctx, db, result.conversationID, opts, summarizer.summarize)
	if err != nil {
		t.Fatalf("run compaction: %v", err)
	}
	if stats.leafPasses == 0 {
		t.Fatalf("expected at least one leaf pass")
	}
	if stats.condensedPasses == 0 {
		t.Fatalf("expected at least one condensed pass")
	}

	assertCountAtLeast(t, db, `SELECT COUNT(*) FROM summaries WHERE conversation_id = ? AND depth = 0`, 1, result.conversationID)
	assertCountAtLeast(t, db, `SELECT COUNT(*) FROM summaries WHERE conversation_id = ? AND depth >= 1`, 1, result.conversationID)
	assertCountAtLeast(t, db, `SELECT COUNT(*) FROM summary_parents sp JOIN summaries s ON s.summary_id = sp.summary_id WHERE s.conversation_id = ?`, 1, result.conversationID)
}

func TestBackfillSingleRootForcedFold(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	mustExec(t, db, `
		INSERT INTO conversations (conversation_id, session_id, title, bootstrapped_at, created_at, updated_at)
		VALUES (42, 'session-root', 'Single Root', datetime('now'), datetime('now'), datetime('now'))
	`)
	mustExec(t, db, `
		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at, file_ids)
		VALUES
			('sum_root_a', 42, 'condensed', 2, 'phase-a', 150, datetime('now', '-2 hour'), '[]'),
			('sum_root_b', 42, 'condensed', 2, 'phase-b', 150, datetime('now', '-1 hour'), '[]')
	`)
	mustExec(t, db, `
		INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
		VALUES
			(42, 0, 'summary', 'sum_root_a', datetime('now', '-2 hour')),
			(42, 1, 'summary', 'sum_root_b', datetime('now', '-1 hour'))
	`)

	summarizer := &stubBackfillSummarizer{}
	opts := backfillOptions{
		singleRoot:           true,
		leafChunkTokens:      400,
		leafTargetTokens:     64,
		condensedTargetToken: 96,
		leafFanout:           2,
		condensedFanout:      3,
		hardFanout:           2,
		freshTailCount:       0,
	}
	stats, err := runBackfillCompaction(ctx, db, 42, opts, summarizer.summarize)
	if err != nil {
		t.Fatalf("run compaction single-root: %v", err)
	}
	if stats.rootFoldPasses == 0 {
		t.Fatalf("expected at least one forced single-root fold pass")
	}

	assertCountQuery(t, db, `SELECT COUNT(*) FROM context_items WHERE conversation_id = ? AND item_type = 'message'`, 0, 42)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM context_items WHERE conversation_id = ? AND item_type = 'summary'`, 1, 42)
}

func TestBackfillTransplantIntegration(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	input := backfillSessionInput{
		agent:       "agent-source",
		sessionID:   "session-source",
		title:       "Source",
		messages:    makeBackfillMessages(8),
		sessionPath: "/tmp/session-source.jsonl",
	}
	importResult, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("apply backfill import: %v", err)
	}
	summarizer := &stubBackfillSummarizer{}
	_, err = runBackfillCompaction(ctx, db, importResult.conversationID, backfillOptions{
		leafChunkTokens:      120,
		leafTargetTokens:     64,
		condensedTargetToken: 96,
		leafFanout:           2,
		condensedFanout:      2,
		hardFanout:           2,
		freshTailCount:       0,
	}, summarizer.summarize)
	if err != nil {
		t.Fatalf("run pre-transplant compaction: %v", err)
	}

	mustExec(t, db, `
		INSERT INTO conversations (conversation_id, session_id, title, bootstrapped_at, created_at, updated_at)
		VALUES (9001, 'target-session', 'Target', datetime('now'), datetime('now'), datetime('now'))
	`)
	mustExec(t, db, `
		INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
		VALUES (9001, 0, 'user', 'target seed', 3, datetime('now'))
	`)
	mustExec(t, db, `
		INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, created_at)
		SELECT 9001, 0, 'message', message_id, datetime('now')
		FROM messages WHERE conversation_id = 9001 AND seq = 0
	`)

	opts := backfillOptions{
		apply:                true,
		transplantTo:         9001,
		hasTransplantTarget:  true,
		leafChunkTokens:      120,
		leafTargetTokens:     64,
		condensedTargetToken: 96,
		leafFanout:           2,
		condensedFanout:      2,
		hardFanout:           2,
		freshTailCount:       0,
	}
	_, _, err = runBackfillWorkflow(ctx, db, opts, input, summarizer.summarize)
	if err != nil {
		t.Fatalf("run workflow with transplant: %v", err)
	}

	assertCountAtLeast(t, db, `SELECT COUNT(*) FROM context_items WHERE conversation_id = 9001 AND item_type = 'summary'`, 1)
	assertCountAtLeast(t, db, `SELECT COUNT(*) FROM summaries WHERE conversation_id = 9001`, 1)
}

func TestBackfillImportIdempotencyGuard(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	input := backfillSessionInput{
		agent:       "agent-idempotent",
		sessionID:   "session-idempotent",
		title:       "Idempotent",
		messages:    makeBackfillMessages(5),
		sessionPath: "/tmp/session-idempotent.jsonl",
	}

	first, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if !first.imported {
		t.Fatalf("expected first import to write rows")
	}

	second, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if second.imported {
		t.Fatalf("expected second import to be skipped by idempotency guard")
	}
	if second.conversationID != first.conversationID {
		t.Fatalf("expected idempotent import to reuse conversation %d, got %d", first.conversationID, second.conversationID)
	}

	assertCount(t, db, `SELECT COUNT(*) FROM conversations WHERE session_id = 'session-idempotent'`, 1)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM messages WHERE conversation_id = ?`, len(input.messages), first.conversationID)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM context_items WHERE conversation_id = ?`, len(input.messages), first.conversationID)
}

func TestBackfillWorkflowExistingImportedSessionSkipsCompactionWithoutRecompact(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	input := backfillSessionInput{
		agent:       "agent-existing",
		sessionID:   "session-existing",
		title:       "Existing Session",
		messages:    makeBackfillMessages(6),
		sessionPath: "/tmp/session-existing.jsonl",
	}
	importResult, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("seed import: %v", err)
	}

	summarizer := &stubBackfillSummarizer{}
	opts := backfillOptions{
		apply:                true,
		leafChunkTokens:      160,
		leafTargetTokens:     64,
		condensedTargetToken: 96,
		leafFanout:           2,
		condensedFanout:      2,
		hardFanout:           2,
		freshTailCount:       0,
	}

	result, stats, err := runBackfillWorkflow(ctx, db, opts, input, summarizer.summarize)
	if err != nil {
		t.Fatalf("run workflow existing session without recompact: %v", err)
	}
	if result.imported {
		t.Fatalf("expected idempotency guard to skip message import")
	}
	if result.conversationID != importResult.conversationID {
		t.Fatalf("expected existing conversation ID %d, got %d", importResult.conversationID, result.conversationID)
	}
	if stats.leafPasses != 0 || stats.condensedPasses != 0 || stats.rootFoldPasses != 0 {
		t.Fatalf("expected no compaction passes without --recompact, got %+v", stats)
	}
	if summarizer.counter != 0 {
		t.Fatalf("expected summarizer not to run without --recompact")
	}

	assertCountQuery(t, db, `SELECT COUNT(*) FROM messages WHERE conversation_id = ?`, len(input.messages), importResult.conversationID)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM context_items WHERE conversation_id = ? AND item_type = 'message'`, len(input.messages), importResult.conversationID)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM summaries WHERE conversation_id = ?`, 0, importResult.conversationID)
}

func TestBackfillWorkflowRecompactSingleRootOnExistingSession(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	mustExec(t, db, `
		INSERT INTO conversations (conversation_id, session_id, title, bootstrapped_at, created_at, updated_at)
		VALUES (77, 'session-recompact', 'Recompact Session', datetime('now'), datetime('now'), datetime('now'))
	`)
	mustExec(t, db, `
		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at, file_ids)
		VALUES
			('sum_recompact_a', 77, 'condensed', 2, 'phase-a', 120, datetime('now', '-2 hour'), '[]'),
			('sum_recompact_b', 77, 'condensed', 2, 'phase-b', 120, datetime('now', '-1 hour'), '[]')
	`)
	mustExec(t, db, `
		INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
		VALUES
			(77, 0, 'summary', 'sum_recompact_a', datetime('now', '-2 hour')),
			(77, 1, 'summary', 'sum_recompact_b', datetime('now', '-1 hour'))
	`)

	input := backfillSessionInput{
		agent:       "agent-recompact",
		sessionID:   "session-recompact",
		title:       "Recompact Session",
		messages:    makeBackfillMessages(5),
		sessionPath: "/tmp/session-recompact.jsonl",
	}
	summarizer := &stubBackfillSummarizer{}
	opts := backfillOptions{
		apply:                true,
		recompact:            true,
		singleRoot:           true,
		leafChunkTokens:      300,
		leafTargetTokens:     64,
		condensedTargetToken: 96,
		leafFanout:           2,
		condensedFanout:      3,
		hardFanout:           2,
		freshTailCount:       0,
	}

	result, stats, err := runBackfillWorkflow(ctx, db, opts, input, summarizer.summarize)
	if err != nil {
		t.Fatalf("run workflow with recompact single-root: %v", err)
	}
	if result.imported {
		t.Fatalf("expected idempotency guard to skip message import")
	}
	if stats.rootFoldPasses == 0 {
		t.Fatalf("expected forced single-root fold pass with --recompact and --single-root")
	}
	if summarizer.counter == 0 {
		t.Fatalf("expected compaction summarizer to run")
	}

	assertCountQuery(t, db, `SELECT COUNT(*) FROM messages WHERE conversation_id = ?`, 0, 77)
	assertCountQuery(t, db, `SELECT COUNT(*) FROM context_items WHERE conversation_id = ? AND item_type = 'summary'`, 1, 77)
}

type stubBackfillSummarizer struct {
	counter int
}

func (s *stubBackfillSummarizer) summarize(_ context.Context, _ string, targetTokens int) (string, error) {
	s.counter++
	if targetTokens <= 0 {
		targetTokens = 64
	}
	// Keep output length proportional to target so compaction token thresholds
	// are exercised in tests.
	return fmt.Sprintf("summary-%d %s", s.counter, strings.Repeat("x", targetTokens*4)), nil
}

func makeBackfillMessages(n int) []backfillMessage {
	messages := make([]backfillMessage, 0, n)
	start := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	for i := 0; i < n; i++ {
		messages = append(messages, backfillMessage{
			seq:       i,
			role:      []string{"user", "assistant"}[i%2],
			content:   strings.Repeat(fmt.Sprintf("message-%d ", i), 10),
			createdAt: start.Add(time.Duration(i) * time.Minute).Format("2006-01-02 15:04:05"),
		})
	}
	return messages
}

func backfillSessionJSONL(n int) string {
	start := time.Date(2026, time.January, 1, 10, 0, 0, 0, time.UTC)
	lines := make([]string, 0, n)
	for i := 0; i < n; i++ {
		role := "user"
		if i%2 == 1 {
			role = "assistant"
		}
		lines = append(lines, fmt.Sprintf(`{"type":"message","id":"msg_%d","timestamp":"%s","message":{"role":"%s","content":[{"type":"text","text":"message %d text"}]}}`, i, start.Add(time.Duration(i)*time.Minute).Format(time.RFC3339), role, i))
	}
	return strings.Join(lines, "\n") + "\n"
}

func newBackfillTestDB(t *testing.T) *sql.DB {
	t.Helper()
	name := strings.ReplaceAll(strings.ToLower(t.Name()), "/", "_")
	dsn := fmt.Sprintf("file:%s?mode=memory&cache=shared", name)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	setupBackfillTestSchema(t, db)
	return db
}

func setupBackfillTestSchema(t *testing.T, db *sql.DB) {
	t.Helper()
	mustExec(t, db, `PRAGMA foreign_keys = ON`)
	mustExec(t, db, `
		CREATE TABLE IF NOT EXISTS conversations (
			conversation_id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL,
			title TEXT,
			bootstrapped_at TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			updated_at TEXT NOT NULL DEFAULT (datetime('now'))
		);

		CREATE TABLE IF NOT EXISTS messages (
			message_id INTEGER PRIMARY KEY AUTOINCREMENT,
			conversation_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			created_at TEXT NOT NULL,
			UNIQUE (conversation_id, seq)
		);

		CREATE TABLE IF NOT EXISTS summaries (
			summary_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			depth INTEGER NOT NULL DEFAULT 0,
			content TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			earliest_at TEXT,
			latest_at TEXT,
			descendant_count INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			file_ids TEXT NOT NULL DEFAULT '[]'
		);

		CREATE TABLE IF NOT EXISTS message_parts (
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

		CREATE TABLE IF NOT EXISTS summary_messages (
			summary_id TEXT NOT NULL,
			message_id INTEGER NOT NULL,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (summary_id, message_id)
		);

		CREATE TABLE IF NOT EXISTS summary_parents (
			summary_id TEXT NOT NULL,
			parent_summary_id TEXT NOT NULL,
			ordinal INTEGER NOT NULL,
			PRIMARY KEY (summary_id, parent_summary_id)
		);

		CREATE TABLE IF NOT EXISTS context_items (
			conversation_id INTEGER NOT NULL,
			ordinal INTEGER NOT NULL,
			item_type TEXT NOT NULL,
			message_id INTEGER,
			summary_id TEXT,
			created_at TEXT NOT NULL DEFAULT (datetime('now')),
			PRIMARY KEY (conversation_id, ordinal)
		);

		CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(content);
	`)
}

func assertCountAtLeast(t *testing.T, db *sql.DB, query string, min int, args ...any) {
	t.Helper()
	var got int
	if err := db.QueryRow(query, args...).Scan(&got); err != nil {
		t.Fatalf("query count failed: %v\nquery:\n%s", err, query)
	}
	if got < min {
		t.Fatalf("count mismatch: got=%d min=%d\nquery:\n%s", got, min, query)
	}
}

func assertCountQuery(t *testing.T, db *sql.DB, query string, want int, args ...any) {
	t.Helper()
	var got int
	if err := db.QueryRow(query, args...).Scan(&got); err != nil {
		t.Fatalf("query count failed: %v\nquery:\n%s", err, query)
	}
	if got != want {
		t.Fatalf("count mismatch: got=%d want=%d\nquery:\n%s", got, want, query)
	}
}
