package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// previousContextLookup finds the content of the chronologically previous
// summary at the same depth. Works for:
//   - Leaves still in context_items (uses ordinal ordering)
//   - Absorbed leaves (uses summary_parents sibling ordering)
//   - Condensed nodes in context_items (uses ordinal + depth filter)
//   - Absorbed condensed nodes (uses summary_parents sibling ordering)
//
// Falls back to timestamp ordering as a last resort.
// Returns empty string (not "(none)") when no previous context exists.
func previousContextLookup(ctx context.Context, q sqlQueryer, summaryID string, conversationID int64, depth int, kind, createdAt string) (string, error) {
	isLeaf := depth == 0 || strings.EqualFold(kind, "leaf")

	// Strategy 1: look up via context_items (still-active nodes)
	content, found, err := previousViaContextItems(ctx, q, summaryID, conversationID, depth, isLeaf)
	if err != nil {
		return "", err
	}
	if found {
		return content, nil
	}

	// Strategy 2: look up via summary_parents (absorbed nodes)
	content, found, err = previousViaSummaryParents(ctx, q, summaryID)
	if err != nil {
		return "", err
	}
	if found {
		return content, nil
	}

	// Strategy 3: timestamp ordering (catches edge cases)
	content, found, err = previousViaTimestamp(ctx, q, summaryID, conversationID, depth, createdAt)
	if err != nil {
		return "", err
	}
	if found {
		return content, nil
	}

	return "", nil
}

// previousViaContextItems finds previous sibling using context_items ordering.
func previousViaContextItems(ctx context.Context, q sqlQueryer, summaryID string, conversationID int64, depth int, isLeaf bool) (string, bool, error) {
	var targetOrdinal int64
	err := q.QueryRowContext(ctx, `
		SELECT ci.ordinal
		FROM context_items ci
		WHERE ci.conversation_id = ?
		  AND ci.item_type = 'summary'
		  AND ci.summary_id = ?
		LIMIT 1
	`, conversationID, summaryID).Scan(&targetOrdinal)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil // not in context_items
	}
	if err != nil {
		return "", false, fmt.Errorf("query context ordinal for %s: %w", summaryID, err)
	}

	// For leaves, match depth 0; for condensed, match same depth
	depthFilter := depth
	if isLeaf {
		depthFilter = 0
	}

	var previous sql.NullString
	err = q.QueryRowContext(ctx, `
		SELECT s.content
		FROM context_items ci
		JOIN summaries s ON s.summary_id = ci.summary_id
		WHERE ci.conversation_id = ?
		  AND ci.item_type = 'summary'
		  AND COALESCE(s.depth, 0) = ?
		  AND ci.ordinal < ?
		ORDER BY ci.ordinal DESC
		LIMIT 1
	`, conversationID, depthFilter, targetOrdinal).Scan(&previous)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil // first at this depth
	}
	if err != nil {
		return "", false, fmt.Errorf("query previous via context_items: %w", err)
	}
	content := strings.TrimSpace(previous.String)
	if content == "" {
		return "", false, nil
	}
	return content, true, nil
}

// previousViaSummaryParents finds the previous sibling of a node that has been
// absorbed into a condensed parent.
func previousViaSummaryParents(ctx context.Context, q sqlQueryer, summaryID string) (string, bool, error) {
	var parentID string
	var myOrdinal int64
	err := q.QueryRowContext(ctx, `
		SELECT sp.summary_id, sp.ordinal
		FROM summary_parents sp
		WHERE sp.parent_summary_id = ?
		LIMIT 1
	`, summaryID).Scan(&parentID, &myOrdinal)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil // no parent
	}
	if err != nil {
		return "", false, fmt.Errorf("query parent of %s: %w", summaryID, err)
	}

	var previous sql.NullString
	err = q.QueryRowContext(ctx, `
		SELECT s.content
		FROM summary_parents sp
		JOIN summaries s ON s.summary_id = sp.parent_summary_id
		WHERE sp.summary_id = ?
		  AND sp.ordinal < ?
		ORDER BY sp.ordinal DESC
		LIMIT 1
	`, parentID, myOrdinal).Scan(&previous)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil // first child
	}
	if err != nil {
		return "", false, fmt.Errorf("query previous sibling of %s: %w", summaryID, err)
	}
	content := strings.TrimSpace(previous.String)
	if content == "" {
		return "", false, nil
	}
	return content, true, nil
}

// previousViaTimestamp finds the previous summary at the same depth by
// timestamp ordering. Last resort fallback.
func previousViaTimestamp(ctx context.Context, q sqlQueryer, summaryID string, conversationID int64, depth int, createdAt string) (string, bool, error) {
	if createdAt == "" {
		return "", false, nil
	}
	var previous sql.NullString
	err := q.QueryRowContext(ctx, `
		SELECT content
		FROM summaries
		WHERE conversation_id = ?
		  AND COALESCE(depth, 0) = ?
		  AND (created_at < ? OR (created_at = ? AND summary_id < ?))
		ORDER BY created_at DESC, summary_id DESC
		LIMIT 1
	`, conversationID, depth, createdAt, createdAt, summaryID).Scan(&previous)
	if errors.Is(err, sql.ErrNoRows) {
		return "", false, nil
	}
	if err != nil {
		return "", false, fmt.Errorf("query previous via timestamp for %s: %w", summaryID, err)
	}
	content := strings.TrimSpace(previous.String)
	if content == "" {
		return "", false, nil
	}
	return content, true, nil
}
