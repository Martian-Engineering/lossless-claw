package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func TestMiniMaxRuntimeRequests(t *testing.T) {
	for _, provider := range []string{"minimax", "minimax-cn"} {
		for _, tc := range []struct {
			name     string
			model    string
			envModel string
			legacy   string
			baseURL  string
			want     string
		}{
			{name: "default", want: "MiniMax-M3.1-Flash"},
			{name: "env-default", want: "MiniMax-M3.1-Flash"},
			{name: "m3", model: "MiniMax-M3", want: "MiniMax-M3"},
			{name: "saved", envModel: "MiniMax-M2.7", want: "MiniMax-M2.7"},
			{name: "legacy-env", legacy: "MiniMax-M2.5", want: "MiniMax-M2.5"},
			{name: "custom", model: "private-model", baseURL: "https://proxy.example/anthropic", want: "private-model"},
			{name: "qualified", model: provider + "/MiniMax-M3.1-Flash", want: "MiniMax-M3.1-Flash"},
			{name: "cli-precedence", model: "MiniMax-M3", envModel: "MiniMax-M2.7", want: "MiniMax-M3"},
		} {
			t.Run(provider+"/"+tc.name, func(t *testing.T) {
				for _, key := range []string{"LCM_TUI_SUMMARY_PROVIDER", "LCM_SUMMARY_PROVIDER", "LCM_TUI_SUMMARY_BASE_URL", "LCM_SUMMARY_BASE_URL"} {
					t.Setenv(key, "")
				}
				t.Setenv("LCM_TUI_SUMMARY_MODEL", tc.envModel)
				t.Setenv("LCM_SUMMARY_MODEL", tc.legacy)
				// Include doctor's fallback to prove it cannot override the
				// selected provider's default. Other entrypoints pass blanks.
				cliProvider := provider
				if tc.name == "env-default" {
					cliProvider = ""
					t.Setenv("LCM_TUI_SUMMARY_PROVIDER", provider)
				}
				settings := resolveTUISummaryRuntimeSettings(appDataPaths{}, cliProvider, tc.model, tc.baseURL, doctorDefaultProvider, doctorDefaultModel)
				wantURL := "https://api.minimax.io/anthropic/v1/messages"
				if provider == "minimax-cn" {
					wantURL = "https://api.minimaxi.com/anthropic/v1/messages"
				}
				if tc.baseURL != "" {
					wantURL = tc.baseURL + "/v1/messages"
				}
				called := false
				client := &anthropicClient{
					provider: settings.provider, model: settings.model, baseURL: settings.baseURL,
					apiKey: "fixture-key",
					http: &http.Client{Transport: roundTripFunc(func(req *http.Request) (*http.Response, error) {
						called = true
						if req.Method != http.MethodPost || req.URL.String() != wantURL {
							t.Fatalf("unexpected request: %s %s", req.Method, req.URL)
						}
						if req.Header.Get("Authorization") != "Bearer fixture-key" || req.Header.Get("anthropic-version") != anthropicVersion {
							t.Fatal("missing MiniMax authentication or API version")
						}
						var payload map[string]json.RawMessage
						if err := json.NewDecoder(req.Body).Decode(&payload); err != nil {
							t.Fatal(err)
						}
						var model string
						if err := json.Unmarshal(payload["model"], &model); err != nil || model != tc.want {
							t.Fatalf("model = %q, want %q (error %v)", model, tc.want, err)
						}
						if string(payload["max_tokens"]) != "8192" || string(payload["messages"]) != `[{"role":"user","content":"source text"}]` {
							t.Fatalf("unexpected summary budget/messages: %s / %s", payload["max_tokens"], payload["messages"])
						}
						// Omission preserves Flash's adaptive/max defaults and
						// M3's default disabled thinking. Never send unsupported fields.
						for _, key := range []string{"thinking", "output_config", "reasoning_effort", "service_tier", "reasoning_split"} {
							if _, ok := payload[key]; ok {
								t.Fatalf("unexpected parameter %s", key)
							}
						}
						return jsonResponse(200, `{"content":[{"type":"thinking","thinking":"private"},{"type":"text","text":"Summary."}]}`), nil
					})},
				}
				summary, err := client.summarize(context.Background(), "source text", 8192)
				if err != nil || summary != "Summary." || !called {
					t.Fatalf("summary = %q, error = %v, transport called = %v", summary, err, called)
				}
			})
		}
	}
}
