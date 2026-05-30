package main

import (
	"strings"
	"testing"
)

func TestRenderCodexContextComparisonShowsBothSides(t *testing.T) {
	t.Parallel()

	rendered := renderCodexContextComparison(
		[]sessionMessage{
			{
				timestamp: "2026-05-12T14:52:29Z",
				role:      "assistant",
				text:      "codex backend answer",
			},
		},
		[]contextItemEntry{
			{
				ordinal:    7,
				itemType:   "summary",
				summaryID:  "sum_abc",
				kind:       "condensed",
				depth:      2,
				tokenCount: 123,
				content:    "lossless managed summary",
			},
		},
		100,
	)

	for _, want := range []string{
		"CODEX BACKEND THREAD",
		"LOSSLESS-MANAGED CONTEXT",
		"codex backend answer",
		"ordinal:7 d2 sum_abc 123t",
		"lossless managed summary",
	} {
		if !strings.Contains(rendered, want) {
			t.Fatalf("expected comparison to contain %q, got:\n%s", want, rendered)
		}
	}
}
