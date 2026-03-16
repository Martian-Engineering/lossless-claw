/**
 * Token counting utilities with tokenizer fallback to LCM's original estimateTokens.
 */

import type { TokenizerService } from "./types.js";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

let tokenizerFailedLogged = false;
let tokenizerSuccessLogged = false;

export function calculateTokens(
  text: string,
  useTokenizer?: boolean,
  tokenizer?: TokenizerService,
): number {
  if (useTokenizer && tokenizer?.isEnabled()) {
    try {
      const count = tokenizer.countTokens(text);
      if (!tokenizerSuccessLogged) {
        tokenizerSuccessLogged = true;
        console.log(`[lcm] Using precise tokenizer for token counting (first call, tokens=${count})`);
      }
      return count;
    } catch (err) {
      if (!tokenizerFailedLogged) {
        tokenizerFailedLogged = true;
        console.warn(`[lcm] Tokenizer failed, falling back to estimateTokens: ${err}`);
      }
    }
  }
  
  return estimateTokens(text);
}
