---
"@martian-engineering/lossless-claw": patch
---

Fix v0.9.3 regressions affecting prefill safety and provider routing:

- Restore the reference-inequality contract on the no-user-turn assemble fallback. PR #502's guard returned `params.messages` by reference, defeating the `installContextEngineLoopHook` `assembled.messages !== sourceMessages` check installed by PR #504; the guard now uses the same `safeFallback()` helper as the other fallback paths so the gateway treats the result as assembled context.
- Strip assistant messages whose only blocks are blank text (`[{type:"text", text:""}]`) during assembly, complementing the existing thinking-only filter so Bedrock no longer rejects with `The text field in the ContentBlock object at messages.N.content.0 is blank`.
- Stop redirecting paid OpenAI API-key Codex users from `https://api.openai.com/v1` to `https://chatgpt.com/backend-api/codex`. `shouldUseNativeCodexBaseUrl` now respects an explicitly-configured baseUrl; the rewrite still applies when baseUrl is empty or already a ChatGPT Codex variant.
- Remove the silent `http://localhost:11434` ollama fallback in `inferBaseUrlFromProvider` so cloud-only ollama configs (`https://ollama.com`) and self-hosted setups must be explicit; the prior default would silently route cloud configs to localhost.
