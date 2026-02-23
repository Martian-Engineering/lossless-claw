package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"time"
)

type rewriteOptions struct {
	apply      bool
	dryRun     bool
	summaryID  string
	depth      int
	depthSet   bool
	all        bool
	promptDir  string
	provider   string
	model      string
	showDiff   bool
	timestamps bool
	tz         *time.Location
}

type rewriteSummary struct {
	summaryID      string
	conversationID int64
	kind           string
	depth          int
	tokenCount     int
	content        string
	createdAt      string
	childCount     int
}

type rewriteSource struct {
	text            string
	itemCount       int
	estimatedTokens int
	timeRange       string
	label           string
}

type summaryTimeRange struct {
	earliest string
	latest   string
	valid    bool
}

// runRewriteCommand executes the standalone rewrite CLI workflow.
func runRewriteCommand(args []string) error {
	opts, conversationID, err := parseRewriteArgs(args)
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
	targets, err := loadRewriteTargets(ctx, db, conversationID, opts)
	if err != nil {
		return err
	}
	if len(targets) == 0 {
		fmt.Println("No summaries matched rewrite selection.")
		return nil
	}

	fmt.Printf("Rewriting %d summaries in conversation %d...\n", len(targets), conversationID)
	if opts.dryRun {
		fmt.Println("Mode: dry-run (no DB writes)")
	} else {
		fmt.Println("Mode: apply")
	}

	var client *anthropicClient
	if !opts.dryRun {
		apiKey, err := resolveProviderAPIKey(paths, opts.provider)
		if err != nil {
			return err
		}
		client = &anthropicClient{
			provider: opts.provider,
			apiKey:   apiKey,
			http:     &http.Client{Timeout: defaultHTTPTimeout},
			model:    opts.model,
		}
	} else {
		apiKey, err := resolveProviderAPIKey(paths, opts.provider)
		if err == nil {
			client = &anthropicClient{
				provider: opts.provider,
				apiKey:   apiKey,
				http:     &http.Client{Timeout: defaultHTTPTimeout},
				model:    opts.model,
			}
		}
		if client == nil {
			return fmt.Errorf("unable to resolve API key for provider %q during dry-run rewrite preview", opts.provider)
		}
	}

	rewritten := 0
	for idx, item := range targets {
		fmt.Printf("\n[%d/%d] %s (d%d, %s)\n", idx+1, len(targets), item.summaryID, item.depth, item.kind)

		source, err := buildSummaryRewriteSource(ctx, db, item, opts.timestamps, opts.tz)
		if err != nil {
			return fmt.Errorf("build source for %s: %w", item.summaryID, err)
		}
		previousContext, err := resolveRewritePreviousContext(ctx, db, item)
		if err != nil {
			return fmt.Errorf("resolve previous context for %s: %w", item.summaryID, err)
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
		}, opts.promptDir)
		if err != nil {
			return fmt.Errorf("render prompt for %s: %w", item.summaryID, err)
		}

		newContent, err := client.summarize(ctx, prompt, targetTokens)
		if err != nil {
			return fmt.Errorf("rewrite %s: %w", item.summaryID, err)
		}
		newTokens := estimateTokenCount(newContent)

		printRewriteReport(item, source, item.content, newContent, item.tokenCount, newTokens)
		if opts.showDiff {
			diff := buildUnifiedDiff("old/"+item.summaryID, "new/"+item.summaryID, item.content, newContent)
			for _, line := range strings.Split(strings.TrimRight(diff, "\n"), "\n") {
				fmt.Println(colorizeDiffLineCLI(line))
			}
		}

		if opts.apply {
			if _, err := db.ExecContext(ctx, `
				UPDATE summaries
				SET content = ?, token_count = ?
				WHERE summary_id = ?
			`, newContent, newTokens, item.summaryID); err != nil {
				return fmt.Errorf("update summary %s: %w", item.summaryID, err)
			}
			item.content = newContent
			item.tokenCount = newTokens
		}
		rewritten++
	}

	if opts.apply {
		fmt.Printf("\nDone. Rewrote %d summaries.\n", rewritten)
	} else {
		fmt.Printf("\nDone. Previewed %d rewrites (dry-run).\n", rewritten)
	}
	return nil
}

func parseRewriteArgs(args []string) (rewriteOptions, int64, error) {
	fs := flag.NewFlagSet("rewrite", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	apply := fs.Bool("apply", false, "apply rewrites to the DB")
	dryRun := fs.Bool("dry-run", true, "show before/after without writing")
	summaryID := fs.String("summary", "", "rewrite a specific summary ID")
	depth := fs.Int("depth", 0, "rewrite summaries at a specific depth")
	all := fs.Bool("all", false, "rewrite all summaries (bottom-up)")
	promptDir := fs.String("prompt-dir", "", "custom prompt template directory")
	provider := fs.String("provider", "", "provider id (e.g. anthropic, openai)")
	model := fs.String("model", "", "summary model id")
	showDiff := fs.Bool("diff", false, "show unified diff")
	timestamps := fs.Bool("timestamps", true, "inject timestamps into source text")
	tzName := fs.String("tz", "", "timezone for timestamps (e.g. America/Los_Angeles; default: system local)")

	normalizedArgs, err := normalizeRewriteArgs(args)
	if err != nil {
		return rewriteOptions{}, 0, fmt.Errorf("%w\n%s", err, rewriteUsageText())
	}
	if err := fs.Parse(normalizedArgs); err != nil {
		return rewriteOptions{}, 0, fmt.Errorf("%w\n%s", err, rewriteUsageText())
	}

	loc := time.Local
	if *tzName != "" {
		parsed, tzErr := time.LoadLocation(*tzName)
		if tzErr != nil {
			return rewriteOptions{}, 0, fmt.Errorf("invalid timezone %q: %w", *tzName, tzErr)
		}
		loc = parsed
	}

	opts := rewriteOptions{
		apply:      *apply,
		dryRun:     *dryRun,
		summaryID:  strings.TrimSpace(*summaryID),
		depth:      *depth,
		all:        *all,
		promptDir:  strings.TrimSpace(*promptDir),
		provider:   strings.TrimSpace(*provider),
		model:      strings.TrimSpace(*model),
		showDiff:   *showDiff,
		timestamps: *timestamps,
		tz:         loc,
		depthSet:   rewriteDepthFlagSet(args),
	}
	if opts.promptDir != "" {
		opts.promptDir = expandHomePath(opts.promptDir)
	}
	opts.provider, opts.model = resolveSummaryProviderModel(opts.provider, opts.model)
	if opts.apply {
		opts.dryRun = false
	}
	if !opts.apply {
		opts.dryRun = true
	}

	modeCount := 0
	if opts.summaryID != "" {
		modeCount++
	}
	if opts.depthSet {
		modeCount++
	}
	if opts.all {
		modeCount++
	}
	if modeCount != 1 {
		return rewriteOptions{}, 0, fmt.Errorf("select exactly one of --summary, --depth, or --all")
	}
	if opts.depthSet && opts.depth < 0 {
		return rewriteOptions{}, 0, fmt.Errorf("--depth must be >= 0")
	}
	if fs.NArg() != 1 {
		return rewriteOptions{}, 0, fmt.Errorf("conversation ID is required")
	}

	conversationID, err := strconv.ParseInt(fs.Arg(0), 10, 64)
	if err != nil {
		return rewriteOptions{}, 0, fmt.Errorf("parse conversation ID %q: %w", fs.Arg(0), err)
	}
	return opts, conversationID, nil
}

func normalizeRewriteArgs(args []string) ([]string, error) {
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, 1)

	for i := 0; i < len(args); i++ {
		arg := args[i]
		takesValue := arg == "--summary" || arg == "--depth" || arg == "--prompt-dir" || arg == "--provider" || arg == "--model" || arg == "--tz"
		if takesValue {
			if i+1 >= len(args) {
				return nil, fmt.Errorf("missing value for %s", arg)
			}
			flags = append(flags, arg, args[i+1])
			i++
			continue
		}
		if strings.HasPrefix(arg, "--summary=") || strings.HasPrefix(arg, "--depth=") || strings.HasPrefix(arg, "--prompt-dir=") || strings.HasPrefix(arg, "--provider=") || strings.HasPrefix(arg, "--model=") || strings.HasPrefix(arg, "--tz=") {
			flags = append(flags, arg)
			continue
		}
		if arg == "--apply" || arg == "--dry-run" || strings.HasPrefix(arg, "--dry-run=") || arg == "--all" || arg == "--diff" || arg == "--timestamps" || strings.HasPrefix(arg, "--timestamps=") {
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

func rewriteDepthFlagSet(args []string) bool {
	for _, arg := range args {
		if arg == "--depth" || strings.HasPrefix(arg, "--depth=") {
			return true
		}
	}
	return false
}

func rewriteUsageText() string {
	return strings.TrimSpace(`Usage:
  lcm-tui rewrite <conversation_id> --summary <id> [--dry-run|--apply]
  lcm-tui rewrite <conversation_id> --depth <n> [--dry-run|--apply]
  lcm-tui rewrite <conversation_id> --all [--dry-run|--apply]

Flags:
  --summary <id>      rewrite a single summary
  --depth <n>         rewrite all summaries at depth n
  --all               rewrite all summaries (bottom-up)
  --dry-run           show before/after (default)
  --apply             write changes to DB
  --prompt-dir <path> custom template directory
  --provider <id>     API provider (inferred from model when omitted)
  --model <model>     API model (default: provider-specific)
  --diff              show unified diff
  --timestamps        inject timestamps into source text (default true)
  --tz <timezone>     timezone for timestamps (e.g. America/Los_Angeles; default: system local)
`)
}

func loadRewriteTargets(ctx context.Context, q sqlQueryer, conversationID int64, opts rewriteOptions) ([]rewriteSummary, error) {
	query := `
		SELECT
			s.summary_id,
			s.conversation_id,
			s.kind,
			COALESCE(s.depth, 0),
			COALESCE(s.token_count, 0),
			COALESCE(s.content, ''),
			COALESCE(s.created_at, ''),
			COALESCE(spc.child_count, 0)
		FROM summaries s
		LEFT JOIN (
			SELECT summary_id, COUNT(*) AS child_count
			FROM summary_parents
			GROUP BY summary_id
		) spc ON spc.summary_id = s.summary_id
		WHERE s.conversation_id = ?
	`
	args := []any{conversationID}
	if opts.summaryID != "" {
		query += " AND s.summary_id = ?"
		args = append(args, opts.summaryID)
	}
	if opts.depthSet {
		query += " AND COALESCE(s.depth, 0) = ?"
		args = append(args, opts.depth)
	}
	query += " ORDER BY COALESCE(s.depth, 0) ASC, s.created_at ASC, s.summary_id ASC"

	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, fmt.Errorf("query rewrite targets: %w", err)
	}
	defer rows.Close()

	targets := make([]rewriteSummary, 0, 64)
	for rows.Next() {
		var item rewriteSummary
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
			return nil, fmt.Errorf("scan rewrite summary row: %w", err)
		}
		targets = append(targets, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate rewrite summary rows: %w", err)
	}

	if opts.summaryID != "" && len(targets) == 0 {
		return nil, fmt.Errorf("summary %s not found in conversation %d", opts.summaryID, conversationID)
	}
	if opts.all {
		sort.Slice(targets, func(i, j int) bool {
			left := targets[i]
			right := targets[j]
			if left.depth != right.depth {
				return left.depth < right.depth
			}
			if left.createdAt != right.createdAt {
				return left.createdAt < right.createdAt
			}
			return left.summaryID < right.summaryID
		})
	}
	return targets, nil
}

func buildSummaryRewriteSource(ctx context.Context, q sqlQueryer, item rewriteSummary, includeTimestamps bool, loc *time.Location) (rewriteSource, error) {
	if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
		return buildLeafRewriteSource(ctx, q, item.summaryID, includeTimestamps, loc)
	}
	return buildCondensedRewriteSource(ctx, q, item.summaryID, includeTimestamps, loc)
}

func buildLeafRewriteSource(ctx context.Context, q sqlQueryer, summaryID string, includeTimestamps bool, loc *time.Location) (rewriteSource, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT m.role, COALESCE(m.content, ''), COALESCE(m.created_at, '')
		FROM summary_messages sm
		JOIN messages m ON m.message_id = sm.message_id
		WHERE sm.summary_id = ?
		ORDER BY sm.ordinal ASC
	`, summaryID)
	if err != nil {
		return rewriteSource{}, fmt.Errorf("query leaf source for %s: %w", summaryID, err)
	}
	defer rows.Close()

	parts := make([]string, 0, 32)
	var earliest, latest string
	for rows.Next() {
		var role, content, createdAt string
		if err := rows.Scan(&role, &content, &createdAt); err != nil {
			return rewriteSource{}, fmt.Errorf("scan leaf source row: %w", err)
		}
		if strings.TrimSpace(role) == "" {
			role = "unknown"
		}
		content = strings.TrimSpace(content)
		if content == "" {
			content = "(empty)"
		}
		formattedTime := formatTimestampWithLoc(createdAt, loc)
		if formattedTime != "" {
			if earliest == "" || formattedTime < earliest {
				earliest = formattedTime
			}
			if latest == "" || formattedTime > latest {
				latest = formattedTime
			}
		}
		if includeTimestamps && formattedTime != "" {
			parts = append(parts, fmt.Sprintf("[%s] [%s] %s", formattedTime, role, content))
		} else {
			parts = append(parts, fmt.Sprintf("[%s] %s", role, content))
		}
	}
	if err := rows.Err(); err != nil {
		return rewriteSource{}, fmt.Errorf("iterate leaf source rows: %w", err)
	}
	if len(parts) == 0 {
		return rewriteSource{}, fmt.Errorf("no messages linked to summary %s", summaryID)
	}

	text := strings.Join(parts, "\n")
	return rewriteSource{
		text:            text,
		itemCount:       len(parts),
		estimatedTokens: estimateTokenCount(text),
		timeRange:       formatTimeRange(earliest, latest),
		label:           "messages",
	}, nil
}

func buildCondensedRewriteSource(ctx context.Context, q sqlQueryer, summaryID string, includeTimestamps bool, loc *time.Location) (rewriteSource, error) {
	rows, err := q.QueryContext(ctx, `
		SELECT sp.parent_summary_id, COALESCE(s.content, '')
		FROM summary_parents sp
		JOIN summaries s ON s.summary_id = sp.parent_summary_id
		WHERE sp.summary_id = ?
		ORDER BY sp.ordinal ASC
	`, summaryID)
	if err != nil {
		return rewriteSource{}, fmt.Errorf("query condensed source for %s: %w", summaryID, err)
	}
	defer rows.Close()

	parts := make([]string, 0, 32)
	var minRange, maxRange string
	for rows.Next() {
		var childID, content string
		if err := rows.Scan(&childID, &content); err != nil {
			return rewriteSource{}, fmt.Errorf("scan condensed source row: %w", err)
		}
		content = strings.TrimSpace(content)
		if content == "" {
			continue
		}
		timeRange, err := lookupSummaryLeafTimeRange(ctx, q, childID, loc)
		if err != nil {
			return rewriteSource{}, fmt.Errorf("derive time range for child %s: %w", childID, err)
		}
		if timeRange.valid {
			if minRange == "" || timeRange.earliest < minRange {
				minRange = timeRange.earliest
			}
			if maxRange == "" || timeRange.latest > maxRange {
				maxRange = timeRange.latest
			}
		}
		if includeTimestamps && timeRange.valid {
			header := fmt.Sprintf("[%s]", formatTimeRange(timeRange.earliest, timeRange.latest))
			parts = append(parts, header+"\n"+content)
			continue
		}
		parts = append(parts, content)
	}
	if err := rows.Err(); err != nil {
		return rewriteSource{}, fmt.Errorf("iterate condensed source rows: %w", err)
	}
	if len(parts) == 0 {
		return rewriteSource{}, fmt.Errorf("no child summaries linked to %s", summaryID)
	}

	text := strings.Join(parts, "\n\n")
	return rewriteSource{
		text:            text,
		itemCount:       len(parts),
		estimatedTokens: estimateTokenCount(text),
		timeRange:       formatTimeRange(minRange, maxRange),
		label:           "child summaries",
	}, nil
}

func lookupSummaryLeafTimeRange(ctx context.Context, q sqlQueryer, summaryID string, loc *time.Location) (summaryTimeRange, error) {
	var earliest, latest sql.NullString
	err := q.QueryRowContext(ctx, `
		WITH RECURSIVE walk(summary_id) AS (
			SELECT ?
			UNION ALL
			SELECT sp.parent_summary_id
			FROM summary_parents sp
			JOIN walk w ON w.summary_id = sp.summary_id
		)
		SELECT MIN(m.created_at), MAX(m.created_at)
		FROM walk w
		JOIN summaries s ON s.summary_id = w.summary_id
		JOIN summary_messages sm ON sm.summary_id = s.summary_id
		JOIN messages m ON m.message_id = sm.message_id
		WHERE COALESCE(s.depth, 0) = 0
	`, summaryID).Scan(&earliest, &latest)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return summaryTimeRange{}, nil
		}
		return summaryTimeRange{}, fmt.Errorf("query summary time range: %w", err)
	}
	e := formatTimestampWithLoc(earliest.String, loc)
	l := formatTimestampWithLoc(latest.String, loc)
	if e == "" || l == "" {
		return summaryTimeRange{}, nil
	}
	return summaryTimeRange{earliest: e, latest: l, valid: true}, nil
}

func resolveRewritePreviousContext(ctx context.Context, q sqlQueryer, item rewriteSummary) (string, error) {
	// Use the shared previousContextLookup which handles both active
	// context_items and absorbed nodes via summary_parents
	return previousContextLookup(ctx, q, item.summaryID, item.conversationID, item.depth, item.kind, item.createdAt)
}

func colorizeDiffLineCLI(line string) string {
	switch {
	case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
		return "\033[1m" + line + "\033[0m" // bold
	case strings.HasPrefix(line, "@@"):
		return "\033[36m" + line + "\033[0m" // cyan
	case strings.HasPrefix(line, "+"):
		return "\033[32m" + line + "\033[0m" // green
	case strings.HasPrefix(line, "-"):
		return "\033[31m" + line + "\033[0m" // red
	default:
		return line
	}
}

func printRewriteReport(item rewriteSummary, source rewriteSource, oldContent, newContent string, oldTokens, newTokens int) {
	kindLabel := fmt.Sprintf("d%d", item.depth)
	if item.depth == 0 || strings.EqualFold(item.kind, "leaf") {
		kindLabel = "leaf"
	}
	header := fmt.Sprintf("━━━ %s (%s, %d %s", item.summaryID, kindLabel, source.itemCount, source.label)
	if source.timeRange != "" {
		header += ", " + source.timeRange
	}
	header += ") ━━━"
	fmt.Println(header)
	fmt.Printf("OLD (%d tokens):\n%s\n\n", oldTokens, strings.TrimSpace(oldContent))
	fmt.Printf("NEW (%d tokens):\n%s\n\n", newTokens, strings.TrimSpace(newContent))
	fmt.Printf("Δ tokens: %+d (%d -> %d)\n", newTokens-oldTokens, oldTokens, newTokens)
}

func formatTimestampWithLoc(raw string, loc *time.Location) string {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return ""
	}
	if loc == nil {
		loc = time.Local
	}
	if parsed, err := parseSQLiteTime(trimmed); err == nil {
		t := parsed.In(loc)
		zone := t.Format("MST")
		return t.Format("2006-01-02 15:04 ") + zone
	}
	return ""
}

func parseSQLiteTime(raw string) (time.Time, error) {
	layouts := []string{
		"2006-01-02 15:04:05",
		"2006-01-02 15:04:05.000",
		"2006-01-02 15:04:05.000000",
		"2006-01-02T15:04:05Z",
		"2006-01-02T15:04:05.000Z",
		"2006-01-02T15:04:05.000000Z",
		"2006-01-02T15:04:05-07:00",
		"2006-01-02T15:04:05.000-07:00",
		"2006-01-02T15:04:05.000000-07:00",
	}
	for _, layout := range layouts {
		parsed, parseErr := timeParse(layout, raw)
		if parseErr == nil {
			return parsed, nil
		}
	}
	return time.Time{}, fmt.Errorf("unsupported time format %q", raw)
}

func formatTimeRange(earliest, latest string) string {
	e := strings.TrimSpace(earliest)
	l := strings.TrimSpace(latest)
	if e == "" && l == "" {
		return ""
	}
	if l == "" {
		return e
	}
	if e == "" {
		return l
	}
	if e == l {
		return e
	}
	return e + " - " + l
}

// timeParse exists to keep timestamp parsing logic testable and isolated.
func timeParse(layout, value string) (time.Time, error) {
	return time.Parse(layout, value)
}
