package main

import (
	"context"
	"io"
	"net/http"
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
