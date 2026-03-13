package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
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
	// Create a temp dir to act as HOME with .openclaw/openclaw.json
	tmpHome := t.TempDir()
	ocDir := filepath.Join(tmpHome, ".openclaw")
	if err := os.MkdirAll(ocDir, 0o755); err != nil {
		t.Fatal(err)
	}
	cfg := map[string]interface{}{"port": float64(8080)}
	data, _ := json.Marshal(cfg)
	if err := os.WriteFile(filepath.Join(ocDir, "openclaw.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}

	// Override HOME so resolveGatewayURL reads our temp config
	orig := os.Getenv("HOME")
	t.Setenv("HOME", tmpHome)
	defer os.Setenv("HOME", orig)

	got := resolveGatewayURL()
	if got != "http://127.0.0.1:8080" {
		t.Fatalf("resolveGatewayURL() = %q, want %q", got, "http://127.0.0.1:8080")
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
	// When an OAuth/setup-token is detected, summarizeAnthropic should NOT
	// make an HTTP request to api.anthropic.com. Instead it delegates to
	// summarizeViaCLI (the `claude` CLI). We verify the HTTP transport is
	// never called when an OAuth token is used.
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

	// Use a very short timeout context so the CLI call doesn't block tests.
	// The key assertion is that the HTTP transport is NOT called.
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, _ = client.summarize(ctx, "say hello", 200)
	if httpCalled {
		t.Fatal("HTTP transport was called for OAuth token; expected delegation to claude CLI")
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
