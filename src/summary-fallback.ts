import { estimateTokens, truncateTextToEstimatedTokens } from "./estimate-tokens.js";

export const FALLBACK_DIRECTIVE_OMISSION =
  "[LCM fallback summary omitted directive-shaped untrusted content].";

export const FALLBACK_SUMMARY_MARKER =
  "[LCM fallback summary; truncated for context management]";
export const FALLBACK_DIRECTIVE_SUMMARY_MARKER =
  "[LCM fallback summary; directive-shaped untrusted content omitted]";
const DEFAULT_FALLBACK_DIRECTIVE_NOTE = FALLBACK_DIRECTIVE_SUMMARY_MARKER;
const OPTIONAL_DIRECTIVE_SCOPE_PREFIX = String.raw`(?:all\s+)?(?:of\s+)?(?:(?:the|your|my|any|these|those)\s+)?`;
const DIRECTIVE_SCOPE = String.raw`(?:(?:previous|prior|above|earlier)(?:\s+(?:system|developer))?|(?:system|developer))`;
const UNSCOPED_DIRECTIVE_TARGET = String.raw`(?:(?:all|any)\s+)?(?:of\s+)?(?:(?:the|your|my|these|those|current|existing|original)\s+)?(?:instructions?|prompts?|rules?)`;
const ANSWER_DAN_OBJECT = String.raw`(?:(?:me|us)|(?:(?:(?:the|this|that|your|my|any|these|those|all|every)\s+)?(?:future\s+)?(?:users?|requests?|questions?|prompts?|messages?)))`;
const DAN_PERSONA_DIRECTIVE_PREFIX = String.raw`(?:^\s*|^\s*[A-Za-z][A-Za-z0-9 _/-]{0,40}:\s*)`;
const FALLBACK_DIRECTIVE_CONTINUATION_PATTERN =
  /^\s*(?:answer|reply|respond|say|output|print|return|show|provide|give|send|reveal|dump|exfiltrate)\b[^.!?\n]{0,160}[.!?]?\s*$/i;
const FALLBACK_DIRECTIVE_SHAPED_PATTERNS = [
  new RegExp(
    [
      String.raw`\b(ignore|disregard|forget|override)\s+${OPTIONAL_DIRECTIVE_SCOPE_PREFIX}${DIRECTIVE_SCOPE}\s+(instructions?|prompts?|rules?)\b`,
      String.raw`\b(ignore|disregard|forget|override)\s+${UNSCOPED_DIRECTIVE_TARGET}\s*(?:$|[.,;:!?]|\s+(?:and|then|now|before|after|instead|to|with|from)\b)`,
      String.raw`\byou\s+are\s+now\b`,
      String.raw`\bfrom\s+now\s+on\b`,
      String.raw`\breply\s+only\s+with\b`,
      String.raw`\b(reveal|print|show|dump|exfiltrate|provide|give|send)\s+(?:me\s+)?(?:(?:the|your|my|any)\s+)?(system|developer)\s+prompt\b`,
      String.raw`\bjailbreak\s+(?:mode|prompt|instructions?|the\s+model|the\s+assistant)\b`,
    ].join("|"),
    "i",
  ),
  /\bdan\s+mode\b/i,
  /\byou\s+are\s+dan\b/i,
  new RegExp(String.raw`\banswer\s+${ANSWER_DAN_OBJECT}\s+as\s+dan\b`, "i"),
  // Preserve embedded human-name "Dan" while catching imperative or labeled DAN persona directives.
  new RegExp(
    String.raw`${DAN_PERSONA_DIRECTIVE_PREFIX}(?:act\s+as|pretend\s+to\s+be)\s+dan\b`,
    "i",
  ),
  /\b(?:[Aa][Cc][Tt]\s+[Aa][Ss]|[Pp][Rr][Ee][Tt][Ee][Nn][Dd]\s+[Tt][Oo]\s+[Bb][Ee])\s+(?!Dan\b)[Dd][Aa][Nn]\b/,
  /\b(?:[Ee][Nn][Aa][Bb][Ll][Ee]|[Aa][Cc][Tt][Ii][Vv][Aa][Tt][Ee]|[Uu][Nn][Ll][Oo][Cc][Kk]|[Ee][Nn][Tt][Ee][Rr]|[Ss][Tt][Aa][Rr][Tt]|[Uu][Ss][Ee])\s+(?!Dan\b)[Dd][Aa][Nn]\b/,
];

export function sanitizeDeterministicFallbackText(text: string): {
  sanitizedText: string;
  omittedDirectiveShapedContent: boolean;
} {
  const units = text.match(/\n+|[^\n.!?]+[.!?]*\s*/g) ?? [text];
  const output: string[] = [];
  let omittedDirectiveShapedContent = false;
  let lastWasOmission = false;

  for (const unit of units) {
    if (/^\n+$/.test(unit)) {
      output.push(unit);
      continue;
    }
    if (
      FALLBACK_DIRECTIVE_SHAPED_PATTERNS.some((pattern) => pattern.test(unit)) ||
      (lastWasOmission && FALLBACK_DIRECTIVE_CONTINUATION_PATTERN.test(unit))
    ) {
      omittedDirectiveShapedContent = true;
      if (!lastWasOmission) {
        output.push(`${FALLBACK_DIRECTIVE_OMISSION} `);
        lastWasOmission = true;
      }
      continue;
    }
    output.push(unit);
    lastWasOmission = false;
  }

  return {
    sanitizedText: output.join("").replace(/[ \t]+\n/g, "\n").trim(),
    omittedDirectiveShapedContent,
  };
}

export function buildDeterministicFallbackSummary(
  text: string,
  targetTokens: number,
  options?: {
    maxTokens?: number;
    truncationNote?: string;
    directiveOmissionNote?: string;
    alwaysAppendNote?: boolean;
  },
): string {
  if (typeof text !== "string") return "";
  const trimmed = text.trim();
  if (!trimmed) {
    return "";
  }

  const { sanitizedText, omittedDirectiveShapedContent } =
    sanitizeDeterministicFallbackText(trimmed);
  const fallbackNote = omittedDirectiveShapedContent
    ? (options?.directiveOmissionNote ?? DEFAULT_FALLBACK_DIRECTIVE_NOTE)
    : (options?.truncationNote ?? FALLBACK_SUMMARY_MARKER);
  const sanitizedTextWithoutOmissionMarkers = omittedDirectiveShapedContent
    ? sanitizedText.split(FALLBACK_DIRECTIVE_OMISSION).join("").trim()
    : sanitizedText;
  if (!sanitizedText || !sanitizedTextWithoutOmissionMarkers) {
    return fallbackNote;
  }

  if (typeof options?.maxTokens === "number" && Number.isFinite(options.maxTokens)) {
    const maxTokens = Math.max(1, Math.floor(options.maxTokens));
    const noteTokenCost = estimateTokens(`\n${fallbackNote}`);
    const maxSummaryTokens = Math.max(0, maxTokens - noteTokenCost);
    const summaryText = truncateTextToEstimatedTokens(sanitizedText, maxSummaryTokens).trimEnd();
    return summaryText ? `${summaryText}\n${fallbackNote}` : fallbackNote;
  }

  const maxChars = Math.max(256, Math.max(1, Math.floor(targetTokens)) * 4);
  if (
    sanitizedText.length <= maxChars &&
    !omittedDirectiveShapedContent &&
    options?.alwaysAppendNote !== true
  ) {
    return sanitizedText;
  }

  const summaryText =
    sanitizedText.length <= maxChars ? sanitizedText : sanitizedText.slice(0, maxChars).trimEnd();
  return summaryText ? `${summaryText}\n${fallbackNote}` : fallbackNote;
}
