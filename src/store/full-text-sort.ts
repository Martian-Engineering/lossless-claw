export type SearchSort = "recency" | "relevance" | "hybrid";

export const AGE_DECAY_RATE = 0.001;

/**
 * Build the ORDER BY clause for FTS5-backed searches.
 *
 * `rank` is FTS5's BM25 score where lower (more negative) is better.
 * `hybrid` keeps that relevance signal but applies a mild age penalty before
 * LIMIT is enforced so older strong matches can still surface.
 */
export function buildFtsOrderBy(sort: SearchSort | undefined, createdAtExpr: string): string {
  switch (sort ?? "recency") {
    case "relevance":
      return `rank ASC, ${createdAtExpr} DESC`;
    case "hybrid":
      return `(rank / (1 + ((julianday('now') - julianday(${createdAtExpr})) * 24 * ${AGE_DECAY_RATE}))) ASC, ${createdAtExpr} DESC`;
    default:
      return `${createdAtExpr} DESC`;
  }
}
