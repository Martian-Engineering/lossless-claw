package main

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
	"testing"
)

func TestLoadDoctorTargetsUsesPositionAwareDetection(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	mustExec(t, db, `
		INSERT INTO conversations (conversation_id, session_id, title, created_at, updated_at)
		VALUES (1, 'session-doctor-detect', 'Detect', datetime('now'), datetime('now'))
	`)
	mustExec(t, db, fmt.Sprintf(`
		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at, file_ids)
		VALUES
			('sum_old_real', 1, 'leaf', 0, '%s restored from bug', 64, '2026-03-22T10:00:00Z', '[]'),
			('sum_old_false', 1, 'leaf', 0, 'We discussed %s during the postmortem.', 64, '2026-03-22T10:01:00Z', '[]'),
			('sum_new_real', 1, 'leaf', 0, 'actual summary body %s520 tokens]', 64, '2026-03-22T10:02:00Z', '[]'),
			('sum_new_false', 1, 'leaf', 0, '%s520 tokens] was mentioned earlier in this summary body and then the text continued long after the marker.', 64, '2026-03-22T10:03:00Z', '[]')
	`, doctorOldMarker, doctorOldMarker, doctorNewMarkerPrefix, doctorNewMarkerPrefix))

	conversationID := int64(1)
	targets, err := loadDoctorTargets(ctx, db, &conversationID)
	if err != nil {
		t.Fatalf("loadDoctorTargets: %v", err)
	}

	got := make(map[string]string, len(targets))
	for _, item := range targets {
		got[item.summaryID] = item.markerKind
	}
	if len(got) != 2 {
		t.Fatalf("expected 2 detected targets, got %d", len(got))
	}
	if got["sum_old_real"] != "old" {
		t.Fatalf("expected old marker detection, got %q", got["sum_old_real"])
	}
	if got["sum_new_real"] != "new" {
		t.Fatalf("expected new marker detection, got %q", got["sum_new_real"])
	}
	if _, exists := got["sum_old_false"]; exists {
		t.Fatalf("false-positive old marker was detected")
	}
	if _, exists := got["sum_new_false"]; exists {
		t.Fatalf("false-positive new marker was detected")
	}
}

func TestBuildDoctorPlanOrdersBottomUp(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	seedDoctorConversation(t, db, 7)
	mustExec(t, db, fmt.Sprintf(`
		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at, file_ids)
		VALUES
			('leaf_late', 7, 'leaf', 0, 'late leaf %s520 tokens]', 90, '2026-03-22T10:10:00Z', '[]'),
			('leaf_early', 7, 'leaf', 0, 'early leaf %s520 tokens]', 90, '2026-03-22T10:11:00Z', '[]'),
			('condensed_d1', 7, 'condensed', 1, 'd1 body %s820 tokens]', 140, '2026-03-22T10:12:00Z', '[]'),
			('condensed_d2', 7, 'condensed', 2, 'd2 body %s1200 tokens]', 180, '2026-03-22T10:13:00Z', '[]')
	`, doctorNewMarkerPrefix, doctorNewMarkerPrefix, doctorNewMarkerPrefix, doctorNewMarkerPrefix))
	mustExec(t, db, `
		INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
		VALUES
			(7, 2, 'summary', 'leaf_late', '2026-03-22T10:10:00Z'),
			(7, 1, 'summary', 'leaf_early', '2026-03-22T10:11:00Z')
	`)
	mustExec(t, db, `
		INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
		VALUES
			('condensed_d1', 'leaf_early', 0),
			('condensed_d1', 'leaf_late', 1),
			('condensed_d2', 'condensed_d1', 0)
	`)

	plan, err := buildDoctorPlan(ctx, db, 7)
	if err != nil {
		t.Fatalf("buildDoctorPlan: %v", err)
	}

	got := make([]string, 0, len(plan.ordered))
	for _, item := range plan.ordered {
		got = append(got, item.summaryID)
	}
	want := []string{"leaf_early", "leaf_late", "condensed_d1", "condensed_d2"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("unexpected order: got=%v want=%v", got, want)
	}
}

func TestExecuteDoctorPlanDryRunDoesNotModifyDB(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	seedDoctorConversation(t, db, 11)
	mustExec(t, db, `
		INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
		VALUES
			(111, 11, 0, 'user', 'first message', 4, '2026-03-22T11:00:00Z'),
			(112, 11, 1, 'assistant', 'second message', 4, '2026-03-22T11:01:00Z')
	`)
	mustExec(t, db, fmt.Sprintf(`
		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at, file_ids)
		VALUES
			('leaf_fix', 11, 'leaf', 0, 'broken leaf %s520 tokens]', 90, '2026-03-22T11:10:00Z', '[]'),
			('parent_fix', 11, 'condensed', 1, 'broken parent %s920 tokens]', 150, '2026-03-22T11:11:00Z', '[]')
	`, doctorNewMarkerPrefix, doctorNewMarkerPrefix))
	mustExec(t, db, `
		INSERT INTO summary_messages (summary_id, message_id, ordinal)
		VALUES
			('leaf_fix', 111, 0),
			('leaf_fix', 112, 1)
	`)
	mustExec(t, db, `
		INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
		VALUES ('parent_fix', 'leaf_fix', 0)
	`)
	mustExec(t, db, `
		INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
		VALUES
			(11, 0, 'summary', 'leaf_fix', '2026-03-22T11:10:00Z'),
			(11, 1, 'summary', 'parent_fix', '2026-03-22T11:11:00Z')
	`)

	plan, err := buildDoctorPlan(ctx, db, 11)
	if err != nil {
		t.Fatalf("buildDoctorPlan: %v", err)
	}

	summarizer := &stubDoctorSummarizer{
		results: []string{"rewritten leaf", "rewritten parent"},
	}
	rewritten, err := executeDoctorPlan(ctx, db, plan, doctorOptions{}, summarizer)
	if err != nil {
		t.Fatalf("executeDoctorPlan: %v", err)
	}
	if rewritten != 2 {
		t.Fatalf("unexpected rewritten count: got=%d want=2", rewritten)
	}

	assertSummaryContent(t, db, "leaf_fix", "broken leaf "+doctorNewMarkerPrefix+"520 tokens]")
	assertSummaryContent(t, db, "parent_fix", "broken parent "+doctorNewMarkerPrefix+"920 tokens]")
}

func TestScanDoctorConversationsAggregatesAllConversations(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	seedDoctorConversation(t, db, 21)
	seedDoctorConversation(t, db, 22)
	seedDoctorConversation(t, db, 23)
	mustExec(t, db, fmt.Sprintf(`
		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, created_at, file_ids)
		VALUES
			('conv21_new', 21, 'leaf', 0, 'conv21 %s520 tokens]', 90, '2026-03-22T12:00:00Z', '[]'),
			('conv22_old', 22, 'leaf', 0, '%s standalone corruption', 90, '2026-03-22T12:01:00Z', '[]'),
			('conv23_false', 23, 'leaf', 0, 'This summary talks about %s but is healthy.', 90, '2026-03-22T12:02:00Z', '[]')
	`, doctorNewMarkerPrefix, doctorOldMarker, doctorOldMarker))

	report, err := scanDoctorConversations(ctx, db, nil)
	if err != nil {
		t.Fatalf("scanDoctorConversations: %v", err)
	}
	if report.totalCount != 2 {
		t.Fatalf("unexpected total count: got=%d want=2", report.totalCount)
	}
	if len(report.conversations) != 2 {
		t.Fatalf("unexpected conversation count: got=%d want=2", len(report.conversations))
	}
	if report.oldCount != 1 || report.newCount != 1 {
		t.Fatalf("unexpected marker counts: old=%d new=%d", report.oldCount, report.newCount)
	}
}

type stubDoctorSummarizer struct {
	results []string
	calls   int
}

func (s *stubDoctorSummarizer) summarize(_ context.Context, _ string, _ int) (string, error) {
	result := s.results[s.calls]
	s.calls++
	return result, nil
}

func seedDoctorConversation(t *testing.T, db *sql.DB, conversationID int64) {
	t.Helper()
	mustExec(t, db, fmt.Sprintf(`
		INSERT INTO conversations (conversation_id, session_id, title, created_at, updated_at)
		VALUES (%d, 'session_%d', 'Doctor', datetime('now'), datetime('now'))
	`, conversationID, conversationID))
}

func assertSummaryContent(t *testing.T, db *sql.DB, summaryID, want string) {
	t.Helper()
	var got string
	if err := db.QueryRow(`SELECT content FROM summaries WHERE summary_id = ?`, summaryID).Scan(&got); err != nil {
		t.Fatalf("query summary content: %v", err)
	}
	if got != want {
		t.Fatalf("unexpected summary content for %s: got=%q want=%q", summaryID, got, want)
	}
}
