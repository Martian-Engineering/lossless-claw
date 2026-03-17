import Anthropic from "@anthropic-ai/sdk";
import {
  LCM_SUMMARIZER_SYSTEM_PROMPT,
  buildLeafSummaryPrompt,
  buildCondensedSummaryPrompt,
  resolveTargetTokens,
} from "../summarize.js";

type SummarizerOptions = {
  model: string;
  apiKey: string;
  _clientOverride?: any;
  _retryDelayMs?: number;
};

type SummarizeContext = { isCondensed?: boolean; targetTokens?: number; depth?: number };

export type LcmSummarizeFn = (text: string, aggressive: boolean, ctx?: SummarizeContext) => Promise<string>;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function createAnthropicSummarizer(opts: SummarizerOptions): LcmSummarizeFn {
  const client = opts._clientOverride ?? new Anthropic({ apiKey: opts.apiKey });
  const retryDelayMs = opts._retryDelayMs ?? 1000;
  const MAX_RETRIES = 3;

  return async function summarize(text, aggressive, ctx = {}): Promise<string> {
    const estimatedInputTokens = Math.ceil(text.length / 4);
    const targetTokens = ctx.targetTokens ?? resolveTargetTokens({
      inputTokens: estimatedInputTokens,
      mode: aggressive ? "aggressive" : "normal",
      isCondensed: ctx.isCondensed ?? false,
      condensedTargetTokens: 2000,
    });

    const prompt = ctx.isCondensed
      ? buildCondensedSummaryPrompt({ text, targetTokens, depth: ctx.depth ?? 1 })
      : buildLeafSummaryPrompt({ text, mode: aggressive ? "aggressive" : "normal", targetTokens });

    let lastError: Error | undefined;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const response = await client.messages.create({
          model: opts.model,
          max_tokens: 1024,
          system: LCM_SUMMARIZER_SYSTEM_PROMPT,
          messages: [{ role: "user", content: prompt }],
        });

        const textContent = response.content.find((c: any) => c.type === "text")?.text ?? "";

        if (!textContent && attempt === 0) {
          // Single retry on empty response
          const retry = await client.messages.create({
            model: opts.model,
            max_tokens: 1024,
            system: LCM_SUMMARIZER_SYSTEM_PROMPT,
            messages: [{ role: "user", content: prompt }],
          });
          return retry.content.find((c: any) => c.type === "text")?.text ?? text.slice(0, 500);
        }

        return textContent || text.slice(0, 500);
      } catch (err: any) {
        if (err?.status === 401) throw err; // auth error: no retry
        lastError = err;
        if (attempt < MAX_RETRIES - 1) await sleep(retryDelayMs * Math.pow(2, attempt));
      }
    }
    throw lastError;
  };
}
