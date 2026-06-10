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

/** Fixed token cost substituted for embedded binary/image payloads. */
const OPAQUE_BINARY_PART_TOKEN_ESTIMATE = 1_600;

/** Strings at least this long are checked for base64-style opaque data. */
const OPAQUE_BINARY_MIN_CHARS = 4_096;

/**
 * Field names that carry binary payloads (image/document sources). Only
 * values under these keys are eligible for fixed-cost substitution: base64
 * or hex that appears inside ordinary text/content fields IS tokenized per
 * character at the model boundary and must be counted in full.
 */
const OPAQUE_BINARY_FIELD_KEYS = new Set([
  "data",
  "image",
  "imageData",
  "image_data",
  "base64",
  "bytes",
  "source",
]);

/**
 * Heuristic for embedded binary payloads providers price per item rather
 * than per character: data: URLs anywhere, or base64-shaped blobs under a
 * known binary field key.
 */
function isLikelyOpaqueBinaryString(key: string, value: string): boolean {
  if (value.length < OPAQUE_BINARY_MIN_CHARS) {
    return false;
  }
  if (value.startsWith("data:")) {
    return true;
  }
  if (!OPAQUE_BINARY_FIELD_KEYS.has(key)) {
    return false;
  }
  const head = value.slice(0, 512);
  return /^[A-Za-z0-9+/=\r\n]+$/.test(head) && /[0-9]/.test(head) && /[A-Za-z]/.test(head);
}

/**
 * Memoized serialized estimates keyed by message object identity. assemble()
 * re-measures candidate outputs repeatedly while packing to budget; without
 * memoization a 400-message tool-heavy transcript costs ~O(n²) full
 * serializations per turn. Host-side in-place truncation of a cached message
 * leaves a stale (higher) estimate, which only errs toward safety.
 */
const serializedEstimateCache = new WeakMap<object, number>();

/**
 * Estimate the model-boundary token cost of a full message object by
 * serializing the entire structure, not just its text blocks.
 *
 * The LLM-boundary prompt renderer serializes structured tool-call payloads
 * (tool inputs, tool result objects, mirrored identifiers) that text-only
 * estimators never see. On tool-heavy transcripts a text-only estimate can
 * undercount the real prompt by 2-3x, which lets "budgeted" assembly output
 * overflow the model. Serializing the whole message tracks the boundary
 * estimate closely; binary payloads under image/document fields are
 * substituted with a fixed per-part cost so images do not dominate.
 */
export function estimateSerializedMessageTokens(message: unknown): number {
  const cacheable = typeof message === "object" && message !== null;
  if (cacheable) {
    const cached = serializedEstimateCache.get(message as object);
    if (cached !== undefined) {
      return cached;
    }
  }
  let opaqueParts = 0;
  let serialized = "";
  try {
    // Agent messages are JSON-parsed transcript/provider data, so cycles do
    // not occur in practice; shared (DAG) references serialize in full,
    // which is what the model boundary sees too.
    serialized =
      JSON.stringify(message, (key, value) => {
        if (typeof value === "string" && isLikelyOpaqueBinaryString(key, value)) {
          opaqueParts += 1;
          return "[opaque binary payload]";
        }
        return value;
      }) ?? "";
  } catch {
    // Cyclic or otherwise non-serializable input: fall back to a shallow
    // per-part estimate so the result is never silently near-zero.
    serialized = "";
    const content = (message as { content?: unknown } | null)?.content;
    if (typeof content === "string") {
      serialized = content;
    } else if (Array.isArray(content)) {
      for (const part of content) {
        try {
          serialized += JSON.stringify(part) ?? "";
        } catch {
          // skip unserializable part
        }
      }
    }
  }
  const estimate = estimateTokens(serialized) + opaqueParts * OPAQUE_BINARY_PART_TOKEN_ESTIMATE;
  if (cacheable) {
    serializedEstimateCache.set(message as object, estimate);
  }
  return estimate;
}

/** Sum of `estimateSerializedMessageTokens` across a message list. */
export function estimateSerializedMessagesTokens(messages: readonly unknown[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateSerializedMessageTokens(message);
  }
  return total;
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
