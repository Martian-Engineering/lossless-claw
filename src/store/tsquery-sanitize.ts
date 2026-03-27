/**
 * Sanitize a user-provided query for use with PostgreSQL's plainto_tsquery.
 *
 * plainto_tsquery is much more forgiving than FTS5 MATCH expressions:
 * - It automatically handles most special characters
 * - It treats input as plain text and extracts meaningful words
 * - It doesn't require manual escaping of operators like AND, OR, NOT
 *
 * However, we still need to handle some edge cases:
 * - Very long queries should be truncated
 * - Empty/whitespace-only queries should return a safe default
 * - Control characters should be stripped
 *
 * Examples:
 *   "sub-agent restrict"  →  "sub-agent restrict" (unchanged)
 *   "lcm_expand OR crash" →  "lcm_expand OR crash" (unchanged, plainto_tsquery handles OR)
 *   'hello "world"'       →  'hello "world"' (unchanged, quotes are fine)
 *   ""                    →  "default" (fallback for empty queries)
 */
export function sanitizeTsQuery(raw: string): string {
  if (!raw || typeof raw !== "string") {
    return "default";
  }

  // Remove control characters but keep normal whitespace and punctuation
  const cleaned = raw.replace(/[\x00-\x1F\x7F]/g, "").trim();
  
  if (cleaned.length === 0) {
    return "default";
  }

  // Truncate very long queries to avoid performance issues
  const maxLength = 500;
  if (cleaned.length > maxLength) {
    return cleaned.substring(0, maxLength).trim();
  }

  return cleaned;
}