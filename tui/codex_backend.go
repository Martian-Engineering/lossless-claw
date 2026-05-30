package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type codexBackendMetadata struct {
	threadID        string
	path            string
	messageCount    int
	estimatedTokens int
}

type codexBindingFile struct {
	ThreadID  string `json:"threadId"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
	Model     string `json:"model"`
	CWD       string `json:"cwd"`
}

type codexSessionLine struct {
	Timestamp string          `json:"timestamp"`
	Type      string          `json:"type"`
	Payload   json.RawMessage `json:"payload"`
}

type codexPayload struct {
	Type       string          `json:"type"`
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content"`
	Message    string          `json:"message"`
	Text       string          `json:"text"`
	Name       string          `json:"name"`
	CallID     string          `json:"call_id"`
	Input      json.RawMessage `json:"input"`
	Output     json.RawMessage `json:"output"`
	Result     json.RawMessage `json:"result"`
	Info       json.RawMessage `json:"info"`
	RateLimits json.RawMessage `json:"rate_limits"`
}

func loadCodexBackendMetadata(sessionPath string) codexBackendMetadata {
	binding, err := readCodexBinding(sessionPath + ".codex-app-server.json")
	if err != nil || strings.TrimSpace(binding.ThreadID) == "" {
		return codexBackendMetadata{}
	}
	backendPath := findCodexBackendSessionPath(sessionPath, binding.ThreadID)
	metadata := codexBackendMetadata{threadID: binding.ThreadID, path: backendPath}
	if backendPath == "" {
		return metadata
	}
	if info, err := os.Stat(backendPath); err == nil {
		metadata.estimatedTokens = estimateTokenCountFromBytes(info.Size())
	}
	if count, err := countCodexBackendRows(backendPath); err == nil {
		metadata.messageCount = count
	}
	return metadata
}

func readCodexBinding(path string) (codexBindingFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return codexBindingFile{}, err
	}
	var binding codexBindingFile
	if err := json.Unmarshal(data, &binding); err != nil {
		return codexBindingFile{}, err
	}
	return binding, nil
}

func findCodexBackendSessionPath(sessionPath, threadID string) string {
	if strings.TrimSpace(threadID) == "" {
		return ""
	}
	sessionsDir := filepath.Dir(sessionPath)
	agentDir := filepath.Dir(sessionsDir)
	codexSessionsDir := filepath.Join(agentDir, "agent", "codex-home", "sessions")
	pattern := filepath.Join(codexSessionsDir, "*", "*", "*", "*"+threadID+"*.jsonl")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) == 0 {
		return ""
	}
	return matches[0]
}

func countCodexBackendRows(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("open codex backend session %q: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 16*1024*1024)
	count := 0
	for scanner.Scan() {
		if len(bytes.TrimSpace(scanner.Bytes())) > 0 {
			count++
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, fmt.Errorf("scan codex backend session %q: %w", path, err)
	}
	return count, nil
}

func parseCodexBackendMessages(path string) ([]sessionMessage, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open codex backend session %q: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 16*1024*1024)

	messages := make([]sessionMessage, 0, 256)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var item codexSessionLine
		if err := json.Unmarshal(line, &item); err != nil {
			continue
		}
		msg, ok := normalizeCodexSessionLine(item, lineNumber)
		if ok {
			messages = append(messages, msg)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan codex backend session %q: %w", path, err)
	}
	return messages, nil
}

func normalizeCodexSessionLine(item codexSessionLine, lineNumber int) (sessionMessage, bool) {
	role := "system"
	text := ""
	switch item.Type {
	case "session_meta":
		text = summarizeCodexSessionMeta(item.Payload)
	case "turn_context":
		text = "[turn_context]\n" + compactJSON(item.Payload)
	case "compacted":
		text = "[compacted]\n" + compactJSON(item.Payload)
	case "response_item":
		var payload codexPayload
		if err := json.Unmarshal(item.Payload, &payload); err != nil {
			return sessionMessage{}, false
		}
		role, text = normalizeCodexResponseItem(payload)
	case "event_msg":
		var payload codexPayload
		if err := json.Unmarshal(item.Payload, &payload); err != nil {
			return sessionMessage{}, false
		}
		role, text = normalizeCodexEvent(payload)
	default:
		text = fmt.Sprintf("[%s]\n%s", item.Type, compactJSON(item.Payload))
	}
	if strings.TrimSpace(text) == "" {
		return sessionMessage{}, false
	}
	return sessionMessage{
		id:        fmt.Sprintf("codex:%d", lineNumber),
		timestamp: item.Timestamp,
		role:      role,
		text:      sanitizeForTerminal(text),
	}, true
}

func normalizeCodexResponseItem(payload codexPayload) (string, string) {
	switch payload.Type {
	case "message":
		role := strings.TrimSpace(payload.Role)
		if role == "" {
			role = "unknown"
		}
		return role, normalizeCodexContent(payload.Content)
	case "reasoning":
		return "reasoning", "[reasoning]\n" + compactJSON(payload.Content)
	case "custom_tool_call":
		name := firstNonEmpty(payload.Name, "unknown")
		return "tool", fmt.Sprintf("[toolCall] %s call_id=%s\n%s", name, payload.CallID, compactJSON(payload.Input))
	case "custom_tool_call_output":
		return "tool", fmt.Sprintf("[toolResult] call_id=%s\n%s", payload.CallID, firstNonEmpty(rawJSONText(payload.Output), rawJSONText(payload.Result), payload.Text))
	default:
		return "system", fmt.Sprintf("[response_item:%s]\n%s", payload.Type, compactJSONFromAny(payload))
	}
}

func normalizeCodexEvent(payload codexPayload) (string, string) {
	switch payload.Type {
	case "user_message":
		return "user", payload.Message
	case "agent_message":
		return "assistant", payload.Message
	case "token_count":
		return "system", "[token_count]\n" + firstNonEmpty(rawJSONText(payload.Info), compactJSONFromAny(payload))
	case "task_started", "task_complete", "turn_aborted", "context_compacted":
		return "system", fmt.Sprintf("[%s]\n%s", payload.Type, compactJSONFromAny(payload))
	case "error":
		return "system", "[error]\n" + compactJSONFromAny(payload)
	default:
		return "system", fmt.Sprintf("[event:%s]\n%s", payload.Type, compactJSONFromAny(payload))
	}
}

func summarizeCodexSessionMeta(raw json.RawMessage) string {
	var meta struct {
		ID            string `json:"id"`
		Timestamp     string `json:"timestamp"`
		CWD           string `json:"cwd"`
		Originator    string `json:"originator"`
		CLIVersion    string `json:"cli_version"`
		Source        string `json:"source"`
		ModelProvider string `json:"model_provider"`
	}
	if err := json.Unmarshal(raw, &meta); err != nil {
		return "[session_meta]\n" + compactJSON(raw)
	}
	return fmt.Sprintf("[session_meta]\nid=%s\ntimestamp=%s\ncwd=%s\noriginator=%s\ncli_version=%s\nsource=%s\nmodel_provider=%s",
		meta.ID, meta.Timestamp, meta.CWD, meta.Originator, meta.CLIVersion, meta.Source, meta.ModelProvider)
}

func normalizeCodexContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return strings.TrimSpace(asString)
	}
	var blocks []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if err := json.Unmarshal(raw, &blocks); err == nil {
		parts := make([]string, 0, len(blocks))
		for _, block := range blocks {
			if strings.TrimSpace(block.Text) != "" {
				parts = append(parts, strings.TrimSpace(block.Text))
			} else if block.Type != "" {
				parts = append(parts, "["+block.Type+"]")
			}
		}
		return strings.Join(parts, "\n")
	}
	return compactJSON(raw)
}

func compactJSON(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return strings.TrimSpace(string(raw))
	}
	return compactJSONFromAny(value)
}

func compactJSONFromAny(value any) string {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(data)
}

func rawJSONText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return asString
	}
	return compactJSON(raw)
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return strings.TrimSpace(value)
		}
	}
	return ""
}
