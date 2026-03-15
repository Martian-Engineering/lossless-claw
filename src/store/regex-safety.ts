const NESTED_QUANTIFIER_RE = /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)[+*{]/;
const MAX_PATTERN_LENGTH = 500;

export type RegexValidationResult = {
  safe: boolean;
  reason?: string;
};

export class UnsafeRegexError extends Error {
  readonly code = "UNSAFE_REGEX";

  constructor(message: string) {
    super(message);
    this.name = "UnsafeRegexError";
  }
}

export function validateRegexSafety(pattern: string): RegexValidationResult {
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      safe: false,
      reason: `Pattern exceeds maximum length of ${MAX_PATTERN_LENGTH}`,
    };
  }

  if (NESTED_QUANTIFIER_RE.test(pattern)) {
    return {
      safe: false,
      reason: "Pattern contains nested quantifiers (potential ReDoS)",
    };
  }

  try {
    new RegExp(pattern);
  } catch {
    return {
      safe: false,
      reason: "Invalid regular expression",
    };
  }

  return { safe: true };
}
