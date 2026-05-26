/**
 * Shared SQL CTE for entity-aggregate queries with suppression-aware
 * semantics. Used by both `lcm_get_entity` and `lcm_search_entities`.
 *
 * # Why this exists (Wave-12 reviewer F4 + consolidation methodology B)
 *
 * Both entity-facing tools must compute entity aggregates from
 * UNSUPPRESSED mentions only, otherwise suppressed-mention data leaks
 * via aggregate columns (occurrence_count, first/last_seen_*, surface
 * forms first introduced in suppressed leaves). The Wave-12 F4 fix
 * landed the CTE in both files via parallel edits — byte-identical
 * SQL maintained in two places, a parallel-edit drift hazard.
 *
 * The architectural-decision methodology (Step 3 adversarial review,
 * 2026-05-08) chose Option B (extract shared helper) over Option A
 * (merge tools into `lcm_entity { mode }`) because:
 *   - Both adversarial agents independently recommended B
 *   - Reach-for/usage telemetry is unavailable to validate the merge
 *   - B is reversible to A when telemetry arrives
 *
 * Helper closes the parallel-edit drift hazard; tool surfaces unchanged.
 */

/**
 * The `WITH visible_mentions AS (...)` clause shared by both entity tools.
 * Joins `lcm_entity_mentions` to `summaries` and filters out mentions
 * whose parent summary is suppressed. Returns no parameters — pure SQL.
 *
 * Callers append `, entity_agg AS (...)` (built via {@link entityAggCte})
 * and then their main `SELECT` body referencing `entity_agg ea`.
 */
export const VISIBLE_MENTIONS_CTE = `
  WITH visible_mentions AS (
    SELECT m.entity_id, m.summary_id, m.surface_form, m.mentioned_at
      FROM lcm_entity_mentions m
      JOIN summaries s ON s.summary_id = m.summary_id
     WHERE s.suppressed_at IS NULL
  )
`;

export interface EntityAggCteOptions {
  /**
   * Include a `first_in` column resolving the earliest visible
   * `summary_id` per entity. Required by `lcm_get_entity` (which
   * surfaces `first_seen_in_summary_id`); not used by
   * `lcm_search_entities`.
   */
  includeFirstIn: boolean;
}

/**
 * Build the `, entity_agg AS (...)` CTE clause that follows
 * {@link VISIBLE_MENTIONS_CTE}. Computes per-entity aggregates from
 * the visible-mentions filter:
 *   - `occ_count`: COUNT of unsuppressed mentions
 *   - `first_at` / `last_at`: MIN/MAX of mentioned_at
 *   - `first_in` (optional): first visible summary_id per entity
 *   - `visible_surfaces`: distinct surface forms (JSON array)
 *
 * Callers reference `entity_agg ea` in their main SELECT/JOIN body.
 *
 * The boolean parameter is the only caller-visible option; the helper
 * never inlines user input, so no SQL-injection surface.
 */
export function entityAggCte(opts: EntityAggCteOptions): string {
  const firstInExpr = opts.includeFirstIn
    ? `(SELECT vm2.summary_id
              FROM visible_mentions vm2
              WHERE vm2.entity_id = vm.entity_id
              ORDER BY vm2.mentioned_at ASC, vm2.summary_id ASC
              LIMIT 1) AS first_in,`
    : "";
  return `, entity_agg AS (
    SELECT
      vm.entity_id,
      COUNT(*) AS occ_count,
      MIN(vm.mentioned_at) AS first_at,
      MAX(vm.mentioned_at) AS last_at,
      ${firstInExpr}
      json_group_array(DISTINCT vm.surface_form) AS visible_surfaces
     FROM visible_mentions vm
    GROUP BY vm.entity_id
  )`;
}
