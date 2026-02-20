package main

import (
	"bytes"
	"embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/template"
)

const defaultPromptOverrideDir = "~/.config/lcm-tui/prompts"

var promptTemplateNames = []string{
	"leaf.tmpl",
	"condensed-d1.tmpl",
	"condensed-d2.tmpl",
	"condensed-d3.tmpl",
}

// defaultPromptFS stores the built-in prompt templates.
//
//go:embed prompts/*.tmpl
var defaultPromptFS embed.FS

// PromptVars is the template data passed into depth-aware prompt templates.
type PromptVars struct {
	TargetTokens    int
	PreviousContext string
	ChildCount      int
	TimeRange       string
	Depth           int
	SourceText      string
}

type promptSource struct {
	name string
	kind string // "filesystem" or "embedded"
	path string
}

type promptsOptions struct {
	list            bool
	exportDir       string
	showName        string
	diffName        string
	renderName      string
	targetTokens    int
	previousContext string
	childCount      int
	timeRange       string
	depth           int
	sourceText      string
	promptDir       string
}

// runPromptsCommand executes prompt template maintenance commands.
func runPromptsCommand(args []string) error {
	opts, err := parsePromptsArgs(args)
	if err != nil {
		return err
	}

	actions := 0
	if opts.list {
		actions++
	}
	if opts.exportDir != "" {
		actions++
	}
	if opts.showName != "" {
		actions++
	}
	if opts.diffName != "" {
		actions++
	}
	if opts.renderName != "" {
		actions++
	}
	if actions == 0 {
		return fmt.Errorf("one action is required\n%s", promptsUsageText())
	}
	if actions > 1 {
		return fmt.Errorf("only one action can be used at a time\n%s", promptsUsageText())
	}

	switch {
	case opts.list:
		return listPromptSources(opts.promptDir)
	case opts.exportDir != "":
		return exportPromptDefaults(opts.exportDir)
	case opts.showName != "":
		return showActivePrompt(opts.showName, opts.promptDir)
	case opts.diffName != "":
		return diffPromptTemplate(opts.diffName, opts.promptDir)
	case opts.renderName != "":
		return renderPromptTemplate(opts)
	default:
		return fmt.Errorf("unknown prompts action\n%s", promptsUsageText())
	}
}

func parsePromptsArgs(args []string) (promptsOptions, error) {
	opts := promptsOptions{
		targetTokens: condensedTargetTokens,
		childCount:   4,
		timeRange:    "2026-02-17 15:37 - 2026-02-17 21:14 UTC",
		sourceText:   "[2026-02-17 15:37 UTC] [user] Example source context.\n[2026-02-17 16:10 UTC] [assistant] Example follow-up details.",
		depth:        -1,
	}

	for i := 0; i < len(args); i++ {
		arg := args[i]
		nextValue := func(flagName string) (string, error) {
			if i+1 >= len(args) {
				return "", fmt.Errorf("missing value for %s", flagName)
			}
			i++
			return args[i], nil
		}

		switch {
		case arg == "--list":
			opts.list = true
		case arg == "--export":
			if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				i++
				opts.exportDir = args[i]
			} else {
				opts.exportDir = defaultPromptOverrideDir
			}
		case strings.HasPrefix(arg, "--export="):
			opts.exportDir = strings.TrimSpace(strings.TrimPrefix(arg, "--export="))
			if opts.exportDir == "" {
				opts.exportDir = defaultPromptOverrideDir
			}
		case arg == "--show":
			value, err := nextValue("--show")
			if err != nil {
				return promptsOptions{}, err
			}
			opts.showName = value
		case strings.HasPrefix(arg, "--show="):
			opts.showName = strings.TrimSpace(strings.TrimPrefix(arg, "--show="))
		case arg == "--diff":
			value, err := nextValue("--diff")
			if err != nil {
				return promptsOptions{}, err
			}
			opts.diffName = value
		case strings.HasPrefix(arg, "--diff="):
			opts.diffName = strings.TrimSpace(strings.TrimPrefix(arg, "--diff="))
		case arg == "--render":
			value, err := nextValue("--render")
			if err != nil {
				return promptsOptions{}, err
			}
			opts.renderName = value
		case strings.HasPrefix(arg, "--render="):
			opts.renderName = strings.TrimSpace(strings.TrimPrefix(arg, "--render="))
		case arg == "--target-tokens":
			value, err := nextValue("--target-tokens")
			if err != nil {
				return promptsOptions{}, err
			}
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return promptsOptions{}, fmt.Errorf("parse --target-tokens: %w", err)
			}
			opts.targetTokens = parsed
		case strings.HasPrefix(arg, "--target-tokens="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--target-tokens="))
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return promptsOptions{}, fmt.Errorf("parse --target-tokens: %w", err)
			}
			opts.targetTokens = parsed
		case arg == "--previous-context":
			value, err := nextValue("--previous-context")
			if err != nil {
				return promptsOptions{}, err
			}
			opts.previousContext = value
		case strings.HasPrefix(arg, "--previous-context="):
			opts.previousContext = strings.TrimSpace(strings.TrimPrefix(arg, "--previous-context="))
		case arg == "--child-count":
			value, err := nextValue("--child-count")
			if err != nil {
				return promptsOptions{}, err
			}
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return promptsOptions{}, fmt.Errorf("parse --child-count: %w", err)
			}
			opts.childCount = parsed
		case strings.HasPrefix(arg, "--child-count="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--child-count="))
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return promptsOptions{}, fmt.Errorf("parse --child-count: %w", err)
			}
			opts.childCount = parsed
		case arg == "--time-range":
			value, err := nextValue("--time-range")
			if err != nil {
				return promptsOptions{}, err
			}
			opts.timeRange = value
		case strings.HasPrefix(arg, "--time-range="):
			opts.timeRange = strings.TrimSpace(strings.TrimPrefix(arg, "--time-range="))
		case arg == "--depth":
			value, err := nextValue("--depth")
			if err != nil {
				return promptsOptions{}, err
			}
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return promptsOptions{}, fmt.Errorf("parse --depth: %w", err)
			}
			opts.depth = parsed
		case strings.HasPrefix(arg, "--depth="):
			value := strings.TrimSpace(strings.TrimPrefix(arg, "--depth="))
			parsed, err := strconv.Atoi(value)
			if err != nil {
				return promptsOptions{}, fmt.Errorf("parse --depth: %w", err)
			}
			opts.depth = parsed
		case arg == "--source-text":
			value, err := nextValue("--source-text")
			if err != nil {
				return promptsOptions{}, err
			}
			opts.sourceText = value
		case strings.HasPrefix(arg, "--source-text="):
			opts.sourceText = strings.TrimSpace(strings.TrimPrefix(arg, "--source-text="))
		case arg == "--prompt-dir":
			value, err := nextValue("--prompt-dir")
			if err != nil {
				return promptsOptions{}, err
			}
			opts.promptDir = value
		case strings.HasPrefix(arg, "--prompt-dir="):
			opts.promptDir = strings.TrimSpace(strings.TrimPrefix(arg, "--prompt-dir="))
		case arg == "-h" || arg == "--help":
			return promptsOptions{}, errors.New(promptsUsageText())
		default:
			return promptsOptions{}, fmt.Errorf("unknown argument %q\n%s", arg, promptsUsageText())
		}
	}

	if opts.targetTokens <= 0 {
		return promptsOptions{}, fmt.Errorf("--target-tokens must be > 0\n%s", promptsUsageText())
	}
	if opts.childCount < 0 {
		return promptsOptions{}, fmt.Errorf("--child-count must be >= 0\n%s", promptsUsageText())
	}
	if opts.exportDir != "" {
		opts.exportDir = expandHomePath(opts.exportDir)
	}
	if opts.promptDir != "" {
		opts.promptDir = expandHomePath(opts.promptDir)
	}
	return opts, nil
}

func promptsUsageText() string {
	return strings.TrimSpace(`Usage:
  lcm-tui prompts --list [--prompt-dir <dir>]
  lcm-tui prompts --export [dir]
  lcm-tui prompts --show <name> [--prompt-dir <dir>]
  lcm-tui prompts --diff <name> [--prompt-dir <dir>]
  lcm-tui prompts --render <name> --target-tokens <n> [--previous-context <text>] [--prompt-dir <dir>]
`)
}

func listPromptSources(overrideDir string) error {
	for _, name := range promptTemplateNames {
		source, err := resolvePromptSource(name, overrideDir)
		if err != nil {
			return err
		}
		if source.kind == "filesystem" {
			fmt.Printf("%-18s %s (override)\n", name, source.path)
			continue
		}
		fmt.Printf("%-18s embedded (no override)\n", name)
	}
	return nil
}

func exportPromptDefaults(dir string) error {
	if strings.TrimSpace(dir) == "" {
		dir = expandHomePath(defaultPromptOverrideDir)
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("create prompt export dir %q: %w", dir, err)
	}
	for _, name := range promptTemplateNames {
		content, err := readEmbeddedPromptTemplate(name)
		if err != nil {
			return err
		}
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
			return fmt.Errorf("write %s: %w", path, err)
		}
	}
	fmt.Printf("Exported %d prompt templates to %s\n", len(promptTemplateNames), dir)
	return nil
}

func showActivePrompt(name, overrideDir string) error {
	normalized, err := normalizePromptTemplateName(name)
	if err != nil {
		return err
	}
	content, source, err := loadPromptTemplateContent(normalized, overrideDir)
	if err != nil {
		return err
	}
	if source.kind == "filesystem" {
		fmt.Printf("# Source: %s\n\n", source.path)
	} else {
		fmt.Printf("# Source: embedded (%s)\n\n", normalized)
	}
	fmt.Print(content)
	if !strings.HasSuffix(content, "\n") {
		fmt.Println()
	}
	return nil
}

func diffPromptTemplate(name, overrideDir string) error {
	normalized, err := normalizePromptTemplateName(name)
	if err != nil {
		return err
	}
	overridePath, overrideContent, found, err := loadPromptOverrideContent(normalized, overrideDir)
	if err != nil {
		return err
	}
	if !found {
		return fmt.Errorf("no override found for %s (checked %s)", normalized, strings.Join(promptCandidatePaths(normalized, overrideDir), ", "))
	}
	embedded, err := readEmbeddedPromptTemplate(normalized)
	if err != nil {
		return err
	}
	diff := buildUnifiedDiff("embedded/"+normalized, overridePath, embedded, overrideContent)
	fmt.Print(diff)
	if !strings.HasSuffix(diff, "\n") {
		fmt.Println()
	}
	return nil
}

func renderPromptTemplate(opts promptsOptions) error {
	normalized, err := normalizePromptTemplateName(opts.renderName)
	if err != nil {
		return err
	}
	depth := opts.depth
	if depth < 0 {
		depth, err = depthForPromptName(normalized)
		if err != nil {
			return err
		}
	}
	vars := PromptVars{
		TargetTokens:    opts.targetTokens,
		PreviousContext: opts.previousContext,
		ChildCount:      opts.childCount,
		TimeRange:       opts.timeRange,
		Depth:           depth,
		SourceText:      opts.sourceText,
	}
	prompt, err := renderPromptByName(normalized, vars, opts.promptDir)
	if err != nil {
		return err
	}
	fmt.Print(prompt)
	if !strings.HasSuffix(prompt, "\n") {
		fmt.Println()
	}
	return nil
}

// promptNameForDepth maps summary depth to prompt filename.
func promptNameForDepth(depth int) string {
	switch {
	case depth <= 0:
		return "leaf.tmpl"
	case depth == 1:
		return "condensed-d1.tmpl"
	case depth == 2:
		return "condensed-d2.tmpl"
	default:
		return "condensed-d3.tmpl"
	}
}

// loadPromptTemplate resolves prompt source and parses a template.
func loadPromptTemplate(name, overrideDir string) (*template.Template, error) {
	normalized, err := normalizePromptTemplateName(name)
	if err != nil {
		return nil, err
	}
	content, _, err := loadPromptTemplateContent(normalized, overrideDir)
	if err != nil {
		return nil, err
	}
	tmpl, err := template.New(normalized).Parse(content)
	if err != nil {
		return nil, fmt.Errorf("parse prompt template %s: %w", normalized, err)
	}
	return tmpl, nil
}

// renderPrompt loads the depth-mapped template and executes it with vars.
func renderPrompt(depth int, vars PromptVars, overrideDir string) (string, error) {
	name := promptNameForDepth(depth)
	return renderPromptByName(name, vars, overrideDir)
}

func renderPromptByName(name string, vars PromptVars, overrideDir string) (string, error) {
	tmpl, err := loadPromptTemplate(name, overrideDir)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, vars); err != nil {
		return "", fmt.Errorf("execute prompt template %s: %w", name, err)
	}
	return buf.String(), nil
}

func resolvePromptSource(name, overrideDir string) (promptSource, error) {
	normalized, err := normalizePromptTemplateName(name)
	if err != nil {
		return promptSource{}, err
	}
	_, source, err := loadPromptTemplateContent(normalized, overrideDir)
	if err != nil {
		return promptSource{}, err
	}
	return source, nil
}

func loadPromptTemplateContent(name, overrideDir string) (string, promptSource, error) {
	for _, path := range promptCandidatePaths(name, overrideDir) {
		data, err := os.ReadFile(path)
		if err == nil {
			return string(data), promptSource{name: name, kind: "filesystem", path: path}, nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return "", promptSource{}, fmt.Errorf("read prompt template %s: %w", path, err)
		}
	}
	content, err := readEmbeddedPromptTemplate(name)
	if err != nil {
		return "", promptSource{}, err
	}
	return content, promptSource{name: name, kind: "embedded", path: "prompts/" + name}, nil
}

func loadPromptOverrideContent(name, overrideDir string) (path, content string, found bool, err error) {
	for _, candidate := range promptCandidatePaths(name, overrideDir) {
		data, readErr := os.ReadFile(candidate)
		if readErr == nil {
			return candidate, string(data), true, nil
		}
		if !errors.Is(readErr, os.ErrNotExist) {
			return "", "", false, fmt.Errorf("read prompt override %s: %w", candidate, readErr)
		}
	}
	return "", "", false, nil
}

func readEmbeddedPromptTemplate(name string) (string, error) {
	normalized, err := normalizePromptTemplateName(name)
	if err != nil {
		return "", err
	}
	data, err := defaultPromptFS.ReadFile("prompts/" + normalized)
	if err != nil {
		return "", fmt.Errorf("read embedded prompt template %s: %w", normalized, err)
	}
	return string(data), nil
}

func promptCandidatePaths(name, overrideDir string) []string {
	paths := make([]string, 0, 2)
	if strings.TrimSpace(overrideDir) != "" {
		paths = append(paths, filepath.Join(expandHomePath(overrideDir), name))
	}
	defaultPath := filepath.Join(expandHomePath(defaultPromptOverrideDir), name)
	if len(paths) == 0 || paths[0] != defaultPath {
		paths = append(paths, defaultPath)
	}
	return paths
}

func normalizePromptTemplateName(name string) (string, error) {
	trimmed := strings.TrimSpace(strings.ToLower(name))
	if trimmed == "" {
		return "", fmt.Errorf("template name is required")
	}
	if !strings.HasSuffix(trimmed, ".tmpl") {
		trimmed += ".tmpl"
	}
	for _, candidate := range promptTemplateNames {
		if candidate == trimmed {
			return trimmed, nil
		}
	}
	return "", fmt.Errorf("unknown prompt template %q", name)
}

func depthForPromptName(name string) (int, error) {
	normalized, err := normalizePromptTemplateName(name)
	if err != nil {
		return 0, err
	}
	switch normalized {
	case "leaf.tmpl":
		return 0, nil
	case "condensed-d1.tmpl":
		return 1, nil
	case "condensed-d2.tmpl":
		return 2, nil
	case "condensed-d3.tmpl":
		return 3, nil
	default:
		return 0, fmt.Errorf("unsupported prompt template %s", normalized)
	}
}

func expandHomePath(path string) string {
	trimmed := strings.TrimSpace(path)
	if trimmed == "" {
		return trimmed
	}
	if trimmed == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return trimmed
		}
		return home
	}
	if !strings.HasPrefix(trimmed, "~/") {
		return trimmed
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return trimmed
	}
	return filepath.Join(home, strings.TrimPrefix(trimmed, "~/"))
}

type diffOp struct {
	kind byte
	line string
}

func buildUnifiedDiff(oldName, newName, oldContent, newContent string) string {
	if oldContent == newContent {
		return fmt.Sprintf("--- %s\n+++ %s\n(no differences)\n", oldName, newName)
	}

	oldLines := strings.Split(oldContent, "\n")
	newLines := strings.Split(newContent, "\n")
	ops := lineDiff(oldLines, newLines)

	var b strings.Builder
	b.WriteString("--- ")
	b.WriteString(oldName)
	b.WriteByte('\n')
	b.WriteString("+++ ")
	b.WriteString(newName)
	b.WriteByte('\n')
	b.WriteString(fmt.Sprintf("@@ -1,%d +1,%d @@\n", len(oldLines), len(newLines)))
	for _, op := range ops {
		b.WriteByte(op.kind)
		b.WriteString(op.line)
		b.WriteByte('\n')
	}
	return b.String()
}

// lineDiff computes a stable line-level edit script using LCS.
func lineDiff(oldLines, newLines []string) []diffOp {
	n := len(oldLines)
	m := len(newLines)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if oldLines[i] == newLines[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}

	ops := make([]diffOp, 0, n+m)
	i := 0
	j := 0
	for i < n && j < m {
		switch {
		case oldLines[i] == newLines[j]:
			ops = append(ops, diffOp{kind: ' ', line: oldLines[i]})
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			ops = append(ops, diffOp{kind: '-', line: oldLines[i]})
			i++
		default:
			ops = append(ops, diffOp{kind: '+', line: newLines[j]})
			j++
		}
	}
	for i < n {
		ops = append(ops, diffOp{kind: '-', line: oldLines[i]})
		i++
	}
	for j < m {
		ops = append(ops, diffOp{kind: '+', line: newLines[j]})
		j++
	}
	return ops
}
