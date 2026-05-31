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

func TestLoadFocusBriefsPopulatesActiveDiagnostics(t *testing.T) {
	t.Parallel()

	dbPath := setupFocusBriefsTestDB(t, true)
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open sqlite db: %v", err)
	}
	defer db.Close()

	if _, err := db.Exec(`
		INSERT INTO conversations (conversation_id, session_id, session_key)
		VALUES (11, 'session-active-focus', 'agent:main:telegram:direct:active-focus');

		INSERT INTO messages (message_id, conversation_id, seq, role, content, token_count, created_at)
		VALUES
			(101, 11, 0, 'user', 'before focus', 5, '2026-05-15 00:00:00'),
			(102, 11, 1, 'assistant', 'covered by focus', 6, '2026-05-15 00:01:00'),
			(103, 11, 2, 'user', 'after focus', 13, '2026-05-16 00:00:00');

		INSERT INTO summaries (summary_id, conversation_id, kind, depth, content, token_count, latest_at, created_at)
		VALUES
			('summary_active', 11, 'condensed', 1, 'active before focus', 25, '2026-05-15 00:01:00', '2026-05-15 00:02:00'),
			('summary_delta', 11, 'leaf', 0, 'new post-focus summary', 9, '2026-05-16 00:00:00', '2026-05-16 00:01:00');

		INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, summary_id, created_at)
		VALUES (11, 0, 'summary', NULL, 'summary_delta', '2026-05-16 00:02:00');

		INSERT INTO focus_briefs (
			brief_id, conversation_id, session_key, prompt, content, status,
			token_count, target_tokens, covered_latest_at, covered_message_seq,
			source_context_hash, raw_result_json, created_at, updated_at
		) VALUES (
			'focus_active', 11, 'agent:main:telegram:direct:active-focus',
			'agent configuration', 'Active focus content.', 'active',
			7000, 12000, '2026-05-15 00:01:00', 1,
			'old-source-hash', '{"truncated":true}',
			'2026-05-15 20:00:00', '2026-05-15 20:01:00'
		);
	`); err != nil {
		t.Fatalf("seed active focus diagnostics: %v", err)
	}

	briefs, err := loadFocusBriefs(dbPath, "session-active-focus")
	if err != nil {
		t.Fatalf("load focus briefs: %v", err)
	}
	if len(briefs) != 1 {
		t.Fatalf("brief count = %d, want 1", len(briefs))
	}
	brief := briefs[0]
	if brief.postFocusMessageCount != 1 || brief.postFocusSummaryCount != 1 || brief.postFocusTokenCount != 22 {
		t.Fatalf("unexpected focus deltas: %#v", brief)
	}
	if !brief.stale || !brief.truncated || !brief.sourceContextChanged {
		t.Fatalf("expected stale truncated obsolete brief: %#v", brief)
	}
	active, err := loadActiveFocusBrief(dbPath, "session-active-focus")
	if err != nil {
		t.Fatalf("load active focus brief: %v", err)
	}
	if active == nil || active.briefID != "focus_active" {
		t.Fatalf("active focus = %#v, want focus_active", active)
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
		height:           40,
		focusBriefCursor: 0,
		focusBriefs: []focusBriefEntry{
			{
				briefID:               "focus_new",
				prompt:                "alpha auth review",
				content:               "## Focused Narrative\nAlpha auth is ready.",
				status:                "draft",
				tokenCount:            25,
				targetTokens:          100,
				createdAt:             "2026-05-16 01:00:00",
				updatedAt:             "2026-05-16 01:02:00",
				generatorRunID:        "run-new",
				generatorSessionKey:   "agent:main:subagent:new",
				sourceCount:           1,
				citedCount:            1,
				expandedCount:         1,
				postFocusMessageCount: 1,
				postFocusSummaryCount: 1,
				postFocusTokenCount:   20,
				stale:                 true,
				truncated:             true,
				sourceContextChanged:  true,
				citedSummaryIDs:       []string{"summary_active"},
				expandedSummaryIDs:    []string{"summary_leaf"},
				preview:               "Alpha auth is ready.",
			},
		},
	}

	rendered := m.renderFocusBriefs()
	for _, want := range []string{
		"focus_new",
		"alpha auth review",
		"Focus brief: focus_new [draft]",
		"Sources: active=1 cited=1 expanded=1 irrelevant=0",
		"Delta since focus: 1 messages, 1 summaries, ~20 tokens",
		"Stale: yes  Truncated: yes  Source snapshot: obsolete",
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
			covered_latest_at TEXT,
			covered_message_seq INTEGER,
			source_context_hash TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL,
			updated_at TEXT NOT NULL,
			generator_run_id TEXT,
			generator_session_key TEXT,
			raw_result_json TEXT,
			error TEXT
		);
		CREATE TABLE focus_brief_sources (
			brief_id TEXT NOT NULL,
			summary_id TEXT NOT NULL,
			ordinal INTEGER,
			role TEXT NOT NULL
		);
		CREATE TABLE messages (
			message_id INTEGER PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			seq INTEGER NOT NULL,
			role TEXT NOT NULL,
			content TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			created_at TEXT NOT NULL
		);
		CREATE TABLE summaries (
			summary_id TEXT PRIMARY KEY,
			conversation_id INTEGER NOT NULL,
			kind TEXT NOT NULL,
			depth INTEGER NOT NULL,
			content TEXT NOT NULL,
			token_count INTEGER NOT NULL,
			latest_at TEXT,
			created_at TEXT NOT NULL
		);
		CREATE TABLE context_items (
			conversation_id INTEGER NOT NULL,
			ordinal INTEGER NOT NULL,
			item_type TEXT NOT NULL,
			message_id INTEGER,
			summary_id TEXT,
			created_at TEXT NOT NULL
		);
	`); err != nil {
		t.Fatalf("create focus schema: %v", err)
	}
	return dbPath
}
