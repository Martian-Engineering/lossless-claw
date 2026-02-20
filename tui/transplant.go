package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
)

type transplantOptions struct {
	apply  bool
	dryRun bool
}

type transplantContextSummary struct {
	ordinal    int64
	summaryID  string
	kind       string
	depth      int
	tokenCount int
	content    string
	createdAt  string
	fileIDs    string
}

type transplantSummary struct {
	summaryID      string
	conversationID int64
	kind           string
	content        string
	tokenCount     int
	createdAt      string
	fileIDs        string
	depth          int
}

type transplantMessage struct {
	messageID      int64
	conversationID int64
	seq            int64
	role           string
	content        string
	tokenCount     int
	createdAt      string
}

type transplantMessagePart struct {
	partType       string
	ordinal        int64
	textContent    sql.NullString
	isIgnored      sql.NullInt64
	isSynthetic    sql.NullInt64
	toolCallID     sql.NullString
	toolName       sql.NullString
	toolStatus     sql.NullString
	toolInput      sql.NullString
	toolOutput     sql.NullString
	toolError      sql.NullString
	toolTitle      sql.NullString
	patchHash      sql.NullString
	patchFiles     sql.NullString
	fileMime       sql.NullString
	fileName       sql.NullString
	fileURL        sql.NullString
	subtaskPrompt  sql.NullString
	subtaskDesc    sql.NullString
	subtaskAgent   sql.NullString
	stepReason     sql.NullString
	stepCost       sql.NullFloat64
	stepTokensIn   sql.NullInt64
	stepTokensOut  sql.NullInt64
	snapshotHash   sql.NullString
	compactionAuto sql.NullInt64
	metadata       sql.NullString
}

type transplantContextStats struct {
	total     int
	summaries int
	messages  int
}

type transplantDuplicate struct {
	summaryID   string
	contentHash string
	targetCount int
}

type transplantPlan struct {
	sourceConversationID int64
	targetConversationID int64
	sourceContext        []transplantContextSummary
	ordered              []transplantSummary
	depthCounts          map[int]int
	targetContext        transplantContextStats
	contextTokenOverhead int
	duplicates           []transplantDuplicate
}

// runTransplantCommand executes the standalone transplant CLI path.
func runTransplantCommand(args []string) error {
	opts, sourceConversationID, targetConversationID, err := parseTransplantArgs(args)
	if err != nil {
		return err
	}

	paths, err := resolveDataPaths()
	if err != nil {
		return err
	}

	db, err := openLCMDB(paths.lcmDBPath)
	if err != nil {
		return err
	}
	defer db.Close()

	ctx := context.Background()
	plan, err := buildTransplantPlan(ctx, db, sourceConversationID, targetConversationID)
	if err != nil {
		return err
	}
	if len(plan.sourceContext) == 0 {
		fmt.Printf("Source conversation %d has no summary context items. Nothing to transplant.\n", sourceConversationID)
		return nil
	}

	printTransplantDryRunReport(plan)
	if len(plan.duplicates) > 0 {
		if opts.apply {
			return fmt.Errorf("aborting transplant: target conversation %d already contains %d matching summary content hashes", targetConversationID, len(plan.duplicates))
		}
		return nil
	}
	if opts.dryRun {
		return nil
	}

	copied, err := applyTransplant(ctx, db, plan)
	if err != nil {
		return err
	}

	fmt.Printf("\nDone. %d summaries copied. %d context items prepended to conversation %d.\n", copied, len(plan.sourceContext), targetConversationID)
	return nil
}

func parseTransplantArgs(args []string) (transplantOptions, int64, int64, error) {
	fs := flag.NewFlagSet("transplant", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	apply := fs.Bool("apply", false, "apply transplant to the DB")
	dryRun := fs.Bool("dry-run", true, "show what would be transplanted")

	normalizedArgs, err := normalizeTransplantArgs(args)
	if err != nil {
		return transplantOptions{}, 0, 0, fmt.Errorf("%w\n%s", err, transplantUsageText())
	}
	if err := fs.Parse(normalizedArgs); err != nil {
		return transplantOptions{}, 0, 0, fmt.Errorf("%w\n%s", err, transplantUsageText())
	}
	if fs.NArg() != 2 {
		return transplantOptions{}, 0, 0, fmt.Errorf("source and target conversation IDs are required\n%s", transplantUsageText())
	}

	sourceConversationID, err := strconv.ParseInt(fs.Arg(0), 10, 64)
	if err != nil {
		return transplantOptions{}, 0, 0, fmt.Errorf("parse source conversation ID %q: %w", fs.Arg(0), err)
	}
	targetConversationID, err := strconv.ParseInt(fs.Arg(1), 10, 64)
	if err != nil {
		return transplantOptions{}, 0, 0, fmt.Errorf("parse target conversation ID %q: %w", fs.Arg(1), err)
	}

	opts := transplantOptions{
		apply:  *apply,
		dryRun: *dryRun,
	}
	if opts.apply {
		opts.dryRun = false
	}
	if !opts.apply {
		opts.dryRun = true
	}
	return opts, sourceConversationID, targetConversationID, nil
}

func normalizeTransplantArgs(args []string) ([]string, error) {
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, 2)

	for _, arg := range args {
		switch arg {
		case "--apply", "--dry-run":
			flags = append(flags, arg)
		case "--help", "-h":
			flags = append(flags, arg)
		default:
			if strings.HasPrefix(arg, "--") {
				flags = append(flags, arg)
				continue
			}
			positionals = append(positionals, arg)
		}
	}
	return append(flags, positionals...), nil
}

func transplantUsageText() string {
	return strings.TrimSpace(`
Usage:
  lcm-tui transplant <source_conversation_id> <target_conversation_id> [--dry-run]
  lcm-tui transplant <source_conversation_id> <target_conversation_id> --apply
`)
}

// buildTransplantPlan gathers source context summaries, recursively resolves the
// full parent DAG, and computes a deterministic copy order (d0 -> dN).
func buildTransplantPlan(ctx context.Context, q sqlQueryer, sourceConversationID, targetConversationID int64) (transplantPlan, error) {
	if sourceConversationID == targetConversationID {
		return transplantPlan{}, errors.New("source and target conversation IDs must be different")
	}

	sourceExists, err := conversationExists(ctx, q, sourceConversationID)
	if err != nil {
		return transplantPlan{}, err
	}
	if !sourceExists {
		return transplantPlan{}, fmt.Errorf("source conversation %d not found", sourceConversationID)
	}

	targetExists, err := conversationExists(ctx, q, targetConversationID)
	if err != nil {
		return transplantPlan{}, err
	}
	if !targetExists {
		return transplantPlan{}, fmt.Errorf("target conversation %d not found", targetConversationID)
	}

	sourceContext, err := loadSourceContextSummaries(ctx, q, sourceConversationID)
	if err != nil {
		return transplantPlan{}, err
	}
	if len(sourceContext) == 0 {
		return transplantPlan{
			sourceConversationID: sourceConversationID,
			targetConversationID: targetConversationID,
		}, nil
	}

	rootIDs := make([]string, 0, len(sourceContext))
	contextTokenOverhead := 0
	for _, item := range sourceContext {
		rootIDs = append(rootIDs, item.summaryID)
		contextTokenOverhead += item.tokenCount
	}

	allSummaryIDs, err := collectSummaryDAGIDs(ctx, q, rootIDs)
	if err != nil {
		return transplantPlan{}, err
	}
	allSummaries, err := loadSummariesByIDs(ctx, q, allSummaryIDs)
	if err != nil {
		return transplantPlan{}, err
	}

	for _, summary := range allSummaries {
		if summary.conversationID != sourceConversationID {
			return transplantPlan{}, fmt.Errorf("summary %s belongs to conversation %d, expected %d", summary.summaryID, summary.conversationID, sourceConversationID)
		}
	}

	ordered := append([]transplantSummary(nil), allSummaries...)
	sort.Slice(ordered, func(i, j int) bool {
		left := ordered[i]
		right := ordered[j]
		if left.depth != right.depth {
			return left.depth < right.depth
		}
		if left.createdAt != right.createdAt {
			return left.createdAt < right.createdAt
		}
		return left.summaryID < right.summaryID
	})

	depthCounts := make(map[int]int)
	for _, summary := range ordered {
		depthCounts[summary.depth]++
	}

	targetContext, err := loadContextStats(ctx, q, targetConversationID)
	if err != nil {
		return transplantPlan{}, err
	}

	duplicates, err := detectSummaryContentDuplicates(ctx, q, targetConversationID, ordered)
	if err != nil {
		return transplantPlan{}, err
	}

	return transplantPlan{
		sourceConversationID: sourceConversationID,
		targetConversationID: targetConversationID,
		sourceContext:        sourceContext,
		ordered:              ordered,
		depthCounts:          depthCounts,
		targetContext:        targetContext,
		contextTokenOverhead: contextTokenOverhead,
		duplicates:           duplicates,
	}, nil
}

func conversationExists(ctx context.Context, q sqlQueryer, conversationID int64) (bool, error) {
	var count int
	if err := q.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM conversations
		WHERE conversation_id = ?
	`, conversationID).Scan(&count); err != nil {
		return false, fmt.Errorf("query conversation %d: %w", conversationID, err)
	}
	return count > 0, nil
}

func loadSourceContextSummaries(ctx context.Context, q sqlQueryer, conversationID int64) ([]transplantContextSummary, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT
			ci.ordinal,
			ci.summary_id,
			s.kind,
			s.depth,
			s.token_count,
			s.content,
			s.created_at,
			s.file_ids
		FROM context_items ci
		JOIN summaries s ON s.summary_id = ci.summary_id
		WHERE ci.conversation_id = ?
		  AND ci.item_type = 'summary'
		ORDER BY ci.ordinal ASC
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("query context summaries for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	var items []transplantContextSummary
	for rows.Next() {
		var item transplantContextSummary
		if err := rows.Scan(
			&item.ordinal,
			&item.summaryID,
			&item.kind,
			&item.depth,
			&item.tokenCount,
			&item.content,
			&item.createdAt,
			&item.fileIDs,
		); err != nil {
			return nil, fmt.Errorf("scan context summary row: %w", err)
		}
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate context summaries for conversation %d: %w", conversationID, err)
	}
	return items, nil
}

// collectSummaryDAGIDs traverses summary_parents recursively from roots and
// returns the deduplicated set of summary IDs to copy.
func collectSummaryDAGIDs(ctx context.Context, q sqlQueryer, rootIDs []string) ([]string, error) {
	seen := make(map[string]bool, len(rootIDs))
	queue := append([]string(nil), rootIDs...)

	for idx := 0; idx < len(queue); idx++ {
		summaryID := queue[idx]
		if seen[summaryID] {
			continue
		}
		seen[summaryID] = true

		parents, err := loadParentSummaryIDs(ctx, q, summaryID)
		if err != nil {
			return nil, err
		}
		for _, parentID := range parents {
			if !seen[parentID] {
				queue = append(queue, parentID)
			}
		}
	}

	ids := make([]string, 0, len(seen))
	for summaryID := range seen {
		ids = append(ids, summaryID)
	}
	sort.Strings(ids)
	return ids, nil
}

func loadParentSummaryIDs(ctx context.Context, q sqlQueryer, summaryID string) ([]string, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT parent_summary_id
		FROM summary_parents
		WHERE summary_id = ?
		ORDER BY ordinal ASC
	`, summaryID)
	if err != nil {
		return nil, fmt.Errorf("query parent summaries for %s: %w", summaryID, err)
	}
	defer rows.Close()

	var parents []string
	for rows.Next() {
		var parentID string
		if err := rows.Scan(&parentID); err != nil {
			return nil, fmt.Errorf("scan parent summary row for %s: %w", summaryID, err)
		}
		parents = append(parents, parentID)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate parent summary rows for %s: %w", summaryID, err)
	}
	return parents, nil
}

func loadSummariesByIDs(ctx context.Context, q sqlQueryer, summaryIDs []string) ([]transplantSummary, error) {
	if len(summaryIDs) == 0 {
		return nil, nil
	}

	const batchSize = 200
	result := make([]transplantSummary, 0, len(summaryIDs))

	for start := 0; start < len(summaryIDs); start += batchSize {
		end := start + batchSize
		if end > len(summaryIDs) {
			end = len(summaryIDs)
		}

		batch := summaryIDs[start:end]
		placeholders := strings.TrimRight(strings.Repeat("?,", len(batch)), ",")
		query := fmt.Sprintf(`
			SELECT
				summary_id,
				conversation_id,
				kind,
				content,
				token_count,
				created_at,
				file_ids,
				depth
			FROM summaries
			WHERE summary_id IN (%s)
		`, placeholders)

		args := make([]any, 0, len(batch))
		for _, summaryID := range batch {
			args = append(args, summaryID)
		}

		rows, err := q.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, fmt.Errorf("query summaries for transplant batch: %w", err)
		}

		for rows.Next() {
			var summary transplantSummary
			if err := rows.Scan(
				&summary.summaryID,
				&summary.conversationID,
				&summary.kind,
				&summary.content,
				&summary.tokenCount,
				&summary.createdAt,
				&summary.fileIDs,
				&summary.depth,
			); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan summary row for transplant: %w", err)
			}
			result = append(result, summary)
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, fmt.Errorf("iterate transplant summary rows: %w", err)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("close transplant summary rows: %w", err)
		}
	}

	if len(result) != len(summaryIDs) {
		return nil, fmt.Errorf("resolved %d summary rows for %d IDs", len(result), len(summaryIDs))
	}
	return result, nil
}

func loadContextStats(ctx context.Context, q sqlQueryer, conversationID int64) (transplantContextStats, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT item_type, COUNT(*)
		FROM context_items
		WHERE conversation_id = ?
		GROUP BY item_type
	`, conversationID)
	if err != nil {
		return transplantContextStats{}, fmt.Errorf("query context stats for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	stats := transplantContextStats{}
	for rows.Next() {
		var itemType string
		var count int
		if err := rows.Scan(&itemType, &count); err != nil {
			return transplantContextStats{}, fmt.Errorf("scan context stats row: %w", err)
		}
		stats.total += count
		switch itemType {
		case "summary":
			stats.summaries = count
		case "message":
			stats.messages = count
		}
	}
	if err := rows.Err(); err != nil {
		return transplantContextStats{}, fmt.Errorf("iterate context stats for conversation %d: %w", conversationID, err)
	}
	return stats, nil
}

func detectSummaryContentDuplicates(ctx context.Context, q sqlQueryer, targetConversationID int64, sourceSummaries []transplantSummary) ([]transplantDuplicate, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT content
		FROM summaries
		WHERE conversation_id = ?
	`, targetConversationID)
	if err != nil {
		return nil, fmt.Errorf("query target summaries for conversation %d: %w", targetConversationID, err)
	}
	defer rows.Close()

	targetHashes := make(map[string]int)
	for rows.Next() {
		var content string
		if err := rows.Scan(&content); err != nil {
			return nil, fmt.Errorf("scan target summary content: %w", err)
		}
		hash := contentSHA256(content)
		targetHashes[hash]++
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate target summaries for conversation %d: %w", targetConversationID, err)
	}

	duplicates := make([]transplantDuplicate, 0)
	seen := make(map[string]bool)
	for _, summary := range sourceSummaries {
		hash := contentSHA256(summary.content)
		targetCount := targetHashes[hash]
		if targetCount == 0 {
			continue
		}
		if seen[summary.summaryID] {
			continue
		}
		seen[summary.summaryID] = true
		duplicates = append(duplicates, transplantDuplicate{
			summaryID:   summary.summaryID,
			contentHash: hash,
			targetCount: targetCount,
		})
	}
	sort.Slice(duplicates, func(i, j int) bool {
		return duplicates[i].summaryID < duplicates[j].summaryID
	})
	return duplicates, nil
}

func contentSHA256(content string) string {
	sum := sha256.Sum256([]byte(content))
	return hex.EncodeToString(sum[:])
}

func printTransplantDryRunReport(plan transplantPlan) {
	fmt.Printf("Transplant: conversation %d -> conversation %d\n\n", plan.sourceConversationID, plan.targetConversationID)

	fmt.Printf("Source context summaries (%d):\n", len(plan.sourceContext))
	for _, item := range plan.sourceContext {
		preview := previewForLog(item.content, 56)
		fmt.Printf("  %s  %-9s d%d  %dt  %q\n", item.summaryID, item.kind, item.depth, item.tokenCount, preview)
	}
	fmt.Println()

	ancestorCount := len(plan.ordered) - len(plan.sourceContext)
	fmt.Printf("Full DAG to copy: %d summaries (%d context + %d ancestors)\n", len(plan.ordered), len(plan.sourceContext), ancestorCount)
	depths := make([]int, 0, len(plan.depthCounts))
	for depth := range plan.depthCounts {
		depths = append(depths, depth)
	}
	sort.Ints(depths)
	for _, depth := range depths {
		label := "condensed"
		if depth == 0 {
			label = "leaves"
		}
		fmt.Printf("  d%d: %d %s\n", depth, plan.depthCounts[depth], label)
	}
	fmt.Println()

	fmt.Printf("Target current context (%d items):\n", plan.targetContext.total)
	fmt.Printf("  %d summaries + %d messages\n\n", plan.targetContext.summaries, plan.targetContext.messages)

	fmt.Println("After transplant:")
	fmt.Printf("  %d new context items prepended\n", len(plan.sourceContext))
	fmt.Printf("  %d summaries copied (new IDs, owned by conversation %d)\n", len(plan.ordered), plan.targetConversationID)
	fmt.Printf("  Estimated token overhead in context: ~%d tokens\n", plan.contextTokenOverhead)

	if len(plan.duplicates) > 0 {
		fmt.Println()
		fmt.Printf("Warning: found %d source summaries with content already present in target conversation.\n", len(plan.duplicates))
		limit := len(plan.duplicates)
		if limit > 5 {
			limit = 5
		}
		for _, duplicate := range plan.duplicates[:limit] {
			fmt.Printf("  %s  hash=%s  matches_in_target=%d\n", duplicate.summaryID, duplicate.contentHash, duplicate.targetCount)
		}
		if len(plan.duplicates) > limit {
			fmt.Printf("  ... and %d more\n", len(plan.duplicates)-limit)
		}
		fmt.Println("Aborting apply to avoid duplicate transplants.")
		return
	}

	fmt.Println()
	fmt.Println("Run with --apply to execute.")
}

// applyTransplant copies summaries, remaps DAG edges, deep-copies linked
// messages, rewires summary_messages, and prepends context items in one
// transaction. New summaries and copied messages are owned by the target
// conversation.
func applyTransplant(ctx context.Context, db *sql.DB, plan transplantPlan) (int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin transplant transaction: %w", err)
	}

	rollbackNeeded := true
	defer func() {
		if rollbackNeeded {
			_ = tx.Rollback()
		}
	}()

	oldToNew := make(map[string]string, len(plan.ordered))
	for i, source := range plan.ordered {
		newSummaryID, err := generateSummaryID(ctx, tx)
		if err != nil {
			return i, err
		}

		if _, err := tx.ExecContext(ctx, `
			INSERT INTO summaries (summary_id, conversation_id, kind, content, token_count, created_at, file_ids, depth)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		`, newSummaryID, plan.targetConversationID, source.kind, source.content, source.tokenCount, source.createdAt, source.fileIDs, source.depth); err != nil {
			return i, fmt.Errorf("insert summary %s (from %s): %w", newSummaryID, source.summaryID, err)
		}

		if err := copyRemappedParentEdges(ctx, tx, source.summaryID, newSummaryID, oldToNew); err != nil {
			return i, err
		}

		oldToNew[source.summaryID] = newSummaryID
		fmt.Printf("[%d/%d] %s -> %s (%s, d%d)\n", i+1, len(plan.ordered), source.summaryID, newSummaryID, source.kind, source.depth)
	}

	sourceSummaryIDs := make([]string, 0, len(plan.ordered))
	for _, source := range plan.ordered {
		sourceSummaryIDs = append(sourceSummaryIDs, source.summaryID)
	}

	oldToNewMessage, copiedMessages, copiedParts, err := copyTransplantedMessages(ctx, tx, plan.targetConversationID, sourceSummaryIDs)
	if err != nil {
		return len(plan.ordered), err
	}
	fmt.Printf("Copied %d linked messages (%d message parts)\n", copiedMessages, copiedParts)

	for _, source := range plan.ordered {
		newSummaryID := oldToNew[source.summaryID]
		if err := copyRewiredSummaryMessages(ctx, tx, source.summaryID, newSummaryID, oldToNewMessage); err != nil {
			return len(plan.ordered), err
		}
	}

	if err := prependTransplantedContextItems(ctx, tx, plan.targetConversationID, plan.sourceContext, oldToNew); err != nil {
		return len(plan.ordered), err
	}

	if err := tx.Commit(); err != nil {
		return len(plan.ordered), fmt.Errorf("commit transplant transaction: %w", err)
	}
	rollbackNeeded = false
	return len(plan.ordered), nil
}

// copyTransplantedMessages deep-copies the deduplicated set of source messages
// referenced by source summaries and returns an old->new message ID map.
func copyTransplantedMessages(ctx context.Context, q sqlQueryer, targetConversationID int64, sourceSummaryIDs []string) (map[int64]int64, int, int, error) {
	sourceMessages, err := loadSourceMessagesForSummaries(ctx, q, sourceSummaryIDs)
	if err != nil {
		return nil, 0, 0, err
	}
	if len(sourceMessages) == 0 {
		return map[int64]int64{}, 0, 0, nil
	}

	targetSessionID, err := loadConversationSessionID(ctx, q, targetConversationID)
	if err != nil {
		return nil, 0, 0, err
	}

	nextSeq, err := nextConversationMessageSeq(ctx, q, targetConversationID)
	if err != nil {
		return nil, 0, 0, err
	}

	oldToNewMessage := make(map[int64]int64, len(sourceMessages))
	totalParts := 0
	for _, source := range sourceMessages {
		newMessageID, err := insertCopiedMessage(ctx, q, targetConversationID, nextSeq, source)
		if err != nil {
			return nil, 0, 0, err
		}
		nextSeq++
		oldToNewMessage[source.messageID] = newMessageID

		if _, err := q.ExecContext(ctx, `
			INSERT INTO messages_fts (rowid, content)
			VALUES (?, ?)
		`, newMessageID, source.content); err != nil {
			return nil, 0, 0, fmt.Errorf("insert messages_fts row for copied message %d: %w", newMessageID, err)
		}

		partsCopied, err := copyMessageParts(ctx, q, source.messageID, newMessageID, targetSessionID)
		if err != nil {
			return nil, 0, 0, err
		}
		totalParts += partsCopied
	}

	return oldToNewMessage, len(sourceMessages), totalParts, nil
}

// loadSourceMessagesForSummaries resolves unique source messages for a summary set.
func loadSourceMessagesForSummaries(ctx context.Context, q sqlQueryer, summaryIDs []string) ([]transplantMessage, error) {
	if len(summaryIDs) == 0 {
		return nil, nil
	}

	const batchSize = 200
	byID := make(map[int64]transplantMessage)

	for start := 0; start < len(summaryIDs); start += batchSize {
		end := start + batchSize
		if end > len(summaryIDs) {
			end = len(summaryIDs)
		}

		batch := summaryIDs[start:end]
		placeholders := strings.TrimRight(strings.Repeat("?,", len(batch)), ",")
		query := fmt.Sprintf(`
			SELECT DISTINCT
				m.message_id,
				m.conversation_id,
				m.seq,
				m.role,
				m.content,
				m.token_count,
				m.created_at
			FROM summary_messages sm
			JOIN messages m ON m.message_id = sm.message_id
			WHERE sm.summary_id IN (%s)
		`, placeholders)

		args := make([]any, 0, len(batch))
		for _, summaryID := range batch {
			args = append(args, summaryID)
		}

		rows, err := q.QueryContext(ctx, query, args...)
		if err != nil {
			return nil, fmt.Errorf("query source messages for transplant batch: %w", err)
		}

		for rows.Next() {
			var message transplantMessage
			if err := rows.Scan(
				&message.messageID,
				&message.conversationID,
				&message.seq,
				&message.role,
				&message.content,
				&message.tokenCount,
				&message.createdAt,
			); err != nil {
				rows.Close()
				return nil, fmt.Errorf("scan source message row for transplant: %w", err)
			}
			byID[message.messageID] = message
		}
		if err := rows.Err(); err != nil {
			rows.Close()
			return nil, fmt.Errorf("iterate source message rows for transplant: %w", err)
		}
		if err := rows.Close(); err != nil {
			return nil, fmt.Errorf("close source message rows for transplant: %w", err)
		}
	}

	messages := make([]transplantMessage, 0, len(byID))
	for _, message := range byID {
		messages = append(messages, message)
	}

	// Preserve deterministic insertion order in target conversation.
	sort.Slice(messages, func(i, j int) bool {
		left := messages[i]
		right := messages[j]
		if left.createdAt != right.createdAt {
			return left.createdAt < right.createdAt
		}
		if left.conversationID != right.conversationID {
			return left.conversationID < right.conversationID
		}
		if left.seq != right.seq {
			return left.seq < right.seq
		}
		return left.messageID < right.messageID
	})

	return messages, nil
}

func loadConversationSessionID(ctx context.Context, q sqlQueryer, conversationID int64) (string, error) {
	var sessionID string
	if err := q.QueryRowContext(ctx, `
		SELECT session_id
		FROM conversations
		WHERE conversation_id = ?
	`, conversationID).Scan(&sessionID); err != nil {
		return "", fmt.Errorf("query session ID for conversation %d: %w", conversationID, err)
	}
	if strings.TrimSpace(sessionID) == "" {
		return "", fmt.Errorf("conversation %d has empty session_id", conversationID)
	}
	return sessionID, nil
}

func nextConversationMessageSeq(ctx context.Context, q sqlQueryer, conversationID int64) (int64, error) {
	var maxSeq sql.NullInt64
	if err := q.QueryRowContext(ctx, `
		SELECT MAX(seq)
		FROM messages
		WHERE conversation_id = ?
	`, conversationID).Scan(&maxSeq); err != nil {
		return 0, fmt.Errorf("query max message seq for conversation %d: %w", conversationID, err)
	}
	if !maxSeq.Valid {
		return 0, nil
	}
	return maxSeq.Int64 + 1, nil
}

func insertCopiedMessage(ctx context.Context, q sqlQueryer, targetConversationID, seq int64, source transplantMessage) (int64, error) {
	result, err := q.ExecContext(ctx, `
		INSERT INTO messages (conversation_id, seq, role, content, token_count, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`, targetConversationID, seq, source.role, source.content, source.tokenCount, source.createdAt)
	if err != nil {
		return 0, fmt.Errorf("insert copied message from %d: %w", source.messageID, err)
	}

	newMessageID, err := result.LastInsertId()
	if err != nil {
		return 0, fmt.Errorf("read copied message ID for source message %d: %w", source.messageID, err)
	}
	return newMessageID, nil
}

// copyMessageParts duplicates all parts for one message and rewires message_id.
func copyMessageParts(ctx context.Context, q sqlQueryer, sourceMessageID, newMessageID int64, targetSessionID string) (int, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT
			part_type,
			ordinal,
			text_content,
			is_ignored,
			is_synthetic,
			tool_call_id,
			tool_name,
			tool_status,
			tool_input,
			tool_output,
			tool_error,
			tool_title,
			patch_hash,
			patch_files,
			file_mime,
			file_name,
			file_url,
			subtask_prompt,
			subtask_desc,
			subtask_agent,
			step_reason,
			step_cost,
			step_tokens_in,
			step_tokens_out,
			snapshot_hash,
			compaction_auto,
			metadata
		FROM message_parts
		WHERE message_id = ?
		ORDER BY ordinal ASC
	`, sourceMessageID)
	if err != nil {
		return 0, fmt.Errorf("query message_parts for message %d: %w", sourceMessageID, err)
	}
	defer rows.Close()

	parts := make([]transplantMessagePart, 0, 8)
	for rows.Next() {
		var part transplantMessagePart
		if err := rows.Scan(
			&part.partType,
			&part.ordinal,
			&part.textContent,
			&part.isIgnored,
			&part.isSynthetic,
			&part.toolCallID,
			&part.toolName,
			&part.toolStatus,
			&part.toolInput,
			&part.toolOutput,
			&part.toolError,
			&part.toolTitle,
			&part.patchHash,
			&part.patchFiles,
			&part.fileMime,
			&part.fileName,
			&part.fileURL,
			&part.subtaskPrompt,
			&part.subtaskDesc,
			&part.subtaskAgent,
			&part.stepReason,
			&part.stepCost,
			&part.stepTokensIn,
			&part.stepTokensOut,
			&part.snapshotHash,
			&part.compactionAuto,
			&part.metadata,
		); err != nil {
			return 0, fmt.Errorf("scan message_part row for message %d: %w", sourceMessageID, err)
		}
		parts = append(parts, part)
	}
	if err := rows.Err(); err != nil {
		return 0, fmt.Errorf("iterate message_parts for message %d: %w", sourceMessageID, err)
	}

	for _, part := range parts {
		partID, err := newMessagePartID()
		if err != nil {
			return 0, err
		}
		if _, err := q.ExecContext(ctx, `
			INSERT INTO message_parts (
				part_id,
				message_id,
				session_id,
				part_type,
				ordinal,
				text_content,
				is_ignored,
				is_synthetic,
				tool_call_id,
				tool_name,
				tool_status,
				tool_input,
				tool_output,
				tool_error,
				tool_title,
				patch_hash,
				patch_files,
				file_mime,
				file_name,
				file_url,
				subtask_prompt,
				subtask_desc,
				subtask_agent,
				step_reason,
				step_cost,
				step_tokens_in,
				step_tokens_out,
				snapshot_hash,
				compaction_auto,
				metadata
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`, partID, newMessageID, targetSessionID, part.partType, part.ordinal, part.textContent, part.isIgnored, part.isSynthetic, part.toolCallID, part.toolName, part.toolStatus, part.toolInput, part.toolOutput, part.toolError, part.toolTitle, part.patchHash, part.patchFiles, part.fileMime, part.fileName, part.fileURL, part.subtaskPrompt, part.subtaskDesc, part.subtaskAgent, part.stepReason, part.stepCost, part.stepTokensIn, part.stepTokensOut, part.snapshotHash, part.compactionAuto, part.metadata); err != nil {
			return 0, fmt.Errorf("insert copied message_part for source message %d: %w", sourceMessageID, err)
		}
	}

	return len(parts), nil
}

// copyRewiredSummaryMessages copies source summary_messages onto the new summary
// while remapping source message IDs to copied target message IDs.
func copyRewiredSummaryMessages(ctx context.Context, q sqlQueryer, oldSummaryID, newSummaryID string, oldToNewMessage map[int64]int64) error {
	rows, err := q.QueryContext(ctx, `
		SELECT message_id, ordinal
		FROM summary_messages
		WHERE summary_id = ?
		ORDER BY ordinal ASC
	`, oldSummaryID)
	if err != nil {
		return fmt.Errorf("query summary_messages for %s: %w", oldSummaryID, err)
	}
	defer rows.Close()

	for rows.Next() {
		var (
			oldMessageID int64
			ordinal      int64
		)
		if err := rows.Scan(&oldMessageID, &ordinal); err != nil {
			return fmt.Errorf("scan summary_message edge for %s: %w", oldSummaryID, err)
		}

		newMessageID, ok := oldToNewMessage[oldMessageID]
		if !ok {
			return fmt.Errorf("missing remapped message for %s -> %d", oldSummaryID, oldMessageID)
		}

		if _, err := q.ExecContext(ctx, `
			INSERT INTO summary_messages (summary_id, message_id, ordinal)
			VALUES (?, ?, ?)
		`, newSummaryID, newMessageID, ordinal); err != nil {
			return fmt.Errorf("insert remapped summary_message for %s: %w", oldSummaryID, err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate summary_messages for %s: %w", oldSummaryID, err)
	}
	return nil
}

func copyRemappedParentEdges(ctx context.Context, q sqlQueryer, oldSummaryID, newSummaryID string, oldToNew map[string]string) error {
	rows, err := q.QueryContext(ctx, `
		SELECT parent_summary_id, ordinal
		FROM summary_parents
		WHERE summary_id = ?
		ORDER BY ordinal ASC
	`, oldSummaryID)
	if err != nil {
		return fmt.Errorf("query parent edges for %s: %w", oldSummaryID, err)
	}
	defer rows.Close()

	for rows.Next() {
		var parentSummaryID string
		var ordinal int64
		if err := rows.Scan(&parentSummaryID, &ordinal); err != nil {
			return fmt.Errorf("scan parent edge for %s: %w", oldSummaryID, err)
		}

		remappedParentID, ok := oldToNew[parentSummaryID]
		if !ok {
			return fmt.Errorf("missing remapped parent for %s -> %s", oldSummaryID, parentSummaryID)
		}

		if _, err := q.ExecContext(ctx, `
			INSERT INTO summary_parents (summary_id, parent_summary_id, ordinal)
			VALUES (?, ?, ?)
		`, newSummaryID, remappedParentID, ordinal); err != nil {
			return fmt.Errorf("insert parent edge for %s: %w", oldSummaryID, err)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate parent edges for %s: %w", oldSummaryID, err)
	}
	return nil
}

// prependTransplantedContextItems inserts transplanted summaries at ordinals
// 0..N-1 while preserving the target's existing context order.
func prependTransplantedContextItems(ctx context.Context, q sqlQueryer, targetConversationID int64, sourceContext []transplantContextSummary, oldToNew map[string]string) error {
	prependCount := len(sourceContext)
	if prependCount == 0 {
		return nil
	}

	var maxOrdinal sql.NullInt64
	if err := q.QueryRowContext(ctx, `
		SELECT MAX(ordinal)
		FROM context_items
		WHERE conversation_id = ?
	`, targetConversationID).Scan(&maxOrdinal); err != nil {
		return fmt.Errorf("query max target context ordinal for conversation %d: %w", targetConversationID, err)
	}

	tempShift := int64(prependCount + 1)
	if maxOrdinal.Valid {
		tempShift += maxOrdinal.Int64
	}

	if _, err := q.ExecContext(ctx, `
		UPDATE context_items
		SET ordinal = ordinal + ?
		WHERE conversation_id = ?
	`, tempShift, targetConversationID); err != nil {
		return fmt.Errorf("temporarily shift context ordinals for conversation %d: %w", targetConversationID, err)
	}

	normalizeDelta := tempShift - int64(prependCount)
	if _, err := q.ExecContext(ctx, `
		UPDATE context_items
		SET ordinal = ordinal - ?
		WHERE conversation_id = ?
	`, normalizeDelta, targetConversationID); err != nil {
		return fmt.Errorf("normalize context ordinals for conversation %d: %w", targetConversationID, err)
	}

	for i, source := range sourceContext {
		newSummaryID, ok := oldToNew[source.summaryID]
		if !ok {
			return fmt.Errorf("missing remapped summary ID for context summary %s", source.summaryID)
		}

		if _, err := q.ExecContext(ctx, `
			INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id)
			VALUES (?, ?, 'summary', ?)
		`, targetConversationID, i, newSummaryID); err != nil {
			return fmt.Errorf("insert transplanted context item %d (%s): %w", i, source.summaryID, err)
		}
	}

	return nil
}

func generateSummaryID(ctx context.Context, q sqlQueryer) (string, error) {
	const maxAttempts = 32
	for attempt := 0; attempt < maxAttempts; attempt++ {
		candidate, err := newSummaryID()
		if err != nil {
			return "", err
		}

		var count int
		if err := q.QueryRowContext(ctx, `
			SELECT COUNT(*)
			FROM summaries
			WHERE summary_id = ?
		`, candidate).Scan(&count); err != nil {
			return "", fmt.Errorf("check generated summary ID %s: %w", candidate, err)
		}
		if count == 0 {
			return candidate, nil
		}
	}
	return "", errors.New("unable to generate unique summary ID after 32 attempts")
}

func newSummaryID() (string, error) {
	var raw [8]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate summary ID bytes: %w", err)
	}
	return "sum_" + hex.EncodeToString(raw[:]), nil
}

func newMessagePartID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", fmt.Errorf("generate message part ID bytes: %w", err)
	}

	// Set UUIDv4 + RFC4122 variant bits.
	raw[6] = (raw[6] & 0x0f) | 0x40
	raw[8] = (raw[8] & 0x3f) | 0x80

	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(raw[0:4]),
		hex.EncodeToString(raw[4:6]),
		hex.EncodeToString(raw[6:8]),
		hex.EncodeToString(raw[8:10]),
		hex.EncodeToString(raw[10:16]),
	), nil
}
