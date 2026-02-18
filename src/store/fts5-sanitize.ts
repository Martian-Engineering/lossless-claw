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
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return '""';
  }
  return tokens.map((t) => `"${t.replace(/"/g, "")}"`).join(" ");
}
