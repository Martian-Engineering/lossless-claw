/**
 * Bounds for search paths that must read row content because no index can
 * answer the predicate (regex patterns and LIKE substring fallbacks).
 *
 * Scans walk rows newest-first in keyset chunks over a time index and stop
 * when the row or time budget is spent, so one search never materializes a
 * whole table or holds a connection for an unbounded time.
 */
export type SearchScanLimits = {
  /** Newest rows a regex search may examine. */
  regexMaxRows: number;
  /** Newest rows a LIKE substring fallback may examine. */
  likeMaxRows: number;
  /** Wall-clock budget for one bounded scan, checked between chunks. */
  maxScanMs: number;
  /** Rows fetched per keyset chunk. */
  chunkRows: number;
};

export const DEFAULT_SEARCH_SCAN_LIMITS: SearchScanLimits = {
  regexMaxRows: 10_000,
  likeMaxRows: 100_000,
  maxScanMs: 10_000,
  chunkRows: 200,
};

/**
 * Search results plus whether a bounded scan stopped before it examined every
 * candidate row in scope.
 */
export type SearchOutcome<T> = {
  results: T[];
  scanLimited: boolean;
};

/** Fill unspecified scan limits with the defaults. */
export function resolveSearchScanLimits(
  overrides?: Partial<SearchScanLimits>,
): SearchScanLimits {
  return { ...DEFAULT_SEARCH_SCAN_LIMITS, ...overrides };
}
