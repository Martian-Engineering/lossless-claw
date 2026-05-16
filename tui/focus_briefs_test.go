package main

import (
	"database/sql"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadFocusBriefsReturnsConversationBriefs(t *testing.T) {
	t.Parallel()

	dbPath := setupFocusBriefsTestDB(t, true)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		INSERT INTO conversations (conversation_id, session_id, session_key)
		VALUES (9, 'session-focus', 'agent:main:telegram:direct:focus');

		INSERT INTO focus_briefs (
			brief_id, conversation_id, session_key, prompt, content, status,
			token_count, target_tokens, created_at, updated_at, generator_run_id,
			generator_session_key
		) VALUES
			('focus_old', 9, 'agent:main:telegram:direct:focus', 'old prompt',
			 'Old content', 'superseded', 10, 100, '2026-05-15 20:00:00',
			 '2026-05-15 20:01:00', 'run-old', 'agent:main:subagent:old'),
			('focus_new', 9, 'agent:main:telegram:direct:focus', 'alpha auth review',
			 '## Focused Narrative\nAlpha auth is ready.', 'draft', 25, 100,
			 '2026-05-16 01:00:00', '2026-05-16 01:02:00',
			 'run-new', 'agent:main:subagent:new');

		INSERT INTO focus_brief_sources (brief_id, summary_id, ordinal, role)
		VALUES
			('focus_new', 'summary_active', 0, 'active_input'),
			('focus_new', 'summary_active', 0, 'cited'),
			('focus_new', 'summary_leaf', NULL, 'expanded'),
			('focus_new', 'summary_noise', NULL, 'irrelevant');
	`); err != nil {
		t.Fatalf("seed focus briefs: %v", err)
	}

	briefs, err := loadFocusBriefs(dbPath, "session-focus")
	if err != nil {
		t.Fatalf("load focus briefs: %v", err)
	}
	if len(briefs) != 2 {
		t.Fatalf("brief count = %d, want 2", len(briefs))
	}
	latest := briefs[0]
	if latest.briefID != "focus_new" {
		t.Fatalf("latest brief = %s, want focus_new", latest.briefID)
	}
	if latest.sourceCount != 1 || latest.citedCount != 1 || latest.expandedCount != 1 || latest.irrelevantCount != 1 {
		t.Fatalf("unexpected source counts: %#v", latest)
	}
	if got := strings.Join(latest.citedSummaryIDs, ","); got != "summary_active" {
		t.Fatalf("cited IDs = %q", got)
	}
	if !strings.Contains(latest.preview, "Alpha auth is ready") {
		t.Fatalf("preview = %q", latest.preview)
	}
}

func TestLoadFocusBriefsTreatsMissingFocusTablesAsEmpty(t *testing.T) {
	t.Parallel()

	dbPath := setupFocusBriefsTestDB(t, false)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		INSERT INTO conversations (conversation_id, session_id, session_key)
		VALUES (10, 'session-no-focus', NULL);
	`); err != nil {
		t.Fatalf("seed conversation: %v", err)
	}

	briefs, err := loadFocusBriefs(dbPath, "session-no-focus")
	if err != nil {
		t.Fatalf("load focus briefs: %v", err)
	}
	if len(briefs) != 0 {
		t.Fatalf("brief count = %d, want 0", len(briefs))
	}
}

func TestRenderFocusBriefsShowsListAndDetail(t *testing.T) {
	t.Parallel()

	m := model{
		width:            120,
		height:           32,
		focusBriefCursor: 0,
		focusBriefs: []focusBriefEntry{
			{
				briefID:             "focus_new",
				prompt:              "alpha auth review",
				content:             "## Focused Narrative\nAlpha auth is ready.",
				status:              "draft",
				tokenCount:          25,
				targetTokens:        100,
				createdAt:           "2026-05-16 01:00:00",
				updatedAt:           "2026-05-16 01:02:00",
				generatorRunID:      "run-new",
				generatorSessionKey: "agent:main:subagent:new",
				sourceCount:         1,
				citedCount:          1,
				expandedCount:       1,
				citedSummaryIDs:     []string{"summary_active"},
				expandedSummaryIDs:  []string{"summary_leaf"},
				preview:             "Alpha auth is ready.",
			},
		},
	}

	rendered := m.renderFocusBriefs()
	for _, want := range []string{
		"focus_new",
		"alpha auth review",
		"Focus brief: focus_new [draft]",
		"Sources: active=1 cited=1 expanded=1 irrelevant=0",
		"Cited: summary_active",
		"Expanded: summary_leaf",
		"Alpha auth is ready.",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("expected rendered focus view to contain %q, got:\n%s", want, rendered)
		}
	}
}

func setupFocusBriefsTestDB(t *testing.T, withFocusTables bool) string {
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
	`); err != nil {
		t.Fatalf("create conversations schema: %v", err)
	}
	if !withFocusTables {
		return dbPath
	}
	if _, err := db.Exec(`
		CREATE TABLE focus_briefs (
			brief_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			session_key TEXT,
			prompt TEXT NOT NULL,
			content TEXT NOT NULL,
			status TEXT NOT NULL,
			token_count INTEGER NOT NULL DEFAULT 0,
			target_tokens INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			generator_run_id TEXT,
			generator_session_key TEXT,
			error TEXT
		);
		CREATE TABLE focus_brief_sources (
			brief_id TEXT NOT NULL,
			summary_id TEXT NOT NULL,
			ordinal INTEGER,
			role TEXT NOT NULL
		);
	`); err != nil {
		t.Fatalf("create focus schema: %v", err)
	}
	return dbPath
}
