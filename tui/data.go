package main

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

// appDataPaths stores resolved locations for session files and the LCM DB.
type appDataPaths struct {
	agentsDir        string
	lcmDBPath        string
	openclawDir      string
	openclawConfig   string
	openclawEnv      string
	openclawCredsDir string
}

// agentEntry describes one agent directory under ~/.openclaw/agents.
type agentEntry struct {
	name string
	path string
}

// sessionEntry describes one JSONL session file.
type sessionEntry struct {
	id                   string
	sessionKey           string
	filename             string
	path                 string
	updatedAt            time.Time
	conversationID       int64
	messageCount         int
	estimatedTokens      int
	codexThreadID        string
	codexBackendPath     string
	codexMessageCount    int
	codexEstimatedTokens int
	summaryCount         int
	fileCount            int
}

// sessionFileEntry stores lightweight metadata used for incremental loading.
type sessionFileEntry struct {
	filename  string
	path      string
	updatedAt time.Time
	byteSize  int64
}

// sessionMessage is a normalized chat message used by the conversation viewer.
type sessionMessage struct {
	id        string
	parentID  string
	timestamp string
	role      string
	text      string
	messageID int64
}

// conversationWindowPage contains one keyset-paged window of conversation messages.
type conversationWindowPage struct {
	messages        []sessionMessage
	hasOlder        bool
	hasNewer        bool
	oldestMessageID int64
	newestMessageID int64
}

// summaryNode holds one summary record and its graph children.
type summaryNode struct {
	id         string
	kind       string
	depth      int
	content    string
	createdAt  string
	tokenCount int
	children   []string
	expanded   bool
}

// largeFileEntry describes one large file intercepted by LCM.
type largeFileEntry struct {
	fileID             string
	conversationID     int64
	fileName           string
	mimeType           string
	byteSize           int64
	storageURI         string
	explorationSummary string
	createdAt          string
}

func (f largeFileEntry) displayName() string {
	if f.fileName != "" {
		return f.fileName
	}
	return "(unnamed)"
}

// summarySource is a source message attached to a summary.
type summarySource struct {
	id        int64
	role      string
	content   string
	timestamp string
}

// contextItemEntry represents one item in the active LCM context window.
type contextItemEntry struct {
	ordinal                int
	itemType               string // "summary", "message", or "focus_brief"
	summaryID              string // set when itemType == "summary"
	messageID              int64  // set when itemType == "message"
	focusBriefID           string // set when itemType == "focus_brief"
	kind                   string // "leaf", "condensed", role for messages, or "active"
	depth                  int    // summary depth (0 for leaves, 1+ for condensed)
	tokenCount             int
	content                string // full sanitized content
	preview                string // single-line preview for list
	createdAt              string
	summaryLatestAt        string
	summaryMaxSourceSeq    int64
	hasSummaryMaxSourceSeq bool
}

// focusBriefEntry represents a generated focus brief for a conversation.
type focusBriefEntry struct {
	briefID               string
	conversationID        int64
	prompt                string
	content               string
	status                string
	tokenCount            int
	targetTokens          int
	createdAt             string
	updatedAt             string
	generatorRunID        string
	generatorSessionKey   string
	errorText             string
	coveredLatestAt       string
	coveredMessageSeq     int64
	hasCoveredMessageSeq  bool
	sourceContextHash     string
	truncated             bool
	postFocusMessageCount int
	postFocusSummaryCount int
	postFocusTokenCount   int
	sourceContextChanged  bool
	stale                 bool
	sourceCount           int
	citedCount            int
	expandedCount         int
	irrelevantCount       int
	citedSummaryIDs       []string
	expandedSummaryIDs    []string
	preview               string
}

// summaryGraph is the in-memory DAG used by the summary drill-down view.
type summaryGraph struct {
	conversationID int64
	roots          []string
	nodes          map[string]*summaryNode
}

// summaryRow is one visible row in the flattened summary tree.
type summaryRow struct {
	summaryID string
	depth     int
}

// contentBlock supports the JSONL message content block format.
type contentBlock struct {
	Type      string          `json:"type"`
	Text      string          `json:"text"`
	Name      string          `json:"name"`
	Arguments json.RawMessage `json:"arguments"`
	Reasoning string          `json:"reasoning"`
	Content   json.RawMessage `json:"content"`
}

// sessionLine is the top-level JSON object in each JSONL row.
type sessionLine struct {
	Type      string          `json:"type"`
	ID        string          `json:"id"`
	ParentID  string          `json:"parentId"`
	Timestamp string          `json:"timestamp"`
	Message   json.RawMessage `json:"message"`
}

// lineMessage is the nested message payload within a session line.
type lineMessage struct {
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	Timestamp any             `json:"timestamp"`
}

func resolveDataPaths() (appDataPaths, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return appDataPaths{}, fmt.Errorf("resolve home dir: %w", err)
	}
	base := filepath.Join(home, ".openclaw")
	return appDataPaths{
		agentsDir:        filepath.Join(base, "agents"),
		lcmDBPath:        filepath.Join(base, "lcm.db"),
		openclawDir:      base,
		openclawConfig:   filepath.Join(base, "openclaw.json"),
		openclawEnv:      filepath.Join(base, ".env"),
		openclawCredsDir: filepath.Join(base, "credentials"),
	}, nil
}

func loadAgents(agentsDir string) ([]agentEntry, error) {
	entries, err := os.ReadDir(agentsDir)
	if err != nil {
		return nil, fmt.Errorf("read agents dir %q: %w", agentsDir, err)
	}

	agents := make([]agentEntry, 0, len(entries))
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		agents = append(agents, agentEntry{
			name: entry.Name(),
			path: filepath.Join(agentsDir, entry.Name()),
		})
	}

	sort.Slice(agents, func(i, j int) bool {
		return strings.ToLower(agents[i].name) < strings.ToLower(agents[j].name)
	})
	return agents, nil
}

func discoverSessionFiles(agent agentEntry) ([]sessionFileEntry, error) {
	sessionsDir := filepath.Join(agent.path, "sessions")
	paths, err := filepath.Glob(filepath.Join(sessionsDir, "*.jsonl"))
	if err != nil {
		return nil, fmt.Errorf("glob sessions for agent %q: %w", agent.name, err)
	}

	sessionsByKey := make(map[string]sessionFileEntry, len(paths))
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			continue
		}
		filename := filepath.Base(path)
		entry := sessionFileEntry{
			filename:  filename,
			path:      path,
			updatedAt: info.ModTime(),
			byteSize:  info.Size(),
		}
		dedupKey := strings.TrimSuffix(filename, filepath.Ext(filename))
		if canonicalID, err := readSessionHeaderID(path); err == nil && canonicalID != "" {
			dedupKey = canonicalID
		}
		if existing, ok := sessionsByKey[dedupKey]; !ok || preferSessionFileEntry(entry, existing) {
			sessionsByKey[dedupKey] = entry
		}
	}

	sessions := make([]sessionFileEntry, 0, len(sessionsByKey))
	for _, entry := range sessionsByKey {
		sessions = append(sessions, entry)
	}

	sort.Slice(sessions, func(i, j int) bool {
		return sessions[i].updatedAt.After(sessions[j].updatedAt)
	})
	return sessions, nil
}

func readSessionHeaderID(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", fmt.Errorf("open session %q: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var header struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if err := json.Unmarshal(line, &header); err != nil {
			return "", fmt.Errorf("decode session header %q: %w", path, err)
		}
		if header.Type == "session" && strings.TrimSpace(header.ID) != "" {
			return strings.TrimSpace(header.ID), nil
		}
		return "", nil
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("scan session %q: %w", path, err)
	}
	return "", nil
}

func preferSessionFileEntry(candidate, existing sessionFileEntry) bool {
	candidateStem := strings.TrimSuffix(candidate.filename, filepath.Ext(candidate.filename))
	existingStem := strings.TrimSuffix(existing.filename, filepath.Ext(existing.filename))
	_, candidateIsTopic := trimTopicSessionSuffix(candidateStem)
	_, existingIsTopic := trimTopicSessionSuffix(existingStem)
	if candidateIsTopic != existingIsTopic {
		return candidateIsTopic
	}
	if !candidate.updatedAt.Equal(existing.updatedAt) {
		return candidate.updatedAt.After(existing.updatedAt)
	}
	if candidate.byteSize != existing.byteSize {
		return candidate.byteSize > existing.byteSize
	}
	return candidate.filename < existing.filename
}

func loadSessionBatch(files []sessionFileEntry, offset, limit int, lcmDBPath string) ([]sessionEntry, int, error) {
	if offset < 0 {
		offset = 0
	}
	if limit <= 0 {
		return nil, offset, nil
	}
	if offset >= len(files) {
		return nil, len(files), nil
	}

	end := offset + limit
	if end > len(files) {
		end = len(files)
	}

	sessions := make([]sessionEntry, 0, end-offset)
	sessionIDs := make([]string, 0, end-offset)
	for _, file := range files[offset:end] {
		messageCount, err := countMessages(file.path)
		if err != nil {
			messageCount = -1
		}
		id := strings.TrimSuffix(file.filename, filepath.Ext(file.filename))
		codexBackend := loadCodexBackendMetadata(file.path)
		sessionIDs = append(sessionIDs, id)
		sessions = append(sessions, sessionEntry{
			id:                   id,
			filename:             file.filename,
			path:                 file.path,
			updatedAt:            file.updatedAt,
			messageCount:         messageCount,
			estimatedTokens:      estimateTokenCountFromBytes(file.byteSize),
			codexThreadID:        codexBackend.threadID,
			codexBackendPath:     codexBackend.path,
			codexMessageCount:    codexBackend.messageCount,
			codexEstimatedTokens: codexBackend.estimatedTokens,
		})
	}

	conversationMetadata := loadConversationMetadata(lcmDBPath, sessionIDs)
	conversationIDs := make([]int64, 0, len(conversationMetadata))
	for _, metadata := range conversationMetadata {
		if metadata.conversationID > 0 {
			conversationIDs = append(conversationIDs, metadata.conversationID)
		}
	}
	summaryCounts := loadSummaryCounts(lcmDBPath, conversationIDs)
	fileCounts := loadFileCounts(lcmDBPath, conversationIDs)
	for i := range sessions {
		metadata := conversationMetadata[sessions[i].id]
		sessions[i].conversationID = metadata.conversationID
		sessions[i].sessionKey = metadata.sessionKey
		sessions[i].summaryCount = summaryCounts[metadata.conversationID]
		sessions[i].fileCount = fileCounts[metadata.conversationID]
	}

	return sessions, end, nil
}

func loadSessions(agent agentEntry, lcmDBPath string) ([]sessionEntry, error) {
	files, err := discoverSessionFiles(agent)
	if err != nil {
		return nil, err
	}
	sessions, _, err := loadSessionBatch(files, 0, len(files), lcmDBPath)
	if err != nil {
		return nil, err
	}
	return sessions, nil
}

// messageTypePattern matches `"type":"message"` or `"type": "message"` near the
// start of a JSONL line. This avoids full JSON unmarshal per line, which is
// critical for large session files (100MB+).
var messageTypePattern = []byte(`"type":"message"`)
var messageTypePatternSpaced = []byte(`"type": "message"`)

func countMessages(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		return 0, fmt.Errorf("open session %q: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 16*1024*1024)

	count := 0
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}
		// Fast path: check for "type":"message" pattern in the line bytes.
		// The "type" field is always near the start of JSONL session lines,
		// and "message" doesn't appear as a type value in nested content.
		if bytes.Contains(line, messageTypePattern) || bytes.Contains(line, messageTypePatternSpaced) {
			count++
		}
	}
	if err := scanner.Err(); err != nil {
		return 0, fmt.Errorf("scan session %q: %w", path, err)
	}
	return count, nil
}

// estimateTokenCountFromBytes applies a rough bytes/4 heuristic to estimate token count.
func estimateTokenCountFromBytes(byteCount int64) int {
	if byteCount <= 0 {
		return 0
	}
	return int(byteCount / 4)
}

func parseSessionMessages(path string) ([]sessionMessage, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open session %q: %w", path, err)
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	buf := make([]byte, 64*1024)
	scanner.Buffer(buf, 16*1024*1024)

	messages := make([]sessionMessage, 0, 256)
	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var item sessionLine
		if err := json.Unmarshal(line, &item); err != nil || item.Type != "message" {
			continue
		}

		var msg lineMessage
		if err := json.Unmarshal(item.Message, &msg); err != nil {
			continue
		}

		role := msg.Role
		if role == "" {
			role = "unknown"
		}
		messages = append(messages, sessionMessage{
			id:        item.ID,
			parentID:  item.ParentID,
			timestamp: pickTimestamp(item.Timestamp, msg.Timestamp),
			role:      role,
			text:      normalizeMessageContent(msg.Content),
			messageID: 0,
		})
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("scan session %q: %w", path, err)
	}
	return messages, nil
}

// loadLatestConversationWindow returns the newest fixed-size message window for a conversation.
func loadLatestConversationWindow(dbPath string, conversationID int64, limit int) (conversationWindowPage, error) {
	return loadConversationWindow(dbPath, conversationID, limit, "latest", 0)
}

// loadConversationWindowBefore returns the previous message window before a cursor message ID.
func loadConversationWindowBefore(dbPath string, conversationID, beforeMessageID int64, limit int) (conversationWindowPage, error) {
	return loadConversationWindow(dbPath, conversationID, limit, "before", beforeMessageID)
}

// loadConversationWindowAfter returns the next message window after a cursor message ID.
func loadConversationWindowAfter(dbPath string, conversationID, afterMessageID int64, limit int) (conversationWindowPage, error) {
	return loadConversationWindow(dbPath, conversationID, limit, "after", afterMessageID)
}

// messageDisplayContentSQL returns SQL that shows message_parts content when
// the canonical messages.content preview is empty.
func messageDisplayContentSQL(messageAlias string) string {
	return fmt.Sprintf(`
		CASE
			WHEN TRIM(COALESCE(%[1]s.content, '')) != '' THEN COALESCE(%[1]s.content, '')
			ELSE COALESCE((
				SELECT group_concat(part_text, char(10) || char(10))
				FROM (
					SELECT TRIM(
						COALESCE(mp.text_content, '') ||
						CASE
							WHEN TRIM(COALESCE(mp.tool_input, '')) != ''
								THEN char(10) || 'Tool input: ' || mp.tool_input
							ELSE ''
						END ||
						CASE
							WHEN TRIM(COALESCE(mp.tool_output, '')) != ''
								THEN char(10) || 'Tool output: ' || mp.tool_output
							ELSE ''
						END
					) AS part_text
					FROM message_parts mp
					WHERE mp.message_id = %[1]s.message_id
					ORDER BY mp.ordinal
				)
				WHERE TRIM(part_text) != ''
			), '')
		END`, messageAlias)
}

// loadConversationWindow executes one keyset-paged message query and computes paging boundaries.
func loadConversationWindow(dbPath string, conversationID int64, limit int, mode string, cursorMessageID int64) (conversationWindowPage, error) {
	if conversationID <= 0 {
		return conversationWindowPage{}, fmt.Errorf("conversation ID must be > 0")
	}
	if limit <= 0 {
		limit = 1
	}

	db, err := openLCMDB(dbPath)
	if err != nil {
		return conversationWindowPage{}, err
	}
	defer db.Close()

	baseQuery := fmt.Sprintf(`
		SELECT m.message_id, m.role, %s AS content, m.created_at
		FROM messages m
		WHERE m.conversation_id = ?
	`, messageDisplayContentSQL("m"))
	args := []any{conversationID}
	orderClause := "ORDER BY m.message_id ASC"
	reverse := false

	switch mode {
	case "latest":
		orderClause = "ORDER BY m.message_id DESC"
		reverse = true
	case "before":
		baseQuery += " AND m.message_id < ?"
		args = append(args, cursorMessageID)
		orderClause = "ORDER BY m.message_id DESC"
		reverse = true
	case "after":
		baseQuery += " AND m.message_id > ?"
		args = append(args, cursorMessageID)
	case "":
		return conversationWindowPage{}, fmt.Errorf("missing conversation window mode")
	default:
		return conversationWindowPage{}, fmt.Errorf("unknown conversation window mode %q", mode)
	}

	args = append(args, limit)
	query := baseQuery + "\n" + orderClause + "\nLIMIT ?"
	rows, err := db.Query(query, args...)
	if err != nil {
		return conversationWindowPage{}, fmt.Errorf("query conversation %d (%s window): %w", conversationID, mode, err)
	}
	defer rows.Close()

	page := conversationWindowPage{
		messages: make([]sessionMessage, 0, limit),
	}
	for rows.Next() {
		var msgID int64
		var role, content string
		var createdAt sql.NullString
		if err := rows.Scan(&msgID, &role, &content, &createdAt); err != nil {
			return conversationWindowPage{}, fmt.Errorf("scan conversation %d (%s window): %w", conversationID, mode, err)
		}
		if role == "" {
			role = "unknown"
		}
		page.messages = append(page.messages, sessionMessage{
			id:        strconv.FormatInt(msgID, 10),
			role:      role,
			timestamp: createdAt.String,
			text:      sanitizeForTerminal(content),
			messageID: msgID,
		})
	}
	if err := rows.Err(); err != nil {
		return conversationWindowPage{}, fmt.Errorf("iterate conversation %d (%s window): %w", conversationID, mode, err)
	}

	if reverse && len(page.messages) > 1 {
		for left, right := 0, len(page.messages)-1; left < right; left, right = left+1, right-1 {
			page.messages[left], page.messages[right] = page.messages[right], page.messages[left]
		}
	}
	if len(page.messages) == 0 {
		return computeEmptyConversationWindowPage(db, conversationID, mode, cursorMessageID)
	}

	page.oldestMessageID = page.messages[0].messageID
	page.newestMessageID = page.messages[len(page.messages)-1].messageID

	hasOlder, err := conversationMessageExistsBefore(db, conversationID, page.oldestMessageID)
	if err != nil {
		return conversationWindowPage{}, err
	}
	page.hasOlder = hasOlder

	hasNewer, err := conversationMessageExistsAfter(db, conversationID, page.newestMessageID)
	if err != nil {
		return conversationWindowPage{}, err
	}
	page.hasNewer = hasNewer
	return page, nil
}

// computeEmptyConversationWindowPage returns boundary flags when a window query yields no rows.
func computeEmptyConversationWindowPage(db *sql.DB, conversationID int64, mode string, cursorMessageID int64) (conversationWindowPage, error) {
	page := conversationWindowPage{}
	switch mode {
	case "before":
		hasNewer, err := conversationMessageExistsAfter(db, conversationID, cursorMessageID)
		if err != nil {
			return conversationWindowPage{}, err
		}
		page.hasNewer = hasNewer
	case "after":
		hasOlder, err := conversationMessageExistsBefore(db, conversationID, cursorMessageID)
		if err != nil {
			return conversationWindowPage{}, err
		}
		page.hasOlder = hasOlder
	}
	return page, nil
}

// conversationMessageExistsBefore checks whether any message has ID lower than the given boundary.
func conversationMessageExistsBefore(db *sql.DB, conversationID, boundaryMessageID int64) (bool, error) {
	var exists int
	if err := db.QueryRow(`
		SELECT CASE
			WHEN EXISTS (
				SELECT 1 FROM messages
				WHERE conversation_id = ? AND message_id < ?
			) THEN 1 ELSE 0
		END
	`, conversationID, boundaryMessageID).Scan(&exists); err != nil {
		return false, fmt.Errorf("query older messages for conversation %d: %w", conversationID, err)
	}
	return exists == 1, nil
}

// conversationMessageExistsAfter checks whether any message has ID higher than the given boundary.
func conversationMessageExistsAfter(db *sql.DB, conversationID, boundaryMessageID int64) (bool, error) {
	var exists int
	if err := db.QueryRow(`
		SELECT CASE
			WHEN EXISTS (
				SELECT 1 FROM messages
				WHERE conversation_id = ? AND message_id > ?
			) THEN 1 ELSE 0
		END
	`, conversationID, boundaryMessageID).Scan(&exists); err != nil {
		return false, fmt.Errorf("query newer messages for conversation %d: %w", conversationID, err)
	}
	return exists == 1, nil
}

func pickTimestamp(primary string, fallback any) string {
	if strings.TrimSpace(primary) != "" {
		return primary
	}
	switch v := fallback.(type) {
	case string:
		return v
	case float64:
		// JSON numbers decode as float64; the source uses epoch milliseconds.
		ms := int64(v)
		if ms <= 0 {
			return ""
		}
		return time.UnixMilli(ms).Local().Format(time.RFC3339Nano)
	default:
		return ""
	}
}

const maxDisplayBytes = 100_000 // truncate very long text content for display

// sanitizeForTerminal strips non-printable characters that corrupt terminal output.
// If more than 10% of the content is non-printable, it's treated as binary and replaced
// with a placeholder showing the byte count. Very long text is truncated.
func sanitizeForTerminal(s string) string {
	if len(s) == 0 {
		return s
	}
	nonPrintable := 0
	total := 0
	for _, r := range s {
		total++
		if r != '\n' && r != '\r' && r != '\t' && (r < 32 || r == 127 || (r >= 0x80 && r <= 0x9F)) {
			nonPrintable++
		}
	}
	if total > 0 && nonPrintable*10 > total {
		return fmt.Sprintf("[binary content, %s]", formatByteSizeCompact(int64(len(s))))
	}

	truncated := false
	if len(s) > maxDisplayBytes {
		// Truncate at a rune boundary
		count := 0
		for i := range s {
			if i >= maxDisplayBytes {
				s = s[:i]
				truncated = true
				break
			}
			count++
		}
	}

	// Strip individual non-printable characters
	var result string
	if nonPrintable == 0 {
		result = s
	} else {
		var b strings.Builder
		b.Grow(len(s))
		for _, r := range s {
			if r == '\n' || r == '\r' || r == '\t' || (r >= 32 && r != 127 && !(r >= 0x80 && r <= 0x9F)) {
				b.WriteRune(r)
			}
		}
		result = b.String()
	}
	if truncated {
		result += fmt.Sprintf("\n\n[truncated — full content is %s]", formatByteSizeCompact(int64(len(s))))
	}
	return result
}

func formatByteSizeCompact(bytes int64) string {
	if bytes < 1024 {
		return fmt.Sprintf("%d B", bytes)
	}
	if bytes < 1024*1024 {
		return fmt.Sprintf("%.1f KB", float64(bytes)/1024)
	}
	return fmt.Sprintf("%.1f MB", float64(bytes)/(1024*1024))
}

func normalizeMessageContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}

	var asString string
	if err := json.Unmarshal(raw, &asString); err == nil {
		return sanitizeForTerminal(strings.TrimSpace(asString))
	}

	var blocks []contentBlock
	if err := json.Unmarshal(raw, &blocks); err == nil {
		parts := make([]string, 0, len(blocks))
		for _, block := range blocks {
			part := formatContentBlock(block)
			if part != "" {
				parts = append(parts, part)
			}
		}
		if len(parts) > 0 {
			return sanitizeForTerminal(strings.Join(parts, "\n"))
		}
	}

	var asAny any
	if err := json.Unmarshal(raw, &asAny); err == nil {
		return sanitizeForTerminal(strings.TrimSpace(fmt.Sprintf("%v", asAny)))
	}
	return sanitizeForTerminal(strings.TrimSpace(string(raw)))
}

func formatContentBlock(block contentBlock) string {
	switch block.Type {
	case "text":
		return strings.TrimSpace(block.Text)
	case "thinking", "reasoning":
		if strings.TrimSpace(block.Text) != "" {
			return "[thinking] " + strings.TrimSpace(block.Text)
		}
		if strings.TrimSpace(block.Reasoning) != "" {
			return "[thinking] " + strings.TrimSpace(block.Reasoning)
		}
		return "[thinking]"
	case "toolCall":
		name := strings.TrimSpace(block.Name)
		if name == "" {
			name = "unknown"
		}
		args := strings.TrimSpace(string(block.Arguments))
		if args == "" || args == "null" {
			return fmt.Sprintf("[toolCall] %s", name)
		}
		return fmt.Sprintf("[toolCall] %s %s", name, args)
	case "toolResult":
		if strings.TrimSpace(block.Text) != "" {
			return "[toolResult] " + strings.TrimSpace(block.Text)
		}
		if len(block.Content) > 0 {
			nested := normalizeMessageContent(block.Content)
			if nested != "" {
				return "[toolResult] " + nested
			}
		}
		return "[toolResult]"
	default:
		if strings.TrimSpace(block.Text) != "" {
			return strings.TrimSpace(block.Text)
		}
		if len(block.Content) > 0 {
			nested := normalizeMessageContent(block.Content)
			if nested != "" {
				return nested
			}
		}
		if block.Type != "" {
			return "[" + block.Type + "]"
		}
		return ""
	}
}

func openLCMDB(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite db %q: %w", path, err)
	}
	// WAL mode + generous busy_timeout for concurrent access with gateway.
	db.Exec("PRAGMA journal_mode=WAL")
	db.Exec("PRAGMA busy_timeout=10000")
	return db, nil
}

func loadSummaryGraph(dbPath, sessionID string) (summaryGraph, error) {
	db, err := openLCMDB(dbPath)
	if err != nil {
		return summaryGraph{}, err
	}
	defer db.Close()

	conversationID, err := lookupConversationID(db, sessionID)
	if err != nil {
		return summaryGraph{}, err
	}

	nodes, err := loadSummaryNodes(db, conversationID)
	if err != nil {
		return summaryGraph{}, err
	}
	if len(nodes) == 0 {
		return summaryGraph{conversationID: conversationID, nodes: map[string]*summaryNode{}}, nil
	}

	childSet, err := populateSummaryChildren(db, conversationID, nodes)
	if err != nil {
		return summaryGraph{}, err
	}

	roots := findSummaryRoots(nodes, childSet)
	sortSummaryIDs(roots, nodes)
	for _, node := range nodes {
		sortSummaryIDs(node.children, nodes)
	}

	return summaryGraph{
		conversationID: conversationID,
		roots:          roots,
		nodes:          nodes,
	}, nil
}

func lookupConversationID(db *sql.DB, sessionID string) (int64, error) {
	// Check if the conversations table exists (fresh install / LCM not yet initialized)
	var tableExists int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = 'conversations'
	`).Scan(&tableExists); err != nil {
		return 0, fmt.Errorf("check LCM schema: %w", err)
	}
	if tableExists == 0 {
		return 0, fmt.Errorf("LCM database has no tables yet — start a conversation first so the plugin can initialize the schema")
	}

	metadata := loadConversationMetadataFromDB(db, []string{sessionID})
	if metadata[sessionID].conversationID == 0 {
		return 0, fmt.Errorf("no LCM conversation found for session %q", sessionID)
	}
	return metadata[sessionID].conversationID, nil
}

func loadSummaryNodes(db *sql.DB, conversationID int64) (map[string]*summaryNode, error) {
	rows, err := db.Query(`
		SELECT summary_id, kind, COALESCE(depth, 0), content, created_at, token_count
		FROM summaries
		WHERE conversation_id = ?
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("query summaries for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	nodes := make(map[string]*summaryNode)
	for rows.Next() {
		var node summaryNode
		if err := rows.Scan(&node.id, &node.kind, &node.depth, &node.content, &node.createdAt, &node.tokenCount); err != nil {
			return nil, fmt.Errorf("scan summary row: %w", err)
		}
		node.content = sanitizeForTerminal(node.content)
		nodes[node.id] = &node
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate summary rows: %w", err)
	}
	return nodes, nil
}

func populateSummaryChildren(db *sql.DB, conversationID int64, nodes map[string]*summaryNode) (map[string]bool, error) {
	rows, err := db.Query(`
		SELECT sp.parent_summary_id, sp.summary_id
		FROM summary_parents sp
		JOIN summaries s ON s.summary_id = sp.summary_id
		WHERE s.conversation_id = ?
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("query summary edges for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	childSet := make(map[string]bool)
	for rows.Next() {
		var sourceID, derivedID string
		if err := rows.Scan(&sourceID, &derivedID); err != nil {
			return nil, fmt.Errorf("scan summary edge: %w", err)
		}
		// DB stores (parent=source, summary=derived). For the TUI tree,
		// the derived (condensed) summary is the parent and sources are children.
		derivedNode, hasDerived := nodes[derivedID]
		_, hasSource := nodes[sourceID]
		if hasDerived && hasSource {
			derivedNode.children = append(derivedNode.children, sourceID)
			childSet[sourceID] = true
		}
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate summary edges: %w", err)
	}
	return childSet, nil
}

func findSummaryRoots(nodes map[string]*summaryNode, childSet map[string]bool) []string {
	roots := make([]string, 0, len(nodes))
	for id := range nodes {
		if !childSet[id] {
			roots = append(roots, id)
		}
	}
	if len(roots) == 0 {
		for id := range nodes {
			roots = append(roots, id)
		}
	}
	return roots
}

func sortSummaryIDs(ids []string, nodes map[string]*summaryNode) {
	sort.Slice(ids, func(i, j int) bool {
		left := nodes[ids[i]]
		right := nodes[ids[j]]
		if left == nil || right == nil {
			return ids[i] < ids[j]
		}
		if left.createdAt == right.createdAt {
			return left.id < right.id
		}
		return left.createdAt < right.createdAt
	})
}

func loadSummarySources(dbPath, summaryID string) ([]summarySource, error) {
	db, err := openLCMDB(dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	rows, err := db.Query(`
		SELECT m.message_id, m.role, m.content, m.created_at
		FROM summary_messages sm
		JOIN messages m ON m.message_id = sm.message_id
		WHERE sm.summary_id = ?
		ORDER BY sm.ordinal ASC
	`, summaryID)
	if err != nil {
		return nil, fmt.Errorf("query summary sources for %q: %w", summaryID, err)
	}
	defer rows.Close()

	sources := make([]summarySource, 0, 8)
	for rows.Next() {
		var src summarySource
		if err := rows.Scan(&src.id, &src.role, &src.content, &src.timestamp); err != nil {
			return nil, fmt.Errorf("scan summary source row: %w", err)
		}
		src.content = sanitizeForTerminal(src.content)
		sources = append(sources, src)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate summary source rows: %w", err)
	}
	return sources, nil
}

func loadSummaryCounts(dbPath string, conversationIDs []int64) map[int64]int {
	counts := make(map[int64]int, len(conversationIDs))
	if len(conversationIDs) == 0 {
		return counts
	}
	db, err := openLCMDB(dbPath)
	if err != nil {
		return counts
	}
	defer db.Close()

	placeholders := make([]string, len(conversationIDs))
	args := make([]any, len(conversationIDs))
	for i, id := range conversationIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	query := fmt.Sprintf(`
		SELECT s.conversation_id, COUNT(s.summary_id)
		FROM summaries s
		WHERE s.conversation_id IN (%s)
		GROUP BY s.conversation_id
	`, strings.Join(placeholders, ","))

	rows, err := db.Query(query, args...)
	if err != nil {
		return counts
	}
	defer rows.Close()

	for rows.Next() {
		var conversationID int64
		var count int
		if err := rows.Scan(&conversationID, &count); err != nil {
			continue
		}
		counts[conversationID] = count
	}
	return counts
}

func loadLargeFiles(dbPath, sessionID string) ([]largeFileEntry, error) {
	db, err := openLCMDB(dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	conversationID, err := lookupConversationID(db, sessionID)
	if err != nil {
		return nil, err
	}

	rows, err := db.Query(`
		SELECT file_id, conversation_id, file_name, mime_type, byte_size, storage_uri, exploration_summary, created_at
		FROM large_files
		WHERE conversation_id = ?
		ORDER BY created_at ASC
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("query large files for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	files := make([]largeFileEntry, 0, 8)
	for rows.Next() {
		var f largeFileEntry
		var fileName, mimeType, explorationSummary sql.NullString
		var byteSize sql.NullInt64
		if err := rows.Scan(&f.fileID, &f.conversationID, &fileName, &mimeType, &byteSize, &f.storageURI, &explorationSummary, &f.createdAt); err != nil {
			return nil, fmt.Errorf("scan large file row: %w", err)
		}
		f.fileName = fileName.String
		f.mimeType = mimeType.String
		f.byteSize = byteSize.Int64
		f.explorationSummary = sanitizeForTerminal(explorationSummary.String)
		files = append(files, f)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate large file rows: %w", err)
	}
	return files, nil
}

func loadFileCounts(dbPath string, conversationIDs []int64) map[int64]int {
	counts := make(map[int64]int, len(conversationIDs))
	if len(conversationIDs) == 0 {
		return counts
	}
	db, err := openLCMDB(dbPath)
	if err != nil {
		return counts
	}
	defer db.Close()

	placeholders := make([]string, len(conversationIDs))
	args := make([]any, len(conversationIDs))
	for i, id := range conversationIDs {
		placeholders[i] = "?"
		args[i] = id
	}
	query := fmt.Sprintf(`
		SELECT lf.conversation_id, COUNT(lf.file_id)
		FROM large_files lf
		WHERE lf.conversation_id IN (%s)
		GROUP BY lf.conversation_id
	`, strings.Join(placeholders, ","))

	rows, err := db.Query(query, args...)
	if err != nil {
		return counts
	}
	defer rows.Close()

	for rows.Next() {
		var conversationID int64
		var count int
		if err := rows.Scan(&conversationID, &count); err != nil {
			continue
		}
		counts[conversationID] = count
	}
	return counts
}

type conversationMetadata struct {
	conversationID int64
	sessionKey     string
}

// sessionLookupKey preserves the on-disk session filename while also tracking
// the normalized DB lookup keys used for topic-backed Telegram sessions.
type sessionLookupKey struct {
	requestedSessionID  string
	normalizedSessionID string
	exactSessionKey     string
}

func loadConversationMetadata(dbPath string, sessionIDs []string) map[string]conversationMetadata {
	// Resolve the latest LCM conversation metadata per session for list/header display.
	metadata := make(map[string]conversationMetadata, len(sessionIDs))
	if len(sessionIDs) == 0 {
		return metadata
	}
	db, err := openLCMDB(dbPath)
	if err != nil {
		return metadata
	}
	defer db.Close()

	return loadConversationMetadataFromDB(db, sessionIDs)
}

func loadConversationMetadataFromDB(db *sql.DB, sessionIDs []string) map[string]conversationMetadata {
	metadata := make(map[string]conversationMetadata, len(sessionIDs))
	if len(sessionIDs) == 0 {
		return metadata
	}

	lookups := buildSessionLookupKeys(sessionIDs)
	sessionIDPlaceholders := make([]string, 0, len(lookups))
	sessionIDArgs := make([]any, 0, len(lookups))
	sessionKeyPlaceholders := make([]string, 0, len(lookups))
	sessionKeyArgs := make([]any, 0, len(lookups))
	for _, lookup := range lookups {
		sessionIDPlaceholders = append(sessionIDPlaceholders, "?")
		sessionIDArgs = append(sessionIDArgs, lookup.normalizedSessionID)
		if lookup.exactSessionKey != "" {
			sessionKeyPlaceholders = append(sessionKeyPlaceholders, "?")
			sessionKeyArgs = append(sessionKeyArgs, lookup.exactSessionKey)
		}
	}

	whereParts := make([]string, 0, 2)
	args := make([]any, 0, len(sessionKeyArgs)+len(sessionIDArgs))
	if len(sessionKeyPlaceholders) > 0 {
		whereParts = append(whereParts, fmt.Sprintf("session_key IN (%s)", strings.Join(sessionKeyPlaceholders, ",")))
		args = append(args, sessionKeyArgs...)
	}
	if len(sessionIDPlaceholders) > 0 {
		whereParts = append(whereParts, fmt.Sprintf("session_id IN (%s)", strings.Join(sessionIDPlaceholders, ",")))
		args = append(args, sessionIDArgs...)
	}
	if len(whereParts) == 0 {
		return metadata
	}

	query := fmt.Sprintf(`
		SELECT conversation_id, session_id, session_key
		FROM conversations
		WHERE %s
		ORDER BY conversation_id DESC
	`, strings.Join(whereParts, " OR "))

	rows, err := db.Query(query, args...)
	if err != nil {
		return metadata
	}
	defer rows.Close()

	bySessionKey := make(map[string]conversationMetadata, len(lookups))
	bySessionID := make(map[string]conversationMetadata, len(lookups))
	for rows.Next() {
		var conversationID int64
		var sessionID string
		var sessionKey sql.NullString
		if err := rows.Scan(&conversationID, &sessionID, &sessionKey); err != nil {
			continue
		}
		row := conversationMetadata{
			conversationID: conversationID,
			sessionKey:     sessionKey.String,
		}
		if row.sessionKey != "" {
			if _, exists := bySessionKey[row.sessionKey]; !exists {
				bySessionKey[row.sessionKey] = row
			}
		}
		if _, exists := bySessionID[sessionID]; !exists {
			bySessionID[sessionID] = row
		}
	}

	for _, lookup := range lookups {
		if lookup.exactSessionKey != "" {
			if row, ok := bySessionKey[lookup.exactSessionKey]; ok {
				metadata[lookup.requestedSessionID] = row
				continue
			}
		}
		if row, ok := bySessionID[lookup.normalizedSessionID]; ok {
			metadata[lookup.requestedSessionID] = row
		}
	}
	return metadata
}

func buildSessionLookupKeys(sessionIDs []string) []sessionLookupKey {
	lookups := make([]sessionLookupKey, 0, len(sessionIDs))
	seen := make(map[string]bool, len(sessionIDs))
	for _, sessionID := range sessionIDs {
		if seen[sessionID] {
			continue
		}
		seen[sessionID] = true
		normalizedSessionID, exactSessionKey := normalizeSessionLookupID(sessionID)
		lookups = append(lookups, sessionLookupKey{
			requestedSessionID:  sessionID,
			normalizedSessionID: normalizedSessionID,
			exactSessionKey:     exactSessionKey,
		})
	}
	return lookups
}

// normalizeSessionLookupID keeps non-topic sessions unchanged, but for
// <session-id>-topic-<n> files it falls back to the bare session_id while still
// preserving the full topic suffix for exact session_key matches.
func normalizeSessionLookupID(sessionID string) (normalizedSessionID, exactSessionKey string) {
	if baseSessionID, ok := trimTopicSessionSuffix(sessionID); ok {
		return baseSessionID, sessionID
	}
	return sessionID, ""
}

// trimTopicSessionSuffix recognizes the topic session filenames written by the
// Telegram adapter so TUI DB lookups can normalize them deterministically.
func trimTopicSessionSuffix(sessionID string) (string, bool) {
	const topicMarker = "-topic-"
	idx := strings.LastIndex(sessionID, topicMarker)
	if idx <= 0 {
		return "", false
	}
	topicSuffix := sessionID[idx+len(topicMarker):]
	if topicSuffix == "" {
		return "", false
	}
	for _, r := range topicSuffix {
		if r < '0' || r > '9' {
			return "", false
		}
	}
	return sessionID[:idx], true
}

func loadContextItems(dbPath, sessionID string) ([]contextItemEntry, error) {
	db, err := openLCMDB(dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	conversationID, err := lookupConversationID(db, sessionID)
	if err != nil {
		return nil, err
	}
	summaryLatestAtExpr := "''"
	if hasLatestAt, err := sqliteColumnExists(db, "summaries", "latest_at"); err != nil {
		return nil, fmt.Errorf("check summaries.latest_at schema: %w", err)
	} else if hasLatestAt {
		summaryLatestAtExpr = "COALESCE(s.latest_at, '')"
	}

	rows, err := db.Query(fmt.Sprintf(`
		SELECT
			ci.ordinal,
			ci.item_type,
			ci.summary_id,
			ci.message_id,
			CASE
				WHEN ci.item_type = 'summary' THEN COALESCE(s.kind, '')
				ELSE COALESCE(m.role, '')
			END AS kind,
			CASE
				WHEN ci.item_type = 'summary' THEN COALESCE(s.depth, 0)
				ELSE 0
			END AS depth,
			CASE
				WHEN ci.item_type = 'summary' THEN COALESCE(s.token_count, 0)
				ELSE COALESCE(m.token_count, 0)
			END AS token_count,
			CASE
				WHEN ci.item_type = 'summary' THEN COALESCE(s.content, '')
				ELSE %s
			END AS content,
			CASE
				WHEN ci.item_type = 'summary' THEN COALESCE(s.created_at, '')
				ELSE COALESCE(m.created_at, '')
			END AS created_at,
			CASE
				WHEN ci.item_type = 'summary' THEN %s
				ELSE ''
			END AS latest_at
		FROM context_items ci
		LEFT JOIN summaries s ON ci.summary_id = s.summary_id
		LEFT JOIN messages m ON ci.message_id = m.message_id
		WHERE ci.conversation_id = ?
		ORDER BY ci.ordinal
	`, messageDisplayContentSQL("m"), summaryLatestAtExpr), conversationID)
	if err != nil {
		return nil, fmt.Errorf("query context items for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	var items []contextItemEntry
	for rows.Next() {
		var item contextItemEntry
		var summaryID sql.NullString
		var messageID sql.NullInt64
		var content string
		if err := rows.Scan(
			&item.ordinal,
			&item.itemType,
			&summaryID,
			&messageID,
			&item.kind,
			&item.depth,
			&item.tokenCount,
			&content,
			&item.createdAt,
			&item.summaryLatestAt,
		); err != nil {
			return nil, fmt.Errorf("scan context item: %w", err)
		}
		if summaryID.Valid {
			item.summaryID = summaryID.String
			if err := populateContextSummarySourceSeq(db, &item); err != nil {
				return nil, err
			}
		}
		if messageID.Valid {
			item.messageID = messageID.Int64
		}
		content = sanitizeForTerminal(content)
		item.content = content
		item.preview = oneLine(content)
		items = append(items, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate context items: %w", err)
	}
	brief, err := loadActiveFocusBriefForConversation(db, conversationID)
	if err != nil {
		return nil, err
	}
	return applyFocusOverlayToContextItems(items, brief), nil
}

// populateContextSummarySourceSeq mirrors the runtime focus coverage lookup.
func populateContextSummarySourceSeq(db *sql.DB, item *contextItemEntry) error {
	if item.summaryID == "" {
		return nil
	}
	exists, err := sqliteTableExists(db, "summary_parents")
	if err != nil {
		return fmt.Errorf("check summary_parents schema for context item %s: %w", item.summaryID, err)
	}
	if !exists {
		return nil
	}
	exists, err = sqliteTableExists(db, "summary_messages")
	if err != nil {
		return fmt.Errorf("check summary_messages schema for context item %s: %w", item.summaryID, err)
	}
	if !exists {
		return nil
	}
	exists, err = sqliteTableExists(db, "messages")
	if err != nil {
		return fmt.Errorf("check messages schema for context item %s: %w", item.summaryID, err)
	}
	if !exists {
		return nil
	}
	var maxSeq sql.NullInt64
	if err := db.QueryRow(`
		WITH RECURSIVE source_summaries(summary_id) AS (
			SELECT ?
			UNION
			SELECT sp.parent_summary_id
			FROM summary_parents sp
			JOIN source_summaries source ON source.summary_id = sp.summary_id
		)
		SELECT MAX(m.seq) AS max_seq
		FROM source_summaries source
		JOIN summary_messages sm ON sm.summary_id = source.summary_id
		JOIN messages m ON m.message_id = sm.message_id
	`, item.summaryID).Scan(&maxSeq); err != nil {
		return fmt.Errorf("query context summary source seq for %s: %w", item.summaryID, err)
	}
	if maxSeq.Valid {
		item.summaryMaxSourceSeq = maxSeq.Int64
		item.hasSummaryMaxSourceSeq = true
	}
	return nil
}

// loadActiveFocusBriefForConversation returns the active focus overlay metadata.
func loadActiveFocusBriefForConversation(db *sql.DB, conversationID int64) (*focusBriefEntry, error) {
	exists, err := sqliteTableExists(db, "focus_briefs")
	if err != nil {
		return nil, fmt.Errorf("check focus brief schema: %w", err)
	}
	if !exists {
		return nil, nil
	}
	var brief focusBriefEntry
	var coveredLatestAt sql.NullString
	var coveredMessageSeq sql.NullInt64
	err = db.QueryRow(`
		SELECT
			brief_id,
			conversation_id,
			COALESCE(prompt, ''),
			COALESCE(content, ''),
			COALESCE(status, ''),
			COALESCE(token_count, 0),
			COALESCE(target_tokens, 0),
			covered_latest_at,
			covered_message_seq,
			COALESCE(created_at, '')
		FROM focus_briefs
		WHERE conversation_id = ?
		  AND status = 'active'
		  AND TRIM(COALESCE(content, '')) != ''
		ORDER BY created_at DESC, rowid DESC
		LIMIT 1
	`, conversationID).Scan(
		&brief.briefID,
		&brief.conversationID,
		&brief.prompt,
		&brief.content,
		&brief.status,
		&brief.tokenCount,
		&brief.targetTokens,
		&coveredLatestAt,
		&coveredMessageSeq,
		&brief.createdAt,
	)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("query active focus brief for conversation %d: %w", conversationID, err)
	}
	brief.content = sanitizeForTerminal(brief.content)
	brief.prompt = sanitizeForTerminal(brief.prompt)
	if coveredLatestAt.Valid {
		brief.coveredLatestAt = coveredLatestAt.String
	}
	if coveredMessageSeq.Valid {
		brief.coveredMessageSeq = coveredMessageSeq.Int64
		brief.hasCoveredMessageSeq = true
	}
	return &brief, nil
}

// applyFocusOverlayToContextItems mirrors ContextAssembler.applyFocusOverlay.
func applyFocusOverlayToContextItems(items []contextItemEntry, brief *focusBriefEntry) []contextItemEntry {
	if brief == nil || strings.TrimSpace(brief.content) == "" {
		return items
	}

	covered := make([]bool, len(items))
	firstCoveredOrdinal := 0
	foundCovered := false
	for idx := range items {
		if !contextSummaryCoveredByFocus(items[idx], brief) {
			continue
		}
		covered[idx] = true
		if !foundCovered || items[idx].ordinal < firstCoveredOrdinal {
			firstCoveredOrdinal = items[idx].ordinal
		}
		foundCovered = true
	}
	if !foundCovered {
		return items
	}

	focusContent := formatFocusBriefContextContent(brief)
	focusItem := contextItemEntry{
		ordinal:      firstCoveredOrdinal,
		itemType:     "focus_brief",
		focusBriefID: brief.briefID,
		kind:         "active",
		tokenCount:   estimateTokenCount(focusContent),
		content:      sanitizeForTerminal(focusContent),
		createdAt:    brief.createdAt,
	}
	focusItem.preview = oneLine(focusItem.content)

	output := make([]contextItemEntry, 0, len(items)-countCoveredContextItems(covered)+1)
	inserted := false
	for idx, item := range items {
		if covered[idx] {
			continue
		}
		if !inserted && item.ordinal > firstCoveredOrdinal {
			output = append(output, focusItem)
			inserted = true
		}
		output = append(output, item)
	}
	if !inserted {
		output = append(output, focusItem)
	}
	return output
}

func contextSummaryCoveredByFocus(item contextItemEntry, brief *focusBriefEntry) bool {
	if item.itemType != "summary" {
		return false
	}
	if brief.hasCoveredMessageSeq && item.hasSummaryMaxSourceSeq {
		return item.summaryMaxSourceSeq <= brief.coveredMessageSeq
	}
	if strings.TrimSpace(brief.coveredLatestAt) == "" || strings.TrimSpace(item.summaryLatestAt) == "" {
		return false
	}
	return compareSQLiteTimes(item.summaryLatestAt, brief.coveredLatestAt) <= 0
}

func compareSQLiteTimes(left, right string) int {
	leftTime, leftOK := parseContextItemTime(left)
	rightTime, rightOK := parseContextItemTime(right)
	if leftOK && rightOK {
		if leftTime.Before(rightTime) {
			return -1
		}
		if leftTime.After(rightTime) {
			return 1
		}
		return 0
	}
	return strings.Compare(strings.TrimSpace(left), strings.TrimSpace(right))
}

func parseContextItemTime(value string) (time.Time, bool) {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return time.Time{}, false
	}
	if parsed, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
		return parsed, true
	}
	if parsed, err := time.Parse("2006-01-02 15:04:05", trimmed); err == nil {
		return parsed, true
	}
	return time.Time{}, false
}

func formatFocusBriefContextContent(brief *focusBriefEntry) string {
	attrs := []string{
		fmt.Sprintf(`id="%s"`, escapeXMLAttribute(brief.briefID)),
		fmt.Sprintf(`prompt="%s"`, escapeXMLAttribute(brief.prompt)),
		fmt.Sprintf(`token_count="%d"`, brief.tokenCount),
		fmt.Sprintf(`target_tokens="%d"`, brief.targetTokens),
		fmt.Sprintf(`created_at="%s"`, escapeXMLAttribute(brief.createdAt)),
	}
	if strings.TrimSpace(brief.coveredLatestAt) != "" {
		attrs = append(attrs, fmt.Sprintf(`covered_latest_at="%s"`, escapeXMLAttribute(brief.coveredLatestAt)))
	}
	if brief.hasCoveredMessageSeq {
		attrs = append(attrs, fmt.Sprintf(`covered_message_seq="%d"`, brief.coveredMessageSeq))
	}
	return strings.Join([]string{
		fmt.Sprintf("<focus_brief %s>", strings.Join(attrs, " ")),
		"  <content>",
		brief.content,
		"  </content>",
		"</focus_brief>",
	}, "\n")
}

func escapeXMLAttribute(value string) string {
	replacer := strings.NewReplacer(
		"&", "&amp;",
		`"`, "&quot;",
		"<", "&lt;",
		">", "&gt;",
	)
	return replacer.Replace(value)
}

func countCoveredContextItems(covered []bool) int {
	count := 0
	for _, value := range covered {
		if value {
			count++
		}
	}
	return count
}

// sqliteTableExists checks optional feature tables without treating older DBs as broken.
func sqliteTableExists(db *sql.DB, tableName string) (bool, error) {
	var count int
	if err := db.QueryRow(`
		SELECT COUNT(*) FROM sqlite_master
		WHERE type = 'table' AND name = ?
	`, tableName).Scan(&count); err != nil {
		return false, err
	}
	return count > 0, nil
}

// sqliteColumnExists checks optional columns across historical LCM schemas.
func sqliteColumnExists(db *sql.DB, tableName, columnName string) (bool, error) {
	rows, err := db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, tableName))
	if err != nil {
		return false, err
	}
	defer rows.Close()

	for rows.Next() {
		var cid int
		var name string
		var columnType string
		var notNull int
		var defaultValue sql.NullString
		var pk int
		if err := rows.Scan(&cid, &name, &columnType, &notNull, &defaultValue, &pk); err != nil {
			return false, err
		}
		if name == columnName {
			return true, nil
		}
	}
	if err := rows.Err(); err != nil {
		return false, err
	}
	return false, nil
}

// loadFocusBriefs returns persisted focus briefs for the selected LCM conversation.
func loadFocusBriefs(dbPath, sessionID string) ([]focusBriefEntry, error) {
	db, err := openLCMDB(dbPath)
	if err != nil {
		return nil, err
	}
	defer db.Close()

	conversationID, err := lookupConversationID(db, sessionID)
	if err != nil {
		return nil, err
	}

	exists, err := sqliteTableExists(db, "focus_briefs")
	if err != nil {
		return nil, fmt.Errorf("check focus brief schema: %w", err)
	}
	if !exists {
		return nil, nil
	}

	rows, err := db.Query(`
		SELECT
			brief_id,
			conversation_id,
			COALESCE(prompt, ''),
			COALESCE(content, ''),
			COALESCE(status, ''),
			COALESCE(token_count, 0),
			COALESCE(target_tokens, 0),
			covered_latest_at,
			covered_message_seq,
			COALESCE(source_context_hash, ''),
			COALESCE(raw_result_json, ''),
			COALESCE(created_at, ''),
			COALESCE(updated_at, ''),
			COALESCE(generator_run_id, ''),
			COALESCE(generator_session_key, ''),
			COALESCE(error, '')
		FROM focus_briefs
		WHERE conversation_id = ?
		ORDER BY created_at DESC, rowid DESC
	`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("query focus briefs for conversation %d: %w", conversationID, err)
	}
	defer rows.Close()

	briefs := make([]focusBriefEntry, 0)
	for rows.Next() {
		var brief focusBriefEntry
		var coveredLatestAt sql.NullString
		var coveredMessageSeq sql.NullInt64
		var rawResultJSON string
		if err := rows.Scan(
			&brief.briefID,
			&brief.conversationID,
			&brief.prompt,
			&brief.content,
			&brief.status,
			&brief.tokenCount,
			&brief.targetTokens,
			&coveredLatestAt,
			&coveredMessageSeq,
			&brief.sourceContextHash,
			&rawResultJSON,
			&brief.createdAt,
			&brief.updatedAt,
			&brief.generatorRunID,
			&brief.generatorSessionKey,
			&brief.errorText,
		); err != nil {
			return nil, fmt.Errorf("scan focus brief: %w", err)
		}
		brief.content = sanitizeForTerminal(brief.content)
		brief.prompt = sanitizeForTerminal(brief.prompt)
		brief.errorText = sanitizeForTerminal(brief.errorText)
		if coveredLatestAt.Valid {
			brief.coveredLatestAt = coveredLatestAt.String
		}
		if coveredMessageSeq.Valid {
			brief.coveredMessageSeq = coveredMessageSeq.Int64
			brief.hasCoveredMessageSeq = true
		}
		brief.truncated = focusBriefRawTruncated(rawResultJSON)
		brief.preview = oneLine(brief.content)
		if err := populateFocusBriefSourceStats(db, &brief); err != nil {
			return nil, err
		}
		if err := populateFocusBriefDiagnostics(db, &brief); err != nil {
			return nil, err
		}
		briefs = append(briefs, brief)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate focus briefs: %w", err)
	}
	return briefs, nil
}

// loadActiveFocusBrief returns the active focus overlay for a session, if any.
func loadActiveFocusBrief(dbPath, sessionID string) (*focusBriefEntry, error) {
	briefs, err := loadFocusBriefs(dbPath, sessionID)
	if err != nil {
		return nil, err
	}
	for idx := range briefs {
		if briefs[idx].status == "active" {
			brief := briefs[idx]
			return &brief, nil
		}
	}
	return nil, nil
}

// focusBriefRawTruncated reads the generator's truncation marker from raw JSON.
func focusBriefRawTruncated(raw string) bool {
	var parsed struct {
		Truncated bool `json:"truncated"`
	}
	if strings.TrimSpace(raw) == "" {
		return false
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return false
	}
	return parsed.Truncated
}

// populateFocusBriefDiagnostics adds post-focus drift and source freshness state.
func populateFocusBriefDiagnostics(db *sql.DB, brief *focusBriefEntry) error {
	if brief.hasCoveredMessageSeq {
		exists, err := sqliteTableExists(db, "messages")
		if err != nil {
			return fmt.Errorf("check messages schema for focus diagnostics: %w", err)
		}
		if exists {
			if err := db.QueryRow(`
				SELECT COUNT(*), COALESCE(SUM(token_count), 0)
				FROM messages
				WHERE conversation_id = ?
				  AND seq > ?
			`, brief.conversationID, brief.coveredMessageSeq).Scan(
				&brief.postFocusMessageCount,
				&brief.postFocusTokenCount,
			); err != nil {
				return fmt.Errorf("query post-focus messages for %s: %w", brief.briefID, err)
			}
		}
	}

	summaryWatermark := strings.TrimSpace(brief.coveredLatestAt)
	summaryPredicate := "datetime(created_at) > datetime(?)"
	if summaryWatermark == "" {
		summaryWatermark = strings.TrimSpace(brief.createdAt)
	} else {
		summaryPredicate = "latest_at IS NOT NULL AND datetime(latest_at) > datetime(?)"
	}
	if summaryWatermark != "" {
		exists, err := sqliteTableExists(db, "summaries")
		if err != nil {
			return fmt.Errorf("check summaries schema for focus diagnostics: %w", err)
		}
		if exists {
			var summaryTokens int
			query := fmt.Sprintf(`
				SELECT COUNT(*), COALESCE(SUM(token_count), 0)
				FROM summaries
				WHERE conversation_id = ?
				  AND %s
			`, summaryPredicate)
			if err := db.QueryRow(query, brief.conversationID, summaryWatermark).Scan(
				&brief.postFocusSummaryCount,
				&summaryTokens,
			); err != nil {
				return fmt.Errorf("query post-focus summaries for %s: %w", brief.briefID, err)
			}
			brief.postFocusTokenCount += summaryTokens
		}
	}

	activeHash, err := activeFocusSourceContextHash(db, brief.conversationID)
	if err != nil {
		return err
	}
	brief.sourceContextChanged = strings.TrimSpace(brief.sourceContextHash) != "" &&
		activeHash != "" &&
		activeHash != brief.sourceContextHash
	brief.stale = brief.postFocusMessageCount > 0 ||
		brief.postFocusSummaryCount > 0 ||
		brief.sourceContextChanged
	return nil
}

// activeFocusSourceContextHash mirrors the runtime focus source fingerprint.
func activeFocusSourceContextHash(db *sql.DB, conversationID int64) (string, error) {
	contextExists, err := sqliteTableExists(db, "context_items")
	if err != nil {
		return "", fmt.Errorf("check context schema for focus diagnostics: %w", err)
	}
	summaryExists, err := sqliteTableExists(db, "summaries")
	if err != nil {
		return "", fmt.Errorf("check summary schema for focus diagnostics: %w", err)
	}
	if !contextExists || !summaryExists {
		return "", nil
	}

	rows, err := db.Query(`
		SELECT
			ci.ordinal,
			s.summary_id,
			COALESCE(s.token_count, 0),
			COALESCE(s.latest_at, '')
		FROM context_items ci
		JOIN summaries s ON s.summary_id = ci.summary_id
		WHERE ci.conversation_id = ?
		  AND ci.item_type = 'summary'
		ORDER BY ci.ordinal
	`, conversationID)
	if err != nil {
		return "", fmt.Errorf("query active focus source hash: %w", err)
	}
	defer rows.Close()

	hasher := sha256.New()
	count := 0
	for rows.Next() {
		var ordinal int
		var summaryID string
		var tokenCount int
		var latestAt string
		if err := rows.Scan(&ordinal, &summaryID, &tokenCount, &latestAt); err != nil {
			return "", fmt.Errorf("scan active focus source hash: %w", err)
		}
		fmt.Fprintf(hasher, "%d\x00%s\x00%d\x00%s\n", ordinal, summaryID, tokenCount, latestAt)
		count++
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("iterate active focus source hash: %w", err)
	}
	if count == 0 {
		return "", nil
	}
	return fmt.Sprintf("%x", hasher.Sum(nil)), nil
}

// populateFocusBriefSourceStats adds source/citation counts and IDs to one brief.
func populateFocusBriefSourceStats(db *sql.DB, brief *focusBriefEntry) error {
	exists, err := sqliteTableExists(db, "focus_brief_sources")
	if err != nil {
		return fmt.Errorf("check focus brief source schema: %w", err)
	}
	if !exists {
		return nil
	}

	rows, err := db.Query(`
		SELECT role, summary_id
		FROM focus_brief_sources
		WHERE brief_id = ?
		ORDER BY role, ordinal, summary_id
	`, brief.briefID)
	if err != nil {
		return fmt.Errorf("query focus brief sources for %s: %w", brief.briefID, err)
	}
	defer rows.Close()

	for rows.Next() {
		var role string
		var summaryID string
		if err := rows.Scan(&role, &summaryID); err != nil {
			return fmt.Errorf("scan focus brief source: %w", err)
		}
		switch role {
		case "active_input":
			brief.sourceCount++
		case "cited":
			brief.citedCount++
			brief.citedSummaryIDs = append(brief.citedSummaryIDs, summaryID)
		case "expanded":
			brief.expandedCount++
			brief.expandedSummaryIDs = append(brief.expandedSummaryIDs, summaryID)
		case "irrelevant":
			brief.irrelevantCount++
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("iterate focus brief sources: %w", err)
	}
	return nil
}

func formatTimeForList(ts time.Time) string {
	return ts.Local().Format("2006-01-02 15:04:05")
}

func formatTimestamp(ts string) string {
	trimmed := strings.TrimSpace(ts)
	if trimmed == "" {
		return ""
	}
	// Try RFC3339 first (with timezone info)
	if parsed, err := time.Parse(time.RFC3339Nano, trimmed); err == nil {
		return parsed.Local().Format("2006-01-02 15:04:05")
	}
	// SQLite bare datetime (stored as UTC, no timezone indicator)
	if parsed, err := time.Parse("2006-01-02 15:04:05", trimmed); err == nil {
		return parsed.In(time.UTC).Local().Format("2006-01-02 15:04:05")
	}
	return trimmed
}
