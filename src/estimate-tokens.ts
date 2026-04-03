/**
 * Shared token estimation utility.
 *
 * Uses character-type-aware weighting instead of length/4:
 *   - CJK (Chinese/Japanese/Korean) characters: ~1.5 tokens/char
 *   - Everything else: ~0.25 tokens/char (≈ 4 chars/token)
 *
 * Covers the full Unicode ranges used by modern tokenizers (cl100k_base, o200k_base).
 * Matches the approach from VoltCode's Token.estimate.
 */

/** CJK Unified Ideographs (U+4E00–U+9FFF) + Extension A (U+3400–U+4DBF) + Extension B+ */
function isCjkCodePoint(code: number): boolean {
  return (
    (code >= 0x4e00 && code <= 0x9fff) ||   // CJK Unified Ideographs
    (code >= 0x3400 && code <= 0x4dbf) ||    // CJK Extension A
    (code >= 0x20000 && code <= 0x2a6df) ||   // CJK Extension B
    (code >= 0x2a700 && code <= 0x2b73f) ||   // CJK Extension C
    (code >= 0x2b740 && code <= 0x2b81f) ||   // CJK Extension D
    (code >= 0x2b820 && code <= 0x2ceaf) ||   // CJK Extension E
    (code >= 0x2ceb0 && code <= 0x2ebef) ||   // CJK Extension F
    (code >= 0x3000 && code <= 0x303f) ||      // CJK Symbols (includes fullwidth punct)
    (code >= 0xff00 && code <= 0xffef)         // Halfwidth/Fullwidth Forms (fullwidth ASCII)
  );
}

export function estimateTokens(text: string): number {
  let count = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    count += isCjkCodePoint(code) ? 1.5 : 0.25;
  }
  return Math.ceil(count);
}
