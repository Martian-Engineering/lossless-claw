package main

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type backfillOptions struct {
	apply                bool
	dryRun               bool
	singleRoot           bool
	recompact            bool
	agent                string
	sessionID            string
	title                string
	transplantTo         int64
	hasTransplantTarget  bool
	leafChunkTokens      int
	leafTargetTokens     int
	condensedTargetToken int
	leafFanout           int
	condensedFanout      int
	hardFanout           int
	freshTailCount       int
	promptDir            string
	model                string
}

type backfillMessage struct {
	seq       int
	role      string
	content   string
	createdAt string
}

type backfillImportPlan struct {
	conversationID int64
	hasData        bool
	messageCount   int
	contextCount   int
	summaryCount   int
}

type backfillImportResult struct {
	conversationID int64
	imported       bool
	messageCount   int
}

type backfillCompactionStats struct {
	leafPasses      int
	condensedPasses int
	rootFoldPasses  int
}

type backfillContextItem struct {
	ordinal    int64
	itemType   string
	messageID  sql.NullInt64
	summaryID  sql.NullString
	tokenCount int
	depth      int
}

type backfillSummaryRecord struct {
	summaryID   string
	content     string
	tokenCount  int
	depth       int
	kind        string
	createdAt   string
	earliestAt  string
	latestAt    string
	descendants int
}

type backfillSessionInput struct {
	agent       string
	sessionID   string
	title       string
	sessionPath string
	messages    []backfillMessage
}

type backfillSummarizeFn func(ctx context.Context, prompt string, targetTokens int) (string, error)

func runBackfillCommand(args []string) error {
	opts, err := parseBackfillArgs(args)
	if err != nil {
		return err
	}

	paths, err := resolveDataPaths()
	if err != nil {
		return err
	}

	sessionPath, err := resolveBackfillSessionPath(paths.agentsDir, opts.agent, opts.sessionID)
	if err != nil {
		return err
	}
	messages, err := parseBackfillSessionFile(sessionPath)
	if err != nil {
		return err
	}
	if len(messages) == 0 {
		return fmt.Errorf("session %s has no message rows to backfill", opts.sessionID)
	}

	db, err := openLCMDB(paths.lcmDBPath)
	if err != nil {
		return err
	}
	defer db.Close()

	ctx := context.Background()
	input := backfillSessionInput{
		agent:       opts.agent,
		sessionID:   opts.sessionID,
		title:       opts.title,
		sessionPath: sessionPath,
		messages:    messages,
	}

	if opts.dryRun {
		plan, err := inspectBackfillImportPlan(ctx, db, input.sessionID)
		if err != nil {
			return err
		}
		if plan.hasData {
			fmt.Printf("Backfill dry-run: session %s already imported as conversation %d (%d messages, %d context items, %d summaries).\n", input.sessionID, plan.conversationID, plan.messageCount, plan.contextCount, plan.summaryCount)
			if opts.recompact {
				fmt.Println("Recompact mode: would skip import and rerun compaction on existing conversation.")
			}
		} else {
			fmt.Printf("Backfill dry-run: would import %d messages from %s into a new conversation.\n", len(input.messages), input.sessionPath)
		}
		fmt.Printf("Compaction dry-run: leaf chunk=%dt, leaf target=%dt, condensed target=%dt, fanout=%d/%d (hard=%d), fresh-tail=%d\n",
			opts.leafChunkTokens,
			opts.leafTargetTokens,
			opts.condensedTargetToken,
			opts.leafFanout,
			opts.condensedFanout,
			opts.hardFanout,
			opts.freshTailCount,
		)
		if opts.singleRoot {
			fmt.Println("Single-root mode: enabled (forced fold when possible).")
		}
		if opts.recompact {
			fmt.Println("Recompact mode: enabled (run compaction for already-imported sessions).")
		}
		if opts.hasTransplantTarget {
			if plan.hasData {
				transplantPlan, terr := buildTransplantPlan(ctx, db, plan.conversationID, opts.transplantTo)
				if terr != nil {
					return terr
				}
				printTransplantDryRunReport(transplantPlan)
			} else {
				fmt.Printf("Transplant dry-run skipped: source conversation does not exist yet (would be created on --apply).\n")
			}
		}
		return nil
	}

	apiKey, err := resolveAnthropicAPIKey(paths)
	if err != nil {
		return err
	}
	client := &anthropicClient{
		apiKey: apiKey,
		http:   &http.Client{Timeout: defaultHTTPTimeout},
		model:  opts.model,
	}

	result, stats, err := runBackfillWorkflow(ctx, db, opts, input, client.summarize)
	if err != nil {
		return err
	}

	if result.imported {
		fmt.Printf("Imported %d messages for %s/%s into conversation %d.\n",
			result.messageCount,
			input.agent,
			input.sessionID,
			result.conversationID,
		)
	} else if opts.recompact {
		fmt.Printf("Idempotency guard: session %s already imported in conversation %d, skipping import and re-running compaction.\n", input.sessionID, result.conversationID)
	} else {
		fmt.Printf("Idempotency guard: session %s already imported in conversation %d, skipping import.\n", input.sessionID, result.conversationID)
	}

	fmt.Printf("Compaction passes: leaf=%d condensed=%d single-root=%d\n", stats.leafPasses, stats.condensedPasses, stats.rootFoldPasses)
	if opts.hasTransplantTarget {
		fmt.Printf("Transplant target: conversation %d\n", opts.transplantTo)
	}
	return nil
}

func runBackfillWorkflow(ctx context.Context, db *sql.DB, opts backfillOptions, input backfillSessionInput, summarize backfillSummarizeFn) (backfillImportResult, backfillCompactionStats, error) {
	plan, err := inspectBackfillImportPlan(ctx, db, input.sessionID)
	if err != nil {
		return backfillImportResult{}, backfillCompactionStats{}, err
	}

	result := backfillImportResult{}
	stats := backfillCompactionStats{}
	if plan.hasData {
		result = backfillImportResult{
			conversationID: plan.conversationID,
			imported:       false,
			messageCount:   plan.messageCount,
		}
	} else {
		result, err = applyBackfillImport(ctx, db, input)
		if err != nil {
			return backfillImportResult{}, backfillCompactionStats{}, err
		}
	}

	shouldCompact := result.imported || (!result.imported && opts.recompact)
	if shouldCompact {
		if summarize == nil {
			return backfillImportResult{}, backfillCompactionStats{}, errors.New("backfill summarize function is required for apply mode")
		}
		stats, err = runBackfillCompaction(ctx, db, result.conversationID, opts, summarize)
		if err != nil {
			return backfillImportResult{}, backfillCompactionStats{}, err
		}
	}

	if opts.hasTransplantTarget {
		transplantPlan, err := buildTransplantPlan(ctx, db, result.conversationID, opts.transplantTo)
		if err != nil {
			return backfillImportResult{}, backfillCompactionStats{}, err
		}
		printTransplantDryRunReport(transplantPlan)
		if len(transplantPlan.duplicates) > 0 {
			return backfillImportResult{}, backfillCompactionStats{}, fmt.Errorf("aborting transplant: target conversation %d already contains %d matching summary content hashes", opts.transplantTo, len(transplantPlan.duplicates))
		}
		if _, err := applyTransplant(ctx, db, transplantPlan); err != nil {
			return backfillImportResult{}, backfillCompactionStats{}, err
		}
	}

	return result, stats, nil
}

func parseBackfillArgs(args []string) (backfillOptions, error) {
	fs := flag.NewFlagSet("backfill", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	apply := fs.Bool("apply", false, "apply import and compaction")
	dryRun := fs.Bool("dry-run", true, "show plan without writing")
	singleRoot := fs.Bool("single-root", false, "force condensed folding until one summary remains when possible")
	recompact := fs.Bool("recompact", false, "rerun compaction on an existing imported conversation")
	transplantTo := fs.Int64("transplant-to", 0, "target conversation ID to transplant backfilled summaries into")
	title := fs.String("title", "", "conversation title override")
	leafChunk := fs.Int("leaf-chunk-tokens", 20000, "max input tokens per leaf chunk")
	leafTarget := fs.Int("leaf-target-tokens", 1200, "target output tokens for leaf summaries")
	condensedTarget := fs.Int("condensed-target-tokens", condensedTargetTokens, "target output tokens for condensed summaries")
	leafFanout := fs.Int("leaf-fanout", 8, "minimum leaf summaries required before d1 condensation")
	condensedFanout := fs.Int("condensed-fanout", 4, "minimum summaries required before d2+ condensation")
	hardFanout := fs.Int("hard-fanout", 2, "minimum summaries used in forced single-root fold")
	freshTail := fs.Int("fresh-tail", 32, "number of freshest raw messages to preserve from leaf compaction")
	promptDir := fs.String("prompt-dir", "", "custom prompt template directory")
	model := fs.String("model", anthropicModel, "Anthropic model")

	normalized, err := normalizeBackfillArgs(args)
	if err != nil {
		return backfillOptions{}, fmt.Errorf("%w\n%s", err, backfillUsageText())
	}
	if err := fs.Parse(normalized); err != nil {
		return backfillOptions{}, fmt.Errorf("%w\n%s", err, backfillUsageText())
	}
	if fs.NArg() != 2 {
		return backfillOptions{}, fmt.Errorf("agent and session_id are required\n%s", backfillUsageText())
	}

	opts := backfillOptions{
		apply:                *apply,
		dryRun:               *dryRun,
		singleRoot:           *singleRoot,
		recompact:            *recompact,
		agent:                strings.TrimSpace(fs.Arg(0)),
		sessionID:            normalizeBackfillSessionID(fs.Arg(1)),
		title:                strings.TrimSpace(*title),
		transplantTo:         *transplantTo,
		hasTransplantTarget:  *transplantTo > 0,
		leafChunkTokens:      *leafChunk,
		leafTargetTokens:     *leafTarget,
		condensedTargetToken: *condensedTarget,
		leafFanout:           *leafFanout,
		condensedFanout:      *condensedFanout,
		hardFanout:           *hardFanout,
		freshTailCount:       *freshTail,
		promptDir:            strings.TrimSpace(*promptDir),
		model:                strings.TrimSpace(*model),
	}
	if opts.apply {
		opts.dryRun = false
	}
	if !opts.apply {
		opts.dryRun = true
	}
	if opts.agent == "" {
		return backfillOptions{}, fmt.Errorf("agent must not be empty\n%s", backfillUsageText())
	}
	if opts.sessionID == "" {
		return backfillOptions{}, fmt.Errorf("session_id must not be empty\n%s", backfillUsageText())
	}
	if opts.leafChunkTokens <= 0 {
		return backfillOptions{}, fmt.Errorf("--leaf-chunk-tokens must be > 0")
	}
	if opts.leafTargetTokens <= 0 {
		return backfillOptions{}, fmt.Errorf("--leaf-target-tokens must be > 0")
	}
	if opts.condensedTargetToken <= 0 {
		return backfillOptions{}, fmt.Errorf("--condensed-target-tokens must be > 0")
	}
	if opts.leafFanout <= 1 {
		return backfillOptions{}, fmt.Errorf("--leaf-fanout must be >= 2")
	}
	if opts.condensedFanout <= 1 {
		return backfillOptions{}, fmt.Errorf("--condensed-fanout must be >= 2")
	}
	if opts.hardFanout <= 1 {
		return backfillOptions{}, fmt.Errorf("--hard-fanout must be >= 2")
	}
	if opts.freshTailCount < 0 {
		return backfillOptions{}, fmt.Errorf("--fresh-tail must be >= 0")
	}
	if opts.promptDir != "" {
		opts.promptDir = expandHomePath(opts.promptDir)
	}
	if opts.model == "" {
		opts.model = anthropicModel
	}
	return opts, nil
}

func normalizeBackfillArgs(args []string) ([]string, error) {
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, 2)

	takesValue := map[string]bool{
		"--transplant-to":           true,
		"--title":                   true,
		"--leaf-chunk-tokens":       true,
		"--leaf-target-tokens":      true,
		"--condensed-target-tokens": true,
		"--leaf-fanout":             true,
		"--condensed-fanout":        true,
		"--hard-fanout":             true,
		"--fresh-tail":              true,
		"--prompt-dir":              true,
		"--model":                   true,
	}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		if takesValue[arg] {
			if i+1 >= len(args) {
				return nil, fmt.Errorf("missing value for %s", arg)
			}
			flags = append(flags, arg, args[i+1])
			i++
			continue
		}
		if arg == "--apply" || arg == "--dry-run" || arg == "--single-root" || arg == "--recompact" {
			flags = append(flags, arg)
			continue
		}
		if strings.HasPrefix(arg, "--") {
			flags = append(flags, arg)
			continue
		}
		positionals = append(positionals, arg)
	}
	return append(flags, positionals...), nil
}

func backfillUsageText() string {
	return strings.TrimSpace(`Usage:
  lcm-tui backfill <agent> <session_id> [--dry-run]
  lcm-tui backfill <agent> <session_id> --apply

Flags:
  --dry-run                    show backfill plan without writes (default)
  --apply                      import + compact + optional transplant
  --recompact                  re-run compaction on already-imported session data
  --single-root                force condensed folding until one summary remains when possible
  --transplant-to <conv_id>    transplant backfilled summaries into target conversation
  --title <text>               conversation title override
  --leaf-chunk-tokens <n>      max source tokens per leaf chunk (default 20000)
  --leaf-target-tokens <n>     target output tokens for leaf summaries (default 1200)
  --condensed-target-tokens <n> target output tokens for condensed summaries (default 2000)
  --leaf-fanout <n>            min leaves per d1 condensation (default 8)
  --condensed-fanout <n>       min summaries per d2+ condensation (default 4)
  --hard-fanout <n>            min summaries per forced single-root pass (default 2)
  --fresh-tail <n>             preserve freshest N raw messages from leaf compaction (default 32)
  --prompt-dir <path>          custom prompt template directory
  --model <id>                 Anthropic model (default claude-sonnet-4-20250514)
`)
}

func normalizeBackfillSessionID(raw string) string {
	trimmed := strings.TrimSpace(raw)
	trimmed = strings.TrimSuffix(trimmed, ".jsonl")
	return trimmed
}

func resolveBackfillSessionPath(agentsDir, agent, sessionID string) (string, error) {
	normalizedSessionID := normalizeBackfillSessionID(sessionID)
	if normalizedSessionID == "" {
		return "", errors.New("session ID must not be empty")
	}

	path := filepath.Join(agentsDir, agent, "sessions", normalizedSessionID+".jsonl")
	if _, err := os.Stat(path); err == nil {
		return path, nil
	}
	if strings.HasSuffix(strings.TrimSpace(sessionID), ".jsonl") {
		fallback := filepath.Join(agentsDir, agent, "sessions", strings.TrimSpace(sessionID))
		if _, err := os.Stat(fallback); err == nil {
			return fallback, nil
		}
	}
	return "", fmt.Errorf("session file not found for agent %q session %q", agent, normalizedSessionID)
}

func parseBackfillSessionFile(path string) ([]backfillMessage, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open session %q: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 16*1024*1024)

	messages := make([]backfillMessage, 0, 512)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var item sessionLine
		if err := json.Unmarshal(line, &item); err != nil || item.Type != "message" {
			continue
		}

		var msg lineMessage
		if err := json.Unmarshal(item.Message, &msg); err != nil {
			continue
		}

		createdAt := normalizeBackfillTimestamp(pickTimestamp(item.Timestamp, msg.Timestamp))
		role := normalizeBackfillRole(msg.Role)
		content := strings.TrimSpace(normalizeMessageContent(msg.Content))

		messages = append(messages, backfillMessage{
			seq:       len(messages),
			role:      role,
			content:   content,
			createdAt: createdAt,
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan session %q: %w", path, err)
	}
	return messages, nil
}

func normalizeBackfillRole(role string) string {
	switch strings.ToLower(strings.TrimSpace(role)) {
	case "system", "user", "assistant", "tool":
		return strings.ToLower(strings.TrimSpace(role))
	default:
		// Matches runtime behavior where unknown roles are preserved in parts
		// and treated as assistant for core message rows.
		return "assistant"
	}
}

func normalizeBackfillTimestamp(raw string) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return time.Now().UTC().Format("2006-01-02 15:04:05")
	}
	if parsed, err := parseSQLiteTime(trimmed); err == nil {
		return parsed.UTC().Format("2006-01-02 15:04:05")
	}
	return time.Now().UTC().Format("2006-01-02 15:04:05")
}

func inspectBackfillImportPlan(ctx context.Context, q sqlQueryer, sessionID string) (backfillImportPlan, error) {
	var conversationID int64
	err := q.QueryRowContext(ctx, `
		SELECT conversation_id
		FROM conversations
		WHERE session_id = ?
		ORDER BY conversation_id DESC
		LIMIT 1
	`, sessionID).Scan(&conversationID)
	if errors.Is(err, sql.ErrNoRows) {
		return backfillImportPlan{}, nil
	}
	if err != nil {
		return backfillImportPlan{}, fmt.Errorf("query existing conversation for session %s: %w", sessionID, err)
	}

	var messageCount int
	if err := q.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM messages WHERE conversation_id = ?
	`, conversationID).Scan(&messageCount); err != nil {
		return backfillImportPlan{}, fmt.Errorf("count messages for conversation %d: %w", conversationID, err)
	}

	var contextCount int
	if err := q.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM context_items WHERE conversation_id = ?
	`, conversationID).Scan(&contextCount); err != nil {
		return backfillImportPlan{}, fmt.Errorf("count context items for conversation %d: %w", conversationID, err)
	}

	var summaryCount int
	if err := q.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM summaries WHERE conversation_id = ?
	`, conversationID).Scan(&summaryCount); err != nil {
		return backfillImportPlan{}, fmt.Errorf("count summaries for conversation %d: %w", conversationID, err)
	}

	return backfillImportPlan{
		conversationID: conversationID,
		hasData:        messageCount > 0 || contextCount > 0 || summaryCount > 0,
		messageCount:   messageCount,
		contextCount:   contextCount,
		summaryCount:   summaryCount,
	}, nil
}

func applyBackfillImport(ctx context.Context, db *sql.DB, input backfillSessionInput) (backfillImportResult, error) {
	plan, err := inspectBackfillImportPlan(ctx, db, input.sessionID)
	if err != nil {
		return backfillImportResult{}, err
	}
	if plan.hasData {
		return backfillImportResult{
			conversationID: plan.conversationID,
			imported:       false,
			messageCount:   plan.messageCount,
		}, nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return backfillImportResult{}, fmt.Errorf("begin backfill import transaction: %w", err)
	}
	rollback := true
	defer func() {
		if rollback {
			_ = tx.Rollback()
		}
	}()

	conversationID := plan.conversationID
	title := strings.TrimSpace(input.title)
	if title == "" {
		title = input.sessionID
	}

	if conversationID == 0 {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO conversations (session_id, title, bootstrapped_at)
			VALUES (?, ?, datetime('now'))
		`, input.sessionID, title)
		if err != nil {
			return backfillImportResult{}, fmt.Errorf("insert conversation for session %s: %w", input.sessionID, err)
		}
		conversationID, err = result.LastInsertId()
		if err != nil {
			return backfillImportResult{}, fmt.Errorf("read conversation ID for session %s: %w", input.sessionID, err)
		}
	} else {
		if _, err := tx.ExecContext(ctx, `
			UPDATE conversations
			SET title = COALESCE(NULLIF(title, ''), ?),
			    bootstrapped_at = COALESCE(bootstrapped_at, datetime('now')),
			    updated_at = datetime('now')
			WHERE conversation_id = ?
		`, title, conversationID); err != nil {
			return backfillImportResult{}, fmt.Errorf("update existing conversation %d: %w", conversationID, err)
		}
	}

	for idx, msg := range input.messages {
		result, err := tx.ExecContext(ctx, `
			INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`, conversationID, idx, msg.role, msg.content, estimateTokenCount(msg.content), msg.createdAt)
		if err != nil {
			return backfillImportResult{}, fmt.Errorf("insert backfill message seq=%d: %w", idx, err)
		}
		messageID, err := result.LastInsertId()
		if err != nil {
			return backfillImportResult{}, fmt.Errorf("read message ID for seq=%d: %w", idx, err)
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO context_items (conversation_id, ordinal, item_type, message_id, created_at)
			VALUES (?, ?, 'message', ?, ?)
		`, conversationID, idx, messageID, msg.createdAt); err != nil {
			return backfillImportResult{}, fmt.Errorf("insert context item seq=%d: %w", idx, err)
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO messages_fts (rowid, content)
			VALUES (?, ?)
		`, messageID, msg.content); err != nil {
			return backfillImportResult{}, fmt.Errorf("insert messages_fts row for message %d: %w", messageID, err)
		}

		partID, err := newMessagePartID()
		if err != nil {
			return backfillImportResult{}, err
		}
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO message_parts (part_id, message_id, session_id, part_type, ordinal, text_content)
			VALUES (?, ?, ?, 'text', 0, ?)
		`, partID, messageID, input.sessionID, msg.content); err != nil {
			return backfillImportResult{}, fmt.Errorf("insert message_part for message %d: %w", messageID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return backfillImportResult{}, fmt.Errorf("commit backfill import transaction: %w", err)
	}
	rollback = false

	return backfillImportResult{
		conversationID: conversationID,
		imported:       true,
		messageCount:   len(input.messages),
	}, nil
}

func runBackfillCompaction(ctx context.Context, db *sql.DB, conversationID int64, opts backfillOptions, summarize backfillSummarizeFn) (backfillCompactionStats, error) {
	stats := backfillCompactionStats{}

	for {
		items, err := loadBackfillContextItems(ctx, db, conversationID)
		if err != nil {
			return stats, err
		}

		leafChunk := selectBackfillLeafChunk(items, opts.leafChunkTokens, opts.freshTailCount)
		if len(leafChunk) > 0 {
			if err := applyBackfillLeafPass(ctx, db, conversationID, leafChunk, opts, summarize); err != nil {
				return stats, err
			}
			stats.leafPasses++
			continue
		}

		candidate, ok := selectBackfillCondensedCandidate(items, opts, false)
		if ok {
			if err := applyBackfillCondensedPass(ctx, db, conversationID, candidate, opts, summarize); err != nil {
				return stats, err
			}
			stats.condensedPasses++
			continue
		}

		break
	}

	if opts.singleRoot {
		for {
			items, err := loadBackfillContextItems(ctx, db, conversationID)
			if err != nil {
				return stats, err
			}
			if !backfillCanForceSingleRoot(items) {
				break
			}
			candidate, ok := selectBackfillCondensedCandidate(items, opts, true)
			if !ok {
				break
			}
			if err := applyBackfillCondensedPass(ctx, db, conversationID, candidate, opts, summarize); err != nil {
				return stats, err
			}
			stats.rootFoldPasses++
		}
	}

	return stats, nil
}

func loadBackfillContextItems(ctx context.Context, q sqlQueryer, conversationID int64) ([]backfillContextItem, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT
			ci.ordinal,
			ci.item_type,
			ci.message_id,
			ci.summary_id,
			COALESCE(m.token_count, s.token_count, 0) AS token_count,
			COALESCE(s.depth, 0) AS depth
		FROM context_items ci
		LEFT JOIN messages m ON m.message_id = ci.message_id
		LEFT JOIN summaries s ON s.summary_id = ci.summary_id
		WHERE ci.conversation_id = ?
		ORDER BY ci.ordinal ASC
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("query context items for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	items := make([]backfillContextItem, 0, 256)
	for rows.Next() {
		var item backfillContextItem
		if err := rows.Scan(&item.ordinal, &item.itemType, &item.messageID, &item.summaryID, &item.tokenCount, &item.depth); err != nil {
			return nil, fmt.Errorf("scan context item row: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate context items: %w", err)
	}
	return items, nil
}

func selectBackfillLeafChunk(items []backfillContextItem, chunkTokens, freshTail int) []backfillContextItem {
	if len(items) == 0 {
		return nil
	}
	if chunkTokens <= 0 {
		chunkTokens = 1
	}
	freshTailOrdinal := resolveBackfillFreshTailOrdinal(items, freshTail)
	chunk := make([]backfillContextItem, 0, 32)
	tokens := 0
	started := false
	for _, item := range items {
		if item.ordinal >= freshTailOrdinal {
			break
		}
		if !started {
			if item.itemType != "message" || !item.messageID.Valid {
				continue
			}
			started = true
		} else if item.itemType != "message" || !item.messageID.Valid {
			break
		}

		messageTokens := item.tokenCount
		if messageTokens <= 0 {
			messageTokens = 1
		}
		if len(chunk) > 0 && tokens+messageTokens > chunkTokens {
			break
		}
		chunk = append(chunk, item)
		tokens += messageTokens
		if tokens >= chunkTokens {
			break
		}
	}
	return chunk
}

func resolveBackfillFreshTailOrdinal(items []backfillContextItem, freshTail int) int64 {
	if freshTail <= 0 {
		return int64(^uint64(0) >> 1)
	}
	messageItems := make([]backfillContextItem, 0, len(items))
	for _, item := range items {
		if item.itemType == "message" && item.messageID.Valid {
			messageItems = append(messageItems, item)
		}
	}
	if len(messageItems) == 0 {
		return int64(^uint64(0) >> 1)
	}
	tailStart := len(messageItems) - freshTail
	if tailStart < 0 {
		tailStart = 0
	}
	return messageItems[tailStart].ordinal
}

type backfillCondensedCandidate struct {
	targetDepth int
	chunk       []backfillContextItem
}

func selectBackfillCondensedCandidate(items []backfillContextItem, opts backfillOptions, hard bool) (backfillCondensedCandidate, bool) {
	freshTailOrdinal := resolveBackfillFreshTailOrdinal(items, opts.freshTailCount)
	depthSet := make(map[int]bool)
	for _, item := range items {
		if item.ordinal >= freshTailOrdinal {
			break
		}
		if item.itemType == "summary" && item.summaryID.Valid {
			depthSet[item.depth] = true
		}
	}
	if len(depthSet) == 0 {
		return backfillCondensedCandidate{}, false
	}
	depths := make([]int, 0, len(depthSet))
	for depth := range depthSet {
		depths = append(depths, depth)
	}
	sort.Ints(depths)

	minChunkTokens := opts.condensedTargetToken
	floor := opts.leafChunkTokens / 2
	if floor > minChunkTokens {
		minChunkTokens = floor
	}
	if hard {
		minChunkTokens = 0
	}

	for _, depth := range depths {
		chunk, tokenSum := selectBackfillChunkAtDepth(items, depth, opts.leafChunkTokens, freshTailOrdinal)
		if len(chunk) == 0 {
			continue
		}
		fanout := opts.condensedFanout
		if depth == 0 {
			fanout = opts.leafFanout
		}
		if hard {
			fanout = opts.hardFanout
		}
		if len(chunk) < fanout {
			continue
		}
		if tokenSum < minChunkTokens {
			continue
		}
		return backfillCondensedCandidate{targetDepth: depth, chunk: chunk}, true
	}
	return backfillCondensedCandidate{}, false
}

func selectBackfillChunkAtDepth(items []backfillContextItem, depth, chunkTokenBudget int, freshTailOrdinal int64) ([]backfillContextItem, int) {
	if chunkTokenBudget <= 0 {
		chunkTokenBudget = 1
	}
	chunk := make([]backfillContextItem, 0, 16)
	tokenSum := 0
	for _, item := range items {
		if item.ordinal >= freshTailOrdinal {
			break
		}
		if item.itemType != "summary" || !item.summaryID.Valid {
			if len(chunk) > 0 {
				break
			}
			continue
		}
		if item.depth != depth {
			if len(chunk) > 0 {
				break
			}
			continue
		}
		tokens := item.tokenCount
		if tokens <= 0 {
			tokens = 1
		}
		if len(chunk) > 0 && tokenSum+tokens > chunkTokenBudget {
			break
		}
		chunk = append(chunk, item)
		tokenSum += tokens
		if tokenSum >= chunkTokenBudget {
			break
		}
	}
	return chunk, tokenSum
}

func applyBackfillLeafPass(ctx context.Context, db *sql.DB, conversationID int64, chunk []backfillContextItem, opts backfillOptions, summarize backfillSummarizeFn) error {
	if len(chunk) == 0 {
		return nil
	}

	messages, err := loadBackfillMessagesByContextChunk(ctx, db, chunk)
	if err != nil {
		return err
	}
	if len(messages) == 0 {
		return nil
	}

	loc := time.Local
	sourceParts := make([]string, 0, len(messages))
	earliest := ""
	latest := ""
	for _, message := range messages {
		ts := formatTimestampWithLoc(message.createdAt, loc)
		if ts != "" {
			sourceParts = append(sourceParts, "["+ts+"]\n"+message.content)
		} else {
			sourceParts = append(sourceParts, message.content)
		}
		if earliest == "" || message.createdAt < earliest {
			earliest = message.createdAt
		}
		if latest == "" || message.createdAt > latest {
			latest = message.createdAt
		}
	}

	previousContext, err := backfillPriorSummaryContext(ctx, db, conversationID, chunk[0].ordinal, -1, 2)
	if err != nil {
		return err
	}
	sourceText := strings.Join(sourceParts, "\n\n")
	targetTokens := opts.leafTargetTokens
	if targetTokens <= 0 {
		targetTokens = calculateLeafTargetTokens(estimateTokenCount(sourceText))
	}
	prompt, err := renderPrompt(0, PromptVars{
		TargetTokens:    targetTokens,
		PreviousContext: previousContext,
		ChildCount:      len(messages),
		TimeRange:       formatTimeRange(formatTimestampWithLoc(earliest, loc), formatTimestampWithLoc(latest, loc)),
		Depth:           0,
		SourceText:      sourceText,
	}, opts.promptDir)
	if err != nil {
		return fmt.Errorf("render leaf prompt: %w", err)
	}

	newContent, err := summarize(ctx, prompt, targetTokens)
	if err != nil {
		return fmt.Errorf("summarize leaf chunk: %w", err)
	}
	newContent = strings.TrimSpace(newContent)
	if newContent == "" {
		return errors.New("leaf summarization returned empty content")
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin leaf compaction transaction: %w", err)
	}
	rollback := true
	defer func() {
		if rollback {
			_ = tx.Rollback()
		}
	}()

	summaryID, err := generateSummaryID(ctx, tx)
	if err != nil {
		return err
	}
	summaryCreatedAt := messages[len(messages)-1].createdAt
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, created_at, file_ids, depth)
		VALUES (?, ?, 'leaf', ?, ?, ?, '[]', 0)
	`, summaryID, conversationID, newContent, estimateTokenCount(newContent), summaryCreatedAt); err != nil {
		return fmt.Errorf("insert leaf summary %s: %w", summaryID, err)
	}

	for i, msg := range messages {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO summary_messages (summary_id, message_id, ordinal)
			VALUES (?, ?, ?)
		`, summaryID, msg.messageID, i); err != nil {
			return fmt.Errorf("insert summary_message for %s: %w", summaryID, err)
		}
	}

	startOrdinal := chunk[0].ordinal
	endOrdinal := chunk[len(chunk)-1].ordinal
	if err := replaceBackfillContextRangeWithSummary(ctx, tx, conversationID, startOrdinal, endOrdinal, summaryID); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit leaf compaction transaction: %w", err)
	}
	rollback = false
	return nil
}

type backfillChunkMessage struct {
	messageID int64
	content   string
	createdAt string
}

func loadBackfillMessagesByContextChunk(ctx context.Context, q sqlQueryer, chunk []backfillContextItem) ([]backfillChunkMessage, error) {
	messages := make([]backfillChunkMessage, 0, len(chunk))
	for _, item := range chunk {
		if !item.messageID.Valid {
			continue
		}
		var row backfillChunkMessage
		row.messageID = item.messageID.Int64
		if err := q.QueryRowContext(ctx, `
			SELECT COALESCE(content, ''), COALESCE(created_at, '')
			FROM messages
			WHERE message_id = ?
		`, row.messageID).Scan(&row.content, &row.createdAt); err != nil {
			return nil, fmt.Errorf("load message %d for backfill chunk: %w", row.messageID, err)
		}
		messages = append(messages, row)
	}
	return messages, nil
}

func backfillPriorSummaryContext(ctx context.Context, q sqlQueryer, conversationID int64, beforeOrdinal int64, depthFilter int, take int) (string, error) {
	if take <= 0 {
		return "", nil
	}
	rows, err := q.QueryContext(ctx, `
		SELECT ci.summary_id, COALESCE(s.depth, 0), COALESCE(s.content, '')
		FROM context_items ci
		JOIN summaries s ON s.summary_id = ci.summary_id
		WHERE ci.conversation_id = ?
		  AND ci.item_type = 'summary'
		  AND ci.ordinal < ?
		ORDER BY ci.ordinal DESC
		LIMIT 8
	`, conversationID, beforeOrdinal)
	if err != nil {
		return "", fmt.Errorf("query prior summary context: %w", err)
	}
	defer rows.Close()

	parts := make([]string, 0, take)
	for rows.Next() {
		var summaryID string
		var depth int
		var content string
		if err := rows.Scan(&summaryID, &depth, &content); err != nil {
			return "", fmt.Errorf("scan prior summary context row: %w", err)
		}
		if depthFilter >= 0 && depth != depthFilter {
			continue
		}
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		parts = append(parts, content)
		if len(parts) >= take {
			break
		}
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("iterate prior summary context rows: %w", err)
	}
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	return strings.Join(parts, "\n\n"), nil
}

func applyBackfillCondensedPass(ctx context.Context, db *sql.DB, conversationID int64, candidate backfillCondensedCandidate, opts backfillOptions, summarize backfillSummarizeFn) error {
	if len(candidate.chunk) == 0 {
		return nil
	}

	summaries, err := loadBackfillSummariesByChunk(ctx, db, candidate.chunk)
	if err != nil {
		return err
	}
	if len(summaries) == 0 {
		return nil
	}

	loc := time.Local
	sourceParts := make([]string, 0, len(summaries))
	earliest := ""
	latest := ""
	totalDescendants := 0
	for _, summary := range summaries {
		rangeText := formatTimeRange(formatTimestampWithLoc(summary.earliestAt, loc), formatTimestampWithLoc(summary.latestAt, loc))
		if rangeText == "" {
			rangeText = formatTimestampWithLoc(summary.createdAt, loc)
		}
		if rangeText != "" {
			sourceParts = append(sourceParts, "["+rangeText+"]\n"+summary.content)
		} else {
			sourceParts = append(sourceParts, summary.content)
		}

		start := summary.earliestAt
		if strings.TrimSpace(start) == "" {
			start = summary.createdAt
		}
		end := summary.latestAt
		if strings.TrimSpace(end) == "" {
			end = summary.createdAt
		}
		if earliest == "" || (start != "" && start < earliest) {
			earliest = start
		}
		if latest == "" || (end != "" && end > latest) {
			latest = end
		}

		if summary.descendants < 0 {
			summary.descendants = 0
		}
		totalDescendants += summary.descendants + 1
	}

	previousContext := ""
	if candidate.targetDepth == 0 {
		previousContext, err = backfillPriorSummaryContext(ctx, db, conversationID, candidate.chunk[0].ordinal, candidate.targetDepth, 2)
		if err != nil {
			return err
		}
	}

	targetTokens := opts.condensedTargetToken
	if targetTokens <= 0 {
		targetTokens = condensedTargetTokens
	}
	sourceText := strings.Join(sourceParts, "\n\n")
	prompt, err := renderPrompt(candidate.targetDepth+1, PromptVars{
		TargetTokens:    targetTokens,
		PreviousContext: previousContext,
		ChildCount:      len(summaries),
		TimeRange:       formatTimeRange(formatTimestampWithLoc(earliest, loc), formatTimestampWithLoc(latest, loc)),
		Depth:           candidate.targetDepth + 1,
		SourceText:      sourceText,
	}, opts.promptDir)
	if err != nil {
		return fmt.Errorf("render condensed prompt: %w", err)
	}

	newContent, err := summarize(ctx, prompt, targetTokens)
	if err != nil {
		return fmt.Errorf("summarize condensed chunk: %w", err)
	}
	newContent = strings.TrimSpace(newContent)
	if newContent == "" {
		return errors.New("condensed summarization returned empty content")
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin condensed compaction transaction: %w", err)
	}
	rollback := true
	defer func() {
		if rollback {
			_ = tx.Rollback()
		}
	}()

	summaryID, err := generateSummaryID(ctx, tx)
	if err != nil {
		return err
	}
	summaryCreatedAt := latest
	if strings.TrimSpace(summaryCreatedAt) == "" {
		summaryCreatedAt = time.Now().UTC().Format("2006-01-02 15:04:05")
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, created_at, file_ids, depth, earliest_at, latest_at, descendant_count)
		VALUES (?, ?, 'condensed', ?, ?, ?, '[]', ?, ?, ?, ?)
	`, summaryID, conversationID, newContent, estimateTokenCount(newContent), summaryCreatedAt, candidate.targetDepth+1, earliest, latest, totalDescendants); err != nil {
		// Compatibility fallback for DBs that have not yet migrated metadata columns.
		if _, fallbackErr := tx.ExecContext(ctx, `
			INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, created_at, file_ids, depth)
			VALUES (?, ?, 'condensed', ?, ?, ?, '[]', ?)
		`, summaryID, conversationID, newContent, estimateTokenCount(newContent), summaryCreatedAt, candidate.targetDepth+1); fallbackErr != nil {
			return fmt.Errorf("insert condensed summary %s: %w", summaryID, err)
		}
	}

	for i, summary := range summaries {
		if _, err := tx.ExecContext(ctx, `
			INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
			VALUES (?, ?, ?)
		`, summaryID, summary.summaryID, i); err != nil {
			return fmt.Errorf("insert summary_parent %s -> %s: %w", summaryID, summary.summaryID, err)
		}
	}

	startOrdinal := candidate.chunk[0].ordinal
	endOrdinal := candidate.chunk[len(candidate.chunk)-1].ordinal
	if err := replaceBackfillContextRangeWithSummary(ctx, tx, conversationID, startOrdinal, endOrdinal, summaryID); err != nil {
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit condensed compaction transaction: %w", err)
	}
	rollback = false
	return nil
}

func loadBackfillSummariesByChunk(ctx context.Context, q sqlQueryer, chunk []backfillContextItem) ([]backfillSummaryRecord, error) {
	summaries := make([]backfillSummaryRecord, 0, len(chunk))
	for _, item := range chunk {
		if !item.summaryID.Valid {
			continue
		}
		row := backfillSummaryRecord{summaryID: item.summaryID.String}
		err := q.QueryRowContext(ctx, `
			SELECT
				COALESCE(content, ''),
				COALESCE(token_count, 0),
				COALESCE(depth, 0),
				COALESCE(kind, 'leaf'),
				COALESCE(created_at, ''),
				COALESCE(earliest_at, ''),
				COALESCE(latest_at, ''),
				COALESCE(descendant_count, 0)
			FROM summaries
			WHERE summary_id = ?
		`, row.summaryID).Scan(&row.content, &row.tokenCount, &row.depth, &row.kind, &row.createdAt, &row.earliestAt, &row.latestAt, &row.descendants)
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "no such column") {
				if fallbackErr := q.QueryRowContext(ctx, `
					SELECT
						COALESCE(content, ''),
						COALESCE(token_count, 0),
						COALESCE(depth, 0),
						COALESCE(kind, 'leaf'),
						COALESCE(created_at, '')
					FROM summaries
					WHERE summary_id = ?
				`, row.summaryID).Scan(&row.content, &row.tokenCount, &row.depth, &row.kind, &row.createdAt); fallbackErr != nil {
					return nil, fmt.Errorf("load summary %s for condensed pass: %w", row.summaryID, fallbackErr)
				}
			} else {
				return nil, fmt.Errorf("load summary %s for condensed pass: %w", row.summaryID, err)
			}
		}
		summaries = append(summaries, row)
	}
	return summaries, nil
}

func replaceBackfillContextRangeWithSummary(ctx context.Context, q sqlQueryer, conversationID, startOrdinal, endOrdinal int64, summaryID string) error {
	if _, err := q.ExecContext(ctx, `
		DELETE FROM context_items
		WHERE conversation_id = ?
		  AND ordinal >= ?
		  AND ordinal <= ?
	`, conversationID, startOrdinal, endOrdinal); err != nil {
		return fmt.Errorf("delete context range [%d,%d] for conversation %d: %w", startOrdinal, endOrdinal, conversationID, err)
	}

	if _, err := q.ExecContext(ctx, `
		INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
		VALUES (?, ?, 'summary', ?, datetime('now'))
	`, conversationID, startOrdinal, summaryID); err != nil {
		return fmt.Errorf("insert replacement summary %s at ordinal %d: %w", summaryID, startOrdinal, err)
	}

	rows, err := q.QueryContext(ctx, `
		SELECT ordinal
		FROM context_items
		WHERE conversation_id = ?
		ORDER BY ordinal ASC
	`, conversationID)
	if err != nil {
		return fmt.Errorf("query context ordinals for resequence: %w", err)
	}
	ordinals := make([]int64, 0, 256)
	for rows.Next() {
		var ordinal int64
		if err := rows.Scan(&ordinal); err != nil {
			rows.Close()
			return fmt.Errorf("scan context ordinal for resequence: %w", err)
		}
		ordinals = append(ordinals, ordinal)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return fmt.Errorf("iterate context ordinals for resequence: %w", err)
	}
	if err := rows.Close(); err != nil {
		return fmt.Errorf("close context ordinal rows: %w", err)
	}

	for i, oldOrdinal := range ordinals {
		tmpOrdinal := -int64(i + 1)
		if _, err := q.ExecContext(ctx, `
			UPDATE context_items
			SET ordinal = ?
			WHERE conversation_id = ? AND ordinal = ?
		`, tmpOrdinal, conversationID, oldOrdinal); err != nil {
			return fmt.Errorf("stage context ordinal %d -> %d: %w", oldOrdinal, tmpOrdinal, err)
		}
	}
	for i := range ordinals {
		finalOrdinal := int64(i)
		tmpOrdinal := -int64(i + 1)
		if _, err := q.ExecContext(ctx, `
			UPDATE context_items
			SET ordinal = ?
			WHERE conversation_id = ? AND ordinal = ?
		`, finalOrdinal, conversationID, tmpOrdinal); err != nil {
			return fmt.Errorf("finalize context ordinal %d -> %d: %w", tmpOrdinal, finalOrdinal, err)
		}
	}
	return nil
}

func backfillCanForceSingleRoot(items []backfillContextItem) bool {
	summaryCount := 0
	for _, item := range items {
		if item.itemType == "message" && item.messageID.Valid {
			return false
		}
		if item.itemType == "summary" && item.summaryID.Valid {
			summaryCount++
		}
	}
	return summaryCount > 1
}
