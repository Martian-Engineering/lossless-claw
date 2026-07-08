const MAX_SEARCH_REGEX_PATTERN_LENGTH = 500;
const REGEX_QUANTIFIER_PATTERN = String.raw`(?:[+*?]|\{\d+(?:,\d*)?\})`;
const NESTED_QUANTIFIER_PATTERN = new RegExp(
  `${REGEX_QUANTIFIER_PATTERN}\\)${REGEX_QUANTIFIER_PATTERN}`,
);
const QUANTIFIED_ALTERNATION_GROUP_PATTERN =
  /\((?:[^()\\]|\\.)*\|(?:[^()\\]|\\.)*\)(?:[+*?]|\{\d)/;

/**
 * Compile a user-provided search regex only after applying the shared search
 * safety guard used by JS-backed message, summary, and large-file scans.
 */
export function compileSafeSearchRegex(pattern: string, flags?: string): RegExp | null {
  if (
    pattern.length > MAX_SEARCH_REGEX_PATTERN_LENGTH ||
    NESTED_QUANTIFIER_PATTERN.test(pattern) ||
    QUANTIFIED_ALTERNATION_GROUP_PATTERN.test(pattern)
  ) {
    return null;
  }
  try {
    return new RegExp(pattern, flags);
  } catch {
    return null;
  }
}
