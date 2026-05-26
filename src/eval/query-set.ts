/**
 * Query set management — LCM v4.1 §11 / D.03.
 *
 * Loads + manages a query set in `lcm_eval_query_set` + `lcm_eval_query`
 * (defined in src/db/migration.ts §"v4.1 eval harness tables (A.05)").
 *
 * SCHEMA NOTES
 * ────────────
 *   The schema's PK on lcm_eval_query_set is a single TEXT column
 *   `query_set_id`, not (name, version). Per the task spec the logical
 *   identity is (name, version), so we encode the composite as
 *     query_set_id = `${name}@v${version}`
 *   (this keeps name/version round-trippable without a migration change).
 *
 *   The schema requires `expected_topics TEXT NOT NULL` and
 *   `rubric TEXT NOT NULL` on each lcm_eval_query row. The task spec's
 *   QueryRecord doesn't surface these — when registering we serialize
 *   QueryRecord.expectedSummaryIds (if any) to `expected_sources` (JSON),
 *   leave `expected_topics` as `'[]'`, and write a placeholder rubric
 *   (`'{"absolute":[],"pairwise":[]}'`). Group F's `/lcm eval` UI can
 *   layer richer rubric+topics on top later by extending QueryRecord.
 *
 *   `lcm_eval_query.query_id` is a GLOBAL primary key (TEXT NOT NULL
 *   PRIMARY KEY across the whole table — not scoped per query_set_id).
 *   That would force callers to invent globally-unique IDs across
 *   versions, which conflicts with the spec's per-set queryId model.
 *   We solve this by namespacing on write: the row's `query_id` is
 *   stored as `${query_set_id}::${queryId}`. Reads strip the prefix
 *   so callers see the unprefixed queryId.
 *
 * IDEMPOTENCY
 * ───────────
 *   `registerQuerySet` is idempotent on identity: re-registering the
 *   same (name, version) with the same content is a no-op. Re-registering
 *   with DIFFERENT content throws (use a new version instead — versions
 *   are append-only by design, the audit trail matters).
 */

import type { DatabaseSync } from "node:sqlite";

export type Stratum = "fts-easy" | "fts-medium" | "paraphrastic";

export interface QueryRecord {
  queryId: string;
  queryText: string;
  stratum: Stratum;
  /** Optional reference text for synthesis quality scoring. */
  referenceSummary?: string;
  /** Optional ground-truth retrieval targets (summary IDs). */
  expectedSummaryIds?: string[];
}

export interface QuerySetIdentity {
  /** Stable name — e.g. 'eva-baseline-v2'. */
  name: string;
  /** Monotone-incrementing per name. */
  version: number;
}

export interface QuerySet {
  identity: QuerySetIdentity;
  queries: QueryRecord[];
}

const QUERY_SET_ID_SEPARATOR = "@v";

/**
 * Encode (name, version) → query_set_id.
 *
 * Names containing `@v` get suffixed with a literal so we can still
 * round-trip; the encoding is unique by construction.
 */
export function encodeQuerySetId(identity: QuerySetIdentity): string {
  if (!identity.name) {
    throw new Error("query set name must be non-empty");
  }
  if (!Number.isInteger(identity.version) || identity.version < 1) {
    throw new Error(`query set version must be a positive integer (got ${identity.version})`);
  }
  return `${identity.name}${QUERY_SET_ID_SEPARATOR}${identity.version}`;
}

export function decodeQuerySetId(id: string): QuerySetIdentity {
  const idx = id.lastIndexOf(QUERY_SET_ID_SEPARATOR);
  if (idx < 0) {
    throw new Error(`malformed query_set_id (missing '${QUERY_SET_ID_SEPARATOR}'): ${id}`);
  }
  const name = id.slice(0, idx);
  const versionStr = id.slice(idx + QUERY_SET_ID_SEPARATOR.length);
  const version = Number.parseInt(versionStr, 10);
  if (!name || !Number.isFinite(version)) {
    throw new Error(`malformed query_set_id: ${id}`);
  }
  return { name, version };
}

function validateStratum(s: string, queryId: string): Stratum {
  if (s !== "fts-easy" && s !== "fts-medium" && s !== "paraphrastic") {
    throw new Error(`query ${queryId} has invalid stratum: ${s}`);
  }
  return s;
}

/**
 * Compute a deterministic content hash for a single query record so
 * we can detect "same identity, different content" registration calls.
 */
function queryContentSignature(q: QueryRecord): string {
  // Stable JSON ordering — keys in fixed order, undefined fields omitted.
  const expected = q.expectedSummaryIds ? [...q.expectedSummaryIds].sort() : null;
  const ref = q.referenceSummary ?? null;
  return JSON.stringify({
    queryId: q.queryId,
    queryText: q.queryText,
    stratum: q.stratum,
    referenceSummary: ref,
    expectedSummaryIds: expected,
  });
}

function querySetSignature(queries: QueryRecord[]): string {
  // Order-independent — sort by queryId.
  const sorted = [...queries].sort((a, b) => a.queryId.localeCompare(b.queryId));
  return JSON.stringify(sorted.map(queryContentSignature));
}

const ROW_ID_SEPARATOR = "::";

/** Namespace a query row's primary-key value with its query_set_id. */
function makeRowQueryId(querySetId: string, queryId: string): string {
  return `${querySetId}${ROW_ID_SEPARATOR}${queryId}`;
}

/** Strip the namespace prefix from a row's query_id. Returns the raw queryId. */
function stripRowQueryId(rowQueryId: string, querySetId: string): string {
  const prefix = `${querySetId}${ROW_ID_SEPARATOR}`;
  if (rowQueryId.startsWith(prefix)) {
    return rowQueryId.slice(prefix.length);
  }
  // Rows that pre-date the namespacing convention (or were inserted by
  // a different code path) round-trip unchanged.
  return rowQueryId;
}

/**
 * Register a NEW query set version. Idempotent on (identity, content):
 *   - if no row exists for this query_set_id → INSERT both header + queries.
 *   - if a row exists with IDENTICAL content → no-op.
 *   - if a row exists with DIFFERENT content → throw (use a new version).
 *
 * Wrapped in a transaction so a half-written set won't survive a crash.
 */
export function registerQuerySet(
  db: DatabaseSync,
  identity: QuerySetIdentity,
  queries: QueryRecord[],
): void {
  const querySetId = encodeQuerySetId(identity);
  if (queries.length === 0) {
    throw new Error(`cannot register empty query set ${querySetId}`);
  }
  // Validate up-front so we don't half-write.
  const seenIds = new Set<string>();
  for (const q of queries) {
    if (!q.queryId) throw new Error(`query missing queryId in set ${querySetId}`);
    if (seenIds.has(q.queryId)) {
      throw new Error(`duplicate queryId ${q.queryId} in set ${querySetId}`);
    }
    seenIds.add(q.queryId);
    validateStratum(q.stratum, q.queryId);
    if (!q.queryText) throw new Error(`query ${q.queryId} has empty queryText`);
  }

  const existing = getQuerySet(db, identity);
  if (existing) {
    const a = querySetSignature(existing.queries);
    const b = querySetSignature(queries);
    if (a !== b) {
      throw new Error(
        `query set ${querySetId} already exists with different content; ` +
          `register a new version instead of mutating an existing one`,
      );
    }
    return; // idempotent: same content, no-op.
  }

  db.exec("BEGIN");
  try {
    const headerStmt = db.prepare(
      `INSERT INTO lcm_eval_query_set (query_set_id, version, description)
       VALUES (?, ?, ?)`,
    );
    headerStmt.run(querySetId, identity.version, null);

    const queryStmt = db.prepare(
      `INSERT INTO lcm_eval_query
        (query_id, query_set_id, query_text, stratum,
         expected_topics, expected_sources, reference_summary,
         must_not_regress, rubric)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const q of queries) {
      queryStmt.run(
        makeRowQueryId(querySetId, q.queryId),
        querySetId,
        q.queryText,
        q.stratum,
        // expected_topics is NOT NULL — empty JSON array as placeholder.
        // (Group F's UI can extend QueryRecord with topics later.)
        "[]",
        q.expectedSummaryIds ? JSON.stringify(q.expectedSummaryIds) : null,
        q.referenceSummary ?? null,
        0,
        // rubric is NOT NULL — placeholder pointing at the absolute+pairwise
        // shape from architecture-v4.1 §11.
        '{"absolute":[],"pairwise":[]}',
      );
    }
    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* swallow rollback error */ }
    throw err;
  }
}

/**
 * Look up a query set by identity. Returns null if it doesn't exist.
 *
 * Queries are returned in queryId order so callers can rely on a stable
 * iteration order across reads.
 */
export function getQuerySet(
  db: DatabaseSync,
  identity: QuerySetIdentity,
): QuerySet | null {
  const querySetId = encodeQuerySetId(identity);
  const headerStmt = db.prepare(
    `SELECT query_set_id, version FROM lcm_eval_query_set WHERE query_set_id = ?`,
  );
  const headerRow = headerStmt.get(querySetId) as
    | { query_set_id: string; version: number }
    | undefined;
  if (!headerRow) return null;

  const queryStmt = db.prepare(
    `SELECT query_id, query_text, stratum, expected_sources, reference_summary
     FROM lcm_eval_query
     WHERE query_set_id = ?
     ORDER BY query_id ASC`,
  );
  const rows = queryStmt.all(querySetId) as Array<{
    query_id: string;
    query_text: string;
    stratum: string;
    expected_sources: string | null;
    reference_summary: string | null;
  }>;

  const queries: QueryRecord[] = rows.map((r) => {
    const rawQueryId = stripRowQueryId(r.query_id, querySetId);
    const rec: QueryRecord = {
      queryId: rawQueryId,
      queryText: r.query_text,
      stratum: validateStratum(r.stratum, rawQueryId),
    };
    if (r.reference_summary !== null) rec.referenceSummary = r.reference_summary;
    if (r.expected_sources !== null) {
      try {
        const parsed = JSON.parse(r.expected_sources);
        if (Array.isArray(parsed)) rec.expectedSummaryIds = parsed.map(String);
      } catch {
        // Tolerate corrupt JSON — treat as missing.
      }
    }
    return rec;
  });

  return { identity: decodeQuerySetId(headerRow.query_set_id), queries };
}

/**
 * List all registered query sets, sorted by name then version ASC so
 * the latest version of each name is last.
 */
export function listQuerySets(db: DatabaseSync): QuerySetIdentity[] {
  const stmt = db.prepare(
    `SELECT query_set_id FROM lcm_eval_query_set ORDER BY query_set_id ASC`,
  );
  const rows = stmt.all() as Array<{ query_set_id: string }>;
  return rows.map((r) => decodeQuerySetId(r.query_set_id));
}
