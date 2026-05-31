import { estimateTokens, truncateTextToEstimatedTokens } from "./estimate-tokens.js";

export const FALLBACK_DIRECTIVE_OMISSION =
  "[LCM fallback summary omitted directive-shaped untrusted content].";

export const FALLBACK_SUMMARY_MARKER =
  "[LCM fallback summary; truncated for context management]";
const DEFAULT_FALLBACK_DIRECTIVE_NOTE =
  "[LCM fallback summary; directive-shaped untrusted content omitted]";
const OPTIONAL_DIRECTIVE_SCOPE_PREFIX = String.raw`(?:all\s+)?(?:(?:the|your|my|any|these|those)\s+)?`;
const FALLBACK_DIRECTIVE_SHAPED_PATTERN = new RegExp(
  [
    String.raw`\b(ignore|disregard|forget|override)\s+${OPTIONAL_DIRECTIVE_SCOPE_PREFIX}(previous|prior|above|earlier|system|developer)\s+(instructions?|prompts?|rules?)\b`,
    String.raw`\byou\s+are\s+now\b`,
    String.raw`\bfrom\s+now\s+on\b`,
    String.raw`\breply\s+only\s+with\b`,
    String.raw`\b(reveal|print|show|dump|exfiltrate)\s+(?:(?:the|your|my|any)\s+)?(system|developer)\s+prompt\b`,
    String.raw`\bjailbreak\b`,
  ].join("|"),
  "i",
);

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
      lastWasOmission = false;
      continue;
    }
    if (FALLBACK_DIRECTIVE_SHAPED_PATTERN.test(unit)) {
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
