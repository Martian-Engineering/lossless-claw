package main

import (
	"context"
	"database/sql"
	"errors"
	"flag"
	"fmt"
	"io"
	"strconv"
	"strings"
)

type dissolveOptions struct {
	summaryID string
	apply     bool
	purge     bool // delete the condensed summary record too
}

type dissolveTarget struct {
	summaryID      string
	conversationID int64
	kind           string
	depth          int
	tokenCount     int
	ordinal        int64
}

type dissolveParent struct {
	summaryID  string
	ordinal    int // position within summary_parents
	kind       string
	depth      int
	tokenCount int
	content    string
}

type dissolvePlan struct {
	target            dissolveTarget
	parents           []dissolveParent
	totalParentTokens int
	itemsToShift      int
	shift             int
}

// runDissolveCommand executes the standalone dissolve CLI path.
func runDissolveCommand(args []string) error {
	opts, conversationID, err := parseDissolveArgs(args)
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

	plan, err := buildDissolvePlan(ctx, db, conversationID, opts.summaryID)
	if err != nil {
		return err
	}

	// Show plan
	fmt.Printf("Dissolve %s (%s, d%d, %dt) at context ordinal %d\n",
		plan.target.summaryID, plan.target.kind, plan.target.depth, plan.target.tokenCount, plan.target.ordinal)
	fmt.Printf("Restore %d parent summaries:\n", len(plan.parents))

	for _, p := range plan.parents {
		preview := oneLine(p.content)
		preview = truncateString(preview, 80)
		fmt.Printf("  [%d] %s (%s, d%d, %dt) %s\n", p.ordinal, p.summaryID, p.kind, p.depth, p.tokenCount, preview)
	}
	fmt.Printf("\nToken impact: %dt condensed → %dt restored (%+dt)\n",
		plan.target.tokenCount, plan.totalParentTokens, plan.totalParentTokens-plan.target.tokenCount)
	fmt.Printf("Ordinal shift: %d items after ordinal %d will shift by +%d\n", plan.itemsToShift, plan.target.ordinal, plan.shift)

	if !opts.apply {
		fmt.Println("\nDry run. Use --apply to execute.")
		return nil
	}

	fmt.Println("\nApplying...")
	newCount, err := applyDissolvePlan(ctx, db, plan, opts.purge)
	if err != nil {
		return err
	}
	fmt.Printf("\nDone. Context now has %d items. Changes take effect on next conversation turn.\n", newCount)
	return nil
}

// buildDissolvePlan validates a condensed target and computes preview stats
// (restored parents, token impact, and ordinal shifts) without mutating DB state.
func buildDissolvePlan(ctx context.Context, db *sql.DB, conversationID int64, summaryID string) (dissolvePlan, error) {
	target, err := loadDissolveTarget(ctx, db, conversationID, summaryID)
	if err != nil {
		return dissolvePlan{}, err
	}

	parents, err := loadDissolveParents(ctx, db, summaryID)
	if err != nil {
		return dissolvePlan{}, err
	}
	if len(parents) == 0 {
		return dissolvePlan{}, fmt.Errorf("summary %s has no parent summaries — nothing to dissolve", summaryID)
	}

	totalParentTokens := 0
	for _, parent := range parents {
		totalParentTokens += parent.tokenCount
	}

	var itemsToShift int
	err = db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM context_items
		WHERE conversation_id = ? AND ordinal > ?
	`, conversationID, target.ordinal).Scan(&itemsToShift)
	if err != nil {
		return dissolvePlan{}, fmt.Errorf("count items to shift: %w", err)
	}

	return dissolvePlan{
		target:            target,
		parents:           parents,
		totalParentTokens: totalParentTokens,
		itemsToShift:      itemsToShift,
		shift:             len(parents) - 1,
	}, nil
}

// applyDissolvePlan performs the transactional context rewrite from a dry-run plan.
func applyDissolvePlan(ctx context.Context, db *sql.DB, plan dissolvePlan, purge bool) (int, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return 0, fmt.Errorf("begin transaction: %w", err)
	}
	rollback := true
	defer func() {
		if rollback {
			_ = tx.Rollback()
		}
	}()

	res, err := tx.ExecContext(ctx, `
		DELETE FROM context_items
		WHERE conversation_id = ? AND ordinal = ? AND summary_id = ?
	`, plan.target.conversationID, plan.target.ordinal, plan.target.summaryID)
	if err != nil {
		return 0, fmt.Errorf("delete condensed context_item: %w", err)
	}
	deleted, _ := res.RowsAffected()
	if deleted != 1 {
		return 0, fmt.Errorf("expected to delete 1 context_item, deleted %d", deleted)
	}

	if plan.shift > 0 {
		const tempOffset = 10_000_000
		_, err = tx.ExecContext(ctx, `
			UPDATE context_items
			SET ordinal = ordinal + ?
			WHERE conversation_id = ? AND ordinal > ?
		`, tempOffset, plan.target.conversationID, plan.target.ordinal)
		if err != nil {
			return 0, fmt.Errorf("shift items to temp ordinals: %w", err)
		}

		_, err = tx.ExecContext(ctx, `
			UPDATE context_items
			SET ordinal = ordinal - ? + ?
			WHERE conversation_id = ? AND ordinal >= ?
		`, tempOffset, plan.shift, plan.target.conversationID, tempOffset)
		if err != nil {
			return 0, fmt.Errorf("shift items to final ordinals: %w", err)
		}
	}

	for i, parent := range plan.parents {
		newOrdinal := plan.target.ordinal + int64(i)
		_, err = tx.ExecContext(ctx, `
			INSERT INTO context_items (conversation_id, ordinal, item_type, summary_id, created_at)
			VALUES (?, ?, 'summary', ?, datetime('now'))
		`, plan.target.conversationID, newOrdinal, parent.summaryID)
		if err != nil {
			return 0, fmt.Errorf("insert parent %s at ordinal %d: %w", parent.summaryID, newOrdinal, err)
		}
	}

	if purge {
		_, err = tx.ExecContext(ctx, `
			DELETE FROM summary_parents WHERE summary_id = ?
		`, plan.target.summaryID)
		if err != nil {
			return 0, fmt.Errorf("delete summary_parents for %s: %w", plan.target.summaryID, err)
		}
		_, err = tx.ExecContext(ctx, `
			DELETE FROM summaries WHERE summary_id = ?
		`, plan.target.summaryID)
		if err != nil {
			return 0, fmt.Errorf("delete summary record %s: %w", plan.target.summaryID, err)
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, fmt.Errorf("commit: %w", err)
	}
	rollback = false

	var newCount int
	_ = db.QueryRowContext(ctx, `
		SELECT COUNT(*) FROM context_items WHERE conversation_id = ?
	`, plan.target.conversationID).Scan(&newCount)
	return newCount, nil
}

func parseDissolveArgs(args []string) (dissolveOptions, int64, error) {
	fs := flag.NewFlagSet("dissolve", flag.ContinueOnError)
	fs.SetOutput(io.Discard)

	summaryID := fs.String("summary-id", "", "summary ID to dissolve (required)")
	apply := fs.Bool("apply", false, "apply changes to the DB")
	purge := fs.Bool("purge", true, "delete the condensed summary record from DB (use --purge=false to keep)")

	// Normalize: pull positional args out so flags parse correctly regardless of order
	normalized, err := normalizeDissolveArgs(args)
	if err != nil {
		return dissolveOptions{}, 0, fmt.Errorf("%w\n%s", err, dissolveUsageText())
	}
	if err := fs.Parse(normalized); err != nil {
		return dissolveOptions{}, 0, fmt.Errorf("%w\n%s", err, dissolveUsageText())
	}

	if strings.TrimSpace(*summaryID) == "" {
		return dissolveOptions{}, 0, fmt.Errorf("--summary-id is required\n%s", dissolveUsageText())
	}

	if fs.NArg() != 1 {
		return dissolveOptions{}, 0, fmt.Errorf("conversation ID is required\n%s", dissolveUsageText())
	}

	conversationID, err := strconv.ParseInt(fs.Arg(0), 10, 64)
	if err != nil {
		return dissolveOptions{}, 0, fmt.Errorf("parse conversation ID %q: %w\n%s", fs.Arg(0), err, dissolveUsageText())
	}

	return dissolveOptions{
		summaryID: strings.TrimSpace(*summaryID),
		apply:     *apply,
		purge:     *purge,
	}, conversationID, nil
}

func normalizeDissolveArgs(args []string) ([]string, error) {
	flags := make([]string, 0, len(args))
	positionals := make([]string, 0, 1)

	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--apply" || arg == "--purge":
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

func dissolveUsageText() string {
	return strings.TrimSpace(`
Usage:
  lcm-tui dissolve <conversation_id> --summary-id <id> [--apply] [--purge]

Dissolve a condensed summary back into its constituent parent summaries
in the active context. Restores the parents as individual context_items
at the position the condensed node occupied.

Flags:
  --summary-id <id>   Condensed summary to dissolve (required)
  --apply             Execute changes (default: dry run)
  --purge             Also delete the condensed summary record from DB
`)
}

func loadDissolveTarget(ctx context.Context, db *sql.DB, conversationID int64, summaryID string) (dissolveTarget, error) {
	var target dissolveTarget
	err := db.QueryRowContext(ctx, `
		SELECT
			s.summary_id,
			s.conversation_id,
			s.kind,
			s.depth,
			s.token_count,
			ci.ordinal
		FROM summaries s
		JOIN context_items ci
			ON ci.summary_id = s.summary_id
			AND ci.conversation_id = s.conversation_id
		WHERE s.summary_id = ?
		  AND s.conversation_id = ?
	`, summaryID, conversationID).Scan(
		&target.summaryID,
		&target.conversationID,
		&target.kind,
		&target.depth,
		&target.tokenCount,
		&target.ordinal,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return dissolveTarget{}, fmt.Errorf("summary %s not found in active context for conversation %d", summaryID, conversationID)
	}
	if err != nil {
		return dissolveTarget{}, fmt.Errorf("load dissolve target: %w", err)
	}
	if target.kind != "condensed" {
		return dissolveTarget{}, fmt.Errorf("summary %s is a %s (depth %d), not condensed — only condensed summaries can be dissolved", summaryID, target.kind, target.depth)
	}
	return target, nil
}

func loadDissolveParents(ctx context.Context, db *sql.DB, summaryID string) ([]dissolveParent, error) {
	rows, err := db.QueryContext(ctx, `
		SELECT
			sp.parent_summary_id,
			sp.ordinal,
			s.kind,
			s.depth,
			s.token_count,
			s.content
		FROM summary_parents sp
		JOIN summaries s ON s.summary_id = sp.parent_summary_id
		WHERE sp.summary_id = ?
		ORDER BY sp.ordinal ASC
	`, summaryID)
	if err != nil {
		return nil, fmt.Errorf("query parents for %s: %w", summaryID, err)
	}
	defer rows.Close()

	var parents []dissolveParent
	for rows.Next() {
		var p dissolveParent
		if err := rows.Scan(&p.summaryID, &p.ordinal, &p.kind, &p.depth, &p.tokenCount, &p.content); err != nil {
			return nil, fmt.Errorf("scan parent row: %w", err)
		}
		parents = append(parents, p)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate parents: %w", err)
	}
	return parents, nil
}
