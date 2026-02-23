package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/muesli/reflow/wordwrap"
)

type screen int

const (
	screenAgents screen = iota
	screenSessions
	screenConversation
	screenSummaries
	screenFiles
	screenContext
)

const (
	sessionInitialLoadSize = 50
	sessionBatchLoadSize   = 50
)

type rewritePhase int

const (
	rewritePreview rewritePhase = iota
	rewriteInflight
	rewriteReview
)

var rewriteSpinnerFrames = []string{"|", "/", "-", `\`}

type rewriteState struct {
	summaryID       string
	kind            string
	depth           int
	oldContent      string
	oldTokens       int
	sourceText      string
	sourceLabel     string
	sourceCount     int
	timeRange       string
	prompt          string
	targetTokens    int
	previousContext string
	phase           rewritePhase
	newContent      string
	newTokens       int
	diffView        bool
	scrollOffset    int
	spinnerFrame    int
	provider        string
	apiKey          string
	model           string
	err             error
}

type rewriteResultMsg struct {
	summaryID string
	content   string
	tokens    int
	err       error
}

type rewriteSpinnerTickMsg struct{}

// model tracks TUI state across all navigation levels.
type model struct {
	screen screen
	paths  appDataPaths

	agents            []agentEntry
	sessionFiles      []sessionFileEntry
	sessionFileCursor int
	sessions          []sessionEntry
	messages          []sessionMessage
	summary           summaryGraph
	summaryRows       []summaryRow

	largeFiles []largeFileEntry
	fileCursor int

	contextItems  []contextItemEntry
	contextCursor int

	agentCursor         int
	sessionCursor       int
	summaryCursor       int
	summaryDetailScroll int
	contextDetailScroll int

	convViewport viewport.Model
	width        int
	height       int

	summarySources   map[string][]summarySource
	summarySourceErr map[string]string
	pendingDissolve  *dissolvePlan
	pendingRewrite   *rewriteState
	subtreeQueue     []rewriteSummary // remaining nodes for W subtree rewrite
	subtreeTotal     int              // original queue length for progress display
	autoAccept       bool             // auto-apply rewrites without waiting for confirmation

	status string
}

var (
	titleStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("69"))
	helpStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("244"))

	selectedStyle = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("230")).Background(lipgloss.Color("62"))

	roleUserStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))
	roleAssistantStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("39"))
	roleSystemStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("220"))
	roleToolStyle      = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))

	diffAddStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("42"))  // green
	diffRemStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("196")) // red
	diffHunkStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("39"))  // blue
	diffHeaderStyle = lipgloss.NewStyle().Bold(true)
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == "repair" {
		if err := runRepairCommand(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "lcm-tui repair failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "backfill" {
		if err := runBackfillCommand(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "lcm-tui backfill failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "transplant" {
		if err := runTransplantCommand(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "lcm-tui transplant failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "dissolve" {
		if err := runDissolveCommand(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "lcm-tui dissolve failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "rewrite" {
		if err := runRewriteCommand(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "lcm-tui rewrite failed: %v\n", err)
			os.Exit(1)
		}
		return
	}
	if len(os.Args) > 1 && os.Args[1] == "prompts" {
		if err := runPromptsCommand(os.Args[2:]); err != nil {
			fmt.Fprintf(os.Stderr, "lcm-tui prompts failed: %v\n", err)
			os.Exit(1)
		}
		return
	}

	m := newModel()
	program := tea.NewProgram(m, tea.WithAltScreen())
	if _, err := program.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "openclaw-tui failed: %v\n", err)
		os.Exit(1)
	}
}

func newModel() model {
	m := model{
		screen:           screenAgents,
		summarySources:   make(map[string][]summarySource),
		summarySourceErr: make(map[string]string),
	}

	paths, err := resolveDataPaths()
	if err != nil {
		m.status = "Error: " + err.Error()
		return m
	}
	m.paths = paths

	agents, err := loadAgents(paths.agentsDir)
	if err != nil {
		m.status = "Error: " + err.Error()
		return m
	}
	m.agents = agents
	m.status = fmt.Sprintf("Loaded %d agents from %s", len(agents), paths.agentsDir)
	return m
}

func (m model) Init() tea.Cmd {
	return nil
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		m.resizeViewport()
		m.refreshConversationViewport()
		return m, nil
	case rewriteResultMsg:
		if m.pendingRewrite == nil || m.pendingRewrite.summaryID != msg.summaryID || m.pendingRewrite.phase != rewriteInflight {
			return m, nil
		}
		if msg.err != nil {
			m.pendingRewrite.err = msg.err
			m.pendingRewrite.phase = rewriteReview
			m.status = fmt.Sprintf("Rewrite failed for %s: %v", msg.summaryID, msg.err)
			if m.autoAccept {
				// Stop auto-accept on error so user can see what happened
				m.autoAccept = false
				m.status += " (auto-accept paused)"
			}
			return m, nil
		}
		m.pendingRewrite.newContent = msg.content
		m.pendingRewrite.newTokens = msg.tokens
		m.pendingRewrite.phase = rewriteReview
		progress := m.subtreeTotal - len(m.subtreeQueue)
		m.status = fmt.Sprintf("Rewrite complete for %s: %dt -> %dt (%+dt)",
			msg.summaryID,
			m.pendingRewrite.oldTokens,
			msg.tokens,
			msg.tokens-m.pendingRewrite.oldTokens)

		if m.autoAccept {
			oldTokens := m.pendingRewrite.oldTokens
			m.confirmPendingRewrite()
			if len(m.subtreeQueue) > 0 {
				m.advanceSubtreeQueue()
				m.status = fmt.Sprintf("Auto-accept [%d/%d]: applied %s (%+dt)",
					progress, m.subtreeTotal,
					msg.summaryID,
					msg.tokens-oldTokens)
				// Auto-start the next one
				if m.pendingRewrite != nil && m.pendingRewrite.phase == rewritePreview {
					m.pendingRewrite.phase = rewriteInflight
					m.pendingRewrite.spinnerFrame = 0
					return m, tea.Batch(m.startPendingRewriteAPI(), rewriteSpinnerTickCmd())
				}
			} else {
				m.autoAccept = false
				m.status = fmt.Sprintf("Subtree rewrite complete (%d nodes, auto-accepted)", m.subtreeTotal)
			}
		}
		return m, nil
	case rewriteSpinnerTickMsg:
		if m.pendingRewrite == nil || m.pendingRewrite.phase != rewriteInflight {
			return m, nil
		}
		m.pendingRewrite.spinnerFrame = (m.pendingRewrite.spinnerFrame + 1) % len(rewriteSpinnerFrames)
		return m, rewriteSpinnerTickCmd()
	case tea.KeyMsg:
		if msg.String() == "ctrl+c" || msg.String() == "q" {
			return m, tea.Quit
		}
		return m.handleKey(msg)
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.screen {
	case screenAgents:
		return m.handleAgentsKey(msg)
	case screenSessions:
		return m.handleSessionsKey(msg)
	case screenConversation:
		return m.handleConversationKey(msg)
	case screenSummaries:
		return m.handleSummariesKey(msg)
	case screenFiles:
		return m.handleFilesKey(msg)
	case screenContext:
		return m.handleContextKey(msg)
	default:
		return m, nil
	}
}

func (m model) handleAgentsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.agentCursor = clamp(m.agentCursor-1, 0, len(m.agents)-1)
	case "down", "j":
		m.agentCursor = clamp(m.agentCursor+1, 0, len(m.agents)-1)
	case "enter":
		if len(m.agents) == 0 {
			m.status = "No agents found"
			return m, nil
		}
		agent := m.agents[m.agentCursor]
		if err := m.loadInitialSessions(agent); err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.sessionCursor = 0
		m.messages = nil
		m.summary = summaryGraph{}
		m.summaryRows = nil
		m.screen = screenSessions
		m.status = fmt.Sprintf("Loaded %d of %d sessions for agent %s", len(m.sessions), len(m.sessionFiles), agent.name)
	case "r":
		agents, err := loadAgents(m.paths.agentsDir)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.agents = agents
		m.agentCursor = clamp(m.agentCursor, 0, len(m.agents)-1)
		m.status = fmt.Sprintf("Reloaded %d agents", len(agents))
	}
	return m, nil
}

func (m model) handleSessionsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.sessionCursor = clamp(m.sessionCursor-1, 0, len(m.sessions)-1)
	case "down", "j":
		previousLoaded := len(m.sessions)
		m.sessionCursor = clamp(m.sessionCursor+1, 0, len(m.sessions)-1)
		loaded := m.maybeLoadMoreSessions()
		if loaded > 0 && m.sessionCursor == previousLoaded-1 {
			m.sessionCursor = clamp(m.sessionCursor+1, 0, len(m.sessions)-1)
		}
	case "enter":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		messages, err := parseSessionMessages(session.path)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.messages = messages
		m.screen = screenConversation
		m.refreshConversationViewport()
		if session.conversationID > 0 {
			m.status = fmt.Sprintf("Loaded %d messages from %s (conv_id:%d)", len(messages), session.filename, session.conversationID)
		} else {
			m.status = fmt.Sprintf("Loaded %d messages from %s", len(messages), session.filename)
		}
	case "b", "backspace":
		m.screen = screenAgents
		m.sessionFiles = nil
		m.sessionFileCursor = 0
		m.sessions = nil
		m.sessionCursor = 0
		m.status = "Back to agents"
	case "r":
		agent, ok := m.currentAgent()
		if !ok {
			m.status = "No agent selected"
			return m, nil
		}
		if err := m.loadInitialSessions(agent); err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.sessionCursor = clamp(m.sessionCursor, 0, len(m.sessions)-1)
		m.status = fmt.Sprintf("Reloaded %d of %d sessions", len(m.sessions), len(m.sessionFiles))
	}
	return m, nil
}

func (m model) handleConversationKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.convViewport.LineUp(1)
	case "down", "j":
		m.convViewport.LineDown(1)
	case "pgup":
		m.convViewport.HalfViewUp()
	case "pgdown":
		m.convViewport.HalfViewDown()
	case "g":
		m.convViewport.GotoTop()
	case "G":
		m.convViewport.GotoBottom()
	case "b", "backspace":
		m.screen = screenSessions
		m.status = "Back to sessions"
	case "r":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		messages, err := parseSessionMessages(session.path)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.messages = messages
		m.refreshConversationViewport()
		m.status = fmt.Sprintf("Reloaded %d messages", len(messages))
	case "l":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		summary, err := loadSummaryGraph(m.paths.lcmDBPath, session.id)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.summary = summary
		m.summaryRows = buildSummaryRows(summary)
		m.summaryCursor = 0
		m.summarySources = make(map[string][]summarySource)
		m.summarySourceErr = make(map[string]string)
		m.loadCurrentSummarySources()
		m.screen = screenSummaries
		m.status = fmt.Sprintf("Loaded %d summaries for conversation %d", len(summary.nodes), summary.conversationID)
	case "f":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		files, err := loadLargeFiles(m.paths.lcmDBPath, session.id)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.largeFiles = files
		m.fileCursor = 0
		m.screen = screenFiles
		if len(files) == 0 {
			m.status = fmt.Sprintf("No large files for session %s", session.id)
		} else {
			m.status = fmt.Sprintf("Loaded %d large files", len(files))
		}
	case "c":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		items, err := loadContextItems(m.paths.lcmDBPath, session.id)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.contextItems = items
		m.contextCursor = 0
		m.screen = screenContext
		if len(items) == 0 {
			m.status = "No context items for this session"
		} else {
			totalTokens := 0
			summaryCount := 0
			messageCount := 0
			for _, it := range items {
				totalTokens += it.tokenCount
				if it.itemType == "summary" {
					summaryCount++
				} else {
					messageCount++
				}
			}
			m.status = fmt.Sprintf("Context: %d summaries + %d messages = %d items, %dk tokens",
				summaryCount, messageCount, len(items), totalTokens/1000)
		}
	}
	return m, nil
}

func (m model) handleSummariesKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	if m.pendingRewrite != nil {
		switch m.pendingRewrite.phase {
		case rewritePreview:
			switch msg.String() {
			case "A":
				// Auto-accept from preview: start this rewrite and auto-apply all subsequent
				if len(m.subtreeQueue) > 0 {
					m.autoAccept = true
				}
				m.pendingRewrite.phase = rewriteInflight
				m.pendingRewrite.spinnerFrame = 0
				m.status = fmt.Sprintf("Rewriting %s...%s", m.pendingRewrite.summaryID,
					func() string {
						if m.autoAccept {
							return " (auto-accept enabled)"
						}
						return ""
					}())
				return m, tea.Batch(m.startPendingRewriteAPI(), rewriteSpinnerTickCmd())
			case "enter":
				m.pendingRewrite.phase = rewriteInflight
				m.pendingRewrite.spinnerFrame = 0
				m.status = fmt.Sprintf("Rewriting %s...", m.pendingRewrite.summaryID)
				return m, tea.Batch(m.startPendingRewriteAPI(), rewriteSpinnerTickCmd())
			case "n":
				m.pendingRewrite = nil
				m.autoAccept = false
				if len(m.subtreeQueue) > 0 {
					m.status = "Skipped, advancing to next..."
					m.advanceSubtreeQueue()
				} else {
					m.status = "Rewrite canceled"
				}
			case "esc", "b", "backspace":
				m.pendingRewrite = nil
				m.autoAccept = false
				if len(m.subtreeQueue) > 0 {
					m.subtreeQueue = nil
					m.subtreeTotal = 0
					m.status = "Subtree rewrite aborted"
				} else {
					m.status = "Rewrite canceled"
				}
			}
			return m, nil
		case rewriteInflight:
			switch msg.String() {
			case "esc", "n", "b", "backspace":
				m.pendingRewrite = nil
				m.autoAccept = false
				m.status = "Rewrite dismissed"
			}
			return m, nil
		case rewriteReview:
			if m.pendingRewrite.err != nil {
				switch msg.String() {
				case "enter", "y", "esc", "n", "b", "backspace":
					m.pendingRewrite = nil
					m.autoAccept = false
				}
				return m, nil
			}
			switch msg.String() {
			case "A":
				// Auto-accept: apply this one and all remaining in subtree
				if len(m.subtreeQueue) > 0 {
					m.autoAccept = true
					m.confirmPendingRewrite()
					m.advanceSubtreeQueue()
					progress := m.subtreeTotal - len(m.subtreeQueue)
					m.status = fmt.Sprintf("Auto-accept [%d/%d]: starting...", progress, m.subtreeTotal)
					if m.pendingRewrite != nil && m.pendingRewrite.phase == rewritePreview {
						m.pendingRewrite.phase = rewriteInflight
						m.pendingRewrite.spinnerFrame = 0
						return m, tea.Batch(m.startPendingRewriteAPI(), rewriteSpinnerTickCmd())
					}
				} else {
					// Last node — just apply it
					m.confirmPendingRewrite()
				}
				return m, nil
			case "y", "enter":
				m.confirmPendingRewrite()
				if len(m.subtreeQueue) > 0 {
					m.advanceSubtreeQueue()
				}
			case "d":
				m.pendingRewrite.diffView = !m.pendingRewrite.diffView
				m.pendingRewrite.scrollOffset = 0
			case "j", "down":
				m.pendingRewrite.scrollOffset++
			case "k", "up":
				if m.pendingRewrite.scrollOffset > 0 {
					m.pendingRewrite.scrollOffset--
				}
			case "n":
				m.pendingRewrite = nil
				m.autoAccept = false
				if len(m.subtreeQueue) > 0 {
					m.status = "Skipped, advancing to next..."
					m.advanceSubtreeQueue()
				} else {
					m.status = "Rewrite discarded"
				}
			case "esc", "b", "backspace":
				m.pendingRewrite = nil
				m.autoAccept = false
				if len(m.subtreeQueue) > 0 {
					m.subtreeQueue = nil
					m.subtreeTotal = 0
					m.status = "Subtree rewrite aborted"
				} else {
					m.status = "Rewrite discarded"
				}
			}
			return m, nil
		}
	}

	if m.pendingDissolve != nil {
		switch msg.String() {
		case "y", "enter":
			m.confirmPendingDissolve()
		case "n", "esc", "b", "backspace", "d":
			m.pendingDissolve = nil
			m.status = "Dissolve canceled"
		}
		return m, nil
	}

	switch msg.String() {
	case "up", "k":
		m.summaryCursor = clamp(m.summaryCursor-1, 0, len(m.summaryRows)-1)
		m.summaryDetailScroll = 0
		m.loadCurrentSummarySources()
	case "down", "j":
		m.summaryCursor = clamp(m.summaryCursor+1, 0, len(m.summaryRows)-1)
		m.summaryDetailScroll = 0
		m.loadCurrentSummarySources()
	case "g":
		m.summaryCursor = 0
		m.summaryDetailScroll = 0
		m.loadCurrentSummarySources()
	case "G":
		m.summaryCursor = max(0, len(m.summaryRows)-1)
		m.summaryDetailScroll = 0
		m.loadCurrentSummarySources()
	case "J":
		m.summaryDetailScroll++
	case "K":
		m.summaryDetailScroll = max(0, m.summaryDetailScroll-1)
	case "enter", "right", "l", " ":
		m.expandOrToggleSelectedSummary()
	case "left", "h":
		m.collapseSelectedSummary()
	case "w":
		m.startPendingRewrite()
	case "W":
		m.startSubtreeRewrite()
	case "d":
		m.startPendingDissolve()
	case "r":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		summary, err := loadSummaryGraph(m.paths.lcmDBPath, session.id)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.summary = summary
		m.summaryRows = buildSummaryRows(summary)
		m.summaryCursor = clamp(m.summaryCursor, 0, len(m.summaryRows)-1)
		m.summarySources = make(map[string][]summarySource)
		m.summarySourceErr = make(map[string]string)
		m.loadCurrentSummarySources()
		m.status = fmt.Sprintf("Reloaded %d summaries", len(summary.nodes))
	case "b", "backspace":
		m.screen = screenConversation
		m.status = "Back to conversation"
	}
	return m, nil
}

func (m model) handleFilesKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.fileCursor = clamp(m.fileCursor-1, 0, len(m.largeFiles)-1)
	case "down", "j":
		m.fileCursor = clamp(m.fileCursor+1, 0, len(m.largeFiles)-1)
	case "g":
		m.fileCursor = 0
	case "G":
		m.fileCursor = max(0, len(m.largeFiles)-1)
	case "r":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		files, err := loadLargeFiles(m.paths.lcmDBPath, session.id)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.largeFiles = files
		m.fileCursor = clamp(m.fileCursor, 0, len(m.largeFiles)-1)
		m.status = fmt.Sprintf("Reloaded %d large files", len(files))
	case "f":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		files, err := loadLargeFiles(m.paths.lcmDBPath, session.id)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.largeFiles = files
		m.fileCursor = 0
		m.screen = screenFiles
		if len(files) == 0 {
			m.status = "No large files for this session"
		} else {
			m.status = fmt.Sprintf("Loaded %d large files", len(files))
		}
	case "b", "backspace":
		m.screen = screenConversation
		m.status = "Back to conversation"
	}
	return m, nil
}

func (m model) handleContextKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "up", "k":
		m.contextCursor = clamp(m.contextCursor-1, 0, len(m.contextItems)-1)
		m.contextDetailScroll = 0
	case "down", "j":
		m.contextCursor = clamp(m.contextCursor+1, 0, len(m.contextItems)-1)
		m.contextDetailScroll = 0
	case "g":
		m.contextCursor = 0
		m.contextDetailScroll = 0
	case "G":
		m.contextCursor = max(0, len(m.contextItems)-1)
		m.contextDetailScroll = 0
	case "J":
		m.contextDetailScroll++
	case "K":
		m.contextDetailScroll = max(0, m.contextDetailScroll-1)
	case "r":
		session, ok := m.currentSession()
		if !ok {
			m.status = "No session selected"
			return m, nil
		}
		items, err := loadContextItems(m.paths.lcmDBPath, session.id)
		if err != nil {
			m.status = "Error: " + err.Error()
			return m, nil
		}
		m.contextItems = items
		m.contextCursor = clamp(m.contextCursor, 0, len(m.contextItems)-1)
		m.status = fmt.Sprintf("Reloaded %d context items", len(items))
	case "b", "backspace":
		m.screen = screenConversation
		m.status = "Back to conversation"
	}
	return m, nil
}

func (m *model) expandOrToggleSelectedSummary() {
	id, ok := m.currentSummaryID()
	if !ok {
		m.status = "No summary selected"
		return
	}
	node := m.summary.nodes[id]
	if node == nil {
		m.status = "Missing summary node"
		return
	}
	if len(node.children) == 0 {
		m.status = "Summary has no children"
		return
	}
	node.expanded = !node.expanded
	m.summaryRows = buildSummaryRows(m.summary)
	m.summaryCursor = clamp(m.summaryCursor, 0, len(m.summaryRows)-1)
	m.loadCurrentSummarySources()
}

func (m *model) collapseSelectedSummary() {
	id, ok := m.currentSummaryID()
	if !ok {
		m.status = "No summary selected"
		return
	}
	node := m.summary.nodes[id]
	if node == nil {
		m.status = "Missing summary node"
		return
	}
	if node.expanded {
		node.expanded = false
		m.summaryRows = buildSummaryRows(m.summary)
		m.summaryCursor = clamp(m.summaryCursor, 0, len(m.summaryRows)-1)
		m.loadCurrentSummarySources()
		return
	}
	m.status = "Summary already collapsed"
}

// startPendingDissolve builds a dry-run dissolve preview for the selected node.
func (m *model) startPendingDissolve() {
	summaryID, ok := m.currentSummaryID()
	if !ok {
		m.status = "No summary selected"
		return
	}
	if m.summary.conversationID <= 0 {
		m.status = "Missing conversation ID for current summary graph"
		return
	}

	db, err := openLCMDB(m.paths.lcmDBPath)
	if err != nil {
		m.status = "Error: " + err.Error()
		return
	}
	defer db.Close()

	plan, err := buildDissolvePlan(context.Background(), db, m.summary.conversationID, summaryID)
	if err != nil {
		m.status = "Error: " + err.Error()
		return
	}

	m.pendingDissolve = &plan
	m.status = fmt.Sprintf("Ready to dissolve %s", summaryID)
}

// confirmPendingDissolve applies the pending dissolve and refreshes the DAG view.
func (m *model) confirmPendingDissolve() {
	if m.pendingDissolve == nil {
		return
	}
	plan := *m.pendingDissolve

	db, err := openLCMDB(m.paths.lcmDBPath)
	if err != nil {
		m.pendingDissolve = nil
		m.status = "Error: " + err.Error()
		return
	}
	defer db.Close()

	newCount, err := applyDissolvePlan(context.Background(), db, plan, true)
	if err != nil {
		m.pendingDissolve = nil
		m.status = "Error: " + err.Error()
		return
	}

	session, ok := m.currentSession()
	if !ok {
		m.pendingDissolve = nil
		m.status = fmt.Sprintf("Dissolved %s, but no session is selected for reload", plan.target.summaryID)
		return
	}

	summary, err := loadSummaryGraph(m.paths.lcmDBPath, session.id)
	if err != nil {
		m.pendingDissolve = nil
		m.status = fmt.Sprintf("Dissolved %s, but reload failed: %v", plan.target.summaryID, err)
		return
	}

	m.summary = summary
	m.summaryRows = buildSummaryRows(summary)
	m.summaryCursor = clamp(m.summaryCursor, 0, len(m.summaryRows)-1)
	m.summaryDetailScroll = 0
	m.summarySources = make(map[string][]summarySource)
	m.summarySourceErr = make(map[string]string)
	m.loadCurrentSummarySources()
	m.pendingDissolve = nil
	m.status = fmt.Sprintf("Dissolved %s: restored %d parents (%dt → %dt, %+dt). Context items: %d",
		plan.target.summaryID,
		len(plan.parents),
		plan.target.tokenCount,
		plan.totalParentTokens,
		plan.totalParentTokens-plan.target.tokenCount,
		newCount)
}

// collectSubtreeBottomUp walks the DAG from a root node and returns all
// descendants (including root) ordered bottom-up: deepest leaves first.
func (m *model) collectSubtreeBottomUp(rootID string) []rewriteSummary {
	var result []rewriteSummary
	visited := map[string]bool{}

	var walk func(id string)
	walk = func(id string) {
		if visited[id] {
			return
		}
		visited[id] = true
		node := m.summary.nodes[id]
		if node == nil {
			return
		}
		// Recurse into children first (bottom-up)
		for _, childID := range node.children {
			walk(childID)
		}
		result = append(result, rewriteSummary{
			summaryID:      id,
			conversationID: m.summary.conversationID,
			kind:           node.kind,
			depth:          node.depth,
			tokenCount:     node.tokenCount,
			content:        node.content,
			createdAt:      node.createdAt,
		})
	}
	walk(rootID)
	return result
}

// startSubtreeRewrite initiates a bottom-up rewrite of the selected node and
// all its descendants. Each node goes through the normal preview→rewrite→review
// cycle. After applying one, the next is queued automatically.
func (m *model) startSubtreeRewrite() {
	summaryID, ok := m.currentSummaryID()
	if !ok {
		m.status = "No summary selected"
		return
	}
	node := m.summary.nodes[summaryID]
	if node == nil {
		m.status = "Missing summary node"
		return
	}
	if len(node.children) == 0 {
		// No children — just do a single rewrite
		m.startPendingRewrite()
		return
	}

	queue := m.collectSubtreeBottomUp(summaryID)
	if len(queue) == 0 {
		m.status = "No summaries found in subtree"
		return
	}

	m.subtreeQueue = queue
	m.subtreeTotal = len(queue)
	m.status = fmt.Sprintf("Subtree rewrite: %d nodes (bottom-up)", len(queue))
	m.advanceSubtreeQueue()
}

// advanceSubtreeQueue pops the next node from the subtree queue and sets up
// a pending rewrite for it. Called after each node is applied (or skipped).
func (m *model) advanceSubtreeQueue() {
	if len(m.subtreeQueue) == 0 {
		m.status = fmt.Sprintf("Subtree rewrite complete (%d nodes)", m.subtreeTotal)
		m.subtreeTotal = 0
		return
	}

	item := m.subtreeQueue[0]
	m.subtreeQueue = m.subtreeQueue[1:]
	progress := m.subtreeTotal - len(m.subtreeQueue)

	db, err := openLCMDB(m.paths.lcmDBPath)
	if err != nil {
		m.status = "Error: " + err.Error()
		m.subtreeQueue = nil
		return
	}
	defer db.Close()

	ctx := context.Background()

	// Re-read content from DB (may have been updated by prior rewrite in this subtree)
	var currentContent string
	var currentTokens int
	err = db.QueryRowContext(ctx, `SELECT content, token_count FROM summaries WHERE summary_id = ?`, item.summaryID).Scan(&currentContent, &currentTokens)
	if err != nil {
		m.status = fmt.Sprintf("Error reading %s: %v", item.summaryID, err)
		m.subtreeQueue = nil
		return
	}
	item.content = currentContent
	item.tokenCount = currentTokens

	source, err := buildSummaryRewriteSource(ctx, db, item, true, time.Local)
	if err != nil {
		m.status = fmt.Sprintf("Error building source for %s: %v", item.summaryID, err)
		m.subtreeQueue = nil
		return
	}
	previousContext, err := resolveRewritePreviousContext(ctx, db, item)
	if err != nil {
		m.status = fmt.Sprintf("Error resolving context for %s: %v", item.summaryID, err)
		m.subtreeQueue = nil
		return
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
	}, "")
	if err != nil {
		m.status = fmt.Sprintf("Error rendering prompt for %s: %v", item.summaryID, err)
		m.subtreeQueue = nil
		return
	}

	provider, model := resolveInteractiveRewriteProviderModel()
	apiKey, err := resolveProviderAPIKey(m.paths, provider)
	if err != nil {
		m.status = "Error: " + err.Error()
		m.subtreeQueue = nil
		return
	}

	m.pendingRewrite = &rewriteState{
		summaryID:       item.summaryID,
		kind:            item.kind,
		depth:           item.depth,
		oldContent:      item.content,
		oldTokens:       item.tokenCount,
		sourceText:      source.text,
		sourceLabel:     source.label,
		sourceCount:     source.itemCount,
		timeRange:       source.timeRange,
		prompt:          prompt,
		targetTokens:    targetTokens,
		previousContext: previousContext,
		phase:           rewritePreview,
		provider:        provider,
		apiKey:          apiKey,
		model:           model,
	}
	m.status = fmt.Sprintf("Subtree rewrite [%d/%d]: %s (d%d)", progress, m.subtreeTotal, item.summaryID, item.depth)
}

// startPendingRewrite builds a dry-run rewrite preview for the selected summary.
func (m *model) startPendingRewrite() {
	summaryID, ok := m.currentSummaryID()
	if !ok {
		m.status = "No summary selected"
		return
	}
	if m.summary.conversationID <= 0 {
		m.status = "Missing conversation ID for current summary graph"
		return
	}
	node := m.summary.nodes[summaryID]
	if node == nil {
		m.status = "Missing summary node"
		return
	}

	db, err := openLCMDB(m.paths.lcmDBPath)
	if err != nil {
		m.status = "Error: " + err.Error()
		return
	}
	defer db.Close()

	ctx := context.Background()
	item := rewriteSummary{
		summaryID:      summaryID,
		conversationID: m.summary.conversationID,
		kind:           node.kind,
		depth:          node.depth,
		tokenCount:     node.tokenCount,
		content:        node.content,
		createdAt:      node.createdAt,
	}

	source, err := buildSummaryRewriteSource(ctx, db, item, true, time.Local)
	if err != nil {
		m.status = "Error: " + err.Error()
		return
	}
	previousContext, err := resolveRewritePreviousContext(ctx, db, item)
	if err != nil {
		m.status = "Error: " + err.Error()
		return
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
	}, "")
	if err != nil {
		m.status = "Error: " + err.Error()
		return
	}

	provider, model := resolveInteractiveRewriteProviderModel()
	apiKey, err := resolveProviderAPIKey(m.paths, provider)
	if err != nil {
		m.status = "Error: " + err.Error()
		return
	}

	m.pendingRewrite = &rewriteState{
		summaryID:       summaryID,
		kind:            item.kind,
		depth:           item.depth,
		oldContent:      item.content,
		oldTokens:       item.tokenCount,
		sourceText:      source.text,
		sourceLabel:     source.label,
		sourceCount:     source.itemCount,
		timeRange:       source.timeRange,
		prompt:          prompt,
		targetTokens:    targetTokens,
		previousContext: previousContext,
		phase:           rewritePreview,
		provider:        provider,
		apiKey:          apiKey,
		model:           model,
	}
	m.status = fmt.Sprintf("Ready to rewrite %s", summaryID)
}

func (m model) startPendingRewriteAPI() tea.Cmd {
	if m.pendingRewrite == nil {
		return nil
	}
	pending := *m.pendingRewrite
	return func() tea.Msg {
		client := &anthropicClient{
			provider: pending.provider,
			apiKey:   pending.apiKey,
			http:     &http.Client{Timeout: defaultHTTPTimeout},
			model:    pending.model,
		}
		content, err := client.summarize(context.Background(), pending.prompt, pending.targetTokens)
		if err != nil {
			return rewriteResultMsg{summaryID: pending.summaryID, err: err}
		}
		return rewriteResultMsg{
			summaryID: pending.summaryID,
			content:   content,
			tokens:    estimateTokenCount(content),
		}
	}
}

func resolveInteractiveRewriteProviderModel() (string, string) {
	provider := strings.TrimSpace(os.Getenv("LCM_TUI_SUMMARY_PROVIDER"))
	if provider == "" {
		provider = strings.TrimSpace(os.Getenv("LCM_SUMMARY_PROVIDER"))
	}

	model := strings.TrimSpace(os.Getenv("LCM_TUI_SUMMARY_MODEL"))
	if model == "" {
		model = strings.TrimSpace(os.Getenv("LCM_SUMMARY_MODEL"))
	}
	return resolveSummaryProviderModel(provider, model)
}

func rewriteSpinnerTickCmd() tea.Cmd {
	return tea.Tick(120*time.Millisecond, func(time.Time) tea.Msg {
		return rewriteSpinnerTickMsg{}
	})
}

func (m *model) confirmPendingRewrite() {
	if m.pendingRewrite == nil || m.pendingRewrite.phase != rewriteReview || m.pendingRewrite.err != nil {
		return
	}
	plan := *m.pendingRewrite

	db, err := openLCMDB(m.paths.lcmDBPath)
	if err != nil {
		m.pendingRewrite = nil
		m.status = "Error: " + err.Error()
		return
	}
	defer db.Close()

	if _, err := db.ExecContext(context.Background(), `
		UPDATE summaries
		SET content = ?, token_count = ?
		WHERE summary_id = ?
	`, plan.newContent, plan.newTokens, plan.summaryID); err != nil {
		m.pendingRewrite = nil
		m.status = "Error: " + err.Error()
		return
	}

	session, ok := m.currentSession()
	if !ok {
		m.pendingRewrite = nil
		m.status = fmt.Sprintf("Rewrote %s, but no session is selected for reload", plan.summaryID)
		return
	}
	summary, err := loadSummaryGraph(m.paths.lcmDBPath, session.id)
	if err != nil {
		m.pendingRewrite = nil
		m.status = fmt.Sprintf("Rewrote %s, but reload failed: %v", plan.summaryID, err)
		return
	}

	m.summary = summary
	m.summaryRows = buildSummaryRows(summary)
	m.summaryCursor = clamp(m.summaryCursor, 0, len(m.summaryRows)-1)
	m.summaryDetailScroll = 0
	m.summarySources = make(map[string][]summarySource)
	m.summarySourceErr = make(map[string]string)
	m.loadCurrentSummarySources()
	m.pendingRewrite = nil
	m.status = fmt.Sprintf("Rewrote %s: %dt -> %dt (%+dt)",
		plan.summaryID,
		plan.oldTokens,
		plan.newTokens,
		plan.newTokens-plan.oldTokens)
}

func (m *model) loadCurrentSummarySources() {
	id, ok := m.currentSummaryID()
	if !ok {
		return
	}
	if _, exists := m.summarySources[id]; exists {
		return
	}
	if _, exists := m.summarySourceErr[id]; exists {
		return
	}

	sources, err := loadSummarySources(m.paths.lcmDBPath, id)
	if err != nil {
		m.summarySourceErr[id] = err.Error()
		return
	}
	m.summarySources[id] = sources
}

func buildSummaryRows(graph summaryGraph) []summaryRow {
	rows := make([]summaryRow, 0, len(graph.nodes))
	var walk func(summaryID string, depth int, path map[string]bool)

	walk = func(summaryID string, depth int, path map[string]bool) {
		if path[summaryID] {
			return
		}
		node := graph.nodes[summaryID]
		if node == nil {
			return
		}
		rows = append(rows, summaryRow{summaryID: summaryID, depth: depth})
		if !node.expanded {
			return
		}

		path[summaryID] = true
		for _, childID := range node.children {
			walk(childID, depth+1, path)
		}
		delete(path, summaryID)
	}

	for _, rootID := range graph.roots {
		walk(rootID, 0, map[string]bool{})
	}
	return rows
}

func (m model) View() string {
	if m.width <= 0 || m.height <= 0 {
		return "Initializing openclaw-tui..."
	}

	header := m.renderHeader()
	body := m.renderBody()
	footer := helpStyle.Render(m.renderStatus())
	return header + "\n" + body + "\n" + footer
}

func (m model) renderHeader() string {
	title := "openclaw-tui"
	switch m.screen {
	case screenAgents:
		title += " | Agents"
	case screenSessions:
		agentName := ""
		if agent, ok := m.currentAgent(); ok {
			agentName = " | " + agent.name
		}
		title += " | Sessions" + agentName
	case screenConversation:
		title += " | Conversation"
		if conversationID, ok := m.currentConversationID(); ok {
			title += fmt.Sprintf(" | conv_id:%d", conversationID)
		}
	case screenSummaries:
		title += " | LCM Summary DAG"
		if m.summary.conversationID > 0 {
			title += fmt.Sprintf(" | conv_id:%d", m.summary.conversationID)
		}
	case screenFiles:
		title += " | LCM Large Files"
		if conversationID, ok := m.currentConversationID(); ok {
			title += fmt.Sprintf(" | conv_id:%d", conversationID)
		}
	case screenContext:
		title += " | LCM Active Context"
		if conversationID, ok := m.currentConversationID(); ok {
			title += fmt.Sprintf(" | conv_id:%d", conversationID)
		}
	}

	help := m.renderHelp()
	return titleStyle.Render(title) + "\n" + helpStyle.Render(help)
}

func (m model) renderHelp() string {
	switch m.screen {
	case screenAgents:
		return "up/down: move | enter: open agent sessions | r: reload | q: quit"
	case screenSessions:
		return "up/down: move | enter: open conversation | b: back | r: reload | q: quit"
	case screenConversation:
		return "j/k/up/down: scroll | pgup/pgdown | g/G: top/bottom | r: reload | l: LCM summaries | c: context | f: LCM files | b: back | q: quit"
	case screenSummaries:
		if m.pendingRewrite != nil {
			switch m.pendingRewrite.phase {
			case rewritePreview:
				return "Rewrite preview | enter: send to API | esc: cancel | q: quit"
			case rewriteInflight:
				return "Rewrite in progress | esc: dismiss | q: quit"
			case rewriteReview:
				if m.pendingRewrite.err != nil {
					return "Rewrite failed | enter/esc: close | q: quit"
				}
				if len(m.subtreeQueue) > 0 {
					return fmt.Sprintf("Subtree rewrite [%d remaining] | y: apply & next | n: skip | esc: abort | d: diff | j/k: scroll", len(m.subtreeQueue))
				}
				return "Rewrite review | y/enter: apply | n/esc: discard | d: toggle diff | j/k: scroll"
			}
		}
		if m.pendingDissolve != nil {
			return "Dissolve confirmation | y/enter: confirm | n/esc: cancel | q: quit"
		}
		nav := "↑↓: move  ⏎/l: expand  h: collapse  g/G: top/bottom  J/K: scroll detail"
		actions := "w: rewrite  W: subtree rewrite  d: dissolve  f: files  r: reload  b: back  q: quit"
		return nav + "\n" + actions
	case screenFiles:
		return "up/down: move | g/G: top/bottom | r: reload | b: back | q: quit"
	case screenContext:
		return "up/down: move | g/G: top/bottom | r: reload | b: back | q: quit"
	default:
		return "q: quit"
	}
}

func (m model) renderBody() string {
	switch m.screen {
	case screenAgents:
		return m.renderAgents()
	case screenSessions:
		return m.renderSessions()
	case screenConversation:
		return m.renderConversation()
	case screenSummaries:
		return m.renderSummaries()
	case screenFiles:
		return m.renderFiles()
	case screenContext:
		return m.renderContext()
	default:
		return "Unknown screen"
	}
}

func (m model) renderStatus() string {
	if m.screen != screenSessions {
		return m.status
	}
	total := len(m.sessionFiles)
	showing := len(m.sessions)
	if m.status == "" {
		return fmt.Sprintf("showing %d of %d", showing, total)
	}
	return fmt.Sprintf("showing %d of %d | %s", showing, total, m.status)
}

func (m model) renderAgents() string {
	if len(m.agents) == 0 {
		return "No agents found under ~/.openclaw/agents"
	}
	visible := max(1, m.height-4)
	offset := listOffset(m.agentCursor, len(m.agents), visible)

	lines := make([]string, 0, visible)
	for idx := offset; idx < min(len(m.agents), offset+visible); idx++ {
		line := fmt.Sprintf("  %s", m.agents[idx].name)
		if idx == m.agentCursor {
			line = selectedStyle.Render("> " + m.agents[idx].name)
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func (m model) renderSessions() string {
	if len(m.sessions) == 0 {
		return "No session JSONL files found for this agent"
	}
	visible := max(1, m.height-4)
	offset := listOffset(m.sessionCursor, len(m.sessions), visible)

	lines := make([]string, 0, visible)
	for idx := offset; idx < min(len(m.sessions), offset+visible); idx++ {
		session := m.sessions[idx]
		messageCount := formatMessageCount(session.messageCount)
		extras := fmt.Sprintf("  est:%dt", session.estimatedTokens)
		if session.conversationID > 0 {
			extras += fmt.Sprintf("  conv_id:%d", session.conversationID)
		}
		if session.summaryCount > 0 {
			extras += fmt.Sprintf("  sums:%d", session.summaryCount)
		}
		if session.fileCount > 0 {
			extras += fmt.Sprintf("  files:%d", session.fileCount)
		}
		line := fmt.Sprintf("  %s  %s  msgs:%s%s", session.filename, formatTimeForList(session.updatedAt), messageCount, extras)
		if idx == m.sessionCursor {
			line = selectedStyle.Render(fmt.Sprintf("> %s  %s  msgs:%s%s", session.filename, formatTimeForList(session.updatedAt), messageCount, extras))
		}
		lines = append(lines, line)
	}
	return strings.Join(lines, "\n")
}

func (m model) renderConversation() string {
	if len(m.messages) == 0 {
		return "No messages found in this session"
	}
	if m.convViewport.Width <= 0 || m.convViewport.Height <= 0 {
		return "Resizing conversation viewport..."
	}
	return m.convViewport.View()
}

func (m model) renderSummaries() string {
	if len(m.summary.nodes) == 0 {
		return "No LCM summaries found for this session"
	}
	if m.pendingRewrite != nil {
		return m.renderRewriteOverlay()
	}
	if m.pendingDissolve != nil {
		return m.renderDissolveConfirmation()
	}
	if len(m.summaryRows) == 0 {
		return "Summary graph is empty"
	}

	available := max(4, m.height-5) // 5 = title + 2-line help + body padding + status
	detailHeight := max(7, available/3)
	listHeight := max(3, available-detailHeight-1)

	listOffsetValue := listOffset(m.summaryCursor, len(m.summaryRows), listHeight)
	listLines := make([]string, 0, listHeight)
	for idx := listOffsetValue; idx < min(len(m.summaryRows), listOffsetValue+listHeight); idx++ {
		row := m.summaryRows[idx]
		node := m.summary.nodes[row.summaryID]
		if node == nil {
			continue
		}
		marker := "-"
		if len(node.children) > 0 {
			if node.expanded {
				marker = "v"
			} else {
				marker = ">"
			}
		}
		preview := oneLine(node.content)
		preview = truncateString(preview, max(8, m.width-50))
		kindLabel := node.kind
		if node.kind == "condensed" {
			kindLabel = fmt.Sprintf("d%d", node.depth)
		}
		line := fmt.Sprintf("%s%s %s [%s, %dt] %s", strings.Repeat("  ", row.depth), marker, node.id, kindLabel, node.tokenCount, preview)
		if idx == m.summaryCursor {
			line = selectedStyle.Render(line)
		}
		listLines = append(listLines, line)
	}

	detailLines := m.renderSummaryDetail(detailHeight)
	return strings.Join(listLines, "\n") + "\n" + helpStyle.Render(strings.Repeat("-", max(20, m.width-1))) + "\n" + strings.Join(detailLines, "\n")
}

// renderDissolveConfirmation draws the preview/confirmation overlay for DAG dissolve.
func (m model) renderDissolveConfirmation() string {
	if m.pendingDissolve == nil {
		return "No dissolve confirmation pending"
	}

	plan := m.pendingDissolve
	lines := []string{
		fmt.Sprintf("Dissolve summary: %s", plan.target.summaryID),
		fmt.Sprintf("Target: kind=%s depth=%d tokens=%d context_ordinal=%d", plan.target.kind, plan.target.depth, plan.target.tokenCount, plan.target.ordinal),
		fmt.Sprintf("Token impact: %d -> %d (%+d)", plan.target.tokenCount, plan.totalParentTokens, plan.totalParentTokens-plan.target.tokenCount),
		fmt.Sprintf("Ordinal shift: %d item(s) will shift by +%d", plan.itemsToShift, plan.shift),
		"",
		"Parent summaries to restore:",
	}

	availableHeight := max(10, m.height-4)
	maxParentLines := max(1, availableHeight-len(lines)-2)
	parentCount := len(plan.parents)
	for idx := 0; idx < min(parentCount, maxParentLines); idx++ {
		parent := plan.parents[idx]
		preview := truncateString(oneLine(parent.content), max(8, m.width-40))
		lines = append(lines, fmt.Sprintf("  [%d] %s (%s, d%d, %dt) %s",
			parent.ordinal, parent.summaryID, parent.kind, parent.depth, parent.tokenCount, preview))
	}
	if parentCount > maxParentLines {
		lines = append(lines, fmt.Sprintf("  ... and %d more parent summaries", parentCount-maxParentLines))
	}

	lines = append(lines, "")
	lines = append(lines, "Press y or Enter to apply dissolve. Press n or Esc to cancel.")
	return strings.Join(lines, "\n")
}

func (m model) renderRewriteOverlay() string {
	if m.pendingRewrite == nil {
		return "No rewrite preview pending"
	}
	rw := m.pendingRewrite

	switch rw.phase {
	case rewritePreview:
		lines := []string{
			fmt.Sprintf("Rewrite summary: %s", rw.summaryID),
			fmt.Sprintf("Target: kind=%s depth=%d target_tokens=%d", rw.kind, rw.depth, rw.targetTokens),
			fmt.Sprintf("Source: %d %s", rw.sourceCount, rw.sourceLabel),
		}
		if rw.timeRange != "" {
			lines = append(lines, "Time range: "+rw.timeRange)
		}
		if strings.TrimSpace(rw.previousContext) != "" {
			lines = append(lines, "Previous context: present")
		} else {
			lines = append(lines, "Previous context: none")
		}
		lines = append(lines, "")
		lines = append(lines, "Prompt preview:")

		availableHeight := max(10, m.height-4)
		maxPromptLines := max(6, availableHeight-len(lines)-2)
		wrappedPrompt := strings.Split(wrapText(rw.prompt, max(20, m.width-4)), "\n")
		for idx := 0; idx < min(len(wrappedPrompt), maxPromptLines); idx++ {
			lines = append(lines, "  "+wrappedPrompt[idx])
		}
		if len(wrappedPrompt) > maxPromptLines {
			lines = append(lines, fmt.Sprintf("  ... %d more lines", len(wrappedPrompt)-maxPromptLines))
		}
		lines = append(lines, "")
		if len(m.subtreeQueue) > 0 {
			lines = append(lines, fmt.Sprintf("Enter: rewrite | A: rewrite & auto-accept remaining | Esc: cancel  [%d remaining]", len(m.subtreeQueue)))
		} else {
			lines = append(lines, fmt.Sprintf("Press Enter to rewrite with %s/%s. Press Esc to cancel.", rw.provider, rw.model))
		}
		return strings.Join(lines, "\n")
	case rewriteInflight:
		frame := rewriteSpinnerFrames[rw.spinnerFrame%len(rewriteSpinnerFrames)]
		progress := ""
		if m.autoAccept && m.subtreeTotal > 0 {
			done := m.subtreeTotal - len(m.subtreeQueue)
			progress = fmt.Sprintf("  [%d/%d, auto-accept]", done, m.subtreeTotal)
		}
		lines := []string{
			fmt.Sprintf("%s Rewriting %s...%s", frame, rw.summaryID, progress),
			fmt.Sprintf("Depth: d%d  Target: %d tokens", rw.depth, rw.targetTokens),
		}
		if rw.timeRange != "" {
			lines = append(lines, "Time range: "+rw.timeRange)
		}
		lines = append(lines, "")
		lines = append(lines, "Waiting for API response...")
		if m.autoAccept {
			lines = append(lines, "Press Esc to stop auto-accept.")
		} else {
			lines = append(lines, "Press Esc to dismiss this rewrite flow.")
		}
		return strings.Join(lines, "\n")
	case rewriteReview:
		if rw.err != nil {
			return fmt.Sprintf("Rewrite failed for %s:\n\n%v\n\nPress Enter or Esc to close.", rw.summaryID, rw.err)
		}
		lines := []string{
			fmt.Sprintf("Rewrite review: %s (d%d)", rw.summaryID, rw.depth),
		}
		if rw.timeRange != "" {
			lines = append(lines, "Time range: "+rw.timeRange)
		}
		lines = append(lines, fmt.Sprintf("Δ tokens: %+d (%d -> %d)", rw.newTokens-rw.oldTokens, rw.oldTokens, rw.newTokens))
		lines = append(lines, "")
		// Build scrollable content lines
		var contentLines []string
		if rw.diffView {
			diff := buildUnifiedDiff("old/"+rw.summaryID, "new/"+rw.summaryID, rw.oldContent, rw.newContent)
			for _, dl := range strings.Split(strings.TrimRight(diff, "\n"), "\n") {
				contentLines = append(contentLines, colorizeDiffLine(dl))
			}
		} else {
			contentLines = append(contentLines, fmt.Sprintf("OLD (%dt):", rw.oldTokens))
			for _, ol := range strings.Split(wrapText(rw.oldContent, max(20, m.width-4)), "\n") {
				contentLines = append(contentLines, "  "+ol)
			}
			contentLines = append(contentLines, "")
			contentLines = append(contentLines, fmt.Sprintf("NEW (%dt):", rw.newTokens))
			for _, nl := range strings.Split(wrapText(rw.newContent, max(20, m.width-4)), "\n") {
				contentLines = append(contentLines, "  "+nl)
			}
		}

		// Clamp scroll offset
		viewHeight := max(4, m.height-len(lines)-4)
		maxScroll := max(0, len(contentLines)-viewHeight)
		if rw.scrollOffset > maxScroll {
			rw.scrollOffset = maxScroll
		}

		// Render visible window
		end := min(rw.scrollOffset+viewHeight, len(contentLines))
		lines = append(lines, contentLines[rw.scrollOffset:end]...)

		// Scroll indicator
		if len(contentLines) > viewHeight {
			lines = append(lines, helpStyle.Render(fmt.Sprintf("  [%d/%d lines — j/k to scroll]", rw.scrollOffset+viewHeight, len(contentLines))))
		}

		lines = append(lines, "")
		if len(m.subtreeQueue) > 0 {
			lines = append(lines, fmt.Sprintf("y: apply & next | A: accept all remaining | n: skip | esc: abort | d: diff | j/k: scroll  [%d remaining]", len(m.subtreeQueue)))
		} else {
			lines = append(lines, "y/enter: apply | n/esc: discard | d: toggle diff | j/k: scroll")
		}
		return strings.Join(lines, "\n")
	default:
		return "Unknown rewrite state"
	}
}

func (m *model) renderSummaryDetail(detailHeight int) []string {
	id, ok := m.currentSummaryID()
	if !ok {
		return padLines([]string{"No summary selected"}, detailHeight)
	}
	node := m.summary.nodes[id]
	if node == nil {
		return padLines([]string{"Missing summary node"}, detailHeight)
	}

	// Build ALL lines (no height limit)
	var allLines []string
	allLines = append(allLines, fmt.Sprintf("Summary: %s", id))
	allLines = append(allLines, fmt.Sprintf("Created: %s  Tokens: %d", formatTimestamp(node.createdAt), node.tokenCount))
	allLines = append(allLines, "Content:")
	wrappedContent := wrapText(node.content, max(20, m.width-4))
	for _, line := range strings.Split(wrappedContent, "\n") {
		allLines = append(allLines, "  "+line)
	}

	allLines = append(allLines, "Sources:")
	if errMsg, exists := m.summarySourceErr[id]; exists {
		allLines = append(allLines, "  error: "+errMsg)
	} else {
		sources := m.summarySources[id]
		if len(sources) == 0 {
			allLines = append(allLines, "  (no source messages)")
		} else {
			for _, src := range sources {
				content := oneLine(src.content)
				content = truncateString(content, max(8, m.width-24))
				line := fmt.Sprintf("  #%d %s %s", src.id, strings.ToUpper(src.role), content)
				allLines = append(allLines, roleStyle(src.role).Render(line))
			}
		}
	}

	// Clamp scroll offset
	maxScroll := max(0, len(allLines)-detailHeight)
	m.summaryDetailScroll = clamp(m.summaryDetailScroll, 0, maxScroll)

	// Slice visible window
	start := m.summaryDetailScroll
	end := min(len(allLines), start+detailHeight)
	visible := allLines[start:end]

	// Add scroll indicator
	if maxScroll > 0 {
		indicator := fmt.Sprintf(" [%d/%d lines, Shift+J/K to scroll]", m.summaryDetailScroll+detailHeight, len(allLines))
		if len(visible) > 0 {
			visible[0] = visible[0] + helpStyle.Render(indicator)
		}
	}

	return padLines(visible, detailHeight)
}

var (
	fileIDStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("183"))
	fileMimeStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("245"))
)

func (m model) renderFiles() string {
	if len(m.largeFiles) == 0 {
		return "No large files found for this session"
	}

	available := max(4, m.height-4)
	detailHeight := max(7, available/2)
	listHeight := max(3, available-detailHeight-1)

	listOffsetValue := listOffset(m.fileCursor, len(m.largeFiles), listHeight)
	listLines := make([]string, 0, listHeight)
	for idx := listOffsetValue; idx < min(len(m.largeFiles), listOffsetValue+listHeight); idx++ {
		f := m.largeFiles[idx]
		sizeStr := formatByteSizeCompact(f.byteSize)
		line := fmt.Sprintf("  %s  %s  %s  %s  %s",
			fileIDStyle.Render(f.fileID),
			f.displayName(),
			fileMimeStyle.Render(f.mimeType),
			sizeStr,
			formatTimestamp(f.createdAt))
		if idx == m.fileCursor {
			line = selectedStyle.Render(fmt.Sprintf("> %s  %s  %s  %s  %s",
				f.fileID,
				f.displayName(),
				f.mimeType,
				sizeStr,
				formatTimestamp(f.createdAt)))
		}
		listLines = append(listLines, line)
	}

	detailLines := m.renderFileDetail(detailHeight)
	return strings.Join(listLines, "\n") + "\n" + helpStyle.Render(strings.Repeat("-", max(20, m.width-1))) + "\n" + strings.Join(detailLines, "\n")
}

func (m model) renderFileDetail(detailHeight int) []string {
	lines := make([]string, 0, detailHeight)
	if m.fileCursor < 0 || m.fileCursor >= len(m.largeFiles) {
		return append(lines, "No file selected")
	}
	f := m.largeFiles[m.fileCursor]

	lines = append(lines, fmt.Sprintf("File: %s", f.fileID))
	lines = append(lines, fmt.Sprintf("Name: %s  MIME: %s  Size: %s  Created: %s",
		f.displayName(), f.mimeType, formatByteSizeCompact(f.byteSize), formatTimestamp(f.createdAt)))
	if f.storageURI != "" {
		lines = append(lines, fmt.Sprintf("Storage: %s", f.storageURI))
	}
	lines = append(lines, "")
	lines = append(lines, "Exploration Summary:")

	summary := strings.TrimSpace(f.explorationSummary)
	if summary == "" {
		summary = "(no exploration summary)"
	}
	wrappedSummary := wrapText(summary, max(20, m.width-4))
	for _, line := range strings.Split(wrappedSummary, "\n") {
		if len(lines) >= detailHeight {
			break
		}
		lines = append(lines, "  "+line)
	}
	return padLines(lines, detailHeight)
}

func (m model) renderContext() string {
	if len(m.contextItems) == 0 {
		return "No context items found for this session"
	}

	available := max(4, m.height-4)
	detailHeight := max(7, available/3)
	listHeight := max(3, available-detailHeight-1)

	listOffsetValue := listOffset(m.contextCursor, len(m.contextItems), listHeight)
	listLines := make([]string, 0, listHeight)
	for idx := listOffsetValue; idx < min(len(m.contextItems), listOffsetValue+listHeight); idx++ {
		item := m.contextItems[idx]
		line := m.formatContextItemLine(item)
		if idx == m.contextCursor {
			line = selectedStyle.Render(line)
		}
		listLines = append(listLines, line)
	}

	detailLines := m.renderContextDetail(detailHeight)
	return strings.Join(listLines, "\n") + "\n" + helpStyle.Render(strings.Repeat("-", max(20, m.width-1))) + "\n" + strings.Join(detailLines, "\n")
}

func (m model) formatContextItemLine(item contextItemEntry) string {
	maxPreview := max(8, m.width-60)
	preview := truncateString(item.preview, maxPreview)

	if item.itemType == "summary" {
		kindLabel := item.kind
		if item.kind == "condensed" {
			kindLabel = fmt.Sprintf("d%d", item.depth)
		}
		return fmt.Sprintf("  %3d  %-10s [%s, %dt] %s",
			item.ordinal, kindLabel, item.summaryID[:min(16, len(item.summaryID))], item.tokenCount, preview)
	}
	// message
	roleStyle := roleUserStyle
	switch item.kind {
	case "assistant":
		roleStyle = roleAssistantStyle
	case "system":
		roleStyle = roleSystemStyle
	case "tool":
		roleStyle = roleToolStyle
	}
	return fmt.Sprintf("  %3d  %-10s [msg %d, %dt] %s",
		item.ordinal, roleStyle.Render(item.kind), item.messageID, item.tokenCount, preview)
}

func (m *model) renderContextDetail(detailHeight int) []string {
	if m.contextCursor < 0 || m.contextCursor >= len(m.contextItems) {
		return padLines([]string{"No item selected"}, detailHeight)
	}
	item := m.contextItems[m.contextCursor]

	var allLines []string
	if item.itemType == "summary" {
		kindLabel := item.kind
		if item.kind == "condensed" {
			kindLabel = fmt.Sprintf("condensed d%d", item.depth)
		}
		allLines = append(allLines, fmt.Sprintf("Summary: %s [%s]", item.summaryID, kindLabel))
		allLines = append(allLines, fmt.Sprintf("Tokens: %d  Created: %s", item.tokenCount, formatTimestamp(item.createdAt)))
	} else {
		allLines = append(allLines, fmt.Sprintf("Message: #%d [%s]", item.messageID, item.kind))
		allLines = append(allLines, fmt.Sprintf("Tokens: %d  Created: %s", item.tokenCount, formatTimestamp(item.createdAt)))
	}
	allLines = append(allLines, "")
	content := strings.TrimSpace(item.content)
	if content == "" {
		content = "(empty)"
	}
	wrapped := wrapText(content, max(20, m.width-4))
	for _, line := range strings.Split(wrapped, "\n") {
		allLines = append(allLines, "  "+line)
	}

	// Clamp scroll offset
	maxScroll := max(0, len(allLines)-detailHeight)
	m.contextDetailScroll = clamp(m.contextDetailScroll, 0, maxScroll)

	// Slice visible window
	start := m.contextDetailScroll
	end := min(len(allLines), start+detailHeight)
	visible := allLines[start:end]

	// Add scroll indicator
	if maxScroll > 0 {
		indicator := fmt.Sprintf(" [%d/%d lines, Shift+J/K to scroll]", m.contextDetailScroll+detailHeight, len(allLines))
		if len(visible) > 0 {
			visible[0] = visible[0] + helpStyle.Render(indicator)
		}
	}

	return padLines(visible, detailHeight)
}

func (m *model) resizeViewport() {
	width := max(20, m.width-2)
	height := max(3, m.height-4)
	if m.convViewport.Width == 0 {
		m.convViewport = viewport.New(width, height)
		return
	}
	m.convViewport.Width = width
	m.convViewport.Height = height
}

func (m *model) refreshConversationViewport() {
	if m.convViewport.Width <= 0 || m.convViewport.Height <= 0 {
		return
	}
	if len(m.messages) == 0 {
		m.convViewport.SetContent("No messages loaded")
		m.convViewport.GotoTop()
		return
	}
	content := renderConversationText(m.messages, m.convViewport.Width)
	m.convViewport.SetContent(content)
	m.convViewport.GotoBottom()
}

func renderConversationText(messages []sessionMessage, width int) string {
	maxWidth := max(20, width-2)
	chunks := make([]string, 0, len(messages))
	for _, msg := range messages {
		timestamp := formatTimestamp(msg.timestamp)
		header := strings.TrimSpace(fmt.Sprintf("%s  %s", timestamp, strings.ToUpper(msg.role)))
		if header == "" {
			header = strings.ToUpper(msg.role)
		}

		body := msg.text
		if strings.TrimSpace(body) == "" {
			body = "(no text content)"
		}

		wrapped := wrapText(body, maxWidth)
		styledHeader := roleStyle(msg.role).Bold(true).Render(header)
		styledBody := roleStyle(msg.role).Render(indentLines(wrapped, "  "))
		chunks = append(chunks, styledHeader+"\n"+styledBody)
	}
	return strings.Join(chunks, "\n\n")
}

func colorizeDiffLine(line string) string {
	switch {
	case strings.HasPrefix(line, "+++"), strings.HasPrefix(line, "---"):
		return diffHeaderStyle.Render(line)
	case strings.HasPrefix(line, "@@"):
		return diffHunkStyle.Render(line)
	case strings.HasPrefix(line, "+"):
		return diffAddStyle.Render(line)
	case strings.HasPrefix(line, "-"):
		return diffRemStyle.Render(line)
	default:
		return line
	}
}

func wrapText(text string, width int) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	wrapped := wordwrap.String(trimmed, width)
	return strings.ReplaceAll(wrapped, "\r", "")
}

func indentLines(text, prefix string) string {
	lines := strings.Split(text, "\n")
	for idx := range lines {
		lines[idx] = prefix + lines[idx]
	}
	return strings.Join(lines, "\n")
}

func roleStyle(role string) lipgloss.Style {
	switch strings.ToLower(role) {
	case "user":
		return roleUserStyle
	case "assistant":
		return roleAssistantStyle
	case "system":
		return roleSystemStyle
	case "tool", "toolresult":
		return roleToolStyle
	default:
		return roleToolStyle
	}
}

func formatMessageCount(count int) string {
	if count < 0 {
		return "?"
	}
	return fmt.Sprintf("%d", count)
}

func (m model) currentAgent() (agentEntry, bool) {
	if len(m.agents) == 0 || m.agentCursor < 0 || m.agentCursor >= len(m.agents) {
		return agentEntry{}, false
	}
	return m.agents[m.agentCursor], true
}

func (m model) currentSession() (sessionEntry, bool) {
	if len(m.sessions) == 0 || m.sessionCursor < 0 || m.sessionCursor >= len(m.sessions) {
		return sessionEntry{}, false
	}
	return m.sessions[m.sessionCursor], true
}

func (m model) currentConversationID() (int64, bool) {
	session, ok := m.currentSession()
	if !ok || session.conversationID <= 0 {
		return 0, false
	}
	return session.conversationID, true
}

func (m model) currentSummaryID() (string, bool) {
	if len(m.summaryRows) == 0 || m.summaryCursor < 0 || m.summaryCursor >= len(m.summaryRows) {
		return "", false
	}
	return m.summaryRows[m.summaryCursor].summaryID, true
}

func listOffset(cursor, total, visible int) int {
	if total <= visible {
		return 0
	}
	offset := cursor - visible/2
	maxOffset := total - visible
	return clamp(offset, 0, maxOffset)
}

func oneLine(text string) string {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	fields := strings.Fields(trimmed)
	return strings.Join(fields, " ")
}

func truncateString(text string, width int) string {
	if width <= 0 {
		return ""
	}
	if len(text) <= width {
		return text
	}
	if width <= 1 {
		return text[:width]
	}
	if width <= 3 {
		return text[:width]
	}
	return text[:width-3] + "..."
}

func padLines(lines []string, minHeight int) []string {
	for len(lines) < minHeight {
		lines = append(lines, "")
	}
	return lines
}

func clamp(value, low, high int) int {
	if high < low {
		return low
	}
	if value < low {
		return low
	}
	if value > high {
		return high
	}
	return value
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func (m *model) loadInitialSessions(agent agentEntry) error {
	files, err := discoverSessionFiles(agent)
	if err != nil {
		return err
	}
	m.sessionFiles = files
	m.sessionFileCursor = 0
	m.sessions = nil
	loaded, err := m.appendSessionBatch(sessionInitialLoadSize)
	if err != nil {
		return err
	}
	m.sessionCursor = clamp(m.sessionCursor, 0, max(0, loaded-1))
	return nil
}

func (m *model) appendSessionBatch(limit int) (int, error) {
	batch, nextCursor, err := loadSessionBatch(m.sessionFiles, m.sessionFileCursor, limit, m.paths.lcmDBPath)
	if err != nil {
		return 0, err
	}
	m.sessionFileCursor = nextCursor
	m.sessions = append(m.sessions, batch...)
	return len(batch), nil
}

func (m *model) maybeLoadMoreSessions() int {
	if len(m.sessions)-m.sessionCursor > 3 {
		return 0
	}
	if m.sessionFileCursor >= len(m.sessionFiles) {
		return 0
	}
	loaded, err := m.appendSessionBatch(sessionBatchLoadSize)
	if err != nil {
		m.status = "Error: " + err.Error()
		return 0
	}
	if loaded > 0 {
		m.status = fmt.Sprintf("Loaded %d of %d sessions", len(m.sessions), len(m.sessionFiles))
	}
	return loaded
}
