package main

import (
	"context"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestHasCodexOAuth(t *testing.T) {
	tests := []struct {
		name  string
		setup func(t *testing.T, home string)
		want  bool
	}{
		{
			name:  "no ~/.codex dir",
			setup: func(t *testing.T, home string) {},
			want:  false,
		},
		{
			name: "auth.json absent",
			setup: func(t *testing.T, home string) {
				if err := os.MkdirAll(filepath.Join(home, ".codex"), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			want: false,
		},
		{
			name: "auth.json empty",
			setup: func(t *testing.T, home string) {
				dir := filepath.Join(home, ".codex")
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "auth.json"), nil, 0o600); err != nil {
					t.Fatal(err)
				}
			},
			want: false,
		},
		{
			name: "auth.json present with content",
			setup: func(t *testing.T, home string) {
				dir := filepath.Join(home, ".codex")
				if err := os.MkdirAll(dir, 0o755); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"access":"mock"}`), 0o600); err != nil {
					t.Fatal(err)
				}
			},
			want: true,
		},
		{
			name: "auth.json is a directory",
			setup: func(t *testing.T, home string) {
				if err := os.MkdirAll(filepath.Join(home, ".codex", "auth.json"), 0o755); err != nil {
					t.Fatal(err)
				}
			},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			home := t.TempDir()
			t.Setenv("HOME", home)
			tt.setup(t, home)
			if got := hasCodexOAuth(); got != tt.want {
				t.Fatalf("hasCodexOAuth() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSummarizeOpenAICodexOAuthDelegatesToCLI(t *testing.T) {
	seedCodexAuth(t)
	stubCodexCLI(t)

	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv("LCM_HELPER_STDOUT", "Codex CLI summary")
	t.Setenv("LCM_EXPECT_MODEL", "gpt-5.3-codex")
	t.Setenv("LCM_EXPECT_PROMPT_SHA256", hashPrompt(cliSummarizationSystemPrompt+"\n\n"+"say hello"))
	t.Setenv("OPENAI_API_KEY", "should-be-filtered")

	httpCalled := false
	client := &anthropicClient{
		provider: "openai-codex",
		apiKey:   "",
		model:    "gpt-5.3-codex",
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			httpCalled = true
			return jsonResponse(500, `{"error":"should not be called"}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "say hello", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if httpCalled {
		t.Fatal("HTTP transport was called for Codex OAuth path; expected delegation to codex CLI")
	}
	if summary != "Codex CLI summary" {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeOpenAICodexAPIKeyHitsDirectAPI(t *testing.T) {
	seedCodexAuth(t)

	var capturedAuth string
	client := &anthropicClient{
		provider: "openai-codex",
		apiKey:   "sk-oai-test-key",
		model:    "gpt-5.3-codex",
		baseURL:  "https://api.openai.com",
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			capturedAuth = req.Header.Get("Authorization")
			return jsonResponse(200, `{
				"output":[{"type":"message","content":[{"type":"output_text","text":"Direct API response."}]}]
			}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "prompt", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if capturedAuth != "Bearer sk-oai-test-key" {
		t.Fatalf("expected direct API bearer header, got %q", capturedAuth)
	}
	if summary != "Direct API response." {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeRejectsEmptyKeyForCodexWithoutOAuth(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)

	client := &anthropicClient{
		provider: "openai-codex",
		apiKey:   "",
		model:    "gpt-5.3-codex",
		http:     &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, nil })},
	}

	_, err := client.summarize(context.Background(), "prompt", 200)
	if err == nil {
		t.Fatal("expected summarize error when empty key and no Codex OAuth")
	}
	if !strings.Contains(err.Error(), "missing API key") {
		t.Fatalf("expected missing-key error, got %v", err)
	}
}

func TestResolveProviderAPIKeyOpenAICodexWithOAuthReturnsEmpty(t *testing.T) {
	seedCodexAuth(t)
	t.Setenv("OPENAI_API_KEY", "")

	paths := appDataPaths{
		openclawDir:      t.TempDir(),
		openclawCredsDir: t.TempDir(),
		openclawConfig:   filepath.Join(t.TempDir(), "openclaw.json"),
		openclawEnv:      filepath.Join(t.TempDir(), ".env"),
	}

	key, err := resolveProviderAPIKey(paths, "openai-codex")
	if err != nil {
		t.Fatalf("resolveProviderAPIKey returned error: %v", err)
	}
	if key != "" {
		t.Fatalf("expected empty key sentinel, got %q", key)
	}
}

func TestResolveProviderAPIKeyOpenAICodexHintsCodexLogin(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("OPENAI_API_KEY", "")

	configDir := t.TempDir()
	configPath := filepath.Join(configDir, "openclaw.json")
	if err := os.WriteFile(configPath, []byte(`{}`), 0o600); err != nil {
		t.Fatal(err)
	}
	paths := appDataPaths{
		openclawDir:      t.TempDir(),
		openclawCredsDir: t.TempDir(),
		openclawConfig:   configPath,
		openclawEnv:      filepath.Join(t.TempDir(), ".env"),
	}

	_, err := resolveProviderAPIKey(paths, "openai-codex")
	if err == nil {
		t.Fatal("expected resolveProviderAPIKey error when no key and no OAuth")
	}
	if !strings.Contains(err.Error(), "codex login") {
		t.Fatalf("expected error to suggest `codex login`, got %v", err)
	}
}

func TestSummarizeOpenAICodexOAuthMissingCLIReturnsActionableError(t *testing.T) {
	seedCodexAuth(t)

	originalLookup := lookupCLIPath
	lookupCLIPath = func(file string) (string, error) {
		if file != "codex" {
			t.Fatalf("unexpected lookup path: %q", file)
		}
		return "", exec.ErrNotFound
	}
	t.Cleanup(func() { lookupCLIPath = originalLookup })

	client := &anthropicClient{
		provider: "openai-codex",
		apiKey:   "",
		model:    "gpt-5.3-codex",
		http:     &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, nil })},
	}

	_, err := client.summarize(context.Background(), "prompt", 200)
	if err == nil {
		t.Fatal("expected error when codex CLI is missing")
	}
	msg := err.Error()
	if !strings.Contains(msg, "codex") || !strings.Contains(msg, "not found") {
		t.Fatalf("expected error to mention missing codex CLI, got %q", msg)
	}
	if !strings.Contains(msg, "OPENAI_API_KEY") {
		t.Fatalf("expected error to mention OPENAI_API_KEY fallback, got %q", msg)
	}
}

func TestSummarizeOpenAICodexOAuthSurfacesCLIStderr(t *testing.T) {
	seedCodexAuth(t)
	stubCodexCLI(t)

	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv("LCM_EXPECT_MODEL", "gpt-5.3-codex")
	t.Setenv("LCM_HELPER_STDERR", "codex: refresh failed 401")
	t.Setenv("LCM_HELPER_EXIT_CODE", "2")

	client := &anthropicClient{
		provider: "openai-codex",
		apiKey:   "",
		model:    "gpt-5.3-codex",
		http:     &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, nil })},
	}

	_, err := client.summarize(context.Background(), "prompt", 200)
	if err == nil {
		t.Fatal("expected error when codex CLI exits non-zero")
	}
	msg := err.Error()
	if !strings.Contains(msg, "codex CLI exited 2") {
		t.Fatalf("expected exit code in error, got %q", msg)
	}
	if !strings.Contains(msg, "refresh failed") {
		t.Fatalf("expected stderr text in error, got %q", msg)
	}
}

func TestSummarizeOpenAICodexOAuthRejectsEmptyCLIOutput(t *testing.T) {
	seedCodexAuth(t)
	stubCodexCLI(t)

	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv("LCM_EXPECT_MODEL", "gpt-5.3-codex")
	t.Setenv("LCM_HELPER_STDOUT", "")

	client := &anthropicClient{
		provider: "openai-codex",
		apiKey:   "",
		model:    "gpt-5.3-codex",
		http:     &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, nil })},
	}

	_, err := client.summarize(context.Background(), "prompt", 200)
	if err == nil {
		t.Fatal("expected error when codex CLI returns empty output")
	}
	if !strings.Contains(err.Error(), "empty output") {
		t.Fatalf("expected empty-output error, got %v", err)
	}
}

func TestSummarizeOpenAICodexOAuthRejectsOversizeCLIOutput(t *testing.T) {
	seedCodexAuth(t)
	stubCodexCLI(t)

	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv("LCM_EXPECT_MODEL", "gpt-5.3-codex")
	t.Setenv("LCM_HELPER_STDOUT", strings.Repeat("word ", 200))

	client := &anthropicClient{
		provider: "openai-codex",
		apiKey:   "",
		model:    "gpt-5.3-codex",
		http:     &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, nil })},
	}

	_, err := client.summarize(context.Background(), "prompt", 32)
	if err == nil {
		t.Fatal("expected error when codex CLI output exceeds token budget")
	}
	if !strings.Contains(err.Error(), "exceeded target token budget") {
		t.Fatalf("expected token-budget error, got %v", err)
	}
}

func TestFilteredOpenAIChildEnv(t *testing.T) {
	in := []string{
		"PATH=/usr/bin",
		"HOME=/root",
		"OPENAI_API_KEY=sk-leak",
		"OPENAI_BASE_URL=https://evil.example.com",
		"OPENAI_ORG_ID=org-abc",
		"OPENAI_PROJECT=proj-xyz",
		"LANG=en_US.UTF-8",
		"ANTHROPIC_API_KEY=sk-ant-untouched",
	}
	out := filteredOpenAIChildEnv(append([]string(nil), in...))

	for _, e := range out {
		if strings.HasPrefix(e, "OPENAI_") {
			t.Fatalf("OPENAI_* leaked: %q", e)
		}
	}

	seenAnthropic := false
	seenPath := false
	for _, e := range out {
		if e == "ANTHROPIC_API_KEY=sk-ant-untouched" {
			seenAnthropic = true
		}
		if e == "PATH=/usr/bin" {
			seenPath = true
		}
	}
	if !seenAnthropic {
		t.Fatal("expected ANTHROPIC_API_KEY to survive filter")
	}
	if !seenPath {
		t.Fatal("expected PATH to survive filter")
	}
}

// seedCodexAuth writes a minimal ~/.codex/auth.json into a temp HOME so
// hasCodexOAuth() returns true for the duration of the test.
func seedCodexAuth(t *testing.T) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("HOME", home)
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(`{"access":"mock"}`), 0o600); err != nil {
		t.Fatal(err)
	}
}

func stubCodexCLI(t *testing.T) {
	t.Helper()

	originalLookup := lookupCLIPath
	originalExec := execCLICommand
	lookupCLIPath = func(file string) (string, error) {
		if file != "codex" {
			t.Fatalf("unexpected lookup path: %q", file)
		}
		return "/tmp/fake-codex", nil
	}
	execCLICommand = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		cmdArgs := append([]string{"-test.run=TestHelperProcessCodexCLI", "--", name}, args...)
		return exec.CommandContext(ctx, os.Args[0], cmdArgs...)
	}
	t.Cleanup(func() {
		lookupCLIPath = originalLookup
		execCLICommand = originalExec
	})
}

func TestHelperProcessCodexCLI(t *testing.T) {
	t.Helper()
	if os.Getenv("GO_WANT_HELPER_PROCESS") != "1" {
		return
	}

	args := os.Args
	separator := -1
	for i, arg := range args {
		if arg == "--" {
			separator = i
			break
		}
	}
	if separator == -1 || separator+1 >= len(args) {
		_, _ = os.Stderr.WriteString("missing helper args")
		os.Exit(2)
	}

	cliArgs := args[separator+2:]
	expectedModel := os.Getenv("LCM_EXPECT_MODEL")
	expectedPromptHash := os.Getenv("LCM_EXPECT_PROMPT_SHA256")

	for _, e := range os.Environ() {
		if strings.HasPrefix(e, "OPENAI_") {
			_, _ = os.Stderr.WriteString("OPENAI_* env var leaked to child: " + e)
			os.Exit(3)
		}
	}
	if !containsArgs(cliArgs, "exec") {
		_, _ = os.Stderr.WriteString("missing exec subcommand")
		os.Exit(4)
	}
	if !containsArgs(cliArgs, "--skip-git-repo-check") {
		_, _ = os.Stderr.WriteString("missing --skip-git-repo-check")
		os.Exit(5)
	}
	if !containsArgs(cliArgs, "--ephemeral") {
		_, _ = os.Stderr.WriteString("missing --ephemeral")
		os.Exit(6)
	}
	if !containsArgPair(cliArgs, "--color", "never") {
		_, _ = os.Stderr.WriteString("missing --color never")
		os.Exit(13)
	}
	if !containsArgPair(cliArgs, "--sandbox", "read-only") {
		_, _ = os.Stderr.WriteString("missing --sandbox read-only")
		os.Exit(14)
	}
	if !containsArgs(cliArgs, "-") {
		_, _ = os.Stderr.WriteString("missing positional `-` for stdin prompt")
		os.Exit(15)
	}
	if expectedModel != "" && !containsArgPair(cliArgs, "-m", expectedModel) {
		_, _ = os.Stderr.WriteString("missing or wrong model")
		os.Exit(7)
	}
	outputPath := extractArgValue(cliArgs, "--output-last-message")
	if outputPath == "" {
		_, _ = os.Stderr.WriteString("missing --output-last-message")
		os.Exit(8)
	}

	if expectedPromptHash != "" {
		prompt, err := io.ReadAll(os.Stdin)
		if err != nil {
			_, _ = os.Stderr.WriteString("failed to read stdin")
			os.Exit(9)
		}
		if hashPrompt(string(prompt)) != expectedPromptHash {
			_, _ = os.Stderr.WriteString("stdin prompt hash mismatch")
			os.Exit(10)
		}
	}

	if err := os.WriteFile(outputPath, []byte(os.Getenv("LCM_HELPER_STDOUT")), 0o600); err != nil {
		_, _ = os.Stderr.WriteString("failed to write output file")
		os.Exit(11)
	}
	if stderr := os.Getenv("LCM_HELPER_STDERR"); stderr != "" {
		_, _ = os.Stderr.WriteString(stderr)
	}
	if codeText := strings.TrimSpace(os.Getenv("LCM_HELPER_EXIT_CODE")); codeText != "" {
		code, err := strconv.Atoi(codeText)
		if err != nil {
			_, _ = os.Stderr.WriteString("bad exit code")
			os.Exit(12)
		}
		os.Exit(code)
	}
	os.Exit(0)
}

func extractArgValue(args []string, flag string) string {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag {
			return args[i+1]
		}
	}
	return ""
}
