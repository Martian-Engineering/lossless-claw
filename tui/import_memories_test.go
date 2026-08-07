package main

import (
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseMarkdownConversation_HeadingStyle(t *testing.T) {
	md := "## User\nWhat is Go?\n\n## Assistant\nGo is a programming language.\n\n## User\nTell me more.\n\n## Assistant\nIt was created at Google.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" || msgs[1].role != "assistant" {
		t.Fatalf("unexpected roles: %q, %q", msgs[0].role, msgs[1].role)
	}
	if msgs[0].content != "What is Go?" {
		t.Fatalf("unexpected content: %q", msgs[0].content)
	}
}

func TestParseMarkdownConversation_H4YouChatGPT(t *testing.T) {
	md := "#### You:\nWhat is the best way to learn Go?\n\n#### ChatGPT\nStart with the official tour at tour.golang.org.\n\n#### You:\nThanks!\n\n#### ChatGPT\nYou're welcome.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected user role for 'You:', got %q", msgs[0].role)
	}
	if msgs[1].role != "assistant" {
		t.Fatalf("expected assistant role for 'ChatGPT', got %q", msgs[1].role)
	}
	if msgs[0].content != "What is the best way to learn Go?" {
		t.Fatalf("unexpected content: %q", msgs[0].content)
	}
}

func TestParseMarkdownConversation_BoldHumanAssistant(t *testing.T) {
	md := "**Human:**\nCan you explain closures?\n\n**Assistant:**\nA closure is a function that captures variables from its enclosing scope.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected user role for '**Human:**', got %q", msgs[0].role)
	}
	if msgs[1].role != "assistant" {
		t.Fatalf("expected assistant role for '**Assistant:**', got %q", msgs[1].role)
	}
}

func TestParseMarkdownConversation_SubHeadingStyle(t *testing.T) {
	md := "### Human\nHello\n\n### Assistant\nHi there\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected 'user' role for Human, got %q", msgs[0].role)
	}
}

func TestParseMarkdownConversation_BoldInlineStyle(t *testing.T) {
	md := "**User:** What time is it?\n**Assistant:** I don't have access to a clock.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected user role, got %q", msgs[0].role)
	}
}

func TestParseMarkdownConversation_ClaudeExportStyle(t *testing.T) {
	md := "Human: Can you help me?\n\nAssistant: Of course! What do you need?\n\nHuman: Fix a bug.\n\nAssistant: Sure, show me the code.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected user role for Human:, got %q", msgs[0].role)
	}
	if msgs[1].role != "assistant" {
		t.Fatalf("expected assistant role, got %q", msgs[1].role)
	}
}

func TestParseMarkdownConversation_NoMarkers(t *testing.T) {
	md := "This is just a document with no conversation markers.\nIt has multiple lines.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 fallback message, got %d", len(msgs))
	}
	if msgs[0].role != "assistant" {
		t.Fatalf("expected assistant role for fallback, got %q", msgs[0].role)
	}
}

func TestParseMarkdownConversation_Empty(t *testing.T) {
	msgs := parseMarkdownConversation("")
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for empty input, got %d", len(msgs))
	}
}

func TestParseMarkdownConversation_WhitespaceOnly(t *testing.T) {
	msgs := parseMarkdownConversation("   \n\n\t\n  ")
	if len(msgs) != 0 {
		t.Fatalf("expected 0 messages for whitespace-only input, got %d", len(msgs))
	}
}

func TestParseMarkdownConversation_RoleMappings(t *testing.T) {
	md := "## ChatGPT\nHello\n\n## Claude\nHi\n\n## AI\nHey\n\n## System\nYou are helpful.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 4 {
		t.Fatalf("expected 4 messages, got %d", len(msgs))
	}
	for i, want := range []string{"assistant", "assistant", "assistant", "system"} {
		if msgs[i].role != want {
			t.Fatalf("message %d: expected role %q, got %q", i, want, msgs[i].role)
		}
	}
}

func TestParseMarkdownConversation_YouMapsToUser(t *testing.T) {
	md := "#### You:\nHi\n\n#### ChatGPT\nHello\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected 'You' to map to user, got %q", msgs[0].role)
	}
}

func TestParseMarkdownConversation_PreMarkerContentDiscarded(t *testing.T) {
	md := "# My Chat Export\nSome preamble text.\n\n## User\nActual question.\n\n## Assistant\nActual answer.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (preamble discarded), got %d", len(msgs))
	}
	if msgs[0].content != "Actual question." {
		t.Fatalf("unexpected content: %q", msgs[0].content)
	}
}

func TestParseMarkdownConversation_MultiLineContent(t *testing.T) {
	md := "## User\nFirst paragraph.\n\nSecond paragraph.\n\nThird paragraph.\n\n## Assistant\nResponse here.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if !strings.Contains(msgs[0].content, "First paragraph.") ||
		!strings.Contains(msgs[0].content, "Second paragraph.") ||
		!strings.Contains(msgs[0].content, "Third paragraph.") {
		t.Fatalf("expected multi-paragraph content to be preserved, got %q", msgs[0].content)
	}
}

func TestParseMarkdownConversation_ContentWithCodeBlocks(t *testing.T) {
	md := "## User\nHow do I sort a slice?\n\n## Assistant\nUse `sort.Slice`:\n\n```go\nsort.Slice(s, func(i, j int) bool {\n    return s[i] < s[j]\n})\n```\n\nThat should work.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if !strings.Contains(msgs[1].content, "```go") {
		t.Fatalf("expected code block to be preserved, got %q", msgs[1].content)
	}
	if !strings.Contains(msgs[1].content, "That should work.") {
		t.Fatalf("expected text after code block to be preserved, got %q", msgs[1].content)
	}
}

func TestParseMarkdownConversation_HeadingWithColon(t *testing.T) {
	md := "## User:\nQuestion with colon in heading.\n\n## Assistant:\nAnswer with colon in heading.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected user role, got %q", msgs[0].role)
	}
}

func TestMemorySessionID_Deterministic(t *testing.T) {
	id1 := memorySessionID("chatgpt/some-chat.md")
	id2 := memorySessionID("chatgpt/some-chat.md")
	id3 := memorySessionID("claude/other-chat.md")
	if id1 != id2 {
		t.Fatal("expected same path to produce same session ID")
	}
	if id1 == id3 {
		t.Fatal("expected different paths to produce different session IDs")
	}
	if !strings.HasPrefix(id1, "import:") {
		t.Fatalf("expected 'import:' prefix, got %q", id1)
	}
}

func TestDeriveAgentName(t *testing.T) {
	cases := []struct {
		relPath string
		want    string
	}{
		{"chatgpt/debugging.md", "chatgpt"},
		{"claude/session.md", "claude"},
		{"chatgpt/subfolder/deep-chat.md", "chatgpt"},
		{"root-file.md", "imported"},
		{"openai/nested/very/deep/chat.md", "openai"},
	}
	for _, tc := range cases {
		got := deriveAgentName(tc.relPath)
		if got != tc.want {
			t.Errorf("deriveAgentName(%q) = %q, want %q", tc.relPath, got, tc.want)
		}
	}
}

func TestDiscoverMarkdownFiles(t *testing.T) {
	dir := t.TempDir()
	chatgptDir := filepath.Join(dir, "chatgpt")
	claudeDir := filepath.Join(dir, "claude")
	os.MkdirAll(chatgptDir, 0o755)
	os.MkdirAll(claudeDir, 0o755)
	os.WriteFile(filepath.Join(chatgptDir, "chat1.md"), []byte("## User\nHi"), 0o644)
	os.WriteFile(filepath.Join(chatgptDir, "chat2.md"), []byte("## User\nHello"), 0o644)
	os.WriteFile(filepath.Join(claudeDir, "session.md"), []byte("## User\nHey"), 0o644)
	os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("not a markdown file"), 0o644)

	files, err := discoverMarkdownFiles(dir)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(files) != 3 {
		t.Fatalf("expected 3 .md files, got %d", len(files))
	}
}

func TestDiscoverMarkdownFiles_CaseInsensitiveExtension(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "chat.MD"), []byte("## User\nHi"), 0o644)
	os.WriteFile(filepath.Join(dir, "chat2.Md"), []byte("## User\nHello"), 0o644)

	files, err := discoverMarkdownFiles(dir)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}
	if len(files) != 2 {
		t.Fatalf("expected 2 .md files (case-insensitive), got %d", len(files))
	}
}

func TestImportMemoriesEndToEnd(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	dir := t.TempDir()
	chatgptDir := filepath.Join(dir, "chatgpt")
	os.MkdirAll(chatgptDir, 0o755)

	os.WriteFile(filepath.Join(chatgptDir, "debugging.md"), []byte(
		"## User\nHow do I fix a nil pointer?\n\n## Assistant\nCheck your pointer before dereferencing.\n",
	), 0o644)
	os.WriteFile(filepath.Join(chatgptDir, "refactoring.md"), []byte(
		"## User\nShould I extract this into a function?\n\n## Assistant\nYes, if it's used in multiple places.\n",
	), 0o644)

	files, err := discoverMarkdownFiles(dir)
	if err != nil {
		t.Fatalf("discover: %v", err)
	}

	for _, absPath := range files {
		relPath, _ := filepath.Rel(dir, absPath)
		content, err := os.ReadFile(absPath)
		if err != nil {
			t.Fatalf("read %s: %v", relPath, err)
		}
		messages := parseMarkdownConversation(string(content))
		sessionID := memorySessionID(relPath)

		input := backfillSessionInput{
			agent:       "chatgpt",
			sessionID:   sessionID,
			title:       filepath.Base(relPath),
			sessionPath: absPath,
			messages:    messages,
		}
		result, err := applyBackfillImport(ctx, db, input)
		if err != nil {
			t.Fatalf("import %s: %v", relPath, err)
		}
		if !result.imported {
			t.Fatalf("expected import for %s", relPath)
		}
		if result.messageCount != 2 {
			t.Fatalf("expected 2 messages, got %d", result.messageCount)
		}
	}

	assertCount(t, db, "SELECT COUNT(*) FROM conversations", 2)

	// Verify idempotency: re-import should skip.
	for _, absPath := range files {
		relPath, _ := filepath.Rel(dir, absPath)
		content, _ := os.ReadFile(absPath)
		messages := parseMarkdownConversation(string(content))
		sessionID := memorySessionID(relPath)

		input := backfillSessionInput{
			agent:       "chatgpt",
			sessionID:   sessionID,
			title:       filepath.Base(relPath),
			sessionPath: absPath,
			messages:    messages,
		}
		result, err := applyBackfillImport(ctx, db, input)
		if err != nil {
			t.Fatalf("re-import %s: %v", relPath, err)
		}
		if result.imported {
			t.Fatalf("expected skip on re-import for %s", relPath)
		}
	}
}

func TestDeleteConversationData(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	// Import a conversation.
	input := backfillSessionInput{
		agent:       "test-agent",
		sessionID:   "session-delete-test",
		title:       "Delete Test",
		sessionPath: "/tmp/test.jsonl",
		messages:    makeBackfillMessages(4),
	}
	result, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if !result.imported {
		t.Fatal("expected import")
	}

	// Verify data exists.
	assertCountQuery(t, db, "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", 4, result.conversationID)
	assertCountQuery(t, db, "SELECT COUNT(*) FROM context_items WHERE conversation_id = ?", 4, result.conversationID)
	assertCountQuery(t, db, "SELECT COUNT(*) FROM conversations WHERE conversation_id = ?", 1, result.conversationID)

	// Delete all data.
	if err := deleteConversationData(ctx, db, result.conversationID); err != nil {
		t.Fatalf("delete: %v", err)
	}

	// Verify everything is gone.
	assertCountQuery(t, db, "SELECT COUNT(*) FROM messages WHERE conversation_id = ?", 0, result.conversationID)
	assertCountQuery(t, db, "SELECT COUNT(*) FROM context_items WHERE conversation_id = ?", 0, result.conversationID)
	assertCountQuery(t, db, "SELECT COUNT(*) FROM conversations WHERE conversation_id = ?", 0, result.conversationID)
	assertCountQuery(t, db, "SELECT COUNT(*) FROM message_parts WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)", 0, result.conversationID)
}

func TestForceReimport(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	sessionID := "session-force-test"
	input := backfillSessionInput{
		agent:       "test-agent",
		sessionID:   sessionID,
		title:       "Force Test",
		sessionPath: "/tmp/test.jsonl",
		messages:    makeBackfillMessages(3),
	}

	// Initial import.
	result1, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("first import: %v", err)
	}
	if !result1.imported {
		t.Fatal("expected first import")
	}

	// Normal re-import should skip.
	result2, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("second import: %v", err)
	}
	if result2.imported {
		t.Fatal("expected skip on second import")
	}

	// Force: delete then re-import.
	if err := deleteConversationData(ctx, db, result1.conversationID); err != nil {
		t.Fatalf("delete for force: %v", err)
	}
	result3, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("force re-import: %v", err)
	}
	if !result3.imported {
		t.Fatal("expected import after force delete")
	}
	if result3.messageCount != 3 {
		t.Fatalf("expected 3 messages after force, got %d", result3.messageCount)
	}
}

func TestParseImportMemoriesArgs_ValidPath(t *testing.T) {
	dir := t.TempDir()
	opts, err := parseImportMemoriesArgs([]string{dir})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if opts.path != dir {
		t.Fatalf("expected path %q, got %q", dir, opts.path)
	}
	if !opts.dryRun {
		t.Fatal("expected dry-run by default")
	}
	if opts.apply {
		t.Fatal("expected apply=false by default")
	}
}

func TestParseImportMemoriesArgs_ApplyMode(t *testing.T) {
	dir := t.TempDir()
	opts, err := parseImportMemoriesArgs([]string{"--apply", dir})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !opts.apply {
		t.Fatal("expected apply=true")
	}
	if opts.dryRun {
		t.Fatal("expected dryRun=false with --apply")
	}
}

func TestParseImportMemoriesArgs_MissingPath(t *testing.T) {
	_, err := parseImportMemoriesArgs([]string{})
	if err == nil {
		t.Fatal("expected error for missing path")
	}
}

func TestParseImportMemoriesArgs_NonDirectoryPath(t *testing.T) {
	f, err := os.CreateTemp("", "test-*.md")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	defer os.Remove(f.Name())

	_, err = parseImportMemoriesArgs([]string{f.Name()})
	if err == nil {
		t.Fatal("expected error for non-directory path")
	}
}

func TestParseImportMemoriesArgs_NonExistentPath(t *testing.T) {
	_, err := parseImportMemoriesArgs([]string{"/nonexistent/path/that/does/not/exist"})
	if err == nil {
		t.Fatal("expected error for non-existent path")
	}
}

func TestNormalizeMemoryRole(t *testing.T) {
	cases := []struct {
		input string
		want  string
	}{
		{"User", "user"},
		{"user", "user"},
		{"Human", "user"},
		{"human", "user"},
		{"You", "user"},
		{"you", "user"},
		{"Assistant", "assistant"},
		{"assistant", "assistant"},
		{"AI", "assistant"},
		{"ChatGPT", "assistant"},
		{"chatgpt", "assistant"},
		{"Claude", "assistant"},
		{"claude", "assistant"},
		{"System", "system"},
		{"system", "system"},
		{"unknown", "assistant"},
	}
	for _, tc := range cases {
		got := normalizeMemoryRole(tc.input)
		if got != tc.want {
			t.Errorf("normalizeMemoryRole(%q) = %q, want %q", tc.input, got, tc.want)
		}
	}
}

func TestParseMarkdownConversation_MarkerInsideCodeBlock(t *testing.T) {
	md := "## User\nShow me an example.\n\n## Assistant\nHere is an example:\n\n```markdown\n## User\nThis is inside a code block and should NOT split.\n```\n\nHope that helps.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages (code block marker ignored), got %d", len(msgs))
	}
	if !strings.Contains(msgs[1].content, "## User") {
		t.Fatalf("expected code block content with '## User' to be preserved in assistant message, got %q", msgs[1].content)
	}
	if !strings.Contains(msgs[1].content, "Hope that helps.") {
		t.Fatalf("expected text after code block to be preserved, got %q", msgs[1].content)
	}
}

func TestStripFrontmatter(t *testing.T) {
	cases := []struct {
		name  string
		input string
		want  string
	}{
		{
			name:  "with frontmatter",
			input: "---\ntitle: My Chat\nsource: https://example.com\n---\n\n# My Chat\n\n## User\nHello\n",
			want:  "\n# My Chat\n\n## User\nHello\n",
		},
		{
			name:  "no frontmatter",
			input: "## User\nHello\n",
			want:  "## User\nHello\n",
		},
		{
			name:  "frontmatter with BOM",
			input: "\xEF\xBB\xBF---\ntitle: Test\n---\nContent\n",
			want:  "Content\n",
		},
		{
			name:  "unclosed frontmatter",
			input: "---\ntitle: broken\nno closing delimiter\n",
			want:  "---\ntitle: broken\nno closing delimiter\n",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := stripFrontmatter(tc.input)
			if got != tc.want {
				t.Errorf("stripFrontmatter:\n  got:  %q\n  want: %q", got, tc.want)
			}
		})
	}
}

func TestExtractTimeTag(t *testing.T) {
	cases := []struct {
		line    string
		wantTS  string
		wantOK  bool
	}{
		{`<time datetime="2025-11-19T05:05:22.247Z" title="19/11/2025, 4:05:22 pm">16:05</time>`, "2025-11-19 05:05:22", true},
		{`<time datetime="2026-01-15T10:30:00Z" title="15/01/2026">10:30</time>`, "2026-01-15 10:30:00", true},
		{"No time tag here", "", false},
		{"<time>malformed</time>", "", false},
	}
	for _, tc := range cases {
		ts, ok := extractTimeTag(tc.line)
		if ok != tc.wantOK {
			t.Errorf("extractTimeTag(%q): ok=%v, want %v", tc.line, ok, tc.wantOK)
		}
		if ts != tc.wantTS {
			t.Errorf("extractTimeTag(%q): ts=%q, want %q", tc.line, ts, tc.wantTS)
		}
	}
}

func TestExtractFilenameDate(t *testing.T) {
	cases := []struct {
		filename string
		wantDate string
		wantOK   bool
	}{
		{"2026-02-18 - API access and subscription.md", "2026-02-18", true},
		{"2025-11-19 - Some chat.md", "2025-11-19", true},
		{"debugging-issue.md", "", false},
		{"chat.md", "", false},
	}
	for _, tc := range cases {
		got, ok := extractFilenameDate(tc.filename)
		if ok != tc.wantOK {
			t.Errorf("extractFilenameDate(%q): ok=%v, want %v", tc.filename, ok, tc.wantOK)
			continue
		}
		if ok {
			gotDate := got.Format("2006-01-02")
			if gotDate != tc.wantDate {
				t.Errorf("extractFilenameDate(%q): date=%q, want %q", tc.filename, gotDate, tc.wantDate)
			}
		}
	}
}

func TestParseMarkdownConversation_ChatGPTTimeTag(t *testing.T) {
	md := "#### You:\n<time datetime=\"2025-11-19T05:05:22.247Z\" title=\"19/11/2025, 4:05:22 pm\">16:05</time>\nWhat is Go?\n\n#### ChatGPT\n<time datetime=\"2025-11-19T05:05:45.000Z\" title=\"19/11/2025\">16:05</time>\nGo is a programming language.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	// Verify timestamps were extracted from <time> tags.
	if msgs[0].createdAt != "2025-11-19 05:05:22" {
		t.Errorf("message 0 timestamp: got %q, want %q", msgs[0].createdAt, "2025-11-19 05:05:22")
	}
	if msgs[1].createdAt != "2025-11-19 05:05:45" {
		t.Errorf("message 1 timestamp: got %q, want %q", msgs[1].createdAt, "2025-11-19 05:05:45")
	}
	// Verify <time> tag was stripped from content.
	if strings.Contains(msgs[0].content, "<time") {
		t.Errorf("expected <time> tag to be stripped from content, got %q", msgs[0].content)
	}
	if msgs[0].content != "What is Go?" {
		t.Errorf("expected clean content, got %q", msgs[0].content)
	}
}

func TestParseMarkdownConversation_FilenameDate(t *testing.T) {
	md := "## User\nHello\n\n## Assistant\nHi\n"
	msgs := parseMarkdownConversation(md, "2026-02-18 - Some chat.md")
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	// Both messages should have 2026-02-18 as their date.
	for i, msg := range msgs {
		if !strings.HasPrefix(msg.createdAt, "2026-02-18") {
			t.Errorf("message %d: expected date starting with 2026-02-18, got %q", i, msg.createdAt)
		}
	}
	// Messages should be spaced 1 minute apart.
	if msgs[0].createdAt == msgs[1].createdAt {
		t.Error("expected messages to have different timestamps (1 minute spacing)")
	}
}

func TestParseMarkdownConversation_FrontmatterStripped(t *testing.T) {
	md := "---\ntitle: Adding statement to letter\nsource: https://chatgpt.com/c/691d5000\n---\n\n# Adding statement to letter\n\n#### You:\nWrite me a letter.\n\n#### ChatGPT\nDear Sir or Madam...\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	// Verify frontmatter and h1 title are not in message content.
	if strings.Contains(msgs[0].content, "title:") {
		t.Errorf("frontmatter leaked into content: %q", msgs[0].content)
	}
	if strings.Contains(msgs[0].content, "Adding statement") {
		t.Errorf("h1 title leaked into content: %q", msgs[0].content)
	}
	if msgs[0].content != "Write me a letter." {
		t.Errorf("unexpected content: %q", msgs[0].content)
	}
}

func TestParseMarkdownConversation_TimeTagFallsBackToFilenameDate(t *testing.T) {
	// No <time> tags, but filename has a date.
	md := "## User\nHello\n\n## Assistant\nHi\n"
	msgs := parseMarkdownConversation(md, "2026-03-01 - Test.md")
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	if !strings.HasPrefix(msgs[0].createdAt, "2026-03-01") {
		t.Errorf("expected filename date fallback, got %q", msgs[0].createdAt)
	}
}

func TestParseMarkdownConversation_NoDateFallsBackToNow(t *testing.T) {
	md := "## User\nHello\n\n## Assistant\nHi\n"
	msgs := parseMarkdownConversation(md, "some-chat.md")
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
	// Should use current date (today).
	today := strings.Split(msgs[0].createdAt, " ")[0]
	if len(today) != 10 { // YYYY-MM-DD
		t.Errorf("expected valid date, got %q", msgs[0].createdAt)
	}
}

func TestParseMarkdownConversation_NestedCodeBlocks(t *testing.T) {
	md := "## User\nWhat does this do?\n\n```go\nfmt.Println(\"```\")\n```\n\n## Assistant\nIt prints backticks.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(msgs))
	}
}

func TestParseMarkdownConversation_UTF8WithBOM(t *testing.T) {
	// UTF-8 BOM: \xEF\xBB\xBF
	md := "\xEF\xBB\xBF## User\nHello from Windows.\n\n## Assistant\nHi there.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 2 {
		t.Fatalf("expected 2 messages from BOM-prefixed file, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected first message to be user, got %q", msgs[0].role)
	}
	if msgs[0].content != "Hello from Windows." {
		t.Fatalf("unexpected content: %q", msgs[0].content)
	}
}

func TestImportMemories_FTSIndexing(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	input := backfillSessionInput{
		agent:       "test-agent",
		sessionID:   "session-fts-test",
		title:       "FTS Test",
		sessionPath: "/tmp/test.md",
		messages: []backfillMessage{
			{seq: 0, role: "user", content: "Tell me about quantum computing", createdAt: "2026-01-01 10:00:00"},
			{seq: 1, role: "assistant", content: "Quantum computing uses qubits instead of classical bits", createdAt: "2026-01-01 10:01:00"},
		},
	}
	result, err := applyBackfillImport(ctx, db, input)
	if err != nil {
		t.Fatalf("import: %v", err)
	}

	// Verify FTS rows were created.
	assertCountQuery(t, db, "SELECT COUNT(*) FROM messages_fts", 2)

	// Verify FTS search actually works.
	var matchCount int
	err = db.QueryRow("SELECT COUNT(*) FROM messages_fts WHERE content MATCH 'quantum'").Scan(&matchCount)
	if err != nil {
		t.Fatalf("FTS query: %v", err)
	}
	if matchCount != 2 {
		t.Fatalf("expected 2 FTS matches for 'quantum', got %d", matchCount)
	}

	// Verify cleanup: delete and confirm FTS rows are gone.
	if err := deleteConversationData(ctx, db, result.conversationID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	assertCountQuery(t, db, "SELECT COUNT(*) FROM messages_fts", 0)
}

func TestImportMemories_DryRunMakesNoWrites(t *testing.T) {
	db := newBackfillTestDB(t)
	ctx := context.Background()

	sessionID := "import:dry-run-test"

	// Verify no conversations exist.
	plan, err := inspectBackfillImportPlan(ctx, db, sessionID)
	if err != nil {
		t.Fatalf("inspect: %v", err)
	}
	if plan.hasData {
		t.Fatal("expected no data before dry-run")
	}

	// The dry-run path in runImportMemoriesCommand calls inspectBackfillImportPlan
	// but never applyBackfillImport. Verify the DB is still empty after inspection.
	assertCount(t, db, "SELECT COUNT(*) FROM conversations", 0)
	assertCount(t, db, "SELECT COUNT(*) FROM messages", 0)
	assertCount(t, db, "SELECT COUNT(*) FROM context_items", 0)
}

func TestParseMarkdownConversation_SingleTurnOnly(t *testing.T) {
	md := "## User\nJust a question with no response.\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message for single turn, got %d", len(msgs))
	}
	if msgs[0].role != "user" {
		t.Fatalf("expected user role, got %q", msgs[0].role)
	}
}

func TestParseMarkdownConversation_EmptyTurnsSkipped(t *testing.T) {
	md := "## User\n\n## Assistant\nOnly I have content.\n"
	msgs := parseMarkdownConversation(md)
	// The user turn is empty (just whitespace), so it should be skipped.
	if len(msgs) != 1 {
		t.Fatalf("expected 1 message (empty turn skipped), got %d", len(msgs))
	}
	if msgs[0].role != "assistant" {
		t.Fatalf("expected assistant role, got %q", msgs[0].role)
	}
}

func TestParseMarkdownConversation_SequentialNumbering(t *testing.T) {
	md := "## User\nFirst\n\n## Assistant\nSecond\n\n## User\nThird\n"
	msgs := parseMarkdownConversation(md)
	if len(msgs) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(msgs))
	}
	for i, msg := range msgs {
		if msg.seq != i {
			t.Errorf("message %d: expected seq=%d, got seq=%d", i, i, msg.seq)
		}
	}
}

// assertCount is reused from backfill_test.go but we need a local version
// for the case where backfill_test.go's version isn't exported.
func assertCountImport(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(query).Scan(&got); err != nil {
		t.Fatalf("query count failed: %v\nquery:\n%s", err, query)
	}
	if got != want {
		t.Fatalf("count mismatch: got=%d want=%d\nquery:\n%s", got, want, query)
	}
}
