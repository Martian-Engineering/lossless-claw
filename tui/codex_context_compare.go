package main

import (
	"fmt"
	"strings"
)

const compareDisplayMaxChars = 4_000

func renderCodexContextComparison(codexMessages []sessionMessage, contextItems []contextItemEntry, width int) string {
	if width <= 0 {
		width = 120
	}
	leftWidth := max(32, (width-5)/2)
	rightWidth := max(32, width-leftWidth-5)

	leftTitle := truncateString("CODEX BACKEND THREAD", leftWidth)
	rightTitle := truncateString("LOSSLESS-MANAGED CONTEXT", rightWidth)
	lines := []string{
		padRight(leftTitle, leftWidth) + "  │  " + padRight(rightTitle, rightWidth),
		strings.Repeat("─", leftWidth) + "──┼──" + strings.Repeat("─", rightWidth),
	}

	maxRows := max(len(codexMessages), len(contextItems))
	for idx := 0; idx < maxRows; idx++ {
		var leftBlock []string
		if idx < len(codexMessages) {
			leftBlock = renderCompareCodexBlock(idx, codexMessages[idx], leftWidth)
		}
		var rightBlock []string
		if idx < len(contextItems) {
			rightBlock = renderCompareContextBlock(idx, contextItems[idx], rightWidth)
		}
		lines = append(lines, zipCompareBlocks(leftBlock, rightBlock, leftWidth, rightWidth)...)
		if idx < maxRows-1 {
			lines = append(lines, strings.Repeat(" ", leftWidth)+"  │  "+strings.Repeat(" ", rightWidth))
		}
	}
	return strings.Join(lines, "\n")
}

func renderCompareCodexBlock(idx int, msg sessionMessage, width int) []string {
	header := fmt.Sprintf("#%d %s %s", idx+1, formatTimestamp(msg.timestamp), strings.ToUpper(msg.role))
	body := conversationMessageDisplayText(sessionMessage{
		role: msg.role,
		text: truncateDisplayText(msg.text, compareDisplayMaxChars),
	})
	return renderCompareBlock(header, body, width)
}

func renderCompareContextBlock(idx int, item contextItemEntry, width int) []string {
	label := item.kind
	if item.itemType == "summary" {
		if item.depth > 0 {
			label = fmt.Sprintf("d%d", item.depth)
		}
		if item.summaryID != "" {
			label += " " + item.summaryID
		}
	} else if item.itemType == "focus_brief" {
		label = "focus " + item.focusBriefID
	} else if item.messageID > 0 {
		label += fmt.Sprintf(" #%d", item.messageID)
	}
	header := fmt.Sprintf("#%d ordinal:%d %s %dt", idx+1, item.ordinal, label, item.tokenCount)
	body := truncateDisplayText(item.content, compareDisplayMaxChars)
	return renderCompareBlock(header, body, width)
}

func renderCompareBlock(header, body string, width int) []string {
	lines := []string{truncateString(header, width)}
	if strings.TrimSpace(body) == "" {
		body = "(no text content)"
	}
	wrapped := wrapText(body, max(20, width))
	for _, line := range strings.Split(wrapped, "\n") {
		lines = append(lines, truncateString(line, width))
	}
	return lines
}

func zipCompareBlocks(left, right []string, leftWidth, rightWidth int) []string {
	count := max(len(left), len(right))
	lines := make([]string, 0, count)
	for idx := 0; idx < count; idx++ {
		leftText := ""
		if idx < len(left) {
			leftText = left[idx]
		}
		rightText := ""
		if idx < len(right) {
			rightText = right[idx]
		}
		lines = append(lines, padRight(leftText, leftWidth)+"  │  "+padRight(rightText, rightWidth))
	}
	return lines
}

func padRight(s string, width int) string {
	if len(s) >= width {
		return truncateString(s, width)
	}
	return s + strings.Repeat(" ", width-len(s))
}
