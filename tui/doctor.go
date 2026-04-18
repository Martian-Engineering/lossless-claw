package main

import (
	"context"
	"database/sql"
	"flag"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

const (
	doctorOldMarker          = corruptedSummaryMarker
	doctorNewMarkerPrefix    = "[Truncated from "
	doctorLCMFallbackMarker  = "[LCM fallback summary; truncated for context management]"
	doctorNewMarkerWindow    = 40
	doctorFallbackWindow     = 80
	doctorDefaultProvider    = "anthropic"
	doctorDefaultModel       = "claude-haiku-4-5"
	doctorDefaultApplyPrompt = ""
)

type doctorOptions struct {
	apply      bool
	summary    bool
	all        bool
	provider   string
	model      string
	baseURL    string
	showDiff   bool
	timestamps bool
}

type doctorTarget struct {
	rewriteSummary
	markerKind        string
	contextOrdinal    int64
	hasContextOrdinal bool
}

type doctorPlan struct {
	targets []doctorTarget
	ordered []doctorTarget
}

type doctorConversationScan struct {
	conversationID int64
	totalCount     int
	oldCount       int
	newCount       int
}

type doctorScanReport struct {
	conversations []doctorConversationScan
	totalCount    int
	oldCount      int
	newCount      int
}

type doctorSummarizer interface {
	summarize(ctx context.Context, prompt string, targetTokens int) (string, error)
}

// oauthCLISummarizer delegates to the claude CLI for OAuth/setup-token auth.
type oauthCLISummarizer struct {
	model string
}

func (o *oauthCLISummarizer) summarize(ctx context.Context, prompt string, targetTokens int) (string, error) {
	return summarizeViaCLI(ctx, o.model, prompt, targetTokens)
}

// runDoctorCommand scans for genuinely truncated summaries and optionally rewrites them.
func runDoctorCommand(args []string) error {
	opts, conversationID, hasConversationID, err := parseDoctorArgs(args)
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
	if opts.summary {
		var conversationFilter *int64
		if hasConversationID {
			conversationFilter = &conversationID
		}
		report, err := scanDoctorConversations(ctx, db, conversationFilter)
		if err != nil {
			return err
		}
		printDoctorScanReport(report, hasConversationID)
		return nil
	}

	plan, err := buildDoctorPlan(ctx, db, conversationID)
	if err != nil {
		return err
	}
	if len(plan.targets) == 0 {
		fmt.Printf("No broken summaries found in conversation %d.\n", conversationID)
		return nil
	}

	settings := resolveTUISummaryRuntimeSettings(paths, opts.provider, opts.model, opts.baseURL, doctorDefaultProvider, doctorDefaultModel)
	opts.provider = settings.provider
	opts.model = settings.model
	opts.baseURL = settings.baseURL

	fmt.Printf("Doctor found %d broken summaries in conversation %d.\n", len(plan.targets), conversationID)
	printDoctorPlan(plan)
	fmt.Println()
	if opts.apply {
		fmt.Println("Mode: apply")
	} else {
		fmt.Println("Mode: dry-run (transaction rolled back after preview)")
	}

	// Check if Anthropic is configured with OAuth/token mode — delegate to claude CLI.
	var summarizer doctorSummarizer
	if opts.provider == "anthropic" {
		mode, _ := readProviderProfileMode(paths.openclawConfig, "anthropic")
		if mode == "token" || mode == "oauth" {
			summarizer = &oauthCLISummarizer{model: opts.model}
		}
	}
	if summarizer == nil {
		apiKey, err := resolveProviderAPIKey(paths, opts.provider)
		if err != nil {
			return err
		}
		summarizer = &anthropicClient{
			provider: opts.provider,
			apiKey:   apiKey,
			http:     &http.Client{Timeout: defaultHTTPTimeout},
			model:    opts.model,
			baseURL:  opts.baseURL,
		}
	}

	rewritten, err := executeDoctorPlan(ctx, db, plan, opts, summarizer)
	if err != nil {
		return err
	}
	if opts.apply {
		fmt.Printf("\nDone. Repaired %d summaries.\n", rewritten)
	} else {
		fmt.Printf("\nDone. Previewed %d repairs (dry-run).\n", rewritten)
	}
	return nil
}

func parseDoctorArgs(args []string) (doctorOptions, int64, bool, error) {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	apply := fs.Bool("apply", false, "write repaired summaries to the DB")
	summary := fs.Bool("summary", false, "scan only and show counts")
	all := fs.Bool("all", false, "scan all conversations")
	provider := fs.String("provider", "", "provider id (e.g. anthropic, openai)")
	model := fs.String("model", "", "summary model id")
	baseURL := fs.String("base-url", "", "custom API base URL")
	showDiff := fs.Bool("show-diff", false, "show unified diff for each fix")
	timestamps := fs.Bool("timestamps", false, "inject timestamps into the rewrite source")

	normalizedArgs, err := normalizeDoctorArgs(args)
	if err != nil {
		return doctorOptions{}, 0, false, fmt.Errorf("%w\n%s", err, doctorUsageText())
	}
	if err := fs.Parse(normalizedArgs); err != nil {
		return doctorOptions{}, 0, false, fmt.Errorf("%w\n%s", err, doctorUsageText())
	}

	opts := doctorOptions{
		apply:      *apply,
		summary:    *summary || *all,
		all:        *all,
		baseURL:    strings.TrimSpace(*baseURL),
		showDiff:   *showDiff,
		timestamps: *timestamps,
	}
	opts.provider = strings.TrimSpace(*provider)
	opts.model = strings.TrimSpace(*model)

	if opts.apply && opts.summary {
		return doctorOptions{}, 0, false, fmt.Errorf("--apply cannot be combined with scan-only flags\n%s", doctorUsageText())
	}

	hasConversationID := fs.NArg() == 1
	if fs.NArg() > 1 {
		return doctorOptions{}, 0, false, fmt.Errorf("accepts at most one conversation ID\n%s", doctorUsageText())
	}
	if opts.all && hasConversationID {
		return doctorOptions{}, 0, false, fmt.Errorf("conversation ID is not allowed with --all\n%s", doctorUsageText())
	}
	if !hasConversationID && !opts.summary {
		return doctorOptions{}, 0, false, fmt.Errorf("conversation ID is required unless scanning\n%s", doctorUsageText())
	}

	var conversationID int64
	if hasConversationID {
		conversationID, err = strconv.ParseInt(fs.Arg(0), 10, 64)
		if err != nil {
			return doctorOptions{}, 0, false, fmt.Errorf("parse conversation ID %q: %w", fs.Arg(0), err)
		}
	}
	return opts, conversationID, hasConversationID, nil
}

func normalizeDoctorArgs(args []string) ([]string, error) {
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, 1)

	for i := 0; i < len(args); i++ {
		arg := args[i]
		takesValue := arg == "--provider" || arg == "--model" || arg == "--base-url"
		if takesValue {
			if i+1 >= len(args) {
				return nil, fmt.Errorf("missing value for %s", arg)
			}
			flags = append(flags, arg, args[i+1])
			i++
			continue
		}
		if strings.HasPrefix(arg, "--provider=") || strings.HasPrefix(arg, "--model=") || strings.HasPrefix(arg, "--base-url=") {
			flags = append(flags, arg)
			continue
		}
		if arg == "--apply" || arg == "--summary" || arg == "--all" || arg == "--show-diff" || arg == "--timestamps" {
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

func doctorUsageText() string {
	return strings.TrimSpace(`Usage:
  lcm-tui doctor <conversation_id> [--show-diff] [--timestamps] [--apply] [--provider <id>] [--model <model>] [--base-url <url>]
  lcm-tui doctor <conversation_id> --summary
  lcm-tui doctor --summary
  lcm-tui doctor --all

Flags:
  --apply             write repaired summaries to the DB
  --summary           scan only and show counts
  --all               scan all conversations (discovery mode only)
  --provider <id>     API provider (default: anthropic)
  --model <model>     API model (default: claude-haiku-4-5)
  --base-url <url>    custom API base URL (overrides config and env)
  --show-diff         show unified diff for each fix
  --timestamps        inject timestamps into rewrite source text

Env:
  LCM_TUI_SUMMARY_PROVIDER / LCM_TUI_SUMMARY_MODEL / LCM_TUI_SUMMARY_BASE_URL
  fall back to LCM_SUMMARY_PROVIDER / LCM_SUMMARY_MODEL / LCM_SUMMARY_BASE_URL
`)
}

// buildDoctorPlan keeps the repair order bottom-up so parent rewrites can consume repaired children.
func buildDoctorPlan(ctx context.Context, q sqlQueryer, conversationID int64) (doctorPlan, error) {
	targets, err := loadDoctorTargets(ctx, q, &conversationID)
	if err != nil {
		return doctorPlan{}, err
	}
	if len(targets) == 0 {
		return doctorPlan{}, nil
	}

	leafOrdinals, err := loadDoctorLeafOrdinals(ctx, q, conversationID)
	if err != nil {
		return doctorPlan{}, err
	}

	byID := make(map[string]*doctorTarget, len(targets))
	for i := range targets {
		byID[targets[i].summaryID] = &targets[i]
	}
	for summaryID, ordinal := range leafOrdinals {
		if item, ok := byID[summaryID]; ok {
			item.contextOrdinal = ordinal
			item.hasContextOrdinal = true
		}
	}

	activeLeaves := make([]doctorTarget, 0, len(targets))
	orphanLeaves := make([]doctorTarget, 0, len(targets))
	condensed := make([]doctorTarget, 0, len(targets))
	for _, item := range targets {
		if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
			if item.hasContextOrdinal {
				activeLeaves = append(activeLeaves, item)
			} else {
				orphanLeaves = append(orphanLeaves, item)
			}
			continue
		}
		condensed = append(condensed, item)
	}

	sort.Slice(activeLeaves, func(i, j int) bool {
		return activeLeaves[i].contextOrdinal < activeLeaves[j].contextOrdinal
	})
	sort.Slice(orphanLeaves, func(i, j int) bool {
		if orphanLeaves[i].createdAt != orphanLeaves[j].createdAt {
			return orphanLeaves[i].createdAt < orphanLeaves[j].createdAt
		}
		return orphanLeaves[i].summaryID < orphanLeaves[j].summaryID
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

	ordered := make([]doctorTarget, 0, len(targets))
	ordered = append(ordered, activeLeaves...)
	ordered = append(ordered, orphanLeaves...)
	ordered = append(ordered, condensed...)

	return doctorPlan{
		targets: targets,
		ordered: ordered,
	}, nil
}

func scanDoctorConversations(ctx context.Context, q sqlQueryer, conversationID *int64) (doctorScanReport, error) {
	targets, err := loadDoctorTargets(ctx, q, conversationID)
	if err != nil {
		return doctorScanReport{}, err
	}

	report := doctorScanReport{
		conversations: make([]doctorConversationScan, 0, 8),
	}
	byConversation := make(map[int64]*doctorConversationScan, 8)
	for _, item := range targets {
		scan := byConversation[item.conversationID]
		if scan == nil {
			report.conversations = append(report.conversations, doctorConversationScan{conversationID: item.conversationID})
			scan = &report.conversations[len(report.conversations)-1]
			byConversation[item.conversationID] = scan
		}
		scan.totalCount++
		report.totalCount++
		switch item.markerKind {
		case "old":
			scan.oldCount++
			report.oldCount++
		case "new":
			scan.newCount++
			report.newCount++
		}
	}

	sort.Slice(report.conversations, func(i, j int) bool {
		return report.conversations[i].conversationID < report.conversations[j].conversationID
	})
	return report, nil
}

func loadDoctorTargets(ctx context.Context, q sqlQueryer, conversationID *int64) ([]doctorTarget, error) {
	query := `
		SELECT
			s.summary_id,
			s.conversation_id,
			s.kind,
			COALESCE(s.depth, 0),
			COALESCE(s.token_count, 0),
			COALESCE(s.content, ''),
			COALESCE(s.created_at, ''),
			COALESCE(spc.child_count, 0),
			CASE
				WHEN INSTR(COALESCE(s.content, ''), ?) = 1 THEN 'old'
				WHEN INSTR(COALESCE(s.content, ''), ?) > 0
					AND LENGTH(COALESCE(s.content, '')) - INSTR(COALESCE(s.content, ''), ?) < ` + strconv.Itoa(doctorNewMarkerWindow) + ` THEN 'new'
				WHEN INSTR(COALESCE(s.content, ''), ?) > 0
					AND LENGTH(COALESCE(s.content, '')) - INSTR(COALESCE(s.content, ''), ?) < ` + strconv.Itoa(doctorFallbackWindow) + ` THEN 'fallback'
				ELSE ''
			END AS marker_kind
		FROM summaries s
		LEFT JOIN (
			SELECT summary_id, COUNT(*) AS child_count
			FROM summary_parents
			GROUP BY summary_id
		) spc ON spc.summary_id = s.summary_id
		WHERE
	`
	args := []any{doctorOldMarker, doctorNewMarkerPrefix, doctorNewMarkerPrefix, doctorLCMFallbackMarker, doctorLCMFallbackMarker}
	if conversationID != nil {
		query += " s.conversation_id = ? AND "
		args = append(args, *conversationID)
	}
	query += `
		(
			INSTR(COALESCE(s.content, ''), ?) = 1
			OR (
				INSTR(COALESCE(s.content, ''), ?) > 0
				AND LENGTH(COALESCE(s.content, '')) - INSTR(COALESCE(s.content, ''), ?) < ` + strconv.Itoa(doctorNewMarkerWindow) + `
			)
			OR (
				INSTR(COALESCE(s.content, ''), ?) > 0
				AND LENGTH(COALESCE(s.content, '')) - INSTR(COALESCE(s.content, ''), ?) < ` + strconv.Itoa(doctorFallbackWindow) + `
			)
		)
		ORDER BY s.conversation_id ASC, COALESCE(s.depth, 0) ASC, s.created_at ASC, s.summary_id ASC
	`
	args = append(args, doctorOldMarker, doctorNewMarkerPrefix, doctorNewMarkerPrefix, doctorLCMFallbackMarker, doctorLCMFallbackMarker)

	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		if conversationID != nil {
			return nil, fmt.Errorf("query doctor targets for conversation %d: %w", *conversationID, err)
		}
		return nil, fmt.Errorf("query doctor targets: %w", err)
	}
	defer rows.Close()

	targets := make([]doctorTarget, 0, 32)
	for rows.Next() {
		var item doctorTarget
		if err := rows.Scan(
			&item.summaryID,
			&item.conversationID,
			&item.kind,
			&item.depth,
			&item.tokenCount,
			&item.content,
			&item.createdAt,
			&item.childCount,
			&item.markerKind,
		); err != nil {
			return nil, fmt.Errorf("scan doctor target row: %w", err)
		}
		if detected := detectDoctorMarker(item.content); detected != item.markerKind {
			item.markerKind = detected
		}
		if item.markerKind == "" {
			continue
		}
		targets = append(targets, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate doctor target rows: %w", err)
	}
	return targets, nil
}

func loadDoctorLeafOrdinals(ctx context.Context, q sqlQueryer, conversationID int64) (map[string]int64, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT ci.summary_id, ci.ordinal
		FROM context_items ci
		JOIN summaries s ON s.summary_id = ci.summary_id
		WHERE ci.conversation_id = ?
		  AND ci.item_type = 'summary'
		  AND COALESCE(s.depth, 0) = 0
		  AND (
				INSTR(COALESCE(s.content, ''), ?) = 1
				OR (
					INSTR(COALESCE(s.content, ''), ?) > 0
					AND LENGTH(COALESCE(s.content, '')) - INSTR(COALESCE(s.content, ''), ?) < ?
				)
				OR (
					INSTR(COALESCE(s.content, ''), ?) > 0
					AND LENGTH(COALESCE(s.content, '')) - INSTR(COALESCE(s.content, ''), ?) < ?
				)
		  )
		ORDER BY ci.ordinal ASC
	`, conversationID, doctorOldMarker, doctorNewMarkerPrefix, doctorNewMarkerPrefix, doctorNewMarkerWindow, doctorLCMFallbackMarker, doctorLCMFallbackMarker, doctorFallbackWindow)
	if err != nil {
		return nil, fmt.Errorf("query doctor leaf ordinals for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	ordinals := make(map[string]int64)
	for rows.Next() {
		var summaryID string
		var ordinal int64
		if err := rows.Scan(&summaryID, &ordinal); err != nil {
			return nil, fmt.Errorf("scan doctor leaf ordinal: %w", err)
		}
		ordinals[summaryID] = ordinal
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate doctor leaf ordinals: %w", err)
	}
	return ordinals, nil
}

func detectDoctorMarker(content string) string {
	if strings.HasPrefix(content, doctorOldMarker) {
		return "old"
	}
	idx := strings.Index(content, doctorNewMarkerPrefix)
	if idx >= 0 && len(content)-idx < doctorNewMarkerWindow {
		return "new"
	}
	fidx := strings.LastIndex(content, doctorLCMFallbackMarker)
	if fidx > 0 && len(content)-fidx < doctorFallbackWindow && content[fidx-1] == '\n' {
		return "fallback"
	}
	return ""
}

func executeDoctorPlan(ctx context.Context, db *sql.DB, plan doctorPlan, opts doctorOptions, summarizer doctorSummarizer) (int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin doctor transaction: %w", err)
	}
	rollbackNeeded := true
	defer func() {
		if rollbackNeeded {
			_ = tx.Rollback()
		}
	}()

	rewritten := 0
	for idx, item := range plan.ordered {
		fmt.Printf("\n[%d/%d] %s (%s marker, d%d, %s)\n", idx+1, len(plan.ordered), item.summaryID, item.markerKind, item.depth, item.kind)

		source, err := buildSummaryRewriteSource(ctx, tx, item.rewriteSummary, opts.timestamps, time.Local)
		if err != nil {
			return rewritten, fmt.Errorf("build source for %s: %w", item.summaryID, err)
		}
		previousContext, err := resolveRewritePreviousContext(ctx, tx, item.rewriteSummary)
		if err != nil {
			return rewritten, fmt.Errorf("resolve previous context for %s: %w", item.summaryID, err)
		}

		targetTokens := condensedTargetTokens
		if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
			targetTokens = calculateLeafTargetTokens(source.estimatedTokens)
		}

		prompt, err := renderPrompt(item.depth, PromptVars{
			TargetTokens:    targetTokens,
			PreviousContext: previousContext,
			ChildCount:      source.itemCount,
			TimeRange:       source.timeRange,
			Depth:           item.depth,
			SourceText:      source.text,
		}, doctorDefaultApplyPrompt)
		if err != nil {
			return rewritten, fmt.Errorf("render prompt for %s: %w", item.summaryID, err)
		}

		newContent, err := summarizer.summarize(ctx, prompt, targetTokens)
		if err != nil {
			return rewritten, fmt.Errorf("rewrite %s: %w", item.summaryID, err)
		}
		newTokens := estimateTokenCount(newContent)
		if newTokens == 0 && strings.TrimSpace(newContent) != "" {
			newTokens = 1
		}

		printRewriteReport(item.rewriteSummary, source, item.content, newContent, item.tokenCount, newTokens)
		if opts.showDiff {
			diff := buildUnifiedDiff("old/"+item.summaryID, "new/"+item.summaryID, item.content, newContent)
			for _, line := range strings.Split(strings.TrimRight(diff, "\n"), "\n") {
				fmt.Println(colorizeDiffLineCLI(line))
			}
		}

		if _, err := tx.ExecContext(ctx, `
			UPDATE summaries
			SET content = ?, token_count = ?
			WHERE summary_id = ?
		`, newContent, newTokens, item.summaryID); err != nil {
			return rewritten, fmt.Errorf("update summary %s: %w", item.summaryID, err)
		}
		rewritten++
	}

	if opts.apply {
		if err := tx.Commit(); err != nil {
			return rewritten, fmt.Errorf("commit doctor transaction: %w", err)
		}
		rollbackNeeded = false
	}
	return rewritten, nil
}

func printDoctorPlan(plan doctorPlan) {
	fmt.Println("Repair order (bottom-up):")
	for _, item := range plan.ordered {
		kindLabel := fmt.Sprintf("d%d", item.depth)
		if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
			kindLabel = "leaf"
		}
		line := fmt.Sprintf("  %s  %-4s  %s  %dt", item.summaryID, item.markerKind, kindLabel, item.tokenCount)
		if item.hasContextOrdinal {
			line += fmt.Sprintf("  ordinal=%d", item.contextOrdinal)
		}
		if item.depth > 0 || strings.EqualFold(item.kind, "condensed") {
			line += fmt.Sprintf("  children=%d", item.childCount)
		}
		fmt.Println(line)
	}
}

func printDoctorScanReport(report doctorScanReport, scoped bool) {
	if report.totalCount == 0 {
		fmt.Println("No broken summaries found.")
		return
	}

	if scoped && len(report.conversations) == 1 {
		row := report.conversations[0]
		fmt.Printf("Conversation %d: %d broken summaries (%d old marker, %d new marker)\n", row.conversationID, row.totalCount, row.oldCount, row.newCount)
		return
	}

	fmt.Printf("Found %d broken summaries across %d conversations (%d old marker, %d new marker).\n", report.totalCount, len(report.conversations), report.oldCount, report.newCount)
	for _, row := range report.conversations {
		fmt.Printf("  %d: %d broken summaries (%d old, %d new)\n", row.conversationID, row.totalCount, row.oldCount, row.newCount)
	}
}
