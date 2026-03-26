package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveProviderBaseURLPrecedence(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "openclaw.json")
	config := []byte(`{
		"models": {
			"providers": {
				"openai": { "baseUrl": "https://config.example.com/openai/" }
			}
		}
	}`)
	if err := os.WriteFile(configPath, config, 0o644); err != nil {
		t.Fatalf("write config: %v", err)
	}

	paths := appDataPaths{openclawConfig: configPath}

	if got := resolveProviderBaseURL(paths, "openai", "https://flag.example.com/openai/"); got != "https://flag.example.com/openai" {
		t.Fatalf("expected flag override, got %q", got)
	}

	t.Setenv("LCM_SUMMARY_BASE_URL", "https://env.example.com/openai/")
	if got := resolveProviderBaseURL(paths, "openai", ""); got != "https://env.example.com/openai" {
		t.Fatalf("expected env override, got %q", got)
	}

	t.Setenv("LCM_SUMMARY_BASE_URL", "")
	if got := resolveProviderBaseURL(paths, "openai", ""); got != "https://config.example.com/openai" {
		t.Fatalf("expected config override, got %q", got)
	}
}

func TestResolveProviderBaseURLFallsBackToProviderDefaults(t *testing.T) {
	paths := appDataPaths{}

	if got := resolveProviderBaseURL(paths, "openai", ""); got != defaultOpenAIBaseURL {
		t.Fatalf("expected OpenAI default %q, got %q", defaultOpenAIBaseURL, got)
	}
	if got := resolveProviderBaseURL(paths, "anthropic", ""); got != defaultAnthropicBaseURL {
		t.Fatalf("expected Anthropic default %q, got %q", defaultAnthropicBaseURL, got)
	}
}

func TestResolveInteractiveRewriteProviderModelUsesTUISummaryBaseURL(t *testing.T) {
	t.Setenv("LCM_TUI_SUMMARY_PROVIDER", "openai")
	t.Setenv("LCM_TUI_SUMMARY_MODEL", "gpt-5.3-codex")
	t.Setenv("LCM_TUI_SUMMARY_BASE_URL", "https://tui.example.com/openai/")
	t.Setenv("LCM_SUMMARY_BASE_URL", "https://summary.example.com/openai/")

	provider, model, baseURL := resolveInteractiveRewriteProviderModel(appDataPaths{})
	if provider != "openai" {
		t.Fatalf("expected provider openai, got %q", provider)
	}
	if model != "gpt-5.3-codex" {
		t.Fatalf("expected model gpt-5.3-codex, got %q", model)
	}
	if baseURL != "https://tui.example.com/openai" {
		t.Fatalf("expected TUI base URL override, got %q", baseURL)
	}
}

func TestParseRewriteArgsAcceptsBaseURL(t *testing.T) {
	opts, conversationID, err := parseRewriteArgs([]string{
		"44",
		"--summary", "sum_abc123",
		"--base-url", "https://proxy.example.com/openai/",
	})
	if err != nil {
		t.Fatalf("parseRewriteArgs returned error: %v", err)
	}
	if conversationID != 44 {
		t.Fatalf("expected conversation ID 44, got %d", conversationID)
	}
	if opts.baseURL != "https://proxy.example.com/openai/" {
		t.Fatalf("expected base URL to round-trip, got %q", opts.baseURL)
	}
}

func TestParseBackfillArgsAcceptsBaseURL(t *testing.T) {
	opts, err := parseBackfillArgs([]string{
		"main",
		"session-123",
		"--base-url", "https://proxy.example.com/openai/",
	})
	if err != nil {
		t.Fatalf("parseBackfillArgs returned error: %v", err)
	}
	if opts.baseURL != "https://proxy.example.com/openai/" {
		t.Fatalf("expected base URL to round-trip, got %q", opts.baseURL)
	}
}
