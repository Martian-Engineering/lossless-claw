package main

import (
	"context"
	"crypto/sha256"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

type importMemoriesOptions struct {
	path     string
	apply    bool
	dryRun   bool
	force    bool
	agent    string
	dbPath   string
	compact  bool
	provider string
	model    string
	// Compaction tuning — reuse backfill defaults.
	leafChunkTokens      int
	leafTargetTokens     int
	condensedTargetToken int
	leafFanout           int
	condensedFanout      int
	hardFanout           int
	freshTailCount       int
	promptDir            string
}

// markerStyle describes a detected conversation turn marker pattern.
type markerStyle struct {
	pattern  *regexp.Regexp
	roleGroup int // capture group index for the role name
}

// timeTagPattern matches <time datetime="2025-11-19T05:05:22.247Z" ...>...</time> tags from ChatGPT exports.
var timeTagPattern = regexp.MustCompile(`<time\s+datetime="([^"]+)"[^>]*>[^<]*</time>`)

// filenameDatePattern matches YYYY-MM-DD at the start of a filename.
var filenameDatePattern = regexp.MustCompile(`^(\d{4}-\d{2}-\d{2})`)

var markerStyles = []markerStyle{
	// #### You: / #### ChatGPT (h4 heading, optional colon)
	{pattern: regexp.MustCompile(`(?i)^####\s+(You|User|Assistant|System|Human|AI|ChatGPT|Claude):?\s*$`), roleGroup: 1},
	// ## User / ## Assistant / ## System / ## Human / ## AI (optional colon)
	{pattern: regexp.MustCompile(`(?i)^##\s+(You|User|Assistant|System|Human|AI|ChatGPT|Claude):?\s*$`), roleGroup: 1},
	// ### User / ### Assistant (optional colon)
	{pattern: regexp.MustCompile(`(?i)^###\s+(You|User|Assistant|System|Human|AI|ChatGPT|Claude):?\s*$`), roleGroup: 1},
	// **User:** / **Assistant:** / **Human:**
	{pattern: regexp.MustCompile(`(?i)^\*\*(You|User|Assistant|System|Human|AI|ChatGPT|Claude):\*\*`), roleGroup: 1},
	// Human: / Assistant: (Claude export style)
	{pattern: regexp.MustCompile(`(?i)^(Human|You|User|Assistant|AI|ChatGPT|Claude|System):\s`), roleGroup: 1},
}

func runImportMemoriesCommand(args []string) error {
	opts, err := parseImportMemoriesArgs(args)
	if err != nil {
		return err
	}

	// Resolve DB path.
	dbPath := opts.dbPath
	if dbPath == "" {
		paths, err := resolveDataPaths()
		if err != nil {
			return err
		}
		dbPath = paths.lcmDBPath
	}

	// Discover .md files.
	files, err := discoverMarkdownFiles(opts.path)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("no .md files found in %s", opts.path)
	}

	fmt.Printf("Found %d .md file(s) under %s\n", len(files), opts.path)

	// Parse all files upfront for dry-run reporting.
	type fileEntry struct {
		relPath   string
		absPath   string
		agent     string
		title     string
		sessionID string
		messages  []backfillMessage
	}
	entries := make([]fileEntry, 0, len(files))
	var totalMessages int
	for _, absPath := range files {
		relPath, _ := filepath.Rel(opts.path, absPath)
		content, err := os.ReadFile(absPath)
		if err != nil {
			fmt.Fprintf(os.Stderr, "warning: skipping %s: %v\n", relPath, err)
			continue
		}

		filename := filepath.Base(relPath)
		messages := parseMarkdownConversation(string(content), filename)
		if len(messages) == 0 {
			fmt.Fprintf(os.Stderr, "warning: skipping %s: no messages extracted\n", relPath)
			continue
		}

		agent := opts.agent
		if agent == "" {
			agent = deriveAgentName(relPath)
		}

		title := strings.TrimSuffix(filename, filepath.Ext(filename))
		sessionID := memorySessionID(relPath)

		entries = append(entries, fileEntry{
			relPath:   relPath,
			absPath:   absPath,
			agent:     agent,
			title:     title,
			sessionID: sessionID,
			messages:  messages,
		})
		totalMessages += len(messages)
	}

	if len(entries) == 0 {
		return fmt.Errorf("no parseable conversations found in %s", opts.path)
	}

	fmt.Printf("Parsed %d conversation(s) with %d total messages\n\n", len(entries), totalMessages)

	if opts.dryRun {
		// Dry-run: show parse results. Try to check DB for duplicates, but
		// work without a database if it doesn't exist.
		db, dbErr := openLCMDB(dbPath)
		if dbErr != nil {
			// No database — just show what was parsed.
			for _, e := range entries {
				fmt.Printf("  [import] %s → agent=%q title=%q (%d msgs, first=%s)\n", e.relPath, e.agent, e.title, len(e.messages), e.messages[0].createdAt)
			}
			fmt.Printf("\nDry-run summary: %d would be imported (database not available for dedup check).\nUse --apply to execute.\n", len(entries))
			return nil
		}
		defer db.Close()

		ctx := context.Background()
		var wouldImport, wouldSkip int
		for _, e := range entries {
			plan, err := inspectBackfillImportPlan(ctx, db, e.sessionID)
			if err != nil {
				// Table may not exist — treat as new.
				fmt.Printf("  [import] %s → agent=%q title=%q (%d msgs, first=%s)\n", e.relPath, e.agent, e.title, len(e.messages), e.messages[0].createdAt)
				wouldImport++
				continue
			}
			if plan.hasData && !opts.force {
				fmt.Printf("  [skip] %s (%d msgs, already imported as conversation %d)\n", e.relPath, len(e.messages), plan.conversationID)
				wouldSkip++
			} else {
				action := "import"
				if plan.hasData && opts.force {
					action = "re-import"
				}
				fmt.Printf("  [%s] %s → agent=%q title=%q (%d msgs, first=%s)\n", action, e.relPath, e.agent, e.title, len(e.messages), e.messages[0].createdAt)
				wouldImport++
			}
		}
		fmt.Printf("\nDry-run summary: %d would be imported, %d would be skipped. Use --apply to execute.\n", wouldImport, wouldSkip)
		return nil
	}

	// Apply mode: open database and import conversations.
	db, err := openLCMDB(dbPath)
	if err != nil {
		return err
	}
	defer db.Close()
	ctx := context.Background()
	var summarize backfillSummarizeFn
	if opts.compact {
		paths, err := resolveDataPaths()
		if err != nil {
			return err
		}
		apiKey, err := resolveProviderAPIKey(paths, opts.provider)
		if err != nil {
			return err
		}
		client := &anthropicClient{
			provider: opts.provider,
			apiKey:   apiKey,
			http:     &http.Client{Timeout: defaultHTTPTimeout},
			model:    opts.model,
		}
		summarize = client.summarize
	}

	var imported, skipped, failed int
	for _, e := range entries {
		plan, err := inspectBackfillImportPlan(ctx, db, e.sessionID)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %s: %v\n", e.relPath, err)
			failed++
			continue
		}

		if plan.hasData && !opts.force {
			fmt.Printf("  [skip] %s (already imported as conversation %d)\n", e.relPath, plan.conversationID)
			skipped++
			continue
		}

		// If force re-import, delete existing data first.
		if plan.hasData && opts.force {
			if err := deleteConversationData(ctx, db, plan.conversationID); err != nil {
				fmt.Fprintf(os.Stderr, "error: %s: failed to clear existing data: %v\n", e.relPath, err)
				failed++
				continue
			}
		}

		input := backfillSessionInput{
			agent:       e.agent,
			sessionID:   e.sessionID,
			title:       e.title,
			sessionPath: e.absPath,
			messages:    e.messages,
		}

		result, err := applyBackfillImport(ctx, db, input)
		if err != nil {
			fmt.Fprintf(os.Stderr, "error: %s: %v\n", e.relPath, err)
			failed++
			continue
		}

		fmt.Printf("  [imported] %s → conversation %d (%d msgs)\n", e.relPath, result.conversationID, result.messageCount)
		imported++

		// Optional compaction.
		if opts.compact && summarize != nil {
			bOpts := backfillOptions{
				apply:                true,
				leafChunkTokens:      opts.leafChunkTokens,
				leafTargetTokens:     opts.leafTargetTokens,
				condensedTargetToken: opts.condensedTargetToken,
				leafFanout:           opts.leafFanout,
				condensedFanout:      opts.condensedFanout,
				hardFanout:           opts.hardFanout,
				freshTailCount:       opts.freshTailCount,
				promptDir:            opts.promptDir,
				provider:             opts.provider,
				model:                opts.model,
			}
			stats, err := runBackfillCompaction(ctx, db, result.conversationID, bOpts, summarize)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  warning: compaction failed for %s: %v\n", e.relPath, err)
			} else {
				fmt.Printf("  [compacted] leaf=%d condensed=%d root-fold=%d\n", stats.leafPasses, stats.condensedPasses, stats.rootFoldPasses)
			}
		}
	}

	fmt.Printf("\nImport complete: %d imported, %d skipped, %d failed\n", imported, skipped, failed)
	return nil
}

func parseImportMemoriesArgs(args []string) (importMemoriesOptions, error) {
	fs := flag.NewFlagSet("import-memories", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	apply := fs.Bool("apply", false, "actually import (default: dry-run)")
	force := fs.Bool("force", false, "re-import files even if already imported")
	agent := fs.String("agent", "", "override agent name (default: parent folder name)")
	dbPath := fs.String("db", "", "database path (default: ~/.openclaw/lcm.db)")
	compact := fs.Bool("compact", false, "run compaction after importing each conversation")
	provider := fs.String("provider", "", "API provider for compaction (e.g. anthropic, openai)")
	model := fs.String("model", "", "API model for compaction")
	leafChunk := fs.Int("leaf-chunk-tokens", 20000, "max input tokens per leaf chunk")
	leafTarget := fs.Int("leaf-target-tokens", 1200, "target output tokens for leaf summaries")
	condensedTarget := fs.Int("condensed-target-tokens", condensedTargetTokens, "target output tokens for condensed summaries")
	leafFanout := fs.Int("leaf-fanout", 8, "minimum leaf summaries before d1 condensation")
	condensedFanout := fs.Int("condensed-fanout", 4, "minimum summaries before d2+ condensation")
	hardFanout := fs.Int("hard-fanout", 2, "minimum summaries in forced single-root fold")
	freshTail := fs.Int("fresh-tail", 32, "freshest raw messages to preserve from leaf compaction")
	promptDir := fs.String("prompt-dir", "", "custom prompt template directory")

	if err := fs.Parse(args); err != nil {
		return importMemoriesOptions{}, fmt.Errorf("%w\n%s", err, importMemoriesUsageText())
	}

	if fs.NArg() != 1 {
		return importMemoriesOptions{}, fmt.Errorf("path argument is required\n%s", importMemoriesUsageText())
	}

	path := expandHomePath(strings.TrimSpace(fs.Arg(0)))
	info, err := os.Stat(path)
	if err != nil {
		return importMemoriesOptions{}, fmt.Errorf("cannot access %s: %w", path, err)
	}
	if !info.IsDir() {
		return importMemoriesOptions{}, fmt.Errorf("%s is not a directory", path)
	}

	resolvedProvider, resolvedModel := resolveSummaryProviderModel(*provider, *model)
	if *promptDir != "" {
		*promptDir = expandHomePath(*promptDir)
	}

	opts := importMemoriesOptions{
		path:                 path,
		apply:                *apply,
		dryRun:               !*apply,
		force:                *force,
		agent:                strings.TrimSpace(*agent),
		dbPath:               expandHomePath(strings.TrimSpace(*dbPath)),
		compact:              *compact,
		provider:             resolvedProvider,
		model:                resolvedModel,
		leafChunkTokens:      *leafChunk,
		leafTargetTokens:     *leafTarget,
		condensedTargetToken: *condensedTarget,
		leafFanout:           *leafFanout,
		condensedFanout:      *condensedFanout,
		hardFanout:           *hardFanout,
		freshTailCount:       *freshTail,
		promptDir:            *promptDir,
	}
	return opts, nil
}

func importMemoriesUsageText() string {
	return `Usage: lcm-tui import-memories <path> [flags]

Import markdown conversation files into LCM memory.

Walks a directory tree for .md files, parses conversation turns, and imports
each file as a separate conversation. Parent folder names are used as agent
identifiers (e.g., chatgpt/, claude/).

Supported turn marker formats:
  ## User / ## Assistant          (heading style)
  ### User / ### Assistant        (sub-heading style)
  **User:** / **Assistant:**      (bold style)
  Human: / Assistant:             (Claude export style)

Files without recognized turn markers are imported as a single assistant message.

Flags:
  --apply              actually import (default: dry-run)
  --force              re-import files even if already imported
  --agent <name>       override agent name (default: parent folder name)
  --db <path>          database path (default: ~/.openclaw/lcm.db)
  --compact            run compaction after importing each conversation
  --provider <id>      API provider for compaction
  --model <id>         API model for compaction
  --leaf-chunk-tokens  max input tokens per leaf chunk (default 20000)
  --leaf-target-tokens target output tokens for leaf summaries (default 1200)
  --condensed-target-tokens target for condensed summaries (default 2000)
  --leaf-fanout        minimum leaf summaries before condensation (default 8)
  --condensed-fanout   minimum summaries before d2+ condensation (default 4)
  --hard-fanout        minimum summaries in forced root fold (default 2)
  --fresh-tail         freshest raw messages to preserve (default 32)
  --prompt-dir         custom prompt template directory
`
}

// discoverMarkdownFiles walks a directory tree and returns all .md file paths.
func discoverMarkdownFiles(root string) ([]string, error) {
	var files []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip inaccessible entries
		}
		if info.IsDir() {
			return nil
		}
		if strings.EqualFold(filepath.Ext(path), ".md") {
			files = append(files, path)
		}
		return nil
	})
	return files, err
}

// memorySessionID creates a deterministic session ID from a relative file path.
func memorySessionID(relPath string) string {
	h := sha256.Sum256([]byte(relPath))
	return fmt.Sprintf("import:%x", h[:8])
}

// parseMarkdownConversation splits a markdown file into conversation messages.
// The optional filename parameter is used to extract a date from the filename
// (e.g., "2026-02-18 - Some title.md") as a fallback timestamp.
func parseMarkdownConversation(content string, filename ...string) []backfillMessage {
	// Strip UTF-8 BOM if present.
	content = strings.TrimPrefix(content, "\xEF\xBB\xBF")

	// Strip YAML frontmatter if present.
	content = stripFrontmatter(content)

	lines := strings.Split(content, "\n")

	// Detect which marker style is present by scanning all lines.
	var detected *markerStyle
	for i := range markerStyles {
		for _, line := range lines {
			if markerStyles[i].pattern.MatchString(strings.TrimSpace(line)) {
				detected = &markerStyles[i]
				break
			}
		}
		if detected != nil {
			break
		}
	}

	// Determine fallback timestamp: filename date > import time.
	fallbackTime := time.Now().UTC()
	if len(filename) > 0 {
		if t, ok := extractFilenameDate(filename[0]); ok {
			fallbackTime = t
		}
	}
	fallbackTimestamp := fallbackTime.Format("2006-01-02 15:04:05")

	// No markers found: treat entire file as a single assistant message.
	if detected == nil {
		trimmed := strings.TrimSpace(content)
		if trimmed == "" {
			return nil
		}
		return []backfillMessage{{
			seq:       0,
			role:      "assistant",
			content:   trimmed,
			createdAt: fallbackTimestamp,
		}}
	}

	// Split on detected marker pattern.
	type pendingMessage struct {
		role      string
		content   strings.Builder
		timestamp string // from <time> tag if found
	}

	var messages []backfillMessage
	var current *pendingMessage

	flush := func() {
		if current == nil {
			return
		}
		text := strings.TrimSpace(current.content.String())
		if text != "" {
			ts := current.timestamp
			if ts == "" {
				// Use fallback with 1-minute spacing per message.
				ts = fallbackTime.Add(time.Duration(len(messages)) * time.Minute).Format("2006-01-02 15:04:05")
			}
			messages = append(messages, backfillMessage{
				seq:       len(messages),
				role:      normalizeMemoryRole(current.role),
				content:   text,
				createdAt: ts,
			})
		}
		current = nil
	}

	inCodeBlock := false
	for _, line := range lines {
		trimmedLine := strings.TrimSpace(line)

		// Track fenced code blocks so markers inside them are treated as content.
		if strings.HasPrefix(trimmedLine, "```") {
			inCodeBlock = !inCodeBlock
		}

		if !inCodeBlock {
			match := detected.pattern.FindStringSubmatch(trimmedLine)
			if match != nil {
				flush()
				current = &pendingMessage{role: match[detected.roleGroup]}
				// For inline markers, capture text after the marker on the same line.
				loc := detected.pattern.FindStringIndex(trimmedLine)
				if loc != nil {
					remainder := strings.TrimSpace(trimmedLine[loc[1]:])
					if remainder != "" {
						current.content.WriteString(remainder)
						current.content.WriteString("\n")
					}
				}
				continue
			}

			// Check for <time datetime="..."> tag — extract timestamp, skip the line.
			if current != nil && current.timestamp == "" {
				if ts, ok := extractTimeTag(trimmedLine); ok {
					current.timestamp = ts
					continue
				}
			}
		}

		if current != nil {
			current.content.WriteString(line)
			current.content.WriteString("\n")
		}
		// Lines before the first marker are discarded (typically metadata/title).
	}
	flush()

	return messages
}

// stripFrontmatter removes YAML frontmatter (--- delimited) from the start of content.
func stripFrontmatter(content string) string {
	// Must start with --- (possibly preceded by BOM or whitespace).
	trimmed := strings.TrimLeft(content, "\xEF\xBB\xBF \t\r\n")
	if !strings.HasPrefix(trimmed, "---") {
		return content
	}
	// Find closing ---.
	rest := trimmed[3:]
	idx := strings.Index(rest, "\n---")
	if idx < 0 {
		return content // no closing delimiter, not frontmatter
	}
	// Skip past the closing --- and its newline.
	after := rest[idx+4:]
	if len(after) > 0 && after[0] == '\n' {
		after = after[1:]
	}
	return after
}

// extractTimeTag extracts a timestamp from a <time datetime="..."> HTML tag.
// Returns the formatted timestamp and true if found.
func extractTimeTag(line string) (string, bool) {
	match := timeTagPattern.FindStringSubmatch(line)
	if match == nil {
		return "", false
	}
	t, err := time.Parse(time.RFC3339Nano, match[1])
	if err != nil {
		// Try without nanoseconds.
		t, err = time.Parse("2006-01-02T15:04:05Z", match[1])
		if err != nil {
			return "", false
		}
	}
	return t.UTC().Format("2006-01-02 15:04:05"), true
}

// extractFilenameDate extracts a YYYY-MM-DD date from the start of a filename.
func extractFilenameDate(filename string) (time.Time, bool) {
	match := filenameDatePattern.FindStringSubmatch(filename)
	if match == nil {
		return time.Time{}, false
	}
	t, err := time.Parse("2006-01-02", match[1])
	if err != nil {
		return time.Time{}, false
	}
	// Set to noon UTC so message spacing doesn't cross date boundaries.
	return t.Add(12 * time.Hour), true
}

// deriveAgentName extracts an agent name from the relative path of a memory file.
// Uses the top-level folder name, or "imported" for files at the root.
func deriveAgentName(relPath string) string {
	dir := filepath.Dir(relPath)
	if dir == "." || dir == "" {
		return "imported"
	}
	parts := strings.SplitN(dir, string(filepath.Separator), 2)
	return parts[0]
}

// normalizeMemoryRole maps marker text to standard LCM roles.
func normalizeMemoryRole(raw string) string {
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "user", "human", "you":
		return "user"
	case "assistant", "ai", "chatgpt", "claude":
		return "assistant"
	case "system":
		return "system"
	default:
		return "assistant"
	}
}

// deleteConversationData removes all data for a conversation (for --force re-import).
func deleteConversationData(ctx context.Context, db sqlQueryer, conversationID int64) error {
	// FTS tables may not exist in all environments; errors on those are non-fatal.
	ftsDeletes := []struct {
		query string
		args  []any
	}{
		{"DELETE FROM messages_fts WHERE rowid IN (SELECT message_id FROM messages WHERE conversation_id = ?)", []any{conversationID}},
		{"DELETE FROM summaries_fts WHERE rowid IN (SELECT rowid FROM summaries WHERE conversation_id = ?)", []any{conversationID}},
	}
	for _, d := range ftsDeletes {
		_, _ = db.ExecContext(ctx, d.query, d.args...)
	}

	// Core tables: delete in dependency order.
	coreDeletes := []struct {
		query string
		args  []any
	}{
		{"DELETE FROM message_parts WHERE message_id IN (SELECT message_id FROM messages WHERE conversation_id = ?)", []any{conversationID}},
		{"DELETE FROM summary_messages WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ?)", []any{conversationID}},
		{"DELETE FROM summary_parents WHERE summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ?) OR parent_summary_id IN (SELECT summary_id FROM summaries WHERE conversation_id = ?)", []any{conversationID, conversationID}},
		{"DELETE FROM context_items WHERE conversation_id = ?", []any{conversationID}},
		{"DELETE FROM summaries WHERE conversation_id = ?", []any{conversationID}},
		{"DELETE FROM messages WHERE conversation_id = ?", []any{conversationID}},
		{"DELETE FROM conversations WHERE conversation_id = ?", []any{conversationID}},
	}
	for _, d := range coreDeletes {
		if _, err := db.ExecContext(ctx, d.query, d.args...); err != nil {
			return fmt.Errorf("delete conversation data: %w", err)
		}
	}
	return nil
}
