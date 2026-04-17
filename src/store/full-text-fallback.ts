const RAW_TERM_RE = /"([^"]+)"|(\S+)/g;

/**
 * Detect whether a query contains CJK characters that FTS5 unicode61
 * tokenizer cannot index properly.
 */
const CJK_RE = /[\u2E80-\u9FFF\u3400-\u4DBF\uF900-\uFAFF\uAC00-\uD7AF\u3040-\u309F\u30A0-\u30FF]/;
export function containsCjk(text: string): boolean {
  return CJK_RE.test(text);
}
const EDGE_PUNCTUATION_RE = /^[`'"()[\]{}<>.,:;!?*_+=|\\/-]+|[`'"()[\]{}<>.,:;!?*_+=|\\/-]+$/g;

export type LikeSearchPlan = {
  terms: string[];
  where: string[];
  args: string[];
};

function normalizeFallbackTerm(raw: string): string {
  if (typeof raw !== "string") return "";
  return raw.trim().replace(EDGE_PUNCTUATION_RE, "").toLowerCase();
}

function escapeLike(term: string): string {
  return term.replace(/([\\%_])/g, "\\$1");
}

/**
 * Convert a free-text query into a conservative LIKE search plan.
 *
 * The fallback keeps phrase tokens when the query uses double quotes, and
 * otherwise searches for all normalized tokens as case-insensitive substrings.
 */
export function buildLikeSearchPlan(column: string, query: string): LikeSearchPlan {
  const terms: string[] = [];
  for (const match of query.matchAll(RAW_TERM_RE)) {
    const raw = match[1] ?? match[2] ?? "";
    const normalized = normalizeFallbackTerm(raw);
    if (normalized.length > 0 && !terms.includes(normalized)) {
      terms.push(normalized);
    }
  }

  if (terms.length === 0) {
    const fallback = normalizeFallbackTerm(query);
    if (fallback.length > 0) {
      terms.push(fallback);
    }
  }

  return {
    terms,
    where: terms.map(() => `LOWER(${column}) LIKE ? ESCAPE '\\'`),
    args: terms.map((term) => `%${escapeLike(term)}%`),
  };
}

/**
 * Build a compact snippet centered around the earliest matching term.
 */
export function createFallbackSnippet(content: string, terms: string[]): string {
  const haystack = content.toLowerCase();
  let matchIndex = -1;
  let matchLength = 0;

  for (const term of terms) {
    const idx = haystack.indexOf(term);
    if (idx !== -1 && (matchIndex === -1 || idx < matchIndex)) {
      matchIndex = idx;
      matchLength = term.length;
    }
  }

  if (matchIndex === -1) {
    const head = content.trim();
    return head.length <= 80 ? head : `${head.slice(0, 77).trimEnd()}...`;
  }

  const start = Math.max(0, matchIndex - 24);
  const end = Math.min(content.length, matchIndex + Math.max(matchLength, 1) + 40);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < content.length ? "..." : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}
