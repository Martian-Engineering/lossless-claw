/**
 * Embeddings store — LCM v4.1 §13
 *
 * Per-model `lcm_embeddings_<slug>` vec0 virtual tables. All vec0
 * interaction goes through this module — callers never touch vec0 SQL
 * directly. Reasons:
 *
 *   1. sqlite-vec is best-effort. The extension may not be loadable in
 *      every environment (CI without it, dev box without npm install,
 *      forked installations). v4.1.1 A7 amendment: graceful degrade — if
 *      vec0 is missing, the rest of LCM still works (FTS-only retrieval,
 *      no semantic recall, lower retrieval quality but no crash). All
 *      embedding writes become no-ops.
 *
 *   2. vec0 schema discipline. vec0 partition keys, metadata columns,
 *      and auxiliary columns each have different syntax + UPDATE
 *      semantics. v4.1.1 noted that "UPDATE on PARTITION KEY corrupts
 *      vec0" — we use METADATA columns for `suppressed` (UPDATE works)
 *      and AUXILIARY columns for `embedded_id` / `embedded_kind` (UPDATE
 *      not needed; these are insert-once). Centralizing the SQL here
 *      prevents callers from accidentally choosing the wrong column
 *      class.
 *
 *   3. INTEGER metadata cols in vec0 require BigInt at the binding
 *      site under Node's `node:sqlite`. JS `0` literal binds as FLOAT
 *      and vec0 rejects it ("Expected integer for INTEGER metadata
 *      column"). Centralizing BigInt conversion here prevents callers
 *      from learning this the hard way.
 *
 *   4. Mapping (embedded_id TEXT, embedded_kind TEXT) ↔ vec0 internal
 *      rowid. We store both as auxiliary columns so KNN queries return
 *      them directly — no separate join to a mapping table needed.
 *      `lcm_embedding_meta` is a parallel sidecar for non-vector queries
 *      (was-this-id-embedded-yet?) but is not required to resolve KNN
 *      results back to source documents.
 */

import type { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join, resolve } from "node:path";

/**
 * Allowed model-name shape for use in `lcm_embeddings_<slug>` table names.
 * SQL identifiers don't accept arbitrary strings; we sanitize aggressively
 * and reject anything outside `[a-z0-9_]` after sluggification. This
 * doubles as defense-in-depth against table-name injection.
 */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Convert a Voyage model name (e.g. `voyage-4-large`) into a SQL-safe
 * table-name suffix (e.g. `voyage4large`). Lowercase, alphanumeric only.
 *
 * Throws if `modelName` is empty or contains characters outside the
 * accepted set — caller bug.
 */
export function embeddingsTableName(modelName: string): string {
  if (!MODEL_NAME_PATTERN.test(modelName)) {
    throw new Error(
      `[embeddings.store] invalid model name: ${JSON.stringify(modelName)} ` +
        `(must match ${MODEL_NAME_PATTERN}; got len=${modelName.length})`,
    );
  }
  const slug = modelName.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (slug.length === 0) {
    throw new Error(
      `[embeddings.store] model name "${modelName}" sluggifies to empty — pick a different model name`,
    );
  }
  return `lcm_embeddings_${slug}`;
}

/**
 * Where this module looks for `vec0.dylib` / `vec0.so` / `vec0.dll`. In
 * order:
 *
 *   1. Explicit path passed via `opts.path`.
 *   2. Env var `LCM_SQLITE_VEC_PATH`.
 *   3. Plugin's `node_modules/sqlite-vec-<platform>-<arch>/vec0.<ext>`.
 *   4. OpenClaw extensions dir's `node_modules/sqlite-vec-<platform>-<arch>/vec0.<ext>`.
 */
export function candidateVec0Paths(): string[] {
  const ext = platform() === "win32" ? "dll" : platform() === "darwin" ? "dylib" : "so";
  const platformPkg = `sqlite-vec-${platform() === "win32" ? "windows" : platform()}-${arch()}`;
  const candidates: string[] = [];

  const envPath = process.env.LCM_SQLITE_VEC_PATH?.trim();
  if (envPath) candidates.push(envPath);

  // Plugin-local install (when this module is bundled with the plugin)
  candidates.push(resolve(process.cwd(), "node_modules", platformPkg, `vec0.${ext}`));

  // OpenClaw extensions dir (typical local-dev install)
  candidates.push(
    join(homedir(), ".openclaw", "extensions", "node_modules", platformPkg, `vec0.${ext}`),
  );

  return candidates;
}

export interface LoadVec0Options {
  /** Override candidate-search with explicit path. */
  path?: string;
  /** Suppress console.warn on failure. Default false. */
  silent?: boolean;
}

/**
 * Best-effort load of the sqlite-vec extension. Returns true on success.
 * Returns false (and optionally logs a warning) if the extension is
 * unavailable — the rest of LCM continues to work without semantic search.
 *
 * After this returns true, vec0 SQL is available on the connection. The
 * connection's `allowExtension` option must have been set when the
 * connection was opened (default false in `node:sqlite`).
 *
 * Idempotent: safe to call multiple times on the same connection;
 * sqlite-vec only registers vec0 once per process (subsequent
 * `loadExtension` calls are essentially no-ops).
 */
export function tryLoadSqliteVec(db: DatabaseSync, opts: LoadVec0Options = {}): boolean {
  const candidates = opts.path ? [opts.path] : candidateVec0Paths();

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      // Node 22+ DatabaseSync exposes loadExtension; throws if the
      // connection wasn't opened with `allowExtension: true`. We surface
      // that as a controlled failure rather than a crash.
      (db as unknown as { loadExtension(filename: string): void }).loadExtension(candidate);
      return true;
    } catch (e: unknown) {
      if (!opts.silent) {
        // eslint-disable-next-line no-console
        console.warn(
          `[embeddings.store] failed to load sqlite-vec at ${candidate}: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
      // Continue to next candidate — maybe a different one works
    }
  }
  return false;
}

/**
 * Cheap probe: did sqlite-vec successfully register? Tries to call
 * `vec_version()`. Returns `null` if not loaded.
 */
export function vec0Version(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT vec_version() AS v").get() as { v?: string } | undefined;
    return row?.v ?? null;
  } catch {
    return null;
  }
}

/**
 * Create the `lcm_embeddings_<slug>` vec0 virtual table for a given model
 * if it doesn't exist. Throws if sqlite-vec is not loaded (caller should
 * gate with {@link vec0Version}).
 *
 * Schema:
 *   - `embedding float[<dim>]` — the actual vector
 *   - `+embedded_id text` — AUXILIARY; stores `summaries.summary_id` /
 *     `lcm_entities.entity_id` / `lcm_themes.theme_id` (polymorphic).
 *     Auxiliary because we never WHERE-filter on it — KNN returns at most
 *     k rows and the application joins/displays from there.
 *   - `embedded_kind text` — METADATA; one of 'summary'/'entity'/'theme'.
 *     Metadata (not auxiliary) because retrieval surfaces filter by kind
 *     during the KNN traversal (`WHERE embedded_kind IN ('summary')`),
 *     and vec0 only allows WHERE on metadata cols inside MATCH queries —
 *     auxiliary cols throw "illegal WHERE constraint" if filtered.
 *   - `suppressed integer` — METADATA; 0/1 for fast WHERE-pre-filter on
 *     KNN queries (so suppressed rows never appear in retrieval results
 *     without a separate JOIN to summaries).
 *
 * Idempotent via `IF NOT EXISTS`.
 *
 * Also creates per-model triggers on `summaries` (B.03):
 *
 *   - `lcm_embed_suppress_<slug>` — AFTER UPDATE OF suppressed_at on
 *     summaries, mirrors NULL-vs-not-NULL into vec0.suppressed metadata
 *     col. Why we use a trigger: the suppression cascade has to fire
 *     every time the operator marks a leaf suppressed (could be from
 *     any path — `lcm_purge`, agent tool, manual SQL); a trigger is
 *     guaranteed-by-DB rather than guaranteed-by-convention.
 *
 *   - `lcm_embed_delete_<slug>` — AFTER DELETE on summaries, removes
 *     vec0 row. Why a trigger and not FK CASCADE: vec0 corrupts under
 *     FK constraints (v4.1.1 finding). Trigger is the only safe path.
 *
 * Both triggers are per-model (one set per `lcm_embeddings_<slug>` table)
 * because vec0 SQL doesn't support dynamic table-name resolution inside
 * triggers — each trigger references its specific vec0 table by name.
 *
 * v4.1.1 NOTE on entities/themes: parallel triggers should be created
 * for `lcm_entities` and `lcm_themes` when those embeddings are added
 * (Group E entity coreference, Group G themes). For now the embedding
 * store only knows about summary embeddings; entity/theme triggers will
 * extend this helper or land their own when Groups E/G ship.
 */
export function ensureEmbeddingsTable(
  db: DatabaseSync,
  modelName: string,
  dim: number,
): void {
  if (!Number.isInteger(dim) || dim <= 0 || dim > 4096) {
    throw new Error(`[embeddings.store] invalid dim ${dim} (must be 1-4096)`);
  }
  const tableName = embeddingsTableName(modelName);
  // No bind params allowed in CREATE VIRTUAL TABLE / CREATE TRIGGER;
  // tableName has been validated via embeddingsTableName regex (alphanum+underscore).
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${tableName} USING vec0(
       embedding float[${dim}],
       +embedded_id text,
       embedded_kind text,
       suppressed integer
     )`,
  );

  // Per-model suppression cascade trigger. Fires only when the
  // suppressed_at column actually transitioned NULL ↔ not-NULL — avoids
  // unnecessary work when other columns of summaries are updated. We use
  // BigInt literal-style 0/1 in CASE because vec0 INTEGER metadata cols
  // require integer-typed values (JS-floats rejected).
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS lcm_embed_suppress_${tableName.replace(/^lcm_embeddings_/, "")}
       AFTER UPDATE OF suppressed_at ON summaries
       WHEN (NEW.suppressed_at IS NULL) != (OLD.suppressed_at IS NULL)
       BEGIN
         UPDATE ${tableName}
           SET suppressed = CASE WHEN NEW.suppressed_at IS NULL THEN 0 ELSE 1 END
           WHERE embedded_id = NEW.summary_id AND embedded_kind = 'summary';
       END`,
  );

  // Per-model deletion cascade trigger. Fires on hard-delete of a summary
  // (only path: lcm_purge with --immediate, or migration cleanup). Removes
  // the vec0 row so KNN doesn't return a dangling pointer.
  db.exec(
    `CREATE TRIGGER IF NOT EXISTS lcm_embed_delete_${tableName.replace(/^lcm_embeddings_/, "")}
       AFTER DELETE ON summaries
       BEGIN
         DELETE FROM ${tableName}
           WHERE embedded_id = OLD.summary_id AND embedded_kind = 'summary';
       END`,
  );
}

/**
 * Drop the per-model triggers (and optionally the vec0 table) for a
 * given model. Used during model archival / cutover.
 *
 * If `dropTable` is true, also drops the vec0 virtual table itself —
 * unrecoverable. Default false (keeps the table for forensic queries
 * even after archival; only the active flag flips in `lcm_embedding_profile`).
 */
export function dropEmbeddingsTriggers(
  db: DatabaseSync,
  modelName: string,
  opts: { dropTable?: boolean } = {},
): void {
  const tableName = embeddingsTableName(modelName);
  const slug = tableName.replace(/^lcm_embeddings_/, "");
  db.exec(`DROP TRIGGER IF EXISTS lcm_embed_suppress_${slug}`);
  db.exec(`DROP TRIGGER IF EXISTS lcm_embed_delete_${slug}`);
  if (opts.dropTable) {
    db.exec(`DROP TABLE IF EXISTS ${tableName}`);
  }
}

/**
 * INSERT OR IGNORE into lcm_embedding_profile. Idempotent. Caller passes
 * the dim we'll use for the vec0 table — this couples profile registration
 * to actual table creation so the two can't drift.
 *
 * v4.1 §13 / Group B Gap 2 fix: also enforces SLUG uniqueness across
 * profiles. Two model names that sluggify to the same vec0 table name
 * (e.g. "voyage-4-large" and "voyage_4_large" both → "voyage4large")
 * would silently corrupt KNN by routing inserts to the same table —
 * the second registration here throws to prevent that.
 *
 * Throws if:
 *   - modelName fails MODEL_NAME_PATTERN regex
 *   - dim is not a positive integer or > 4096 (Gap 8: align with ensureEmbeddingsTable)
 *   - existing profile with same name has different dim
 *   - existing profile has same SLUG but different name
 */
export function registerEmbeddingProfile(
  db: DatabaseSync,
  modelName: string,
  dim: number,
): void {
  if (!MODEL_NAME_PATTERN.test(modelName)) {
    throw new Error(`[embeddings.store] invalid model name: ${JSON.stringify(modelName)}`);
  }
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`[embeddings.store] invalid dim ${dim}`);
  }
  // Group B Gap 8 fix: align dim upper bound between
  // registerEmbeddingProfile and ensureEmbeddingsTable.
  if (dim > 4096) {
    throw new Error(`[embeddings.store] invalid dim ${dim} (max 4096)`);
  }

  // Group B Gap 2 fix: check slug uniqueness BEFORE inserting. Compute
  // slug, scan existing profiles, throw if a different model_name already
  // has the same slug (would cause vec0 table-name collision).
  const ourSlug = modelName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const existingSlugCollision = db
    .prepare(`SELECT model_name FROM lcm_embedding_profile WHERE model_name != ?`)
    .all(modelName) as Array<{ model_name: string }>;
  for (const other of existingSlugCollision) {
    const otherSlug = other.model_name.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (otherSlug === ourSlug) {
      throw new Error(
        `[embeddings.store] slug collision: model_name "${modelName}" sluggifies to ` +
          `"${ourSlug}" which is already used by registered model "${other.model_name}". ` +
          `Two profiles cannot share a vec0 table name. Pick a model_name that sluggifies differently.`,
      );
    }
  }

  // INSERT OR IGNORE: if a row exists with the same model_name, leave it
  // alone (whether the dim matches or not is checked next).
  db.prepare(
    `INSERT OR IGNORE INTO lcm_embedding_profile (model_name, dim, active)
     VALUES (?, ?, 1)`,
  ).run(modelName, dim);

  // Defensive: if a profile exists with a DIFFERENT dim, that's a bug —
  // dim is locked at first registration. Silently accepting a mismatched
  // dim would corrupt the vec0 table.
  const row = db
    .prepare(`SELECT dim FROM lcm_embedding_profile WHERE model_name = ?`)
    .get(modelName) as { dim?: number } | undefined;
  if (!row) {
    throw new Error(`[embeddings.store] failed to register profile ${modelName}`);
  }
  if (row.dim !== dim) {
    throw new Error(
      `[embeddings.store] dim mismatch for ${modelName}: existing profile has dim=${row.dim}, ` +
        `caller passed dim=${dim}. Profiles are immutable; bump model_name (e.g. add suffix) instead.`,
    );
  }
}

export type EmbeddedKind = "summary" | "entity" | "theme";

/**
 * Insert (or replace) an embedding for a (id, kind) pair under the given
 * model. Updates BOTH the vec0 table AND `lcm_embedding_meta` in the
 * caller's transaction (caller wraps both calls together for atomicity).
 *
 * Throws if the dim of `vector` doesn't match the registered profile dim.
 *
 * Note: we DO NOT wrap in a transaction here — the caller does, because
 * the leaf-write path embeds inside its existing T1, and the backfill
 * cron groups multiple inserts into a single transaction for throughput.
 */
export function recordEmbedding(
  db: DatabaseSync,
  args: {
    modelName: string;
    embeddedId: string;
    embeddedKind: EmbeddedKind;
    vector: Float32Array | number[];
    suppressed?: boolean;
    sourceTokenCount: number;
  },
): void {
  const { modelName, embeddedId, embeddedKind, vector, suppressed, sourceTokenCount } = args;
  const profile = db
    .prepare(`SELECT dim FROM lcm_embedding_profile WHERE model_name = ?`)
    .get(modelName) as { dim?: number } | undefined;
  if (!profile) {
    throw new Error(
      `[embeddings.store] no profile registered for ${modelName} — call registerEmbeddingProfile first`,
    );
  }
  if (vector.length !== profile.dim) {
    throw new Error(
      `[embeddings.store] dim mismatch: vector.length=${vector.length}, profile.dim=${profile.dim}`,
    );
  }
  const tableName = embeddingsTableName(modelName);

  // vec0 stores vectors as JSON arrays; binding a Float32Array directly
  // does NOT serialize correctly under node:sqlite (it becomes a BLOB
  // that vec0 doesn't know how to parse into a vector). Stringify.
  const vecJson = JSON.stringify(Array.from(vector));
  // INTEGER metadata cols require BigInt under node:sqlite, see
  // module-level docs (vec0 sees JS number 0 as FLOAT and rejects).
  const suppressedBig = suppressed ? 1n : 0n;

  // We DON'T enforce uniqueness on (embedded_id, embedded_kind) inside
  // vec0 — auxiliary cols aren't UNIQUE-indexed. Caller responsibility:
  // delete any prior row before inserting (or use the provided helper
  // {@link replaceEmbedding}).
  db.prepare(
    `INSERT INTO ${tableName} (embedding, embedded_id, embedded_kind, suppressed)
     VALUES (?, ?, ?, ?)`,
  ).run(vecJson, embeddedId, embeddedKind, suppressedBig);

  // Mirror in lcm_embedding_meta — sidecar for "is this thing embedded?"
  // queries that don't need to load the vector.
  db.prepare(
    `INSERT OR REPLACE INTO lcm_embedding_meta
       (embedded_id, embedded_kind, embedding_model, embedded_at, source_token_count, archived)
     VALUES (?, ?, ?, datetime('now'), ?, 0)`,
  ).run(embeddedId, embeddedKind, modelName, sourceTokenCount);
}

/**
 * Replace an existing embedding for a (id, kind, model) tuple. Deletes
 * any prior vec0 rows then inserts. Use when the source content was
 * regenerated (e.g., leaf re-summarized at higher cap per A.10).
 */
export function replaceEmbedding(
  db: DatabaseSync,
  args: Parameters<typeof recordEmbedding>[1],
): void {
  const tableName = embeddingsTableName(args.modelName);
  db.prepare(
    `DELETE FROM ${tableName} WHERE embedded_id = ? AND embedded_kind = ?`,
  ).run(args.embeddedId, args.embeddedKind);
  recordEmbedding(db, args);
}

/**
 * Delete an embedding (e.g., when source row is hard-deleted by purge).
 * Removes from both vec0 and lcm_embedding_meta.
 */
export function deleteEmbedding(
  db: DatabaseSync,
  args: { modelName: string; embeddedId: string; embeddedKind: EmbeddedKind },
): void {
  const tableName = embeddingsTableName(args.modelName);
  db.prepare(
    `DELETE FROM ${tableName} WHERE embedded_id = ? AND embedded_kind = ?`,
  ).run(args.embeddedId, args.embeddedKind);
  db.prepare(
    `DELETE FROM lcm_embedding_meta
       WHERE embedded_id = ? AND embedded_kind = ? AND embedding_model = ?`,
  ).run(args.embeddedId, args.embeddedKind, args.modelName);
}

/**
 * Mark / unmark an embedding as suppressed. Updates the metadata column
 * inside vec0 so subsequent KNN queries can pre-filter via
 * `WHERE suppressed = 0` (much cheaper than a JOIN to summaries).
 *
 * Note: vec0 supports UPDATE on metadata columns. (UPDATE on PARTITION
 * KEY columns is documented as broken; we don't use partition keys.)
 */
export function markEmbeddingSuppressed(
  db: DatabaseSync,
  args: {
    modelName: string;
    embeddedId: string;
    embeddedKind: EmbeddedKind;
    suppressed: boolean;
  },
): void {
  const tableName = embeddingsTableName(args.modelName);
  db.prepare(
    `UPDATE ${tableName} SET suppressed = ?
       WHERE embedded_id = ? AND embedded_kind = ?`,
  ).run(args.suppressed ? 1n : 0n, args.embeddedId, args.embeddedKind);
}

export interface SearchSimilarOptions {
  modelName: string;
  queryVector: Float32Array | number[];
  k?: number;
  /** Filter to specific embedded_kind values. Default = ['summary']. */
  embeddedKinds?: EmbeddedKind[];
  /**
   * If true (default), excludes rows with suppressed=1 via vec0 metadata
   * pre-filter. v4.1 §10 invariant: every retrieval surface MUST suppress
   * by default; opt-in to false only for operator/admin tools.
   */
  excludeSuppressed?: boolean;
}

export interface SearchHit {
  embeddedId: string;
  embeddedKind: EmbeddedKind;
  distance: number;
}

/**
 * KNN search against the per-model vec0 table. Returns nearest-K rows,
 * cosine distance ascending (smallest = most similar).
 *
 * Throws if the embeddings table for this model doesn't exist. Caller
 * should `vec0Version(db) !== null && embeddingsTableExists(db, modelName)`
 * gate.
 */
export function searchSimilar(
  db: DatabaseSync,
  opts: SearchSimilarOptions,
): SearchHit[] {
  const k = opts.k ?? 50;
  if (!Number.isInteger(k) || k <= 0 || k > 1000) {
    throw new Error(`[embeddings.store] invalid k=${k} (must be 1-1000)`);
  }
  const excludeSuppressed = opts.excludeSuppressed !== false;
  const kinds = opts.embeddedKinds ?? ["summary"];
  if (kinds.length === 0) return [];

  const tableName = embeddingsTableName(opts.modelName);
  const vecJson = JSON.stringify(Array.from(opts.queryVector));

  // Build kinds filter — placeholder list, parameterized
  const kindPlaceholders = kinds.map(() => "?").join(",");
  const suppressedFilter = excludeSuppressed ? "AND suppressed = 0" : "";

  const sql = `
    SELECT embedded_id, embedded_kind, distance
    FROM ${tableName}
    WHERE embedding MATCH ?
      AND k = ?
      ${suppressedFilter}
      AND embedded_kind IN (${kindPlaceholders})
    ORDER BY distance
  `;
  const rows = db.prepare(sql).all(vecJson, k, ...kinds) as Array<{
    embedded_id: string;
    embedded_kind: EmbeddedKind;
    distance: number;
  }>;
  return rows.map((r) => ({
    embeddedId: r.embedded_id,
    embeddedKind: r.embedded_kind,
    distance: r.distance,
  }));
}

/**
 * Does the vec0 virtual table for this model exist? Cheap sqlite_master
 * check; safe to call when vec0 isn't loaded (returns false).
 */
export function embeddingsTableExists(db: DatabaseSync, modelName: string): boolean {
  const tableName = embeddingsTableName(modelName);
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?`)
    .get(tableName) as { name?: string } | undefined;
  return Boolean(row?.name);
}

/**
 * Has this (id, kind, model) tuple been embedded? Cheap meta lookup; no
 * vec0 access. Used by backfill cron to skip already-embedded rows.
 */
export function isEmbedded(
  db: DatabaseSync,
  args: { embeddedId: string; embeddedKind: EmbeddedKind; modelName: string },
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS x FROM lcm_embedding_meta
         WHERE embedded_id = ? AND embedded_kind = ? AND embedding_model = ? AND archived = 0`,
    )
    .get(args.embeddedId, args.embeddedKind, args.modelName) as { x?: number } | undefined;
  return Boolean(row?.x);
}
