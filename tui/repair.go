package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	corruptedSummaryMarker = "[LCM fallback summary; truncated for context management]"
	anthropicModel         = "claude-sonnet-4-20250514"
	anthropicVersion       = "2023-06-01"
	condensedTargetTokens  = 2000
	defaultHTTPTimeout     = 180 * time.Second
)

type repairOptions struct {
	apply     bool
	dryRun    bool
	all       bool
	summaryID string
	verbose   bool
}

type repairSummary struct {
	summaryID         string
	conversationID    int64
	kind              string
	depth             int
	tokenCount        int
	content           string
	createdAt         string
	childCount        int
	contextOrdinal    int64
	hasContextOrdinal bool
}

type leafSequenceEntry struct {
	ordinal   int64
	summaryID string
	content   string
	corrupted bool
}

type repairPlan struct {
	summaries    []repairSummary
	ordered      []repairSummary
	leafSequence []leafSequenceEntry
}

type repairSource struct {
	text            string
	itemCount       int
	estimatedTokens int
	label           string
}

type sqlQueryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

type anthropicClient struct {
	apiKey string
	http   *http.Client
	model  string
}

type anthropicRequest struct {
	Model       string                    `json:"model"`
	MaxTokens   int                       `json:"max_tokens"`
	Temperature float64                   `json:"temperature,omitempty"`
	Messages    []anthropicRequestMessage `json:"messages"`
}

type anthropicRequestMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicResponse struct {
	Content []anthropicContentBlock `json:"content"`
}

type anthropicContentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type anthropicErrorEnvelope struct {
	Type  string `json:"type"`
	Error struct {
		Type    string `json:"type"`
		Message string `json:"message"`
	} `json:"error"`
}

// runRepairCommand executes the standalone repair CLI path.
func runRepairCommand(args []string) error {
	opts, conversationID, err := parseRepairArgs(args)
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
	conversationIDs, err := resolveRepairConversationIDs(ctx, db, opts, conversationID)
	if err != nil {
		return err
	}
	if len(conversationIDs) == 0 {
		fmt.Println("No corrupted summaries found.")
		return nil
	}

	var client *anthropicClient
	if opts.apply {
		apiKey, err := resolveAnthropicAPIKey(paths)
		if err != nil {
			return err
		}
		client = &anthropicClient{
			apiKey: apiKey,
			http:   &http.Client{Timeout: defaultHTTPTimeout},
		}
	}

	totalRepaired := 0
	for i, id := range conversationIDs {
		if i > 0 {
			fmt.Println()
		}
		repaired, err := runRepairConversation(ctx, db, id, opts, client)
		if err != nil {
			return err
		}
		totalRepaired += repaired
	}

	if opts.apply && opts.all {
		fmt.Printf("\nDone. %d summaries repaired across %d conversations.\n", totalRepaired, len(conversationIDs))
	}
	return nil
}

func parseRepairArgs(args []string) (repairOptions, int64, error) {
	fs := flag.NewFlagSet("repair", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	apply := fs.Bool("apply", false, "apply repairs to the DB")
	dryRun := fs.Bool("dry-run", true, "show what would be repaired")
	all := fs.Bool("all", false, "scan all conversations")
	summaryID := fs.String("summary-id", "", "repair a specific summary ID")
	verbose := fs.Bool("verbose", false, "include old content hash and preview")

	normalizedArgs, err := normalizeRepairArgs(args)
	if err != nil {
		return repairOptions{}, 0, fmt.Errorf("%w\n%s", err, repairUsageText())
	}
	if err := fs.Parse(normalizedArgs); err != nil {
		return repairOptions{}, 0, fmt.Errorf("%w\n%s", err, repairUsageText())
	}
	if *all && *summaryID != "" {
		return repairOptions{}, 0, fmt.Errorf("--all and --summary-id cannot be combined\n%s", repairUsageText())
	}

	opts := repairOptions{
		apply:     *apply,
		dryRun:    *dryRun,
		all:       *all,
		summaryID: strings.TrimSpace(*summaryID),
		verbose:   *verbose,
	}
	if opts.apply {
		opts.dryRun = false
	}
	if !opts.apply {
		opts.dryRun = true
	}

	if opts.all {
		if fs.NArg() != 0 {
			return repairOptions{}, 0, fmt.Errorf("conversation ID is not allowed with --all\n%s", repairUsageText())
		}
		return opts, 0, nil
	}
	if fs.NArg() != 1 {
		return repairOptions{}, 0, fmt.Errorf("conversation ID is required unless --all is used\n%s", repairUsageText())
	}

	conversationID, err := strconv.ParseInt(fs.Arg(0), 10, 64)
	if err != nil {
		return repairOptions{}, 0, fmt.Errorf("parse conversation ID %q: %w", fs.Arg(0), err)
	}
	return opts, conversationID, nil
}

func normalizeRepairArgs(args []string) ([]string, error) {
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, 1)

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--apply" || arg == "--dry-run" || arg == "--all" || arg == "--verbose":
			flags = append(flags, arg)
		case strings.HasPrefix(arg, "--summary-id="):
			flags = append(flags, arg)
		case arg == "--summary-id":
			if i+1 >= len(args) {
				return nil, errors.New("missing value for --summary-id")
			}
			flags = append(flags, arg, args[i+1])
			i++
		case strings.HasPrefix(arg, "--"):
			flags = append(flags, arg)
		default:
			positionals = append(positionals, arg)
		}
	}
	return append(flags, positionals...), nil
}

func repairUsageText() string {
	return strings.TrimSpace(`
Usage:
  lcm-tui repair <conversation_id> [--dry-run] [--summary-id <id>]
  lcm-tui repair <conversation_id> --apply [--summary-id <id>]
  lcm-tui repair --all [--dry-run|--apply]
`)
}

func resolveRepairConversationIDs(ctx context.Context, db *sql.DB, opts repairOptions, conversationID int64) ([]int64, error) {
	if !opts.all {
		return []int64{conversationID}, nil
	}

	rows, err := db.QueryContext(ctx, `
		SELECT DISTINCT conversation_id
		FROM summaries
		WHERE content LIKE ?
		ORDER BY conversation_id ASC
	`, "%"+corruptedSummaryMarker+"%")
	if err != nil {
		return nil, fmt.Errorf("query corrupted conversations: %w", err)
	}
	defer rows.Close()

	var ids []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan corrupted conversation ID: %w", err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate corrupted conversations: %w", err)
	}
	return ids, nil
}

func runRepairConversation(ctx context.Context, db *sql.DB, conversationID int64, opts repairOptions, client *anthropicClient) (int, error) {
	label := "Scanning"
	if opts.apply {
		label = "Repairing"
	}
	fmt.Printf("%s conversation %d...\n\n", label, conversationID)

	plan, err := buildRepairPlan(ctx, db, conversationID, opts.summaryID)
	if err != nil {
		return 0, err
	}
	if len(plan.summaries) == 0 {
		if opts.summaryID != "" {
			exists, err := summaryExists(ctx, db, conversationID, opts.summaryID)
			if err != nil {
				return 0, err
			}
			if exists {
				fmt.Printf("Summary %s is not corrupted.\n", opts.summaryID)
				return 0, nil
			}
			fmt.Printf("Summary %s not found in conversation %d.\n", opts.summaryID, conversationID)
			return 0, nil
		}
		fmt.Println("No corrupted summaries found.")
		return 0, nil
	}

	if opts.dryRun {
		printDryRunReport(plan.summaries, plan.ordered)
		return 0, nil
	}

	repaired, err := applyRepairs(ctx, db, plan, opts, client)
	if err != nil {
		return repaired, err
	}
	fmt.Printf("\nDone. %d summaries repaired. Changes take effect on next conversation turn.\n", repaired)
	return repaired, nil
}

// buildRepairPlan computes both the scan output and bottom-up repair order.
// Leaves are repaired in context_items ordinal order so each repaired leaf can
// feed previous_context into the next corrupted leaf.
func buildRepairPlan(ctx context.Context, q sqlQueryer, conversationID int64, summaryID string) (repairPlan, error) {
	summaries, err := loadCorruptedSummaries(ctx, q, conversationID, summaryID)
	if err != nil {
		return repairPlan{}, err
	}
	if len(summaries) == 0 {
		return repairPlan{}, nil
	}

	leafSeq, err := loadLeafSequence(ctx, q, conversationID)
	if err != nil {
		return repairPlan{}, err
	}

	byID := make(map[string]*repairSummary, len(summaries))
	for i := range summaries {
		byID[summaries[i].summaryID] = &summaries[i]
	}
	for _, leaf := range leafSeq {
		if item, ok := byID[leaf.summaryID]; ok {
			item.contextOrdinal = leaf.ordinal
			item.hasContextOrdinal = true
		}
	}

	ordered := make([]repairSummary, 0, len(summaries))
	seen := make(map[string]bool, len(summaries))

	for _, leaf := range leafSeq {
		item, ok := byID[leaf.summaryID]
		if !ok || seen[leaf.summaryID] {
			continue
		}
		if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
			ordered = append(ordered, *item)
			seen[leaf.summaryID] = true
		}
	}

	var orphanLeaves []repairSummary
	var condensed []repairSummary
	for _, item := range summaries {
		if seen[item.summaryID] {
			continue
		}
		if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
			orphanLeaves = append(orphanLeaves, item)
			continue
		}
		condensed = append(condensed, item)
	}

	sort.Slice(orphanLeaves, func(i, j int) bool {
		left := orphanLeaves[i]
		right := orphanLeaves[j]
		if left.createdAt != right.createdAt {
			return left.createdAt < right.createdAt
		}
		return left.summaryID < right.summaryID
	})
	sort.Slice(condensed, func(i, j int) bool {
		left := condensed[i]
		right := condensed[j]
		if left.depth != right.depth {
			return left.depth < right.depth
		}
		if left.createdAt != right.createdAt {
			return left.createdAt < right.createdAt
		}
		return left.summaryID < right.summaryID
	})

	ordered = append(ordered, orphanLeaves...)
	ordered = append(ordered, condensed...)

	sort.Slice(summaries, func(i, j int) bool {
		left := summaries[i]
		right := summaries[j]
		if left.depth != right.depth {
			return left.depth > right.depth
		}
		if left.createdAt != right.createdAt {
			return left.createdAt < right.createdAt
		}
		return left.summaryID < right.summaryID
	})

	return repairPlan{
		summaries:    summaries,
		ordered:      ordered,
		leafSequence: leafSeq,
	}, nil
}

func loadCorruptedSummaries(ctx context.Context, q sqlQueryer, conversationID int64, summaryID string) ([]repairSummary, error) {
	query := `
		SELECT
			s.summary_id,
			s.conversation_id,
			s.kind,
			s.depth,
			s.token_count,
			s.content,
			s.created_at,
			COALESCE(spc.child_count, 0)
		FROM summaries s
		LEFT JOIN (
			SELECT summary_id, COUNT(*) AS child_count
			FROM summary_parents
			GROUP BY summary_id
		) spc ON spc.summary_id = s.summary_id
		WHERE s.conversation_id = ?
		  AND s.content LIKE ?
	`
	args := []any{conversationID, "%" + corruptedSummaryMarker + "%"}
	if summaryID != "" {
		query += " AND s.summary_id = ?"
		args = append(args, summaryID)
	}
	query += " ORDER BY s.depth DESC, s.created_at ASC, s.summary_id ASC"

	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query corrupted summaries for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	var summaries []repairSummary
	for rows.Next() {
		var item repairSummary
		if err := rows.Scan(
			&item.summaryID,
			&item.conversationID,
			&item.kind,
			&item.depth,
			&item.tokenCount,
			&item.content,
			&item.createdAt,
			&item.childCount,
		); err != nil {
			return nil, fmt.Errorf("scan corrupted summary row: %w", err)
		}
		summaries = append(summaries, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate corrupted summaries: %w", err)
	}
	return summaries, nil
}

func loadLeafSequence(ctx context.Context, q sqlQueryer, conversationID int64) ([]leafSequenceEntry, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT
			ci.ordinal,
			ci.summary_id,
			s.content,
			CASE WHEN s.content LIKE ? THEN 1 ELSE 0 END AS corrupted
		FROM context_items ci
		JOIN summaries s ON ci.summary_id = s.summary_id
		WHERE ci.conversation_id = ?
		  AND ci.item_type = 'summary'
		  AND s.depth = 0
		ORDER BY ci.ordinal ASC
	`, "%"+corruptedSummaryMarker+"%", conversationID)
	if err != nil {
		return nil, fmt.Errorf("query ordered leaves for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	var items []leafSequenceEntry
	for rows.Next() {
		var (
			item         leafSequenceEntry
			corruptedInt int
		)
		if err := rows.Scan(&item.ordinal, &item.summaryID, &item.content, &corruptedInt); err != nil {
			return nil, fmt.Errorf("scan ordered leaf row: %w", err)
		}
		item.corrupted = corruptedInt == 1
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate ordered leaf rows: %w", err)
	}
	return items, nil
}

func summaryExists(ctx context.Context, q sqlQueryer, conversationID int64, summaryID string) (bool, error) {
	var count int
	if err := q.QueryRowContext(ctx, `
		SELECT COUNT(*)
		FROM summaries
		WHERE conversation_id = ? AND summary_id = ?
	`, conversationID, summaryID).Scan(&count); err != nil {
		return false, fmt.Errorf("check summary existence for %q: %w", summaryID, err)
	}
	return count > 0, nil
}

func printDryRunReport(summaries []repairSummary, ordered []repairSummary) {
	fmt.Printf("Found %d corrupted summaries:\n", len(summaries))
	for _, item := range summaries {
		line := fmt.Sprintf("  %s  %-9s d%d  %dt  %d chars", item.summaryID, item.kind, item.depth, item.tokenCount, len(item.content))
		if item.depth > 0 || strings.EqualFold(item.kind, "condensed") {
			line += fmt.Sprintf("  [%d children]", item.childCount)
		}
		fmt.Println(line)
	}
	fmt.Println()
	fmt.Println("Repair order (bottom-up):")

	depthCounts := make(map[int]int)
	var depths []int
	for _, item := range ordered {
		if _, seen := depthCounts[item.depth]; !seen {
			depths = append(depths, item.depth)
		}
		depthCounts[item.depth]++
	}
	sort.Ints(depths)
	for i, depth := range depths {
		label := "condensed"
		if depth == 0 {
			label = "leaves"
		}
		fmt.Printf("  %d. %d %s (d%d)\n", i+1, depthCounts[depth], label, depth)
	}
	fmt.Println()
	fmt.Println("Run with --apply to execute repairs.")
}

func applyRepairs(ctx context.Context, db *sql.DB, plan repairPlan, opts repairOptions, client *anthropicClient) (int, error) {
	if client == nil {
		return 0, errors.New("missing Anthropic client")
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin repair transaction: %w", err)
	}

	repaired := 0
	rollbackNeeded := true
	defer func() {
		if rollbackNeeded {
			_ = tx.Rollback()
		}
	}()

	for i, item := range plan.ordered {
		fmt.Printf("[%d/%d] %s (%s, d%d)\n", i+1, len(plan.ordered), item.summaryID, item.kind, item.depth)

		source, err := buildSummaryRepairSource(ctx, tx, item)
		if err != nil {
			return repaired, err
		}
		fmt.Printf("  Sources: %d %s (%d tokens)\n", source.itemCount, source.label, source.estimatedTokens)

		oldDescriptor := "existing content"
		if strings.Contains(item.content, corruptedSummaryMarker) {
			oldDescriptor = "truncated garbage"
		}
		fmt.Printf("  Old: %d chars / %d tokens (%s)\n", len(item.content), item.tokenCount, oldDescriptor)
		if opts.verbose {
			fmt.Printf("  Old hash: %s | Preview: %q\n", shortSHA256(item.content), previewForLog(item.content, 100))
		}

		previousContext, err := resolvePreviousContext(ctx, tx, item)
		if err != nil {
			return repaired, err
		}
		prompt, targetTokens := buildRepairPrompt(item.kind, source.text, previousContext, source.estimatedTokens)
		newContent, err := client.summarize(ctx, prompt, targetTokens)
		if err != nil {
			return repaired, fmt.Errorf("summarize %s: %w", item.summaryID, err)
		}

		newTokens := estimateTokenCount(newContent)
		if newTokens == 0 && strings.TrimSpace(newContent) != "" {
			newTokens = 1
		}

		if _, err := tx.ExecContext(ctx, `
			UPDATE summaries
			SET content = ?, token_count = ?
			WHERE summary_id = ?
		`, newContent, newTokens, item.summaryID); err != nil {
			return repaired, fmt.Errorf("update summary %s: %w", item.summaryID, err)
		}
		fmt.Printf("  New: %d chars / %d tokens ✓\n\n", len(newContent), newTokens)
		repaired++
	}

	if err := tx.Commit(); err != nil {
		return repaired, fmt.Errorf("commit repair transaction: %w", err)
	}
	rollbackNeeded = false
	return repaired, nil
}

func buildSummaryRepairSource(ctx context.Context, q sqlQueryer, item repairSummary) (repairSource, error) {
	if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
		return buildLeafRepairSource(ctx, q, item.summaryID)
	}
	return buildCondensedRepairSource(ctx, q, item.summaryID)
}

// buildLeafRepairSource reconstructs a summary's source segment from linked messages and parts.
func buildLeafRepairSource(ctx context.Context, q sqlQueryer, summaryID string) (repairSource, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT
			sm.ordinal,
			m.message_id,
			m.role,
			m.content,
			mp.ordinal,
			mp.part_type,
			mp.text_content
		FROM summary_messages sm
		JOIN messages m ON m.message_id = sm.message_id
		LEFT JOIN message_parts mp
			ON mp.message_id = m.message_id
			AND COALESCE(mp.is_ignored, 0) = 0
		WHERE sm.summary_id = ?
		ORDER BY sm.ordinal ASC, mp.ordinal ASC
	`, summaryID)
	if err != nil {
		return repairSource{}, fmt.Errorf("query summary messages for %s: %w", summaryID, err)
	}
	defer rows.Close()

	type messageChunk struct {
		role     string
		fallback string
		parts    []string
	}

	var (
		lines            []string
		currentMessageID int64
		active           bool
		current          messageChunk
	)

	flushCurrent := func() {
		if !active {
			return
		}
		role := strings.TrimSpace(current.role)
		if role == "" {
			role = "unknown"
		}
		body := strings.TrimSpace(strings.Join(current.parts, "\n"))
		if body == "" {
			body = strings.TrimSpace(current.fallback)
		}
		if body == "" {
			body = "(empty)"
		}
		lines = append(lines, fmt.Sprintf("[%s] %s", role, body))
	}

	for rows.Next() {
		var (
			summaryOrdinal int64
			messageID      int64
			role           string
			content        string
			partOrdinal    sql.NullInt64
			partType       sql.NullString
			partTextValue  sql.NullString
		)
		if err := rows.Scan(&summaryOrdinal, &messageID, &role, &content, &partOrdinal, &partType, &partTextValue); err != nil {
			return repairSource{}, fmt.Errorf("scan summary message row: %w", err)
		}

		if !active || currentMessageID != messageID {
			flushCurrent()
			currentMessageID = messageID
			current = messageChunk{role: role, fallback: content}
			active = true
		}

		partText := strings.TrimSpace(partTextValue.String)
		if partText != "" {
			current.parts = append(current.parts, partText)
			continue
		}

		kind := strings.TrimSpace(partType.String)
		if kind == "toolCall" || kind == "toolResult" || kind == "tool_call" || kind == "tool_result" {
			current.parts = append(current.parts, "["+kind+"]")
		}
	}
	if err := rows.Err(); err != nil {
		return repairSource{}, fmt.Errorf("iterate summary message rows: %w", err)
	}
	flushCurrent()

	if len(lines) == 0 {
		return repairSource{}, fmt.Errorf("no source messages linked to summary %s", summaryID)
	}

	text := strings.Join(lines, "\n")
	return repairSource{
		text:            text,
		itemCount:       len(lines),
		estimatedTokens: estimateTokenCount(text),
		label:           "messages",
	}, nil
}

func buildCondensedRepairSource(ctx context.Context, q sqlQueryer, summaryID string) (repairSource, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT sp.parent_summary_id, s.content
		FROM summary_parents sp
		JOIN summaries s ON s.summary_id = sp.parent_summary_id
		WHERE sp.summary_id = ?
		ORDER BY sp.ordinal ASC
	`, summaryID)
	if err != nil {
		return repairSource{}, fmt.Errorf("query child summaries for %s: %w", summaryID, err)
	}
	defer rows.Close()

	var parts []string
	for rows.Next() {
		var childID string
		var content string
		if err := rows.Scan(&childID, &content); err != nil {
			return repairSource{}, fmt.Errorf("scan child summary row: %w", err)
		}
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		parts = append(parts, content)
	}
	if err := rows.Err(); err != nil {
		return repairSource{}, fmt.Errorf("iterate child summary rows: %w", err)
	}
	if len(parts) == 0 {
		return repairSource{}, fmt.Errorf("no child summaries linked to %s", summaryID)
	}

	text := strings.Join(parts, "\n\n")
	return repairSource{
		text:            text,
		itemCount:       len(parts),
		estimatedTokens: estimateTokenCount(text),
		label:           "child summaries",
	}, nil
}

func resolvePreviousContext(ctx context.Context, q sqlQueryer, item repairSummary) (string, error) {
	content, err := previousContextLookup(ctx, q, item.summaryID, item.conversationID, item.depth, item.kind, item.createdAt)
	if err != nil {
		return "", err
	}
	if content == "" {
		return "(none)", nil
	}
	return content, nil
}

func buildRepairPrompt(kind, text, previousContext string, inputTokens int) (string, int) {
	if strings.EqualFold(kind, "leaf") {
		targetTokens := calculateLeafTargetTokens(inputTokens)
		return buildLeafSummaryPrompt(text, previousContext, targetTokens), targetTokens
	}
	return buildCondensedSummaryPrompt(text, previousContext, condensedTargetTokens), condensedTargetTokens
}

func calculateLeafTargetTokens(inputTokens int) int {
	target := int(math.Floor(float64(inputTokens) * 0.35))
	if target < 192 {
		return 192
	}
	if target > 1200 {
		return 1200
	}
	return target
}

func buildLeafSummaryPrompt(text, previousContext string, targetTokens int) string {
	prev := strings.TrimSpace(previousContext)
	if prev == "" {
		prev = "(none)"
	}
	return fmt.Sprintf(`You summarize a SEGMENT of an OpenClaw conversation for future model turns.
Treat this as incremental memory compaction input, not a full-conversation summary.

Normal summary policy:
- Preserve key decisions, rationale, constraints, and active tasks.
- Keep essential technical details needed to continue work safely.
- Remove obvious repetition and conversational filler.

Operator instructions: (none)

Output requirements:
- Plain text only.
- No preamble, headings, or markdown formatting.
- Keep it concise while preserving required details.
- Track file operations (created, modified, deleted, renamed) with file paths and current status.
- If no file operations appear, include exactly: "Files: none".
- Target length: about %d tokens or less.

<previous_context>
%s
</previous_context>

<conversation_segment>
%s
</conversation_segment>
`, targetTokens, prev, text)
}

func buildCondensedSummaryPrompt(text, previousContext string, targetTokens int) string {
	prev := strings.TrimSpace(previousContext)
	if prev == "" {
		prev = "(none)"
	}
	return fmt.Sprintf(`You produce a Pi-inspired condensed OpenClaw memory summary for long-context handoff.
Capture only durable facts that matter for future execution and safe continuation.

Operator instructions: (none)

Output requirements:
- Use plain text.
- Use these exact section headings in this exact order:
Goals & Context
Key Decisions
Progress
Constraints
Critical Details
Files
- Under Files, list file operations (created, modified, deleted, renamed) with path and current status.
- If no file operations are present, set Files to: none.
- Target length: about %d tokens.

<previous_context>
%s
</previous_context>

<conversation_to_condense>
%s
</conversation_to_condense>
`, targetTokens, prev, text)
}

func (c *anthropicClient) summarize(ctx context.Context, prompt string, targetTokens int) (string, error) {
	if strings.TrimSpace(c.apiKey) == "" {
		return "", errors.New("missing Anthropic API key")
	}
	if targetTokens <= 0 {
		targetTokens = condensedTargetTokens
	}
	model := strings.TrimSpace(c.model)
	if model == "" {
		model = anthropicModel
	}

	reqBody := anthropicRequest{
		Model:       model,
		MaxTokens:   targetTokens,
		Temperature: 0,
		Messages: []anthropicRequestMessage{
			{Role: "user", Content: prompt},
		},
	}
	payload, err := json.Marshal(reqBody)
	if err != nil {
		return "", fmt.Errorf("marshal Anthropic request: %w", err)
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "https://api.anthropic.com/v1/messages", bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("build Anthropic request: %w", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-api-key", c.apiKey)
	req.Header.Set("anthropic-version", anthropicVersion)

	resp, err := c.http.Do(req)
	if err != nil {
		return "", fmt.Errorf("call Anthropic API: %w", err)
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", fmt.Errorf("read Anthropic response: %w", err)
	}

	if resp.StatusCode >= 300 {
		var apiErr anthropicErrorEnvelope
		if json.Unmarshal(body, &apiErr) == nil && strings.TrimSpace(apiErr.Error.Message) != "" {
			return "", fmt.Errorf("Anthropic API %d %s: %s", resp.StatusCode, apiErr.Error.Type, apiErr.Error.Message)
		}
		return "", fmt.Errorf("Anthropic API %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	var parsed anthropicResponse
	if err := json.Unmarshal(body, &parsed); err != nil {
		return "", fmt.Errorf("decode Anthropic response: %w", err)
	}
	var chunks []string
	for _, block := range parsed.Content {
		if block.Type == "text" {
			chunks = append(chunks, block.Text)
		}
	}
	result := strings.TrimSpace(strings.Join(chunks, "\n"))
	if result == "" {
		return "", errors.New("Anthropic response did not include text content")
	}
	return result, nil
}

func resolveAnthropicAPIKey(paths appDataPaths) (string, error) {
	if env := strings.TrimSpace(os.Getenv("ANTHROPIC_API_KEY")); env != "" {
		return env, nil
	}

	mode, err := readAnthropicProfileMode(paths.openclawConfig)
	if err != nil {
		return "", err
	}
	if mode != "api_key" {
		return "", fmt.Errorf("anthropic profile mode is %q; set ANTHROPIC_API_KEY for repair command", mode)
	}

	if key, err := readKeyFromEnvFile(paths.openclawEnv); err == nil && key != "" {
		return key, nil
	}

	home, _ := os.UserHomeDir()
	if key, err := readKeyFromEnvFile(filepath.Join(home, ".zshrc")); err == nil && key != "" {
		return key, nil
	}

	candidates := []string{
		filepath.Join(paths.openclawDir, "auth-tokens.json"),
		filepath.Join(paths.openclawCredsDir, "auth-tokens.json"),
		filepath.Join(paths.openclawCredsDir, "anthropic.json"),
		filepath.Join(paths.openclawCredsDir, "providers", "anthropic.json"),
	}
	for _, path := range candidates {
		if key, err := readLikelyAnthropicKey(path); err == nil && key != "" {
			return key, nil
		}
	}

	return "", errors.New("unable to resolve Anthropic API key; set ANTHROPIC_API_KEY")
}

func readAnthropicProfileMode(configPath string) (string, error) {
	raw, err := os.ReadFile(configPath)
	if err != nil {
		return "", fmt.Errorf("read OpenClaw config %q: %w", configPath, err)
	}

	var parsed struct {
		Auth struct {
			Profiles map[string]struct {
				Provider string `json:"provider"`
				Mode     string `json:"mode"`
			} `json:"profiles"`
		} `json:"auth"`
	}
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return "", fmt.Errorf("parse OpenClaw config %q: %w", configPath, err)
	}

	for _, name := range []string{"anthropic:default", "anthropic:manual"} {
		if profile, ok := parsed.Auth.Profiles[name]; ok && profile.Provider == "anthropic" {
			return strings.TrimSpace(profile.Mode), nil
		}
	}
	return "", errors.New("OpenClaw config does not define anthropic:default or anthropic:manual profile")
}

func readKeyFromEnvFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		if !strings.HasPrefix(line, "ANTHROPIC_API_KEY=") {
			continue
		}
		val := strings.TrimPrefix(line, "ANTHROPIC_API_KEY=")
		val = strings.Trim(strings.TrimSpace(val), `"'`)
		if strings.HasPrefix(val, "sk-ant-") {
			return val, nil
		}
	}
	if err := scanner.Err(); err != nil {
		return "", err
	}
	return "", nil
}

func readLikelyAnthropicKey(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}

	var asAny any
	if json.Unmarshal(data, &asAny) == nil {
		if key := walkForAnthropicKey(asAny); key != "" {
			return key, nil
		}
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "ANTHROPIC_API_KEY=") {
			val := strings.Trim(strings.TrimSpace(strings.TrimPrefix(line, "ANTHROPIC_API_KEY=")), `"'`)
			if strings.HasPrefix(val, "sk-ant-") {
				return val, nil
			}
		}
	}
	return "", nil
}

func walkForAnthropicKey(node any) string {
	switch v := node.(type) {
	case map[string]any:
		for key, child := range v {
			lower := strings.ToLower(key)
			if lower == "api_key" || lower == "anthropic_api_key" || lower == "key" || lower == "token" {
				if s, ok := child.(string); ok && strings.HasPrefix(strings.TrimSpace(s), "sk-ant-") {
					return strings.TrimSpace(s)
				}
			}
			if nested := walkForAnthropicKey(child); nested != "" {
				return nested
			}
		}
	case []any:
		for _, child := range v {
			if nested := walkForAnthropicKey(child); nested != "" {
				return nested
			}
		}
	case string:
		trimmed := strings.TrimSpace(v)
		if strings.HasPrefix(trimmed, "sk-ant-") {
			return trimmed
		}
	}
	return ""
}

func shortSHA256(s string) string {
	sum := sha256.Sum256([]byte(s))
	return fmt.Sprintf("%x", sum[:6])
}

func previewForLog(s string, limit int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\n", " "))
	if len(s) <= limit {
		return s
	}
	return s[:limit] + "..."
}

func estimateTokenCount(s string) int {
	if len(s) == 0 {
		return 0
	}
	return len(s) / 4
}
