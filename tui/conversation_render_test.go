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
