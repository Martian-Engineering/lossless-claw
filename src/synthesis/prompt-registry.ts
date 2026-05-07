/**
 * Prompt registry — LCM v4.1 §3 / Group D.
 *
 * Versioned prompt templates per (memory_type, tier_label, pass_kind).
 * Append-only: old versions stay archived (active=0) for traceability;
 * new versions are added (active=1) and the previous-active row is
 * marked archived in the same transaction.
 *
 * Schema lives in lcm_prompt_registry (created in A.04 + B.fix Gap 2 NULL
 * UNIQUE patch).
 *
 * Why versioning matters: synthesis cache rows reference a prompt_id
 * (Group D's lcm_synthesis_cache.prompt_id FK). When a prompt is updated,
 * cache invalidation can be SELECTIVE — only the entries that used the
 * superseded prompt need to be rebuilt. Bumping `bundle_version` triggers
 * voice-consistency rebuild across the whole synthesis tier (when the
 * prompt set is updated as a coordinated unit).
 *
 * Lookup flow: callers ask for the active prompt for a (memory_type,
 * tier_label, pass_kind) triple — `getActivePrompt()` returns it. They
 * also get the prompt_id which they pass into the synthesis call so it
 * gets recorded on the cache row.
 *
 * Updates: `registerPrompt()` deactivates the previous-active version (if
 * any) AND inserts the new version, all in a single transaction. version
 * is auto-incremented (max(version) + 1 within the same triple).
 */

import type { DatabaseSync } from "node:sqlite";

export type MemoryType =
  | "episodic-leaf"
  | "episodic-condensed"
  | "episodic-yearly"
  | "procedural-extract"
  | "entity-extract"
  | "theme-consolidation";

export type PassKind = "single" | "verify_fidelity" | "best_of_n_judge";

export interface PromptRecord {
  promptId: string;
  memoryType: MemoryType;
  tierLabel: string | null;
  passKind: PassKind;
  version: number;
  template: string;
  modelRecommendation: string | null;
  createdAt: string;
  active: boolean;
  bundleVersion: number;
  notes: string | null;
}

export interface RegisterPromptOptions {
  memoryType: MemoryType;
  tierLabel?: string | null;
  passKind: PassKind;
  template: string;
  modelRecommendation?: string;
  bundleVersion?: number;
  notes?: string;
  /**
   * Override prompt_id. Default: `prompt_<memoryType>_<tierLabel ?? "any">_<passKind>_v<version>_<6hex>`.
   * Caller-supplied IDs must be unique (DB enforces via PK).
   */
  promptIdOverride?: string;
}

/**
 * Look up the currently-active prompt for the given (memory_type,
 * tier_label, pass_kind) triple. Returns null if none registered.
 *
 * NULL `tierLabel` is matched literally (i.e. `tierLabel: null` finds
 * a row where `tier_label IS NULL`, NOT a row where `tier_label = ""`).
 *
 * If two rows are somehow active for the same triple (shouldn't happen
 * thanks to `lcm_prompt_registry_active_idx` partial index, but
 * defensive), returns the highest-version one.
 */
export function getActivePrompt(
  db: DatabaseSync,
  args: { memoryType: MemoryType; tierLabel: string | null; passKind: PassKind },
): PromptRecord | null {
  // Group D adversarial Gap 3 fix: normalize empty-string tier_label
  // to null. The B.fix Gap 2 UNIQUE INDEX uses COALESCE(tier_label, '')
  // — treating NULL and '' as equivalent at the DB level. Aligning the
  // API surface here so callers don't get confusing "no row found"
  // results when they pass "" instead of null.
  const normalizedTier =
    args.tierLabel === null || args.tierLabel === "" ? null : args.tierLabel;
  const tierClause = normalizedTier === null ? "tier_label IS NULL" : "tier_label = ?";
  // Wave-9 TS-tightening: typed for DatabaseSync.get(...args).
  const params: string[] =
    normalizedTier === null
      ? [args.memoryType, args.passKind]
      : [args.memoryType, normalizedTier, args.passKind];
  const sql = `SELECT prompt_id, memory_type, tier_label, pass_kind, version, template,
                      model_recommendation, created_at, active, bundle_version, notes
                 FROM lcm_prompt_registry
                 WHERE memory_type = ? AND ${tierClause} AND pass_kind = ?
                   AND active = 1
                 ORDER BY version DESC LIMIT 1`;
  const row = db.prepare(sql).get(...params) as
    | {
        prompt_id: string;
        memory_type: MemoryType;
        tier_label: string | null;
        pass_kind: PassKind;
        version: number;
        template: string;
        model_recommendation: string | null;
        created_at: string;
        active: number;
        bundle_version: number;
        notes: string | null;
      }
    | undefined;
  if (!row) return null;
  return rowToRecord(row);
}

/**
 * Look up a prompt by exact `prompt_id`. Used by synthesis-cache reads
 * to verify the cache's prompt_id is still current (or look up the
 * archived version that was used).
 */
export function getPromptById(db: DatabaseSync, promptId: string): PromptRecord | null {
  const row = db
    .prepare(
      `SELECT prompt_id, memory_type, tier_label, pass_kind, version, template,
              model_recommendation, created_at, active, bundle_version, notes
         FROM lcm_prompt_registry WHERE prompt_id = ?`,
    )
    .get(promptId) as
    | {
        prompt_id: string;
        memory_type: MemoryType;
        tier_label: string | null;
        pass_kind: PassKind;
        version: number;
        template: string;
        model_recommendation: string | null;
        created_at: string;
        active: number;
        bundle_version: number;
        notes: string | null;
      }
    | undefined;
  if (!row) return null;
  return rowToRecord(row);
}

/**
 * Register a NEW prompt version. If an active prompt exists for the
 * same (memory_type, tier_label, pass_kind), it's marked archived
 * (active=0) atomically with the insert. Returns the new prompt_id.
 *
 * version is auto-incremented: max(version) + 1 across all rows for
 * the same triple (active or archived).
 */
export function registerPrompt(
  db: DatabaseSync,
  opts: RegisterPromptOptions,
): string {
  // Group D adversarial Gap 3 fix: normalize empty-string to null,
  // matching getActivePrompt + the COALESCE-based UNIQUE index.
  const tierLabel =
    opts.tierLabel === null || opts.tierLabel === undefined || opts.tierLabel === ""
      ? null
      : opts.tierLabel;
  const bundleVersion = opts.bundleVersion ?? 1;

  db.exec("BEGIN IMMEDIATE");
  try {
    // 1. Find current max version for this triple (across active + archived)
    const tierClauseSel = tierLabel === null ? "tier_label IS NULL" : "tier_label = ?";
    // Wave-9 TS-tightening: typed for DatabaseSync.get(...args).
    const selParams: string[] =
      tierLabel === null
        ? [opts.memoryType, opts.passKind]
        : [opts.memoryType, tierLabel, opts.passKind];
    const maxRow = db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS max_v FROM lcm_prompt_registry
           WHERE memory_type = ? AND ${tierClauseSel} AND pass_kind = ?`,
      )
      .get(...selParams) as { max_v: number };
    const newVersion = maxRow.max_v + 1;

    // 2. Deactivate previous active row (if any)
    // Wave-9 TS-tightening: typed for DatabaseSync.run(...args).
    const updParams: string[] =
      tierLabel === null
        ? [opts.memoryType, opts.passKind]
        : [opts.memoryType, tierLabel, opts.passKind];
    db.prepare(
      `UPDATE lcm_prompt_registry SET active = 0
         WHERE memory_type = ? AND ${tierClauseSel} AND pass_kind = ? AND active = 1`,
    ).run(...updParams);

    // 3. Insert new version
    const promptId =
      opts.promptIdOverride ??
      `prompt_${opts.memoryType}_${tierLabel ?? "any"}_${opts.passKind}_v${newVersion}_${randomSuffix()}`;
    db.prepare(
      `INSERT INTO lcm_prompt_registry
         (prompt_id, memory_type, tier_label, pass_kind, version, template,
          model_recommendation, active, bundle_version, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    ).run(
      promptId,
      opts.memoryType,
      tierLabel,
      opts.passKind,
      newVersion,
      opts.template,
      opts.modelRecommendation ?? null,
      bundleVersion,
      opts.notes ?? null,
    );

    db.exec("COMMIT");
    return promptId;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/**
 * List all active prompts (most-recent version per triple). For
 * `/lcm health` and operator inspection.
 */
export function listActivePrompts(db: DatabaseSync): PromptRecord[] {
  const rows = db
    .prepare(
      `SELECT prompt_id, memory_type, tier_label, pass_kind, version, template,
              model_recommendation, created_at, active, bundle_version, notes
         FROM lcm_prompt_registry WHERE active = 1
         ORDER BY memory_type, COALESCE(tier_label, ''), pass_kind`,
    )
    .all() as Array<{
    prompt_id: string;
    memory_type: MemoryType;
    tier_label: string | null;
    pass_kind: PassKind;
    version: number;
    template: string;
    model_recommendation: string | null;
    created_at: string;
    active: number;
    bundle_version: number;
    notes: string | null;
  }>;
  return rows.map(rowToRecord);
}

/**
 * Bump bundle_version on every active prompt (atomically). Used by
 * voice-consistency rebuilds after a coordinated prompt set update.
 * Returns count of rows updated.
 */
export function bumpBundleVersion(db: DatabaseSync): number {
  const result = db
    .prepare(`UPDATE lcm_prompt_registry SET bundle_version = bundle_version + 1 WHERE active = 1`)
    .run();
  return Number(result.changes);
}

// ---------- internals ----------

function rowToRecord(row: {
  prompt_id: string;
  memory_type: MemoryType;
  tier_label: string | null;
  pass_kind: PassKind;
  version: number;
  template: string;
  model_recommendation: string | null;
  created_at: string;
  active: number;
  bundle_version: number;
  notes: string | null;
}): PromptRecord {
  return {
    promptId: row.prompt_id,
    memoryType: row.memory_type,
    tierLabel: row.tier_label,
    passKind: row.pass_kind,
    version: row.version,
    template: row.template,
    modelRecommendation: row.model_recommendation,
    createdAt: row.created_at,
    active: row.active === 1,
    bundleVersion: row.bundle_version,
    notes: row.notes,
  };
}

function randomSuffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, "0");
}
