package main

import (
	"strings"
	"testing"
)

func TestConversationMessageDisplayTextTruncatesLargeToolOutput(t *testing.T) {
	t.Parallel()

	msg := sessionMessage{
		role: "tool",
		text: strings.Repeat("x", conversationDisplayMaxCharsTool+128),
	}

	got := conversationMessageDisplayText(msg)
	if !strings.Contains(got, "[display truncated in conversation view") {
		t.Fatalf("expected truncation notice, got %q", got)
	}
	if !strings.Contains(got, "8128 chars total") {
		t.Fatalf("expected original size in truncation notice, got %q", got)
	}
	if strings.Count(got, "x") >= len(msg.text) {
		t.Fatalf("expected tool output to be shortened for display")
	}
}

func TestConversationMessageDisplayTextKeepsLargeAssistantMessageBelowDefaultLimit(t *testing.T) {
	t.Parallel()

	msg := sessionMessage{
		role: "assistant",
		text: strings.Repeat("a", conversationDisplayMaxCharsTool+128),
	}

	got := conversationMessageDisplayText(msg)
	if got != msg.text {
		t.Fatalf("expected assistant message below default cap to remain unchanged")
	}
}

func TestRenderActiveFocusBannerShowsStaleDiagnostics(t *testing.T) {
	t.Parallel()

	brief := &focusBriefEntry{
		briefID:               "focus_active",
		prompt:                "agent configuration",
		status:                "active",
		tokenCount:            7000,
		targetTokens:          12000,
		postFocusMessageCount: 2,
		postFocusSummaryCount: 1,
		postFocusTokenCount:   900,
		stale:                 true,
		sourceContextChanged:  true,
	}

	got := renderActiveFocusBanner(brief, 200)
	for _, want := range []string{
		"FOCUS active",
		"focus_active",
		"agent configuration",
		"7000/12000t",
		"delta:2 msgs,1 summaries,~900t",
		"stale",
		"source obsolete",
	} {
		if !strings.Contains(got, want) {
			t.Fatalf("expected focus banner to contain %q, got %q", want, got)
		}
	}
	if inactive := renderActiveFocusBanner(&focusBriefEntry{status: "inactive"}, 120); inactive != "" {
		t.Fatalf("inactive focus banner = %q, want empty", inactive)
	}
}
