/**
 * Shared token estimation utility.
 *
 * Uses code-point-aware weighting instead of `text.length / 4`:
 *   - CJK (Chinese/Japanese/Korean) characters: ~1.5 tokens/char
 *   - Emoji / Supplementary Plane: ~2 tokens/char
 *   - ASCII / Latin: ~0.25 tokens/char (≈ 4 chars/token)
 *
 * Why not `text.length / 4`?
 * JavaScript `String.length` counts UTF-16 code units, not Unicode code points.
 * CJK characters are 1 UTF-16 unit but ~1.5 tokens; emoji are 2 UTF-16 units
 * (surrogate pairs) but ~2-4 tokens. The naive formula underestimates CJK by
 * ~6× and emoji by ~2-4×, causing compaction to trigger far too late for
 * non-English conversations.
 */

/** Detect CJK code points across all relevant Unicode ranges. */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x4e00 && cp <= 0x9fff) ||   // CJK Unified Ideographs
    (cp >= 0x3400 && cp <= 0x4dbf) ||    // CJK Extension A
    (cp >= 0x20000 && cp <= 0x2a6df) ||  // CJK Extension B
    (cp >= 0x2a700 && cp <= 0x2b73f) ||  // CJK Extension C
    (cp >= 0x2b740 && cp <= 0x2b81f) ||  // CJK Extension D
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||  // CJK Extension E
    (cp >= 0x2ceb0 && cp <= 0x2ebef) ||  // CJK Extension F
    (cp >= 0x3000 && cp <= 0x303f) ||    // CJK Symbols and Punctuation
    (cp >= 0x3040 && cp <= 0x30ff) ||    // Hiragana + Katakana
    (cp >= 0xac00 && cp <= 0xd7af) ||    // Hangul Syllables
    (cp >= 0xff00 && cp <= 0xffef)       // Fullwidth Forms
  );
}

/** Estimate token cost for a single Unicode code point. */
function estimateCodePointTokens(cp: number): number {
  if (isCjkCodePoint(cp)) {
    return 1.5;
  }
  if (cp > 0xffff) {
    return 2;
  }
  return 0.25;
}

/** Estimate text tokens using Unicode-aware character weighting. */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    tokens += estimateCodePointTokens(cp);
  }
  return Math.ceil(tokens);
}

/**
 * Truncate text so the estimated token count stays within `maxTokens`.
 *
 * Iterates by Unicode code point to avoid splitting surrogate pairs while
 * preserving the same weighting model as `estimateTokens()`.
 */
export function truncateTextToEstimatedTokens(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || !text) {
    return "";
  }

  let tokens = 0;
  let end = 0;

  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    const nextTokens = tokens + estimateCodePointTokens(cp);
    if (Math.ceil(nextTokens) > maxTokens) {
      break;
    }
    tokens = nextTokens;
    end += char.length;
  }

  return text.slice(0, end);
}
