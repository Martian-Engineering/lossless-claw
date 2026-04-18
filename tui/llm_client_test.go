package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (fn roundTripFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func jsonResponse(statusCode int, body string) *http.Response {
	return &http.Response{
		StatusCode: statusCode,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func TestResolveSummaryProviderModel(t *testing.T) {
	provider, model := resolveSummaryProviderModel("", "gpt-5.3-codex")
	if provider != "openai" {
		t.Fatalf("expected provider openai, got %q", provider)
	}
	if model != "gpt-5.3-codex" {
		t.Fatalf("expected model gpt-5.3-codex, got %q", model)
	}

	provider, model = resolveSummaryProviderModel("", "openai/gpt-5.3-codex")
	if provider != "openai" || model != "gpt-5.3-codex" {
		t.Fatalf("expected openai/gpt-5.3-codex, got %q/%q", provider, model)
	}
}

func TestExtractOpenAISummaryFromOutputAndReasoningBlocks(t *testing.T) {
	body := []byte(`{
		"id":"resp_1",
		"output":[
			{
				"type":"reasoning",
				"summary":[{"type":"summary_text","text":"Reasoning summary line."}]
			},
			{
				"type":"message",
				"role":"assistant",
				"content":[{"type":"output_text","text":"Final condensed summary."}]
			}
		]
	}`)

	summary, blockTypes, err := extractOpenAISummary(body)
	if err != nil {
		t.Fatalf("extractOpenAISummary error: %v", err)
	}
	if !strings.Contains(summary, "Final condensed summary.") {
		t.Fatalf("expected summary to include final output text, got %q", summary)
	}
	if !strings.Contains(summary, "Reasoning summary line.") {
		t.Fatalf("expected summary to include reasoning summary text, got %q", summary)
	}

	joined := strings.Join(blockTypes, ",")
	for _, expected := range []string{"message", "output_text", "reasoning", "summary_text"} {
		if !strings.Contains(joined, expected) {
			t.Fatalf("missing block type %q in %q", expected, joined)
		}
	}
}

func TestSummarizeOpenAISucceedsWithOutputText(t *testing.T) {
	client := &anthropicClient{
		provider: "openai",
		apiKey:   "test-openai-key",
		model:    "gpt-5.3-codex",
		baseURL:  "https://api.openai.com",
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			if req.URL.String() != "https://api.openai.com/v1/responses" {
				t.Fatalf("unexpected URL: %s", req.URL.String())
			}
			if got := req.Header.Get("Authorization"); got != "Bearer test-openai-key" {
				t.Fatalf("unexpected auth header: %q", got)
			}
			return jsonResponse(200, `{
				"output":[{"type":"message","content":[{"type":"output_text","text":"Hello from OpenAI."}]}]
			}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "prompt", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if summary != "Hello from OpenAI." {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeOpenAIEmptyNormalizationIncludesDiagnostics(t *testing.T) {
	client := &anthropicClient{
		provider: "openai",
		apiKey:   "test-openai-key",
		model:    "gpt-5.3-codex",
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			return jsonResponse(200, `{"output":[{"type":"reasoning"}]}`), nil
		})},
	}

	_, err := client.summarize(context.Background(), "prompt", 200)
	if err == nil {
		t.Fatal("expected summarize error for empty normalized output")
	}
	msg := err.Error()
	if !strings.Contains(msg, "provider=openai") || !strings.Contains(msg, "model=gpt-5.3-codex") {
		t.Fatalf("expected provider/model diagnostics, got %q", msg)
	}
	if !strings.Contains(msg, "block_types=reasoning") {
		t.Fatalf("expected block_types diagnostics, got %q", msg)
	}
}

func TestIsOAuthToken(t *testing.T) {
	tests := []struct {
		token string
		want  bool
	}{
		{"sk-ant-oat01-abc123", true},
		{"sk-ant-oat02-xyz", true},
		{"sk-ant-api03-abc123", false},
		{"some-random-key", false},
		{"", false},
	}
	for _, tt := range tests {
		if got := isOAuthToken(tt.token); got != tt.want {
			t.Errorf("isOAuthToken(%q) = %v, want %v", tt.token, got, tt.want)
		}
	}
}

func TestResolveGatewayURL(t *testing.T) {
	tests := []struct {
		name string
		cfg  map[string]interface{}
		want string
	}{
		{
			name: "top-level port",
			cfg:  map[string]interface{}{"port": float64(8080)},
			want: "http://127.0.0.1:8080",
		},
		{
			name: "nested gateway port",
			cfg:  map[string]interface{}{"gateway": map[string]interface{}{"port": float64(3030)}},
			want: "http://127.0.0.1:3030",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			tmpHome := t.TempDir()
			ocDir := filepath.Join(tmpHome, ".openclaw")
			if err := os.MkdirAll(ocDir, 0o755); err != nil {
				t.Fatal(err)
			}
			data, _ := json.Marshal(tt.cfg)
			if err := os.WriteFile(filepath.Join(ocDir, "openclaw.json"), data, 0o644); err != nil {
				t.Fatal(err)
			}

			t.Setenv("HOME", tmpHome)

			got := resolveGatewayURL()
			if got != tt.want {
				t.Fatalf("resolveGatewayURL() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestResolveGatewayURLMissingFile(t *testing.T) {
	tmpHome := t.TempDir()
	t.Setenv("HOME", tmpHome)
	got := resolveGatewayURL()
	if got != "" {
		t.Fatalf("resolveGatewayURL() = %q, want empty string", got)
	}
}

func TestSummarizeAnthropicOAuthDelegatesToCLI(t *testing.T) {
	stubClaudeCLI(t)
	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv("LCM_HELPER_STDOUT", "CLI summary")
	t.Setenv("LCM_EXPECT_MODEL", anthropicModel)
	t.Setenv("LCM_EXPECT_PROMPT_SHA256", hashPrompt("say hello"))
	t.Setenv("ANTHROPIC_API_KEY", "should-be-filtered")

	httpCalled := false
	client := &anthropicClient{
		provider: "anthropic",
		apiKey:   "sk-ant-oat01-test-token",
		model:    anthropicModel,
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
		t.Fatal("HTTP transport was called for OAuth token; expected delegation to claude CLI")
	}
	if summary != "CLI summary" {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeAnthropicOAuthRejectsOversizeCLIOutput(t *testing.T) {
	stubClaudeCLI(t)
	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv("LCM_HELPER_STDOUT", strings.Repeat("word ", 200))
	t.Setenv("LCM_EXPECT_MODEL", anthropicModel)
	t.Setenv("LCM_EXPECT_PROMPT_SHA256", hashPrompt("oversized"))

	client := &anthropicClient{
		provider: "anthropic",
		apiKey:   "sk-ant-oat01-test-token",
		model:    anthropicModel,
		http:     &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, nil })},
	}

	_, err := client.summarize(context.Background(), "oversized", 32)
	if err == nil {
		t.Fatal("expected summarize to reject oversized CLI output")
	}
	if !strings.Contains(err.Error(), "exceeded target token budget") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestSummarizeAnthropicOAuthStreamsLargePromptViaStdin(t *testing.T) {
	stubClaudeCLI(t)
	t.Setenv("GO_WANT_HELPER_PROCESS", "1")
	t.Setenv("LCM_HELPER_STDOUT", "large prompt summary")
	t.Setenv("LCM_EXPECT_MODEL", anthropicModel)

	largePrompt := strings.Repeat("large prompt chunk ", 20000)
	t.Setenv("LCM_EXPECT_PROMPT_SHA256", hashPrompt(largePrompt))
	t.Setenv("ANTHROPIC_API_KEY", "should-be-filtered")

	client := &anthropicClient{
		provider: "anthropic",
		apiKey:   "sk-ant-oat01-test-token",
		model:    anthropicModel,
		http:     &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) { return nil, nil })},
	}

	summary, err := client.summarize(context.Background(), largePrompt, 200)
	if err != nil {
		t.Fatalf("summarize returned error for large prompt: %v", err)
	}
	if summary != "large prompt summary" {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeOpenAICustomBaseURL(t *testing.T) {
	customBase := "https://proxy.example.com/openai"
	client := &anthropicClient{
		provider: "openai",
		apiKey:   "test-openai-key",
		model:    "gpt-5.3-codex",
		baseURL:  customBase,
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			expectedURL := customBase + "/v1/responses"
			if req.URL.String() != expectedURL {
				t.Fatalf("expected URL %s, got %s", expectedURL, req.URL.String())
			}
			return jsonResponse(200, `{
				"output":[{"type":"message","content":[{"type":"output_text","text":"proxied response"}]}]
			}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "prompt", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if summary != "proxied response" {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeOpenAICustomBaseURLWithVersionPrefix(t *testing.T) {
	customBase := "https://proxy.example.com/v1"
	client := &anthropicClient{
		provider: "openai",
		apiKey:   "test-openai-key",
		model:    "gpt-5.3-codex",
		baseURL:  customBase,
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			expectedURL := customBase + "/responses"
			if req.URL.String() != expectedURL {
				t.Fatalf("expected URL %s, got %s", expectedURL, req.URL.String())
			}
			return jsonResponse(200, `{
				"output":[{"type":"message","content":[{"type":"output_text","text":"versioned proxy response"}]}]
			}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "prompt", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if summary != "versioned proxy response" {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func stubClaudeCLI(t *testing.T) {
	t.Helper()

	originalLookup := lookupCLIPath
	originalExec := execCLICommand
	lookupCLIPath = func(file string) (string, error) {
		if file != "claude" {
			t.Fatalf("unexpected lookup path: %q", file)
		}
		return "/tmp/fake-claude", nil
	}
	execCLICommand = func(ctx context.Context, name string, args ...string) *exec.Cmd {
		cmdArgs := append([]string{"-test.run=TestHelperProcessClaudeCLI", "--", name}, args...)
		return exec.CommandContext(ctx, os.Args[0], cmdArgs...)
	}
	t.Cleanup(func() {
		lookupCLIPath = originalLookup
		execCLICommand = originalExec
	})
}

func TestHelperProcessClaudeCLI(t *testing.T) {
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

	if os.Getenv("ANTHROPIC_API_KEY") != "" {
		_, _ = os.Stderr.WriteString("ANTHROPIC_API_KEY should be filtered")
		os.Exit(3)
	}
	if !containsArgs(cliArgs, "--print") {
		_, _ = os.Stderr.WriteString("missing --print")
		os.Exit(4)
	}
	if !containsArgPair(cliArgs, "--output-format", "text") {
		_, _ = os.Stderr.WriteString("missing output format")
		os.Exit(5)
	}
	if !containsArgPair(cliArgs, "--input-format", "text") {
		_, _ = os.Stderr.WriteString("missing input format")
		os.Exit(9)
	}
	if expectedModel != "" && !containsArgPair(cliArgs, "--model", expectedModel) {
		_, _ = os.Stderr.WriteString("missing model")
		os.Exit(6)
	}
	if containsArgs(cliArgs, "-p") || containsArgs(cliArgs, "--prompt") {
		_, _ = os.Stderr.WriteString("prompt should arrive via stdin, not argv")
		os.Exit(7)
	}
	if expectedPromptHash != "" {
		prompt, err := io.ReadAll(os.Stdin)
		if err != nil {
			_, _ = os.Stderr.WriteString("failed to read stdin")
			os.Exit(10)
		}
		if hashPrompt(string(prompt)) != expectedPromptHash {
			_, _ = os.Stderr.WriteString("stdin prompt hash mismatch")
			os.Exit(11)
		}
	}

	_, _ = os.Stdout.WriteString(os.Getenv("LCM_HELPER_STDOUT"))
	if codeText := strings.TrimSpace(os.Getenv("LCM_HELPER_EXIT_CODE")); codeText != "" {
		code, err := strconv.Atoi(codeText)
		if err != nil {
			_, _ = os.Stderr.WriteString("bad exit code")
			os.Exit(8)
		}
		os.Exit(code)
	}
	os.Exit(0)
}

func hashPrompt(prompt string) string {
	sum := sha256.Sum256([]byte(prompt))
	return fmt.Sprintf("%x", sum)
}

func containsArgs(args []string, want string) bool {
	for _, arg := range args {
		if arg == want {
			return true
		}
	}
	return false
}

func containsArgPair(args []string, flag, want string) bool {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == flag && args[i+1] == want {
			return true
		}
	}
	return false
}

func TestSummarizeAnthropicCustomBaseURL(t *testing.T) {
	customBase := "https://proxy.example.com/anthropic"
	client := &anthropicClient{
		provider: "anthropic",
		apiKey:   "test-anthropic-key",
		model:    "claude-sonnet-4-20250514",
		baseURL:  customBase,
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			expectedURL := customBase + "/v1/messages"
			if req.URL.String() != expectedURL {
				t.Fatalf("expected URL %s, got %s", expectedURL, req.URL.String())
			}
			return jsonResponse(200, `{
				"content":[{"type":"text","text":"proxied anthropic response"}]
			}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "prompt", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if summary != "proxied anthropic response" {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeAnthropicCustomBaseURLWithVersionPrefix(t *testing.T) {
	customBase := "https://proxy.example.com/v1"
	client := &anthropicClient{
		provider: "anthropic",
		apiKey:   "test-anthropic-key",
		model:    "claude-sonnet-4-20250514",
		baseURL:  customBase,
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			expectedURL := customBase + "/messages"
			if req.URL.String() != expectedURL {
				t.Fatalf("expected URL %s, got %s", expectedURL, req.URL.String())
			}
			return jsonResponse(200, `{
				"content":[{"type":"text","text":"versioned anthropic proxy response"}]
			}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "prompt", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if summary != "versioned anthropic proxy response" {
		t.Fatalf("unexpected summary: %q", summary)
	}
}

func TestSummarizeAnthropicRegularKeyHitsDirectAPI(t *testing.T) {
	var capturedURL string
	client := &anthropicClient{
		provider: "anthropic",
		apiKey:   "sk-ant-api03-regular-key",
		model:    anthropicModel,
		http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
			capturedURL = req.URL.String()
			if got := req.Header.Get("x-api-key"); got != "sk-ant-api03-regular-key" {
				t.Fatalf("expected x-api-key header, got %q", got)
			}
			return jsonResponse(200, `{
				"content":[{"type":"text","text":"Direct API response."}]
			}`), nil
		})},
	}

	summary, err := client.summarize(context.Background(), "prompt", 200)
	if err != nil {
		t.Fatalf("summarize returned error: %v", err)
	}
	if capturedURL != "https://api.anthropic.com/v1/messages" {
		t.Fatalf("expected direct API URL, got %q", capturedURL)
	}
	if summary != "Direct API response." {
		t.Fatalf("unexpected summary: %q", summary)
	}
}
