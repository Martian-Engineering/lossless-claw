/**
 * Sanitize a user-provided query for use in an FTS5 MATCH expression.
 *
 * FTS5 treats certain characters as operators:
 *   - `-` (NOT), `+` (required), `*` (prefix), `^` (initial token)
 *   - `OR`, `AND`, `NOT` (boolean operators)
 *   - `:` (column filter — e.g. `agent:foo` means "search column agent")
 *   - `"` (phrase query), `(` `)` (grouping)
 *   - `NEAR` (proximity)
 *
 * If the query contains any of these, naive MATCH will either error
 * ("no such column") or return unexpected results.
 *
 * Strategy: wrap each whitespace-delimited token in double quotes so FTS5
 * treats it as a literal phrase token. Internal double quotes are stripped.
 * Empty tokens are dropped. Tokens are joined with spaces (implicit AND).
 *
 * Examples:
 *   "sub-agent restrict"  →  '"sub-agent" "restrict"'
 *   "lcm_expand OR crash" →  '"lcm_expand" "OR" "crash"'
 *   'hello "world"'       →  '"hello" "world"'
 */
export function sanitizeFts5Query(raw: string): string {
  // Preserve user-quoted phrases: extract "..." groups first, then tokenize the rest.
  const parts: string[] = [];
  const phraseRegex = /"([^"]+)"/g;
  let match: RegExpExecArray | null;
  let lastIndex = 0;

  while ((match = phraseRegex.exec(raw)) !== null) {
    // Process unquoted text before this phrase
    const before = raw.slice(lastIndex, match.index);
    for (const t of before.split(/\s+/).filter(Boolean)) {
      parts.push(`"${t.replace(/"/g, "")}"`);
    }
    // Preserve the phrase as-is (strip internal quotes for safety)
    const phrase = match[1].replace(/"/g, "").trim();
    if (phrase) {
      parts.push(`"${phrase}"`);
    }
    lastIndex = match.index + match[0].length;
  }

  // Process unquoted text after last phrase
  for (const t of raw.slice(lastIndex).split(/\s+/).filter(Boolean)) {
    parts.push(`"${t.replace(/"/g, "")}"`);
  }

  return parts.length > 0 ? parts.join(" ") : '""';
}
