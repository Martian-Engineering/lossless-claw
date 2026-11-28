package main

import (
	"os"
	"strings"
)

type summaryRuntimeSettings struct {
	provider string
	model    string
	baseURL  string
}

// resolveTUISummaryRuntimeSettings centralizes standalone/interactive summary
// provider resolution so every lcm-tui summarization entrypoint honors the
// same CLI, TUI env, legacy env, config, and provider-default precedence.
func resolveTUISummaryRuntimeSettings(
	paths appDataPaths,
	cliProvider string,
	cliModel string,
	cliBaseURL string,
	defaultProvider string,
	defaultModel string,
) summaryRuntimeSettings {
	providerHint := firstNonEmptyString(
		cliProvider,
		os.Getenv("LCM_TUI_SUMMARY_PROVIDER"),
		os.Getenv("LCM_SUMMARY_PROVIDER"),
		defaultProvider,
	)
	// Doctor's fallback model belongs to its default provider. An explicit
	// MiniMax provider must use its own default unless a model was supplied.
	switch normalizeProviderID(providerHint) {
	case miniMaxProviderID, miniMaxCNProviderID:
		defaultModel = ""
	}
	modelHint := firstNonEmptyString(
		cliModel,
		os.Getenv("LCM_TUI_SUMMARY_MODEL"),
		os.Getenv("LCM_SUMMARY_MODEL"),
		defaultModel,
	)
	provider, model := resolveSummaryProviderModel(providerHint, modelHint)

	baseURLHint := firstNonEmptyString(
		cliBaseURL,
		os.Getenv("LCM_TUI_SUMMARY_BASE_URL"),
	)

	return summaryRuntimeSettings{
		provider: provider,
		model:    model,
		baseURL:  resolveProviderBaseURL(paths, provider, baseURLHint),
	}
}

func firstNonEmptyString(values ...string) string {
	for _, value := range values {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return ""
}
